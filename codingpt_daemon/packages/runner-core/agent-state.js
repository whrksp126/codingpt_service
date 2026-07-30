/**
 * 에이전트 상태의 단일 소유자(agent-state) — 훅 자기보고(주력) + agent-watch(폴백)의 유일한 화해 지점.
 *
 * 왜 이 모듈이 필요한가:
 *  · 지금까지 상태는 agent-watch.states(tmux 2s 폴링 파생) 하나뿐이었고, 훅(hook.event)은 상태를
 *    갱신하지 않고 알림만 발사했다. 그래서 (a) `cpt terminal wait` 는 훅이 정상 동작해도 폴링 지연을
 *    그대로 먹고, (b) "훅 알림 + 폴백 알림" 이중 발사를 시각 기반 dedup(15s 창) 하나로만 막고 있었다.
 *  · 상태와 알림 발사 권한을 여기 한 곳에 모으면 이중 발사가 시각 휴리스틱이 아니라 구조로 차단된다
 *    (같은 key 에 대해 kind 별 REFIRE_MIN_MS 집행 + hookGoverned 우선순위).
 *
 * 설계 원칙:
 *  · 순수 스토어 + 순수 판정. 타이머 없음, tmux/HTTP 직접 호출 없음. 외부 의존(알림 전송·시각·로그)은
 *    configure()/start() 로 주입 가능 → 테스트가 tmux/back 없이 전이표 전항목을 검증한다.
 *  · key = tmux 세션명 "<ns>--t-<tid>"(pty.termSession). tid 가 31-bit 안정 ID라 재접속/기기변경에 불변.
 *  · 알림 payload 는 기존 계약(POST /api/notifications) 그대로 — 서버 무수정으로 동작해야 한다.
 *  · 모르는 event/notificationType 은 throw 하지 않고 무시한다(구 CLI ↔ 신 데몬, 신 CLI ↔ 구 데몬 혼재 안전).
 *  · 상태 방출(agent_state 프레임)도 여기서 한다 — bump() 가 유일한 변경 지점이므로 방출 지점도 하나다.
 *    (계약 정본: docs/구현설계-2026-07-25/11-배관-계약.md §1.3)
 */
const path = require('path');

const HOOK_GOVERN_MS = 10 * 60 * 1000; // 이 시간 안에 훅을 받은 터미널 = 훅이 지배(폴백은 관찰만)
const REFIRE_MIN_MS = 8000;            // 같은 key + 같은 kind 최소 재발사 간격(이중 알림 구조적 차단)
const PERMISSION_DEDUP_MS = 8000;      // PermissionRequest(즉시) ↔ Notification(permission_prompt, 6s 뒤) 동일 사건 창
const HOOK_RECENT_MS = 15000;          // 레거시 noteHook(cwdRel|win) dedup 창 — agent-watch HOOK_DEDUP_MS 미러
const PRIMARY_STALE_MS = HOOK_GOVERN_MS; // 주 세션이 이 시간 무소식이면 다른 sessionId 가 승계 가능
const SUMMARY_MAX = 2000;
const TOMB_MAX = 200;
const AGENT_STATE_CAP = 'agentstate.v1';   // 서버가 수신·검증·팬아웃 코드를 가진 커밋에서만 선언한다(caps 교리)

// 훅 event 도메인. pre_tool/post_tool 은 1단계 미구독이지만 값이 와도 조용히 무시한다.
const HOOK_EVENTS = new Set(['session_start', 'prompt', 'permission', 'notification', 'stop', 'stop_failure', 'session_end']);
// 알림 타이틀(기존 cpt-server/agent-watch 문구 유지 — 클라이언트가 보는 문자열이라 바꾸지 않는다).
const AGENT_TITLES = new Map([['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI']]);
// subtitle 은 서버도 조합할 수 있지만(SUBTITLE_SUFFIX), 기존 발사 문구와 1바이트도 달라지지 않게 여기서 유지.
const SUBTITLE = {
  done: (ws) => `「${ws}」에서 완료`,
  permission_request: (ws) => `「${ws}」에서 승인 대기`,
};

// ── 주입 가능한 외부 의존 ──
let nowFn = () => Date.now();
let notifyFn = null;                                  // null = 기본(cpt-server.backFetch)
let logFn = (msg) => { console.log(msg); };
let emitFn = null;                                    // null = 기본(control.sendEvent + caps 게이팅)

// 실제 알림 전송 — cpt-server 는 lazy require(순환 회피, agent-watch 와 동일 패턴).
async function defaultNotify(payload) {
  await require('./cpt-server').backFetch('POST', '/api/notifications', payload);
}

// 상태 프레임 전송 — control 은 lazy require(control → agent-state 단방향 유지). sendEvent 는 서버가
//  cap 을 선언하지 않았거나 연결이 없으면 **보내지 않고 false** 를 준다(구 back 안전 = 조용한 폴백).
function defaultEmit(frame) {
  try { return require('./control').sendEvent(frame, AGENT_STATE_CAP); } catch (_) { return false; }
}

function configure(opts = {}) {
  if (typeof opts.now === 'function') nowFn = opts.now;
  if (opts.notify !== undefined) notifyFn = typeof opts.notify === 'function' ? opts.notify : null;
  if (opts.log !== undefined) logFn = typeof opts.log === 'function' ? opts.log : () => {};
  if (opts.emit !== undefined) emitFn = typeof opts.emit === 'function' ? opts.emit : null;
  return module.exports;
}
// control.js 기동 순서용 진입점 — 타이머를 만들지 않는다(순수 스토어). 주입도 겸한다.
function start(opts) { return configure(opts || {}); }

// ── 스토어 ──
const states = new Map();   // key → rec
const wsHooks = new Map();  // `${cwdRel}|${win}` → 마지막 훅 수신 시각(레거시 noteHook 창)
const tombs = new Map();    // key → { lastHookAt, fires }  세션이 목록에서 사라졌다 돌아올 때 복원(중복 알림 방지)

function tidFromKey(key) {
  const m = /--t-(\d+)$/.exec(String(key || ''));
  return m ? parseInt(m[1], 10) : null;
}

// rec 생성/아이덴티티 보강. 나중에 알게 된 값만 채운다(null 로 덮지 않는다).
function ensure(key, id = {}) {
  let rec = states.get(key);
  if (!rec) {
    const t = nowFn();
    rec = {
      key,
      tid: id.tid != null ? id.tid : tidFromKey(key),
      cwdRel: id.cwdRel || null,
      wsName: id.wsName || (id.cwdRel ? path.basename(id.cwdRel) : null),
      agent: id.agent || null,
      state: 'launching',        // 아직 어떤 신호도 확정되지 않은 초기값
      version: 0,
      since: t,
      updatedAt: t,
      source: id.source || 'hook',
      lastHookAt: 0,
      sessionId: null,
      promptId: null,
      pending: null,
      summary: '',
      backgroundTasks: 0,
      sessionCrons: 0,
      // 내부용(스냅샷 비노출)
      fires: new Map(),          // kind → 마지막 발사 시각(REFIRE 집행)
      primarySessionId: null,    // §6-G 중첩 claude -p 오귀속 차단
      primaryAt: 0,
      primaryReleased: true,
    };
    const tomb = tombs.get(key);
    if (tomb) { // 목록에서 잠깐 사라졌던 터미널 — 훅 지배/발사 이력을 되살려 중복 알림을 막는다
      rec.lastHookAt = tomb.lastHookAt || 0;
      for (const [k, v] of tomb.fires) rec.fires.set(k, v);
      tombs.delete(key);
    }
    states.set(key, rec);
  }
  if (id.tid != null) rec.tid = id.tid;
  if (id.cwdRel) { rec.cwdRel = id.cwdRel; if (!id.wsName) rec.wsName = path.basename(id.cwdRel); }
  if (id.wsName) rec.wsName = id.wsName;
  if (id.agent) rec.agent = id.agent;
  return rec;
}

// 상태 기록 + 단조 version. 같은 key 안에서 갱신마다 +1 (전이가 없어도 소비자가 순서를 검증할 수 있게).
function bump(rec, next, source, ctx = {}) {
  const now = nowFn();
  const prev = rec.state;
  if (next && next !== prev) { rec.state = next; rec.since = now; }
  rec.version += 1;
  rec.updatedAt = now;
  rec.source = source;
  // §8 관측 계측: 훅 도착 지연(dt)까지 한 줄로 — 라이브에서 훅 배선 문제를 눈으로 잡을 수 있어야 한다.
  logFn(`[agent-state] ${rec.tid} ${prev}→${rec.state} v${rec.version} src=${source} ev=${ctx.ev || '-'}${ctx.dt != null ? ` dt=${ctx.dt}ms` : ''}`);
  emitState(rec);  // 와이어 state 가 바뀐 경우에만 실제로 나간다(내부 dedup)
  return rec;
}

// ── 상태 방출(기능3 2단계, 계약 §1.3) ─────────────────────────────────────────
//  왜 bump() 안에서 방출하는가: 상태를 바꾸는 지점이 여기 하나뿐이라 방출도 하나여야 한다. 호출부마다
//  emit 을 흩으면 한 경로를 빼먹었을 때 "어떤 전이만 가끔 늦는" 버그가 되고, 그건 폴백(tab.cmd, 5~9초)
//  으로 가려져 발견되지 않는다.
//
//  규율 4개(어기면 조용히 죽는다):
//   ① 와이어 state 는 클라이언트 도메인으로 접는다 — `ended → 'gone'`, `launching → 'idle'`.
//      ★ ended 를 그대로 보내면 PC `pane.js` 가 `st.state !== "gone"` 으로 판정해 claude 를 끝낸 뒤에도
//        Chat 토글이 영구히 켜진 채 남고 `tab.cmd` 폴백도 다시는 발동하지 않는다(push 우선 규칙).
//   ② 같은 와이어 state 로는 재방출하지 않는다 — 훅 7종이 도는 턴마다 version 만 오르는 프레임 폭주 차단.
//      이 억제는 알림 억제(fire 의 REFIRE_MIN_MS)와 **다른 축**이다: 저건 kind 별 시간창(8s)이고 이건
//      상태 변화 기준(시간 게이트 0)이다. 그래서 두 억제가 겹쳐 "전이가 늦게 나가는" 일은 없다.
//   ③ 좌표(cwdRel, tid)를 모르면 방출하지 않는다 — 클라이언트 색인 키가 (cwd, win) 이라 빈 값으로
//      보내면 홈 루트 워크스페이스와 충돌한다. 좌표를 알게 된 다음 bump 에서 나간다.
//   ④ 내용성 정보(summary/body/promptId/pending)는 절대 싣지 않는다 — 상태 프레임은 순수 메타데이터여야
//      E2EE 봉투 배관과 독립적으로 안전하다(요약은 알림 body 경로가 담당).
const lastEmitted = new Map();   // key → 마지막으로 **실제 전송에 성공한** 와이어 state

function wireStateOf(rec) {
  const s = rec && rec.state;
  if (s === 'ended') return 'gone';
  if (s === 'launching') return 'idle';   // statusOf() 와 같은 접기 규칙
  return s || 'idle';
}

// 실패(cap 미선언·연결 없음)는 캐시에 남기지 않는다 — 다음 bump 가 다시 시도하고, 첫 성공 프레임이
//  그 시점의 현재 상태를 실어 나른다(hello_ack 리싱크에만 의존하지 않는다).
function emitFrame(rec, wire, force) {
  if (rec.cwdRel == null || rec.tid == null) return false;
  if (!force && lastEmitted.get(rec.key) === wire) return false;
  const frame = {
    type: 'agent_state',
    event: {
      cwd: rec.cwdRel,
      win: rec.tid,
      state: wire,
      agent: rec.agent || null,
      version: rec.version,
      at: nowFn(),
      sessionId: rec.sessionId || null,
      source: rec.source || 'hook',
      since: rec.since,
    },
  };
  let sent = false;
  try { sent = !!(emitFn || defaultEmit)(frame); } catch (e) {
    logFn(`[agent-state] ${rec.tid} 상태 방출 실패: ${e && e.message}`); // 방출 실패는 무해(폴백)
    sent = false;
  }
  if (sent) lastEmitted.set(rec.key, wire);
  return sent;
}

function emitState(rec, force) { return emitFrame(rec, wireStateOf(rec), !!force); }

// 전체 리싱크 — back 이 재시작하면 인메모리 라스트-스테이트 인덱스가 통째로 사라지지만 데몬의 상태는
//  그대로다. hello_ack 에서 서버가 cap 을 선언했을 때만 부른다(구 서버엔 프레임을 던지지 않는다).
function resyncAll() {
  lastEmitted.clear();
  let sent = 0;
  for (const rec of states.values()) if (emitState(rec, true)) sent += 1;
  if (sent) logFn(`[agent-state] 상태 리싱크 ${sent}건 재방출`);
  return { sent, total: states.size };
}

// ── 부착 판정(pull 경로, 계약 §1.6) ────────────────────────────────────────
//  왜 필요한가: push(agent_state) 는 **전이가 있을 때만** 나가는 휘발성 신호라, 스테일(15분)·WS 재접속
//  공백·호스트 복귀·데몬 재기동 구간에서 클라이언트 쪽 상태가 빈다. 그때 클라가 프로세스 이름
//  (`tab.cmd`)으로 되짚는 구조가 이번 사고의 원인이었다(최신 claude 의 pane_current_command 는
//  `2.1.219` 같은 버전 문자열 = 어떤 이름 패턴에도 안 맞는다). 그래서 5~9초마다 무조건 다시 오는
//  터미널 목록(terminal.list)에 **데몬이 판정한 결과**를 실어 보낸다 — 이 함수가 그 판정의 상태 쪽 절반이다.
//
//  규율: "부착" 의 정의는 와이어 계약과 **한 벌**이어야 한다 → `wireStateOf(rec) !== 'gone'`.
//   · launching(훅은 왔지만 아직 상태 미확정)은 wireStateOf 가 idle 로 접으므로 부착으로 답한다.
//   · ended(셸 복귀·session_end)는 'gone' 이므로 즉시 미부착 — 빈 셸 탭에 토글이 굳지 않는다.
//  기록이 아예 없으면 attached:false + known:false 로 답한다(= "근거 없음". 목록 판정은 이때 제목
//  신호로 내려간다 — agent-watch.agentSignalOf 참조).
function attachmentOf(key) {
  const rec = states.get(String(key || ''));
  if (!rec) return { attached: false, known: false, agent: null, state: null, source: null, hookGoverned: false, ready: null };
  const wire = wireStateOf(rec);
  return {
    attached: wire !== 'gone',
    known: true,
    agent: rec.agent || null,
    state: wire,
    source: rec.source || null,
    hookGoverned: hookGoverned(rec.key),
    // Codex의 SessionStart 훅이 도착해야 sessionId가 생긴다. 프로젝트 신뢰 질문 중에는 false.
    ready: !!rec.sessionId,
  };
}

// ── 훅 생존/지배 판정 ──
function hookGoverned(key) {
  const rec = states.get(String(key || ''));
  if (!rec) {
    const tomb = tombs.get(String(key || ''));
    return !!(tomb && nowFn() - (tomb.lastHookAt || 0) < HOOK_GOVERN_MS);
  }
  return nowFn() - (rec.lastHookAt || 0) < HOOK_GOVERN_MS;
}

// 레거시 창구 — cpt-server / agent-watch.noteHook 이 (cwdRel,win) 로 훅 생존을 신고한다.
//  key(세션명)를 모르는 호출자(cwdRel 은 sanitize 로 세션명 역산 불가)를 위해 별도 맵을 유지한다.
function noteHook(cwdRel, win) {
  wsHooks.set(`${cwdRel || ''}|${win == null ? '' : win}`, nowFn());
  if (wsHooks.size > 200) {
    const cut = nowFn() - HOOK_RECENT_MS * 2;
    for (const [k, ts] of wsHooks) if (ts < cut) wsHooks.delete(k);
  }
}

function hookRecent(cwdRel, win) {
  const ts = wsHooks.get(`${cwdRel || ''}|${win == null ? '' : win}`);
  return !!ts && nowFn() - ts < HOOK_RECENT_MS;
}

// ── 알림 발사(단일 창구) ──
//  REFIRE_MIN_MS 집행이 여기 한 곳에 있어야 "훅 + 폴백 동시 도착 = 정확히 1건" 이 구조로 보장된다.
async function fire(rec, kind, opts = {}) {
  const now = nowFn();
  const last = rec.fires.get(kind) || 0;
  if (now - last < REFIRE_MIN_MS) {
    logFn(`[agent-state] ${rec.tid} 알림 억제(refire ${kind}, ${now - last}ms) src=${opts.source || rec.source}`);
    return { fired: false, reason: 'refire' };
  }
  rec.fires.set(kind, now);
  const wsName = rec.wsName || (rec.cwdRel ? path.basename(rec.cwdRel) : '');
  const title = opts.agentName || AGENT_TITLES.get(rec.agent) || 'AI 에이전트';
  const body = opts.body ? String(opts.body).slice(0, SUMMARY_MAX) : undefined;
  const payload = {
    source: opts.source || rec.source || 'hook',
    kind,
    title,
    subtitle: wsName && SUBTITLE[kind] ? SUBTITLE[kind](wsName) : undefined,
    body,
    cwd: rec.cwdRel || undefined,
    wsName: wsName || undefined,
    win: rec.tid != null ? rec.tid : undefined,
    sessionId: rec.sessionId || undefined,
  };
  try {
    await (notifyFn || defaultNotify)(payload);
    logFn(`[agent-state] ${rec.tid} 알림 발송: ${kind} src=${payload.source}`);
    return { fired: true, payload };
  } catch (e) {
    // 서버 미가용/미페어링 등 — 상태는 이미 갱신됐고 알림은 다음 기회. 훅을 절대 실패시키지 않는다.
    logFn(`[agent-state] ${rec.tid} 알림 실패(${kind}): ${e && e.message}`);
    return { fired: false, reason: 'error', error: e };
  }
}

/**
 * 훅 이벤트 적용 — 상태의 1차 소유자 경로.
 *  applyHook(key, ev)  ev = hook.event v2 args + { cwdRel, tid, wsName }
 *  (방어적으로 applyHook(ev) 단일 인자도 허용 — ev.key|ev.session 에서 key 를 얻는다)
 * 반환: { ok, state, version, clearedProgress, notified, ignored? }
 */
async function applyHook(key, ev = {}) {
  if (key && typeof key === 'object') { ev = key; key = ev.key || ev.session || ''; }
  key = String(key || '');
  if (!key) return { ok: false, ignored: 'no_key' };

  const now = nowFn();
  const event = String(ev.event || '');
  const rec = ensure(key, {
    tid: ev.tid, cwdRel: ev.cwdRel, wsName: ev.wsName, agent: ev.agent || 'claude', source: 'hook',
  });
  // 훅이 도착했다는 사실 자체가 "이 터미널은 훅이 지배한다" 는 신호 — 이벤트를 무시하는 경로에서도 기록한다.
  rec.lastHookAt = now;
  if (ev.cwdRel != null || rec.cwdRel) noteHook(ev.cwdRel || rec.cwdRel, ev.tid != null ? ev.tid : rec.tid);
  const dt = Number.isFinite(Number(ev.at)) && Number(ev.at) > 0 ? Math.max(0, now - Number(ev.at)) : null;

  // 서브에이전트 이벤트는 상태/알림에서 제외(§6-F) — 병렬 5개면 "완료" 5건이 된다.
  //  ⚠ 판정 근거는 agent_id 뿐이다. agent_type 은 메인 세션 SessionStart 에도 실려 오므로(실측)
  //  그걸로 판정하면 메인 세션이 통째로 버려져 상태가 launching 에 고착된다. 구 CLI 가 보낸
  //  {id:null, type:'...'} 형태도 여기서 걸러진다(id 가 있을 때만 서브에이전트).
  const subId = (ev.subagent && ev.subagent.id) || ev.agentId || ev.agent_id || null;
  if (subId) {
    return { ok: true, ignored: 'subagent', state: rec.state, version: rec.version };
  }
  if (!HOOK_EVENTS.has(event)) {
    // 구/신 혼재 안전: 모르는 event 는 throw 하지 않는다(pre_tool/post_tool 포함).
    return { ok: true, ignored: 'unknown_event', state: rec.state, version: rec.version };
  }

  // 주 세션 고정(§6-G) — 같은 터미널에서 에이전트가 `claude -p` 를 중첩 실행하면 CPT_TID 를 상속해
  //  같은 key 로 Stop 훅이 날아온다(= 거짓 "완료"). 첫 세션을 주 세션으로 못박고 다른 sessionId 는 로그만.
  const sid = ev.sessionId ? String(ev.sessionId) : null;
  if (sid) {
    if (!rec.primarySessionId || rec.primaryReleased || now - (rec.primaryAt || 0) > PRIMARY_STALE_MS) {
      rec.primarySessionId = sid;
      rec.primaryReleased = false;
    }
    if (rec.primarySessionId !== sid) {
      logFn(`[agent-state] ${rec.tid} 다른 세션의 훅 무시(nested?) ev=${event} sid=${sid.slice(0, 8)} primary=${rec.primarySessionId.slice(0, 8)}`);
      return { ok: true, ignored: 'foreign_session', state: rec.state, version: rec.version };
    }
    rec.primaryAt = now;
    rec.sessionId = sid;
  }

  let next = null;        // null = 상태 무변경
  let kind = null;        // 발사할 알림 kind
  let body;
  let clearedProgress = false;

  switch (event) {
    case 'session_start':
      next = 'idle';
      rec.promptId = null; rec.pending = null; rec.backgroundTasks = 0;
      break;

    case 'prompt':
      next = 'working';
      rec.promptId = ev.promptId ? String(ev.promptId) : null;
      rec.pending = null;
      break;

    case 'permission':
      next = 'permission';
      rec.pending = {
        kind: 'permission',
        tool: (ev.tool && ev.tool.name) || null,
        at: now,
        notified: true,
        sessionId: rec.sessionId,
        promptId: ev.promptId ? String(ev.promptId) : rec.promptId,
      };
      kind = 'permission_request';
      body = ev.summary || undefined;
      break;

    case 'notification': {
      const nt = ev.notificationType ? String(ev.notificationType) : null;
      if (nt === 'permission_prompt') {
        // PermissionRequest(즉시)와 Notification(permission_prompt, 6s 뒤)은 같은 사건이다.
        //  tool_use_id 가 없어 (sessionId, promptId) + 8s 창으로 묶는다.
        const p = rec.pending;
        const evPid = ev.promptId ? String(ev.promptId) : null;
        const sameTurn = !!p && p.kind === 'permission'
          && (!p.sessionId || !sid || p.sessionId === sid)
          && (!p.promptId || !evPid || p.promptId === evPid);
        if (sameTurn && now - (p.at || 0) < PERMISSION_DEDUP_MS) {
          next = 'permission'; // 상태 유지 + 알림 억제(dedup)
          logFn(`[agent-state] ${rec.tid} 승인 알림 dedup(PermissionRequest 선발사 ${now - p.at}ms 전)`);
        } else {
          next = 'permission';
          rec.pending = { kind: 'permission', tool: null, at: now, notified: true, sessionId: rec.sessionId, promptId: evPid || rec.promptId };
          kind = 'permission_request';
          body = ev.summary || undefined;
        }
      } else if (nt === 'idle_prompt') {
        // 60초 유휴 = 사용자 입력 대기. 알림 kind 'needs_input' 은 미도입이라 1단계는 상태만 바꾼다.
        next = 'needsInput';
      }
      // 그 외 notification_type(auth_success 등) = 무변경(알림 없음)
      break;
    }

    case 'stop': {
      const bg = Math.max(0, Number(ev.backgroundTasks || 0) || 0);
      rec.backgroundTasks = bg;
      rec.sessionCrons = Math.max(0, Number(ev.sessionCrons || 0) || 0);
      if (ev.summary) rec.summary = String(ev.summary).slice(0, SUMMARY_MAX);
      if (bg > 0) {
        // "세션 종료" 가 아니라 "백그라운드 작업 대기 중 일시정지" — 여기서 done 을 내면 매번 오알림(§6-E).
        next = 'working';
        logFn(`[agent-state] ${rec.tid} stop 무시(backgroundTasks=${bg}) — working 유지`);
      } else {
        next = 'idle';
        rec.pending = null;
        kind = 'done';
        body = rec.summary || undefined;
        clearedProgress = true;
      }
      break;
    }

    case 'stop_failure':
      next = 'idle';
      rec.pending = null;
      kind = 'error';
      body = ev.summary || ev.errorDetails || ev.error || undefined;
      clearedProgress = true;
      break;

    case 'session_end':
      next = 'ended';
      rec.pending = null;
      rec.primaryReleased = true; // 다음 SessionStart(예: /clear, resume)가 주 세션을 새로 잡을 수 있게
      break;

    default:
      break;
  }

  bump(rec, next, 'hook', { ev: event, dt });
  let fired = null;
  if (kind) fired = await fire(rec, kind, { source: 'hook', body });
  return {
    ok: true,
    state: rec.state,
    version: rec.version,
    clearedProgress,
    notified: !!(fired && fired.fired),
  };
}

/**
 * 폴백(agent-watch) 관찰 적용 — agent-watch 가 상태/알림을 스스로 결정하지 않고 여기로만 넘긴다.
 *  applyWatch(key, obs)  (방어적으로 applyWatch(obs) 단일 인자도 허용)
 *
 *  obs 두 형태:
 *   ① 관찰 기록(매 폴링): { tid, cwdRel?, wsName?, agent?, agentName?, observedState:'working'|'idle'|'permission'|null,
 *                          shell?:bool, seed?:bool }
 *   ② 발사 요청(QUIET 창 통과 후): { ..., fire:'done'|'permission_request', exited?:bool, body? }
 *
 * 우선순위(정본): hookGoverned 면 폴백은 상태를 쓰지 못한다(관찰만). 예외 1개 —
 *  "에이전트→셸 전이"(프로세스 사망)는 훅이 낼 수 없는 신호라 항상 채택한다.
 */
async function applyWatch(key, obs = {}) {
  if (key && typeof key === 'object') { obs = key; key = obs.key || obs.session || ''; }
  key = String(key || '');
  if (!key) return { ok: false, ignored: 'no_key' };

  const id = { tid: obs.tid, cwdRel: obs.cwdRel, wsName: obs.wsName, agent: obs.agent, source: 'watch' };

  // ② 발사 요청 — 알림 결정권은 전부 여기.
  if (obs.fire) {
    const rec = ensure(key, id);
    const agentName = obs.agentName || undefined;
    if (obs.exited) {
      // 프로세스 사망/크래시는 훅이 낼 수 없다 → hookGoverned 무관하게 채택(단 REFIRE 는 집행 → 훅 done 직후면 억제).
      bump(rec, 'ended', 'watch', { ev: 'exit' });
      const title = agentName || AGENT_TITLES.get(rec.agent) || 'AI 에이전트';
      const r = await fire(rec, obs.fire, {
        source: 'watch', agentName, body: obs.body || `${title} 프로세스가 종료되었습니다`,
      });
      return { ok: true, state: rec.state, version: rec.version, notified: r.fired };
    }
    if (hookGoverned(key) || hookRecent(rec.cwdRel, rec.tid)) {
      // 훅이 살아있는 터미널 = 같은 턴을 훅이 이미 보고했다. 폴백은 침묵(관찰만).
      logFn(`[agent-state] ${rec.tid} 폴백 발사 억제(훅 지배) kind=${obs.fire}`);
      return { ok: true, state: rec.state, version: rec.version, suppressed: true, notified: false };
    }
    bump(rec, obs.fire === 'permission_request' ? 'permission' : 'idle', 'watch', { ev: `watch-${obs.fire}` });
    const r = await fire(rec, obs.fire, { source: 'watch', agentName, body: obs.body });
    return { ok: true, state: rec.state, version: rec.version, notified: r.fired };
  }

  // ① 관찰 기록 — 에이전트 신호가 전혀 없는 터미널(일반 셸)은 레코드를 만들지 않는다(스냅샷 오염 방지).
  const observed = obs.observedState || null;
  const existed = states.has(key);
  if (!existed && !observed) return { ok: true, skipped: 'no_signal' };
  const rec = ensure(key, id);

  if (obs.seed) {
    // 첫 관찰 = 시드: 상태만, 알림 없음. 훅이 이미 지배 중이면(데몬만 재기동된 경우) 손대지 않는다.
    if (!existed && observed) bump(rec, observed, 'watch', { ev: 'seed' });
    return { ok: true, state: rec.state, version: rec.version, seeded: true };
  }
  if (hookGoverned(key)) {
    return { ok: true, state: rec.state, version: rec.version, observedOnly: true };
  }
  if (observed) {
    if (observed === rec.state) return { ok: true, state: rec.state, version: rec.version }; // 무변화 = version 인플레 방지
    bump(rec, observed, 'watch', { ev: 'observe' });
  } else if (obs.shell) {
    // 셸 복귀 = 에이전트 프로세스가 사라졌다 → 'idle' 이 아니라 **소멸**('ended' → 와이어 'gone')이다.
    //  와이어 계약(§1.3)에서 'idle' 은 "에이전트가 붙어 있고 유휴" 를 뜻하므로 여기서 'idle' 을 쓰면
    //  두 방향으로 조용히 죽는다(부록A #1 의 변종, 로그·에러 0건):
    //   ① 훅 없는 에이전트(gemini·--settings 직접 지정·kill -9): 마지막 방출값이 'idle' 로 남아
    //      빈 셸 탭에 Chat 토글이 stale 상한(15분)까지 켜진 채 굳는다(push 우선 규칙이라 tab.cmd 폴백도 안 돈다).
    //   ② 훅 있는 경우: session_end 가 'gone' 을 보낸 뒤 hookGoverned(10분)가 풀리면 같은 셸 관찰이
    //      'ended'→'idle' 로 되돌려 'idle' 을 **재방출** → 이미 꺼진 토글이 스스로 되켜진다.
    //  레거시 "미관찰=idle" 의미는 statusOf/legacyStatusOf 가 그대로 유지한다(ended→idle 접기) →
    //  `cpt terminal wait --for idle` 은 영향 없다.
    if (rec.state !== 'ended') bump(rec, 'ended', 'watch', { ev: 'shell' });
  }
  return { ok: true, state: rec.state, version: rec.version };
}

// 현재 상태(전체 도메인) — launching 은 "아직 미확정" 이라 소비자에겐 idle 로 보인다.
function statusOf(key) {
  const rec = states.get(String(key || ''));
  if (!rec) return 'idle';
  return rec.state === 'launching' ? 'idle' : rec.state;
}

// 레거시 3값 축약 — `cpt terminal wait`(for: idle|permission|any)가 신규 상태 때문에 영원히 대기하지
//  않게 needsInput/ended/launching 을 idle 로 접는다(에이전트가 안 도는 터미널 = 곧 유휴, 오늘과 동일).
function legacyStatusOf(key) {
  const s = statusOf(key);
  if (s === 'working' || s === 'permission') return s;
  return 'idle';
}

function publicView(rec) {
  return {
    key: rec.key,
    tid: rec.tid,
    cwdRel: rec.cwdRel,
    wsName: rec.wsName,
    agent: rec.agent,
    state: rec.state,
    // 추가 전용(2026-07-25): 와이어와 같은 접기(ended→gone, launching→idle) + 부착 불리언.
    //  구 소비자(`cpt agent status`·hooks.doctor)는 state 만 읽으므로 무영향이고, 새 소비자는
    //  "gone 이 아니면 부착" 규칙을 여기서 그대로 받는다(판정 정본 2벌 방지).
    wireState: wireStateOf(rec),
    attached: wireStateOf(rec) !== 'gone',
    version: rec.version,
    since: rec.since,
    updatedAt: rec.updatedAt,
    source: rec.source,
    hookGoverned: hookGoverned(rec.key),
    lastHookAt: rec.lastHookAt,
    sessionId: rec.sessionId,
    promptId: rec.promptId,
    pending: rec.pending,
    summary: rec.summary,
    backgroundTasks: rec.backgroundTasks,
  };
}

// cwdRel 생략 = 전체. `cpt agent status` / agent.state 방송용.
//  includeUnknown: cwdRel 이 아직 미상(null)인 레코드도 포함 — 진단(hooks.doctor)에서 "훅이 한 번도
//  안 온 터미널"을 놓치지 않기 위한 옵션. 일반 조회에서는 스코프 오염을 피하려 기본 제외.
//  ⚠ 오해 금지(2026-07-25): 여기서 "unknown" 은 **cwdRel 미상**을 뜻하며 `rec.agent`(에이전트 이름)와는
//   아무 상관이 없다. 이름을 모르는 레코드(agent:null — 버전 문자열 cmd 처럼 제목 신호만으로 감지된
//   에이전트)는 이 필터에 걸리지 않고, 와이어 방출(emitFrame)도 좌표(cwdRel,tid)만 요구한다.
//   즉 **토글 노출은 "에이전트 이름을 아는가" 와 완전히 무관**하다(계약 §1.3 `agent` 는 null 허용).
//   두 필터의 기준이 다른 이유: snapshot 은 *질의 스코프*(어느 워크스페이스를 묻는가), emitFrame 은
//   *정확성 전제*(클라이언트 색인 키를 만들 수 있는가). 목적이 달라도 결과적으로 둘 다 cwdRel 을
//   요구하므로 "status 엔 보이는데 와이어엔 안 나가는" 비대칭은 생기지 않는다.
function snapshot(cwdRel, { includeUnknown = false } = {}) {
  const out = [];
  for (const rec of states.values()) {
    if (cwdRel && rec.cwdRel !== cwdRel && !(includeUnknown && rec.cwdRel == null)) continue;
    out.push(publicView(rec));
  }
  out.sort((a, b) => (a.tid || 0) - (b.tid || 0));
  return out;
}

// 세션 소멸 정리. 훅 지배 중이던 터미널은 "지배/발사 이력" 만 tomb 로 남긴다 —
//  tmux 목록이 일시적으로 비었다 돌아오는 사고(과거 LANG 이스케이프로 list 파싱 전멸)에서
//  폴백이 authoritative 로 뒤집혀 중복 알림을 내는 것을 막는다.
function forget(key) {
  key = String(key || '');
  const rec = states.get(key);
  if (!rec) return false;
  if (nowFn() - (rec.lastHookAt || 0) < HOOK_GOVERN_MS || rec.fires.size) {
    tombs.set(key, { lastHookAt: rec.lastHookAt, fires: new Map(rec.fires), at: nowFn() });
    if (tombs.size > TOMB_MAX) {
      const cut = nowFn() - HOOK_GOVERN_MS;
      for (const [k, t] of tombs) if ((t.at || 0) < cut) tombs.delete(k);
      // 그래도 넘치면 가장 오래된 것부터(삽입 순서) 버린다.
      while (tombs.size > TOMB_MAX) { const k = tombs.keys().next().value; tombs.delete(k); }
    }
  }
  // 터미널 소멸 = 클라이언트가 키를 지워야 하는 순간. 'gone' 1회를 방출한 뒤 캐시를 비운다
  //  (이미 ended→gone 을 보냈다면 dedup 이 중복 전송을 막는다).
  emitFrame(rec, 'gone', false);
  lastEmitted.delete(key);
  states.delete(key);
  return true;
}

// 테스트용 전면 초기화(agent-watch.js:204 _states 노출 컨벤션 미러).
function _reset() {
  states.clear(); wsHooks.clear(); tombs.clear(); lastEmitted.clear();
}

module.exports = {
  start, configure,
  applyHook, applyWatch,
  statusOf, legacyStatusOf, snapshot, hookGoverned, noteHook, hookRecent, forget,
  attachmentOf,             // 목록(terminal.list) 판정의 상태 쪽 절반 — agent-watch.agentSignalOf 가 소비
  wireStateOf, resyncAll,   // 상태 방출(기능3 2단계) — control.js 가 hello_ack 에서 리싱크를 부른다
  HOOK_GOVERN_MS, REFIRE_MIN_MS, PERMISSION_DEDUP_MS, HOOK_RECENT_MS, AGENT_STATE_CAP,
  _states: states, _tombs: tombs, _reset, _lastEmitted: lastEmitted,
};
