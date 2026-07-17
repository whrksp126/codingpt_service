// 핵심 순수 로직 테스트 — node 내장 러너(node --test), DB/objectstore 무접촉.
//  실행: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeRemote } = require('../services/workspaceService');
const { cmpVersion } = require('../services/pcReleaseService');

test('normalizeRemote — ssh/https/포트/.git 흡수해 동일 키', () => {
  assert.strictEqual(normalizeRemote('git@github.com:Foo/Bar.git'), normalizeRemote('https://github.com/Foo/Bar'));
  assert.strictEqual(normalizeRemote('ssh://git@host.com:2222/a/b.git'), 'host.com/a/b');
  assert.notStrictEqual(normalizeRemote('https://github.com/foo/bar'), normalizeRemote('https://github.com/foo/other'));
});

test('cmpVersion — semver 대소/동등', () => {
  assert.strictEqual(cmpVersion('0.2.0', '0.1.9'), 1);
  assert.strictEqual(cmpVersion('1.0.0', '1.0.0'), 0);
  assert.strictEqual(cmpVersion('0.9.0', '0.10.0'), -1); // 문자열 비교가 아님
  assert.strictEqual(cmpVersion('v1.2', '1.2.0'), 0);    // v 접두사·자릿수 관용
});
