'use strict';
// template.js — 자동화 번들 설계 §5.4. 픽스처 template-01(치환·미정의·잘림) + 원본 20000B 초과 거부.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tpl = require('../template');

const FIX = require(path.join(__dirname, '..', '..', '..', 'docs', 'fixtures', 'automation', 'template-01.json'));

test('template-01 — 정확 치환·미정의 빈 문자열·비식별자 중괄호 보존·1회 치환', () => {
  for (const c of FIX.cases) {
    assert.deepStrictEqual(tpl.render(c.template, c.vars), c.expect, c.why);
  }
});

test('template-01 — 렌더 30000B 초과는 UTF-8 경계에서 자르고 표식', () => {
  const t = FIX.truncate;
  const r = tpl.render(t.template, { issue: { body: t.bodyUnit.repeat(t.bodyRepeat) } });
  assert.strictEqual(r.truncated, t.expect.truncated);
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= t.expect.maxBytes);
  assert.ok(r.text.endsWith(t.expect.suffix));
  assert.ok(!r.text.includes('�'), '멀티바이트 잔재 없음');
});

test('template-01 — 원본 20000B 초과는 AUTO_TEMPLATE_TOO_LARGE, 모르는 변수는 경고 목록', () => {
  assert.throws(() => tpl.check(FIX.tooLarge.unit.repeat(FIX.tooLarge.repeat), { field: 'prompt' }),
    (e) => e.code === FIX.tooLarge.code && /prompt/.test(e.message));
  assert.deepStrictEqual(tpl.check('a'.repeat(20000)), [], '정확히 20000B 는 허용');
  assert.deepStrictEqual(tpl.check(FIX.unknownVars.template), FIX.unknownVars.expect);
});

test('truncBytes — 짧으면 그대로, maxBytes 는 표식 포함 상한', () => {
  assert.deepStrictEqual(tpl.truncBytes('abc', 10), { text: 'abc', truncated: false });
  const r = tpl.truncBytes('x'.repeat(100), 20);
  assert.strictEqual(Buffer.byteLength(r.text), 20);
  assert.ok(r.truncated && r.text.endsWith(tpl.TRUNC_MARK));
});
