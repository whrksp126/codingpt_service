// 로컬 UI 채널 라우팅 배타성 회귀 테스트 — node --test
//
// 배경: 터미널의 `cpt` → 로컬 데몬 → back WSS → **같은 기기의** PC 앱 왕복을 없애기 위해 cpt.sock 에
//  지속 연결(ui.attach)을 두고, 두 경우에만 로컬로 직결한다.
//   ① target 이 명시됐고 그 deviceId|clientKey 가 이 머신의 attach 클라이언트와 일치
//   ② back 제어 WS 가 없다(전에는 무조건 BACK_OFFLINE) → 로컬 화면이 있으면 그리로
//  그 외(target 미지정 + back 정상)는 **반드시 back** 이어야 한다 — executor 선정은 back 만 가진 전
//  기기 presence 로 하기 때문이다. 여기서 전면 단축이 생기면 "폰에서 보는 중인데 명령이 옆 PC 로 간다".
//
// 고정하는 계약:
//  A. target 미지정 + back OPEN  → back 으로 전송(로컬 클라이언트가 있어도).
//  B. target=이 머신          → 로컬로 전송(back 으로 아무것도 안 나간다).
//  C. back 없음 + 로컬 있음     → 로컬로 전송(BACK_OFFLINE 아님).
//  D. back 없음 + 로컬 없음     → BACK_OFFLINE(기존 동작 보존).
//  E. 로컬 채널 유실           → 대기 중 왕복이 매달리지 않고 즉시 실패.
//  F. 같은 명령이 두 경로로 동시에 가지 않는다(배타 분기).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-localui-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const cptServer = require('../cpt-server');
const LU = cptServer._localUi;

function fakeOpenWs() {
  return { readyState: 1, sent: [], send(s) { this.sent.push(s); } };
}
// cpt.sock 커넥션 대역 — write 로 나간 NDJSON 프레임을 모은다.
function fakeConn() {
  return { frames: [], write(s) { for (const l of String(s).split('\n')) if (l.trim()) this.frames.push(JSON.parse(l)); return true; } };
}
function attach(opts) {
  const conn = fakeConn();
  const c = LU.attach(conn, opts);
  return { c, conn };
}
function cleanup() {
  for (const c of [...LU.clients]) LU.detach(c);
  cptServer.setControlWs(null);
}

test('A. target 미지정 + back OPEN → back 경로(로컬 단축 금지)', async () => {
  cleanup();
  const ws = fakeOpenWs();
  cptServer.setControlWs(ws);
  const { conn } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc', foreground: true });

  const p = cptServer._sendUiCommand('ui.previewOpen', { url: 'x' }, { mode: 'broadcast', timeoutMs: 500 });
  assert.strictEqual(ws.sent.length, 1, 'back 으로 나가야 한다');
  assert.strictEqual(conn.frames.length, 0, '로컬로는 나가면 안 된다(executor 선정은 back 몫)');
  await assert.rejects(p, (e) => e.code === 'UI_TIMEOUT');
  cleanup();
});

test('B. target=이 머신 → 로컬 직결(back 미경유), deviceId·clientKey 둘 다 매칭', async () => {
  cleanup();
  const ws = fakeOpenWs();
  cptServer.setControlWs(ws);
  const { c, conn } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc', foreground: true });

  // deviceId 매칭
  const p1 = cptServer._sendUiCommand('ui.ideOpen', { path: 'a.ts' }, { mode: 'target', target: { deviceId: 7 }, timeoutMs: 2000 });
  assert.strictEqual(ws.sent.length, 0, 'back 으로 나가면 안 된다');
  assert.strictEqual(conn.frames.length, 1);
  const f1 = conn.frames[0];
  assert.strictEqual(f1.t, 'ui_command');
  assert.match(f1.uiId, /^loc-\d+$/, "로컬 uiId 는 'loc-' 접두사(back uuid 와 절대 안 섞임)");
  LU.frame(c, { t: 'ui_result', uiId: f1.uiId, ok: true, result: { opened: true } });
  assert.deepStrictEqual(await p1, { opened: true });

  // clientKey 매칭 + 실패 회신 전파
  const p2 = cptServer._sendUiCommand('ui.ideOpen', {}, { mode: 'target', target: { clientKey: 'pc-a' }, timeoutMs: 2000 });
  const f2 = conn.frames[1];
  LU.frame(c, { t: 'ui_result', uiId: f2.uiId, ok: false, error: '워크스페이스 없음' });
  await assert.rejects(p2, (e) => /워크스페이스 없음/.test(e.message));
  assert.strictEqual(ws.sent.length, 0);
  cleanup();
});

test('B2. target 이 다른 기기면 로컬 단축 없이 back 으로', async () => {
  cleanup();
  const ws = fakeOpenWs();
  cptServer.setControlWs(ws);
  const { conn } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc' });

  const p = cptServer._sendUiCommand('ui.ideOpen', {}, { mode: 'target', target: { deviceId: 99 }, timeoutMs: 300 });
  assert.strictEqual(conn.frames.length, 0, '다른 기기 타겟은 로컬로 가면 안 된다');
  assert.strictEqual(ws.sent.length, 1);
  await assert.rejects(p, (e) => e.code === 'UI_TIMEOUT');
  cleanup();
});

test('C. back 없음 + 로컬 있음 → 로컬 폴백(back 죽으면 cpt 전멸이던 것을 살린다)', async () => {
  cleanup();
  const { c, conn } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc', foreground: true });
  const p = cptServer._sendUiCommand('ui.previewOpen', { url: 'y' }, { mode: 'broadcast', timeoutMs: 2000 });
  assert.strictEqual(conn.frames.length, 1);
  LU.frame(c, { t: 'ui_result', uiId: conn.frames[0].uiId, ok: true, result: { ok: 1 } });
  assert.deepStrictEqual(await p, { ok: 1 });
  cleanup();
});

test('C2. 로컬 클라이언트 2개면 포커스된 화면을 고른다', async () => {
  cleanup();
  const a = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc', foreground: false });
  const b = attach({ clientKey: 'pc-b', deviceId: 8, kind: 'pc', foreground: true });
  assert.strictEqual(LU.pick(), b.c);
  // presence 프레임으로 포커스가 바뀌면 선택도 바뀐다.
  LU.frame(b.c, { t: 'presence', active: false });
  LU.frame(a.c, { t: 'presence', active: true });
  assert.strictEqual(LU.pick(), a.c);
  cleanup();
});

test('D. back 없음 + 로컬 없음 → BACK_OFFLINE(기존 동작 보존)', async () => {
  cleanup();
  await assert.rejects(
    cptServer._sendUiCommand('ui.previewOpen', {}, { mode: 'broadcast', timeoutMs: 500 }),
    (e) => e.code === 'BACK_OFFLINE',
  );
});

test('E. 로컬 채널 유실 → 대기 중 왕복 즉시 실패(무기한 대기 금지)', async () => {
  cleanup();
  const { c } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc' });
  const p = cptServer._sendUiCommand('ui.previewOpen', {}, { mode: 'broadcast', timeoutMs: 30000 });
  const t0 = Date.now();
  LU.detach(c);
  await assert.rejects(p, (e) => e.code === 'UI_LOCAL_GONE');
  assert.ok(Date.now() - t0 < 1000, '끊긴 즉시 실패해야 한다');
  cleanup();
});

test('F. 로컬로 간 명령은 back 으로 중복 전송되지 않는다(배타 분기)', async () => {
  cleanup();
  const ws = fakeOpenWs();
  cptServer.setControlWs(ws);
  const { c, conn } = attach({ clientKey: 'pc-a', deviceId: 7, kind: 'pc' });
  const p = cptServer._sendUiCommand('ui.focusPane', {}, { mode: 'target', target: { clientKey: 'pc-a' }, timeoutMs: 2000 });
  LU.frame(c, { t: 'ui_result', uiId: conn.frames[0].uiId, ok: true, result: null });
  await p;
  assert.strictEqual(ws.sent.length, 0);
  assert.strictEqual(conn.frames.length, 1);
  cleanup();
});
