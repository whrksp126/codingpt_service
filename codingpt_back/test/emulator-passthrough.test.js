// 모바일 화면 조작(`/api/daemon/emulator/input`)이 **필드를 잘라 먹지 않는지** — node --test.
//
// 왜 이 파일이 있나(2026-08-06 실사고): 컨트롤러가 `{id,type,x,y,x2,y2,durationMs,key,text}` 만
//  골라 담고 있었다. 그 뒤로 늘어난 필드가 **여기서만** 조용히 사라졌다:
//   · `phase` — 손가락을 따라가는 터치. 데몬이 "알 수 없는 터치 단계" 로 거절 → 폰은 옛 swipe 로
//     물러섰다. PC 는 이 길(back 릴레이)을 안 지나므로 **PC 에서만 부드럽고 폰에서만 끊기는**,
//     설명할 수 없는 차이가 남았다.
//   · `orientation` — 세로/가로. 없으면 데몬이 기본값 portrait 로 읽는다 → 회전 버튼을 눌러도
//     기기가 안 돈다. 게다가 요청은 **성공을 돌려준다**(조용한 실패 중에서도 가장 나쁜 모양).
//  그래서 검사하는 것은 개별 필드가 아니라 **불변식**이다: 화면이 보낸 것은 데몬까지 그대로 간다.
const { test } = require('node:test');
const assert = require('node:assert');

const relay = require('../services/daemonRelayService');
const daemonController = require('../controllers/daemonController');

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

/** 컨트롤러를 한 번 호출하고 **데몬에 실제로 간 인자**를 돌려준다. */
async function callInput(body) {
  const orig = relay.callRpc;
  let seen = null;
  relay.callRpc = async (_uid, method, args) => { seen = { method, args }; return { ok: true }; };
  try {
    await daemonController.emulatorInput({ user: { id: 1 }, body }, fakeRes());
  } finally { relay.callRpc = orig; }
  return seen;
}

test('★ 화면이 보낸 필드는 데몬까지 그대로 간다(서버가 고르지 않는다)', async () => {
  const sent = await callInput({
    id: 'android:emulator-5554', type: 'touch', phase: 'move', x: 0.5, y: 0.5,
    videoWidth: 1080, videoHeight: 2400,
  });
  assert.equal(sent.method, 'emulator.input');
  assert.equal(sent.args.phase, 'move', 'phase 가 잘리면 드래그가 옛 방식으로 물러선다');
  assert.equal(sent.args.videoWidth, 1080);
  assert.equal(sent.args.videoHeight, 2400);
});

test('★ 회전 방향(orientation)이 잘리지 않는다 — 잘리면 눌러도 기기가 안 돈다', async () => {
  const sent = await callInput({ id: 'ios:UDID', type: 'rotate', orientation: 'landscape' });
  assert.equal(sent.args.type, 'rotate');
  assert.equal(sent.args.orientation, 'landscape');
});

test('id·type 은 문자열로 정규화한다(그 둘만 서버가 손댄다)', async () => {
  const sent = await callInput({ id: undefined, type: undefined, key: 'home' });
  assert.equal(sent.args.id, '');
  assert.equal(sent.args.type, '');
  assert.equal(sent.args.key, 'home');
});
