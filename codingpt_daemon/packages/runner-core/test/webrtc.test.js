/**
 * WebRTC 송신 — **바이트 계약**과 **ICE 서버 해석**을 못박는다.
 *
 * 왜 이 경로가 생겼나(2026-08-06 실측): 같은 Wi-Fi 는 LAN 직결로 ~120ms 인데 밖에서는
 *  폰→CF→홈서버→CF→PC 를 돌아 310~420ms 다. 서버를 안 거치면 그 250ms 가 사라진다.
 *
 * 여기서 지키는 것
 *  · TURN 크리덴셜은 **서버가 만들어 클라이언트가 넘겨준다** — 데몬은 해석만 한다(시크릿 무접촉).
 *  · H.264 Annex-B 규칙이 WebCodecs 클라이언트와 **같아야** 한다: config 는 따로 보내지 않고
 *    키프레임 앞에 붙인다. 다르면 한쪽 화면만 뜨는 상태가 된다.
 */
const test = require('node:test');
const assert = require('node:assert');
const w = require('../webrtc');
const stream = require('../emulator-stream');

test('ICE 서버 해석 — 브라우저 형식을 그대로 받는다', () => {
  const out = w.toIceServers([
    { urls: 'stun:turn.example:3478' },
    { urls: 'turn:turn.example:3478?transport=udp', username: 'u', credential: 'p' },
    { urls: 'turn:turn.example:3478?transport=tcp', username: 'u', credential: 'p' },
    { urls: 'turns:turn.example:5349', username: 'u', credential: 'p' },
  ]);
  assert.equal(out[0], 'stun:turn.example:3478');
  assert.equal(out[1].relayType, 'TurnUdp');
  assert.equal(out[2].relayType, 'TurnTcp');
  assert.equal(out[3].relayType, 'TurnTls');
  assert.equal(out[1].username, 'u');
  assert.equal(out[1].password, 'p');
});

test('★ 크리덴셜 없는 TURN 은 버린다(있으나 마나 한 후보로 수집만 늦어진다)', () => {
  assert.deepEqual(w.toIceServers([{ urls: 'turn:turn.example:3478' }]), []);
  assert.deepEqual(w.toIceServers([{ urls: '아무거나' }]), []);
  assert.deepEqual(w.toIceServers(null), []);
});

// ── 프레임 계약 ────────────────────────────────────────────────────────────
function fakeSession() {
  const sent = [];
  return {
    sent: 0, droppedClosed: 0, config: null, lastSendAt: 0,
    rtpConfig: { timestamp: 0 },
    track: { isOpen: () => true, sendMessageBinary: (b) => { sent.push(Buffer.from(b)); return true; } },
    _out: sent,
  };
}
const framed = (flags, body) => Buffer.concat([Buffer.from([flags]), body]);

test('★ config 는 단독 송신하지 않고 키프레임 앞에 붙인다(WebCodecs 클라이언트와 같은 규칙)', () => {
  const s = fakeSession();
  const CONFIG = Buffer.from([0, 0, 0, 1, 0x67, 0x42]);
  const KEY = Buffer.from([0, 0, 0, 1, 0x65, 0xaa]);
  const DELTA = Buffer.from([0, 0, 0, 1, 0x41, 0xbb]);

  w._feed(s, framed(stream.FLAG_CONFIG, CONFIG));
  assert.equal(s._out.length, 0, 'config 만으로는 보내지 않는다');

  w._feed(s, framed(stream.FLAG_KEY, KEY));
  assert.deepEqual(s._out[0], Buffer.concat([CONFIG, KEY]), '키프레임 앞에 SPS/PPS');

  w._feed(s, framed(0, DELTA));
  assert.deepEqual(s._out[1], DELTA, '델타는 그대로');
  assert.equal(s.sent, 2);
});

test('타임스탬프는 90kHz 로 앞으로만 간다', () => {
  const s = fakeSession();
  w._feed(s, framed(stream.FLAG_KEY, Buffer.from([1, 2])));
  const t0 = s.rtpConfig.timestamp;
  s.lastSendAt -= 100;                       // 100ms 전에 보낸 것처럼
  w._feed(s, framed(0, Buffer.from([3, 4])));
  assert.ok(s.rtpConfig.timestamp > t0, '증가해야 한다');
  assert.ok(s.rtpConfig.timestamp - t0 >= 9000 - 200, '100ms ≈ 9000 틱');
});

test('트랙이 닫혀 있으면 보내지 않고 세어 둔다(조용한 유실 금지)', () => {
  const s = fakeSession();
  s.track.isOpen = () => false;
  w._feed(s, framed(stream.FLAG_KEY, Buffer.from([1, 2])));
  assert.equal(s._out.length, 0);
  assert.equal(s.droppedClosed, 1);
});

test('★ 트랙이 열리는 순간 지금 GOP 를 다시 튼다(열리기 전 것은 전부 버려진다)', () => {
  const s = fakeSession();
  const KEY = Buffer.from([0, 0, 0, 1, 0x65, 1]);
  const D = Buffer.from([0, 0, 0, 1, 0x41, 2]);
  s.entry = { session: { configPacket: Buffer.from([0, 0, 0, 1, 0x67, 9]) }, gop: [[stream.FLAG_KEY, KEY], [0, D]] };
  w._replayGop(s);
  assert.equal(s._out.length, 2, '키프레임 + 델타가 다시 나간다');
  assert.equal(s._out[0][4], 0x67, '되감기 첫 장은 SPS 부터 시작한다');
});
