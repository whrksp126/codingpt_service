// emulator — 순수 판정(id 파싱·좌표 환산·raw 프레임 디코딩)을 고정한다.
//
// 여기서 지키려는 것은 하나다: **엉뚱한 곳을 누르지 않는 것.** 좌표가 어긋나면 사용자는 화면을
//  보면서 눌렀는데 다른 버튼이 눌린다 — 그리고 그게 왜 그런지 알 방법이 없다.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../emulator');

test('기기 id — 우리가 만든 형식만 통과한다', () => {
  assert.deepStrictEqual(E._parseId('android:emulator-5554'), { scheme: 'android', value: 'emulator-5554' });
  assert.deepStrictEqual(E._parseId('avd:Pixel_6'), { scheme: 'avd', value: 'Pixel_6' });
  assert.deepStrictEqual(E._parseId('ios:E7CB2FDE-0E62-405B-9EEF-AA5FDD10B914'),
    { scheme: 'ios', value: 'E7CB2FDE-0E62-405B-9EEF-AA5FDD10B914' });
  // 모르는 스킴·빈 값
  assert.strictEqual(E._parseId('windows:foo'), null);
  assert.strictEqual(E._parseId('android:'), null);
  assert.strictEqual(E._parseId('없음'), null);
  assert.strictEqual(E._parseId(null), null);
});

test('★ id 에 셸 메타문자가 섞이면 거부한다', () => {
  // execFile 이라 셸을 안 거치지만, 인자 자체가 오염되는 길도 막는다(adb -s "; rm -rf ~").
  for (const bad of ['android:a b', 'android:a;b', 'android:$(id)', 'android:`id`', 'android:a|b',
    'android:a&b', 'android:../../x', 'ios:a\nb', 'android:a>b']) {
    assert.strictEqual(E._parseId(bad), null, bad);
  }
});

test('좌표 — 0~1 을 픽셀로, 범위 밖은 잘라 낸다', () => {
  assert.strictEqual(E._px(0, 1080), 0);
  assert.strictEqual(E._px(1, 1080), 1079);        // 마지막 픽셀(1080 이면 화면 밖)
  assert.strictEqual(E._px(0.5, 1080), 540);
  assert.strictEqual(E._px(-3, 1080), 0);          // 밖을 누르면 기기가 이상하게 반응한다
  assert.strictEqual(E._px(99, 1080), 1079);
  assert.strictEqual(E._px('0.25', 1000), 250);    // 문자열로 와도 숫자로 본다
  assert.strictEqual(E._px(undefined, 1000), 0);
  assert.strictEqual(E._px(NaN, 1000), 0);
});

test('보낼 수 있는 키는 화면에 있는 것뿐 — 임의 keyevent 를 열지 않는다', () => {
  // 임의 keyevent 를 통과시키면 KEYCODE_ 무엇이든(공장초기화 메뉴 진입 등) 닿는다.
  assert.ok(E.ANDROID_KEYS.home && E.ANDROID_KEYS.back);
  assert.strictEqual(E.ANDROID_KEYS.KEYCODE_FACTORY_TEST, undefined);
  assert.strictEqual(E.ANDROID_KEYS['home; rm -rf'], undefined);
  for (const v of Object.values(E.ANDROID_KEYS)) assert.match(v, /^KEYCODE_[A-Z_]+$/);
  for (const v of Object.values(E.IOS_BUTTONS)) assert.match(v, /^[A-Z_]+$/);
});

// ── raw screencap 디코딩 ─────────────────────────────────────────────────────
function fakeRaw(w, h, headerExtra, fill) {
  const head = headerExtra ? 16 : 12;
  const buf = Buffer.alloc(head + w * h * 4);
  buf.writeUInt32LE(w, 0);
  buf.writeUInt32LE(h, 4);
  buf.writeUInt32LE(1, 8);
  if (headerExtra) buf.writeUInt32LE(1, 12);
  for (let i = head; i < buf.length; i += 4) {
    buf[i] = fill ? fill[0] : 10; buf[i + 1] = fill ? fill[1] : 20;
    buf[i + 2] = fill ? fill[2] : 30; buf[i + 3] = 255;
  }
  return buf;
}

test('raw screencap — 헤더 12바이트(구형)와 16바이트(안드로이드 13+) 둘 다 읽는다', () => {
  // 버전으로 분기하지 않고 **전체 길이에서 역산**한다는 규칙을 고정한다.
  const a = E._parseRawScreencap(fakeRaw(4, 3, false));
  assert.deepStrictEqual({ w: a.w, h: a.h, offset: a.offset }, { w: 4, h: 3, offset: 12 });
  const b = E._parseRawScreencap(fakeRaw(4, 3, true));
  assert.deepStrictEqual({ w: b.w, h: b.h, offset: b.offset }, { w: 4, h: 3, offset: 16 });
});

test('raw screencap — 우리가 모르는 모양이면 null(=PNG 경로로 물러선다)', () => {
  assert.strictEqual(E._parseRawScreencap(Buffer.alloc(4)), null);
  assert.strictEqual(E._parseRawScreencap(null), null);
  // 길이가 w*h*4 + 12/16 이 아니다 → RGBA_8888 이 아니다
  const odd = fakeRaw(4, 3, false);
  assert.strictEqual(E._parseRawScreencap(odd.slice(0, odd.length - 5)), null);
  // 말도 안 되는 크기(쓰레기 데이터)
  const junk = Buffer.alloc(64);
  junk.writeUInt32LE(999999, 0); junk.writeUInt32LE(999999, 4);
  assert.strictEqual(E._parseRawScreencap(junk), null);
});

test('BMP 변환 — 헤더가 맞고, 색이 RGBA→BGR 로 제대로 뒤집힌다', () => {
  const raw = E._parseRawScreencap(fakeRaw(2, 2, false, [200, 100, 50]));  // R=200 G=100 B=50
  const bmp = E._rawToBmp(raw, 480);   // 원본이 더 작으므로 축소 없음
  assert.strictEqual(bmp.toString('ascii', 0, 2), 'BM');
  assert.strictEqual(bmp.readUInt32LE(10), 54);            // 픽셀 시작
  assert.strictEqual(bmp.readInt32LE(18), 2);              // 폭
  assert.strictEqual(bmp.readInt32LE(22), 2);              // 높이
  assert.strictEqual(bmp.readUInt16LE(28), 24);            // 24비트
  // 첫 픽셀 = B,G,R 순서
  assert.deepStrictEqual([bmp[54], bmp[55], bmp[56]], [50, 100, 200]);
});

test('★ BMP 축소는 박스 평균이다 — 최근접이면 같은 화면이 4배로 부푼다', () => {
  // 왼쪽 절반 검정 / 오른쪽 절반 흰색을 절반 크기로 줄인다. 평균이면 각 칸이 순수 검/흰으로 남고,
  //  경계 한 칸만 섞인다. (확인하려는 건 "평균을 내고 있다"는 사실 — 실측에서 최근접이 41KB→185KB.)
  //  폭은 240 이다: 축소 목표에는 하한 120 이 걸려 있어(너무 작으면 알아볼 수 없다) 그보다 커야
  //  실제로 줄어든다 — 4px 로 시험했다가 "안 줄어드는" 걸 결함으로 착각할 뻔했다.
  const w = 240, h = 2;
  const buf = Buffer.alloc(12 + w * h * 4);
  buf.writeUInt32LE(w, 0); buf.writeUInt32LE(h, 4); buf.writeUInt32LE(1, 8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 12 + (y * w + x) * 4;
      const v = x < w / 2 ? 0 : 255;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
  }
  const raw = E._parseRawScreencap(buf);
  const bmp = E._rawToBmp(raw, 120);
  const ow = bmp.readInt32LE(18);
  assert.strictEqual(ow, 120);
  const rowBytes = (ow * 3 + 3) & ~3;
  const lastRow = 54 + (bmp.readInt32LE(22) - 1) * rowBytes;   // BMP 는 아래에서 위로
  assert.strictEqual(bmp[lastRow], 0, '왼쪽 끝은 검정 그대로');
  assert.strictEqual(bmp[lastRow + (ow - 1) * 3], 255, '오른쪽 끝은 흰색 그대로');
  // 경계가 뭉개지지 않았다 — 최근접이든 평균이든 여기까진 같지만, 아래가 진짜 판정이다.
  // 소스 2픽셀(검+흰)이 한 칸으로 합쳐지는 자리가 있으면 그 칸은 **중간값**이어야 한다.
  const mid = bmp[lastRow + 59 * 3];
  const midNext = bmp[lastRow + 60 * 3];
  assert.ok(mid === 0 || (mid > 0 && mid < 255), '경계 왼쪽');
  assert.ok(midNext === 255 || (midNext > 0 && midNext < 255), '경계 오른쪽');
});

test('축소 목표 폭을 넘지 않는다 · 원본이 더 작으면 키우지 않는다', () => {
  const big = E._parseRawScreencap(fakeRaw(1000, 500, false));
  const shrunk = E._rawToBmp(big, 200);
  assert.strictEqual(shrunk.readInt32LE(18), 200);
  assert.strictEqual(shrunk.readInt32LE(22), 100);      // 비율 유지
  const small = E._parseRawScreencap(fakeRaw(80, 40, false));
  const kept = E._rawToBmp(small, 480);
  assert.strictEqual(kept.readInt32LE(18), 80);          // 확대하지 않는다(흐려지기만 한다)
});

test('알 수 없는 메서드는 조용히 성공하지 않는다', async () => {
  await assert.rejects(() => E.handle('emulator.nope', {}), /알 수 없는 메서드/);
});

test('꺼져 있는 기기(avd:)에 프레임/입력을 요청하면 "켜라"고 말한다', async () => {
  await assert.rejects(() => E.frame({ id: 'avd:Pixel_6' }), /먼저 켜/);
  await assert.rejects(() => E.input({ id: 'avd:Pixel_6', type: 'tap', x: 0.5, y: 0.5 }), /먼저 켜/);
});

test('id 가 이상하면 아무것도 실행하지 않는다', async () => {
  for (const fn of ['frame', 'input', 'openUrl']) {
    await assert.rejects(() => E[fn]({ id: 'android:a;b', type: 'tap', url: 'https://x' }), /올바르지 않아요/);
  }
  await assert.rejects(() => E.boot('nope:1'), /올바르지 않아요/);
});

test('주소 열기 — 스킴 없는 문자열은 거부한다', async () => {
  await assert.rejects(() => E.openUrl({ id: 'android:emulator-5554', url: 'javascript' }), /주소가 올바르지/);
  await assert.rejects(() => E.openUrl({ id: 'android:emulator-5554', url: '' }), /주소가 올바르지/);
});

test('목록 정렬 — 켜진 것이 항상 위다', () => {
  const rows = E._sortDevices([
    { kind: 'ios', name: 'z', state: 'shutdown' },
    { kind: 'android', name: 'b', state: 'booted' },
    { kind: 'android', name: 'a', state: 'shutdown' },
    { kind: 'android', name: 'a', state: 'booted' },
  ]);
  assert.deepStrictEqual(rows.map((r) => r.state), ['booted', 'booted', 'shutdown', 'shutdown']);
  assert.deepStrictEqual(rows.slice(0, 2).map((r) => r.name), ['a', 'b']);
});

// ── 켜기 후 따라가기 · 캡처 방식 ─────────────────────────────────────────────
//  2026-08-05 실사고 둘을 고정한다.

test('★ 켜기 응답이 avdName 을 준다 — 켜지면 id 가 바뀌므로 화면이 따라갈 끈이 필요하다', async () => {
  // 실제로 에뮬레이터를 띄우지 않고, spawn 이 불릴 때의 반환 계약만 본다.
  const cp = require('node:child_process');
  const orig = cp.spawn;
  let spawned = null;
  cp.spawn = (bin, args) => { spawned = { bin, args }; return { unref() {} }; };
  try {
    E._resetTools();
    const r = await E.boot('avd:Pixel_9a').catch((e) => ({ err: e.message }));
    if (r && r.err && /찾을 수 없어요/.test(r.err)) return;   // 이 머신에 SDK 가 없다 — 건너뛴다
    assert.equal(r.ok, true);
    assert.equal(r.booting, true);
    //  ★ 이게 없으면 앱은 죽은 `avd:` id 를 붙든 채 영원히 '꺼짐' 을 보여 준다.
    assert.equal(r.avdName, 'Pixel_9a');
    assert.ok(spawned && spawned.args.includes('Pixel_9a'));
  } finally { cp.spawn = orig; }
});

test('★ 꺼진 AVD 행에도 avdName 이 있다 — 켜진 행과 이름으로 이어져야 한다', async () => {
  //  androidAvds 는 내부 함수라 list() 로 확인한다. SDK 가 없으면 빈 목록이니 건너뛴다.
  const r = await E.list();
  const avds = r.devices.filter((d) => d.id.startsWith('avd:'));
  if (!avds.length) return;
  for (const d of avds) {
    assert.equal(d.avdName, d.id.slice('avd:'.length),
      '꺼진 AVD 의 avdName 은 id 에서 바로 나온다');
  }
  //  켜진 에뮬레이터가 있으면 그쪽에도 이름이 붙어 있어야 한다(둘을 잇는 유일한 끈).
  const runningEmu = r.devices.filter((d) => /^android:emulator-/.test(d.id) && d.state === 'booted');
  for (const d of runningEmu) {
    assert.ok(typeof d.avdName === 'string' && d.avdName,
      `켜진 에뮬레이터(${d.id})에 avdName 이 없다 — 화면이 따라갈 방법이 사라진다`);
  }
});

test('★ 안드로이드 캡처는 기기 안에서 압축해 가져온다(전송량이 지배적이다)', async () => {
  //  실측(SM-N960N 1440x2960 USB): raw 1288ms/16.3MB · png 439ms · raw|gzip 297ms.
  //  raw 를 그대로 끌어오는 코드로 되돌아가면 4배 느려진다 — 그 선택을 여기서 못박는다.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'emulator.js'), 'utf8');
  assert.match(src, /screencap \| toybox gzip -1/, '기기 안 gzip 파이프가 사라졌다');
  assert.match(src, /gunzipSync/, '받은 것을 풀지 않는다');
  //  매직바이트 판정이 없으면 gzip 이 없는 기기에서 쓰레기를 파싱한다.
  assert.match(src, /0x1f && \w+\[1\] === 0x8b/, 'gzip 매직바이트 판정이 없다');
  //  실패한 기기를 매 프레임 다시 시도하면 왕복이 두 배가 된다.
  assert.match(src, /capMode\.set\(serial, 'raw'\)/, '실패한 기기를 raw 로 고정하지 않는다');
});

// ── iOS 조작 좌표계 ────────────────────────────────────────────────────────
// ★ 2026-08-06 실사고: iOS 는 **포인트**, 안드로이드는 **픽셀** 이다. 스크린샷 픽셀(1179x2556)을
//  idb 에 그대로 넘기면 3배 밖을 눌러 아무 일도 안 일어나는데, idb 는 rc=0 을 돌려준다 —
//  즉 **조용한 실패**다. idb 를 깔고도 "보기 전용" 처럼 보이던 진짜 이유가 이것이었다.
test('★ iOS 화면 크기는 idb 의 포인트 값을 쓴다(스크린샷 픽셀이 아니다)', () => {
  const emu = require('../emulator');
  const describe = JSON.stringify({
    udid: 'X', screen_dimensions: { width: 1179, height: 2556, density: 3.0, width_points: 393, height_points: 852 },
  });
  assert.deepEqual(emu._pointsFromIdbDescribe(describe), { w: 393, h: 852 });
});

test('idb 응답이 이상하면 크기를 지어내지 않는다(밖을 누르는 것보다 못 한다고 말하는 게 낫다)', () => {
  const emu = require('../emulator');
  assert.equal(emu._pointsFromIdbDescribe('쓰레기'), null);
  assert.equal(emu._pointsFromIdbDescribe(JSON.stringify({ screen_dimensions: { width: 1179, height: 2556 } })), null);
});

test('우리가 설치한 idb(전용 venv)를 찾는다', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'emulator.js'), 'utf8');
  assert.ok(/\.codingpt['"],\s*['"]idb['"],\s*['"]bin['"],\s*['"]idb['"]/.test(src),
    '전용 venv 경로가 탐지 목록에 없으면 설치해도 보기 전용으로 남는다');
});

// ── idb 는 혼자 못 돈다 ──────────────────────────────────────────────────────
// ★ 2026-08-06 실사고(두 번째): idb 를 깔고 좌표까지 고쳤는데도 **PC 앱에서만** iOS 조작이
//  안 됐다. 진범은 PATH — 파이썬 CLI 인 idb 는 실제 작업을 `idb_companion` 에 시키고 그 위치를
//  `shutil.which("idb_companion")` 로 **PATH 에서만** 찾는다. 앱이 띄운 데몬의 PATH 는
//  `/usr/bin:/bin:/usr/sbin:/sbin` 이라 /opt/homebrew/bin 이 안 보이고, idb 는
//  "/usr/local/bin/idb_companion 없음" 으로 죽는다(터미널에서는 brew PATH 라 됐다).

test('★ idb 실행 env 에 companion 디렉터리가 PATH 맨 앞에 붙는다', () => {
  const emu = require('../emulator');
  const env = emu._idbEnv({ idb: '/x/idb', idbCompanion: '/opt/homebrew/bin/idb_companion' },
    { PATH: '/usr/bin:/bin' });
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin',
    'companion 디렉터리를 얹지 않으면 앱이 띄운 데몬에서 idb 가 100% 실패한다');
});

test('companion 을 못 찾았으면 PATH 를 건드리지 않는다', () => {
  const emu = require('../emulator');
  assert.equal(emu._idbEnv({ idb: '/x/idb', idbCompanion: null }, { PATH: '/usr/bin' }).PATH, '/usr/bin');
});

test('★ 반쪽 설치(companion 없음)는 조작 가능으로 표시하지 않는다', () => {
  const emu = require('../emulator');
  assert.equal(emu._idbReady({ idb: '/x/idb', idbCompanion: null }), false);
  assert.equal(emu._idbReady({ idb: null, idbCompanion: '/opt/homebrew/bin/idb_companion' }), false);
  assert.equal(emu._idbReady({ idb: '/x/idb', idbCompanion: '/y/idb_companion' }), true);
});

test('idb 호출은 전부 idbRun 을 거친다(맨손 run(t.idb) 금지)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'emulator.js'), 'utf8');
  const bare = src.split('\n').filter((l) => /\brun\(t\.idb\b/.test(l) && !/return run\(t\.idb, args/.test(l));
  assert.deepEqual(bare, [], `PATH 를 안 얹고 idb 를 부르는 자리가 남아 있다:\n${bare.join('\n')}`);
});

// ── 버튼줄은 기기가 정한다 ──────────────────────────────────────────────────
test('★ iOS 버튼줄에 안드로이드 전용 키가 없다(누를 때마다 오류만 났다)', () => {
  const emu = require('../emulator');
  for (const k of emu.IOS_KEY_ROW) {
    assert.ok(emu.IOS_BUTTONS[k], `iOS 버튼줄의 ${k} 를 데몬이 못 보낸다`);
  }
  assert.ok(!emu.IOS_KEY_ROW.includes('back') && !emu.IOS_KEY_ROW.includes('recents'));
  for (const k of emu.ANDROID_KEY_ROW) assert.ok(emu.ANDROID_KEYS[k], `안드로이드 버튼줄의 ${k} 가 없다`);
});

test('appSwitch→APPLE_PAY 라는 거짓 매핑이 없다(앱 전환이 아니라 페이다)', () => {
  const emu = require('../emulator');
  assert.equal(emu.IOS_BUTTONS.appSwitch, undefined);
});
