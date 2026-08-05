/**
 * scrcpy — 라이브 화면(H.264)의 바이트 계약과 **조용한 실패**를 막는 가드.
 *
 * 왜 이게 있나(2026-08-05): 폴링(screencap)은 실기기에서 3.4fps·프레임당 300ms 였다. 안드로이드
 *  스튜디오가 부드러운 이유는 화면을 하드웨어 인코더로 H.264 로 뽑아 흘리기 때문이고, 우리도 그
 *  길로 갔다(실측 23~29fps, 정지 화면 6KB/s).
 *
 * 그 과정에서 **조용히 실패하는 결함**을 하나 만들었다: 터치 좌표를 기기 픽셀(1440x2960)로
 *  보냈는데 scrcpy 는 영상 좌표계(496x1024)를 기대한다. 크기가 다르면 서버가 그 이벤트를 **버린다**.
 *  RPC 는 `ok:true, via:'scrcpy'` 를 돌려주는데 화면은 꼼짝도 안 했다. 실측으로 잡았다 —
 *  같은 드래그가 영상 좌표계로는 34프레임, 기기 좌표계로는 0프레임.
 *  그래서 여기서 **무엇을 보내는지**를 바이트로 못박는다.
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../scrcpy-protocol');

test('서버 인자 — 우리가 켜고 끄는 것이 그대로 실린다', () => {
  const a = P.serverArgs('SER', { scid: 'deadbeef', maxSize: 1024, maxFps: 30, videoBitRate: 4000000 });
  assert.deepEqual(a.slice(0, 3), ['-s', 'SER', 'shell']);
  assert.ok(a.includes('com.genymobile.scrcpy.Server'));
  assert.ok(a.includes(P.SCRCPY_VERSION), '버전을 인자로 넘겨야 서버가 프로토콜을 맞춘다');
  assert.ok(a.includes('tunnel_forward=true'));
  assert.ok(a.includes('video_codec=h264'));
  //  control=true 여야 컨트롤 소켓이 열린다 — 이게 꺼지면 터치가 통째로 죽는다.
  assert.ok(a.includes('control=true'));
  //  audio=true 면 오디오 소켓까지 기다리느라 시작이 느려진다(우리는 화면만 본다).
  assert.ok(a.includes('audio=false'));
  assert.ok(a.includes('max_size=1024') && a.includes('max_fps=30'));
});

test('코덱 메타 — 널 패딩된 4바이트 태그 + 폭/높이', () => {
  const b = Buffer.alloc(12);
  Buffer.from('h264').copy(b, 0);
  b.writeUInt32BE(496, 4);
  b.writeUInt32BE(1024, 8);
  assert.deepEqual(P.parseCodecMeta(b), { codec: 'h264', width: 496, height: 1024 });
  assert.equal(P.parseCodecMeta(b.subarray(0, 11)), null, '덜 왔으면 null(추측 금지)');
});

test('프레임 조립 — 한 청크에 여러 개, 헤더가 반만 온 경우', () => {
  const mk = (flagBits, payload) => {
    const h = Buffer.alloc(12);
    h.writeBigUInt64BE(flagBits, 0);
    h.writeUInt32BE(payload.length, 8);
    return Buffer.concat([h, payload]);
  };
  const CONFIG = 1n << 63n;
  const KEY = 1n << 62n;
  const one = mk(CONFIG, Buffer.from([1, 2, 3]));
  const two = mk(KEY | 42n, Buffer.from([4, 5]));
  const three = mk(7n, Buffer.from([6]));

  const all = Buffer.concat([one, two, three]);
  const r = P.parseFrames(Buffer.alloc(0), all);
  assert.equal(r.frames.length, 3);
  assert.equal(r.frames[0].config, true);
  assert.equal(r.frames[1].keyFrame, true);
  assert.equal(r.frames[1].pts, 42n);
  assert.deepEqual([...r.frames[2].data], [6]);
  assert.equal(r.pending.length, 0);

  // 잘라서 넣어도 같은 결과여야 한다(TCP 는 우리 경계를 안 지킨다).
  let pending = Buffer.alloc(0);
  const got = [];
  for (let i = 0; i < all.length; i += 5) {
    const out = P.parseFrames(pending, all.subarray(i, i + 5));
    pending = out.pending;
    got.push(...out.frames);
  }
  assert.equal(got.length, 3);
  assert.equal(pending.length, 0);
});

test('★ 말도 안 되는 프레임 크기는 즉시 실패한다(버퍼를 키우며 OOM 으로 가지 않는다)', () => {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE(0n, 0);
  h.writeUInt32BE(P.MAX_FRAME_BYTES + 1, 8);
  assert.throws(() => P.parseFrames(Buffer.alloc(0), h), /어긋/);
});

test('터치 — 32바이트 · 빅엔디언 · up 은 압력 0', () => {
  const b = P.encodeTouch({ action: 'down', pointerId: 0, x: 100, y: 200, screenWidth: 496, screenHeight: 1024 });
  assert.equal(b.length, 32);
  assert.equal(b.readUInt8(0), P.MSG.TOUCH);
  assert.equal(b.readUInt8(1), 0, 'down=0');
  assert.equal(b.readInt32BE(10), 100);
  assert.equal(b.readInt32BE(14), 200);
  assert.equal(b.readUInt16BE(18), 496);
  assert.equal(b.readUInt16BE(20), 1024);
  assert.equal(b.readUInt16BE(22), 0xffff, '누르는 중은 최대 압력');
  const up = P.encodeTouch({ action: 'up', pointerId: 0, x: 1, y: 2, screenWidth: 496, screenHeight: 1024 });
  assert.equal(up.readUInt8(1), 1, 'up=1');
  assert.equal(up.readUInt16BE(22), 0, '손을 떼면 압력 0');
  assert.equal(up.readUInt32BE(28), 0, '떼면 눌린 버튼 없음');
});

test('글자 — 길이 접두사는 UTF-8 바이트 수다(글자 수가 아니다)', () => {
  const b = P.encodeText('한글');
  assert.equal(b.readUInt8(0), P.MSG.TEXT);
  assert.equal(b.readUInt32BE(1), 6, '한글 2자 = UTF-8 6바이트');
  assert.equal(b.subarray(5).toString('utf8'), '한글');
});

test('키 — 화면에 있는 것만 연다(임의 keyevent 금지)', () => {
  assert.equal(P.KEYCODES.home, 3);
  assert.equal(P.KEYCODES.back, 4);
  assert.equal(P.KEYCODES['공장초기화'], undefined);
  const b = P.encodeKeycode({ action: 'down', keycode: P.KEYCODES.back });
  assert.equal(b.length, 14);
  assert.equal(b.readInt32BE(2), 4);
});

// ── ★ 조용한 실패 가드 ───────────────────────────────────────────────────────

test('★ 입력 좌표는 **영상 크기**로 나간다 — 기기 픽셀을 보내면 scrcpy 가 조용히 버린다', async () => {
  const emu = require('../emulator');
  const streamMod = require('../emulator-stream');
  const sent = [];
  const fakeSession = {
    meta: { codec: 'h264', width: 496, height: 1024 },
    closed: false,
    send: (buf) => { sent.push(buf); return true; },
  };
  const origSessionFor = streamMod.sessionFor;
  streamMod.sessionFor = () => fakeSession;
  // 프레임을 본 적 있는 것처럼 기기 픽셀을 심어 둔다 — 예전 코드는 **이걸** 보내서 망가졌다.
  emu._lastSize.set('android:FAKE', { w: 1440, h: 2960 });
  try {
    const r = await emu.handle('emulator.input', { id: 'android:FAKE', type: 'tap', x: 0.5, y: 0.5 });
    assert.equal(r.via, 'scrcpy');
    assert.ok(sent.length >= 2, 'down 과 up 이 나가야 한다');
    const down = sent[0];
    assert.equal(down.readUInt16BE(18), 496, '★ 영상 폭이어야 한다(1440 이면 입력이 통째로 무시된다)');
    assert.equal(down.readUInt16BE(20), 1024, '★ 영상 높이여야 한다');
    assert.equal(down.readInt32BE(10), 248, '0.5 는 영상 폭의 절반');
  } finally {
    streamMod.sessionFor = origSessionFor;
    emu._lastSize.delete('android:FAKE');
  }
});

test('★ 회전 등으로 화면이 아는 크기가 다르면 그 값을 우선한다', async () => {
  const emu = require('../emulator');
  const streamMod = require('../emulator-stream');
  const sent = [];
  const origSessionFor = streamMod.sessionFor;
  streamMod.sessionFor = () => ({ meta: { width: 496, height: 1024 }, closed: false, send: (b) => { sent.push(b); return true; } });
  try {
    await emu.handle('emulator.input', {
      id: 'android:FAKE', type: 'tap', x: 1, y: 0, videoWidth: 1024, videoHeight: 496,
    });
    assert.equal(sent[0].readUInt16BE(18), 1024);
    assert.equal(sent[0].readUInt16BE(20), 496);
  } finally { streamMod.sessionFor = origSessionFor; }
});

test('컨트롤 소켓이 죽어 있으면 null 을 돌려 adb 로 물러선다(조용한 성공 금지)', async () => {
  const emu = require('../emulator');
  const streamMod = require('../emulator-stream');
  const origSessionFor = streamMod.sessionFor;
  streamMod.sessionFor = () => ({ meta: { width: 496, height: 1024 }, closed: false, send: () => false });
  try {
    //  adb 가 없으면 폴백 경로가 "adb 를 찾을 수 없어요" 로 실패한다 — 그게 곧 폴백을 탔다는 증거다.
    //  (조용히 ok 를 돌려줬다면 이 단정이 깨진다)
    await assert.rejects(
      () => emu.handle('emulator.input', { id: 'android:FAKE', type: 'key', key: 'home' }),
      (e) => /adb|찾을 수 없|화면 크기/.test(e.message),
    );
  } finally { streamMod.sessionFor = origSessionFor; }
});

test('iOS 시뮬레이터에는 라이브 화면을 약속하지 않는다(인코더 경로가 없다)', async () => {
  const emu = require('../emulator');
  await assert.rejects(
    () => emu.handle('emulator.stream.start', { id: 'ios:ABC-123' }),
    /지원하지 않아요/,
  );
});

// ── 경로가 늘어도 바이트는 하나 ────────────────────────────────────────────
// 2026-08-05: 폰의 화면 지연을 실측하고(릴레이 310~420ms vs LAN 직결 96~109ms) LAN 경로를 더했다.
//  이제 같은 프레임이 세 갈래로 나간다 — 로컬 웹뷰 WS · 릴레이 WS · LAN 채널.
//  ★ 여기서 못박는 것: **셋이 같은 바이트를 낸다.** 갈라지면 화면 코드가 세 벌이 되고,
//   그러면 반드시 한쪽만 고쳐진다(이 리포에서 이미 여러 번 그랬다).
test('★ LAN 직결과 릴레이는 같은 바이트를 낸다(meta 한 줄 + [플래그][H.264])', async () => {
  const stream = require('../emulator-stream');
  const CONFIG = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);   // SPS 흉내
  const KEY = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa]);
  const DELTA = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0xbb]);

  // 살아 있는 스트림 하나를 손으로 만든다(실제 기기·adb 없이 배선만 본다).
  const entry = {
    id: 'S1', serial: 'emulator-5554', deviceId: 'android:emulator-5554',
    token: 't', clients: new Set(), meta: { codec: 'h264', width: 576, height: 1280 },
    closeTimer: setTimeout(() => {}, 60000), session: { closed: false, configPacket: CONFIG, close() {} },
  };
  stream._streams.set(entry.id, entry);

  const lanOut = [];
  const chan = {
    closed: () => false,
    backlog: () => 0,
    sendText: (s) => lanOut.push(['text', s]),
    sendBinary: (b) => lanOut.push(['bin', Buffer.from(b)]),
    close: () => lanOut.push(['close']),
  };
  const startFor = async () => ({ streamId: entry.id, width: 576, height: 1280, codec: 'h264' });
  const handle = await stream.openLanStream({ id: entry.deviceId }, chan, { startFor });

  // 릴레이 쪽은 ws 를 흉내 낸다(같은 attach/send 를 타는지 본다).
  const wsOut = [];
  const fakeWs = { readyState: 1, bufferedAmount: 0, binaryType: '', send: (b) => wsOut.push(Buffer.from(b)) };
  stream.attach(entry, stream.wsViewer(fakeWs));

  // 프레임을 흘린다 — start() 의 onFrame 과 같은 방식으로.
  for (const [flags, data] of [[stream.FLAG_CONFIG, CONFIG], [stream.FLAG_KEY, KEY], [0, DELTA]]) {
    for (const v of entry.clients) {
      const head = Buffer.alloc(1); head.writeUInt8(flags, 0);
      if (v.backlog() <= stream.BACKPRESSURE_MAX && v.alive()) v.write(Buffer.concat([head, data]));
    }
  }

  // meta 가 **먼저** 나간다(화면이 좌표계를 알아야 입력을 보낸다).
  assert.equal(lanOut[0][0], 'text');
  assert.deepEqual(JSON.parse(lanOut[0][1]), { type: 'meta', width: 576, height: 1280, codec: 'h264' });

  // 그 다음 바이너리는 붙는 순간의 config(attach) + 흘린 3장.
  const lanBins = lanOut.filter((x) => x[0] === 'bin').map((x) => x[1]);
  assert.deepEqual(lanBins.map((b) => b[0]), [1, 1, 2, 0], 'attach 시 config 선행 → config/key/delta');
  assert.deepEqual(lanBins[1].subarray(1), CONFIG);
  assert.deepEqual(lanBins[2].subarray(1), KEY);
  assert.deepEqual(lanBins[3].subarray(1), DELTA);

  // ★ 릴레이(ws) 가 받은 것과 LAN 이 받은 것이 **같아야** 한다.
  assert.deepEqual(wsOut.map((b) => b.toString('hex')), lanBins.map((b) => b.toString('hex')));

  const before = entry.clients.size;
  handle.detach();
  assert.equal(entry.clients.size, before - 1, 'detach 하면 뷰어 집합에서 빠진다');
  clearTimeout(entry.closeTimer);
  stream._streams.delete(entry.id);
});

test('★ 느린 뷰어는 프레임을 버리는 게 아니라 끊는다(델타를 빼면 몇 분간 깨진 화면이 남는다)', () => {
  const stream = require('../emulator-stream');
  const events = [];
  const viewer = {
    alive: () => true,
    backlog: () => stream.BACKPRESSURE_MAX + 1,
    write: () => events.push('write'),
    close: () => events.push('close'),
  };
  const entry = { clients: new Set([viewer]), session: { configPacket: null }, closeTimer: null };
  for (const v of entry.clients) {
    if (v.backlog() > stream.BACKPRESSURE_MAX) v.close(4003, 'too slow');
    else v.write(Buffer.alloc(1));
  }
  assert.deepEqual(events, ['close'], '밀리면 그 뷰어만 끊는다(프레임 드롭 금지)');
});
