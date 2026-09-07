// compat-check 판정 회귀 — "PC 를 올렸는데 앱이 못 따라오는" 상태를 정말 잡는지 고정한다.
//  실행: node --test scripts/test/compat-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { evaluate, cmpVersion } from '../compat-check.mjs';

const manifest = { pc: '0.1.326', minApp: { android: '0.4.1', ios: '0.4.1' } };
const okLive = {
  android: { version: '0.4.1', minVersion: '0.4.1' },
  ios: { version: '0.4.1', minVersion: '0.4.1' },
};
const fatalOf = (r) => r.problems.filter((p) => p.level === 'fatal');

test('버전 비교', () => {
  assert.strictEqual(cmpVersion('0.4.1', '0.4.0'), 1);
  assert.strictEqual(cmpVersion('0.4.0', '0.4.1'), -1);
  assert.strictEqual(cmpVersion('0.4.1', '0.4.1'), 0);
  assert.strictEqual(cmpVersion('0.10.0', '0.9.9'), 1); // 문자열 비교였다면 뒤집힌다
  assert.strictEqual(cmpVersion('', '0.0.0'), 0);
});

test('하한이 선언·게시·전파까지 다 맞으면 통과', () => {
  const r = evaluate(manifest, okLive);
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});

test('★ 스토어 게시본이 하한보다 낮으면 치명 — 사용자가 고칠 방법이 없는 상태다', () => {
  const live = { ...okLive, ios: { version: '0.4.0', minVersion: '0.4.1' } };
  const r = evaluate(manifest, live);
  assert.strictEqual(r.ok, false);
  const ios = fatalOf(r).filter((p) => p.platform === 'ios');
  assert.strictEqual(ios.length, 1, '한 원인에 두 개를 쌓지 않는다');
  assert.match(ios[0].message, /고칠 방법이 없다/);
  assert.match(ios[0].fix, /APP_MIN_IOS 는 비워 둔다/);
});

test('게시가 안 된 동안 APP_MIN 을 비워 둔 것은 "추가 잘못" 이 아니다 — 원인 하나만 보고한다', () => {
  // 받을 수 없는 버전을 강제하면 끌 수 없는 안내만 남는다. 그래서 게시 갭이 있으면 그것만 지적한다.
  const live = { ...okLive, ios: { version: '0.4.0' } };
  const r = evaluate(manifest, live);
  assert.strictEqual(fatalOf(r).filter((p) => p.platform === 'ios').length, 1);
});

test('★ APP_MIN_* 가 비어 있으면 치명 — 구버전 앱에 강제 안내가 안 뜬다(이번 사고의 그 상태)', () => {
  const live = { android: { version: '0.4.1' }, ios: { version: '0.4.1' } };
  const r = evaluate(manifest, live);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fatalOf(r).length, 2, '두 플랫폼 모두 잡아야 한다');
  for (const f of fatalOf(r)) assert.match(f.fix, /APP_MIN_(ANDROID|IOS)=0\.4\.1/);
});

test('하한이 어긋나게 설정된 것도 잡는다(오타·이전 값 잔존)', () => {
  const live = { ...okLive, android: { version: '0.4.1', minVersion: '0.4.0' } };
  const r = evaluate(manifest, live);
  assert.strictEqual(r.ok, false);
  assert.ok(fatalOf(r).some((p) => p.platform === 'android' && /minVersion\(0\.4\.0\)/.test(p.message)));
});

test('스토어 조회 실패는 경고로만 — 네트워크 한 번 끊겼다고 배포를 막지 않는다', () => {
  const live = { ...okLive, ios: { minVersion: '0.4.1' } };
  const r = evaluate(manifest, live);
  assert.strictEqual(r.ok, true);
  assert.ok(r.problems.some((p) => p.level === 'warn' && /스토어 버전을 못 읽었다/.test(p.message)));
});

test('하한을 선언하지 않으면 경고 — 검증이 조용히 무의미해지는 걸 막는다', () => {
  const r = evaluate({ pc: '0.1.326', minApp: {} }, okLive);
  assert.ok(r.problems.some((p) => /minApp\.android 가 없다/.test(p.message)));
});

test('리포의 compat.json 이 실제로 읽히고 두 플랫폼 하한을 갖는다', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const m = JSON.parse(fs.readFileSync(path.join(root, 'compat.json'), 'utf8'));
  assert.match(m.minApp.android, /^\d+\.\d+\.\d+$/);
  assert.match(m.minApp.ios, /^\d+\.\d+\.\d+$/);
  assert.match(m.pc, /^\d+\.\d+\.\d+$/);
});
