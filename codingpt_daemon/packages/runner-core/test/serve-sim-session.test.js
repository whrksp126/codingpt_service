// serve-sim 세션 — 와이어 해석만 고정한다(시뮬레이터를 띄우지 않는다).
//
// 여기서 지키려는 것: **화면이 깨지지 않는 것.** H.264 는 한 바이트만 어긋나도 디코더가
//  조용히 이상한 그림을 그린다 — 그리고 사용자는 그게 왜인지 알 방법이 없다.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../serve-sim-session');

const START = Buffer.from([0, 0, 0, 1]);

// ── avcC(설명) → Annex-B ────────────────────────────────────────────────────
// 실측한 진짜 바이트로 만든다: 01 64 00 33 ff e1 00 16 ... (iPhone 16 Pro, 2026-08-06)
function fakeAvcC(sps, pps, lengthSizeMinusOne = 3) {
  const parts = [
    Buffer.from([1, 0x64, 0x00, 0x33, 0xfc | lengthSizeMinusOne, 0xe0 | 1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1]),
    Buffer.from([pps.length >> 8, pps.length & 0xff]), pps,
  ];
  return Buffer.concat(parts);
}

test('★ avcC 설명은 SPS/PPS 를 시작코드로 풀어 준다(우리 디코더는 Annex-B 를 먹는다)', () => {
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x33, 0xac]);
  const pps = Buffer.from([0x68, 0xee, 0x3c, 0xb0]);
  const r = S._avccConfigToAnnexB(fakeAvcC(sps, pps));
  assert.ok(r, '설명을 못 풀면 화면은 첫 프레임부터 검은 채로 남는다');
  assert.equal(r.lengthSize, 4);
  assert.deepEqual(r.data, Buffer.concat([START, sps, START, pps]));
});

test('길이 바이트 수(lengthSizeMinusOne)를 그대로 읽는다 — 4가 아닐 수도 있다', () => {
  const r = S._avccConfigToAnnexB(fakeAvcC(Buffer.from([0x67, 1]), Buffer.from([0x68, 2]), 1));
  assert.equal(r.lengthSize, 2);
});

test('망가진 설명은 지어내지 않고 null(다음 설명을 기다린다)', () => {
  assert.equal(S._avccConfigToAnnexB(Buffer.alloc(3)), null);
  assert.equal(S._avccConfigToAnnexB(null), null);
  assert.equal(S._avccConfigToAnnexB(Buffer.from([2, 0, 0, 0, 0xff, 0xe1, 0, 0])), null, '버전이 1이 아니다');
  //  SPS 길이가 남은 바이트보다 크다 — 억지로 자르면 디코더가 깨진 그림을 그린다.
  const bad = Buffer.from([1, 0x64, 0, 0x33, 0xff, 0xe1, 0x00, 0x40, 0x67]);
  assert.equal(S._avccConfigToAnnexB(bad), null);
});

// ── AVCC 프레임 → Annex-B ──────────────────────────────────────────────────
test('★ NAL 길이 접두를 시작코드로 바꾼다', () => {
  const nal1 = Buffer.from([0x25, 0xb8, 0x00, 0x40]);
  const nal2 = Buffer.from([0x21, 0xe0]);
  const avcc = Buffer.concat([
    Buffer.from([0, 0, 0, nal1.length]), nal1,
    Buffer.from([0, 0, 0, nal2.length]), nal2,
  ]);
  assert.deepEqual(S._avccToAnnexB(avcc, 4), Buffer.concat([START, nal1, START, nal2]));
});

test('길이가 어긋난 프레임은 버린다(이어 붙이면 화면이 깨진 채로 남는다)', () => {
  assert.equal(S._avccToAnnexB(Buffer.from([0, 0, 0, 9, 1, 2]), 4), null, '선언한 길이보다 짧다');
  assert.equal(S._avccToAnnexB(Buffer.from([0, 0, 0, 1, 1, 0, 0]), 4), null, '꼬리가 남는다');
});

// ── 봉투 조립 ───────────────────────────────────────────────────────────────
function envelope(tag, payload) {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(payload.length + 1, 0);
  h[4] = tag;
  return Buffer.concat([h, payload]);
}

test('★ TCP 가 잘라 보내도 프레임 경계를 되찾는다', () => {
  const a = envelope(2, Buffer.from('키프레임'));
  const b = envelope(3, Buffer.from('델타'));
  const all = Buffer.concat([a, b]);
  //  한 바이트씩 흘려 넣어도 결과가 같아야 한다 — 실제로 청크는 이렇게 쪼개진다.
  let pending = Buffer.alloc(0);
  const got = [];
  for (const byte of all) {
    const out = S._parseEnvelopes(pending, Buffer.from([byte]));
    pending = out.pending;
    got.push(...out.items);
  }
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((x) => x.tag), [2, 3]);
  assert.equal(got[0].payload.toString(), '키프레임');
  assert.equal(pending.length, 0);
});

test('한 청크에 여러 프레임이 와도 전부 꺼낸다', () => {
  const out = S._parseEnvelopes(Buffer.alloc(0), Buffer.concat([
    envelope(1, Buffer.from([1, 2])), envelope(2, Buffer.from([3])), envelope(3, Buffer.from([4, 5, 6])),
  ]));
  assert.deepEqual(out.items.map((x) => x.tag), [1, 2, 3]);
  assert.equal(out.pending.length, 0);
});

test('말도 안 되는 길이는 던진다 — 어긋난 스트림을 무한히 모으지 않는다', () => {
  const bad = Buffer.alloc(9);
  bad.writeUInt32BE(0x7fffffff, 0);
  assert.throws(() => S._parseEnvelopes(Buffer.alloc(0), bad), /상한을 넘었어요/);
  const zero = Buffer.alloc(9);            // 길이 0 = 태그조차 없다
  assert.throws(() => S._parseEnvelopes(Buffer.alloc(0), zero), /상한을 넘었어요/);
});

test('좌표는 0~1 로 잘라 낸다(밖을 누르면 기기가 이상하게 반응한다)', () => {
  assert.equal(S._clamp01(-1), 0);
  assert.equal(S._clamp01(2), 1);
  assert.equal(S._clamp01('0.25'), 0.25);
  assert.equal(S._clamp01(undefined), 0);
  assert.equal(S._clamp01(NaN), 0);
});

test('쓸 수 있는 환경인지 정직하게 답한다(네이티브 헬퍼는 애플 실리콘 전용)', () => {
  const ok = S.available();
  assert.equal(typeof ok, 'boolean');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    assert.equal(ok, false, '못 도는 환경에서 된다고 하면 화면이 영영 안 붙는다');
  } else {
    //  이 리포에서는 의존성으로 들어 있어야 한다 — 빠지면 iOS 가 조용히 폴링으로 돌아간다.
    assert.ok(S.serveSimEntry(), 'serve-sim 을 못 찾았다(번들에서 빠졌는지 확인)');
  }
});

// ── 유령 헬퍼 정리는 **정확해야** 한다 ──────────────────────────────────────
// 데몬이 강제 종료되면 헬퍼가 남아 시뮬레이터를 계속 캡처한다. 다음 기동 때 치우는데,
//  여기서 조건을 하나라도 느슨하게 잡으면 **남의 앱 프로세스를 죽인다**(같은 기계에서 Orca 도
//  자기 serve-sim 을 띄운다). 그래서 판정을 따로 떼어 못박는다.
test('★ 우리 경로 + 같은 udid 일 때만 유령으로 본다', () => {
  const entry = '/Applications/CodingPT.app/Contents/Resources/daemon/app/node_modules/serve-sim/dist/serve-sim.js';
  const udid = 'E7CB2FDE-0E62-405B-9EEF-AA5FDD10B914';
  assert.equal(S._strayPid(`  4321 node ${entry} --no-preview -q --port 5000 ${udid}`, entry, udid, 9), 4321);
  //  Orca 가 띄운 같은 기기의 헬퍼 — 경로가 다르다. 절대 건드리면 안 된다.
  assert.equal(S._strayPid(`  4322 /Users/x/Library/Application Support/orca/serve-sim-runtime/1.4/bin/serve-sim-bin ${udid}`, entry, udid, 9), 0);
  //  우리 경로지만 **다른 기기** — 지금 쓰는 중일 수 있다.
  assert.equal(S._strayPid(`  4323 node ${entry} --no-preview -q --port 5001 OTHER-UDID`, entry, udid, 9), 0);
  //  나 자신
  assert.equal(S._strayPid(`  9 node ${entry} ${udid}`, entry, udid, 9), 0);
  //  형식이 아닌 줄 · 빈 인자
  assert.equal(S._strayPid('쓰레기', entry, udid, 9), 0);
  assert.equal(S._strayPid(`  1 node ${entry} ${udid}`, '', udid, 9), 0);
  assert.equal(S._strayPid(`  1 node ${entry} ${udid}`, entry, '', 9), 0);
});
