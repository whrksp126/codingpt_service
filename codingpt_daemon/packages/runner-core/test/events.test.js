'use strict';
// 이벤트 버스(events.js) — 자동화 번들 설계 §2.2. 발행은 즉시 반환·리스너는 setImmediate 로 분리·순서 유지·
//  리스너 예외 격리. 테스트 훅 _reset/flush.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const events = require('../events');

beforeEach(() => { events._reset(); events.configure({ log: () => {} }); });

test('emit 은 동기 반환하고 리스너는 다음 틱에 발행 순서대로 불린다', async () => {
  const seen = [];
  events.on('task.review_ready', (p) => seen.push(['a', p.task.id]));
  events.on('task.merged', (p) => seen.push(['b', p.task.id]));
  assert.strictEqual(events.emit('task.review_ready', { task: { id: 't1' } }), true);
  events.emit('task.merged', { task: { id: 't2' } });
  events.emit('task.review_ready', { task: { id: 't3' } });
  assert.deepStrictEqual(seen, [], '발행자의 스택에서 리스너가 돌지 않는다');
  await events.flush();
  assert.deepStrictEqual(seen, [['a', 't1'], ['b', 't2'], ['a', 't3']]);
});

test('리스너 예외·reject 는 삼키고 로그만 — 다른 리스너와 발행자는 무사', async () => {
  const logs = [];
  events.configure({ log: (m) => logs.push(m) });
  const seen = [];
  events.on('auto.fired', () => { throw new Error('boom'); });
  events.on('auto.fired', async () => { throw new Error('async boom'); });
  events.on('auto.fired', (p) => seen.push(p.firingId));
  assert.doesNotThrow(() => events.emit('auto.fired', { firingId: 'f_1' }));
  await events.flush();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, ['f_1']);
  assert.ok(logs.some((l) => /\[events\] listener error auto\.fired boom/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /async boom/.test(l)));
});

test('off 는 구독을 끊고, 받을 리스너가 없으면 emit 은 false(대기열에 쌓지 않는다)', async () => {
  const seen = [];
  const off = events.on('activity.changed', (p) => seen.push(p.active));
  off(); off();
  assert.strictEqual(events.emit('activity.changed', { active: true, reasons: [] }), false);
  assert.strictEqual(events.listenerCount('activity.changed'), 0);
  await events.flush();
  assert.deepStrictEqual(seen, []);
});

test('페이로드에 type 이 실리고 * 구독자는 전부 받는다', async () => {
  const all = [];
  events.on('*', (p, type) => all.push([type, p.type]));
  events.emit('pr.ci_failed', { task: { id: 't' } });
  events.emit('task.failed', { task: { id: 't' }, code: 'X' });
  await events.flush();
  assert.deepStrictEqual(all, [['pr.ci_failed', 'pr.ci_failed'], ['task.failed', 'task.failed']]);
});

test('리스너 안에서 발행한 이벤트도 뒤에 이어서 처리된다(순서 유지)', async () => {
  const seen = [];
  events.on('task.merged', () => { seen.push('merged'); events.emit('auto.fired', { firingId: 'f' }); });
  events.on('auto.fired', () => seen.push('fired'));
  events.on('task.failed', () => seen.push('failed'));
  events.emit('task.merged', {});
  events.emit('task.failed', {});
  await events.flush();
  assert.deepStrictEqual(seen, ['merged', 'failed', 'fired']);
});
