/**
 * conv-store.js — 채팅 v2 의 저장소(설계 정본 docs/chat-v2-design.md §2).
 *
 *   <stateDir>/conv/index.json        thread 색인 { v:1, threads:{ <id>: Thread } }
 *   <stateDir>/conv/<threadId>.jsonl  thread 별 이벤트 로그(append-only, 한 줄 = 이벤트 1개)
 *
 * 규율:
 *  · seq 는 thread 마다 1부터 단조·연속이다. 부여하는 곳은 append 하나뿐이다.
 *  · msg/req 는 key 기준 upsert — 로그에는 **새 줄로 덧붙이고**(과거 줄을 고치지 않는다), 읽을 때 접는다.
 *    접기 = "같은 key 의 더 뒤 이벤트가 있는 줄을 버린다". 그래서 스냅샷은 로그의 부분열이고 seq 오름차순이다.
 *    upsert 줄에는 `first`(그 key 가 처음 나온 seq)를 실어, 클라가 라이브(제자리 교체)와 스냅샷에서
 *    같은 자리에 행을 놓을 수 있게 한다.
 *  · 델타는 여기 오지 않는다(비영속).
 *  · 이 파일은 우리 로그만 다룬다. 에이전트의 세션 파일(~/.claude/projects)은 conv.js 의 가져오기가 읽는다.
 *  · 색인 쓰기는 모아서 한다(이벤트마다 headSeq/lastAt 이 바뀐다) — 원자적 rename 이라 도중에 죽어도 온전하다.
 *    색인이 로그보다 뒤처져도 무해하다: headSeq 의 정본은 로그다(load 가 다시 센다).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');
const { readJson, writeJsonAtomic } = require('./json-store');

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000; // 30일 무활동 thread 는 정리(agent.js 세션 로그와 같은 기준)
const INDEX_FLUSH_MS = 250;
const CACHE_MAX = 8;                        // 메모리에 펼쳐 둘 로그 수(라이브 thread 는 pinned 로 보호)
const PAGE_DEFAULT = 200;
const PAGE_MAX = 500;
const FRAME_BUDGET = 512 * 1024;            // open/since/before 응답 예산(§4.0 — 앞단 413/524 이력)
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

let nowFn = () => Date.now();
let index = null;        // { v, threads }
let indexTimer = null;
let indexDirty = false;
let pinnedFn = () => false;
const cache = new Map(); // id → { events, headSeq, latest:Map(k→seq), first:Map(k→seq), uuids:Set, touched }

function dir() { return path.join(runtime.stateDir(), 'conv'); }
function indexFile() { return path.join(dir(), 'index.json'); }
function assertId(id) {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('대화 ID 형식이 올바르지 않습니다'), { code: 'BAD_REQUEST' });
  return String(id);
}
function logFile(id) { return path.join(dir(), assertId(id) + '.jsonl'); }

function configure(opts = {}) {
  if (typeof opts.now === 'function') nowFn = opts.now;
  if (typeof opts.pinned === 'function') pinnedFn = opts.pinned;
}

// ── 색인 ─────────────────────────────────────────────────────────────────────
function loadIndex() {
  if (index) return index;
  index = readJson(indexFile(), {
    fallback: () => ({ v: 1, threads: {} }),
    validate: (v) => v && typeof v === 'object' && v.threads && typeof v.threads === 'object',
    onError: (e) => console.error('[conv] 색인을 읽지 못했습니다(빈 색인으로 시작):', e && e.message),
  });
  // 데몬이 새로 떴다 = 살아 있는 프로세스가 없다. 디스크에 남은 진행 상태는 전부 과거의 것이다(§5).
  for (const t of Object.values(index.threads)) {
    if (!t || typeof t !== 'object') continue;
    if (t.state !== 'error') t.state = 'stopped';
    t.pending = 0;
  }
  return index;
}

function scheduleIndexFlush() {
  indexDirty = true;
  if (indexTimer) return;
  indexTimer = setTimeout(() => { indexTimer = null; flushSync(); }, INDEX_FLUSH_MS);
  if (indexTimer.unref) indexTimer.unref();
}

/** 색인을 지금 쓴다(종료 경로·테스트). 실패는 삼킨다 — 로그가 정본이라 다음 쓰기에 따라잡는다. */
function flushSync() {
  if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
  if (!indexDirty || !index) return;
  indexDirty = false;
  try { writeJsonAtomic(indexFile(), index, { dirMode: 0o700 }); } catch (e) {
    console.error('[conv] 색인 쓰기 실패:', e && e.message);
  }
}

function getThread(id) {
  const t = loadIndex().threads[String(id || '')];
  return t || null;
}

function listThreads() { return Object.values(loadIndex().threads); }

function putThread(thread) {
  assertId(thread && thread.id);
  const fresh = !loadIndex().threads[thread.id];
  index.threads[thread.id] = thread;
  scheduleIndexFlush();
  // 새 thread 는 바로 쓴다 — 색인에 오르기 전에 죽으면 로그만 남아 대화가 목록에서 사라진다.
  if (fresh) flushSync();
  return thread;
}

/** 얕은 병합 — 바뀐 필드가 하나라도 있으면 true. */
function patchThread(id, patch) {
  const t = getThread(id);
  if (!t) return false;
  let changed = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    const same = (v && typeof v === 'object') ? JSON.stringify(t[k]) === JSON.stringify(v) : t[k] === v;
    if (same) continue;
    t[k] = v;
    changed = true;
  }
  if (changed) scheduleIndexFlush();
  return changed;
}

function removeThread(id) {
  const sid = assertId(id);
  const had = !!loadIndex().threads[sid];
  delete index.threads[sid];
  cache.delete(sid);
  try { fs.unlinkSync(logFile(sid)); } catch (_) { /* 로그가 없던 thread */ }
  if (had) scheduleIndexFlush();
  return had;
}

// ── 로그 ─────────────────────────────────────────────────────────────────────
// upsert 키 — msg 와 req 의 이름공간을 나눈다(도구 id 와 요청 id 가 우연히 같아도 서로를 덮지 않게).
function keyOf(ev) {
  if (!ev) return null;
  if (ev.op === 'msg' && ev.msg && ev.msg.key) return 'm:' + ev.msg.key;
  if (ev.op === 'req' && ev.req && ev.req.id) return 'q:' + ev.req.id;
  return null;
}

function evict() {
  if (cache.size <= CACHE_MAX) return;
  const rows = [...cache.entries()].sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of rows) {
    if (cache.size <= CACHE_MAX) break;
    let pinned = false;
    try { pinned = !!pinnedFn(id); } catch (_) { pinned = false; }
    if (!pinned) cache.delete(id);
  }
}

function load(id) {
  const sid = assertId(id);
  let c = cache.get(sid);
  if (c) { c.touched = nowFn(); return c; }
  c = { events: [], headSeq: 0, latest: new Map(), first: new Map(), uuids: new Set(), touched: nowFn() };
  let raw = '';
  try { raw = fs.readFileSync(logFile(sid), 'utf8'); } catch (_) { raw = ''; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch (_) { continue; } // 쓰다 죽은 반쪽 줄
    if (!ev || !Number.isInteger(ev.seq) || ev.seq <= c.headSeq) continue; // seq 가 뒤로 가는 줄은 버린다(단조 보장)
    note(c, ev);
  }
  cache.set(sid, c);
  evict();
  return c;
}

function note(c, ev) {
  c.events.push(ev);
  c.headSeq = ev.seq;
  const k = keyOf(ev);
  if (k) {
    if (!c.first.has(k)) c.first.set(k, ev.seq);
    c.latest.set(k, ev.seq);
  }
  if (ev.uuid) c.uuids.add(ev.uuid);
}

/**
 * appendMany(id, evs) — seq/ts 를 붙여 한 번에 덧붙인다. 돌려주는 값이 곧 push 프레임의 events 다.
 *  디스크 쓰기가 실패해도 메모리에는 반영한다(라이브 전달이 먼저 — 다음 기동에 그 구간만 비어 보인다).
 */
function appendMany(id, evs) {
  const sid = assertId(id);
  const list = (Array.isArray(evs) ? evs : [evs]).filter(Boolean);
  if (!list.length) return [];
  const c = load(sid);
  const out = [];
  const now = nowFn();
  for (const src of list) {
    const seq = c.headSeq + 1;
    const ev = { seq, ts: src.ts || now, ...src };
    ev.seq = seq;
    const k = keyOf(ev);
    const first = k ? c.first.get(k) : undefined;
    if (first !== undefined) ev.first = first; else delete ev.first;
    if (ev.op === 'msg' && ev.msg) ev.msg = { ...ev.msg, seq };
    note(c, ev);
    out.push(ev);
  }
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile(sid), out.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('[conv] 로그 쓰기 실패:', e && e.message);
  }
  const t = getThread(sid);
  if (t) { t.headSeq = c.headSeq; t.lastAt = now; scheduleIndexFlush(); }
  return out;
}

function append(id, ev) { return appendMany(id, [ev])[0] || null; }

function headSeq(id) { return load(id).headSeq; }

/** 그 key 의 최신 이벤트(없으면 null). kind = 'msg' | 'req'. */
function latestOf(id, kind, key) {
  const c = load(id);
  const seq = c.latest.get((kind === 'req' ? 'q:' : 'm:') + String(key));
  if (seq === undefined) return null;
  return c.events[indexOfSeq(c, seq)] || null;
}

function hasUuid(id, uuid) { return !!uuid && load(id).uuids.has(uuid); }

/** 그 접두사로 시작하는 msg key 수 — 가져오기가 assistant 블록 인덱스를 이어 셀 때 쓴다. */
function countKeys(id, prefix) {
  const want = 'm:' + String(prefix);
  let n = 0;
  for (const k of load(id).first.keys()) if (k.startsWith(want)) n++;
  return n;
}

// seq → 배열 위치. 보통 seq-1 이지만 깨진 줄을 건너뛴 로그는 구멍이 있다 → 이분 탐색으로 보정.
function indexOfSeq(c, seq) {
  const guess = seq - 1;
  if (c.events[guess] && c.events[guess].seq === seq) return guess;
  let lo = 0; let hi = c.events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = c.events[mid].seq;
    if (s === seq) return mid;
    if (s < seq) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// seq 이하(le) 또는 미만인 마지막 위치.
function lastIndexBelow(c, seq) {
  let lo = 0; let hi = c.events.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.events[mid].seq < seq) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function superseded(c, ev) {
  const k = keyOf(ev);
  return !!k && c.latest.get(k) !== ev.seq;
}

const sizeOf = (ev) => Buffer.byteLength(JSON.stringify(ev), 'utf8');

/**
 * 뒤에서부터 접은 페이지 — fromIdx 에서 거꾸로 limit 개(예산 안에서). floorSeq 는 "이 아래로 더 있나" 의 표지다:
 *  더 없으면 1, 있으면 돌려준 첫 이벤트의 seq. 클라는 floorSeq > 1 일 때만 conv.before 를 부른다.
 */
function pageBack(c, fromIdx, limit) {
  const picked = [];
  let bytes = 0;
  let i = fromIdx;
  for (; i >= 0; i--) {
    const ev = c.events[i];
    if (superseded(c, ev)) continue;
    const n = sizeOf(ev);
    if (picked.length && (picked.length >= limit || bytes + n > FRAME_BUDGET)) break;
    picked.push(ev);
    bytes += n;
  }
  let more = false;
  for (; i >= 0; i--) { if (!superseded(c, c.events[i])) { more = true; break; } }
  picked.reverse();
  return { events: picked, floorSeq: more && picked.length ? picked[0].seq : 1 };
}

function clampLimit(v) {
  const n = Number.isInteger(v) && v > 0 ? v : PAGE_DEFAULT;
  return Math.min(n, PAGE_MAX);
}

/** 스냅샷 꼬리 — { events, headSeq, floorSeq }. */
function open(id, { limit } = {}) {
  const c = load(id);
  const r = pageBack(c, c.events.length - 1, clampLimit(limit));
  return { events: r.events, headSeq: c.headSeq, floorSeq: r.floorSeq };
}

/** beforeSeq 미만의 접은 페이지 — { events, floorSeq }. */
function before(id, { beforeSeq, limit } = {}) {
  const c = load(id);
  const b = Number.isInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : c.headSeq + 1;
  return pageBack(c, lastIndexBelow(c, b), clampLimit(limit));
}

/**
 * sinceSeq 초과분 — { events, headSeq, more, reset? }.
 *  · 구간 안에서만 접는다(구간 밖의 더 뒤 줄로 접으면 more 로 이어받는 클라가 그 key 를 한동안 못 본다).
 *  · 마지막 이벤트는 절대 접히지 않으므로(자기보다 뒤가 구간에 없다) 클라는 그 seq 부터 이어받으면 된다.
 *  · sinceSeq 가 우리 head 보다 크다 = 클라가 아는 로그가 우리 것이 아니다(삭제 후 재생성 등) → reset.
 */
function since(id, sinceSeq, { limit } = {}) {
  const c = load(id);
  const s = Number.isInteger(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
  if (s > c.headSeq) {
    const snap = open(id, { limit });
    return { ...snap, more: false, reset: true };
  }
  const max = clampLimit(limit == null ? PAGE_MAX : limit);
  const start = lastIndexBelow(c, s + 1) + 1;
  const range = [];
  let bytes = 0;
  for (let i = start; i < c.events.length; i++) {
    const ev = c.events[i];
    const n = sizeOf(ev);
    if (range.length && (range.length >= max || bytes + n > FRAME_BUDGET)) break;
    range.push(ev);
    bytes += n;
  }
  const last = new Map();
  for (const ev of range) { const k = keyOf(ev); if (k) last.set(k, ev.seq); }
  const events = range.filter((ev) => { const k = keyOf(ev); return !k || last.get(k) === ev.seq; });
  const cut = range.length ? range[range.length - 1].seq : s;
  return { events, headSeq: c.headSeq, more: cut < c.headSeq };
}

/** 열린 턴·대기 요청 — 데몬이 비정상 종료한 뒤 남은 미결을 conv.js 가 닫을 때 쓴다. */
function dangling(id) {
  const c = load(id);
  let openTurn = null;
  for (let i = c.events.length - 1; i >= 0; i--) {
    const ev = c.events[i];
    if (ev.op !== 'turn') continue;
    if (ev.phase === 'start') openTurn = ev.turn;
    break;
  }
  const reqs = [];
  const queued = [];
  for (const [k, seq] of c.latest) {
    const ev = c.events[indexOfSeq(c, seq)];
    if (!ev) continue;
    if (k.startsWith('q:') && ev.req && ev.req.status === 'pending') reqs.push(ev.req);
    if (k.startsWith('m:') && ev.msg && ev.msg.role === 'user' && ev.msg.status === 'queued') queued.push(ev);
  }
  return { openTurn, reqs, queued };
}

/** 30일 정리 — 무활동 thread(색인+로그)와 주인 없는 로그 파일. pinned(라이브)는 건드리지 않는다. */
function prune() {
  const now = nowFn();
  let n = 0;
  for (const t of listThreads()) {
    if (!t || !t.id) continue;
    let pinned = false;
    try { pinned = !!pinnedFn(t.id); } catch (_) { pinned = false; }
    if (pinned) continue;
    if (now - (t.lastAt || t.createdAt || 0) <= RETAIN_MS) continue;
    try { removeThread(t.id); n++; } catch (_) { /* 다음 기회 */ }
  }
  let names = [];
  try { names = fs.readdirSync(dir()); } catch (_) { names = []; }
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (loadIndex().threads[id]) continue;
    const full = path.join(dir(), f);
    try { if (now - fs.statSync(full).mtimeMs > RETAIN_MS) { fs.unlinkSync(full); n++; } } catch (_) { /* noop */ }
  }
  return { pruned: n };
}

function _reset() {
  if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
  index = null;
  indexDirty = false;
  cache.clear();
  nowFn = () => Date.now();
  pinnedFn = () => false;
}

module.exports = {
  configure, dir, logFile,
  getThread, listThreads, putThread, patchThread, removeThread, flushSync,
  append, appendMany, headSeq, latestOf, hasUuid, countKeys,
  open, before, since, dangling, prune, keyOf,
  RETAIN_MS, FRAME_BUDGET, PAGE_DEFAULT, PAGE_MAX,
  _reset, _cache: cache,
};
