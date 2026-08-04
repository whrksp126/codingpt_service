// review.js — 코드 리뷰 세션(에이전트 ↔ 사용자 화면).
//
// 무엇인가: 터미널 안의 에이전트가 "이 변경을 봐 달라"고 부르면(`cpt review`), 화면(PC/폰)의 IDE 가
//  리뷰 모드로 바뀌고, 사용자가 덩어리마다 승인/거절하고 코멘트를 단 뒤 보내면 그 결과가 **그
//  에이전트의 stdout 으로** 돌아간다.
//
// 왜 여기(데몬)에 상태를 두나: 사용자가 리뷰하는 시간은 사람 시간이다(수십 초~수 분). ui_command
//  왕복은 60초 상한이라(cpt-server UI_TIMEOUT_MAX_MS) 한 번의 왕복으로 사람을 기다릴 수 없다.
//  그래서 **띄우기(ui_command)와 결과 받기(review.submit RPC)를 분리**하고, 그 사이를 잇는
//  세션을 데몬이 들고 있는다. 승인 인박스가 이미 같은 모양이다.
//
// 규율:
//  · 세션은 **메모리에만** 둔다. 데몬이 죽으면 에이전트도 같이 죽는다(같은 PC) — 디스크에 남겨
//    봐야 기다리는 쪽이 없다. 대신 죽었을 때 화면이 유령 리뷰를 붙들지 않도록 `review.get` 이
//    "없음"을 분명히 답한다.
//  · 사용자가 창을 닫거나 취소하면 **취소로 끝난다**. 조용히 승인으로 바꾸지 않는다.
//  · 대기는 반드시 끝난다(타임아웃). 에이전트를 영원히 붙잡아 두면 그 터미널이 죽은 것처럼 보인다.

// 제어문자 제거용(탭 \t·줄바꿈 \n 은 남긴다) — 코멘트는 에이전트의 터미널로 되돌아가므로
//  ESC(\u001B)가 섞이면 그 터미널이 오작동한다.
const CTRL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const MAX_SESSIONS = 20;          // 동시에 열려 있을 수 있는 리뷰(폭주 방지)
const MAX_FILES = 50;
const MAX_COMMENT = 4000;
const MAX_NOTE = 4000;

/** id → session */
const sessions = new Map();
/** id → Set<resolve> — 같은 리뷰를 여럿이 기다릴 수 있다(cpt 재호출·재접속). */
const waiters = new Map();

let seq = 0;
function newId() {
  seq += 1;
  return `rv_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function prune() {
  // 끝난 지 오래된 것부터 버린다. 끝난 세션도 잠시 남겨 둔다 — 화면이 늦게 `review.get` 을 물어도
  //  "이미 끝났다"를 답할 수 있어야 유령 리뷰가 안 남는다.
  if (sessions.size <= MAX_SESSIONS) return;
  const done = [...sessions.values()].filter((s) => s.status !== 'pending').sort((a, b) => a.endedAt - b.endedAt);
  while (sessions.size > MAX_SESSIONS && done.length) sessions.delete(done.shift().id);
  // 그래도 넘치면 가장 오래된 대기 세션을 취소로 끝내고 **버린다**(기다리던 에이전트도 함께 풀린다).
  //  ★ `finish` 는 세션을 지우지 않는다(끝난 뒤에도 조회에 답해야 하므로) — 여기서 delete 까지
  //   하지 않으면 크기가 줄지 않아 이 루프가 **영원히 돈다**. 실제로 테스트가 이 무한루프를
  //   잡았다(데몬 이벤트루프 전체가 멈춘다 = 그 PC 의 모든 터미널이 죽는다).
  let guard = sessions.size + 1;
  while (sessions.size > MAX_SESSIONS && guard-- > 0) {
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    finish(oldest.id, { status: 'cancelled', reason: 'too_many' });
    sessions.delete(oldest.id);
  }
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  // 제어문자 제거(탭·줄바꿈은 남긴다) — 코멘트가 터미널로 되돌아가므로 ESC 는 특히 위험하다.
  return v.replace(CTRL_RE, '').slice(0, max);
}

/**
 * 새 리뷰. files = [{ path, diffText, truncated, hunks }].
 *  `hunks` 는 데몬이 세지 않는다 — 화면(공용 파서)이 정본이고, 여기서 또 세면 두 벌이 된다.
 */
function create({ title, files, cwd, ws }) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_FILES).map((f) => ({
    path: str(f && f.path, 1024),
    diffText: typeof (f && f.diffText) === 'string' ? f.diffText : '',
    truncated: !!(f && f.truncated),
  })).filter((f) => f.path);
  if (!list.length) throw new Error('리뷰할 변경이 없습니다');
  const s = {
    id: newId(),
    title: str(title, 200) || '코드 리뷰',
    files: list,
    cwd: typeof cwd === 'string' ? cwd : '',
    ws: typeof ws === 'string' ? ws : '',
    status: 'pending',
    result: null,
    createdAt: Date.now(),
    endedAt: 0,
  };
  sessions.set(s.id, s);
  prune();
  return s;
}

/** 화면에 보낼 모양(전문). diffText 가 커서 목록 응답에는 넣지 않는다. */
function payload(s) {
  return {
    reviewId: s.id,
    title: s.title,
    ws: s.ws,
    status: s.status,
    files: s.files.map((f) => ({ path: f.path, diffText: f.diffText, truncated: f.truncated })),
  };
}

function get(id) {
  return sessions.get(String(id || '')) || null;
}

/** 지금 대기 중인 리뷰들(화면이 재접속했을 때 되살리기 위한 것). */
function listPending(ws) {
  const out = [];
  for (const s of sessions.values()) {
    if (s.status !== 'pending') continue;
    if (typeof ws === 'string' && s.ws !== ws) continue;
    out.push(payload(s));
  }
  return out.sort((a, b) => (sessions.get(a.reviewId).createdAt - sessions.get(b.reviewId).createdAt));
}

function finish(id, outcome) {
  const s = sessions.get(String(id || ''));
  if (!s || s.status !== 'pending') return null;
  s.status = outcome.status;
  s.result = outcome;
  s.endedAt = Date.now();
  const set = waiters.get(s.id);
  if (set) {
    waiters.delete(s.id);
    for (const fn of set) { try { fn(outcome); } catch (_) { /* noop */ } }
  }
  return s;
}

/**
 * 화면이 결과를 제출. 페이로드 모양은 공용 파서(buildSubmission)가 만든다 — 여기서는
 *  **길이만 조인다**(어떤 판정이 유효한지는 화면의 표가 정본이다).
 */
function submit(id, body) {
  const s = sessions.get(String(id || ''));
  if (!s) throw Object.assign(new Error('그 리뷰를 찾을 수 없습니다'), { code: 'REVIEW_NOT_FOUND' });
  if (s.status !== 'pending') throw Object.assign(new Error('이미 끝난 리뷰입니다'), { code: 'REVIEW_DONE' });
  const files = (Array.isArray(body && body.files) ? body.files : []).map((f) => ({
    path: str(f && f.path, 1024),
    verdict: str(f && f.verdict, 32),
    hunks: (Array.isArray(f && f.hunks) ? f.hunks : []).map((h) => ({
      index: Number(h && h.index) || 0,
      decision: str(h && h.decision, 16),
    })),
    comments: (Array.isArray(f && f.comments) ? f.comments : []).map((c) => ({
      hunk: Number(c && c.hunk) || 0,
      side: c && c.side === 'old' ? 'old' : 'new',
      line: c && c.line != null ? Number(c.line) : null,
      text: str(c && c.text, MAX_COMMENT),
    })).filter((c) => c.text),
  })).filter((f) => f.path);
  return finish(s.id, {
    status: 'submitted',
    files,
    note: str(body && body.note, MAX_NOTE) || undefined,
  });
}

/** 사용자가 닫음/취소. 승인으로 바꾸지 않는다 — 안 본 것은 안 본 것이다. */
function cancel(id, reason) {
  return finish(id, { status: 'cancelled', reason: str(reason, 64) || 'user' });
}

/**
 * 결과를 기다린다(에이전트 쪽). 반드시 끝난다 — 타임아웃이면 세션을 취소로 닫고
 *  `{status:'timeout'}` 을 준다(대기만 풀고 세션을 살려 두면 화면에 유령이 남는다).
 */
function waitFor(id, timeoutMs) {
  const s = sessions.get(String(id || ''));
  if (!s) return Promise.resolve({ status: 'not_found' });
  if (s.status !== 'pending') return Promise.resolve(s.result);
  const ms = Math.max(1000, Math.min(6 * 60 * 60 * 1000, Number(timeoutMs) || 30 * 60 * 1000));
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const set = waiters.get(s.id);
      if (set) set.delete(fn);
      finish(s.id, { status: 'timeout' });
      resolve({ status: 'timeout' });
    }, ms);
    const fn = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    if (!waiters.has(s.id)) waiters.set(s.id, new Set());
    waiters.get(s.id).add(fn);
  });
}

/** 테스트/재기동용 — 전부 취소하고 비운다. */
function _reset() {
  for (const id of [...sessions.keys()]) finish(id, { status: 'cancelled', reason: 'reset' });
  sessions.clear();
  waiters.clear();
}

module.exports = {
  create, get, listPending, submit, cancel, waitFor, payload, _reset,
  MAX_FILES, MAX_SESSIONS, MAX_COMMENT,
};
