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
      // 훅(P5): claude/codex 훅이 응답 요약과 함께 호출 — notify 경로 재사용.
      if (cmd === 'hook.event') {
        // 폴백 감지(agent-watch)에 훅 생존 신고 — 같은 턴을 title/exit 폴백이 중복 알림하지 않게.
        try { require('./agent-watch').noteHook(resolved.cwdRel, resolved.windowIndex); } catch (_) { /* noop */ }
        const agentName = args.agent === 'codex' ? 'Codex' : 'Claude Code';
        const wsName = resolved.cwdRel ? path.basename(resolved.cwdRel) : '';
        const kind = args.event === 'notification' ? 'permission_request' : 'done';
        const payload = {
          source: 'hook',
          kind,
          title: agentName,
          subtitle: wsName ? (kind === 'done' ? `「${wsName}」에서 완료` : `「${wsName}」에서 승인 대기`) : undefined,
          body: args.summary ? String(args.summary).slice(0, 2000) : undefined,
          cwd: resolved.cwdRel || undefined,
          wsName: wsName || undefined,
          win: resolved.windowIndex != null ? resolved.windowIndex : undefined,
        };
        await backFetch('POST', '/api/notifications', payload);
        // 진행 상태도 갱신: 완료 → 진행률 제거.
        if (kind === 'done') { const m = metaFor(resolved.cwdRel); m.progress = null; pushStatusChanged(resolved.cwdRel); }
        return { ok: true };
      }
      throw new Error(`알 수 없는 명령: ${cmd} (cpt capabilities 로 확인)`);
    }
  }
}

// 터미널 풀 변화(생성/삭제/개명)를 전 기기에 즉시 알림 — 클라이언트 리컨실 tick 트리거(폴링 대기 제거).
function notifyPoolChanged() {
  sendUiCommand('pool.changed', {}, { mode: 'broadcast', timeoutMs: 5000 }).catch(() => { /* 무시 */ });
}

const CAPABILITIES = [
  'ping', 'capabilities', 'identify',
  'terminal.list', 'terminal.new', 'terminal.close', 'terminal.rename', 'terminal.read', 'terminal.send', 'terminal.sendKey',
  'ws.list', 'ws.create', 'ws.clone',
  'notify', 'notification.list', 'notification.readAll',
  'status.set', 'status.clear', 'status.progress', 'status.log', 'status.list',
  'ui.devices',
  'ui.wsSelect', 'ui.wsClose', 'ui.layoutTree', 'ui.layoutSplit', 'ui.newPane', 'ui.focusPane', 'ui.moveSurface', 'ui.closeSurface', 'ui.setRatio',
  'ui.previewOpen', 'ui.previewNavigate', 'ui.previewReload', 'ui.previewClose', 'ui.previewDevtools', 'ui.previewInfo', 'ui.previewHandoff',
  'ui.ideOpen', 'ui.ideClose', 'ui.ideCloseFile', 'ui.ideList',
  'browser.snapshot', 'browser.click', 'browser.scroll', 'browser.press', 'browser.type', 'browser.fill', 'browser.eval', 'browser.wait', 'browser.get', 'browser.screenshot',
  'hook.event',
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

module.exports = { start, setControlWs, resolveUi, sockPath, takeoverExisting, killStrayDaemons, backFetch };
