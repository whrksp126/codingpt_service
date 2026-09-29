'use strict';
// 채팅 v2 저장소(conv-store.js) — docs/chat-v2-design.md §2.
//  seq 단조·연속, key upsert 접기, since/before 경계, 응답 예산, 디스크 복원, 30일 정리.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-convstore-')));
const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: path.join(ROOT, '.claude') });
const store = require('../conv-store');

let n = 0;
function fresh() {
  const id = `t-${++n}-${Date.now()}`;
  store.putThread({ id, agent: 'claude', cwd: 'ws', title: '', createdAt: Date.now(), lastAt: Date.now(), state: 'stopped', headSeq: 0, pending: 0 });
  return id;
}
const msg = (key, text, more) => ({ op: 'msg', msg: { key, role: 'assistant', kind: 'text', text, truncated: false, hidden: false, ...(more || {}) } });

beforeEach(() => { store.flushSync(); });

test('seq — 1부터 단조·연속, msg 안의 seq 도 같은 값', () => {
  const id = fresh();
  const a = store.append(id, { op: 'turn', phase: 'start', turn: 1 });
  const many = store.appendMany(id, [msg('m1:0', 'a'), msg('m1:1', 'b'), { op: 'notice', level: 'info', code: 'X', text: 'x' }]);
  assert.strictEqual(a.seq, 1);
  assert.deepStrictEqual(many.map((e) => e.seq), [2, 3, 4]);
  assert.strictEqual(many[0].msg.seq, 2);
  assert.strictEqual(store.headSeq(id), 4);
  assert.ok(many.every((e) => Number.isFinite(e.ts)));
  assert.strictEqual(store.getThread(id).headSeq, 4, '색인의 headSeq 도 따라온다');
});

test('upsert — 같은 key 의 뒤 이벤트가 앞을 대체하고 first 에 첫 seq 가 실린다', () => {
  const id = fresh();
  store.append(id, msg('u:c1', '안녕', { role: 'user', status: 'queued' }));   // 1
  store.append(id, msg('m1:0', '답'));                                           // 2
  const up = store.append(id, msg('u:c1', '안녕', { role: 'user', status: 'sent' })); // 3
  assert.strictEqual(up.first, 1);
  const snap = store.open(id);
  assert.deepStrictEqual(snap.events.map((e) => e.seq), [2, 3], '접힌 스냅샷은 로그의 부분열(seq 오름차순)');
  assert.strictEqual(snap.events[1].msg.status, 'sent');
  assert.strictEqual(snap.headSeq, 3);
  assert.strictEqual(snap.floorSeq, 1);
  assert.strictEqual(store.latestOf(id, 'msg', 'u:c1').seq, 3);
  assert.strictEqual(store.latestOf(id, 'msg', 'nope'), null);
});

test('msg 와 req 는 이름공간이 다르다 — 같은 문자열이어도 서로를 덮지 않는다', () => {
  const id = fresh();
  store.append(id, msg('same', 'm'));
  store.append(id, { op: 'req', req: { id: 'same', kind: 'permission', status: 'pending' } });
  assert.strictEqual(store.open(id).events.length, 2);
  store.append(id, { op: 'req', req: { id: 'same', kind: 'permission', status: 'allowed' } });
  const snap = store.open(id);
  assert.deepStrictEqual(snap.events.map((e) => e.op), ['msg', 'req']);
  assert.strictEqual(snap.events[1].req.status, 'allowed');
});

test('open/before — limit 경계와 floorSeq(더 없으면 1)', () => {
  const id = fresh();
  for (let i = 1; i <= 10; i++) store.append(id, msg('k' + i, 'v' + i));
  const tail = store.open(id, { limit: 4 });
  assert.deepStrictEqual(tail.events.map((e) => e.seq), [7, 8, 9, 10]);
  assert.strictEqual(tail.floorSeq, 7);
  const p2 = store.before(id, { beforeSeq: tail.floorSeq, limit: 4 });
  assert.deepStrictEqual(p2.events.map((e) => e.seq), [3, 4, 5, 6]);
  assert.strictEqual(p2.floorSeq, 3);
  const p3 = store.before(id, { beforeSeq: p2.floorSeq, limit: 4 });
  assert.deepStrictEqual(p3.events.map((e) => e.seq), [1, 2]);
  assert.strictEqual(p3.floorSeq, 1, '처음에 닿았다');
  const p4 = store.before(id, { beforeSeq: 1, limit: 4 });
  assert.deepStrictEqual(p4.events, []);
  assert.strictEqual(p4.floorSeq, 1);
});

test('before — 새 페이지에 있는 key 의 옛 판은 과거 페이지에도 나오지 않는다', () => {
  const id = fresh();
  store.append(id, msg('a', 'old'));      // 1 (나중에 대체됨)
  store.append(id, msg('b', 'keep'));     // 2
  store.append(id, msg('c', 'keep'));     // 3
  store.append(id, msg('a', 'new'));      // 4
  const tail = store.open(id, { limit: 1 });
  assert.deepStrictEqual(tail.events.map((e) => e.seq), [4]);
  const older = store.before(id, { beforeSeq: 4, limit: 10 });
  assert.deepStrictEqual(older.events.map((e) => e.seq), [2, 3]);
  assert.strictEqual(older.floorSeq, 1);
});

test('since — 초과분만, 구간 안에서 접고, 앞선 클라는 reset', () => {
  const id = fresh();
  store.append(id, msg('a', '1'));   // 1
  store.append(id, msg('b', '1'));   // 2
  store.append(id, msg('a', '2'));   // 3
  store.append(id, msg('b', '2'));   // 4
  assert.deepStrictEqual(store.since(id, 4).events, []);
  assert.strictEqual(store.since(id, 4).more, false);
  assert.deepStrictEqual(store.since(id, 2).events.map((e) => e.seq), [3, 4]);
  assert.deepStrictEqual(store.since(id, 0).events.map((e) => e.seq), [3, 4], '구간 안에서 대체된 1·2 는 빠진다');
  assert.strictEqual(store.since(id, 0).headSeq, 4);
  const r = store.since(id, 99);
  assert.strictEqual(r.reset, true);
  assert.deepStrictEqual(r.events.map((e) => e.seq), [3, 4]);
});

test('since — limit 로 끊기면 more, 마지막 이벤트의 seq 부터 이어받으면 빠짐이 없다', () => {
  const id = fresh();
  for (let i = 1; i <= 7; i++) store.append(id, msg('k' + (i % 3), 'v' + i));
  const seen = [];
  let cur = 0;
  for (let guard = 0; guard < 10; guard++) {
    const r = store.since(id, cur, { limit: 3 });
    for (const e of r.events) seen.push(e.seq);
    if (!r.events.length) break;
    cur = r.events[r.events.length - 1].seq;
    if (!r.more) break;
  }
  assert.strictEqual(cur, 7);
  // 각 key 의 최신판(5,6,7)은 반드시 들어 있다.
  for (const s of [5, 6, 7]) assert.ok(seen.includes(s), `seq ${s}`);
});

test('응답 예산 — 큰 본문은 512KB 안에서 개수를 줄이고 floorSeq/more 로 이어받는다', () => {
  const id = fresh();
  const big = 'x'.repeat(60 * 1024);
  for (let i = 1; i <= 20; i++) store.append(id, msg('k' + i, big));
  const snap = store.open(id, { limit: 200 });
  const bytes = Buffer.byteLength(JSON.stringify(snap.events));
  assert.ok(bytes <= store.FRAME_BUDGET + 1024, `예산 초과 ${bytes}`);
  assert.ok(snap.events.length < 20 && snap.events.length >= 1);
  assert.strictEqual(snap.events[snap.events.length - 1].seq, 20);
  assert.strictEqual(snap.floorSeq, snap.events[0].seq);
  const s = store.since(id, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(s.events)) <= store.FRAME_BUDGET + 1024);
  assert.strictEqual(s.more, true);
  assert.strictEqual(s.events[0].seq, 1);
});

test('디스크 복원 — 캐시를 비워도 같은 스냅샷, 반쪽 줄은 건너뛴다', () => {
  const id = fresh();
  store.append(id, msg('a', '1'));
  store.append(id, msg('a', '2'));
  store.append(id, { op: 'turn', phase: 'start', turn: 1 });
  store.flushSync();
  fs.appendFileSync(store.logFile(id), '{"seq":4,"op":"msg","msg":{"key":"x"'); // 쓰다 죽은 줄
  store._cache.clear();
  const snap = store.open(id);
  assert.deepStrictEqual(snap.events.map((e) => e.seq), [2, 3]);
  assert.strictEqual(snap.events[0].first, 1);
  const next = store.append(id, msg('b', '3'));
  assert.strictEqual(next.seq, 4, '복원한 head 에서 이어 센다');
  const st = fs.statSync(store.logFile(id));
  assert.strictEqual(st.mode & 0o777, 0o600);
});

test('색인 재적재 — 진행 상태는 stopped 로, 오류는 그대로', () => {
  const a = fresh(); const b = fresh();
  store.patchThread(a, { state: 'working', pending: 2 });
  store.patchThread(b, { state: 'error' });
  store.flushSync();
  store._reset();
  assert.strictEqual(store.getThread(a).state, 'stopped');
  assert.strictEqual(store.getThread(a).pending, 0);
  assert.strictEqual(store.getThread(b).state, 'error');
});

test('dangling — 열린 턴·대기 요청·미도달 메시지를 찾는다', () => {
  const id = fresh();
  store.append(id, { op: 'turn', phase: 'start', turn: 1 });
  store.append(id, { op: 'turn', phase: 'end', turn: 1, ok: true });
  store.append(id, { op: 'turn', phase: 'start', turn: 2 });
  store.append(id, msg('u:c9', 'hi', { role: 'user', status: 'queued' }));
  store.append(id, { op: 'req', req: { id: 'req_1', status: 'pending' } });
  store.append(id, { op: 'req', req: { id: 'req_2', status: 'pending' } });
  store.append(id, { op: 'req', req: { id: 'req_2', status: 'allowed' } });
  const d = store.dangling(id);
  assert.strictEqual(d.openTurn, 2);
  assert.deepStrictEqual(d.reqs.map((r) => r.id), ['req_1']);
  assert.deepStrictEqual(d.queued.map((e) => e.msg.key), ['u:c9']);
});

test('uuid·key 셈 — 가져오기의 중복 판정 재료', () => {
  const id = fresh();
  store.append(id, { ...msg('msg_1:0', 'a'), uuid: 'u-1' });
  store.append(id, { ...msg('msg_1:1', 'b'), uuid: 'u-2' });
  store.append(id, { ...msg('toolu_1', 'c'), uuid: 'u-3' });
  assert.ok(store.hasUuid(id, 'u-2'));
  assert.ok(!store.hasUuid(id, 'u-9'));
  assert.strictEqual(store.countKeys(id, 'msg_1:'), 2);
  store._cache.clear();
  assert.ok(store.hasUuid(id, 'u-3'), '디스크에서 다시 읽어도 안다');
});

test('30일 정리 — 무활동 thread 와 주인 없는 로그만 지운다(pinned 는 보존)', () => {
  const old = fresh(); const pinned = fresh(); const recent = fresh();
  for (const id of [old, pinned, recent]) store.append(id, msg('a', '1'));
  const past = Date.now() - store.RETAIN_MS - 1000;
  store.getThread(old).lastAt = past;
  store.getThread(pinned).lastAt = past;
  const orphan = path.join(store.dir(), 'orphan-1.jsonl');
  fs.writeFileSync(orphan, '{}\n');
  fs.utimesSync(orphan, new Date(past), new Date(past));
  store.configure({ pinned: (id) => id === pinned });
  const r = store.prune();
  store.configure({ pinned: () => false });
  assert.ok(r.pruned >= 2);
  assert.strictEqual(store.getThread(old), null);
  assert.ok(!fs.existsSync(store.logFile(old)));
  assert.ok(store.getThread(pinned));
  assert.ok(store.getThread(recent));
  assert.ok(!fs.existsSync(orphan));
});

test('removeThread — 색인과 로그를 함께 지운다', () => {
  const id = fresh();
  store.append(id, msg('a', '1'));
  assert.strictEqual(store.removeThread(id), true);
  assert.strictEqual(store.getThread(id), null);
  assert.ok(!fs.existsSync(store.logFile(id)));
  assert.strictEqual(store.removeThread(id), false);
});

test('thread id 검증 — 경로 문자를 받지 않는다', () => {
  assert.throws(() => store.logFile('../x'), (e) => e.code === 'BAD_REQUEST');
  assert.throws(() => store.putThread({ id: 'a/b' }), (e) => e.code === 'BAD_REQUEST');
});
