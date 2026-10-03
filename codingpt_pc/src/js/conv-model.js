import * as i18n from './i18n/index.js';
import { TOOL_GROUP_MIN, isVisible } from './chat-model.js';
// conv-model.js — 채팅 v2(구조화 대화) "규칙" 한 벌. DOM 도 api 도 모르는 순수 모듈.
//
// 계약 정본 = codingpt_daemon/docs/chat-v2-design.md (§2 데이터 모델 · §3 push · §4 RPC · §10 클라 규칙).
// ⚠ 모바일 `codingpt_app/src/workspace/conv/convModel.ts` 와 **동시 수정 대상**이다(같은 함수 이름·같은 규칙).
//   한쪽만 고치면 같은 대화가 PC/폰에서 다르게 보인다(chat-model.js 머리주석의 전례).
//
// 채팅 v1(chat-model.js)과의 관계: ConvMsg 는 v1 ChatMsg 와 같은 모양에 필드를 더한 것이라(§2.3)
//  라벨·결과 표식·diff 행 같은 표시 규칙은 v1 것을 그대로 쓴다. 여기에는 v2 에만 있는 것만 둔다:
//  seq 연속성 · key upsert · 델타 병합 · 낙관 버블 · 요청 카드 · 스트리밍 분할.

export const CONV = {
  OPEN_LIMIT: 200,          // conv.open limit
  BEFORE_LIMIT: 100,        // conv.before limit(위로 스크롤 한 번에 받는 양)
  POLL_IDLE_MS: 15000,      // 폴백 폴링 — 유휴(§10.1)
  POLL_BUSY_MS: 5000,       // 폴백 폴링 — 작업 중
  PUSH_FRESH_MS: 3000,      // push 가 이 안에 왔으면 폴링을 건너뛴다
  // 보고 있다는 신호 — 데몬은 "최근 30초 안에 open/since 를 부른 클라"를 보는 기기로 친다(§7).
  //  push 가 살아 있다고 pull 을 계속 건너뛰면 작업이 길어질수록 "아무도 안 본다"가 되어, 보고 있는
  //  화면에 완료 알림이 울린다 → push 가 살아 있어도 이 간격으로는 한 번씩 부른다.
  PRESENCE_MS: 20000,
  SEND_FAIL_MS: 20000,      // 이 안에 접수 확인이 없으면 버블을 실패로(§10.2 3)
  AT_BOTTOM_PX: 48,         // 바닥에서 이 안이면 따라간다(§10.4)
  HISTORY_EDGE_PX: 160,     // 위쪽 끝에서 이 안으로 들어오면 이전 내역을 받는다
  DRAFT_MAX: 4096,          // 탭에 남기는 초안 상한(§10.7)
  THINKING_CHARS: 120,
};

// 클라 HTTP 타임아웃 = back 값 + 5초(§4.0). 기동·가져오기·TUI 종료 대기가 끼는 메서드만 길다.
const LONG_METHODS = new Set(['conv.create', 'conv.send', 'conv.open', 'conv.adopt', 'conv.toTerminal', 'conv.file']);   // conv.file = 8MB 바이트(§4.5)
export function convTimeoutSecs(method) {
  return LONG_METHODS.has(String(method || '')) ? 35 : 20;
}

// ── 오류 ─────────────────────────────────────────────────────────────────────
// Rust back_api 는 실패를 `HTTP <상태> <CODE>: <메시지>` 문자열로 올린다(detail.code 보존 — bridge.rs).
//  분기는 **상태가 아니라 code** 로 한다(§4.0): 데몬 오류는 전부 500 이라 상태로는 아무것도 못 가른다.
const RELAY_TIMEOUT_RE = /timed? ?out|시간 초과|타임아웃/i;

/** 던져진 값 → { code, message, status }. code 가 없으면 ''(모름). */
export function parseConvError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code) {
    return { code: err.code, message: String(err.message || ''), status: Number(err.status) || 0 };
  }
  const msg = err == null ? '' : String((err && err.message) || err);
  const m = /^HTTP (\d{3})(?: ([A-Z][A-Z0-9_]{1,63}))?(?:: ([\s\S]*))?$/.exec(msg);
  if (m) {
    const status = Number(m[1]);
    // 구 back(라우트 없음)·code 없는 409 도 뜻은 분명하다 — 화면이 같은 말을 하게 여기서 이름을 붙인다.
    const code = m[2] || (status === 409 ? 'DAEMON_OFFLINE' : status === 404 || status === 405 ? 'SERVER_NEEDS_UPDATE' : '');
    return { code, message: m[3] || '', status };
  }
  if (/^요청 실패:/.test(msg)) return { code: RELAY_TIMEOUT_RE.test(msg) ? 'TIMEOUT' : 'NETWORK', message: msg, status: 0 };
  return { code: '', message: msg, status: 0 };
}

/** 결과가 불명인 실패인가 — 데몬이 실제로는 처리했을 수 있다(재시도는 같은 clientId 로만, §4.0). */
export function isAmbiguousFailure(code) {
  return code === 'TIMEOUT' || code === 'NETWORK' || code === '';
}

/** 호스트 PC 가 끊긴 실패인가 — 상단 연결 상태 줄이 말한다(§10.2 4). */
export function isOfflineCode(code) {
  return code === 'DAEMON_OFFLINE';
}

/**
 * code → 사용자에게 보일 한 줄. 모르는 code 는 일반 문구(데몬 문구를 그대로 비추지 않는다).
 *  ⚠ 문구는 앱 convModel.ts `errorText` 와 **글자까지 같다**(같은 오류가 기기마다 다른 말을 하지 않게).
 */
export function convErrorText(code) {
  switch (String(code || '')) {
    case 'DAEMON_OFFLINE': return i18n.t('PC가 꺼져 있거나 연결이 끊겼어요.');
    case 'TIMEOUT': return i18n.t('PC의 응답이 늦어요. 잠시 후 다시 시도해 주세요.');
    case 'NETWORK': return i18n.t('네트워크에 연결할 수 없어요.');
    case 'CONV_DISABLED': return i18n.t('지금은 채팅을 쓸 수 없어요.');
    case 'SERVER_NEEDS_UPDATE': return i18n.t('서버가 아직 채팅을 지원하지 않아요.');
    case 'AGENT_UNAVAILABLE': return i18n.t('이 PC에 에이전트가 설치되어 있지 않아요.');
    case 'AGENT_NOT_LOGGED_IN': return i18n.t('PC에서 에이전트에 먼저 로그인해 주세요.');
    case 'THREAD_NOT_FOUND': return i18n.t('대화를 찾을 수 없어요.');
    case 'THREAD_BUSY': return i18n.t('작업이 끝난 뒤에 할 수 있어요.');
    case 'THREAD_BUSY_IN_TERMINAL': return i18n.t('이 대화는 터미널에서 사용 중이에요.');
    case 'REQ_NOT_PENDING': return i18n.t('이미 처리된 요청이에요.');
    case 'TOO_MANY_LIVE': return i18n.t('동시에 진행 중인 대화가 너무 많아요. 하나가 끝난 뒤 다시 시도해 주세요.');
    case 'START_FAILED': return i18n.t('에이전트를 시작하지 못했어요.');
    case 'ADOPT_FAILED': return i18n.t('터미널의 에이전트를 끝내지 못해 가져오지 못했어요.');
    case 'CONTROL_TIMEOUT': return i18n.t('에이전트가 응답하지 않아요. 잠시 후 다시 시도해 주세요.');
    case 'CONTROL_FAILED': return i18n.t('에이전트가 요청을 받아들이지 않았어요.');
    case 'TERMINAL_ONLY_COMMAND': return i18n.t('이 명령은 터미널에서만 쓸 수 있어요.');
    case 'BAD_REQUEST': return i18n.t('요청이 올바르지 않아요.');
    default: return i18n.t('요청을 처리하지 못했어요.');
  }
}
export { convErrorText as errorText };

/**
 * 안내(notice) 한 줄. 아는 code 면 우리 문구다 — 데몬 문구는 한국어뿐이라 다른 언어 화면에서 혼자 한국어로 남는다.
 *  모르는 code 는 데몬이 준 글을 그대로 보여 준다(없는 것보다 낫다).
 */
export function noticeText(code, text) {
  switch (String(code || '')) {
    case 'TERMINAL_ONLY_COMMAND': return i18n.t('이 명령은 터미널에서만 쓸 수 있어요.');
    case 'PROCESS_EXIT': return i18n.t('에이전트가 예기치 않게 종료됐어요.');
    case 'START_FAILED': return i18n.t('에이전트를 시작하지 못했어요.');
    case 'TURN_FAILED': return i18n.t('작업을 끝내지 못했어요.');
    case 'AGENT_NOT_LOGGED_IN': return i18n.t('PC에서 에이전트에 먼저 로그인해 주세요.');
    case 'RATE_LIMITED': return i18n.t('사용 한도에 걸렸어요. 잠시 후 다시 시도해 주세요.');
    case 'IMPORT_TRUNCATED': return i18n.t('대화가 길어 최근 부분만 가져왔어요.');
    case 'MODEL_NEXT_START': return i18n.t('모델 변경은 다음 시작부터 적용돼요.');
    default: return String(text || '');
  }
}

// ── 권한 모드(채팅 탭) ────────────────────────────────────────────────────────
// 채팅 v1 의 알약은 TUI 원문("manual mode on")을 그대로 쓴다 — 화면(터미널)과 같은 단어여야 해서다.
//  채팅 v2 에는 맞춰 볼 터미널 화면이 없다 → 무엇이 자동으로 실행되는지를 우리 말로 적는다.
//  v1 카탈로그(chat-model.AGENT_MODES)는 건드리지 않는다.
export const CONV_MODES = [
  { id: 'default', label: '매번 물어보기' },
  { id: 'acceptEdits', label: '파일 수정은 자동 허용' },
  { id: 'plan', label: '계획만 세우기' },
  { id: 'auto', label: '자동' },
  { id: 'bypassPermissions', label: '모두 허용', hidden: true },
  { id: 'dontAsk', label: '묻지 않고 거절', hidden: true },
];

/** 모드 id → 표시 이름. 모르는 id(미래의 데몬)는 id 그대로 — 빈 알약보다 낫다. */
export function convModeLabel(id) {
  const m = CONV_MODES.find((x) => x.id === String(id || ''));
  return m ? i18n.t(m.label) : String(id || '');
}

/**
 * 목록에 그릴 모드. allowed = 데몬이 알려 준 모드 id(conv.caps.modes — 없으면 카탈로그 그대로).
 *  위험한 모드(전부 허용·묻지 않고 거절)는 **지금 그 모드일 때만** 보인다 — 채팅에서 실수로 켜는 길을 만들지 않는다.
 */
export function convModeChoices(current, allowed) {
  const cur = String(current || 'default');
  const ok = Array.isArray(allowed) && allowed.length
    ? new Set(allowed.map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean)) : null;
  const out = CONV_MODES.filter((m) => (m.id === cur) || (!m.hidden && (!ok || ok.has(m.id))));
  if (!out.some((m) => m.id === cur)) out.push({ id: cur, label: cur });
  return out.map((m) => ({ id: m.id, label: convModeLabel(m.id), on: m.id === cur }));
}

// ── 상태 ─────────────────────────────────────────────────────────────────────
/** 대화 한 개의 로컬 상태. 뷰는 이것만 들고, 그릴 때마다 buildRows 로 행을 뽑는다. */
export function createConv(threadId) {
  return {
    threadId: threadId || null,
    thread: null,           // Thread(§2.1) — open/since 응답과 state 이벤트·thread 힌트로 갱신
    headSeq: 0,             // 적용한 마지막 영속 seq
    floorSeq: 0,            // 받아 둔 가장 오래된 seq(0 = 아직 없음)
    noMoreBefore: false,    // 더 받을 이전 내역이 없다
    msgs: new Map(),        // key → { msg, firstSeq }
    reqs: new Map(),        // id → ConvReq
    turns: new Map(),       // turn → { turn, startSeq, startTs, endSeq, endTs, ok, interrupted, durationMs, ... }
    notices: [],            // [{ seq, ts, level, code, text }]
    live: new Map(),        // key → { key, kind, text } (스트리밍 초안 — 비영속)
    pending: new Map(),     // clientId → { clientId, text, status, code, at }
    hidden: new Set(),      // 사용자가 [삭제] 한 실패 메시지 key(로컬 감춤 — 로그는 데몬 것)
  };
}

function seqOf(ev) {
  return ev && typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null;
}

/**
 * push 프레임 판정(§3 "push 는 힌트, pull 이 정본").
 *  · 'apply' — 이어 붙일 수 있다. events 는 headSeq 뒤의 것만 추린 것.
 *  · 'dup'   — 전부 이미 가진 것(재전송·순서 역전으로 늦게 온 프레임) → 조용히 버린다.
 *  · 'gap'   — 사이가 비었다(또는 프레임 안이 끊겼다) → 버리고 conv.since.
 */
export function classifyFrame(headSeq, events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => seqOf(e) != null);
  if (!list.length) return { kind: 'dup', events: [] };
  const head = Number(headSeq) || 0;
  const fresh = list.filter((e) => e.seq > head);
  if (!fresh.length) return { kind: 'dup', events: [] };
  let want = head + 1;
  for (const e of fresh) {
    if (e.seq !== want) return { kind: 'gap', events: [] };
    want += 1;
  }
  return { kind: 'apply', events: fresh };
}

/** 행의 자리 = `first ?? seq`(§2.2). upsert 줄에는 그 key 가 처음 나온 seq 가 first 로 실려 온다. */
function placeOf(ev, seq) {
  const f = Number(ev && ev.first);
  return Number.isFinite(f) && f > 0 && f <= seq ? f : seq;
}

function upsertMsg(st, msg, seq, ts, backfill, first) {
  if (!msg || typeof msg.key !== 'string' || !msg.key) return;
  const m = { ...msg, seq, at: ts };   // at = 이벤트 시각(epoch ms). msg.ts 는 ISO 문자열이다(§2.3)
  const had = st.msgs.get(m.key);
  if (!had) {
    // 접은 스냅샷에는 마지막 판만 온다 — 그 줄의 first 가 없으면 턴 중에 보낸 메시지가 답 아래로 내려간다.
    st.msgs.set(m.key, { msg: m, firstSeq: first });
  } else {
    // 자리는 처음 등장한 seq 다 — 'queued' 로 보낸 메시지가 'sent' 가 됐다고 아래로 내려가지 않는다.
    had.firstSeq = Math.min(had.firstSeq, first);
    // 같은 key 의 뒤 이벤트가 앞을 대체한다(§2.2). 이전 내역을 받아 넣을 때 새 것을 덮지 않는다.
    if (!(backfill && had.msg.seq > seq)) had.msg = m;
  }
  // 그 key 에 새 사실이 왔다 → 접어 둔 것을 푼다(다시 보낸 메시지가 또 실패하면 그 실패가 보여야 한다).
  if (!backfill) st.hidden.delete(m.key);
  // 완성된 블록이 왔다 → 같은 key 의 스트리밍 초안은 끝났다(§2.5).
  st.live.delete(m.key);
  // 서버가 내 메시지를 기록했다 → 낙관 버블은 그것으로 대체된다(§10.2 2).
  if (m.clientId) st.pending.delete(String(m.clientId));
}

function upsertReq(st, req, seq, backfill, first) {
  if (!req || !req.id) return;
  const had = st.reqs.get(req.id);
  if (had && backfill && (had._seq || 0) > seq) return;
  st.reqs.set(req.id, { ...req, _seq: seq, _firstSeq: had && had._firstSeq ? Math.min(had._firstSeq, first) : first });
}

/** 열려 있는 턴(시작만 있고 끝이 없는 것 중 가장 뒤). 없으면 null. */
function openTurn(st) {
  let top = null;
  for (const t of st.turns.values()) if (t.startSeq != null && t.endSeq == null && (!top || t.turn > top.turn)) top = t;
  return top;
}

// working/waiting 전이는 로그에 state 이벤트로 남지 않는다(§2.2) — turn·req 이벤트가 말해 준다.
//  현재값의 정본은 thread 힌트와 pull 응답이지만 힌트는 한 박자 늦게 온다 → 라이브 이벤트에서 바로 따라간다
//  (안 그러면 전송 버튼이 중단으로 바뀌는 것이 눈에 띄게 늦다).
//  ⚠ "열린 턴이 안 보인다"를 idle 의 근거로 쓰지 않는다 — 턴 시작이 받아 둔 구간 밖에 있을 수 있다.
//   idle 로 내리는 것은 턴 끝 이벤트를 **실제로 받았을 때**뿐이다.
function deriveState(st, turnEnded) {
  if (!st.thread) st.thread = { id: st.threadId };
  const pend = [...st.reqs.values()].filter((q) => q.status === 'pending').length;
  st.thread.pending = pend;
  if (turnEnded) { if (!openTurn(st)) st.thread.state = 'idle'; return; }
  if (pend) st.thread.state = 'waiting';
  else if (openTurn(st) || st.thread.state === 'waiting') st.thread.state = 'working';   // 요청은 턴 안에서만 열린다
}

function applyTurn(st, ev) {
  const n = Number(ev.turn);
  if (!Number.isFinite(n)) return;
  const t = st.turns.get(n) || { turn: n };
  if (ev.phase === 'start') { t.startSeq = ev.seq; t.startTs = ev.ts; }
  else if (ev.phase === 'end') {
    t.endSeq = ev.seq; t.endTs = ev.ts;
    t.ok = ev.ok !== false;
    t.interrupted = !!ev.interrupted;
    t.subtype = ev.subtype || '';
    if (ev.durationMs != null) t.durationMs = Number(ev.durationMs) || 0;
    if (ev.usage) t.usage = ev.usage;
    if (ev.costUsd != null) t.costUsd = ev.costUsd;
  }
  st.turns.set(n, t);
}

/** 턴이 끝났다 — 완성되지 못한 초안(중단·프로세스 종료)은 메시지가 되지 않는다(§2.5). */
function dropDrafts(st) { st.live.clear(); }

const STATE_FIELDS = ['state', 'mode', 'model', 'usage', 'owner', 'ownerTid', 'title', 'titleSet', 'pending', 'preview'];

function applyOne(st, ev, backfill) {
  const seq = seqOf(ev);
  if (seq == null) return;
  switch (ev.op) {
    case 'msg': upsertMsg(st, ev.msg, seq, ev.ts, backfill, placeOf(ev, seq)); break;
    case 'req': upsertReq(st, ev.req, seq, backfill, placeOf(ev, seq)); if (!backfill) deriveState(st); break;
    case 'turn':
      applyTurn(st, ev);
      if (!backfill) { if (ev.phase === 'end') dropDrafts(st); deriveState(st, ev.phase === 'end'); }
      break;
    case 'state':
      // 이전 내역 속의 상태는 옛 사진이다 — 지금 상태를 덮으면 끝난 대화가 "작업 중"으로 돌아간다.
      if (backfill) break;
      st.thread = st.thread || { id: st.threadId };
      for (const k of STATE_FIELDS) if (ev[k] !== undefined) st.thread[k] = ev[k];
      break;
    case 'notice':
      if (!st.notices.some((n) => n.seq === seq)) {
        st.notices.push({ seq, ts: ev.ts, level: ev.level || 'info', code: ev.code || '', text: ev.text || '' });
      }
      break;
    default: break;   // 모르는 op — 미래의 데몬이 보낸 것. 버리되 seq 는 센다(연속성이 깨지면 안 된다)
  }
}

function noteFloor(st, events, floorSeq) {
  let lo = Number(floorSeq) || 0;
  for (const e of events || []) { const s = seqOf(e); if (s != null && (!lo || s < lo)) lo = s; }
  if (lo && (!st.floorSeq || lo < st.floorSeq)) st.floorSeq = lo;
}

/** 스트리밍 초안 통째 교체 — open/since 의 `live`(지금 진행 중인 블록의 누적 본문). */
export function setLive(st, live) {
  st.live.clear();
  const list = Array.isArray(live) ? live : (live && typeof live === 'object' ? Object.values(live) : []);
  for (const d of list) {
    if (!d || typeof d.key !== 'string' || !d.key) continue;
    if (st.msgs.has(d.key)) continue;   // 이미 완성본이 있다
    st.live.set(d.key, { key: d.key, kind: d.kind === 'thinking' ? 'thinking' : 'text', text: String(d.text || '') });
  }
}

function mergeThread(st, thread) {
  if (!thread || typeof thread !== 'object') return;
  st.thread = { ...(st.thread || {}), ...thread };
  if (thread.id) st.threadId = thread.id;
}

/** conv.open 응답 적용 — 버퍼를 비우고 스냅샷부터 다시 세운다. 낙관 버블은 남긴다(아직 안 온 내 메시지). */
export function applyOpen(st, r) {
  const res = r || {};
  st.msgs.clear(); st.reqs.clear(); st.turns.clear(); st.live.clear();
  st.notices = [];
  st.headSeq = 0; st.floorSeq = 0; st.noMoreBefore = false;
  st.thread = null;
  const events = (Array.isArray(res.events) ? res.events : []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const e of events) applyOne(st, e, false);
  syncPending(st, res.pending, res.headSeq);
  // 응답의 thread 가 **지금 이 순간**의 값이다 — 이벤트에서 짐작한 상태를 덮는다.
  //  (스냅샷 창 밖에서 시작한 턴은 이벤트만으로는 "열린 턴"인지 알 수 없다.)
  mergeThread(st, res.thread);
  let head = Number(res.headSeq) || 0;
  let top = 0;
  for (const e of events) { const s = seqOf(e); if (s != null && s > top) top = s; }
  // 응답이 512KB 예산으로 잘렸으면(more) headSeq 는 아직 못 받은 뒤쪽을 가리킨다 → 받은 데까지만 믿는다.
  if (res.more && top) head = top;
  st.headSeq = Math.max(head, top);
  // floorSeq = 돌려준 첫 이벤트의 seq, **더 앞이 없으면 1**(§4). 1 보다 클 때만 conv.before 를 부른다.
  const floor = Number(res.floorSeq) || 0;
  st.floorSeq = floor || (events.length ? events[0].seq : 0);
  st.noMoreBefore = st.floorSeq <= 1;
  setLive(st, res.live);
  return { more: !!res.more };
}

/**
 * pull 응답의 pending(`[ConvReq]` — 지금 열려 있는 요청 전부, §4)과 맞춘다.
 *  · 목록에 있는데 내가 모르는 것 → 더한다(이벤트 창 밖에서 열린 요청도 카드는 떠야 한다).
 *  · 내가 열려 있다고 아는데 목록에 없는 것 → 닫혔다(닫힌 이벤트를 아직 못 받았을 뿐). 유령 카드를 남기지 않는다.
 *  pending 이 배열이 아니면(구 데몬·필드 없음) 아무것도 하지 않는다.
 */
function syncPending(st, pending, headSeq) {
  if (!Array.isArray(pending)) return;
  const head = Number(headSeq) || 0;
  const open = new Set();
  for (const q of pending) {
    if (!q || !q.id) continue;
    open.add(q.id);
    const had = st.reqs.get(q.id);
    if (!had) st.reqs.set(q.id, { ...q, _seq: 0, _firstSeq: 0 });
    else if (had.status !== 'pending' && !had._local) st.reqs.set(q.id, { ...had, ...q });
  }
  for (const [id, q] of st.reqs) {
    // 응답이 만들어진 **뒤에** push 로 먼저 도착한 요청은 목록에 없는 것이 당연하다 — 닫지 않는다.
    if (q.status === 'pending' && !open.has(id) && (q._seq || 0) <= head) st.reqs.set(id, { ...q, status: 'canceled', _stale: true });
  }
}

/**
 * conv.since 응답 적용.
 *  · 응답의 이벤트는 **접은 부분열**이다(같은 key 의 더 뒤 줄이 있으면 앞 줄은 빠진다) — seq 가 띄엄띄엄한 것이
 *    정상이라 연속성을 검사하지 않는다(그건 push 프레임의 규칙이다).
 *  · more  = 예산(512KB)에 잘렸다 → 받은 마지막 seq 부터 다시 부른다(§4.0).
 *  · reset = 내가 아는 로그가 데몬의 것이 아니다(삭제 후 재생성 등). 응답은 conv.open 과 같은 스냅샷이다 →
 *    로컬 상태를 버리고 그것으로 바꾼다. 반환의 reset 으로 뷰가 행을 통째로 다시 그린다.
 *  · 서버 head 가 내 것보다 작은 것은 로그가 바뀐 증거가 **아니다** — 응답이 만들어진 뒤에 도착한 push 를
 *    내가 먼저 적용했을 뿐이다(로그가 바뀌었으면 데몬이 reset 을 준다). 그 응답은 늦은 사진이라 head·상태·초안을
 *    되돌리지 않는다. reopen 은 앱 모델과 모양을 맞춘 자리이고 지금은 항상 false 다.
 */
export function applySince(st, r) {
  const res = r || {};
  if (res.reset) {
    const o = applyOpen(st, res);
    return { more: o.more, added: (res.events || []).length, reopen: false, reset: true };
  }
  const events = (Array.isArray(res.events) ? res.events : []).filter((e) => seqOf(e) != null)
    .sort((a, b) => a.seq - b.seq);
  const srvHead = Number(res.headSeq) || 0;
  const stale = srvHead > 0 && srvHead < st.headSeq;
  let top = st.headSeq;
  let added = 0;
  for (const e of events) {
    if (e.seq <= st.headSeq) continue;   // 이미 가진 것(push 로 먼저 왔다)
    applyOne(st, e, false);
    added += 1;
    if (e.seq > top) top = e.seq;
  }
  // more 가 아니면 서버 head 가 정본이다(접혀서 빠진 줄·영속 이벤트가 없던 구간도 따라간다).
  st.headSeq = res.more ? top : Math.max(top, srvHead);
  if (!st.floorSeq && events.length) st.floorSeq = events[0].seq;
  if (!res.more) {
    // 이어 받을 것이 남았으면 아직 믿을 수 없다 — 다 받은 뒤의 값이 정본이다.
    syncPending(st, res.pending, srvHead);
    if (res.live !== undefined && !stale) setLive(st, res.live);
  }
  if (!stale) mergeThread(st, res.thread);
  return { more: !!res.more, added, reopen: false, reset: false };
}

/** conv.before 응답 적용(이전 내역). 새 것을 덮지 않고, 자리만 앞으로 넓힌다. */
export function applyBefore(st, r) {
  const res = r || {};
  const events = (Array.isArray(res.events) ? res.events : []).filter((e) => seqOf(e) != null);
  for (const e of events) applyOne(st, e, true);
  const was = st.floorSeq;
  const floor = Number(res.floorSeq) || (events.length ? Math.min(...events.map((e) => e.seq)) : 0);
  if (floor && (!st.floorSeq || floor < st.floorSeq)) st.floorSeq = floor;
  // 더 앞이 없다: 빈 응답이거나, 바닥이 1 이거나(§4), 바닥이 움직이지 않았다(무한 요청 방지).
  if (!events.length || st.floorSeq <= 1 || (was && st.floorSeq >= was)) st.noMoreBefore = true;
  return { added: events.length };
}

/**
 * push 의 영속 이벤트 적용. 반환:
 *  { ok:true, applied:n } 또는 { ok:false, resync:true }(틈 — conv.since 를 부를 것).
 */
export function applyPush(st, frame) {
  const c = classifyFrame(st.headSeq, frame && frame.events);
  if (c.kind === 'gap') return { ok: false, resync: true, applied: 0 };
  if (c.kind === 'dup') return { ok: true, resync: false, applied: 0 };
  for (const e of c.events) { applyOne(st, e, false); st.headSeq = e.seq; }
  if (!st.floorSeq) noteFloor(st, c.events, 0);
  return { ok: true, resync: false, applied: c.events.length };
}

/**
 * 델타 병합(§2.5). off = 이 조각 앞까지의 누적 길이. 내 누적과 다르면 조각을 버리고 다시 받는다.
 *  반환 { ok, resync, ignored }.
 */
export function applyDelta(st, d) {
  if (!d || typeof d.key !== 'string' || !d.key) return { ok: true, resync: false, ignored: true };
  // 완성본이 이미 있다 = 늦게 도착한 조각이다.
  if (st.msgs.has(d.key)) return { ok: true, resync: false, ignored: true };
  const off = Number(d.off) || 0;
  const piece = String(d.text == null ? '' : d.text);
  const cur = st.live.get(d.key);
  const have = cur ? cur.text.length : 0;
  if (off !== have) {
    // 같은 조각의 재전송(내가 이미 그 뒤까지 갖고 있고 내용도 같다)은 틈이 아니다.
    if (cur && off < have && cur.text.slice(off, off + piece.length) === piece) return { ok: true, resync: false, ignored: true };
    return { ok: false, resync: true, ignored: false };
  }
  const kind = d.kind === 'thinking' ? 'thinking' : 'text';
  if (cur) { cur.text += piece; cur.kind = kind; }
  else st.live.set(d.key, { key: d.key, kind, text: piece });
  return { ok: true, resync: false, ignored: false };
}

/**
 * thread 힌트 프레임(제목·상태·preview) — 영속 이벤트가 아니라 내 headSeq 를 건드리지 않는다.
 *  반환 behind = 힌트의 headSeq 가 내 것보다 크다. 가져온 과거는 push 되지 않으므로(§4.3) 이것이
 *  "받아 갈 것이 있다"는 유일한 신호다 — 뷰가 conv.since 를 부른다.
 */
export function applyThreadHint(st, thread) {
  if (!thread || (thread.id && st.threadId && thread.id !== st.threadId)) return { ok: false, behind: false };
  const { headSeq, ...rest } = thread;
  mergeThread(st, rest);
  const h = Number(headSeq) || 0;
  if (h) st.thread.headSeq = h;
  return { ok: true, behind: h > st.headSeq };
}

// ── 폴백 폴링 판정(§10.1) ─────────────────────────────────────────────────────
/**
 * 지금 conv.since 를 부를 것인가.
 * @param {{now:number,lastPushAt:number,lastPullAt:number,working:boolean,visible:boolean}} a
 */
export function shouldPoll({ now, lastPushAt, lastPullAt, working, visible } = {}) {
  if (!visible) return false;
  const sincePull = now - (lastPullAt || 0);
  if (sincePull < (working ? CONV.POLL_BUSY_MS : CONV.POLL_IDLE_MS)) return false;
  const pushFresh = now - (lastPushAt || 0) < CONV.PUSH_FRESH_MS;
  if (pushFresh && sincePull < CONV.PRESENCE_MS) return false;
  return true;
}

// ── 낙관 버블(§10.2) ──────────────────────────────────────────────────────────
//  sending → sent | queued | failed,  failed → sending(다시 시도 — **같은 clientId**).
//  접수 확인은 언제 와도 이긴다: 20초가 지나 실패로 보인 뒤에 늦은 성공이 오면 성공이 사실이다.
export function pendingNext(cur, ev) {
  const s = cur || 'sending';
  switch (ev) {
    case 'ack_sent': return 'sent';
    case 'ack_queued': return 'queued';
    case 'error':
    case 'timeout':
    case 'offline':
      return s === 'sending' ? 'failed' : s;   // 이미 접수된 것은 늦은 오류로 뒤집지 않는다
    case 'retry': return s === 'failed' ? 'sending' : s;
    default: return s;
  }
}

export function newClientId() {
  try { if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch (_) { /* 아래 폴백 */ }
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 보낸 즉시 그리는 버블. 원문은 버블이 보관한다 — 실패해도 사용자가 쓴 글이 사라지지 않는다. */
export function addPending(st, { clientId, text, now, attachments }) {
  const id = String(clientId || newClientId());
  const had = st.pending.get(id);
  if (had) return had;   // 같은 clientId 재등록 = 멱등
  const p = { clientId: id, text: String(text || ''), status: 'sending', code: '', at: Number(now) || 0 };
  // 첨부 칩 — 다시 시도도 같은 파일로 간다(보낸 뒤 입력칸의 칩은 이미 비었다).
  if (Array.isArray(attachments) && attachments.length) p.attachments = attachments.slice(0, ATTACH_MAX);
  st.pending.set(id, p);
  return p;
}

/** 버블 전이. 없는 clientId(서버 메시지로 이미 대체됨)는 아무 일도 하지 않는다. */
export function markPending(st, clientId, ev, code) {
  const p = st.pending.get(String(clientId));
  if (!p) return null;
  const next = pendingNext(p.status, ev);
  if (next === 'failed' && p.status !== 'failed') p.code = String(code || '');
  if (next !== 'failed') p.code = '';
  p.status = next;
  return p;
}

export function removePending(st, clientId) {
  return st.pending.delete(String(clientId));
}

// ── 표시 행 ───────────────────────────────────────────────────────────────────
function isResultMsg(m) { return !!(m && m.kind === 'tool_result'); }
function toolIdOfResult(m) {
  if (m.result && m.result.toolUseId) return m.result.toolUseId;
  return typeof m.key === 'string' && m.key.startsWith('r:') ? m.key.slice(2) : null;
}

/** 열려 있는 요청(가장 오래된 것부터, §10.8). */
export function openReqs(st) {
  return [...st.reqs.values()]
    .filter((q) => q.status === 'pending')
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0) || (a._firstSeq || 0) - (b._firstSeq || 0));
}

/**
 * 상태 → 표시 행 목록. 뷰는 key 로 DOM 을 재사용하고 sig 가 바뀐 행만 다시 그린다.
 * @param {object} st
 * @param {{openGroups?:Set<string>, openTools?:Set<string>}} [opts]
 *   openGroups = 사용자가 펼친 묶음, openTools = 사용자가 펼쳐 둔 도구 행(묶지 않는다)
 */
export function buildRows(st, opts) {
  const o = opts || {};
  const openGroups = o.openGroups || new Set();
  const openTools = o.openTools || new Set();

  // ① 도구 결과를 id 로 모은다(결과는 독립 행이 아니라 그 도구 행의 결과 자리다).
  const results = new Map();
  for (const { msg } of st.msgs.values()) {
    if (!isResultMsg(msg)) continue;
    const id = toolIdOfResult(msg);
    if (id) results.set(id, msg);
  }
  const pendingToolIds = new Set(openReqs(st).map((q) => q.toolUseId).filter(Boolean));
  // 터미널 전용 명령 — 데몬은 에이전트에 전달하지 않고 msg(failed) 바로 뒤에 안내를 남긴다(§4.1).
  //  보내기에 실패한 것이 아니라 **여기서는 못 쓰는 명령**이다 → 다시 시도를 권하지 않는다.
  const blockedAt = new Set(st.notices.filter((n) => n.code === 'TERMINAL_ONLY_COMMAND').map((n) => n.seq - 1));

  // ② seq 순서로 한 줄씩.
  const items = [];
  const toolIds = new Set();
  for (const { msg, firstSeq } of st.msgs.values()) {
    if (msg.tool && msg.tool.id && (msg.kind === 'tool_use' || msg.kind === 'question')) toolIds.add(msg.tool.id);
    items.push({ at: firstSeq, msg });
  }
  for (const t of st.turns.values()) if (t.endSeq != null) items.push({ at: t.endSeq, turn: t });
  for (const n of st.notices) items.push({ at: n.seq, notice: n });
  items.sort((a, b) => a.at - b.at);

  const flat = [];
  for (const it of items) {
    if (it.turn) {
      const s = turnSummary(it.turn);
      if (s) flat.push({ type: 'turn', key: 't:' + it.turn.turn, sig: String(it.turn.endSeq), ...s });
      continue;
    }
    if (it.notice) {
      const n = it.notice;
      flat.push({ type: 'notice', key: 'n:' + n.seq, sig: String(n.seq), level: n.level, code: n.code, text: n.text });
      continue;
    }
    const m = it.msg;
    if (st.hidden.has(m.key)) continue;
    if (isResultMsg(m)) {
      const id = toolIdOfResult(m);
      if (id && toolIds.has(id)) continue;          // 짝이 있다 → 그 도구 행이 그린다
      if (m.hidden) continue;
      flat.push({ type: 'orphan', key: m.key, sig: String(m.seq), msg: m, sub: !!m.parent });
      continue;
    }
    if (!isVisible(m)) continue;
    if (m.role === 'user' && m.kind === 'compact') continue;
    if (m.role === 'user' && /^\s*(<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION|\[Image: (?:original|source))/.test(String(m.text || ''))) continue;   // 하네스 기계 메시지 — 이미 저장된 옛 대화에도   // /compact 요약 본문 — 이미 저장된 옛 대화에도 적용
    if (m.kind === 'tool_use' || m.kind === 'question') {
      const id = m.tool && m.tool.id;
      // 아직 답하지 않은 질문은 도크의 카드가 그린다 — 내역에 또 그리면 같은 질문이 둘이 된다.
      if (m.kind === 'question' && id && pendingToolIds.has(id)) continue;
      const res = id ? results.get(id) || null : null;
      flat.push({
        type: 'tool', key: m.key, sig: `${m.seq}|${res ? res.seq : ''}`, msg: m, result: res,
        question: m.kind === 'question', sub: !!m.parent,
      });
      continue;
    }
    if (m.role === 'user' && (m.kind === 'text' || m.kind === 'slash')) {
      const status = m.status === 'failed' && blockedAt.has(m.seq) ? 'blocked' : (m.status || 'sent');
      flat.push({ type: 'user', key: m.key, sig: `${m.seq}|${status}`, msg: m, status });
      continue;
    }
    if (m.role === 'assistant' && m.kind === 'text') {
      flat.push({ type: 'assistant', key: m.key, sig: String(m.seq), msg: m, sub: !!m.parent });
      continue;
    }
    if (m.kind === 'thinking') {
      flat.push({ type: 'thinking', key: m.key, sig: String(m.seq), msg: m, sub: !!m.parent });
      continue;
    }
    flat.push({ type: 'divider', key: m.key, sig: String(m.seq), msg: m });
  }

  // ③ 끝난 도구 묶기 — v1 규칙 그대로(chat-view._regroupTools): 연속으로 끝난 도구가 TOOL_GROUP_MIN 개
  //    이상이면 한 줄로 접는다. 진행 중·질문·diff 가 붙은 편집·사용자가 펼쳐 둔 행은 묶지 않는다.
  //    '생각' 줄은 묶음을 끊지 않는다(도구 사이에 끼어 run 을 토막내면 하나도 안 접힌다).
  const rows = [];
  let run = [];
  const flush = () => {
    const tools = run.filter((r) => r.type === 'tool');
    if (tools.length >= TOOL_GROUP_MIN) {
      const key = 'g:' + run[0].key;
      if (openGroups.has(key)) rows.push(...run);
      else {
        rows.push({
          type: 'group', key, sig: run.map((r) => r.sig).join(','), items: run,
          names: tools.map((r) => (r.msg.tool && r.msg.tool.name) || ''),
          bad: tools.filter((r) => r.result && r.result.result && r.result.result.ok === false).length,
          count: tools.length,
        });
      }
    } else rows.push(...run);
    run = [];
  };
  for (const r of flat) {
    const foldable = r.type === 'tool' && !r.question && !!r.result
      && !(r.result.result && r.result.result.patch) && !openTools.has(r.key);
    if (foldable) { run.push(r); continue; }
    if (r.type === 'thinking' && run.length) { run.push(r); continue; }
    flush();
    rows.push(r);
  }
  flush();

  // ④ 스트리밍 초안 — 도착 순서대로 맨 아래. key 는 완성본과 같다(같은 DOM 이 완성본으로 넘어간다).
  for (const d of st.live.values()) {
    if (st.msgs.has(d.key)) continue;
    rows.push({ type: 'live', key: d.key, sig: 'live', kind: d.kind, text: d.text });
  }
  // ⑤ 낙관 버블 — 아직 서버 기록이 없는 내 메시지.
  for (const p of st.pending.values()) {
    rows.push({ type: 'pending', key: 'p:' + p.clientId, sig: `${p.status}|${p.code}`, clientId: p.clientId, text: p.text, status: p.status, code: p.code, attachments: p.attachments || null });
  }
  return rows;
}

// ── 턴 요약·작업 중 표시 ──────────────────────────────────────────────────────
/** ms → '8초' / '3분 20초' / '3분' / '1시간 5분' / '2시간'. 앱 convModel.fmtDuration 과 같은 규칙. */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return i18n.t('{n}초', { n: total });
  const min = Math.floor(total / 60);
  if (min < 60) { const s = total % 60; return s ? i18n.t('{m}분 {s}초', { m: min, s }) : i18n.t('{n}분', { n: min }); }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? i18n.t('{h}시간 {m}분', { h, m }) : i18n.t('{n}시간', { n: h });
}

/** 끝난 턴 → { durationMs, interrupted, ok }. 걸린 시간을 모르면(둘 다 없음) 중단·실패만 말한다. */
export function turnSummary(t) {
  if (!t || t.endSeq == null) return null;
  let ms = t.durationMs;
  if (ms == null && t.startTs != null && t.endTs != null) ms = Math.max(0, Number(t.endTs) - Number(t.startTs));
  const interrupted = !!t.interrupted;
  const ok = t.ok !== false;
  if (!ms && !interrupted && ok) return null;   // 할 말이 없는 턴(걸린 시간을 모른다) — 빈 줄을 만들지 않는다
  return { turn: t.turn, durationMs: ms || null, interrupted, ok };
}

/** 턴 요약 한 줄. */
export function turnSummaryText(s) {
  if (!s) return '';
  const d = s.durationMs ? fmtDuration(s.durationMs) : '';
  if (s.interrupted) return d ? i18n.t('중단됨 · {d}', { d }) : i18n.t('중단됨');
  if (s.ok === false) return d ? i18n.t('오류로 끝남 · {d}', { d }) : i18n.t('오류로 끝남');
  return d ? i18n.t('{d} 걸림', { d }) : '';
}

/** 입력을 받을 수 있는 상태인가. stopped 는 사용자에게 idle 과 같다(§2.1). */
export function isBusy(st) {
  const s = st && st.thread && st.thread.state;
  return s === 'working' || s === 'waiting';
}

/**
 * 작업 중 표시에 쓸 값 — { on, title, since }.
 *  title = 지금 돌고 있는 도구(결과가 아직 없는 마지막 도구)의 제목. 없으면 ''(뷰가 '작업 중…').
 *  since = 이 턴이 시작한 시각(경과 시간의 기준). 모르면 null.
 */
export function workingInfo(st) {
  if (!isBusy(st)) return { on: false, title: '', since: null, waiting: false };
  const waiting = st.thread.state === 'waiting';
  const done = new Set();
  let last = null;
  for (const { msg } of st.msgs.values()) {
    if (isResultMsg(msg)) { const id = toolIdOfResult(msg); if (id) done.add(id); }
  }
  for (const { msg, firstSeq } of st.msgs.values()) {
    if (msg.kind !== 'tool_use' || !msg.tool || !msg.tool.id || done.has(msg.tool.id)) continue;
    if (!last || firstSeq > last.at) last = { at: firstSeq, msg };
  }
  let since = null;
  let top = -1;
  for (const t of st.turns.values()) {
    if (t.startSeq != null && t.endSeq == null && t.turn > top) { top = t.turn; since = t.startTs != null ? Number(t.startTs) : null; }
  }
  const tool = last ? last.msg.tool : null;
  return { on: true, waiting, title: tool ? String(tool.title || tool.name || '') : '', since };
}

/**
 * conv.toTerminal 응답 → 새 터미널에서 실행할 { agent, args }.
 *  데몬이 준 args 가 정본이다. 없으면(구 데몬) command 에서 실행 파일을 빼고 뽑는다.
 */
export function terminalLaunch(res, fallbackAgent) {
  const r = res || {};
  const args = Array.isArray(r.args) ? r.args.filter((x) => typeof x === 'string' && x) : argsOfCommand(r.command);
  return { agent: String(r.agent || fallbackAgent || 'claude'), args, cwd: String(r.cwd || '') };
}

// ── 요청 카드(§10.8) ──────────────────────────────────────────────────────────
/**
 * ConvReq → 승인 카드 행(approvals.js 가 그리는 모양).
 *  · 권한    → 번호 선택지(허용 / 허용하고 다음부터 묻지 않기 / 거절)
 *  · 질문    → 질문 카드(한 번에 하나)
 *  · 계획    → 계획 본문 + (계획대로 진행 / 거절)
 *  카드는 prompt.kind === 'choice' 로 질문·계획을 가른다(approvals.js isChoice).
 */
export function reqToCard(req) {
  if (!req || !req.id) return null;
  const kind = req.kind === 'question' || req.kind === 'plan' ? 'choice' : 'permission';
  const questions = req.kind === 'question' && Array.isArray(req.questions) && req.questions.length ? req.questions : undefined;
  return {
    id: String(req.id),
    tool: req.tool || (req.kind === 'plan' ? 'ExitPlanMode' : req.kind === 'question' ? 'AskUserQuestion' : ''),
    kind,
    summary: req.summary || '',
    relPath: req.relPath || '',
    detail: req.detail || '',
    alwaysLabel: req.alwaysLabel || '',
    inputPreview: req.inputPreview || null,
    diff: req.diff || null,
    prompt: {
      kind,
      ...(questions ? { questions } : {}),
      ...(req.kind === 'plan' ? { plan: typeof req.plan === 'string' ? req.plan : '' } : {}),
    },
  };
}

/**
 * 카드가 낸 응답 → conv.respond params(§4.2).
 *  카드의 계획 승인은 의견이 있으면 answer 로 온다(v1 승인 인박스 규약) → v2 는 "허용 + 추가 지시"다.
 *  질문 답은 `{ "<질문 문구>": "<라벨|자유 텍스트>" }` 로 보낸다(answersForWire — 앱과 같은 모양, §0.1).
 */
export function respondParams(req, body, by) {
  const b = body || {};
  const out = { reqId: String(req.id), decision: b.decision };
  if (req.kind === 'plan' && b.decision === 'answer') {
    const text = String(((b.answers || [])[0] || {}).text || '').trim();
    out.decision = 'allow';
    if (text) out.message = text;
  } else {
    if (b.always) out.always = true;
    if (b.message) out.message = String(b.message);
    if (b.decision === 'answer' && Array.isArray(b.answers)) out.answers = answersForWire(req, b.answers);
  }
  if (by) out.by = String(by);
  return out;
}

/**
 * 카드의 답(질문 index·라벨) → conv.respond 의 answers. 에이전트가 받는 모양 그대로다(§0.1).
 *  여러 개를 고른 질문은 쉼표로 잇는다(받는 쪽이 문자열 하나다). 앱 convModel.answersForWire 와 같은 규칙.
 */
export function answersForWire(req, answers) {
  const out = {};
  const qs = (req && Array.isArray(req.questions)) ? req.questions : [];
  for (const a of answers || []) {
    const q = qs[a.questionIndex];
    if (!q) continue;
    const v = (a.text && String(a.text).trim()) || (a.labels || []).join(', ');
    if (v) out[q.question || q.header || String(a.questionIndex)] = v;
  }
  return out;
}

// 앱 convModel.ts 와 이름을 맞춘 별칭 — 두 구현을 나란히 읽을 때 같은 것을 같은 이름으로 찾게.
export { createConv as emptyState, openReqs as pendingReqs, reqToCard as reqToApproval };

// ── 터미널로 넘기기(§6.1) ─────────────────────────────────────────────────────
/**
 * `<bin> --resume <id>` → 실행 파일을 뺀 인자 배열. 새 터미널은 기존 에이전트 실행 경로
 *  (agents.launch: 셸 준비를 기다렸다가 타이핑)로 띄우고, 거기에 이 인자를 붙인다.
 *  따옴표·역슬래시를 셸 규칙대로 푼다(경로에 공백이 있는 설치 위치).
 */
export function argsOfCommand(command) {
  const src = String(command || '');
  const out = [];
  let cur = '';
  let has = false;
  let q = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) { q = ''; continue; }
      if (c === '\\' && q === '"' && i + 1 < src.length) { cur += src[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < src.length) { cur += src[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c; has = true;
  }
  if (has || cur) out.push(cur);
  return out.slice(1);
}

// ── 대화 목록(§10.6) ──────────────────────────────────────────────────────────
/** 상대 시각 — '방금' / '5분 전' / '3시간 전' / '2일 전' / 한 주가 넘으면 날짜. 미래 값(시계 어긋남)은 '방금'. */
export function fmtAgo(ts, now) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = Math.max(0, (Number(now) || 0) - t);
  if (d < 60000) return i18n.t('방금');
  const min = Math.floor(d / 60000);
  if (min < 60) return i18n.t('{n}분 전', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return i18n.t('{n}시간 전', { n: h });
  const day = Math.floor(h / 24);
  if (day < 7) return i18n.t('{n}일 전', { n: day });
  const dt = new Date(t);
  return `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}`;
}

/** 목록의 상태 점 — 'attention'(조치 필요) | 'working' | ''(없음). 색은 뷰가 상태 신호 색으로만 칠한다. */
export function threadDot(t) {
  if (!t) return '';
  if (t.state === 'waiting' || Number(t.pending) > 0) return 'attention';
  if (t.state === 'working') return 'working';
  if (t.state === 'error') return 'error';
  return '';
}

/** 채팅에서 바로 열 수 없는 대화인가 — 터미널이 쓰고 있으면 먼저 가져와야 한다(§6.3). */
export function needsAdopt(t) {
  return !!(t && t.owner === 'terminal');
}

export function threadTitle(t) {
  const s = t && typeof t.title === 'string' ? t.title.trim() : '';
  return s || i18n.t('새 대화');
}

// ── 스트리밍 렌더(§10.5) ──────────────────────────────────────────────────────
// 글자가 올 때마다 메시지 전체를 다시 그리면 ① 선택이 풀리고 ② 긴 답에서 프레임이 밀린다.
//  그래서 본문을 "확정 블록 + 진행 중 꼬리"로 나누고, 확정 블록의 DOM 은 건드리지 않는다.
//
//  나누는 자리 = chat-md.renderMarkdown 이 **앞뒤를 끊는 자리**와 같아야 한다(빈 줄 · 펜스 여닫이).
//  그 자리에서 나눠 따로 그린 결과는 통째로 그린 결과와 같다 — 테스트가 이 등식을 고정한다.
const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+#.-]*)\s*$/;   // chat-md.js 와 같은 식
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/**
 * @returns {{ blocks:string[], tail:string, open:{mark:string,lang:string}|null, partial:boolean }}
 *   blocks  = 확정된 블록의 원문(다시는 안 바뀐다)
 *   tail    = 아직 자라는 부분
 *   open    = 꼬리가 열린 코드 펜스 안이면 그 펜스
 *   partial = 마지막 줄이 아직 개행으로 끝나지 않았다
 */
export function splitStreamBlocks(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const partial = src.length > 0 && !src.endsWith('\n');
  const lines = src.split('\n');
  if (!partial) lines.pop();            // 끝 개행이 만든 빈 조각
  const blocks = [];
  let cur = [];
  let fence = null;
  const flush = () => { if (cur.length) blocks.push(cur.join('\n')); cur = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (partial && i === lines.length - 1) { cur.push(line); break; }   // 미완 줄은 판정하지 않는다
    const m = FENCE_RE.exec(line);
    if (fence) {
      cur.push(line);
      if (m && m[1] === fence.mark && !m[2]) { fence = null; flush(); }
      continue;
    }
    if (m) { flush(); fence = { mark: m[1], lang: m[2] || '' }; cur.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    cur.push(line);
  }
  return { blocks, tail: cur.join('\n'), open: fence, partial };
}

// 마지막 줄의 안 닫힌 인라인 문법을 보정한다 — 닫는 기호가 올 때까지 `**`·백틱·`[글](주소` 가
//  날글자로 보였다가 사라지면 글이 깜빡인다. 내용이 있으면 닫아서 그리고, 방금 연 것이면 감춘다.
/** 짝 없는 마지막 `*` 의 위치(없으면 -1). 코드 안과 `**` 는 세지 않는다. */
function lastLoneStar(s) {
  let inCode = false;
  let last = -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') { inCode = !inCode; continue; }
    if (inCode || c !== '*') continue;
    if (s[i + 1] === '*') { i += 1; continue; }
    last = i; n += 1;
  }
  return n % 2 === 1 ? last : -1;
}

function closeInline(line) {
  let s = line;
  // 링크/이미지 — 주소가 오는 동안에는 라벨만(이미지는 자리 자체를 미룬다).
  s = s.replace(/!\[[^\]\n]*\]\([^)\s]*$/, '');
  s = s.replace(/!\[[^\]\n]*$/, '');
  s = s.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1');
  // 인라인 코드 — 홀수 개면 마지막 것이 열려 있다.
  const ticks = s.split('`');
  let inCode = false;
  if (ticks.length % 2 === 0) {
    if (ticks[ticks.length - 1].length) { s += '`'; inCode = true; }
    else s = s.slice(0, -1);
  }
  // 코드 밖 글자만 센다(코드 안의 ** 는 문법이 아니다).
  const outside = () => s.split('`').filter((_, i) => i % 2 === 0).join('\u0000');
  const closePair = (tok) => {
    const n = outside().split(tok).length - 1;
    if (n % 2 === 0) return;
    if (!inCode && s.endsWith(tok)) { s = s.slice(0, -tok.length); return; }   // 방금 열었다
    s += tok;
  };
  closePair('**');
  closePair('~~');
  // 기울임(*) — 굵게(**)와 코드를 빼고 남는 별표가 홀수면 마지막 것이 열려 있다.
  //  목록 기호(`* 항목`)나 곱셈(`2 * 3`)은 뒤가 공백이라 여는 기호가 아니다.
  const at = lastLoneStar(s);
  if (at >= 0) {
    const after = s.slice(at + 1);
    if (!after) s = s.slice(0, at);
    else if (!/^\s/.test(after)) s += '*';
  }
  return s;
}

/**
 * 꼬리를 그리기 전에 다듬는다. 고치는 것은 **아직 개행으로 끝나지 않은 마지막 줄**뿐이다
 *  (끝난 줄은 이미 확정된 글자다 — 거기서 안 닫힌 기호는 실제로 날글자다).
 *  · 펜스 줄이 쪼개져 오는 중(`` ` `` · ` `` ` · ```` ```py ````)이면 그 줄을 미룬다.
 *  · 표 구분선이 오는 중이면 그 줄을 미룬다(구분선이 완성되면 표가 된다).
 *  · 제목·목록 기호만 온 줄도 미룬다.
 *  열린 펜스는 손대지 않는다 — renderMarkdown 이 닫힌 것으로 보고 코드 블록으로 그린다.
 */
export function patchStreamTail(tail, info) {
  const t = String(tail == null ? '' : tail);
  const partial = !!(info && info.partial);
  if (!t || !partial) return t;
  const nl = t.lastIndexOf('\n');
  const head = nl >= 0 ? t.slice(0, nl) : '';
  const last = nl >= 0 ? t.slice(nl + 1) : t;
  const drop = () => head;   // 마지막 줄을 미룬다(앞 줄들은 그대로)
  if (info && info.open) {
    // 닫는 펜스가 쪼개져 오는 중일 수 있다.
    return /^\s*(`{1,3}|~{1,3})$/.test(last) ? drop() : t;
  }
  if (/^\s*(`{1,2}|~{1,2})$/.test(last)) return drop();
  if (/^\s*(```|~~~)[A-Za-z0-9_+#.-]*$/.test(last)) return drop();
  if (/^\s*#{1,6}$/.test(last)) return drop();
  if (/^\s*([-*+]|\d{1,3}[.)])$/.test(last)) return drop();
  const prev = head.slice(head.lastIndexOf('\n') + 1);
  if (last.trim() && /^\s*\|?[\s:|-]*$/.test(last) && TABLE_ROW_RE.test(prev)) return drop();
  const fixed = closeInline(last);
  return nl >= 0 ? head + '\n' + fixed : fixed;
}

// ── 첨부(§4.1·§4.5) ───────────────────────────────────────────────────────────
// 데몬 계약: conv.send/create 의 `attachments:[{path, name?, mediaType?}]`(최대 12). 데몬이 본문 끝에
//  `[첨부] <절대경로>` 줄로 붙이고 msg.attachments 에 남긴다. 경로는 **그 PC 의 홈 jail 안**이어야 한다
//  (밖이면 데몬이 조용히 버린다) → 보내기 전에 PC 의 경로로 만들어 둔다(attachPlan).
export const ATTACH_MAX = 12;
export const ATTACH_DIR = '.codingpt/attachments';   // 홈 기준 — 앱 attachmentUpload.ts 와 같은 자리
const ATTACH_LINE_RE = /^\[첨부\] (.+)$/;
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff'];
const ATTACH_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function extOfName(name) {
  const n = String(name || '');
  return n.includes('.') ? n.split('.').pop().toLowerCase() : '';
}

/** 파일 하나 → 칩 표시 정보. */
export function attachInfo(path, name, mediaType) {
  const nm = String(name || baseName(path) || path || '');
  const ext = extOfName(nm) || extOfName(baseName(path));
  const mt = mediaType ? String(mediaType) : (ATTACH_MIME[ext] || '');
  const image = mt ? mt.startsWith('image/') : IMAGE_EXTS.includes(ext);
  return { path: String(path || ''), name: nm, ext, image, ...(mt ? { mediaType: mt } : {}) };
}

/**
 * 보낸 메시지 본문 → { body, files }. 끝의 `[첨부] <경로>` 줄들을 떼어 칩으로 그린다(§4.5).
 *  줄은 **끝에 모여 있을 때만** 뗀다(본문 중간에 사용자가 쓴 같은 모양의 글은 글이다).
 *  msg.attachments 가 있으면 이름·형식은 그것을 쓴다(경로로 짝짓는다). 줄이 없는데 attachments 만 있으면 그것으로.
 */
export function splitAttachLines(text, attachments) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const paths = [];
  while (lines.length) {
    const m = ATTACH_LINE_RE.exec(lines[lines.length - 1]);
    if (!m) break;
    paths.unshift(m[1].trim());
    lines.pop();
  }
  const meta = new Map();
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (a && typeof a.path === 'string' && a.path) meta.set(a.path, a);
  }
  if (!paths.length && meta.size) {
    return { body: src, files: [...meta.values()].map((a) => attachInfo(a.path, a.name, a.mediaType)) };
  }
  if (!paths.length) return { body: src, files: [] };
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const files = paths.map((p) => { const a = meta.get(p); return attachInfo(p, a && a.name, a && a.mediaType); });
  return { body: lines.join('\n'), files };
}

// 홈 안의 절대경로인가 — 데몬 jail 은 "그 PC 의 홈"이다. PC 앱에는 홈 경로를 묻는 길이 없어 모양으로 판정한다
//  (틀려도 비용이 작다: 홈 안인데 복사하면 사본이 하나 생길 뿐, 홈 밖인데 그대로 보내면 데몬이 버린다 → 밖으로 오판하는 쪽이 안전).
const HOME_RE = [/^\/Users\/[^/]+\//, /^\/home\/[^/]+\//, /^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/i];
function isAbsPath(p) { return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p); }
export function looksInHome(p) {
  const s = String(p || '');
  if (!isAbsPath(s)) return false;
  if (/^\/Users\/Shared\//.test(s)) return false;
  return HOME_RE.some((re) => re.test(s));
}

/**
 * 첨부를 그 PC 의 경로로 만드는 방법.
 *  · 'keep'   — 그대로 보낸다(워크스페이스에서 고른 파일 = 이미 그 PC 의 홈 기준 경로 / 이 PC 의 홈 안 파일)
 *  · 'copy'   — 이 PC 의 홈 밖(임시 폴더의 붙여넣은 스크린샷 등) → ~/.codingpt/attachments 로 복사
 *  · 'upload' — 다른 PC 의 대화 → 바이트를 그 PC 의 ~/.codingpt/attachments 로 올린다
 * @param {{path:string, origin:'local'|'workspace'}} a  origin = 어디서 온 경로인가(OS 드롭·붙여넣기 = local)
 */
export function attachPlan(a, isLocal) {
  if (!a || !a.path) return 'keep';
  if (a.origin === 'workspace') return 'keep';
  if (!isLocal) return 'upload';
  return looksInHome(a.path) ? 'keep' : 'copy';
}

/** 올릴 때의 파일명 — `<yyyymmdd-hhmmss>-<원래 이름>`(앱 uploadAttachmentNamed 와 같은 규칙). */
export function attachUploadName(name, now) {
  const d = new Date(Number(now) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const safe = String(name || 'file').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, '_').slice(0, 120) || 'file';
  return `${ATTACH_DIR}/${ts}-${safe}`;
}

/** 칩 목록 → 와이어 모양(최대 12, 경로 없는 것은 뺀다). 빈 배열이면 undefined(필드를 싣지 않는다). */
export function attachmentsForWire(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.path !== 'string' || !a.path) continue;
    if (out.some((x) => x.path === a.path)) continue;
    out.push({ path: a.path, ...(a.name ? { name: String(a.name) } : {}), ...(a.mediaType ? { mediaType: String(a.mediaType) } : {}) });
    if (out.length >= ATTACH_MAX) break;
  }
  return out.length ? out : undefined;
}

// ── 파일 바이트 캐시(conv.file) ───────────────────────────────────────────────
/**
 * 같은 파일을 행이 다시 그려질 때마다 받지 않게 — 진행 중 요청은 합치고, 받은 것은 바이트 상한 안에서 남긴다.
 *  "없음"(missing)은 남기지 않는다(파일이 곧 생길 수 있다). 실패(throw)도 남기지 않는다.
 */
export function createByteCache(maxBytes) {
  const cap = Number(maxBytes) || 48 * 1024 * 1024;
  const done = new Map();      // key → { r, size } (삽입 순서 = 오래된 순)
  const flying = new Map();    // key → Promise
  let total = 0;
  const sizeOf = (r) => (r && typeof r.base64 === 'string' ? r.base64.length : 0);
  return {
    get(key, loader) {
      const k = String(key);
      const hit = done.get(k);
      if (hit) { done.delete(k); done.set(k, hit); return Promise.resolve(hit.r); }
      if (flying.has(k)) return flying.get(k);
      const p = Promise.resolve().then(loader).then((r) => {
        flying.delete(k);
        const size = sizeOf(r);
        if (r && !r.missing && size && size <= cap) {
          done.set(k, { r, size });
          total += size;
          for (const [ok, v] of done) { if (total <= cap) break; done.delete(ok); total -= v.size; }
        }
        return r;
      }, (e) => { flying.delete(k); throw e; });
      flying.set(k, p);
      return p;
    },
    has(key) { return done.has(String(key)); },
    get size() { return total; },
    clear() { done.clear(); flying.clear(); total = 0; },
  };
}

/** conv.file 의 없음 사유 → 한 줄. */
export function fileMissingText(r) {
  const why = r && r.reason;
  if (why === 'too_large') return i18n.t('파일이 너무 커서 여기서는 못 보여줘요(눌러서 열기)');
  if (why === 'not_found') return i18n.t('파일을 찾을 수 없어요');
  return i18n.t('불러오지 못했어요');
}

// ── 사용량 줄(§4.5) ───────────────────────────────────────────────────────────
/**
 * thread → 상태 칩 재료(chat-model.statusChips/statusDetail 이 그린다 — 앱 ConvBody 와 같은 값).
 *  "모델 · 컨텍스트 n%". 모르는 값은 싣지 않는다(빈 칩을 만들지 않는다). 둘 다 모르면 null.
 */
export function usageStatus(thread) {
  if (!thread) return null;
  const u = thread.usage && typeof thread.usage === 'object' ? thread.usage : null;
  const st = {};
  const model = (u && u.model) || thread.model;
  if (model) st.model = String(model);
  if (u && typeof u.contextTokens === 'number') st.contextUsed = u.contextTokens;
  if (u && typeof u.contextMax === 'number' && u.contextMax > 0) st.contextMax = u.contextMax;
  if (u && typeof u.contextPct === 'number' && Number.isFinite(u.contextPct)) st.contextPct = Math.max(0, Math.min(100, Math.round(u.contextPct)));
  else if (st.contextUsed != null && st.contextMax) st.contextPct = Math.max(0, Math.min(100, Math.round((st.contextUsed / st.contextMax) * 100)));
  if (u && typeof u.costUsd === 'number') st.costUsd = u.costUsd;
  // 플랜 한도(5시간·주간) — claude 의 rate_limit_event 가 알려 준 창 하나(utilization 0~1, resetsAt 초). 사용량 링 팝업이 그린다.
  const rl = u && u.rateLimit && typeof u.rateLimit === 'object' ? u.rateLimit : null;
  if (rl && typeof rl.utilization === 'number' && Number.isFinite(rl.utilization)) {
    st.limits = [{ id: String(rl.kind || 'rate'), label: rateKindLabel(rl.kind), pct: Math.max(0, Math.min(100, Math.round(rl.utilization * 100))), resetsAt: rl.resetsAt != null ? rl.resetsAt : null }];
  }
  return st.model || st.contextPct != null || st.limits ? st : null;
}

function rateKindLabel(kind) {
  const k = String(kind || '').toLowerCase();
  if (/five|5h|hour/.test(k)) return i18n.t('5시간');
  if (/seven|week|7d/.test(k)) return i18n.t('주간');
  return k || i18n.t('사용량');
}

/** 추론 강도 표시 이름(데몬이 준 단계 id → 사람 말). 모르는 단계는 그대로. */
export function effortLabel(e) {
  switch (e) {
    case 'low': return i18n.t('낮음');
    case 'medium': return i18n.t('중간');
    case 'high': return i18n.t('높음');
    case 'xhigh': return i18n.t('매우 높음');
    case 'max': return i18n.t('최대');
    case 'ultra': return i18n.t('울트라');
    default: return e ? String(e) : '';
  }
}

/**
 * 모델 메뉴용 분할 — 계열별 최신 버전만 위에(Opus·Sonnet·Fable·Haiku 순), 나머지는 "더 많은 모델" 아래로.
 *  별칭(opus·sonnet…)은 그 계열 최신 버전과 같은 것이라 따로 세우지 않는다(켜짐·기본값 표시는 그 줄로 옮긴다).
 *  버전 ID 를 모르는 에이전트(또는 목록이 별칭뿐)면 전부 위에 둔다. 항목 = { id, label, on, badge }.
 */
export function modelSplit(choices, caps, agent) {
  const list = Array.isArray(choices) ? choices : [];
  const ag = caps && Array.isArray(caps.agents) ? caps.agents.find((a) => a && a.id === agent) : null;
  const defAlias = ag && ag.defaultModel ? String(ag.defaultModel) : '';
  const famOf = (id) => {
    const m = /^claude-(opus|sonnet|fable|haiku)-(\d+)-(\d{1,2})(?:-\d{8})?$/.exec(String(id));
    return m ? { f: m[1], v: [Number(m[2]), Number(m[3])] } : null;
  };
  const versioned = list.filter((c) => famOf(c.id));
  if (!versioned.length) return { top: list.map((c) => ({ ...c, badge: c.id === defAlias ? i18n.t('기본값') : '' })), more: [] };
  // 같은 계열·같은 버전(날짜 접미 변형)은 한 줄로 합친다 — 켜짐은 어느 쪽이든 유지.
  const byKey = new Map();
  for (const c of versioned) {
    const fm = famOf(c.id);
    const key = fm.f + ':' + fm.v.join('.');
    const hit = byKey.get(key);
    if (hit) { hit.on = hit.on || !!c.on; continue; }
    byKey.set(key, { ...c, _f: fm.f, _v: fm.v });
  }
  const top = [];
  const more = [];
  for (const f of ['opus', 'sonnet', 'fable', 'haiku']) {
    const fam = [...byKey.values()].filter((x) => x._f === f).sort((a, b) => b._v[0] - a._v[0] || b._v[1] - a._v[1]);
    if (fam[0]) top.push(fam[0]);
    more.push(...fam.slice(1));
  }
  const onAlias = list.find((c) => c.on && !famOf(c.id));
  if (onAlias) { const t = top.find((x) => x._f === onAlias.id); if (t) t.on = true; }
  const clean = (x) => { const { _f, _v, ...rest } = x; return { ...rest, badge: _f === defAlias ? i18n.t('기본값') : '' }; };
  return { top: top.map(clean), more: more.map((x) => { const { _f, _v, ...rest } = x; return { ...rest, badge: '' }; }) };
}

// ── 에이전트·모델 고르기(§4.5) ────────────────────────────────────────────────
/** 새 대화에서 고를 수 있는 에이전트. **2개 이상일 때만** 고르는 줄을 보인다(1개면 빈 배열). */
export function agentChoices(caps) {
  const list = (caps && Array.isArray(caps.agents) ? caps.agents : [])
    .filter((a) => a && a.id && a.available);
  return list.length >= 2 ? list.map((a) => ({ id: String(a.id), label: String(a.label || a.id) })) : [];
}

/**
 * 모델 목록 — **데몬이 알려 준 것만**(conv.caps.models 또는 그 에이전트의 agents[].models).
 *  없으면 빈 배열 = 기능을 숨긴다(추측한 별칭을 내밀지 않는다). 항목은 문자열 또는 {id,label}.
 *  지금 모델이 목록에 없으면 맨 앞에 남긴다(바뀌지 않았는데 다른 것이 켜진 것처럼 보이지 않게).
 */
export function modelChoices(caps, agent, current) {
  const out = modelList(caps, agent);
  if (!out.length) return [];
  const cur = current ? String(current) : '';
  // 지금 모델이 전체 ID(`claude-haiku-4-5-20251001`)이고 목록이 별칭(`haiku`)이면 같은 것이다 —
  //  그 별칭을 켠다(원시 ID 를 한 줄 더 세우지 않는다). 별칭도 못 찾으면 맨 앞에 다듬은 이름으로 남긴다.
  const onId = cur ? (out.some((x) => x.id === cur) ? cur : (familyOf(out, cur) || {}).id || cur) : '';
  if (onId && !out.some((x) => x.id === onId)) out.unshift({ id: cur, label: prettyModelId(cur) });
  return out.map((x) => ({ ...x, on: x.id === onId }));
}

/** 데몬이 알려 준 모델 목록(에이전트별 → 공용 순). 항목 = { id, label }. */
function modelList(caps, agent) {
  const ag = caps && Array.isArray(caps.agents) ? caps.agents.find((a) => a && a.id === agent) : null;
  const raw = (ag && Array.isArray(ag.models) && ag.models.length) ? ag.models
    : (caps && Array.isArray(caps.models) ? caps.models : []);
  const out = [];
  for (const m of raw) {
    const id = typeof m === 'string' ? m : m && (m.id || m.value);
    if (!id || out.some((x) => x.id === String(id))) continue;
    out.push({ id: String(id), label: String((m && typeof m === 'object' && m.label) || id), ...(m && typeof m === 'object' && m.hint ? { hint: String(m.hint) } : {}) });
  }
  return out;
}

/** 전체 ID 의 토막(`-`·`.`·`[`·`]` 로 가른 것) 중 하나가 목록 항목의 id/라벨과 같으면 그 항목(3자 이상만 — 우연 일치 방지). */
function familyOf(list, id) {
  const toks = String(id).toLowerCase().split(/[-_.\[\]\s]+/).filter(Boolean);
  return list.find((x) => {
    const a = x.id.toLowerCase(), l = x.label.toLowerCase();
    return (a.length >= 3 && toks.includes(a)) || (l.length >= 3 && toks.includes(l));
  }) || null;
}

/**
 * 원시 모델 ID → 사람이 읽는 이름(목록에서 못 찾았을 때의 폴백).
 *  `claude-haiku-4-5-20251001` → `Haiku 4.5` · `claude-opus-4-1[1m]` → `Opus 4.1` · 그 밖(`gpt-5-codex`)은 날짜 꼬리만 뗀다.
 */
export function prettyModelId(id) {
  let s = String(id || '').trim();
  if (!s) return '';
  s = s.replace(/\[[^\]]*\]$/, '').replace(/[-@](20\d{6}|\d{8})$/, '');
  if (!/^claude-/i.test(s)) return s;
  const toks = s.replace(/^claude-/i, '').split('-').filter(Boolean);
  const words = [];
  const nums = [];
  for (const t of toks) (/^\d+$/.test(t) ? nums : words).push(t);
  if (!words.length) return s;
  const head = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return nums.length ? `${head} ${nums.join('.')}` : head;
}

/**
 * 표시용 모델 이름 — caps 목록의 라벨(Haiku/Sonnet/Opus)이 정본. 전체 ID 는 같은 계열의 별칭 라벨로,
 *  그것도 없으면 prettyModelId. 헤더 알약과 하단 사용량 줄이 같은 규칙을 쓴다(PLAN §0.7 채팅).
 */
export function modelLabel(id, caps, agent) {
  const cur = id ? String(id) : '';
  if (!cur) return '';
  const list = modelList(caps, agent);
  const hit = list.find((x) => x.id === cur) || familyOf(list, cur);
  return hit ? hit.label : prettyModelId(cur);
}

// ── 대화 안 검색(§4.5 — 클라 전용) ───────────────────────────────────────────
/** 대소문자 무시로 q 가 text 에 몇 번 나오나(겹치지 않게). */
export function countMatches(text, q) {
  const s = String(text || '').toLowerCase();
  const n = String(q || '').toLowerCase();
  if (!n) return 0;
  let c = 0;
  for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + n.length)) c += 1;
  return c;
}

function toolText(r) {
  const m = r.msg || {};
  const t = m.tool || {};
  const res = r.result && r.result.result ? r.result.result : null;
  return [t.title, t.name, t.argsPreview, t.path, res && res.preview].filter(Boolean).join('\n');
}

/**
 * 검색이 행 안의 글을 **보이게** 하려면 무엇을 펼쳐야 하나. 접힌 묶음·접힌 도구 결과 속 일치는
 *  화면에 없어 찾을 수 없다 → 그 묶음/도구를 펼친다. 반환 { groups, tools }(key 집합).
 */
export function searchExpand(rows, q) {
  const groups = new Set();
  const tools = new Set();
  if (!String(q || '').trim()) return { groups, tools };
  const visit = (r, group) => {
    if (r.type === 'tool' || r.type === 'orphan') {
      const res = r.result && r.result.result ? r.result.result : (r.msg && r.msg.result) || null;
      const inRes = !!(res && countMatches(res.preview, q));
      if (countMatches(toolText(r), q)) {
        if (group) groups.add(group);
        if (inRes && r.type === 'tool') tools.add(r.key);
      }
      return;
    }
    if (r.type === 'thinking' && countMatches(r.msg && r.msg.text, q) && group) groups.add(group);
  };
  for (const r of rows || []) {
    if (r.type === 'group') for (const it of r.items || []) visit(it, r.key);
    else visit(r, null);
  }
  return { groups, tools };
}

// ── 채팅 탭 고르기(알림으로 대화 열기) ───────────────────────────────────────
/**
 * 대화 B 를 열 탭. cands = 지금 워크스페이스의 채팅 탭들 [{ threadId, focused? , ...}](화면 순서).
 *  ① 그 대화가 열린 탭 → 'focus'  ② **threadId 가 없는 빈 새 채팅 탭** → 'reuse'(포커스 pane 의 것 우선)
 *  ③ 없으면 'new'. 다른 대화가 열린 탭은 절대 갈아치우지 않는다(앱 실기 규칙과 같다).
 */
export function pickConvTab(cands, threadId) {
  const list = Array.isArray(cands) ? cands : [];
  const same = list.find((c) => c && threadId && c.threadId === threadId);
  if (same) return { kind: 'focus', target: same };
  const blank = list.filter((c) => c && !c.threadId);
  const b = blank.find((c) => c.focused) || blank[0];
  if (b) return { kind: 'reuse', target: b };
  return { kind: 'new', target: null };
}

/**
 * 탭에 반영할 것 — 대화가 바뀌었거나 제목이 새로 왔으면 탭 라벨·threadId 를 맞춘다. 바꿀 것이 없으면 null.
 *  제목을 모르면(빈 문자열) 옛 제목을 남기지 않는다: 다른 대화의 제목이 붙어 있으면 지운다.
 */
export function tabPatchFor(tab, threadId, thread) {
  const t = tab || {};
  const out = {};
  if ((threadId || undefined) !== (t.threadId || undefined)) {
    out.threadId = threadId || undefined;
    out.title = (thread && typeof thread.title === 'string' && thread.title.trim()) || undefined;
    if (thread && thread.agent) out.agent = thread.agent;
    return out;
  }
  // 탭 아이콘 = 에이전트 로고 — 대화의 에이전트를 탭에 적어 둔다(목록·다른 기기에서도 같은 로고).
  if (thread && thread.agent && thread.agent !== t.agent) out.agent = thread.agent;
  const title = thread && typeof thread.title === 'string' ? thread.title.trim() : '';
  if (title && title !== (t.title || '')) out.title = title;
  return Object.keys(out).length ? out : null;
}
