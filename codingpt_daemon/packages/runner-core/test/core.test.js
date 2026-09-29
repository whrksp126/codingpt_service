// 핵심 안전장치 테스트 — node 내장 러너(node --test), 외부 프레임워크 없음.
//  실행: node --test packages/runner-core/test/
//  대상: ① fs 홈 jail(safeResolve — 상대 탈출/심링크 탈출 거부) ② freshness git 판정.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const runtime = require('../runtime');

// 격리 루트 — 홈/실데이터 무접촉.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-test-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });
const { safeResolve } = require('../fs');

test('fs jail — 루트 안 경로는 허용', () => {
  fs.mkdirSync(path.join(ROOT, 'proj'), { recursive: true });
  assert.strictEqual(safeResolve('proj'), path.join(ROOT, 'proj'));
  assert.strictEqual(safeResolve(''), ROOT);
});

test('fs jail — ../ 상대경로 탈출 거부', () => {
  assert.throws(() => safeResolve('../outside'), /허용되지 않은 경로/);
  assert.throws(() => safeResolve('proj/../../etc'), /허용되지 않은 경로/);
});

// win32 스킵: symlinkSync 는 권한(SeCreateSymbolicLinkPrivilege) 의존 — CI 러너에서 비결정적 (windows-port 게이트)
test('fs jail — 심링크로 루트 밖 우회 거부', { skip: process.platform === 'win32' }, () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  const link = path.join(ROOT, 'esc');
  try { fs.symlinkSync(outside, link); } catch (_) { /* 이미 존재 */ }
  assert.throws(() => safeResolve('esc/secret.txt'), /허용되지 않은 경로/);
});

test('freshness.statusFor — dirty/ahead/upstream 판정', async (t) => {
  let gitOk = true;
  try { execFileSync('git', ['--version']); } catch (_) { gitOk = false; }
  if (!gitOk) return t.skip('git 없음');
  const { statusFor } = require('../freshness');

  const dir = path.join(ROOT, 'repo');
  const up = path.join(ROOT, 'up.git');
  fs.mkdirSync(dir, { recursive: true });
  const g = (args, cwd = dir) => execFileSync('git', args, { cwd });
  g(['init', '-q', '--bare', up], ROOT);
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  g(['add', '-A']); g(['commit', '-qm', 'c1']);
  g(['remote', 'add', 'origin', up]); g(['branch', '-M', 'main']); g(['push', '-qu', 'origin', 'main']);

  // 클린 상태
  let st = await statusFor(dir);
  assert.deepStrictEqual({ dirty: st.dirty, ahead: st.ahead, upstream: st.upstream, branch: st.branch },
    { dirty: false, ahead: 0, upstream: true, branch: 'main' });

  // 미푸시 1 + 미커밋 변경
  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  g(['add', '-A']); g(['commit', '-qm', 'c2']);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x');
  st = await statusFor(dir);
  assert.strictEqual(st.dirty, true);
  assert.strictEqual(st.ahead, 1);

  // git 저장소 아님 → null
  const plain = path.join(ROOT, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  assert.strictEqual(await statusFor(plain), null);
});
