/**
 * events.js — 데몬 프로세스 내 이벤트 버스(자동화 번들 설계 정본: docs/automation-design.md §2.2).
 *
 * 한 줄 요약: tasks.js(발행) ↔ automations.js·power.js(구독) 사이의 느슨한 결합. 발행자는 구독자를 모르고,
 *  구독자가 느리거나 예외를 던져도 발행자(작업 상태기계)는 멈추지 않는다.
 *
 * 타입(§2.2): task.created · task.review_ready · task.merged · task.failed · pr.ci_failed ·
 *  pr.review_comments · auto.fired · activity.changed. 목록 밖 타입도 막지 않는다(추가 전용 — 새 발행자가
 *  이 파일을 고치지 않고 이벤트를 늘릴 수 있게). 페이로드 모양은 설계 표가 정본이다.
 *
 * 규율:
 *  · emit 은 **동기 반환**하고 리스너 호출은 setImmediate 로 분리한다 — 발행 지점(save() 직후 등)에서 구독자의
 *    무거운 일(자동화 firing)이 발행자의 스택을 붙잡지 않게. 큐 하나를 순서대로 비우므로 **발행 순서는 유지**된다.
 *  · 리스너 예외는 삼키고 로그만 남긴다(상태 소유자가 소비자 버그로 죽으면 안 된다 — agent-state 구독 규율과 동일).
 *  · 리스너가 promise 를 돌려줘도 기다리지 않는다(reject 는 로그로 접는다).
 */
const noop = () => {};
let logFn = (m) => console.log(m);

const listeners = new Map(); // type → Set<fn>
const queue = [];            // [{type, payload}] — 발행 순서 그대로
let draining = false;
let scheduled = null;

function log(...a) { try { logFn(a.join(' ')); } catch (_) { /* noop */ } }

/** 구독 — fn(payload, type). 반환 = 해제 함수(두 번 불러도 무해). type '*' 는 전부 받는다. */
function on(type, fn) {
  if (typeof fn !== 'function' || typeof type !== 'string' || !type) return noop;
  let set = listeners.get(type);
  if (!set) { set = new Set(); listeners.set(type, set); }
  set.add(fn);
  return () => { const s = listeners.get(type); if (s) { s.delete(fn); if (!s.size) listeners.delete(type); } };
}

/** 발행 — 즉시 반환. 리스너는 다음 setImmediate 에서 발행 순서대로 불린다. 반환 = 받을 리스너가 있었는지. */
function emit(type, payload) {
  if (typeof type !== 'string' || !type) return false;
  const has = (listeners.get(type) && listeners.get(type).size) || (listeners.get('*') && listeners.get('*').size);
  if (!has) return false;
  queue.push({ type, payload: payload && typeof payload === 'object' ? { type, ...payload } : { type } });
  if (!scheduled && !draining) scheduled = setImmediate(drain);
  return true;
}

function drain() {
  scheduled = null;
  draining = true;
  try {
    while (queue.length) {
      const { type, payload } = queue.shift();
      const fns = [...(listeners.get(type) || []), ...(listeners.get('*') || [])];
      for (const fn of fns) {
        try {
          const r = fn(payload, type);
          if (r && typeof r.then === 'function') r.catch((e) => log('[events] listener error', type, (e && e.message) || e));
        } catch (e) {
          log('[events] listener error', type, (e && e.message) || e);
        }
      }
    }
  } finally {
    draining = false;
  }
}

/** 테스트 전용 — 대기 중 이벤트를 전부 흘려보낼 때까지(setImmediate 한 바퀴 이상) 기다린다. */
function flush() {
  return new Promise((resolve) => {
    const step = () => { if (!queue.length && !scheduled && !draining) resolve(); else setImmediate(step); };
    setImmediate(step);
  });
}

function configure(opts = {}) {
  if (typeof opts.log === 'function') logFn = opts.log;
  return module.exports;
}

/** 테스트 전용 — 구독·대기열 전부 비움. */
function _reset() {
  listeners.clear();
  queue.length = 0;
  if (scheduled) { clearImmediate(scheduled); scheduled = null; }
  draining = false;
}

function listenerCount(type) { const s = listeners.get(type); return s ? s.size : 0; }

module.exports = { on, emit, configure, flush, listenerCount, _reset };
