/**
 * cpt 컨트롤 소켓 — 터미널 안의 AI/사용자가 `cpt <command>` CLI 로 서비스를 조작하는 진입점.
 *
 * cmux 모델의 미러: 로컬 유닉스 소켓(<stateDir>/cpt.sock, 0600) 하나로 NDJSON one-shot
 * 요청/응답을 받는다. 요청의 ctx(CLI 가 tmux 자기조회로 수집한 좌표)로 "어느 워크스페이스의
 * 어느 터미널에서 부른 명령인지"를 확정한다.
 *
 * 처리 위치 분류:
 *  · tmux/파일/백엔드가 원천 = 데몬 직접(terminal.*, read-screen, send, ws.*, notify, status.*)
 *  · 기기 화면이 원천(레이아웃/프리뷰/IDE/브라우저) = ui_command 로 back 경유 클라이언트 위임
 *    (control WS 로 {type:'ui_command'} 전송 → back 팬아웃 → ui_result 회신. P3 에서 back 구현)
 *
 * 보안: 소켓 0600(로컬 사용자 = 소유자 신뢰 경계 — 승인 MCP 소켓과 동급). 요청당 256KB 상한.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const runtime = require('./runtime');
const configLib = require('./config');
const ptyLib = require('./pty');
const wsRpc = require('./workspace');
const fsLib = require('./fs');
const forwardLib = require('./forward');

const MAX_REQ_BYTES = 256 * 1024;
const UI_TIMEOUT_DEFAULT_MS = 10 * 1000;
const UI_TIMEOUT_BROWSER_MS = 30 * 1000;
const UI_TIMEOUT_MAX_MS = 60 * 1000;

let server = null;
let controlWs = null;          // back 제어 WS(연결 시 control.js 가 주입) — ui_command 전송로
const pendingUi = new Map();   // uiId → { resolve, reject, timer }

// 워크스페이스별 사이드바 메타(set-status/set-progress/log) — 인메모리(데몬 생존 동안).
//  ws(cwdRel) → { status: Map<key,{value,icon,color}>, progress: {value,label}|null, log: [{ts,level,source,message}] }
const wsMeta = new Map();
const LOG_MAX = 200;

// 유닉스 소켓 경로 — sun_path 한계(macOS 104B) 초과 시 /tmp 짧은 폴백(경로 해시로 인스턴스 구분).
//  초과 경로는 커널이 조용히 잘라 바인딩해 유령 소켓(연결은 되는데 파일이 안 보임)이 된다.
function sockPath() {
  const p = path.join(runtime.stateDir(), 'cpt.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  const h = crypto.createHash('sha1').update(runtime.stateDir()).digest('hex').slice(0, 8);
  return path.join('/tmp', `cpt-${typeof process.getuid === 'function' ? process.getuid() : 0}-${h}.sock`);
}

function setControlWs(ws) {
  controlWs = ws;
  if (!ws) {
    // 제어 연결 유실 — 대기 중이던 ui 왕복은 모두 실패 처리(무기한 대기 방지).
    for (const [id, p] of pendingUi) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('back 연결이 끊겼습니다'), { code: 'BACK_OFFLINE' }));
      pendingUi.delete(id);
    }
  }
}

// back 이 회신한 ui_result 를 대기 중인 CLI 요청으로 전달(control.js 가 호출).
function resolveUi(id, msg) {
  const p = pendingUi.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingUi.delete(id);
  if (msg && msg.ok) p.resolve(msg.result);
  else p.reject(Object.assign(new Error((msg && msg.error) || 'UI 명령 실패'), { code: (msg && msg.code) || 'UI_ERROR' }));
}

// ui_command 를 back 으로 보내고 ui_result 를 기다린다(P3 왕복).
//  mode: 'broadcast'(전 기기) | 'target'(지정 기기 1곳, target 없으면 활성 기기) | 'executor'(구 호환=활성 기기).
//  target: {deviceId}|{clientKey} — mode:'target' 에서 명시 기기. undefined 면 back 이 활성 기기 선정.
function sendUiCommand(cmd, params, { mode = 'broadcast', target, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    if (!controlWs || controlWs.readyState !== 1) {
      return reject(Object.assign(new Error('back 에 연결돼 있지 않습니다(데몬 오프라인)'), { code: 'BACK_OFFLINE' }));
    }
    const id = crypto.randomUUID();
    const t = Math.min(UI_TIMEOUT_MAX_MS, timeoutMs || (cmd.startsWith('browser.') ? UI_TIMEOUT_BROWSER_MS : UI_TIMEOUT_DEFAULT_MS));
    const timer = setTimeout(() => {
      pendingUi.delete(id);
      reject(Object.assign(new Error('UI 명령 응답 시간 초과'), { code: 'UI_TIMEOUT' }));
    }, t);
    pendingUi.set(id, { resolve, reject, timer });
    try {
      controlWs.send(JSON.stringify({ type: 'ui_command', id, cmd, params: params || {}, mode, target, timeoutMs: t }));
    } catch (e) {
      clearTimeout(timer);
      pendingUi.delete(id);
      reject(e);
    }
  });
}

// ── back REST 헬퍼(deviceToken) — 알림/워크스페이스 목록 등 서버가 원천인 것 ──
async function backFetch(method, apiPath, body) {
  const cfg = configLib.load();
  if (!cfg || !cfg.serverUrl || !cfg.deviceToken) throw new Error('페어링돼 있지 않습니다 (daemon.json 없음)');
  const res = await fetch(cfg.serverUrl.replace(/\/+$/, '') + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.deviceToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 비 JSON 응답 */ }
  if (!res.ok) throw new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
  return json;
}

// --on <deviceId|이름 부분일치|kind> → target {deviceId}|{clientKey}. 미지정=undefined(=활성 기기).
//  이름 매칭은 back 의 접속 클라 목록(/api/daemon/ui/clients)으로 해석. 0개/2개+ 매칭이면 에러.
async function resolveTargetDevice(on) {
  if (on == null || on === '') return undefined;
  const res = await backFetch('GET', '/api/daemon/ui/clients');
  const clients = (res && res.clients) || [];
  const key = String(on).trim();
  if (/^\d+$/.test(key)) {
    const byId = clients.find((c) => c.deviceId === Number(key));
    if (byId) return { deviceId: byId.deviceId };
  }
  const low = key.toLowerCase();
  const matches = clients.filter((c) =>
    (c.deviceName || '').toLowerCase().includes(low) || String(c.kind || '').toLowerCase() === low);
  if (matches.length === 0) throw new Error(`--on: '${on}' 에 맞는 접속 기기가 없습니다 (cpt devices 로 확인)`);
  if (matches.length > 1) throw new Error(`--on: '${on}' 가 여러 기기와 일치합니다: ${matches.map((c) => c.deviceName || c.kind).join(', ')}`);
  const m = matches[0];
  return m.deviceId != null ? { deviceId: m.deviceId } : { clientKey: m.clientKey };
}

// ── ctx 해석 — CLI 가 보낸 좌표에서 (네임스페이스, cwdRel, 터미널 ID) 확정 ──
//  · ctx.ws(CPT_WS env) = 워크스페이스 cwdRel(정본). 없으면 ctx.cwd(프로세스 CWD)를 relOf.
//  · 전용 세션 모델: 세션명 "<ns>--t-<tid>" 의 접미 tid 가 곧 이 터미널의 안정 ID(windowIndex 자리).
//  · 레거시(마이그레이션 전) 뷰 세션(--p-)/풀 직결은 구 규칙(windowId→index)로 폴백.
async function resolveCtx(ctx) {
  const c = ctx || {};
  let cwdRel = typeof c.ws === 'string' ? c.ws : null;
  if (cwdRel == null && typeof c.cwd === 'string' && c.cwd) {
    // 프로세스 CWD(절대) → 홈-상대. jail 밖이면 홈 루트 폴백.
    try { cwdRel = fsLib.relOf(fsLib.safeResolve(c.cwd)); } catch (_) { cwdRel = null; }
  }
  if (cwdRel == null) cwdRel = '';
  const sessionName = c.tmux && c.tmux.session ? String(c.tmux.session) : '';
  let pool = sessionName;
  let windowIndex = c.tmux && Number.isInteger(c.tmux.windowIndex) ? c.tmux.windowIndex : null;
  const windowId = c.tmux && c.tmux.windowId ? String(c.tmux.windowId) : '';
  const t = /^(.*)--t-(\d+)$/.exec(sessionName);
  if (t) {
    pool = t[1];
    windowIndex = parseInt(t[2], 10); // 터미널 ID(안정) — 알림 win/타겟팅의 정본
  } else {
    if (sessionName.includes('--p-')) pool = sessionName.split('--p-')[0];
    // 레거시: windowId 로 풀 index 확정(가능하면) — 뷰 세션 index 는 폴백으로 어긋날 수 있다.
    if (pool && windowId) {
      try {
        const wins = await ptyLib.poolWindows(pool);
        const hit = wins.find((w) => w.id === windowId);
        if (hit) windowIndex = hit.index;
      } catch (_) { /* 풀 미존재 등 — ctx 값 유지 */ }
    }
  }
  return { cwdRel, pool, windowIndex, windowId };
}

// 대상 터미널 인덱스 — 명령 인자(idx)가 있으면 그것, 없으면 자기 자신(ctx).
function targetWin(args, resolved) {
  if (args && args.index != null && Number.isInteger(args.index)) return args.index;
  if (resolved.windowIndex != null) return resolved.windowIndex;
  throw new Error('대상 터미널을 알 수 없습니다 — 인덱스를 지정하세요 (cpt terminal list 로 확인)');
}

// ── git 헬퍼(ide diff) — 워크스페이스 루트에서 execFile 실행(셸 인젝션 없음, freshness 와 동일 컨벤션) ──
const DIFF_MAX_BYTES = 256 * 1024; // ui.ideDiff diffText 캡(초과 시 잘라내고 truncated:true)

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || 'git 실행 실패').trim().split('\n')[0]));
      resolve(String(stdout));
    });
  });
}

// ws 루트(abs) 기준 파일 경로 정규화 — ws 상대/절대 모두 수용, 워킹트리 밖이면 에러.
function wsRelPath(abs, p) {
  const fileAbs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(abs, p);
  const rel = path.relative(abs, fileAbs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) throw new Error('워크스페이스 밖 경로입니다: ' + p);
  return rel;
}

// diff 텍스트 캡 — UTF-8 바이트 기준 절단(멀티바이트 경계 잔재는 제거).
function capDiff(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= DIFF_MAX_BYTES) return { diffText: text, truncated: false };
  return { diffText: buf.subarray(0, DIFF_MAX_BYTES).toString('utf8').replace(/�+$/, ''), truncated: true };
}

function metaFor(cwdRel) {
  let m = wsMeta.get(cwdRel);
  if (!m) { m = { status: new Map(), progress: null, log: [] }; wsMeta.set(cwdRel, m); }
  return m;
}

// status/progress/log 변경을 전 기기에 알림(P3 채널) — 실패해도 로컬 상태는 유지(무해).
function pushStatusChanged(cwdRel) {
  const m = metaFor(cwdRel);
  const payload = {
    ws: cwdRel,
    status: [...m.status.entries()].map(([key, v]) => ({ key, ...v })),
    progress: m.progress,
    logTail: m.log.slice(-5),
  };
  sendUiCommand('status.changed', payload, { mode: 'broadcast', timeoutMs: 5000 }).catch(() => { /* 클라이언트 0대 등 — 무시 */ });
}

// ── 명령 디스패치 ──
async function dispatch(req) {
  const cmd = String(req.cmd || '');
  // 인수(takeover) 지시 — 새 데몬 인스턴스가 기존 인스턴스를 정상 종료시킬 때 사용.
  //  resolveCtx(tmux 조회) 전에 처리해 어떤 상태에서도 응답 가능하게. CAPABILITIES 비공개(내부용).
  if (cmd === 'daemon.shutdown') {
    console.log('[cpt] 인수 지시 수신 — 이 인스턴스를 종료합니다(새 데몬이 대체)');
    setTimeout(() => {
      try { fs.unlinkSync(sockPath()); } catch (_) { /* noop */ }
      process.exit(0);
    }, 200); // 응답 flush 여유
    return { shuttingDown: true, pid: process.pid };
  }
  // 로컬 포트 포워더(PC 앱 내부용) — 원격 프리뷰의 127.0.0.1 리스너 기동/정리. tmux ctx 가
  //  불필요하므로 resolveCtx 전에 처리. daemon.shutdown 처럼 CAPABILITIES 비공개(내부용).
  if (cmd === 'forward.start' || cmd === 'forward.stop') {
    const fargs = req.args || {};
    const port = Number(fargs.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('유효한 port 가 필요합니다.');
    if (cmd === 'forward.stop') return forwardLib.stopLocalForward(port);
    const cfg = configLib.load();
    if (!cfg || !cfg.serverUrl) throw new Error('페어링돼 있지 않습니다 (daemon.json 없음)');
    const token = typeof fargs.token === 'string' ? fargs.token.trim() : '';
    if (!token) throw new Error('token 이 필요합니다.');
    // bind 실패는 { ok:false, error:'EADDRINUSE' } 구조화 반환 — 호출측이 프록시 폴백 판단.
    return forwardLib.startLocalForward({ serverUrl: cfg.serverUrl.replace(/\/+$/, ''), port, token });
  }
  const args = req.args || {};
  const resolved = await resolveCtx(req.ctx);
  const { session, abs } = ptyLib.sessionForCwd(resolved.cwdRel);
  // 터미널 = 전용 세션 "<ns>--t-<tid>" (window 0 하나). 직접 tmux 를 때리는 커맨드의 타겟.
  const termTarget = (tid) => `=${ptyLib.termSession(session, tid)}:0`;

  switch (cmd) {
    case 'ping': return { pong: true, at: Date.now() };
    case 'capabilities': return { name: 'cpt', version: 1, commands: CAPABILITIES };
    case 'identify': {
      const cfg = configLib.load() || {};
      return {
        ws: resolved.cwdRel,
        pool: session,
        windowIndex: resolved.windowIndex,
        windowId: resolved.windowId,
        runner: process.env.CODINGPT_CLOUD ? 'cloud' : 'local',
        server: cfg.serverUrl || null,
        device: cfg.deviceName || null,
      };
    }

    // ── 터미널(공유 풀 — 전 기기 반영) ──
    case 'terminal.list': {
      const r = await ptyLib.handleTerminalRpc('terminal.list', { cwd: resolved.cwdRel });
      return r;
    }
    case 'terminal.new': {
      const r = await ptyLib.handleTerminalRpc('terminal.new', { cwd: resolved.cwdRel });
      if (args.name) {
        await ptyLib.runTmux(['rename-window', '-t', termTarget(r.index), String(args.name)]).catch(() => {});
        r.name = String(args.name);
      }
      notifyPoolChanged();
      return r;
    }
    case 'terminal.close': {
      const win = targetWin(args, resolved);
      const r = await ptyLib.handleTerminalRpc('terminal.close', { cwd: resolved.cwdRel, index: win });
      notifyPoolChanged();
      return r;
    }
    case 'terminal.rename': {
      const win = targetWin(args, resolved);
      if (!args.name) throw new Error('새 이름이 필요합니다');
      await ptyLib.migrateLegacyPool(session, abs).catch(() => {});
      await ptyLib.runTmux(['rename-window', '-t', termTarget(win), String(args.name)]);
      notifyPoolChanged();
      return { ok: true, index: win, name: String(args.name) };
    }
    case 'terminal.read': {
      const win = targetWin(args, resolved);
      const lines = Math.max(1, Math.min(5000, (args.lines | 0) || 200));
      await ptyLib.migrateLegacyPool(session, abs).catch(() => {});
      // -p: stdout, -S -N: 스크롤백 N줄 위부터, -E -: 화면 끝까지. -J: 랩 줄 병합.
      const out = await ptyLib.runTmux(['capture-pane', '-p', '-J', '-t', termTarget(win), '-S', `-${lines}`]);
      return { text: out.replace(/\s+$/, ''), index: win };
    }
    case 'terminal.send': {
      const win = targetWin(args, resolved);
      // 자기 자신 터미널에 입력 = AI 자기루프 위험 — 명시적 --force 요구.
      if (resolved.windowIndex != null && win === resolved.windowIndex && !args.force) {
        throw new Error('자기 자신 터미널에 입력하려 합니다. 의도한 것이면 --force 를 붙이세요.');
      }
      if (typeof args.text !== 'string' || !args.text.length) throw new Error('보낼 텍스트가 필요합니다');
      await ptyLib.migrateLegacyPool(session, abs).catch(() => {});
      await ptyLib.runTmux(['send-keys', '-t', termTarget(win), '-l', '--', args.text]);
      if (args.enter) await ptyLib.runTmux(['send-keys', '-t', termTarget(win), 'Enter']);
      return { ok: true, index: win };
    }
    case 'terminal.sendKey': {
      const win = targetWin(args, resolved);
      if (!args.key) throw new Error('키 이름이 필요합니다 (예: C-c, Enter, Up)');
      if (resolved.windowIndex != null && win === resolved.windowIndex && !args.force) {
        throw new Error('자기 자신 터미널에 키를 보내려 합니다. 의도한 것이면 --force 를 붙이세요.');
      }
      await ptyLib.migrateLegacyPool(session, abs).catch(() => {});
      await ptyLib.runTmux(['send-keys', '-t', termTarget(win), String(args.key)]);
      return { ok: true, index: win };
    }
    case 'terminal.wait': {
      // 다른 터미널의 에이전트(claude 등)가 유휴/승인대기가 될 때까지 agent-watch 상태를 1s 폴링.
      const win = targetWin(args, resolved);
      // 자기 자신 대기 = 영원히 안 끝나는 자기루프 — send/sendKey 와 동일 컨벤션으로 --force 요구.
      if (resolved.windowIndex != null && win === resolved.windowIndex && !args.force) {
        throw new Error('자기 자신 터미널을 대기하려 합니다. 의도한 것이면 --force 를 붙이세요.');
      }
      const wins = await ptyLib.listTerminals(session);
      if (!wins.some((w) => w.index === win)) throw new Error('해당 터미널이 없습니다 (cpt terminal list 로 확인)');
      const forWhat = ['idle', 'permission', 'any'].includes(args.for) ? args.for : 'idle';
      const timeoutMs = Math.max(1, Math.min(3600, (args.timeoutSec | 0) || 600)) * 1000;
      const watch = require('./agent-watch');
      const sess = ptyLib.termSession(session, win);
      const hit = (s) => (forWhat === 'any' ? s === 'idle' || s === 'permission' : s === forWhat);
      const t0 = Date.now();
      for (;;) {
        const s = watch.statusOf(sess); // working|idle|permission (관찰 지연 최대 2s)
        if (hit(s)) return { state: s, waitedMs: Date.now() - t0 };
        if (Date.now() - t0 >= timeoutMs) return { timeout: true, state: s };
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // ── 워크스페이스 ──
    case 'ws.list': {
      const r = await backFetch('GET', '/api/daemon/workspaces');
      // 응답 포맷(성공 시 data 직접)이 배열/객체 어느 쪽이든 그대로 전달.
      return r;
    }
    case 'ws.create': {
      const r = await wsRpc.create({ name: args.name, parentPath: args.parentPath });
      notifyPoolChanged();
      return r;
    }
    case 'ws.clone': {
      const r = await wsRpc.clone({ url: args.url, name: args.name, parentPath: args.parentPath });
      return r;
    }
    case 'ws.delete': {
      // 서버 목록(메타)에서만 삭제 — 로컬 폴더/파일은 절대 건드리지 않는다.
      if (!args.id) throw new Error('워크스페이스 id 가 필요합니다 (cpt ws list 로 확인)');
      const r = await backFetch('DELETE', `/api/daemon/workspaces/${encodeURIComponent(String(args.id))}`);
      notifyPoolChanged();
      return r;
    }

    // ── 알림(back 이 원천 — P1 REST) ──
    case 'notify': {
      if (!args.title) throw new Error('--title 이 필요합니다');
      const cfg = configLib.load() || {};
      const payload = {
        source: args.source || 'cli',
        kind: args.kind || 'custom',
        title: String(args.title),
        subtitle: args.subtitle ? String(args.subtitle) : undefined,
        body: args.body ? String(args.body) : undefined,
        cwd: resolved.cwdRel || undefined,
        wsName: args.wsName || (resolved.cwdRel ? path.basename(resolved.cwdRel) : undefined),
        win: resolved.windowIndex != null ? resolved.windowIndex : undefined,
        sessionId: args.sessionId || undefined,
      };
      const r = await backFetch('POST', '/api/notifications', payload);
      return { id: r && r.id, ok: true };
    }
    case 'notification.list': {
      const r = await backFetch('GET', `/api/notifications?limit=${Math.min(100, (args.limit | 0) || 30)}`);
      return r;
    }
    case 'notification.readAll': {
      const r = await backFetch('POST', '/api/notifications/read-all', {});
      return r;
    }

    // ── 사이드바 메타(status/progress/log) ──
    case 'status.set': {
      if (!args.key) throw new Error('키가 필요합니다');
      const m = metaFor(resolved.cwdRel);
      m.status.set(String(args.key), { value: String(args.value ?? ''), icon: args.icon || null, color: args.color || null });
      pushStatusChanged(resolved.cwdRel);
      return { ok: true };
    }
    case 'status.clear': {
      const m = metaFor(resolved.cwdRel);
      if (args.key) m.status.delete(String(args.key));
      else m.status.clear();
      pushStatusChanged(resolved.cwdRel);
      return { ok: true };
    }
    case 'status.progress': {
      const m = metaFor(resolved.cwdRel);
      if (args.value == null) m.progress = null;
      else m.progress = { value: Math.max(0, Math.min(1, Number(args.value))), label: args.label ? String(args.label) : null };
      pushStatusChanged(resolved.cwdRel);
      return { ok: true };
    }
    case 'status.log': {
      const m = metaFor(resolved.cwdRel);
      m.log.push({ ts: Date.now(), level: args.level || 'info', source: args.source || null, message: String(args.message || '') });
      if (m.log.length > LOG_MAX) m.log.splice(0, m.log.length - LOG_MAX);
      pushStatusChanged(resolved.cwdRel);
      return { ok: true };
    }
    case 'status.list': {
      const m = metaFor(resolved.cwdRel);
      return {
        status: [...m.status.entries()].map(([key, v]) => ({ key, ...v })),
        progress: m.progress,
        log: m.log.slice(-((args.limit | 0) || 50)),
      };
    }

    // 접속 중인 UI 화면(기기) 목록 — 기기 타겟팅(--on) 재료. executor=활성 기기 표기.
    case 'ui.devices': {
      const res = await backFetch('GET', '/api/daemon/ui/clients');
      return { devices: (res && res.clients) || [] };
    }

    // 프리뷰 세션 이어받기(CLI) — 활성(또는 --on) 기기에서 캡처 → --to 기기에 복원(세션·쿠키 포함).
    //  데몬이 오케스트레이터: surfaceCapture(소스) → previewHandoff(타겟) 2단 sendUiCommand.
    case 'ui.previewHandoff': {
      const toTarget = await resolveTargetDevice(args.to);
      if (!toTarget) throw new Error('--to <기기> 가 필요합니다 (cpt devices 로 대상 확인)');
      const fromTarget = await resolveTargetDevice(args.on); // 캡처 소스(기본=활성 기기)
      const cap = await sendUiCommand('surfaceCapture', { kind: 'preview', ws: resolved.cwdRel }, { mode: 'target', target: fromTarget, timeoutMs: 12000 });
      if (!cap || !cap.manifest) throw new Error('이어받을 프리뷰가 없습니다(소스 기기에 프리뷰 없음)');
      const r = await sendUiCommand('previewHandoff', { manifest: cap.manifest, ws: resolved.cwdRel }, { mode: 'target', target: toTarget, timeoutMs: 20000 });
      return { ok: true, to: toTarget, result: r };
    }

    // IDE diff 보기 — 데몬이 ws 루트에서 git diff 를 계산해 diffText 를 실어 보낸다(클라는 렌더만).
    //  변경 없음이면 ui_command 를 보내지 않고 { noChanges: true } 즉시 반환.
    case 'ui.ideDiff': {
      if (!args.path) throw new Error('파일 경로가 필요합니다');
      const rel = wsRelPath(abs, String(args.path));
      const staged = !!args.staged;
      const raw = await runGit(abs, ['diff', ...(staged ? ['--staged'] : []), '--', rel]);
      if (!raw.trim()) return { noChanges: true };
      const { diffText, truncated } = capDiff(raw);
      const target = await resolveTargetDevice(args.on);
      return sendUiCommand('ideDiff', { path: rel, staged, diffText, truncated, sid: args.sid, ws: resolved.cwdRel },
        { mode: 'target', target, timeoutMs: args.timeoutMs });
    }
    // 변경 파일 일괄 열기 — name-only 후 기존 ideOpen/ideDiff 를 150ms 간격 순차 발행(신규 클라 핸들러 불필요).
    case 'ui.ideOpenChanged': {
      const staged = !!args.staged;
      const mode = ['edit', 'diff', 'both'].includes(args.mode) ? args.mode : 'diff';
      const max = Math.max(1, Math.min(50, (args.max | 0) || 10));
      const files = (await runGit(abs, ['diff', '--name-only', ...(staged ? ['--staged'] : [])]))
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (!files.length) return { files: [], opened: 0, skipped: 0, noChanges: true };
      const target = await resolveTargetDevice(args.on);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let opened = 0;
      let skipped = files.length - Math.min(files.length, max); // 캡 초과분
      for (const f of files.slice(0, max)) {
        try {
          if (mode === 'edit' || mode === 'both') {
            await sendUiCommand('ideOpen', { path: f, ws: resolved.cwdRel }, { mode: 'target', target });
            await sleep(150); // 순차+간격 — 클라 레이트리밋(10/s) 회피
          }
          if (mode === 'diff' || mode === 'both') {
            const raw = await runGit(abs, ['diff', ...(staged ? ['--staged'] : []), '--', f]).catch(() => '');
            if (raw.trim()) {
              const { diffText, truncated } = capDiff(raw);
              await sendUiCommand('ideDiff', { path: f, staged, diffText, truncated, ws: resolved.cwdRel }, { mode: 'target', target });
            }
            await sleep(150);
          }
          opened++;
        } catch (_) { skipped++; } // 개별 실패(기기 이탈 등)는 건너뜀
      }
      return { files, opened, skipped };
    }

    // ── 화면 조작(ui_command — back/클라이언트 왕복) — 기기-타겟 라우팅 ──
    case 'ui.wsSelect':
    case 'ui.wsClose':
    case 'ui.layoutTree':
    case 'ui.layoutSplit':
    case 'ui.newPane':
    case 'ui.focusPane':
    case 'ui.moveSurface':
    case 'ui.closeSurface':
    case 'ui.setRatio':
    case 'ui.previewOpen':
    case 'ui.previewNavigate':
    case 'ui.previewReload':
    case 'ui.previewClose':
    case 'ui.previewDevtools':
    case 'ui.previewInfo':
    case 'ui.previewInspect':
    case 'ui.ideOpen':
    case 'ui.ideClose':
    case 'ui.ideCloseFile':
    case 'ui.ideList': {
      const uiCmd = cmd.slice(3, 4).toLowerCase() + cmd.slice(4); // ui.layoutTree → layoutTree
      // 기기-타겟 라우팅: 화면 조작/조회는 "사용자가 보고 있는 활성 기기" 1곳에서만 실행·회신.
      //  --on <기기> 지정 시 그 기기 1곳. (구 broadcast '전 기기 오픈' 모델 폐기 — 표면은 한 기기에만.)
      const target = await resolveTargetDevice(args.on);
      return sendUiCommand(uiCmd, { ...args, ws: resolved.cwdRel }, { mode: 'target', target, timeoutMs: args.timeoutMs });
    }
    // 브라우저 자동화 — 활성(또는 --on 지정) 기기 1곳 단독 실행.
    default: {
      if (cmd.startsWith('browser.')) {
        const target = await resolveTargetDevice(args.on);
        return sendUiCommand(cmd, { ...args, ws: resolved.cwdRel }, { mode: 'target', target, timeoutMs: args.timeoutMs });
      }
      // 훅(기능3): 상태의 단일 소유자 agent-state 로 위임한다. 전이 판정·알림 발사·중복 억제가
      //  전부 그쪽에 있으므로 여기서 알림을 직접 만들지 않는다.
      //  ⚠ 구 구현(event==='notification' ? permission_request : done)을 남겨두면 훅 7종 × 알림 1건 =
      //  턴당 6건 폭주가 된다(agent-state 의 REFIRE 억제는 자기 발사만 집행). 절대 되살리지 말 것.
      if (cmd === 'hook.event') {
        // 폴백 감지(agent-watch)에 훅 생존 신고 — 같은 턴을 title/exit 폴백이 중복 알림하지 않게.
        try { require('./agent-watch').noteHook(resolved.cwdRel, resolved.windowIndex); } catch (_) { /* noop */ }
        // key = 실제 tmux 세션명. ctx 가 준 전용 세션명(--t-<tid>)을 최우선으로 쓴다 —
        //  sessionForCwd 로 재조립하면 워크스페이스 폴더가 소실된 유령 ws 에서 TMUX_SESSION 으로
        //  폴백해(pty.js sessionForCwd) agent-watch 가 list-windows 로 잡은 키와 갈라진다.
        //  키가 갈라지면 hookGoverned 가 안 걸려 폴백이 authoritative 로 뒤집힌다.
        const ctxSess = String((req.ctx && req.ctx.tmux && req.ctx.tmux.session) || '');
        const key = /--t-\d+$/.test(ctxSess) ? ctxSess : ptyLib.termSession(session, resolved.windowIndex);
        const r = await require('./agent-state').applyHook(key, {
          ...args,
          cwdRel: resolved.cwdRel,
          tid: resolved.windowIndex,
          wsName: resolved.cwdRel ? path.basename(resolved.cwdRel) : '',
        });
        // 턴 종료(done/error) → 진행률 제거. 판정은 agent-state 가 한다.
        if (r.clearedProgress) { const m = metaFor(resolved.cwdRel); m.progress = null; pushStatusChanged(resolved.cwdRel); }
        return { ok: true, state: r.state, version: r.version };
      }
      // 에이전트 상태 조회 — 훅/폴백이 만든 현재 상태 스냅샷(터미널별).
      if (cmd === 'agent.status') {
        return { terminals: require('./agent-state').snapshot(resolved.cwdRel) };
      }
      // 훅 배선 자기진단 — "상태가 왜 안 오지"를 라이브에서 판별하는 유일한 수단.
      //  shim 이 PATH 경쟁(다른 터미널 앱의 claude 래퍼)에 밀렸는지, 훅이 실제로 도착하는지를 본다.
      if (cmd === 'hooks.doctor') {
        return hooksDoctor(resolved);
      }
      throw new Error(`알 수 없는 명령: ${cmd} (cpt capabilities 로 확인)`);
    }
  }
}

// 훅 배선 자기진단 — 훅 주력화의 유일한 실패 모드는 "훅이 영영 안 온다"이고, 원인이 전부 환경이다:
//  ① 다른 터미널 앱(cmux 등)의 claude 래퍼가 PATH 선두를 잡아 우리 --settings 주입이 건너뛰어짐
//  ② 사용자가 claude --settings 를 직접 지정(우리 래퍼가 무간섭 통과) 또는 CPT_HOOKS_DISABLED=1
//  ③ shim 파일 자체가 없음/구버전(훅 2종)
//  ④ CodingPT 밖 터미널에서 실행(shim PATH 미주입 — 이 경우는 정상 동작이며 진단 대상 아님)
// 상태가 안 오는데 원인을 모르면 승인 왕복(기능1) 디버깅이 불가능하므로, 사실만 모아 반환한다(자동 수정 안 함).
function hooksDoctor(resolved) {
  const agentState = require('./agent-state');
  const shim = require('./shim');
  const binDir = path.join(runtime.stateDir(), 'bin');
  const hooksFile = path.join(runtime.stateDir(), 'shim', 'claude-hooks.json');

  let hooks = null; let hookEvents = []; let hooksError = null;
  try {
    hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    hookEvents = Object.keys((hooks && hooks.hooks) || {}).sort();
  } catch (e) { hooksError = e.message; }

  const wrapper = path.join(binDir, 'claude');
  let wrapperOk = false; let wrapperInjects = false;
  try {
    const src = fs.readFileSync(wrapper, 'utf8');
    wrapperOk = true;
    wrapperInjects = src.includes('--settings');
  } catch (_) { /* 없음 */ }

  // 이 워크스페이스 터미널들의 훅 수신 실태 — lastHookAt 이 null 이면 그 터미널엔 훅이 한 번도 안 왔다.
  const terminals = agentState.snapshot(resolved.cwdRel, { includeUnknown: true }).map((t) => ({
    tid: t.tid,
    state: t.state,
    version: t.version,
    agent: t.agent,
    source: t.source,
    hookGoverned: t.hookGoverned,
    lastHookAt: t.lastHookAt,
    hookAgeMs: t.lastHookAt ? Date.now() - t.lastHookAt : null,
    sessionId: t.sessionId,
  }));

  const problems = [];
  if (hooksError) problems.push(`훅 설정 파일을 읽을 수 없습니다(${hooksFile}): ${hooksError} — 데몬 재기동으로 재생성됩니다`);
  else if (hookEvents.length < 7) problems.push(`훅이 ${hookEvents.length}종만 등록돼 있습니다(구버전 shim) — 데몬 재기동 필요`);
  if (!wrapperOk) problems.push(`claude 래퍼가 없습니다(${wrapper}) — 데몬 재기동으로 재생성됩니다`);
  else if (!wrapperInjects) problems.push('claude 래퍼가 --settings 를 주입하지 않습니다(구버전) — 데몬 재기동 필요');
  if (process.env.CPT_HOOKS_DISABLED === '1') problems.push('CPT_HOOKS_DISABLED=1 — 훅이 의도적으로 비활성 상태입니다');
  if (terminals.length && terminals.every((t) => t.lastHookAt == null)) {
    problems.push('이 워크스페이스의 어느 터미널에도 훅이 도착한 적이 없습니다 — PATH 선두를 다른 터미널 앱의 claude 래퍼가 잡았을 수 있습니다(`type -a claude` 로 확인). 폴백(title 관찰)으로는 계속 동작합니다');
  }

  return {
    hooksFile, hookEvents, hooksError,
    wrapper: { path: wrapper, exists: wrapperOk, injectsSettings: wrapperInjects },
    binDir,
    zdotDir: (() => { try { return shim.zdotDir(); } catch (_) { return null; } })(),
    hooksDisabled: process.env.CPT_HOOKS_DISABLED === '1',
    governWindowMs: agentState.HOOK_GOVERN_MS,
    terminals,
    problems,
    ok: problems.length === 0,
  };
}

// 터미널 풀 변화(생성/삭제/개명)를 전 기기에 즉시 알림 — 클라이언트 리컨실 tick 트리거(폴링 대기 제거).
function notifyPoolChanged() {
  sendUiCommand('pool.changed', {}, { mode: 'broadcast', timeoutMs: 5000 }).catch(() => { /* 무시 */ });
}

const CAPABILITIES = [
  'ping', 'capabilities', 'identify',
  'terminal.list', 'terminal.new', 'terminal.close', 'terminal.rename', 'terminal.read', 'terminal.send', 'terminal.sendKey', 'terminal.wait',
  'ws.list', 'ws.create', 'ws.clone', 'ws.delete',
  'notify', 'notification.list', 'notification.readAll',
  'status.set', 'status.clear', 'status.progress', 'status.log', 'status.list',
  'ui.devices',
  'ui.wsSelect', 'ui.wsClose', 'ui.layoutTree', 'ui.layoutSplit', 'ui.newPane', 'ui.focusPane', 'ui.moveSurface', 'ui.closeSurface', 'ui.setRatio',
  'ui.previewOpen', 'ui.previewNavigate', 'ui.previewReload', 'ui.previewClose', 'ui.previewDevtools', 'ui.previewInfo', 'ui.previewInspect', 'ui.previewHandoff',
  'ui.ideOpen', 'ui.ideClose', 'ui.ideCloseFile', 'ui.ideList', 'ui.ideDiff', 'ui.ideOpenChanged',
  'browser.snapshot', 'browser.click', 'browser.scroll', 'browser.press', 'browser.type', 'browser.fill', 'browser.eval', 'browser.wait', 'browser.get', 'browser.screenshot', 'browser.console', 'browser.network',
  'hook.event', 'agent.status', 'hooks.doctor',
];

// 소켓에 의존하지 않는 단일 인스턴스 백스톱 — 시작 시 같은 머신의 "다른" 데몬 프로세스를 전부 정리.
//  takeoverExisting 은 cpt.sock 소유자 하나만 graceful 종료시키는데, start() 가 sock 을 무조건 unlink
//  하고 takeover 가 타임아웃(느린 종료·행)나면 "sock 을 잃었지만 살아있는" 좀비 데몬이 남는다. 이 좀비는
//  이후 어떤 takeover 로도 못 잡아(sock 없음) 계속 누적되고, 공유 tmux 소켓(-L codingpt)을 놓고 경쟁해
//  세션 churn·"can't find session" 을 유발한다(실측 데몬 3개 공존). ps 로 데몬 진입 프로세스를 직접 훑어
//  자기 자신만 남기고 SIGTERM→(잔존 시)SIGKILL. 새 인스턴스 승리 = 앱 재시작 시맨틱과 일치.
//  전용 소켓(-L codingpt)은 stateDir 무관 머신 전역이라, 머신당 데몬 1개가 올바른 불변식.
function killStrayDaemons() {
  return new Promise((resolve) => {
    let strays = [];
    execFile('/bin/ps', ['-A', '-o', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);
      const self = process.pid;
      for (const line of String(stdout).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const cmd = m[2] || '';
        if (!pid || pid === self) continue;
        // 데몬 진입 프로세스만: <node 실행파일> <...>/daemon/index.js run 형태.
        //  node 실행 토큰 + 공백없는 스크립트 경로 + run 을 함께 요구 → 셸/에디터/grep 이 그 경로
        //  문자열을 인자로 담고 있어도(오탐) 안 잡힌다. 번들(@codingpt/daemon/index.js)·dev(packages/daemon/index.js) 공통.
        if (!/(^|\/)node(\.exe)?\s+\S*daemon\/index\.js\s+run\b/.test(cmd)) continue;
        strays.push(pid);
      }
      if (!strays.length) return resolve(0);
      for (const pid of strays) { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* 이미 죽음 */ } }
      // graceful 유예 후 잔존 좀비 강제 종료(행 데몬 대비).
      setTimeout(() => {
        for (const pid of strays) {
          try { process.kill(pid, 0); try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ } } catch (_) { /* 정상 종료됨 */ }
        }
        resolve(strays.length);
      }, 800);
    });
  });
}

// 같은 stateDir 의 기존 데몬 인스턴스 감지·인수 — 살아있으면 shutdown 을 지시하고 소켓이 빌 때까지 대기.
//  (tauri dev 재시작·수동 재실행이 남긴 인스턴스와 단일 control WS 를 서로 뺏는 replaced 재접속
//   폭주(~2s 간격)를 원천 차단. 새 인스턴스 승리 = PC 앱 재시작 시맨틱과 일치)
function takeoverExisting(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = sockPath();
    if (!fs.existsSync(sock)) return resolve(false);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const probe = net.createConnection(sock);
    const guard = setTimeout(() => { try { probe.destroy(); } catch (_) { /* noop */ } finish(false); }, 1500);
    probe.on('connect', () => {
      try { probe.write(JSON.stringify({ id: 0, cmd: 'daemon.shutdown' }) + '\n'); } catch (_) { /* noop */ }
      probe.on('data', () => { /* 응답 무시 — close 대기 */ });
      probe.on('close', () => {
        clearTimeout(guard);
        const t0 = Date.now();
        const poll = setInterval(() => {
          // 기존 인스턴스가 exit 하며 소켓을 unlink 한다 — 사라지면(또는 타임아웃) 진행.
          if (!fs.existsSync(sock) || Date.now() - t0 > timeoutMs) { clearInterval(poll); finish(true); }
        }, 150);
      });
    });
    probe.on('error', () => { clearTimeout(guard); finish(false); }); // 스테일 소켓 — start()가 unlink
  });
}

function start() {
  if (server) return server;
  const sock = sockPath();
  try { fs.mkdirSync(path.dirname(sock), { recursive: true }); } catch (_) { /* noop */ }
  try { fs.unlinkSync(sock); } catch (_) { /* 스테일 소켓 정리(살아있는 인스턴스는 takeoverExisting 이 먼저 종료시킴) */ }
  server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (d) => {
      buf += d.toString();
      if (buf.length > MAX_REQ_BYTES) { try { conn.end(); } catch (_) { /* noop */ } return; }
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, i)); } catch (_) { try { conn.end(); } catch (_) { /* noop */ } return; }
      const id = req && req.id;
      try {
        const result = await dispatch(req);
        conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (e) {
        conn.write(JSON.stringify({ id, ok: false, error: (e && e.message) || String(e), code: (e && e.code) || undefined }) + '\n');
      }
      try { conn.end(); } catch (_) { /* one-shot */ }
    });
    conn.on('error', () => { /* noop */ });
  });
  server.on('error', (e) => {
    // 스테일 소켓 자가치유 — 다른(살아있는) 데몬이 물고 있으면 접속이 되고, 죽은 잔재면 실패한다.
    //  실패 시 unlink 후 1회 재시도(EADDRINUSE 는 unlink 전 크래시/중복 기동 잔재가 대부분).
    if (e && e.code === 'EADDRINUSE') {
      const probe = net.createConnection(sock);
      const retry = () => { try { fs.unlinkSync(sock); } catch (_) { /* noop */ } server.listen(sock); };
      probe.on('connect', () => { probe.end(); console.error('[cpt] 소켓을 다른 데몬이 사용 중 — 이 인스턴스는 cpt 비활성'); });
      probe.on('error', retry);
      return;
    }
    console.error('[cpt] 소켓 오류:', e.message);
  });
  server.listen(sock, () => {
    try { fs.chmodSync(sock, 0o600); } catch (_) { /* noop */ }
    console.log(`[cpt] 컨트롤 소켓 대기: ${sock}`);
  });
  return server;
}

module.exports = {
  start, setControlWs, resolveUi, sockPath, takeoverExisting, killStrayDaemons, backFetch,
  _sendUiCommand: sendUiCommand, // 테스트 전용(control-teardown.test.js) — 프로덕션 코드에서 직접 쓰지 말 것
};
