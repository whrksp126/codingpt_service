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
  // 구분자는 실행 플랫폼의 path.delimiter(win32 CI 에선 ';') — 하드코딩 ':' 는 win32 에서 거짓 실패.
  assert.equal(env.PATH, `/opt/homebrew/bin${require('path').delimiter}/usr/bin:/bin`,
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
  //  serve-sim 이 있는 기계의 버튼줄 — 그 경로로 전부 보낼 수 있어야 한다.
  //  회전은 버튼(HID)이 아니라 전용 메시지라 버튼 표가 아닌 ROTATE_KEYS 에 있다.
  for (const k of emu.IOS_KEY_ROW) {
    assert.ok(emu.IOS_SS_BUTTONS[k] || emu.ROTATE_KEYS[k], `iOS 버튼줄의 ${k} 를 serve-sim 으로 못 보낸다`);
  }
  //  ★ idb 폴백만 있는 기계는 **줄이 더 짧다.** idb 의 버튼 어휘에는 볼륨이 아예 없어서
  //   같은 줄을 그리면 누를 때마다 오류만 난다(2026-08-06 테스트가 잡아낸 결함).
  for (const k of emu.IOS_KEY_ROW_IDB) {
    assert.ok(emu.IOS_BUTTONS[k], `idb 폴백 버튼줄의 ${k} 를 idb 로 못 보낸다`);
  }
  assert.ok(emu.IOS_KEY_ROW_IDB.length <= emu.IOS_KEY_ROW.length);
  assert.ok(!emu.IOS_KEY_ROW.includes('back') && !emu.IOS_KEY_ROW.includes('recents'));
  //  회전은 키코드가 아니라 전용 처리다(settings user_rotation) — 그래서 KEYCODE 표에 없다.
  for (const k of emu.ANDROID_KEY_ROW) {
    assert.ok(emu.ANDROID_KEYS[k] || emu.ROTATE_KEYS[k], `안드로이드 버튼줄의 ${k} 를 보낼 방법이 없다`);
  }
});

test('appSwitch→APPLE_PAY 라는 거짓 매핑이 없다(앱 전환이 아니라 페이다)', () => {
  const emu = require('../emulator');
  assert.equal(emu.IOS_BUTTONS.appSwitch, undefined);
});

// ── 표시 크기와 입력 좌표계는 다른 칸에 산다 ────────────────────────────────
// ★ 2026-08-06 실사고(세 번째): 포인트를 lastSize 에 캐시했더니 frame() 이 픽셀로 덮어썼다.
//  실사용은 항상 "화면 먼저 → 조작" 이라 고친 좌표가 첫 프레임과 함께 사라졌고, iOS 는 계속
//  조작이 안 됐다. 프레임 없이 새 프로세스에서 돌린 내 검증만 통과했던 것 — 순서를 못박는다.
test('★ 프레임이 들어와도 iOS 입력 좌표계는 포인트로 남는다', async () => {
  const emu = require('../emulator');
  const id = 'ios:TEST-UDID';
  emu._lastSize.set(id, { w: 1179, h: 2556 });          // frame() 이 넣는 표시 픽셀
  emu._inputSize.set(id, { w: 393, h: 852 });           // idb 가 알려 준 입력 포인트
  const s = await emu._screenSize(id, { scheme: 'ios', value: 'TEST-UDID' });
  assert.deepEqual(s, { w: 393, h: 852 }, '표시 픽셀이 입력 좌표계를 덮어썼다 — 3배 밖을 누르게 된다');
  assert.equal(emu._px(0.5, s.w), 197);   // 화면 한가운데 = 197pt (픽셀이었다면 590 — 화면 밖)
  emu._lastSize.delete(id); emu._inputSize.delete(id);
});

test('안드로이드는 표시 픽셀이 곧 입력 좌표계다(adb 는 픽셀을 받는다)', async () => {
  const emu = require('../emulator');
  const id = 'android:TEST';
  emu._lastSize.set(id, { w: 1080, h: 2400 });
  const s = await emu._screenSize(id, { scheme: 'android', value: 'TEST' });
  assert.deepEqual(s, { w: 1080, h: 2400 });
  emu._lastSize.delete(id);
});

// ── 축소는 "가로" 기준이다 ──────────────────────────────────────────────────
// ★ 2026-08-06 실사고(네 번째): `sips -Z` 는 **긴 변**을 맞춘다. 세로 폰(1179x2556)에
//  maxWidth=480 을 주면 가로는 221px 이 됐다 — "480 을 보내는 중" 이라 믿은 화면이 실제로는
//  절반도 안 됐고, 그걸 레티나에서 늘려 그리니 글씨가 안 읽혔다. --resampleWidth 여야 한다.
test('★ maxWidth 는 가로 픽셀이다(세로가 긴 화면에서도)', async () => {
  const emu = require('../emulator');
  const fsx = require('fs'), pathx = require('path'), osx = require('os');
  const { execFile } = require('child_process');
  if (!emu._tools().sips) return;                       // 비-macOS 에선 건너뛴다
  const sips = (args) => new Promise((res, rej) =>
    execFile('/usr/bin/sips', args, (e, so) => (e ? rej(e) : res(String(so)))));
  const tmp = (ext) => pathx.join(osx.tmpdir(), `cpt-sipstest-${process.pid}.${ext}`);
  const [bmpPath, pngPath, jpgPath] = ['bmp', 'png', 'jpg'].map(tmp);
  //  세로가 긴 가짜 화면(300x800) → 가로 150 요구. (하한이 120 이라 그보다 커야 의미가 있다.)
  fsx.writeFileSync(bmpPath, emu._rawToBmp({ w: 300, h: 800, offset: 0, data: Buffer.alloc(300 * 800 * 4, 0x80) }, 4000));
  try {
    await sips(['-s', 'format', 'png', bmpPath, '--out', pngPath]);
    const out = await emu._toJpeg(fsx.readFileSync(pngPath), 'png', 150, 70, { w: 300, h: 800 });
    fsx.writeFileSync(jpgPath, out.buf);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(await sips(['-g', 'pixelWidth', jpgPath]))[1]);
    //  -Z(긴 변) 였다면 150x(300/800)= 56px 이 됐을 것이다.
    assert.equal(w, 150, `가로가 150 이어야 하는데 ${w} — -Z(긴 변 기준)로 되돌아갔다`);
  } finally { for (const f of [bmpPath, pngPath, jpgPath]) { try { fsx.unlinkSync(f); } catch (_) {} } }
});

test('원본보다 크게 요구해도 늘리지 않는다(용량만 커진다)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'emulator.js'), 'utf8');
  assert.match(src, /!srcSize \|\| srcSize\.w > want/, '원본보다 클 때 확대를 막는 조건이 사라졌다');
});

// ── serve-sim 버튼 어휘 ─────────────────────────────────────────────────────
// ★ 2026-08-06 실측: 이름이 **소문자**여야 한다. idb 어휘(대문자 HOME)를 그대로 넘기면
//  serve-sim 은 아무 일도 하지 않으면서 오류도 안 낸다 — 조용한 실패의 교과서다.
test('★ serve-sim 버튼 이름은 소문자다(대문자는 조용히 무시된다)', () => {
  const emu = require('../emulator');
  for (const [k, v] of Object.entries(emu.IOS_SS_BUTTONS)) {
    assert.equal(v.button, v.button.toLowerCase(), `${k} 가 대문자다`);
  }
  assert.equal(emu.IOS_SS_BUTTONS.home.button, 'home');
});

test('★ 전원·볼륨은 HID page/usage 를 함께 보낸다(이름만으로는 안 눌린다)', () => {
  const emu = require('../emulator');
  //  'lock' 은 serve-sim 어휘에 없다 — 전원 버튼이 곧 잠금이다(실측으로 확인).
  assert.deepEqual(emu.IOS_SS_BUTTONS.lock, { button: 'power', page: 12, usage: 48 });
  for (const k of ['lock', 'volumeUp', 'volumeDown']) {
    assert.ok(emu.IOS_SS_BUTTONS[k].page > 0 && emu.IOS_SS_BUTTONS[k].usage > 0, `${k} 에 page/usage 가 없다`);
  }
});

test('iOS 도 라이브 화면을 요청할 수 있다(예전엔 android 만 통과시켰다)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'emulator.js'), 'utf8');
  assert.match(src, /p\.scheme !== 'android' && p\.scheme !== 'ios'/,
    'streamStart 가 iOS 를 막으면 화면은 영원히 폴링으로 남는다');
});

// ── 화면을 글자로 읽기(에이전트용) ──────────────────────────────────────────
// ★ 이게 있으면 에이전트가 스크린샷을 눈으로 보고 좌표를 찍지 않아도 된다. 좌표를 찍어서 틀리면
//  기기는 아무 반응이 없고 rc 는 0 이다 — 오늘 하루 종일 나를 속인 그 실패 모양이다.
test('★ 접근성 트리 좌표는 0~1 정규화다(그대로 tap 에 넣을 수 있어야 한다)', () => {
  const emu = require('../emulator');
  const r = emu._normalizeIosAx([{
    frame: { x: 0, y: 0, width: 400, height: 800 }, AXLabel: '', children: [
      { frame: { x: 100, y: 200, width: 200, height: 100 }, AXLabel: '설정', type: 'Button', enabled: true, children: [] },
    ],
  }]);
  assert.deepEqual(r.screen, { w: 400, h: 800 });
  assert.equal(r.elements.length, 1);
  const e = r.elements[0];
  assert.equal(e.label, '설정');
  assert.equal(e.x, 0.5);        // (100+200/2)/400 = 중심
  assert.equal(e.y, 0.3125);     // (200+100/2)/800
  assert.equal(e.w, 0.5);
});

test('화면 전체를 덮는 껍데기는 요소로 세지 않는다(누르면 아무 데나 누른 것)', () => {
  const emu = require('../emulator');
  const r = emu._normalizeIosAx([{
    frame: { x: 0, y: 0, width: 400, height: 800 }, AXLabel: '배경', children: [
      { frame: { x: 0, y: 0, width: 400, height: 800 }, AXLabel: '전체', type: 'Group', children: [] },
    ],
  }]);
  assert.equal(r.elements.length, 0);
});

test('★ 안드로이드 uiautomator 덤프에서 라벨과 사각형을 뽑는다', () => {
  const emu = require('../emulator');
  const xml = '<?xml version="1.0"?><hierarchy rotation="0">'
    + '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />'
    + '<node index="1" text="설정" resource-id="com.x:id/s" class="android.widget.TextView" clickable="true" enabled="true" bounds="[100,200][300,300]" />'
    + '<node index="2" text="" content-desc="" class="android.view.View" clickable="false" enabled="true" bounds="[0,0][10,10]" />'
    + '</hierarchy>';
  const r = emu._parseAndroidAx(xml);
  assert.deepEqual(r.screen, { w: 1080, h: 2400 });
  //  전체 껍데기와 이름 없는 비클릭 요소는 빠지고 '설정' 만 남는다.
  assert.equal(r.elements.length, 1);
  assert.equal(r.elements[0].label, '설정');
  assert.equal(r.elements[0].x, Math.round((200 / 1080) * 10000) / 10000);
  assert.equal(r.elements[0].y, Math.round((250 / 2400) * 10000) / 10000);
});

test('덤프가 쓰레기면 요소를 지어내지 않는다', () => {
  const emu = require('../emulator');
  assert.deepEqual(emu._parseAndroidAx('망가진 출력'), { screen: { w: 0, h: 0 }, elements: [] });
});

// ── 회전은 세로/가로 두 상태다 ──────────────────────────────────────────────
// ★ 2026-08-06 재설계: 좌/우 두 버튼 → **하나**. 그리고 "한 칸 돌리기" 가 아니라 **절대값**이다.
//  왜: 한 칸씩 더하면 값이 어디서부터 도는지 알 수 없다(실측 중 0 인 줄 알았던 user_rotation 이
//  2 였고, 2 는 '거꾸로 세로' 라 프레임이 안 바뀌어 "아무 일도 안 일어난다" 로 보였다).
test('★ 회전은 세로/가로 두 상태를 절대값으로 쓴다', () => {
  const emu = require('../emulator');
  assert.deepEqual(emu.ROTATE_TARGETS, { portrait: 0, landscape: 1 }, '안드로이드 user_rotation 절대값');
  assert.equal(emu.IOS_ROTATE_TARGET.landscape, 'landscape_left', 'iOS 의 가로 = 왼쪽으로 눕힘');
  assert.equal(emu.IOS_ROTATE_TARGET.portrait, 'portrait');
  for (const row of [emu.IOS_KEY_ROW, emu.ANDROID_KEY_ROW]) {
    assert.ok(row.includes('rotate'), '버튼줄에 회전이 있다');
    assert.ok(!row.includes('rotateLeft') && !row.includes('rotateRight'), '좌/우 두 버튼은 없다');
  }
  //  옛 이름(한 칸 돌리기)은 cpt CLI 를 위해 계속 받는다 — 화면만 새 경로를 쓴다.
  assert.equal(emu.ROTATE_KEYS.rotateLeft, -emu.ROTATE_KEYS.rotateRight);
});

// ★ 화면 잠금은 두 OS 가 같은 일이다 — 이름을 `lock` 으로 맞췄다(아이콘도 한 벌).
//  `power` 는 구 데몬/구 화면이 쓰던 옛 이름이라 계속 받는다.
test('★ 화면 잠금 키 이름이 두 OS 에서 같다', () => {
  const emu = require('../emulator');
  assert.ok(emu.ANDROID_KEY_ROW.includes('lock'), '안드로이드 버튼줄이 lock 을 쓴다');
  assert.ok(emu.IOS_KEY_ROW.includes('lock') && emu.IOS_KEY_ROW_IDB.includes('lock'));
  assert.equal(emu.ANDROID_KEYS.lock, 'KEYCODE_POWER');
  assert.equal(emu.ANDROID_KEYS.power, 'KEYCODE_POWER', '옛 이름도 계속 받는다');
  assert.ok(emu.IOS_SS_BUTTONS.lock, 'iOS 잠금은 전원 HID 다');
  //  idb 폴백은 회전을 못 한다 — 그 기계에서는 회전 버튼을 아예 안 그린다.
  assert.ok(!emu.IOS_KEY_ROW_IDB.includes('rotate'));
});

// ── 화면에 띄우기(cpt emulator show) ────────────────────────────────────────
// 2026-08-06: 에이전트가 에뮬레이터를 조작할 수는 있었는데 **사용자에게 보여 줄 수가 없었다**
//  (프리뷰·IDE 는 되는데 모바일 화면만 빠져 있었다 — 사용자가 손으로 탭을 열어야 했다).
//  기기 id 를 생략했을 때 무엇을 고르는가가 이 기능의 유일한 판단이라, 그것만 순수 함수로 고정한다.
test('★ 띄울 기기는 켜져 있는 것 중에서, 조작 가능한 쪽을 먼저 고른다', () => {
  const emu = require('../emulator');
  const off = { id: 'avd:Pixel_6', state: 'shutdown', caps: { input: false } };
  const viewOnly = { id: 'ios:AAA', state: 'booted', caps: { input: false } };
  const usable = { id: 'android:emulator-5554', state: 'booted', caps: { input: true } };
  //  꺼진 기기는 절대 고르지 않는다 — 띄워 봐야 검은 액자다("띄웠어요" 라 답하고 아무것도 안 보이는 것).
  assert.equal(emu.pickVisibleDevice([off]), null);
  assert.equal(emu.pickVisibleDevice([]), null);
  assert.equal(emu.pickVisibleDevice(null), null);
  //  조작까지 되는 기기가 있으면 그쪽 — 보여 주는 이유가 "만져 보라" 이기 때문이다.
  assert.equal(emu.pickVisibleDevice([off, viewOnly, usable]).id, 'android:emulator-5554');
  //  보기 전용뿐이면 그거라도 띄운다(안 띄우는 것보다 낫다).
  assert.equal(emu.pickVisibleDevice([off, viewOnly]).id, 'ios:AAA');
});

// 명령이 **네 곳에서 같은 이름**이어야 실제로 동작한다: CLI → 데몬 라우팅 → CAPABILITIES(터미널 AI
//  에게 보이는 목록) → 화면(uiCmds 신고). 하나라도 빠지면 조용히 실패한다 — 서버는 그 명령을 할 줄
//  아는 화면이 없다고 보고 그냥 안 보내거나, 보내 놓고 아무 일도 일어나지 않는다.
test('★ emulator show 가 CLI·라우팅·공개목록에 모두 있다', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
  assert.ok(/case 'ui\.emulatorOpen'/.test(src), '데몬이 ui.emulatorOpen 을 라우팅한다');
  assert.ok(/case 'ui\.emulatorClose'/.test(src), '데몬이 ui.emulatorClose 를 라우팅한다');
  assert.ok(/'ui\.emulatorOpen', 'ui\.emulatorClose'/.test(src), 'CAPABILITIES 에 공개돼 있다');
  const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js'), 'utf8');
  assert.ok(/c2 === 'show'/.test(cli) && /ui\.emulatorOpen/.test(cli), 'cpt emulator show');
  assert.ok(/c2 === 'hide'/.test(cli) && /ui\.emulatorClose/.test(cli), 'cpt emulator hide');
  const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'GUIDE.md'), 'utf8');
  assert.ok(/cpt emulator show/.test(guide), '에이전트 안내서에 적혀 있다(안 적으면 아무도 안 쓴다)');
});
