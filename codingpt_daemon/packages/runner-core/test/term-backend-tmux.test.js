// term-backend darwin(tmux) 구현 등가성 — 격리 소켓의 **실 tmux** 로 op 전체를 왕복 검증한다.
//  웨이브2 재배선의 전제: 백엔드 op 가 종전 호출부의 tmux 서브커맨드와 같은 인자를 조립한다.
//  실행: node --test packages/runner-core/test/term-backend-tmux.test.js
//
// 안전: 반드시 CODINGPT_TMUX_SOCKET 격리 소켓을 강제한 뒤 require 한다 — 실사용 -L codingpt 무접촉.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOCK = `codingpt-tbx-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;
delete process.env.CPT_TERMHOST_SOCK; // 파이프 백엔드 오버라이드 무효화 — 이 테스트는 tmux 경로

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tbx-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const ptyLib = require('../pty');
const backend = require('../term-backend');
assert.strictEqual(ptyLib.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();
const skip = !hasTmux || process.platform === 'win32';

const NAME = 'cpt-tbx--t-1000042';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, label = '조건') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(80);
  }
}

after(async () => {
  try { await backend.killServer(); } catch (_) { /* noop */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

test('활성 판정 — 비-win32(env 오버라이드 없음)는 tmux 백엔드', { skip }, () => {
  assert.strictEqual(backend.isHostBackend(), false);
});

test('create — new-session -d -e(초기 env) + duplicate 에러 계약', { skip }, async () => {
  await backend.create({ name: NAME, cwd: ROOT, env: { CPT_WS: 'tbx-ws', CPT_TID: '1000042' } });
  assert.strictEqual(await backend.has(NAME), true);
  assert.strictEqual(await backend.has('cpt-tbx--t-9'), false);
  // 같은 이름 재생성 = duplicate(createTerminal 의 tid 충돌 재시도가 이 문구에 의존한다)
  await assert.rejects(() => backend.create({ name: NAME, cwd: ROOT }), /duplicate session/i);
});

test('list / listSessionNames — 세션당 1행 + 이름 목록', { skip }, async () => {
  const rows = await backend.list();
  const row = rows.find((r) => r.name === NAME);
  assert.ok(row, 'list 에 세션이 없다');
  assert.ok(typeof row.windowName === 'string');
  assert.ok(typeof row.command === 'string');
  assert.ok(row.createdAt > 0);
  const names = await backend.listSessionNames();
  assert.ok(names.includes(NAME));
});

test('create 초기 env — getEnv 로 회수(tmux show-environment 등가)', { skip }, async () => {
  assert.strictEqual(await backend.getEnv(NAME, 'CPT_WS'), 'tbx-ws');
  assert.strictEqual(await backend.getEnv(NAME, 'CPT_TID'), '1000042');
  assert.strictEqual(await backend.getEnv(NAME, 'CPT_NOPE'), null); // unknown variable → null
});

test('setEnv/getEnv — 세션 env 왕복(빈 값 포함)', { skip }, async () => {
  await backend.setEnv(NAME, 'TBX_KEY', 'v1');
  assert.strictEqual(await backend.getEnv(NAME, 'TBX_KEY'), 'v1');
  await backend.setEnv(NAME, 'TBX_EMPTY', '');
  assert.strictEqual(await backend.getEnv(NAME, 'TBX_EMPTY'), '');
});

test('sendKeys(data/keys/count) + capture(text·escapes·join·lines)', { skip }, async () => {
  await until(async () => (await backend.capture(NAME)).trim() ? true : null, 8000, '셸 프롬프트');
  await backend.sendKeys(NAME, { data: 'echo tbx-e' });
  await backend.sendKeys(NAME, { keys: ['cho'], literal: true }); // literal 키 이어붙이기
  await backend.sendKeys(NAME, { keys: ['Enter'] });
  await until(async () => (await backend.capture(NAME)).includes('tbx-echo') ? true : null, 8000, 'echo 실행');
  const esc = await backend.capture(NAME, { escapes: true });
  assert.ok(esc.includes('tbx-echo'), 'escapes 캡처에도 본문이 있어야 한다');
  const joined = await backend.capture(NAME, { join: true, lines: 50 });
  assert.ok(joined.includes('tbx-echo'));
  // count(-N): BSpace 반복 — 조작 자체가 성공해야 한다(clearComposerResidue 실사용 패턴)
  await backend.sendKeys(NAME, { keys: ['zz'], literal: true });
  await backend.sendKeys(NAME, { keys: ['BSpace'], count: 2 });
  await backend.sendKeys(NAME, { keys: ['C-u'] });
});

test('rename/info — 수동 이름 → windowName, 빈 값 = automatic-rename 복귀', { skip }, async () => {
  await backend.rename(NAME, '백엔드검증');
  await until(async () => (await backend.info(NAME)).windowName === '백엔드검증' ? true : null, 6000, 'rename 반영');
  const inf = await backend.info(NAME);
  assert.ok(inf.cols > 0 && inf.rows > 0);
  assert.ok(Number.isFinite(inf.cursor.x) && Number.isFinite(inf.cursor.y));
  assert.ok(inf.panePid > 0);
  assert.ok(typeof inf.command === 'string' && inf.command.length > 0);
  await backend.rename(NAME, ''); // 자동 복귀 — 에러 없이 수용(automatic-rename on)
});

test('respawn — 프로세스 교체 후에도 세션 유지 + setEnv 반영(주의점 3)', { skip }, async () => {
  await backend.setEnv(NAME, 'TBX_RESPAWN', 'yes');
  await backend.respawn(NAME, { cwd: ROOT });
  assert.strictEqual(await backend.has(NAME), true);
  // 새 셸이 세션 env 를 상속했는지 — 셸이 뜨길 기다렸다가 echo 로 확인.
  await until(async () => (await backend.capture(NAME)).trim() ? true : null, 8000, 'respawn 셸');
  await sleep(400); // 스폰 직후 시그널/입력 레이스(주의점 2) — 짧은 여유
  await backend.sendKeys(NAME, { data: 'echo R=$TBX_RESPAWN\r' });
  await until(async () => (await backend.capture(NAME)).includes('R=yes') ? true : null, 8000, 'respawn env 상속');
});

test('attach — node-pty tmux 클라이언트 핸들(write/resize/close)', { skip }, async () => {
  let out = '';
  const h = await backend.attach(NAME, {
    cols: 90, rows: 26, cwd: ROOT, setLatest: true,
    onData: (d) => { out += String(d); },
  });
  // 리페인트 = 현재 화면(respawn 뒤라 직전 테스트의 R=yes 가 보인다). 히스토리 전체가 아니다.
  await until(() => out.includes('R=yes') ? true : null, 8000, 'attach 리페인트(현재 화면)');
  h.write('echo att-live\r');
  await until(() => out.includes('att-live') ? true : null, 8000, 'attach 실시간 입출력');
  h.resize(100, 30);
  h.close();
});

test('kill — 멱등(없어도 성공) + list 에서 소멸', { skip }, async () => {
  await backend.kill(NAME);
  assert.strictEqual(await backend.has(NAME), false);
  await backend.kill(NAME); // 멱등
  await backend.kill('cpt-없는세션--t-1'); // 서버가 살아 있어도 없는 세션 = 성공
  const names = await backend.listSessionNames().catch(() => []);
  assert.ok(!names.includes(NAME));
});
