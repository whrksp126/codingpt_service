/**
 * term-backend(유일 진입점) e2e — mac 유닉스 소켓 폴백으로 실제 term-host 프로세스를
 * detached 스폰(win32 데몬과 같은 경로)해 클라이언트 API 전체를 왕복 검증한다.
 *
 *  · 호스트 미기동 → 자동 스폰 → 재시도 접속(win32 최초 기동 경로와 동일 코드)
 *  · op 1:1 API(create/list/has/sendKeys/capture/resize/env/rename/info/kill)
 *  · attach 미러 + latest-wins + killServer 로 정리
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

// env 는 require 전에 굳힌다 — term-backend.pipePath 가 이 값을 읽는다(비-win32 개발 경로 활성).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-termbackend-test-'));
process.env.CPT_TERMHOST_SOCK = path.join(tmp, 'backend.sock');
process.env.CODINGPT_STATE_DIR = tmp;

const { test, after } = require('node:test');
const assert = require('node:assert');
const backend = require('../term-backend');

// 테스트 셸 — posix 는 /bin/cat(에코·라인킬 의미론이 결정적), win32 CI 는 cmd.exe(ConPTY 에코만 검증).
const IS_WIN = process.platform === 'win32';
const CAT = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/cat';
const NAME = 'cpt-backend--t-7000007';

async function until(fn, ms = 8000, label = '조건') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

after(async () => {
  // 스폰된 상주 호스트 정리 — killServer 가 정규 경로, 실패 시 좀비 방지는 소켓 프로브로 확인만.
  try { await backend.killServer(); } catch (_) { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

test('활성 판정 — env 오버라이드로 비-win32 에서도 파이프 백엔드', () => {
  assert.strictEqual(backend.isHostBackend(), true);
  if (process.platform === 'win32') {
    // win32: 파일 경로 스타일 오버라이드는 파이프 이름으로 정규화된다(net.listen 제약) —
    //  클라이언트(term-backend)와 호스트(term-host paths)가 같은 규칙이어야 유령 호스트가 없다.
    const hostPaths = require('../../term-host/lib/paths');
    assert.match(backend.pipePath(), /^\\\\\.\\pipe\\cpt-termhost-test-[0-9a-f]{8}$/);
    assert.strictEqual(backend.pipePath(), hostPaths.pipePath(), '클라/호스트 파이프 규칙 불일치');
  } else {
    assert.strictEqual(backend.pipePath(), process.env.CPT_TERMHOST_SOCK);
  }
  assert.ok(backend.hostEntry() && fs.existsSync(backend.hostEntry()), 'term-host 엔트리 해석');
});

test('자동 스폰 — 호스트 미기동에서 첫 op 가 detached 스폰 후 접속', async () => {
  const sessions = await backend.list(); // 이 호출이 스폰을 유발한다
  assert.deepStrictEqual(sessions, []);
});

test('create → list/has — tmux 세션명 관례 그대로', async () => {
  const meta = await backend.create({ name: NAME, cwd: tmp, shell: CAT, cols: 70, rows: 18, env: { CPT_WS: 'backend' } });
  assert.strictEqual(meta.name, NAME);
  assert.ok(meta.panePid > 0);
  assert.strictEqual((await backend.list()).length, 1);
  assert.strictEqual(await backend.has(NAME), true);
  assert.strictEqual(await backend.has('cpt-없음--t-1'), false);
});

test('sendKeys/capture — 데이터·키 표기 두 경로 모두', async () => {
  await backend.sendKeys(NAME, { data: 'ping-pong\r' });
  await until(async () => (await backend.capture(NAME)).includes('ping-pong') ? true : null, 8000, '셸 에코');
  if (IS_WIN) {
    // cmd.exe 는 C-u 라인킬 의미론이 없다 — 키 표기(literal)·Enter 경로만 검증.
    await backend.sendKeys(NAME, { keys: ['win-keys'], literal: true });
    await backend.sendKeys(NAME, { keys: ['Enter'] });
    await until(async () => (await backend.capture(NAME)).includes('win-keys') ? true : null, 8000, '키 표기 에코');
  } else {
    await backend.sendKeys(NAME, { keys: ['zzz'], literal: true });
    await backend.sendKeys(NAME, { keys: ['C-u'] });          // 라인 삭제(잔여 청소 실사용 패턴)
    await backend.sendKeys(NAME, { keys: ['ok'], literal: true });
    await backend.sendKeys(NAME, { keys: ['Enter'] });
    await until(async () => {
      const t = await backend.capture(NAME);
      return t.includes('ok') && !t.includes('zzzok') ? true : null;
    }, 8000, 'C-u 로 zzz 삭제 후 ok 제출');
  }
  const esc = await backend.capture(NAME, { escapes: true });
  assert.ok(typeof esc === 'string' && esc.includes('ping-pong'));
});

test('env/rename/info — 메타 왕복', async () => {
  await backend.setEnv(NAME, 'CPT_TID', '7000007');
  assert.strictEqual(await backend.getEnv(NAME, 'CPT_TID'), '7000007');
  assert.strictEqual(await backend.getEnv(NAME, 'CPT_WS'), 'backend');
  await backend.rename(NAME, '백엔드 검증');
  const info = await backend.info(NAME);
  assert.strictEqual(info.windowName, '백엔드 검증');
  assert.ok(info.cursor && Number.isFinite(info.cursor.x));
});

test('attach 미러 + latest-wins 리사이즈', async () => {
  let outA = '';
  let outB = '';
  const a = await backend.attach(NAME, { cols: 100, rows: 30, onData: (b) => { outA += b.toString('utf8'); } });
  const b = await backend.attach(NAME, { cols: 80, rows: 24, onData: (bu) => { outB += bu.toString('utf8'); } });
  await until(() => outA.includes('ping-pong') && outB.includes('ping-pong') ? true : null, 8000, 'attach 리페인트 양쪽');
  a.write('both-see-this\r');
  await until(() => outA.includes('both-see-this') && outB.includes('both-see-this') ? true : null, 8000, '미러 브로드캐스트');
  // latest wins: b(80) 가 마지막 attach → a 의 resize 가 다시 이긴다.
  a.resize(132, 43);
  await until(async () => (await backend.info(NAME)).cols === 132 ? true : null, 6000, 'latest-wins 반영');
  a.close(); b.close();
});

test('kill 멱등 + killServer 로 호스트 종료', async () => {
  await backend.kill(NAME);
  assert.strictEqual(await backend.has(NAME), false);
  await backend.kill(NAME); // 멱등
  await backend.killServer();
  // 호스트 소켓이 실제로 닫혔는지 프로브(상주 프로세스 정리 확인) — win32 는 정규화된 파이프 경로.
  await until(() => new Promise((resolve) => {
    const probe = net.connect(backend.pipePath());
    probe.once('connect', () => { probe.destroy(); resolve(null); });
    probe.once('error', () => resolve(true));
  }), 6000, '호스트 종료');
});
