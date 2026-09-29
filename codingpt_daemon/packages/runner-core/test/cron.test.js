'use strict';
// cron.js — 자동화 번들 설계 §5.1·§5.2. 픽스처 docs/fixtures/automation/cron-01.json(tz 2종·DST 경계) +
//  최소 간격 거부·잘못된 필드 AUTO_BAD_TRIGGER·일회(at) 검증(automations.normalizeDraft 경유)·dayKey.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cron = require('../cron');

const FIX = require(path.join(__dirname, '..', '..', '..', 'docs', 'fixtures', 'automation', 'cron-01.json'));

test('cron-01 — 표현식 → 다음 5회(tz·DST 규칙 고정)', () => {
  for (const c of FIX.cases) {
    const got = cron.nextN(c.expr, Date.parse(c.fromIso), c.tz, 5).map((t) => new Date(t).toISOString());
    assert.deepStrictEqual(got, c.next, `${c.expr} (${c.tz}) — ${c.why}`);
  }
});

test('cron-01 — 잘못된 식·최소 간격 위반·시간대 오류는 AUTO_BAD_TRIGGER', () => {
  for (const x of FIX.invalid) {
    assert.throws(() => cron.validate(x.expr, x.tz, { minIntervalMs: FIX.minIntervalMs, now: Date.parse('2026-09-29T00:00:00Z') }),
      (e) => e.code === x.code, `${x.expr} — ${x.why}`);
  }
});

test('validate — 최소 간격 경계(정확히 15분)는 허용, nextRunAt 은 now 초과 첫 시각', () => {
  const now = Date.parse('2026-09-29T10:07:30Z');
  const v = cron.validate('*/15 * * * *', 'UTC', { minIntervalMs: 15 * 60 * 1000, now });
  assert.strictEqual(new Date(v.nextRunAt).toISOString(), '2026-09-29T10:15:00.000Z');
  assert.strictEqual(v.parsed.expr, '*/15 * * * *');
  // 공백이 여럿이어도 정규화된 식을 돌려준다
  assert.strictEqual(cron.parse('  0   9 * *  1-5 ').expr, '0 9 * * 1-5');
});

test('정확히 분 경계에서 부르면 그 분은 제외(초과)된다 — 같은 스케줄이 두 번 돌지 않게', () => {
  const t = Date.parse('2026-09-30T00:00:00Z'); // 서울 09:00
  const n = cron.next('0 9 * * *', t, 'Asia/Seoul');
  assert.strictEqual(new Date(n).toISOString(), '2026-10-01T00:00:00.000Z');
});

test('요일 7 = 일요일, dayKey 는 tz 기준 날짜', () => {
  const a = cron.nextN('0 10 * * 7', Date.parse('2026-09-29T00:00:00Z'), 'UTC', 2).map((x) => new Date(x).toISOString());
  const b = cron.nextN('0 10 * * 0', Date.parse('2026-09-29T00:00:00Z'), 'UTC', 2).map((x) => new Date(x).toISOString());
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, ['2026-10-04T10:00:00.000Z', '2026-10-11T10:00:00.000Z']);
  assert.strictEqual(cron.dayKey(Date.parse('2026-09-28T16:00:00Z'), 'Asia/Seoul'), '2026-09-29');
  assert.strictEqual(cron.dayKey(Date.parse('2026-09-28T16:00:00Z'), 'UTC'), '2026-09-28');
  assert.strictEqual(cron.validTz('Asia/Seoul'), true);
  assert.strictEqual(cron.validTz('Nope/Nope'), false);
});
