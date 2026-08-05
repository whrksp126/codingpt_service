/**
 * TURN 크리덴셜 발급 — coturn 의 use-auth-secret(REST) 규약을 못박는다.
 *
 * 왜 서버가 만드나: 시크릿은 **서버에만** 둔다. 데몬도 폰도 단명 크리덴셜만 받는다.
 *  (데몬 "자격증명 무접촉" 규율의 연장 — 데몬에 TURN 시크릿을 두면 PC 가 털렸을 때 중계까지 열린다.)
 *
 * 이 파일이 지키는 것
 *  · 기본은 **꺼짐**(주소 미설정이면 빈 목록 → 클라이언트는 기존 릴레이/LAN 그대로)
 *  · 크리덴셜은 coturn 이 실제로 검증하는 그 값이어야 한다(HMAC-SHA1 → base64)
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const turn = require('../config/turn');

test('★ 미설정이면 꺼져 있다(실수로 켜지지 않는다)', () => {
  assert.deepStrictEqual(turn.iceServers(1, {}), []);
  assert.strictEqual(turn.enabled({}), false);
});

test('STUN 만 켤 수 있다 — 인증 없는 항목에 크리덴셜을 붙이지 않는다', () => {
  const out = turn.iceServers(7, { TURN_URLS: 'stun:t.example:3478' });
  assert.deepStrictEqual(out, [{ urls: 'stun:t.example:3478' }]);
});

test('시크릿이 없으면 TURN 항목은 아예 안 준다(못 쓰는 후보로 수집만 늦어진다)', () => {
  const out = turn.iceServers(7, { TURN_URLS: 'turn:t.example:3478,stun:t.example:3478' });
  assert.deepStrictEqual(out.map((x) => x.urls), ['stun:t.example:3478']);
});

test('★ coturn REST 규약대로 만든다 — username=만료:주체, credential=HMAC-SHA1(base64)', () => {
  const env = { TURN_URLS: 'turn:t.example:3478?transport=udp', TURN_SECRET: 's3cret', TURN_TTL_SEC: '600' };
  const before = Math.floor(Date.now() / 1000);
  const [s] = turn.iceServers(42, env);
  const [expiry, subject] = s.username.split(':');
  assert.strictEqual(subject, '42');
  assert.ok(Number(expiry) >= before + 599 && Number(expiry) <= before + 601, '만료는 지금 + TTL');
  const expect = crypto.createHmac('sha1', 's3cret').update(s.username).digest('base64');
  assert.strictEqual(s.credential, expect, 'coturn 이 검증하는 값과 한 글자도 달라선 안 된다');
});

test('주체는 소독한다(크리덴셜 형식을 깨는 문자가 못 들어간다)', () => {
  const env = { TURN_URLS: 'turn:t.example:3478', TURN_SECRET: 's' };
  const [s] = turn.iceServers('a:b c/d', env);
  assert.ok(/^\d+:[\w.-]*$/.test(s.username), `username 형식 위반: ${s.username}`);
});

test('TTL 은 범위를 벗어나면 기본값으로 — 오타로 영구/즉시 만료가 되지 않는다', () => {
  assert.strictEqual(turn.ttlSec({ TURN_TTL_SEC: '5' }), turn.DEFAULT_TTL_SEC);
  assert.strictEqual(turn.ttlSec({ TURN_TTL_SEC: '999999' }), turn.DEFAULT_TTL_SEC);
  assert.strictEqual(turn.ttlSec({ TURN_TTL_SEC: '300' }), 300);
});
