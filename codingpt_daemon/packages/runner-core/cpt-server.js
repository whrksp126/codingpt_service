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

// 동시에 블로킹 대기할 수 있는 승인 요청 수 — 승인 1건 = 소켓 커넥션 1개가 수 분간 유지되므로
//  상한이 없으면 폭주하는 세션이 소켓/파일디스크립터를 통째로 점유한다. 초과분은 즉시 defer
//  (= 그 터미널에서 TUI 로 답한다) — 어떤 경우에도 자동 허용은 없다.
const APPROVAL_MAX_INFLIGHT = 8;
let approvalInflight = 0;

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

// ── 로컬 UI 채널(F0-c) — 같은 기기 안에서 back 을 왕복하지 않는 ui_command 경로 ────────────────
//  cpt.sock 은 one-shot 규약이지만 `ui.attach` 만 예외로 커넥션을 유지해 양방향 NDJSON 채널이 된다
//   (데몬→앱 {t:'ui_command',uiId:'loc-n',cmd,params} / 앱→데몬 {t:'ui_result',uiId,ok,result,error}).
//  ⚠ **전면 단축 금지.** executor(어느 화면에서 실행할지) 선정은 back 만 가진 전 기기 presence 로 해야
//    한다 — 폰에서 보고 있는데 명령이 옆 PC 로 가면 회귀다. 그래서 로컬로 가는 경우는 배타적으로 둘뿐:
//     ① target 이 명시됐고 그 deviceId|clientKey 가 이 머신의 attach 클라이언트와 일치
//     ② back 제어 WS 가 없다(지금까지 무조건 BACK_OFFLINE 이던 상황) → 로컬 화면이 있으면 그리로
const localUiClients = new Set(); // { conn, clientKey, deviceId, kind, foreground, at, pending:Map }
let localUiSeq = 0;
const MAX_UI_FRAME_BYTES = 8 * 1024 * 1024; // ui_result(browser.snapshot/screenshot)는 256KB 를 넘긴다

function attachLocalUi(conn, a) {
  const c = {
    conn,
    clientKey: a && a.clientKey ? String(a.clientKey) : null,
    deviceId: a && a.deviceId != null && Number.isInteger(Number(a.deviceId)) ? Number(a.deviceId) : null,
    kind: a && a.kind ? String(a.kind) : 'pc',
    foreground: !!(a && a.foreground),
    at: Date.now(),
    pending: new Map(),
  };
  localUiClients.add(c);
  console.log(`[cpt] 로컬 UI 채널 attach (kind=${c.kind} client=${c.clientKey || '-'} device=${c.deviceId ?? '-'})`);
  return c;
}

function detachLocalUi(c) {
  if (!localUiClients.delete(c)) return;
  for (const [, p] of c.pending) {
    clearTimeout(p.timer);
    p.reject(Object.assign(new Error('로컬 UI 채널이 끊겼습니다'), { code: 'UI_LOCAL_GONE' }));
  }
  c.pending.clear();
}

function handleLocalUiFrame(c, f) {
  if (!f || typeof f !== 'object') return;
  if (f.t === 'ui_result') {
    const p = c.pending.get(f.uiId);
    if (!p) return; // 타임아웃 후 늦게 온 회신 — 무시
    clearTimeout(p.timer);
    c.pending.delete(f.uiId);
    if (f.ok) p.resolve(f.result);
    else p.reject(Object.assign(new Error(f.error || 'UI 명령 실패'), { code: f.code || 'UI_ERROR' }));
    return;
  }
  // 앱 창 포커스 변화 — 로컬 클라이언트가 여러 개일 때(예: 개발 중 2개) 어디로 보낼지 판단에 쓴다.
  if (f.t === 'presence') { c.foreground = !!f.active; return; }
}

function localUiFor(target) {
  if (!target) return null;
  for (const c of localUiClients) {
    if (target.deviceId != null && c.deviceId != null && c.deviceId === Number(target.deviceId)) return c;
    if (target.clientKey && c.clientKey && c.clientKey === String(target.clientKey)) return c;
  }
  return null;
}

// back 오프라인 폴백용 — 포커스된 화면 우선, 없으면 가장 최근 attach.
function pickLocalUi() {
  let best = null;
  for (const c of localUiClients) {
    if (!best) { best = c; continue; }
    if (c.foreground !== best.foreground) { if (c.foreground) best = c; continue; }
    if (c.at > best.at) best = c;
  }
  return best;
}

function sendLocalUiCommand(c, cmd, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `loc-${++localUiSeq}`; // 'loc-' 접두사 = back 경로(uuid)와 절대 섞이지 않는다
    const t = Math.min(UI_TIMEOUT_MAX_MS, timeoutMs || (cmd.startsWith('browser.') ? UI_TIMEOUT_BROWSER_MS : UI_TIMEOUT_DEFAULT_MS));
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(Object.assign(new Error('UI 명령 응답 시간 초과'), { code: 'UI_TIMEOUT' }));
    }, t);
    c.pending.set(id, { resolve, reject, timer });
    try {
      c.conn.write(JSON.stringify({ t: 'ui_command', uiId: id, cmd, params: params || {}, timeoutMs: t }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      c.pending.delete(id);
      reject(e);
    }
  });
}

// ui_command 를 back 으로 보내고 ui_result 를 기다린다(P3 왕복).
//  mode: 'broadcast'(전 기기) | 'target'(지정 기기 1곳, target 없으면 활성 기기) | 'executor'(구 호환=활성 기기).
//  target: {deviceId}|{clientKey} — mode:'target' 에서 명시 기기. undefined 면 back 이 활성 기기 선정.
function sendUiCommand(cmd, params, { mode = 'broadcast', target, timeoutMs } = {}) {
  const backLive = !!(controlWs && controlWs.readyState === 1);
  // ① 명시 타겟이 이 머신의 화면 → back 미경유(같은 기기 왕복 제거)
  let local = target ? localUiFor(target) : null;
  // ② back 오프라인 폴백 — 여기까지 오면 원래는 무조건 BACK_OFFLINE 이었다(= back 죽으면 cpt 전멸)
  if (!local && !backLive) local = pickLocalUi();
  if (local) return sendLocalUiCommand(local, cmd, params, timeoutMs);
  return new Promise((resolve, reject) => {
    if (!backLive) {
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
// 응답을 **무한정 기다리지 않는다**: 여기 오는 라우트는 전부 JSON 메타(수 KB)라 30초면 넉넉하고,
//  걸린 요청은 호출측의 "진행 중" 플래그를 그만큼 붙잡아 둔다 — e2ee-account 의 st.running 이 몇 분간
//  참이면 그 사이 도착한 e2ee_hint 가 전부 한 번의 재확인으로 뭉개진다(실측 결함의 창 폭 확대 요인).
//  ★ 실패 취급은 기존 네트워크 단절과 같다(에러 throw) → 호출측 백오프/폴백 경로가 그대로 돈다.
const BACK_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.CPT_BACK_TIMEOUT_MS) || 30000);
async function backFetch(method, apiPath, body) {
  const cfg = configLib.load();
  if (!cfg || !cfg.serverUrl || !cfg.deviceToken) throw new Error('페어링돼 있지 않습니다 (daemon.json 없음)');
  // 구 node(AbortSignal.timeout 부재)에서도 그대로 도는 폴백 — 그때는 타임아웃 없이 기존 동작.
  const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(BACK_FETCH_TIMEOUT_MS) : undefined;
  const res = await fetch(cfg.serverUrl.replace(/\/+$/, '') + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.deviceToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 비 JSON 응답 */ }
  if (!res.ok) {
    // 상태코드와 서버가 실은 code(errorResponse 의 detail.code 규약)를 **에러 객체에 붙인다** —
    //  호출측이 한글 문구 정규식으로 분기하면 문구가 바뀌는 순간 조용히 오작동한다(레이트리밋 키 함정과
    //  같은 종류의 사고). 기존 호출부는 message 만 읽으므로 additive.
    const err = new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    const code = json && json.detail && json.detail.code;
    if (code) err.code = String(code);
    throw err;
  }
  return json;
}

// ── 로컬 자동 체크포인트(F0-a) ──────────────────────────────────────────────
//  back 신규 REST 2개에 의존한다(스펙은 이 함수가 보내는 body/기대 응답이 정본):
//    POST /api/daemon/sync/checkpoint/begin  {workspaceId, reason, cwd?}
//      → {checkpointId, putUrls:{bundle,session}, cwd}
//    POST /api/daemon/sync/checkpoint/commit {workspaceId, checkpointId, skipped?, unchanged?,
//                                             baseCommit, commit, sizeBytes, hasSession, enc?, epoch?}
//      → {…entry, head}
//  둘 중 하나라도 없는 back(=미배포)이면 begin 이 실패하고 호출측(PC 앱)이 구 경로로 폴백한다.
const syncLocalInflight = new Set(); // wsId — 같은 워크스페이스 중복 체크포인트 방지(주기 트리거 겹침)

// ── 에이전트 관리(agents.*) ──────────────────────────────────────────────────
//  list   : 카탈로그 + 감지 결과 + 배선 상태(등급 포함). refresh=true 면 캐시 무시(설치 직후 검증용).
//  wire   : 배선 on/off (claude/codex 만) → 즉시 shim 재생성. **CAPABILITIES 비공개**(AI 자기해제 금지).
//  rescan : 재감지 + shim 재생성. 설치 시트의 3단계("CodingPT 동기화")가 부르는 것이 이것이다.
//           성공 판정을 이 결과(installed)로만 한다 — 설치 명령의 종료 코드는 믿지 않는다.
async function handleAgentsRpc(cmd, a) {
  const agentsLib = lazyMod('./agents');
  if (!agentsLib) throw new Error('이 데몬은 에이전트 관리를 지원하지 않습니다(PC 앱 업데이트 필요)');
  const shimLib = lazyMod('./shim');
  if (cmd === 'agents.list') {
    const items = await agentsLib.list({ refresh: !!a.refresh });
    return { agents: items, onboardedAt: agentsLib.onboardedAt() };
  }
  if (cmd === 'agents.wire') {
    const id = String(a.id || '').trim();
    const on = !!a.on;
    agentsLib.setWired(id, on);
    // 래퍼 생성/삭제를 즉시 반영 — 토글하고 나서 "다음 재부팅부터" 는 사용자가 이해할 수 없다.
    if (shimLib && shimLib.ensureShimsAsync) await shimLib.ensureShimsAsync();
    const items = await agentsLib.list({ refresh: true });
    return { agents: items, onboardedAt: agentsLib.onboardedAt() };
  }
  if (cmd === 'agents.rescan') {
    if (a.markOnboarded) agentsLib.markOnboarded();
    if (shimLib && shimLib.ensureShimsAsync) await shimLib.ensureShimsAsync();
    const items = await agentsLib.list({ refresh: true });
    return { agents: items, onboardedAt: agentsLib.onboardedAt() };
  }
  if (cmd === 'agents.launch') return launchAgentInTerminal(agentsLib, a);
  throw new Error('알 수 없는 명령: ' + cmd);
}

/**
 * 이미 만들어진 터미널(tid)에서 에이전트를 **타이핑해 실행**한다. "터미널 추가 ▾ → Claude" 의 뒷단.
 *
 * ★ 왜 클라이언트가 아니라 여기서 하나: **새 셸이 사용자 rc 를 다 읽기 전에 키를 보내면 입력이
 *  씹힌다**(사용자 zsh 는 powerlevel10k — 프롬프트 준비까지 수백 ms). 이 타이밍 판정을 PC/모바일이
 *  각자 구현하면 한쪽만 고쳐지는 결함이 된다(전례: runTmux UTF-8 미러 누락).
 *
 * "준비됨" 판정 = ① 실행 중 명령이 셸이다(에이전트가 이미 돌고 있으면 덮어 치지 않는다)
 *  ② 화면에 뭐라도 그려졌다(= 프롬프트가 나왔다). 둘 다 tmux 에 직접 묻는다.
 *  타임아웃(기본 6초)이면 그래도 보내고 `ready:false` 로 정직하게 알린다 — 아무것도 안 하는 것보다,
 *  "명령이 안 들어갔을 수 있다"를 UI 가 말할 수 있게 하는 편이 낫다.
 */
async function launchAgentInTerminal(agentsLib, a) {
  const id = String(a.id || a.agent || '').trim();
  const items = await agentsLib.list({ version: false });
  const hit = items.find((x) => x.id === id);
  if (!hit) throw new Error('알 수 없는 에이전트입니다: ' + id);
  if (!hit.installed) throw new Error(`${hit.name} 이 이 PC 에 설치되어 있지 않습니다`);
  const tid = Number(a.index != null ? a.index : a.tid);
  if (!Number.isFinite(tid)) throw new Error('터미널 index 가 필요합니다');
  const { session, abs } = ptyLib.sessionForCwd(a.cwd);
  await ptyLib.migrateLegacyPool(session, abs).catch(() => {});
  const target = `=${ptyLib.termSession(session, tid)}:0`;
  const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login']);
  const deadline = Date.now() + Math.max(1000, Math.min(20000, (a.timeoutMs | 0) || 6000));
  let ready = false;
  let busy = false;
  while (Date.now() < deadline) {
    let cur = '';
    try {
      cur = (await ptyLib.runTmux(['display-message', '-p', '-t', target, '#{pane_current_command}'])).trim();
    } catch (e) {
      throw new Error('터미널을 찾을 수 없습니다 (index=' + tid + ')');
    }
    if (cur && !SHELLS.has(cur)) { busy = true; break; }   // 이미 뭔가 돌고 있다 — 덮어 치지 않는다
    let screen = '';
    try {
      screen = await ptyLib.runTmux(['capture-pane', '-p', '-t', target, '-S', '-5']);
    } catch (_) { screen = ''; }
    if (screen.trim()) { ready = true; break; }            // 프롬프트가 그려졌다
    await new Promise((r) => setTimeout(r, 120));
  }
  if (busy) return { ok: false, busy: true, index: tid, command: hit.bin };
  // ★ 크기가 안정될 때까지 한 번 더 기다린다(2026-07-27 실측으로 추가).
  //  에이전트 TUI 는 **첫 화면을 그 순간의 창 폭으로 그리고**, tmux 는 히스토리를 리플로우하지 않는다
  //  → 창이 아직 스테일 치수(라이브 실측 42x15)일 때 실행하면 환영 박스가 영구히 어긋난 채 남는다.
  //  클라이언트가 attach 하며 보내는 resize 가 도착할 여유를 주고, **폭이 두 번 연속 같을 때** 보낸다.
  //  최대 1.5초만 기다린다 — 아무도 안 볼 터미널(백그라운드 생성)에서 영원히 대기하지 않게.
  let lastW = null;
  const sizeDeadline = Date.now() + 1500;
  while (Date.now() < sizeDeadline) {
    let w = null;
    try { w = (await ptyLib.runTmux(['display-message', '-p', '-t', target, '#{window_width}'])).trim(); } catch (_) { break; }
    if (lastW !== null && w === lastW) break;   // 두 번 연속 동일 = 안정
    lastW = w;
    await new Promise((r) => setTimeout(r, 220));
  }
  const command = agentsLib.launchCommand(id);
  await ptyLib.runTmux(['send-keys', '-t', target, '-l', '--', command]);
  await ptyLib.runTmux(['send-keys', '-t', target, 'Enter']);
  return { ok: true, ready, index: tid, command };
}

async function localCheckpoint(a) {
  const wsId = String(a.workspaceId || a.wsId || '').trim();
  if (!wsId) throw new Error('workspaceId 가 필요합니다.');
  if (syncLocalInflight.has(wsId)) return { accepted: false, busy: true }; // 진행 중 — 다음 트리거가 재시도
  const syncLib = lazyMod('./sync');
  if (!syncLib) throw new Error('이 데몬에는 sync 모듈이 없습니다.');
  const reason = String(a.reason || 'periodic');
  const begin = await backFetch('POST', '/api/daemon/sync/checkpoint/begin', {
    workspaceId: wsId, reason, ...(a.cwd ? { cwd: a.cwd } : {}),
  });
  const b = (begin && (begin.data || begin)) || {};
  const checkpointId = b.checkpointId;
  const putUrls = b.putUrls;
  const cwd = a.cwd || b.cwd;
  if (!checkpointId || !putUrls || !putUrls.bundle || !cwd) {
    throw new Error('체크포인트 좌표 발급 실패(begin 응답 형식)');
  }
  syncLocalInflight.add(wsId);
  // sync_event(sync_progress) push 대상 = 살아 있는 제어 WS. 없으면 null(=푸시 없음, 진행은 정상).
  const pushWs = controlWs && controlWs.readyState === 1 ? controlWs : null;
  (async () => {
    const r = (await syncLib.handle('sync.checkpoint', {
      cwd, reason, checkpointId, putUrls, wsId,
      includeAgentSession: a.includeAgentSession !== false,
    }, pushWs)) || {};
    await backFetch('POST', '/api/daemon/sync/checkpoint/commit', {
      workspaceId: wsId,
      checkpointId: r.checkpointId || checkpointId,
      skipped: !!r.skipped,
      unchanged: !!r.unchanged,
      baseCommit: r.baseCommit || null,
      commit: r.commit || null,
      sizeBytes: r.sizeBytes || 0,
      hasSession: !!r.hasSession,
      // 봉인 좌표(E2EE) — 구 back 은 무시(additive). 평문이면 아예 실리지 않는다.
      ...(r.enc ? { enc: r.enc, epoch: r.epoch } : {}),
    });
  })()
    .catch((e) => console.warn(`[cpt] 로컬 체크포인트 실패 ws=${wsId} ck=${checkpointId}: ${e.message}`))
    .finally(() => syncLocalInflight.delete(wsId));
  return { accepted: true, background: true, local: true, checkpointId };
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

// ── CodingPT 컨텍스트 게이트(2026-07-29) ─────────────────────────────────
// 문제(실측): resolveCtx 는 CPT_WS/tmux 좌표가 없으면 프로세스 CWD 를 그대로 워크스페이스로
//  승격한다 — 홈 아래 아무 폴더에서 cpt 를 실행해도 그 폴더가 ws 가 되고 공개 명령 전체
//  (terminal.send·ws.delete·ui.previewOpen…)가 열렸다. 전역 스킬 스텁·전역 심링크와 결합해
//  무관한 프로젝트의 codex/claude 가 cpt 로 사용자의 **활성 기기 화면**을 실제 조작할 수 있었다.
// 규칙: CodingPT 가 만든 컨텍스트가 있으면 통과 —
//  ① ctx.ws 가 문자열(CPT_WS env 주입 터미널 — 값이 '' 여도 env 존재 자체가 우리 터미널 증거)
//  ② ctx.tmux.session 이 우리 세션(cpt-…) — CLI 가 -L codingpt 소켓 자기조회에 성공한 경우
//  CWD 폴백만으로 온 요청은 그 CWD(또는 상위 폴더)가 **지금 열려 있는 워크스페이스**(-L codingpt
//  에 세션 보유)일 때만 통과 — 워크스페이스 폴더 안 "옛 셸"의 수동 사용은 살리고 무관 폴더는 거부.
//  (Orca 의 "전역 아티팩트는 컨텍스트 밖에서 무해화" 패턴의 데몬측 절반. 스킬 스텁의 자기-스코핑
//   문구가 나머지 절반이다. env 위조까지 막는 게 목적이 아니다 — 위협 모델은 악의가 아니라
//   다른 에이전트의 **우발적 간섭**이다.)
// 예외(컨텍스트 불요): 진단(ping/capabilities/identify/hooks.doctor)과 훅 자기보고(hook.event/
//  approval.*)뿐. 훅을 게이트하면 env 유실 상황에서 승인·알림이 통째로 죽는다 — 훅은 조작이
//  아니라 자기보고라 위험도가 낮고, approval.request/respond 는 어차피 CAPABILITIES 비공개다.
const CONTEXT_EXEMPT = new Set([
  'ping', 'capabilities', 'identify', 'hooks.doctor',
  'hook.event', 'approval.request', 'approval.respond',
]);
// 세션명 → 워크스페이스 ns(전용 --t-/레거시 --p-/--v-/--c- 접미 제거). sanitize 가 비영숫자 런을
//  '-' 하나로 접으므로 ns 자체에 '--' 는 나올 수 없다 → '--' 앞이 곧 ns 다.
let liveNsCache = { at: 0, set: null };
async function liveWorkspaceNs() {
  if (liveNsCache.set && Date.now() - liveNsCache.at < 5000) return liveNsCache.set;
  const set = new Set();
  try {
    const out = await ptyLib.runTmux(['list-sessions', '-F', '#{session_name}']);
    for (const raw of String(out).split('\n')) {
      const name = raw.replace(/\r$/, '').trim();
      if (!name.startsWith('cpt-')) continue;
      set.add(name.split('--')[0]);
    }
  } catch (_) { /* tmux 서버 없음 = 열린 워크스페이스 0 */ }
  liveNsCache = { at: Date.now(), set };
  return set;
}
// cwdRel → 세션 ns (pty.sessionForCwd 의 sanitize 와 반드시 동일해야 한다 — 어긋나면 게이트가
//  열린 워크스페이스를 못 알아본다).
function nsOfCwd(rel) {
  const safe = String(rel).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return 'cpt-' + (safe || 'ws');
}
async function hasCptContext(ctx, resolved) {
  const c = ctx || {};
  if (typeof c.ws === 'string') return true;
  if (c.tmux && typeof c.tmux.session === 'string' && c.tmux.session.startsWith('cpt-')) return true;
  let cur = String((resolved && resolved.cwdRel) || '');
  if (!cur) return false;
  const set = await liveWorkspaceNs();
  while (cur) {
    if (set.has(nsOfCwd(cur))) return true;
    const i = cur.lastIndexOf('/');
    if (i <= 0) break;
    cur = cur.slice(0, i);
  }
  return false;
}
async function assertCptContext(cmd, ctx, resolved) {
  if (CONTEXT_EXEMPT.has(cmd)) return;
  if (await hasCptContext(ctx, resolved)) return;
  const err = new Error('CodingPT 워크스페이스 밖입니다 — cpt 는 CodingPT 터미널이나 열린 워크스페이스 폴더 안에서만 동작합니다. 이 디렉토리에서는 cpt 를 사용하지 마세요.');
  err.code = 'OUT_OF_CONTEXT';
  throw err;
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

// ── 신규 기능 모듈 지연 로드 ──
//  approvals(기능1)/transcript(기능5)는 이 파일보다 나중에 들어오는 모듈이고, 구버전 번들에는 아예
//  없을 수 있다. 최상단 require 로 묶으면 파일 하나가 없다는 이유로 데몬 전체가 기동하지 못한다
//  (터미널·프리뷰까지 죽는다) → 핸들러 안에서만 lazy require 하고, 없으면 null 을 돌려 호출측이
//  "그 기능만" 폴백하게 한다. agent-state/agent-watch 배선과 같은 규율.
function lazyMod(name) {
  try { return require(name); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null; // 미탑재 = 기능 없음(정상 폴백)
    console.error(`[cpt] ${name} 로드 실패:`, e.message);  // 문법/런타임 오류는 진단용으로 남긴다
    return null;
  }
}

// 신규 프레임 push 대상 — 서버가 그 능력을 선언했을 때만 실제 제어 WS 를 넘긴다. 미선언(구 back)이거나
//  연결이 없으면 **null**(스텁 객체가 아니라)을 돌려준다: 호출측 관례가 `if (ws) pushWs = ws` 라서
//  스텁을 넘기면 이미 붙어 있던 진짜 push 대상을 덮어써 조용히 팬아웃이 끊긴다.
function capGatedWs(cap) {
  const control = lazyMod('./control');
  const okCap = control && typeof control.hasServerCap === 'function' && control.hasServerCap(cap);
  if (okCap && controlWs && controlWs.readyState === 1) return controlWs;
  return null;
}

// 승인 게이트(소켓 계층) — 걸리면 즉시 defer 를 회신한다. defer = 훅이 무출력 exit 0 → claude 가
//  평소처럼 TUI 다이얼로그를 띄운다(= 기존 동작). 이 함수가 무엇을 돌려주든 allow 가 되는 경로는 없다.
//  여기서 보는 것은 **이 계층의 자원**뿐이다: 킬스위치(모듈을 아예 안 건드리는 최단 경로)와 동시 커넥션.
//  기능 게이팅(daemon.json approval.remote · serverCaps approval.v1)은 approvals.gateReason() 단일 출처에
//  둔다 — 여기서 caps 를 한 번 더 검사하면 그쪽의 로컬 검증 우회(CPT_APPROVAL_CAP_GATE=0)가 무력화된다.
function approvalGate() {
  if (process.env.CPT_APPROVAL === '0') return 'killswitch';
  if (approvalInflight >= APPROVAL_MAX_INFLIGHT) return 'too_many_pending';
  return null;
}

// ── 명령 디스패치 ──
//  conn = 요청을 보낸 소켓 커넥션(있으면). 장기 블로킹 커맨드(approval.request)가 "요청자 소멸"을
//  감지하는 유일한 수단이다 — 훅 프로세스가 죽으면(Esc/Ctrl-C/세션 kill) 이 소켓이 close 된다.
async function dispatch(req, conn) {
  const cmd = String(req.cmd || '');
  // 인수(takeover) 지시 — 새 데몬 인스턴스가 기존 인스턴스를 정상 종료시킬 때 사용.
  //  resolveCtx(tmux 조회) 전에 처리해 어떤 상태에서도 응답 가능하게. CAPABILITIES 비공개(내부용).
  if (cmd === 'daemon.shutdown') {
    console.log('[cpt] 인수 지시 수신 — 이 인스턴스를 종료합니다(새 데몬이 대체)');
    // 대기 중 승인을 먼저 defer 로 종결한다 — 블록된 훅들이 프로세스 종료(=소켓 강제 close)를 기다리지
    //  않고 즉시 응답을 받아 TUI 로 폴백한다. 카드 회수(retract)는 베스트에포트(back TTL 스위퍼가 수습).
    try {
      const approvals = lazyMod('./approvals');
      if (approvals && typeof approvals.cancelAll === 'function') {
        const n = approvals.cancelAll('daemon_gone');
        if (n) console.log(`[cpt] 대기 중 승인 ${n}건 defer 처리(종료)`);
      }
    } catch (_) { /* noop */ }
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
    // ★ upstream(LAN 직결 좌표)을 **반드시 전달한다**. Rust 는 이미 args.upstream 을 싣고
    //  (`cptsock.rs:69-75`) forward.js 는 연결별 직결/버퍼 승계 폴백까지 완비돼 있는데, 여기서
    //  한 필드를 떨어뜨리면 grant 는 매번 발급되면서 바이트는 영원히 서버를 경유한다(에러·로그 0건 —
    //  기능4 死文의 진짜 원인이었다). token 은 upstream 이 있어도 항상 함께 넘긴다(릴레이 = 영구 폴백).
    const up = fargs.upstream && typeof fargs.upstream === 'object' ? { ...fargs.upstream } : null;
    if (up) {
      // grant 는 단일 사용이다 — 세션이 끊기면 forward.js 가 refresh() 를 1회 부른다(강등 카운터 무소모).
      //  재발급은 **PC JS 가 쓰던 clientKey 그대로** 해야 호스트 측 grant 바인딩(MAC 입력)이 맞는다.
      const lanLocal = lazyMod('./lan-local');
      if (lanLocal && typeof lanLocal.refreshUpstream === 'function' && up.hostDeviceId != null) {
        up.refresh = () => lanLocal.refreshUpstream(up.hostDeviceId, up.clientKey, up.remotePort || port);
      }
    }
    // bind 실패는 { ok:false, error:'EADDRINUSE' } 구조화 반환 — 호출측이 프록시 폴백 판단.
    return forwardLib.startLocalForward({
      serverUrl: cfg.serverUrl.replace(/\/+$/, ''), port, token, ...(up ? { upstream: up } : {}),
    });
  }
  // LAN 직결(기능4) — PC 앱 내부용. tmux ctx 가 불필요하므로 resolveCtx 전에 처리하고
  //  CAPABILITIES 에는 **넣지 않는다**(아래 CAPABILITIES 주석의 판단 기준 참조).
  if (cmd === 'lan.probe' || cmd === 'lan.status' || cmd === 'lan.rpc') {
    const lanLocal = lazyMod('./lan-local');
    // 모듈 부재(구 번들) = 소켓 에러 → Rust Err → PC 가 markUnsupported → 조용히 릴레이(무증상).
    const fn = lanLocal && lanLocal[cmd.slice(4)];          // lan.probe → probe
    if (typeof fn !== 'function') throw new Error('이 데몬은 LAN 직결을 지원하지 않습니다(PC 앱 업데이트 필요)');
    return fn(req.args || {});
  }
  // 종단간 암호화(기능2) — PC 앱 내부용. MK 가 필요한 연산을 데몬이 대행한다(JS 에 MK 무노출).
  //  resolveCtx 전 처리 + CAPABILITIES 비공개. 모듈 부재는 **명확한 실패**로(callLazy 규율) —
  //  PC 는 그걸 "구 데몬 = 미지원" 으로 읽고 조용히 평문으로 돈다.
  if (cmd.startsWith('e2ee.')) {
    const e2eeLocal = lazyMod('./e2ee-local');
    if (!e2eeLocal || typeof e2eeLocal.handle !== 'function') {
      throw new Error('이 데몬은 종단간 암호화를 지원하지 않습니다(PC 앱 업데이트 필요)');
    }
    return e2eeLocal.handle(cmd, req.args || {});
  }
  // 자동 체크포인트(PC 앱 내부용) — "PC 앱 → back → 제어 WS → **같은 머신의 사이드카 데몬**" 왕복 제거.
  //  presigned URL·manifest 는 objectstore 자격증명을 가진 back 만 만들 수 있다(데몬은 무접촉 원칙) →
  //  왕복을 없애는 최선은 **데몬이 back REST 를 직접 호출**하는 것: begin(좌표 발급) → 로컬 번들·업로드 → commit.
  //  begin 만 await 한다: 즉시 끝나고, 실패(구 back = 404)를 호출측에 알려 기존 경로로 폴백시킬 수 있다.
  //  무거운 번들/업로드는 background — 대형 워크스페이스는 분 단위라 소켓 왕복으로 기다릴 수 없다.
  //  forward.* 와 같이 CAPABILITIES 비공개(내부용) + resolveCtx 전 처리(tmux ctx 불필요).
  if (cmd === 'sync.checkpoint') return localCheckpoint(req.args || {});
  // 에이전트 관리(2026-07-27) — 이 PC 에 설치된 AI CLI 감지·배선. resolveCtx 전 처리(tmux ctx 불필요).
  //  ⚠ `agents.wire` 는 CAPABILITIES 비공개다: 터미널 안의 AI 가 자기 승인 훅을 스스로 끄는 경로가
  //   되기 때문이다(approval.respond 를 닫는 것과 같은 이유 — 승인 게이트의 자기해제 금지).
  //   `agents.list` 만 공개한다(어차피 AI 는 `which claude` 로 알 수 있는 정보).
  if (cmd.startsWith('agents.')) return handleAgentsRpc(cmd, req.args || {});
  // ── 에이전트 모드(PC 앱 내부용) — 같은 머신인데 back 을 왕복하던 것을 없앤다 ────────────────
  //  실측(2026-08-02): back 왕복 150~285ms vs 이 소켓 1~2ms. 사용자가 "묘하게 느리다"고 한 그 차이다.
  //  · status.poke = "지금 다시 봐"(부작용 없음) · chat.mode = 조회/전환 · chat.commands = 슬래시 목록
  //    (전부 control.js 와 **같은 구현**에 위임한다 — 경로만 다르고 동작이 갈리면 안 된다)
  //  CAPABILITIES 에는 넣지 않는다(터미널 안 AI 용 명령이 아니라 앱 내부 배관 — forward.*/sync.* 와 동일).
  //  resolveCtx 앞에 두는 이유: 인자로 (cwd,tid)를 명시하므로 tmux ctx 가 필요 없고, 워크스페이스
  //  컨텍스트 게이트(cpt 오사용 방지)는 터미널에서 실행되는 명령을 위한 것이라 여기선 무의미하다.
  if (cmd === 'status.poke') {
    const a = req.args || {};
    const win = Number.isInteger(a.tid) ? a.tid : parseInt(a.tid, 10);
    if (!Number.isInteger(win)) throw Object.assign(new Error('tid 가 필요합니다'), { code: 'BAD_REQUEST' });
    const { session: s0 } = ptyLib.sessionForCwd(typeof a.cwd === 'string' ? a.cwd : '');
    require('./status-line').pokeTermSession(ptyLib.termSession(s0, win));
    return { ok: true };
  }
  // ★ claude statusLine 중계 보고(2026-08-03) — 화면 스크랩을 대체하는 공식 상태 원천.
  //  bin/cpt-statusline(statusline-relay.js)이 claude 에게 받은 stdin JSON 을 그대로 넘긴다.
  //  resolveCtx 앞에 두는 이유 = 앱 내부 배관(터미널 안 AI 용 명령이 아니다) + 인자가 자족적이다.
  //  ⚠ 보고자는 응답을 기다리지 않는다(화면을 붙잡지 않기 위해) → 여기서 실패해도 조용히 끝난다.
  if (cmd === 'status.report') {
    const a = req.args || {};
    // rendered = 사용자 statusline 스크립트가 실제로 출력한 줄(릴레이가 사본을 떠 준다).
    //  채팅의 한 줄 요약은 **그 줄** 이다 — 우리가 항목을 고르지 않는다(사용자 지적 2026-08-04).
    const file = require('./agent-status').noteClaudeHook(a.payload, a.rendered);
    return { ok: true, ...(file ? { file: fsLib.relOf(file) } : {}) };
  }
  if (cmd === 'chat.mode') return chatMode(req.args || {});
  if (cmd === 'chat.commands') return chatCommands(req.args || {});
  if (cmd === 'chat.dialog') return chatDialog(req.args || {});
  if (cmd === 'chat.screen') return chatScreen(req.args || {});
  // 채팅 스냅샷/캐치업도 같은 이유로 로컬 직결(PC 앱 전용) — 토글할 때마다 back 왕복 255ms 를
  //  물던 자리다. 데몬 구현은 back 경로와 **같은 transcript.handle** 이고, ws 를 넘기지 않으므로
  //  push 대상(제어 WS)은 그대로 유지된다(transcript.js:1513 `if (ws) pushWs = ws`).
  if (cmd === 'chat.open' || cmd === 'chat.since') {
    return require('./transcript').handle(cmd, req.args || {}, null);
  }
  const args = req.args || {};
  const resolved = await resolveCtx(req.ctx);
  // CodingPT 컨텍스트 밖(무관 폴더의 CWD 폴백)이면 진단/훅 예외만 남기고 전부 거부 — §게이트 주석.
  await assertCptContext(cmd, req.ctx, resolved);
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
        // 게이트 판정 — false 면 이 위치에서 조작 명령이 거부된다(에이전트가 스스로 물러날 근거).
        context: await hasCptContext(req.ctx, resolved),
      };
    }

    // ── 터미널(공유 풀 — 전 기기 반영) ──
    case 'terminal.list': {
      // 응답의 windows[] 는 데몬이 판정한 agent 신호를 함께 싣는다(추가 전용, §1.6):
      //  agent(3값: true / false=셸 확정만 / null=모름) · agentName · agentState · agentSource.
      //  내용성 정보(제목 원문·요약)는 싣지 않는다.
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

    // ── 원격 승인(기능1) ──
    //  approval.request 는 이 소켓의 유일한 장기 블로킹 커맨드다. 구조적으로 가능한 이유:
    //   ① dispatch 가 async 이고 응답까지 conn 을 유지한다(cpt-server 는 one-shot 이지만 무기한 대기 허용).
    //   ② 커넥션에 유휴 타임아웃을 걸지 않는다(net 기본값 = 무제한). start() 의 소켓 생성부에
    //      conn.setTimeout 을 절대 추가하지 말 것 — 넣으면 승인 대기가 그 시점에 끊겨 defer 로 떨어진다.
    //  실패 규율: 어떤 오류 경로에서도 { decision:'defer' } 를 회신한다(throw 하지 않는다).
    //   훅은 ok:false 도 defer 로 취급하지만, 여기서 명시적으로 돌려주면 이유(reason)가 로그에 남는다.
    case 'approval.request': {
      const gate = approvalGate();
      if (gate) return { decision: 'defer', reason: gate };
      const approvals = lazyMod('./approvals');
      if (!approvals || typeof approvals.request !== 'function') return { decision: 'defer', reason: 'approvals_unavailable' };
      approvalInflight++;
      try {
        const r = await approvals.request({
          ...args,
          // ctx 에서 확정한 좌표 — 알림/읽음 스코프의 기존 계약(cwd=cwdRel, win=tid)과 동일 값이어야 한다.
          cwdRel: resolved.cwdRel,
          tid: resolved.windowIndex,
          wsName: resolved.cwdRel ? path.basename(resolved.cwdRel) : '',
          tmuxSession: resolved.windowIndex != null ? ptyLib.termSession(session, resolved.windowIndex) : null,
        }, resolved, conn);
        return r && r.decision ? r : { decision: 'defer', reason: 'no_decision' };
      } catch (e) {
        console.error('[cpt] 승인 요청 실패(defer 로 폴백):', (e && e.message) || e);
        return { decision: 'defer', reason: 'error' };
      } finally {
        approvalInflight--;
      }
    }
    // 대기 중 승인 목록(조회 전용) — `cpt approval list` / 진단. 데몬이 정본이다.
    case 'approval.list': {
      const approvals = lazyMod('./approvals');
      if (!approvals || typeof approvals.handle !== 'function') return { approvals: [], supported: false };
      return approvals.handle('approval.list', {});
    }
    // 로컬 응답(기본 비활성) — 승인 결정은 back 경유(control WS rpc approval.resolve)가 정본이다.
    //  ⚠ 이 소켓은 터미널 안의 AI 도 부를 수 있다 → 상시 노출하면 에이전트가 자기 승인 요청을 스스로
    //   허용할 수 있고, 그건 기능1 의 존재 이유(사람이 결정)를 통째로 무력화한다. HOME 격리 하네스
    //   검증용으로만 CPT_APPROVAL_LOCAL=1 에서 열린다. CAPABILITIES 에도 노출하지 않는다.
    case 'approval.respond': {
      if (process.env.CPT_APPROVAL_LOCAL !== '1') throw new Error('로컬 승인 응답은 비활성입니다(CPT_APPROVAL_LOCAL=1 필요) — 앱/PC 에서 응답하세요.');
      const approvals = lazyMod('./approvals');
      if (!approvals || typeof approvals.handle !== 'function') throw new Error('승인 모듈이 없습니다(구 데몬)');
      return approvals.handle('approval.resolve', {
        id: args.id,
        decision: args.decision,
        message: args.message || null,
        by: { kind: 'local', deviceName: 'this PC (cpt)', deviceId: null },
      });
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
      // 트랜스크립트(기능5) — chat.* 는 전부 transcript 모듈로 통째 위임한다(메서드별 case 를 두지 않는다:
      //  계약이 그쪽 정본이고, 여기서 필드를 재조립하면 스키마 드리프트가 두 파일로 갈라진다).
      //  좌표(cwd/tid)는 CLI 가 보내지 않으므로 ctx 에서 채운 뒤 args 로 덮어쓴다(명시 인자 우선).
      // chat.input 은 **읽기가 아니라 입력**이므로 transcript(읽기 전용 모듈)로 넘기지 않고 여기서 처리한다.
      //  채팅 모드는 별도 에이전트 세션을 만들지 않는다 — 지금 그 터미널에서 돌고 있는 claude 에게
      //  사람이 직접 타이핑한 것과 똑같이 들어가야 "같은 대화"가 유지된다(PTY 하네스).
      //  멀티라인은 bracketed paste 로 감싼다: 생 개행을 그대로 보내면 TUI 가 첫 줄에서 즉시 제출한다.
      //  Enter 는 별도 send-keys 로 지연 전송(붙여넣기 처리 완료 후 제출).
      if (cmd === 'chat.input') {
        return chatInput({ cwd: resolved.cwdRel, tid: targetWin(args, resolved), text: args.text, submit: args.submit });
      }
      if (cmd.startsWith('chat.')) {
        const transcript = lazyMod('./transcript');
        if (!transcript || typeof transcript.handle !== 'function') {
          throw new Error('트랜스크립트 모듈이 없습니다(구 데몬) — chat.* 미지원');
        }
        const params = { cwd: resolved.cwdRel, tid: resolved.windowIndex, ...args };
        // push 대상은 back 제어 WS. 서버가 transcript.v1 을 선언하지 않으면 프레임이 조용히 유실되므로
        //  아예 넘기지 않는다(구독 없이 조회만 동작 = pull 폴백). RPC 응답 자체는 그대로 회신된다.
        return transcript.handle(cmd, params, capGatedWs('transcript.v1'));
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
        // 세션↔터미널 바인딩(기능5 P0) — 훅만이 (sessionId, transcriptPath, tid) 를 결정론적으로 준다.
        //  ⚠ 알림/상태(위 applyHook)보다 뒤에서, 그리고 절대 실패하지 않게(try/catch + await 없음) 한다:
        //   훅은 claude 를 블록하는 경로이고 이 바인딩은 부가정보이므로, 여기서 예외나 지연이 새면
        //   훅 전체가 느려지거나 상태 보고가 유실된다.
        try {
          const transcript = lazyMod('./transcript');
          if (transcript && typeof transcript.noteHook === 'function') {
            // transcriptPath 는 훅 페이로드(외부 입력)다 — jail(`~/.claude/projects/**.jsonl`) 검증을
            //  통과한 값만 넘긴다. 검증기는 transcript.safeTranscriptPath 단일 출처를 쓴다(여기서 정규식을
            //  복제하면 둘이 갈라지고, 느슨한 쪽이 `~/.claude/.credentials.json` 을 읽히게 만든다 = ToS 경계).
            let tp = null;
            try { tp = typeof transcript.safeTranscriptPath === 'function' ? transcript.safeTranscriptPath(args.transcriptPath) : null; } catch (_) { tp = null; }
            const p = transcript.noteHook({
              event: args.event || null,
              sessionId: args.sessionId || null,
              transcriptPath: tp,
              cwd: args.agentCwd || null,   // 에이전트의 절대 cwd — path 미검증 시 파일명 추정 폴백에 쓰인다
              cwdRel: resolved.cwdRel,
              tid: resolved.windowIndex,
            });
            if (p && typeof p.then === 'function') p.catch(() => { /* 바인딩 실패는 무해(폴백=슬러그 스캔) */ });
          }
        } catch (_) { /* noop */ }
        return { ok: true, state: r.state, version: r.version };
      }
      // 에이전트 상태 조회 — 훅/폴백이 만든 현재 상태 스냅샷(터미널별).
      //  각 항목에 `wireState`(ended→gone, launching→idle 접기)와 `attached`(= wireState !== 'gone')가
      //  함께 온다(추가 전용) — 목록(terminal.list)의 agent 플래그와 **같은 규칙**이라 두 표면이 어긋나지 않는다.
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

// 채팅 모드 입력 — 지금 그 터미널에서 돌고 있는 claude 에게 사람이 직접 타이핑한 것과 동일하게 넣는다.
//  별도 에이전트 세션을 만들지 않는 것이 핵심이다: 그래야 TUI 와 채팅이 "같은 대화"로 유지된다(PTY 하네스).
//  transcript(읽기 전용 모듈)가 아니라 여기 있는 이유 = tmux/pty 관심사이기 때문. 로컬 소켓(dispatch)과
//  back rpc(control.js) 두 경로가 같은 구현을 쓰도록 독립 함수로 둔다.
//  ⚠ 멀티라인은 bracketed paste 로 감싼다 — 생 개행을 그대로 보내면 TUI 가 첫 줄에서 즉시 제출한다.
async function chatInput({ cwd, tid, text, submit } = {}) {
  const body = typeof text === 'string' ? text : '';
  if (!body) throw Object.assign(new Error('보낼 텍스트가 필요합니다'), { code: 'BAD_REQUEST' });
  if (Buffer.byteLength(body, 'utf8') > 32 * 1024) {
    throw Object.assign(new Error('텍스트가 너무 깁니다(32KB 상한)'), { code: 'TOO_LARGE' });
  }
  const cwdRel = typeof cwd === 'string' ? cwd : '';
  const win = Number.isInteger(tid) ? tid : (typeof tid === 'string' && /^\d+$/.test(tid) ? parseInt(tid, 10) : null);
  if (win == null) throw Object.assign(new Error('대상 터미널(tid)이 필요합니다'), { code: 'BAD_REQUEST' });
  const { session, abs } = ptyLib.sessionForCwd(cwdRel);
  await ptyLib.migrateLegacyPool(session, abs).catch(() => { /* 레거시 풀 없음 — 무해 */ });
  const target = `=${ptyLib.termSession(session, win)}:0`;
  const multiline = /\n/.test(body);
  // 컴포저 잔재 청소(2026-07-30 실사고): TUI 컴포저에 남아 있던 초안 위에 paste 하면
  //  "채팅에서 보낸 것"과 다른 메시지가 제출된다(경로 이중 전송 신고). 채팅 전송의 계약은
  //  **채팅 텍스트 = 제출 본문** — claude 컴포저(❯)가 비어 있지 않으면 C-u 로 비운다.
  await clearComposerResidue(target).catch(() => { /* 감지 실패 = 기존 동작(그대로 이어붙임) */ });
  // 항상 bracketed paste + **이미지 경로 조각 분리**(2026-07-30 격리 실측):
  //  · claude 는 붙여넣은 내용이 "경로 그 자체"일 때만 [Image #N] 으로 변환한다 — 문장 중간에 섞인
  //    경로는 변환되지 않는다. 그래서 인용 이미지 경로를 경계로 텍스트를 쪼개 조각마다 따로
  //    paste 하면 문장 중간의 첨부도 제자리에서 변환된다(literal 타이핑은 아예 무변환 — 옛 진범).
  const segs = splitImagePathSegments(body);
  for (const seg of segs) {
    await ptyLib.runTmux(['send-keys', '-t', target, '-l', '--', `[200~${seg}[201~`]);
    if (segs.length > 1) await new Promise((r) => setTimeout(r, 90)); // 조각 간 소화 시간
  }
  const doSubmit = submit !== false;
  if (doSubmit) {
    // 붙여넣기 직후 즉시 Enter 를 보내면 TUI 가 버퍼를 정리하기 전이라 일부만 제출되는 경우가 있다.
    //  이미지 경로 조각이 있으면 변환(파일 읽기)이 비동기라 넉넉히 기다린다 — 미변환 제출이어도
    //  경로 텍스트는 여전히 유효하다(에이전트가 Read 로 읽는다). 즉 안전한 지연일 뿐이다.
    await new Promise((r) => setTimeout(r, segs.length > 1 ? 900 : 120));
    await ptyLib.runTmux(['send-keys', '-t', target, 'Enter']);
  }
  // ★ 제출 직후 화면 확인을 앞당긴다(2026-08-03 사용자 신고: "/model 선택 UI 가 늦게 뜬다").
  //  격리 실측: Enter 후 51ms 면 TUI 에 선택 화면이 이미 있다 — 늦은 건 우리 3초 폴링뿐이었다.
  //  제출은 화면이 바뀌는 게 **확실한 순간**이라 여기가 burst 를 걸 자리다(슬래시든 일반 문장이든
  //  상태줄·모드도 같이 갱신되므로 조건을 달지 않는다).
  try { require('./status-line').pokeTermSession(ptyLib.termSession(session, win), { burst: true }); }
  catch (_) { /* 감시자 없음 — 무해 */ }
  return { ok: true, index: win, submitted: doSubmit, multiline };
}

// TUI 컴포저 잔재를 비운다 — 최대 6회, **화면 확인 기반**. 채팅 전송의 계약은 "채팅 텍스트 = 제출 본문"이다.
//  · claude(`❯`): C-u 로 한 번에 지운다.
//  · codex(`›`) : ★ 2026-08-02 사용자 신고 — 채팅에서 `/model` 을 보냈는데 TUI 에 `//model` 이 들어갔다.
//    TUI 컴포저에 사용자가 쳐 둔 `/` 가 남아 있었는데 이 함수가 claude 만 감지해 codex 는 그냥 통과했다.
//    codex 는 C-u 가 먹지 않는다(실측) → Backspace 를 글자 수만큼 보낸다.
//    ★ 글자 수는 **커서 위치**로 잰다: codex 는 빈 컴포저에 회색 플레이스홀더("Write tests for @filename")를
//    같은 자리에 그려서 화면 텍스트만 보면 초안과 구분할 수 없다. 실측(0.146.0): 빈 컴포저의 커서는
//    `› ` 바로 뒤(x=2), `/mo` 를 치면 x=5 다. 즉 x-2 = 실제 입력 글자 수이고, x<=2 면 비어 있다.
//  · 어느 쪽이든 다이얼로그 선택지 줄(`❯ 1.` / `› 1.`)은 절대 건드리지 않는다(오조작 금지).
const RESIDUE_PROMPT_COLS = 2;  // `› ` 폭(실측)
const RESIDUE_MAX_BS = 200;     // 폭주 방어(긴 초안이 남아 있어도 이 이상은 지우지 않는다)

async function clearComposerResidue(target) {
  for (let i = 0; i < 6; i++) {
    const out = await ptyLib.runTmux(['capture-pane', '-p', '-t', target]);
    const lines = String(out || '').split('\n');
    let idx = -1;
    let codex = false;
    for (let k = lines.length - 1; k >= 0; k--) {
      if (/^\s*[❯›]\s*[1-9]\.\s/.test(lines[k])) continue;   // 다이얼로그 커서 — 컴포저가 아니다
      if (/^\s*❯/.test(lines[k])) { idx = k; break; }
      if (/^\s*›/.test(lines[k])) { idx = k; codex = true; break; }
    }
    if (idx < 0) return;
    const text = lines[idx].replace(/^\s*[❯›][\s ]?/, '').trim();
    if (/^\d+\.\s/.test(text)) return;             // 다이얼로그 — 오조작 금지
    if (codex) {
      let cx = -1;
      let cy = -1;
      try {
        const pos = await ptyLib.runTmux(['display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y}']);
        const m = /(\d+)\s+(\d+)/.exec(String(pos || ''));
        if (m) { cx = parseInt(m[1], 10); cy = parseInt(m[2], 10); }
      } catch (_) { return; }                       // 커서를 못 읽으면 건드리지 않는다(추측 조작 금지)
      if (cy !== idx) return;                        // 커서가 컴포저 줄이 아니다 = 지금 입력 자리가 아니다
      const n = cx - RESIDUE_PROMPT_COLS;
      if (n <= 0) return;                            // 비어 있다(보이는 건 플레이스홀더)
      await ptyLib.runTmux(['send-keys', '-t', target, '-N', String(Math.min(n, RESIDUE_MAX_BS)), 'BSpace']);
    } else {
      if (!text || /^Try "/.test(text)) return;      // 비었다(힌트는 본문이 아니다)
      await ptyLib.runTmux(['send-keys', '-t', target, 'C-u']);
    }
    await new Promise((r) => setTimeout(r, 140));
  }
}

// 인용 이미지 경로(뒤 공백 포함)를 독립 조각으로 분리 — chatInput 의 조각 paste 용 순수 함수.
const IMG_PATH_SEG_RE = /('[^'\n]+\.(?:png|jpe?g|gif|webp|bmp|heic|tiff)' ?)/i;
function splitImagePathSegments(text) {
  const out = [];
  let rest = String(text || '');
  while (rest) {
    const m = rest.match(IMG_PATH_SEG_RE);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    out.push(m[1]);
    rest = rest.slice(m.index + m[1].length);
  }
  return out.length ? out : [''];
}

// ── TUI 질문 다이얼로그 원격 조작(chat.answer) ─────────────────────────────
// 승인 훅이 이미 끝난(defer → TUI 폴백) AskUserQuestion 에 원격 카드로 답하는 경로.
//  훅 채널이 없으므로 **다이얼로그를 키 입력으로 대신 조작**한다 — TUI 앞에 앉은 사람과 동일한 입력.
//
// 키 프로토콜(claude 2.1.220, 2026-07-28 격리 tmux 실측 — 추측 아님):
//  · 단일선택: 숫자키 = 선택 + 다음 질문 자동 진행
//  · multiSelect: 숫자키 = 체크 토글, Tab = 다음 탭(마지막 질문이면 Review 화면)
//  · 자유입력: "Type something." 행 숫자키(= 선택지수+1) → 그 행이 입력창이 됨 → 텍스트 → Enter
//  · 질문이 1개면 Review 없이 즉시 제출, 여러 개면 "Ready to submit your answers?" → 1 = Submit
//
// 안전장치 — 다이얼로그가 실제로 떠 있을 때만 친다. 아니면 숫자가 **셸/컴포저에 타이핑**된다:
//  ① 화면에 다이얼로그 푸터("Enter to select")가 있어야 하고
//  ② 클라가 보낸 expect(질문 텍스트 조각)가 화면에 있어야 한다(다른 질문/다른 상태 오조작 방지).
const DRIVE_KEY_GAP_MS = 160;
function normScreen(s) { return String(s || '').replace(/\s+/g, ''); }

// 조작 본체 — io 주입형(테스트/격리 검증이 실제 코드 경로를 그대로 태울 수 있게 분리).
//  io = { screen(): Promise<string>, key(k, literal): Promise<void>, sleep(ms) }
async function driveQuestionDialog(io, { answers, expect, cancel } = {}) {
  const list = Array.isArray(answers) ? answers : [];
  if (!cancel && !list.length) throw Object.assign(new Error('답변이 비어 있습니다'), { code: 'BAD_REQUEST' });
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const s0 = await io.screen();
  if (!/Enter to select/.test(s0)) {
    throw Object.assign(new Error('지금 이 터미널에 질문 다이얼로그가 떠 있지 않습니다'), { code: 'QUESTION_NOT_ON_SCREEN' });
  }
  if (expect && !normScreen(s0).includes(normScreen(String(expect).slice(0, 60)))) {
    throw Object.assign(new Error('화면의 질문이 답하려는 질문과 다릅니다'), { code: 'QUESTION_MISMATCH' });
  }

  // 거절(전부 건너뜀) = Esc — 다이얼로그의 자체 취소("Esc to cancel"). claude 가 declined 를 기록한다.
  if (cancel) {
    await io.key('Escape');
    for (let i = 0; i < 10; i++) {
      if (!/Enter to select/.test(await io.screen())) return { ok: true, canceled: true };
      await sleep(300);
    }
    throw Object.assign(new Error('다이얼로그가 닫히지 않았습니다 — TUI 를 직접 확인해 주세요'), { code: 'DRIVE_INCOMPLETE' });
  }

  for (const a of list) {
    const picks = (Array.isArray(a.optionIndexes) ? a.optionIndexes : []).map((n) => parseInt(n, 10)).filter((n) => n >= 1);
    const optionCount = parseInt(a.optionCount, 10) || 0;
    const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : null;
    if (text != null) {
      const d = optionCount + 1;                       // "Type something." 행
      if (d > 9) throw Object.assign(new Error('선택지가 너무 많아 자유입력을 조작할 수 없습니다'), { code: 'UNSUPPORTED' });
      await io.key(String(d), true);
      await sleep(120);
      await io.key(text, true);
      await io.key('Enter');
    } else if (a.multiSelect) {
      if (!picks.length || picks.some((n) => n > 9)) throw Object.assign(new Error('선택이 비었거나 조작할 수 없는 번호입니다'), { code: 'BAD_REQUEST' });
      for (const n of picks) await io.key(String(n), true);
      await io.key('Tab');
    } else {
      if (picks.length !== 1 || picks[0] > 9) throw Object.assign(new Error('단일선택 질문엔 정확히 1개를 골라야 합니다'), { code: 'BAD_REQUEST' });
      await io.key(String(picks[0]), true);
    }
    await sleep(200);
  }

  // 마무리 — 질문이 여러 개면 Review 화면이 남는다. 최대 ~3초 관찰하며 제출을 완주시킨다.
  for (let i = 0; i < 10; i++) {
    const s = await io.screen();
    if (/Ready to submit your answers\?/.test(s)) { await io.key('1', true); continue; }
    if (!/Enter to select/.test(s)) return { ok: true };             // 다이얼로그 소멸 = 제출 완료
    await sleep(300);
  }
  throw Object.assign(new Error('다이얼로그가 예상대로 진행되지 않았습니다 — TUI 를 직접 확인해 주세요'), { code: 'DRIVE_INCOMPLETE' });
}

async function chatAnswer({ cwd, tid, answers, expect, cancel } = {}) {
  const { io, win } = dialogIoFor(cwd, tid);
  await io.ready;
  const r = await driveQuestionDialog(io, { answers, expect, cancel: cancel === true });
  return { ...r, tid: win };
}

// tmux 조작 io 조립(질문/권한 다이얼로그 공용).
function dialogIoFor(cwd, tid, opts) {
  const win = Number.isInteger(tid) ? tid : (typeof tid === 'string' && /^\d+$/.test(tid) ? parseInt(tid, 10) : null);
  if (win == null) throw Object.assign(new Error('대상 터미널(tid)이 필요합니다'), { code: 'BAD_REQUEST' });
  const { session, abs } = ptyLib.sessionForCwd(typeof cwd === 'string' ? cwd : '');
  const target = `=${ptyLib.termSession(session, win)}:0`;
  const io = {
    ready: ptyLib.migrateLegacyPool(session, abs).catch(() => { /* 레거시 풀 없음 — 무해 */ }),
    screen: () => ptyLib.runTmux(['capture-pane', '-p', '-t', target]),
    key: async (k, literal) => {
      await ptyLib.runTmux(literal ? ['send-keys', '-t', target, '-l', '--', k] : ['send-keys', '-t', target, k]);
      // 다이얼로그 조작은 키 사이 간격이 필요하지만(그 값이 실측 정본), 모드 순환은 키 1개마다
      //  화면을 다시 읽어 검증하므로 고정 대기를 짧게 잡는다(체감 반응 — 사용자 신고 2026-08-02).
      await new Promise((r) => setTimeout(r, (opts && opts.keyGapMs != null) ? opts.keyGapMs : DRIVE_KEY_GAP_MS));
    },
  };
  return { io, win };
}

// ── TUI 권한 다이얼로그 원격 조작(permission-revive 전용) ─────────────────────
// 훅이 죽어 TUI 로 폴백된 승인 다이얼로그(claude "Do you want to proceed?" /
//  codex "Would you like to run the following command?")에 카드 응답을 전달한다.
//  키 프로토콜(claude 2.1.220 · codex 0.145, 각각 2026-07-29 PTY 실측): **숫자키 한 번**이면
//  즉시 그 옵션이 실행된다(Enter 불필요).
//  안전장치는 질문 조작과 동일: 다이얼로그가 실제로 떠 있고 + expect(명령 조각)가 화면에 있어야
//  키를 친다 — 아니면 숫자가 셸/컴포저에 타이핑된다.
async function drivePermissionDialog(io, { pick, expect, text, flow } = {}) {
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const n = parseInt(pick, 10);
  if (!(n >= 1 && n <= 9)) throw Object.assign(new Error('선택 번호가 올바르지 않습니다'), { code: 'BAD_REQUEST' });
  // ⚠ 푸터("esc to cancel")를 조건으로 걸지 않는다 — claude Fetch 다이얼로그는 푸터가 없다
  //  (2026-07-29 실사고). 질문 줄 + 번호 옵션 행 존재로 판정하고, expect(명령 조각)가 오조작을 막는다.
  const up = (s) => /(Do you want to|Would you like to) .{0,160}\?/.test(s) && /^\s*[❯›>]?\s*[1-9]\.\s+\S/m.test(s);
  const s0 = await io.screen();
  if (!up(s0)) {
    throw Object.assign(new Error('지금 이 터미널에 승인 다이얼로그가 떠 있지 않습니다'), { code: 'QUESTION_NOT_ON_SCREEN' });
  }
  if (expect && !normScreen(s0).includes(normScreen(String(expect).slice(0, 60)))) {
    throw Object.assign(new Error('화면의 승인 요청이 답하려는 요청과 다릅니다'), { code: 'QUESTION_MISMATCH' });
  }
  // 추가 지시 텍스트 없음 = 기존 프로토콜(숫자키 한 번, Enter 불필요 — 양 TUI 실측).
  const msg = typeof text === 'string' && text.trim() ? text.trim().replace(/\s*\n\s*/g, ' ') : null;
  if (!msg) {
    await io.key(String(n), true);
    for (let i = 0; i < 10; i++) {
      if (!up(await io.screen())) return { ok: true, picked: n };   // 다이얼로그 소멸 = 전달 완료
      await sleep(300);
    }
    throw Object.assign(new Error('다이얼로그가 닫히지 않았습니다 — TUI 를 직접 확인해 주세요'), { code: 'DRIVE_INCOMPLETE' });
  }

  // flow 는 파서가 "Tab to amend" 힌트로 판별해 넘긴다. 방어적으로 화면에서도 재판별(스테일 메타 대비).
  const interrupt = flow === 'interrupt' || (flow !== 'amend' && !/tab to amend/i.test(s0));
  if (interrupt) {
    // 인라인 입력이 없는 다이얼로그(codex 전부 + claude Fetch 등 — 2026-07-29 각각 실측):
    //  "tell … what to do differently" 선택 → 대화 인터럽트 → 컴포저에 코멘트 타이핑+Enter 하면
    //  그 지시가 모델에 전달된다. 인터럽트 이후는 실패해도 복구 경로가 없으므로(거절은 이미 전달됨)
    //  주입은 최선 노력으로 완주한다.
    await io.key(String(n), true);
    for (let i = 0; i < 10; i++) {
      if (!up(await io.screen())) break;
      await sleep(300);
    }
    await sleep(400);                    // 컴포저 포커스 복귀 대기
    await io.key(msg, true);
    await sleep(250);
    await io.key('Enter');
    return { ok: true, picked: n, injected: true };
  }

  // claude(2026-07-29 실측): 하이라이트를 대상 옵션으로 옮기고(❯), Tab 으로 인라인 입력을 켠 뒤
  //  타이핑+Enter. Tab 은 옵션별 토글이라 푸터에 "Tab to amend" 가 있을 때만 누른다(이미 입력
  //  모드거나 입력 불가 옵션이면 생략 — 불가 옵션은 타이핑이 무시되고 선택만 전달된다).
  const hlOf = (s) => {
    const m = /^\s*[❯›]\s*([1-9])\./m.exec(s);
    return m ? parseInt(m[1], 10) : null;
  };
  let cur = hlOf(s0);
  for (let hop = 0; hop < 3 && cur != null && cur !== n; hop++) {
    const delta = n - cur;
    for (let i = 0; i < Math.abs(delta) && i < 8; i++) await io.key(delta > 0 ? 'Down' : 'Up');
    cur = hlOf(await io.screen());
  }
  if (cur != null && cur !== n) {
    throw Object.assign(new Error('선택지로 이동하지 못했습니다 — TUI 를 직접 확인해 주세요'), { code: 'DRIVE_INCOMPLETE' });
  }
  if (/Tab to amend/i.test(await io.screen())) await io.key('Tab');
  await io.key(msg, true);
  await sleep(250);
  await io.key('Enter');
  for (let i = 0; i < 10; i++) {
    if (!up(await io.screen())) return { ok: true, picked: n, amended: true };
    await sleep(300);
  }
  throw Object.assign(new Error('다이얼로그가 닫히지 않았습니다 — TUI 를 직접 확인해 주세요'), { code: 'DRIVE_INCOMPLETE' });
}

async function permissionAnswer({ cwd, tid, pick, expect, text, flow } = {}) {
  const { io, win } = dialogIoFor(cwd, tid);
  await io.ready;
  const r = await drivePermissionDialog(io, { pick, expect, text, flow });
  return { ...r, tid: win };
}

// ── 에이전트 모드 전환(chat.mode) — 채팅 알약 → TUI shift+tab ────────────────────
// claude 는 권한 모드를 **shift+tab 한 방향 순환**으로만 바꾼다(직접 지정 키/명령 없음, 2.1.220 실측).
//  순환 순서는 세션 조건에 따라 달라지므로(bypass 는 --dangerously-skip-permissions 세션에서만 낀다)
//  순서를 코드에 박지 않는다 — **화면의 라벨을 읽고 → BTab → 다시 읽기**를 목표가 나올 때까지 반복한다
//  (드라이브 후 화면으로 검증하는 기존 다이얼로그 조작과 같은 규율).
// 안전장치: 다이얼로그가 떠 있으면 조작하지 않는다(그 화면에서 shift+tab 은 모드 키가 아니다).
// ★ 2026-08-03 실측(격리 claude 2.1.220): shift+tab 한 칸의 화면 반영은 **8~30ms** 다.
//  종전엔 90ms 고정 sleep 이라 3칸 이동에 270ms 를 그냥 기다렸다. 고정 대기 대신 **바뀔 때까지
//  짧게 폴링**한다 — 대부분 첫 폴에서 끝나고, 느린 순간에도 상한 안에서 알아서 기다린다.
const MODE_SETTLE_MS = 20;    // 폴링 간격
const MODE_SETTLE_TRIES = 25; // 상한 500ms(느린 머신/큰 화면 대비)
const MODE_HOP_MS = 90;    // (구) 고정 대기 — codex 2상태 토글의 확인 주기로만 남는다
const MODE_KEY_GAP_MS = 0; // 모드 순환은 매 키마다 화면으로 검증하므로 다이얼로그용 고정 간격이 불필요
const MODE_MAX_HOPS = 6;   // 현재 최대 5모드 — 한 바퀴를 넘기면 순환 불가로 본다

/**
 * 키를 보낸 뒤 **모드가 실제로 바뀔 때까지** 짧게 폴링한다(고정 sleep 대신).
 *  실측 8~30ms 라 보통 1~2회면 끝난다. 상한을 넘기면 null — 호출측이 다음 hop 에서 다시 본다.
 */
async function waitModeChange(read, from, sleep) {
  for (let i = 0; i < MODE_SETTLE_TRIES; i++) {
    await sleep(MODE_SETTLE_MS);
    const m = await read();
    if (m && m.id !== from) return m;
  }
  return null;
}

async function driveMode(io, { mode } = {}) {
  const statusLib = require('./status-line');
  const want = String(mode || '');
  if (!statusLib.MODE_IDS.includes(want)) {
    throw Object.assign(new Error('알 수 없는 모드입니다'), { code: 'BAD_REQUEST' });
  }
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const dialogUp = (s) => /Enter to select/.test(s)
    || (/(Do you want to|Would you like to) .{0,160}\?/.test(s) && /^\s*[❯›>]?\s*[1-9]\.\s+\S/m.test(s));

  const read = async () => {
    const s = await io.screen();
    if (dialogUp(s)) {
      throw Object.assign(new Error('지금은 이 터미널에 다이얼로그가 떠 있어 모드를 바꿀 수 없습니다'), { code: 'MODE_BLOCKED' });
    }
    return statusLib.extractMode(s, 'claude');
  };

  let cur = await read();
  if (!cur) {
    throw Object.assign(new Error('화면에서 현재 모드를 읽을 수 없습니다 — TUI 를 확인해 주세요'), { code: 'MODE_UNKNOWN' });
  }
  // 실측 순환(2.1.220 일반 세션): default → acceptEdits → plan → auto (한 방향). bypassPermissions 는
  //  `--dangerously-skip-permissions` 세션에만 낀다 → 순서를 코드에 박지 않고 **화면으로 확인하며** 돈다.
  for (let hop = 0; hop < MODE_MAX_HOPS && cur.id !== want; hop++) {
    const from = cur.id;
    await io.key('BTab');                    // = shift+tab(\e[Z)
    const next = await waitModeChange(read, from, sleep);
    if (next) cur = next;                    // 상한까지 안 바뀌면 한 틱 건너뛴다(다음 hop 에서 다시 확인)
  }
  if (cur.id !== want) {
    throw Object.assign(new Error('그 모드로 전환하지 못했습니다(이 세션에서 지원하지 않는 모드일 수 있어요)'), { code: 'MODE_UNREACHABLE' });
  }
  return { ok: true, mode: cur };
}

// 화면 확인 주기 — 키를 보낸 뒤 TUI 리페인트를 기다리는 값(실측). 카드 조작·모드 전환 공용.
const DIALOG_STEP_MS = 160;
const DIALOG_WAIT_TRIES = 12;

// ── codex 모드 전환 — shift+tab(Default ↔ Plan) 그 하나뿐 ─────────────────────
// 사용자 확정(2026-08-03): 알약은 **shift+tab 이 바꾸는 것만** 조작한다. 권한(`/permissions`)은
//  다른 축이고, 팔레트에서 그 명령을 실행하면 선택 화면 카드가 떠서 거기서 고른다(제자리).
//  덕분에 모드 전환은 **컴포저를 한 글자도 건드리지 않는다** — 슬래시를 타이핑하던 옛 경로가
//  사라지면서 "사용자가 쓰던 글 위에 붙어 전송" 같은 사고 표면 자체가 없어진다.
async function driveCodexMode(io, { mode } = {}) {
  const statusLib = require('./status-line');
  const want = String(mode || '');
  if (!statusLib.CODEX_MODE_IDS.includes(want)) {
    throw Object.assign(new Error('알 수 없는 모드입니다'), { code: 'BAD_REQUEST' });
  }
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const read = async () => statusLib.extractMode(await io.screen(), 'codex');

  const cur = await read();
  if (!cur) {
    throw Object.assign(new Error('화면에서 현재 모드를 읽을 수 없습니다 — TUI 를 확인해 주세요'), { code: 'MODE_UNKNOWN' });
  }
  if (cur.id === want) return { ok: true, mode: cur };   // 이미 그 상태 — 누르면 반대로 간다
  await io.key('BTab');
  const next = await waitModeChange(read, cur.id, sleep);
  if (next && next.id === want) return { ok: true, mode: next };
  throw Object.assign(new Error('모드를 전환하지 못했습니다'), { code: 'MODE_UNREACHABLE' });
}

/**
 * chat.dialog — 채팅 카드로 미러한 TUI 선택 화면을 조작한다. { cwd, tid, pick|cancel, expect? }
 *  · pick   = 그 번호 키를 누른다(실측: claude /model · codex /permissions 모두 숫자 한 번에 적용).
 *             일부 화면은 번호가 커서만 옮기므로, 그대로 남아 있으면 Enter 를 **한 번만** 덧붙인다.
 *  · cancel = Escape.
 * ★ expect(제목)를 반드시 대조한다: 카드를 누르는 사이 화면이 바뀌었으면 **다른 질문에 대신 답하는**
 *   사고가 된다(승인 다이얼로그 조작에서 확립된 규율 — QUESTION_MISMATCH 와 같은 이유).
 */
async function driveDialog(io, { pick, cancel, expect } = {}) {
  const statusLib = require('./status-line');
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cur = statusLib.extractDialog(await io.screen());
  if (!cur) throw Object.assign(new Error('지금 이 터미널에 선택 화면이 떠 있지 않습니다'), { code: 'DIALOG_GONE' });
  if (expect && String(expect).trim() && cur.title !== String(expect).trim()) {
    throw Object.assign(new Error('화면의 선택지가 카드와 다릅니다 — 다시 확인해 주세요'), { code: 'DIALOG_MISMATCH' });
  }
  if (cancel) {
    await io.key('Escape');
    await sleep(DIALOG_STEP_MS);
    return { ok: true, dialog: statusLib.extractDialog(await io.screen()) };
  }
  const n = parseInt(pick, 10);
  if (!(n >= 1 && n <= cur.options.length)) {
    throw Object.assign(new Error('선택 번호가 올바르지 않습니다'), { code: 'BAD_REQUEST' });
  }
  await io.key(String(n), true);
  let enterTried = false;
  for (let i = 0; i < DIALOG_WAIT_TRIES; i++) {
    await sleep(DIALOG_STEP_MS);
    const next = statusLib.extractDialog(await io.screen());
    // 같은 화면이 그대로면(번호가 커서만 옮기는 형식) Enter 로 확정 — 딱 한 번만 시도한다.
    if (!next || next.title !== cur.title) return { ok: true, dialog: next || null };
    if (!enterTried && i >= 2) { enterTried = true; await io.key('Enter'); }
  }
  throw Object.assign(new Error('선택이 반영되지 않았습니다 — TUI 를 확인해 주세요'), { code: 'DIALOG_STUCK' });
}

/** chat.dialog — { cwd, tid, pick|cancel, expect? } → { ok, tid, dialog }. */
async function chatDialog({ cwd, tid, pick, cancel, expect } = {}) {
  const { io, win } = dialogIoFor(cwd, tid, { keyGapMs: MODE_KEY_GAP_MS });
  await io.ready;
  const r = await driveDialog(io, { pick, cancel, expect });
  // 감시자를 깨워 다른 기기의 카드도 즉시 갱신한다(폴링 3초를 기다리지 않는다).
  //  burst 인 이유: 고른 뒤 화면이 두 번 움직인다(카드가 걷히고 → 상태줄/후속 확인 화면이 뜬다).
  try {
    const { session } = ptyLib.sessionForCwd(typeof cwd === 'string' ? cwd : '');
    require('./status-line').pokeTermSession(ptyLib.termSession(session, win), { burst: true });
  } catch (_) { /* noop */ }
  return { ...r, tid: win };
}

/**
 * chat.screen — { cwd, tid, agent? } → { lines, mode, dialog }. 대화 바인딩과 **무관한** 화면 상태.
 *  대화 파일과 짝이 안 지어진 터미널(codex ambiguous 등)에서도 상태줄·모드 알약·선택 화면 카드가
 *  나와야 하기 때문에 둔다(2026-08-03 실사고). 감시자는 chatId 로만 라우팅되므로 이 경로는 폴링용.
 */
async function chatScreen({ cwd, tid, agent } = {}) {
  const win = Number.isInteger(tid) ? tid : (typeof tid === 'string' && /^\d+$/.test(tid) ? parseInt(tid, 10) : null);
  if (win == null) throw Object.assign(new Error('대상 터미널(tid)이 필요합니다'), { code: 'BAD_REQUEST' });
  const cwdRel = typeof cwd === 'string' ? cwd : '';
  const r = await require('./status-line').screenFor({ cwdRel, tid: win, agent });
  // 대화 바인딩이 없는 터미널도 **공식 상태**는 있을 수 있다(claude 훅은 첫 턴 전에도 온다).
  const st = (() => {
    try { return require('./transcript').agentStatusForTerm(cwdRel, win, agent || (r && r.agent) || 'claude'); }
    catch (_) { return null; }
  })();
  return {
    lines: (r && r.lines) || null, mode: (r && r.mode) || null, dialog: (r && r.dialog) || null,
    ...(st ? { agentStatus: st } : {}), tid: win,
  };
}

/**
 * chat.commands — { cwd, tid, agent? } → { agent, items:[{name,desc,chat,source}] }.
 *  TUI 의 `/` 목록을 채팅 팔레트로 내준다(commands.js 헤더가 카탈로그 정본).
 *  에이전트는 호출측이 주면 그걸 쓰고(대화에서 이미 안다), 없으면 화면으로 판정한다.
 */
async function chatCommands({ cwd, tid, agent } = {}) {
  const cwdRel = typeof cwd === 'string' ? cwd : '';
  const { abs } = ptyLib.sessionForCwd(cwdRel);
  let a = agent === 'claude' || agent === 'codex' ? agent : null;
  if (!a && (Number.isInteger(tid) || /^\d+$/.test(String(tid || '')))) {
    try {
      const { io } = dialogIoFor(cwdRel, tid);
      a = require('./status-line').detectAgent(await io.screen());
    } catch (_) { /* 터미널이 없거나 화면을 못 읽음 — 아래 기본값 */ }
  }
  return require('./commands').listCommands({ agent: a || 'claude', cwdAbs: abs });
}

/** chat.mode — { cwd, tid, mode } → { ok, mode:{id,label,symbol[,plan]}, tid }. mode 생략 시 읽기만. */
async function chatMode({ cwd, tid, mode } = {}) {
  const { io, win } = dialogIoFor(cwd, tid, { keyGapMs: MODE_KEY_GAP_MS });
  await io.ready;
  const statusLib = require('./status-line');
  // 어느 CLI 인지는 **화면으로** 판정한다 — 호출측(앱/PC)이 에이전트를 실어 보내지 않아도 되고,
  //  세션 도중 다른 CLI 로 바뀌어도 그 순간의 화면이 정본이다.
  const screen0 = await io.screen();
  const agent = statusLib.detectAgent(screen0);
  if (mode == null || mode === '') {
    return { ok: true, mode: statusLib.extractMode(screen0, agent), tid: win, agent };
  }
  const r = agent === 'codex' ? await driveCodexMode(io, { mode }) : await driveMode(io, { mode });
  // 바꾼 직후 **다른 기기들**도 바로 알아야 한다(폰에서 바꾸면 PC 알약도 즉시) — 감시자를 깨워
  //  다음 폴링(3초)을 기다리지 않고 emit 하게 한다. 요청한 기기는 이미 응답으로 받았다.
  try {
    const { session } = ptyLib.sessionForCwd(typeof cwd === 'string' ? cwd : '');
    require('./status-line').pokeTermSession(ptyLib.termSession(session, win));
  } catch (_) { /* noop */ }
  return { ...r, tid: win };
}

// ── 컴포저 메시지 주입(훅 경로의 "허용하고 추가 지시" = TUI 의 "Yes, and tell Claude what to do
//  next" 동치) ────────────────────────────────────────────────────────────────
// 훅이 allow 로 답하면 다이얼로그가 닫히고 에이전트가 실행을 계속한다. 그 직후 컴포저에 지시를
//  타이핑+Enter 하면 실행 중엔 큐잉, 유휴면 즉시 전달된다(터미널에 직접 치는 것과 동일 경로).
//  다이얼로그가 아직 화면에 있으면(훅 응답 반영 지연) 닫힐 때까지 짧게 기다린다 — 다이얼로그 위에
//  타이핑하면 입력이 무시되거나(비입력 모드) Enter 가 하이라이트 옵션을 눌러버린다.
async function composerInject({ cwd, tid, text } = {}) {
  const msg = typeof text === 'string' && text.trim() ? text.trim().replace(/\s*\n\s*/g, ' ') : null;
  if (!msg) return { ok: false };
  const { io, win } = dialogIoFor(cwd, tid);
  await io.ready;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // ⚠ 푸터("esc to cancel")를 조건으로 걸지 않는다 — claude Fetch 다이얼로그는 푸터가 없다
  //  (2026-07-29 실사고). 질문 줄 + 번호 옵션 행 존재로 판정하고, expect(명령 조각)가 오조작을 막는다.
  const up = (s) => /(Do you want to|Would you like to) .{0,160}\?/.test(s) && /^\s*[❯›>]?\s*[1-9]\.\s+\S/m.test(s);
  for (let i = 0; i < 10; i++) {
    if (!up(await io.screen())) break;
    await sleep(300);
  }
  await io.key(msg, true);
  await sleep(250);
  await io.key('Enter');
  return { ok: true, tid: win };
}

// ── 훅 대기 중 TUI 다이얼로그 캡처(승인 카드 내용 보강용) ─────────────────────
// 훅이 결정을 기다리는 동안 TUI 는 같은 다이얼로그를 **동시에** 그린다(2026-07-29 기실측 —
//  hook_state_f3 라운드). 그 화면을 파싱해 카드가 TUI 원문(제목/본문/질문 줄/선택지 문구)을
//  그대로 싣게 한다 — 도구별 문구 템플릿 흉내가 아니라 화면이 정본(채팅=TUI 원칙).
async function captureDialog({ cwd, tid } = {}) {
  const { io } = dialogIoFor(cwd, tid);
  await io.ready;
  const screen = await io.screen();
  return require('./question-revive')._parsePermissionDialog(screen);
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
  // 이 PC 에 설치된 AI CLI 조회(읽기 전용). `agents.wire`/`agents.rescan` 는 아래 이유로 비공개.
  'agents.list',
  // 조회 전용(사람/AI 노출 안전) — 승인 대기 목록 + 트랜스크립트 읽기.
  'approval.list',
  'chat.sessions', 'chat.open', 'chat.since', 'chat.close', 'chat.detail', 'chat.attachment',
  // ⚠ 아래는 의도적으로 비공개다(daemon.shutdown/forward.start 선례).
  //  판단 기준은 하나다: **`cpt` 는 터미널 안의 AI 도 부를 수 있는 CLI** 이므로, 노출하면 AI 가
  //  "사람만 할 수 있어야 하는 일"(자기 승인·자기 주입·포트 개방·서버가 못 보는 경로로 파일 접근)을
  //  스스로 하게 되는 커맨드는 목록에 넣지 않는다. 애매하면 비공개(나중에 열 수는 있다).
  //  · approval.request — 훅 전용 내부 커맨드(사람이 부를 것이 아니고, 부르면 그 터미널이 블록된다)
  //  · approval.respond — 터미널의 AI 가 자기 승인을 스스로 허용하는 경로가 된다(CPT_APPROVAL_LOCAL 게이트)
  //  · chat.input — AI 가 자기/타 세션에 프롬프트를 주입하는 자기루프 경로(응답은 back RPC 로만)
  //  · forward.start/stop — 이 기기에 127.0.0.1 리스너를 여는 포트 개방 경로(PC 앱이 수명 주인)
  //  · sync.checkpoint — PC 앱 트리거 전용(begin/commit 왕복 제거용 내부 경로)
  //  · lan.probe / lan.status / lan.rpc — (계약 §4.5) `lan.rpc` 는 **서버가 보지 못하는 경로로 다른 PC
  //    의 파일을 읽고 쓰는 수단**을 AI 에게 직접 주는 것이고(허용 접두사에 fs.write 가 있다),
  //    `lan.probe` 는 사설 IP·포트·RTT = 사용자 내부망 지형을 프롬프트 컨텍스트로 유출한다.
  //    사람이 부를 이유도 없다(진단은 `~/.codingpt/*.log` 의 [lan] 라인 + PC 배지로 충분).
  //    읽기 전용인 lan.status 만 훗날 공개하는 것은 안전하지만, 지금은 셋 다 닫는다.
  //  · agents.wire / agents.rescan / agents.launch — wire 는 **터미널 안의 AI 가 자기 승인 훅을
  //    스스로 끄는 경로**다(approval.respond 를 닫는 것과 같은 이유). rescan 은 shim 을 재생성하고,
  //    launch 는 AI 가 다른 터미널에 에이전트를 띄우는 자기증식 경로라 셋 다 사람(UI)만 부른다.
  //  · e2ee.* — 열쇠 승인/거절/정책/복구코드/봉투 RPC. 승인(approve)은 **새 기기에 마스터키를 넘기는
  //    행위**이고 recovery.create 는 열쇠 자체를 텍스트로 뽑는다 — 승인 인박스(기능1)와 같은 이유로
  //    사람만 할 수 있어야 한다. openText(알림 복호)도 봉인된 내용을 평문으로 꺼내는 경로다.
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
    let handled = false; // 한 커넥션 = 한 요청(one-shot). 블로킹 대기 중 도착한 추가 데이터는 무시한다.
    let uiClient = null; // ui.attach 로 승격되면 지속(양방향) 모드 — one-shot 규약의 유일한 예외
    // ⚠ conn.setTimeout 을 걸지 말 것 — 원격 승인(approval.request)은 이 커넥션을 수 분간 유지한다.
    //  유휴 종료를 넣으면 사용자가 폰에서 답하기 전에 대기가 끊겨 매번 TUI 로 폴백한다.
    const drainUiFrames = () => {
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let f = null;
        try { f = JSON.parse(line); } catch (_) { continue; } // 깨진 프레임 1개는 건너뛴다(연결 유지)
        handleLocalUiFrame(uiClient, f);
      }
    };
    conn.on('data', async (d) => {
      buf += d.toString();
      if (uiClient) {
        // 지속 모드 — NDJSON 프레임 스트림. 프레임 상한은 one-shot 보다 크다(ui_result 페이로드).
        if (buf.length > MAX_UI_FRAME_BYTES) { try { conn.destroy(); } catch (_) { /* noop */ } return; }
        drainUiFrames();
        return;
      }
      if (buf.length > MAX_REQ_BYTES) { try { conn.end(); } catch (_) { /* noop */ } return; }
      const i = buf.indexOf('\n');
      if (i < 0 || handled) return;
      handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, i)); } catch (_) { try { conn.end(); } catch (_) { /* noop */ } return; }
      const id = req && req.id;
      // ui.attach = 로컬 UI 채널 승격(응답 후 닫지 않는다). CAPABILITIES 비공개(내부용 — PC 앱 전용).
      if (req && req.cmd === 'ui.attach') {
        buf = buf.slice(i + 1);
        uiClient = attachLocalUi(conn, req.args || {});
        try { conn.write(JSON.stringify({ id, ok: true, result: { attached: true, pid: process.pid } }) + '\n'); } catch (_) { /* noop */ }
        drainUiFrames(); // attach 요청과 같은 청크에 프레임이 붙어 왔을 수 있다
        return;
      }
      try {
        // conn 을 넘긴다 — 장기 대기 커맨드가 "요청자가 사라짐"(훅 프로세스 종료)을 감지해 즉시 정리한다.
        const result = await dispatch(req, conn);
        conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (e) {
        conn.write(JSON.stringify({ id, ok: false, error: (e && e.message) || String(e), code: (e && e.code) || undefined }) + '\n');
      }
      try { conn.end(); } catch (_) { /* one-shot */ }
    });
    conn.on('close', () => { if (uiClient) detachLocalUi(uiClient); });
    conn.on('error', () => { /* noop — 대기 중 상대가 죽으면 EPIPE. close 로 처리된다 */ });
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
  chatInput, // 채팅 입력(PTY 하네스) — control.js 의 back rpc 경로도 이 구현을 쓴다
  chatAnswer, // TUI 질문 다이얼로그 원격 조작 — control.js 의 chat.answer 가 위임
  chatMode, // 에이전트 모드 전환(shift+tab 드라이브) — control.js 의 chat.mode 가 위임
  chatCommands, // 슬래시 명령 팔레트 목록 — control.js 의 chat.commands 가 위임
  chatDialog, // TUI 선택 화면 카드 조작 — control.js 의 chat.dialog 가 위임
  chatScreen, // 대화 바인딩 없는 터미널의 화면 상태(상태줄·모드·선택 화면)
  _driveChatDialog: driveDialog, // 테스트/격리 검증용(io 주입)
  permissionAnswer, // TUI 권한 다이얼로그 원격 조작 — question-revive 의 권한 카드 drive 가 위임
  composerInject, // 훅 경로 "허용+추가 지시" — approvals.resolveRemote 가 allow 후 위임
  captureDialog, // 훅 대기 중 TUI 다이얼로그 캡처 — approvals 의 카드 내용 보강이 위임
  _driveQuestionDialog: driveQuestionDialog, // 테스트/격리 검증용(io 주입)
  _drivePermissionDialog: drivePermissionDialog,
  _driveMode: driveMode,
  _driveCodexMode: driveCodexMode,          // 테스트/격리 검증용(io 주입)
  _clearComposerResidue: clearComposerResidue, // 테스트/격리 검증용
  // 테스트 전용 — 소켓 프레임 없이 명령 디스패치만 태운다(앱 내부용 명령의 게이트 회귀 고정).
  _dispatch: dispatch,
  handleAgentsRpc, // 에이전트 관리(agents.*) — control.js 의 back rpc 경로도 이 구현을 쓴다(단일 출처)
  _sendUiCommand: sendUiCommand, // 테스트 전용(control-teardown.test.js) — 프로덕션 코드에서 직접 쓰지 말 것
  // 테스트 전용(local-ui-route.test.js) — 로컬 UI 채널 라우팅 배타성 고정. 프로덕션에서 직접 쓰지 말 것.
  _localUi: { clients: localUiClients, attach: attachLocalUi, detach: detachLocalUi, frame: handleLocalUiFrame, pick: pickLocalUi, forTarget: localUiFor },
};
