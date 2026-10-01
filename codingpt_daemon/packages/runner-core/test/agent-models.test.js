'use strict';
const test = require('node:test');
const assert = require('node:assert');
const am = require('../agent-models');

test('launchArgs: claude 는 --model/--effort, 값은 작은따옴표로 감싼다', () => {
  assert.deepStrictEqual(am.launchArgs('claude', { model: 'opus[1m]', effort: 'high' }), ['--model', "'opus[1m]'", '--effort', "'high'"]);
  assert.deepStrictEqual(am.launchArgs('claude', {}), []);
  assert.deepStrictEqual(am.launchArgs('claude', { model: '', effort: null }), []);
});

test('launchArgs: codex 는 -m 과 -c model_reasoning_effort', () => {
  assert.deepStrictEqual(am.launchArgs('codex', { model: 'gpt-5.5', effort: 'xhigh' }), ['-m', "'gpt-5.5'", '-c', `'model_reasoning_effort="xhigh"'`]);
});

test('launchArgs: 셸 메타문자가 든 값은 통째로 무시(주입 방지)', () => {
  for (const bad of ["x'; rm -rf ~ #", 'a b', '$(id)', 'a;b', '`id`', '']) {
    assert.deepStrictEqual(am.launchArgs('claude', { model: bad, effort: bad }), []);
  }
  assert.strictEqual(am.valid("x'y"), false);
  assert.strictEqual(am.valid(null), true);
  assert.strictEqual(am.valid('opus'), true);
});

test('headlessArgs: 셸을 안 거치므로 따옴표 없이', () => {
  assert.deepStrictEqual(am.headlessArgs('codex', { model: 'gpt-5.5', effort: 'high' }), ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.deepStrictEqual(am.headlessArgs('claude', { model: 'sonnet' }), ['--model', 'sonnet']);
});

test('describe: 모르는 에이전트는 null', async () => {
  assert.strictEqual(await am.describe('gemini', null), null);
});
