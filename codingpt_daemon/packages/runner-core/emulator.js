/**
 * emulator — 이 PC 에 붙어 있는 **모바일 화면**(안드로이드 에뮬레이터/실기기, iOS 시뮬레이터)을
 *  폰·태블릿에서 보고 조작하게 해 주는 RPC.
 *
 * 왜 영상이 아니라 **프레임 폴링**인가(사용자 확정 2026-08-05):
 *  · scrcpy 는 부드럽지만 바이너리 번들 + H.264 디코딩을 웹뷰에 얹어야 하고 iOS 를 아예 못 한다.
 *  · 우리가 필요한 건 "고친 화면이 어떻게 보이는지"이지 60fps 게임이 아니다.
 *  · 폴링은 **클라이언트가 당겨 간다** — 느린 회선에서 저절로 느려질 뿐 밀리지 않는다(푸시였다면
 *    프레임이 큐에 쌓여 지연이 눈덩이처럼 커진다).
 *
 * 좌표는 **0~1 정규화**로 주고받는다. 화면 크기를 클라이언트가 알 필요가 없고, 표시 배율·회전이
 *  달라도 어긋나지 않는다. 픽셀로 주고받으면 "폰에서 본 그림의 픽셀"과 "기기 실제 픽셀"이 갈린다.
 *
 * 입력 지원은 기기마다 다르다 — `caps.input` 으로 **정직하게** 알린다:
 *  · 안드로이드: `adb shell input` 으로 탭·스와이프·키·글자 전부 된다.
 *  · iOS 시뮬레이터: `simctl` 에는 탭 주입이 없다. `idb`(설치돼 있으면)로만 된다.
 *    없으면 보기 전용이라고 화면에 적는다 — 눌리는 척하다 아무 일도 안 일어나는 게 제일 나쁘다.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXEC_MAX = 24 * 1024 * 1024;     // screencap PNG 는 수 MB 까지 간다
const DEFAULT_TIMEOUT = 15000;

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: (opts && opts.timeoutMs) || DEFAULT_TIMEOUT,
      maxBuffer: EXEC_MAX,
      encoding: (opts && opts.encoding) === 'buffer' ? 'buffer' : 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve(stdout);
    });
  });
}

// ── 도구 찾기 ────────────────────────────────────────────────────────────────
// PATH 에만 기대면 안 된다 — 데몬은 로그인 셸이 아니라 **런치 에이전트**로도 뜨고, 그때 PATH 는
//  거의 비어 있다(터미널에서 되는데 앱에서만 안 되는 전형적 사고).
function androidHome() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(os.homedir(), 'Library', 'Android', 'sdk');
}
function firstExisting(cands) {
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch (_) { /* noop */ } }
  return null;
}
let toolCache = null;
function tools() {
  if (toolCache) return toolCache;
  const sdk = androidHome();
  toolCache = {
    adb: firstExisting([path.join(sdk, 'platform-tools', 'adb'), '/usr/local/bin/adb', '/opt/homebrew/bin/adb']),
    emulator: firstExisting([path.join(sdk, 'emulator', 'emulator'), '/usr/local/bin/emulator']),
    xcrun: firstExisting(['/usr/bin/xcrun']),
    sips: firstExisting(['/usr/bin/sips']),
    idb: firstExisting(['/usr/local/bin/idb', '/opt/homebrew/bin/idb', path.join(os.homedir(), '.local', 'bin', 'idb')]),
  };
  return toolCache;
}
/** 테스트용 — 도구 경로 캐시를 비운다(설치 직후 재조회). */
function _resetTools() { toolCache = null; }

// ── 목록 ─────────────────────────────────────────────────────────────────────

/** `adb devices -l` → 붙어 있는 안드로이드(에뮬레이터 + **실기기**). */
async function androidDevices() {
  const t = tools();
  if (!t.adb) return [];
  let out;
  try { out = await run(t.adb, ['devices', '-l']); } catch (_) { return []; }
  const rows = [];
  for (const line of String(out).split('\n').slice(1)) {
    const m = /^(\S+)\s+(device|offline|unauthorized)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const serial = m[1];
    const state = m[2];
    const model = /model:(\S+)/.exec(m[3] || '');
    const isEmu = /^emulator-\d+$/.test(serial);
    rows.push({
      id: `android:${serial}`,
      kind: 'android',
      name: (model ? model[1].replace(/_/g, ' ') : serial) + (isEmu ? '' : ' (실기기)'),
      state: state === 'device' ? 'booted' : state,
      physical: !isEmu,
      caps: { frame: state === 'device', input: state === 'device' },
    });
  }
  return rows;
}

/** 꺼져 있는 AVD — 목록에 보여야 켤 수 있다. */
async function androidAvds(booted) {
  const t = tools();
  if (!t.emulator) return [];
  let out;
  try { out = await run(t.emulator, ['-list-avds']); } catch (_) { return []; }
  // 이미 떠 있는 에뮬레이터의 AVD 이름은 adb 로 알 수 있다 — 중복 표시를 막는다.
  const running = new Set();
  for (const d of booted) {
    if (d.kind !== 'android' || d.physical) continue;
    const serial = d.id.slice('android:'.length);
    try {
      const n = await run(t.adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 4000 });
      running.add(String(n).split('\n')[0].trim());
    } catch (_) { /* 이름을 못 얻으면 중복이 보일 뿐 — 기능은 멀쩡하다 */ }
  }
  return String(out).split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((n) => !n.startsWith('INFO') && !running.has(n))
    .map((n) => ({
      id: `avd:${n}`, kind: 'android', name: n.replace(/_/g, ' '),
      state: 'shutdown', physical: false, caps: { frame: false, input: false },
    }));
}

/** iOS 시뮬레이터 — 켜져 있는 것 + 자주 쓰는 것. */
async function iosSimulators() {
  const t = tools();
  if (!t.xcrun) return [];
  let json;
  try { json = await run(t.xcrun, ['simctl', 'list', 'devices', 'available', '--json']); }
  catch (_) { return []; }
  let parsed;
  try { parsed = JSON.parse(json); } catch (_) { return []; }
  const canInput = !!t.idb;
  const rows = [];
  for (const runtime of Object.keys(parsed.devices || {})) {
    // "com.apple.CoreSimulator.SimRuntime.iOS-18-5" → "iOS 18.5"
    const rt = runtime.replace(/^.*SimRuntime\./, '').replace(/-/g, ' ').replace(/(\d+) (\d+)$/, '$1.$2');
    for (const d of parsed.devices[runtime] || []) {
      if (!d.isAvailable) continue;
      const booted = d.state === 'Booted';
      rows.push({
        id: `ios:${d.udid}`,
        kind: 'ios',
        name: `${d.name} · ${rt}`,
        state: booted ? 'booted' : 'shutdown',
        physical: false,
        caps: {
          frame: booted,
          // idb 가 없으면 **보기 전용**이다. 눌리는 척하는 것보다 못 한다고 말하는 게 낫다.
          input: booted && canInput,
          inputHint: canInput ? '' : 'iOS 시뮬레이터를 조작하려면 idb 가 필요해요 (brew install facebook/fb/idb-companion)',
        },
      });
    }
  }
  return rows;
}

/** 켜진 것 먼저, 그 다음 이름순. 사용자가 찾는 건 거의 항상 "지금 떠 있는 것"이다. */
function sortDevices(rows) {
  const rank = (d) => (d.state === 'booted' ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

async function list() {
  const t = tools();
  const android = await androidDevices();
  const [avds, ios] = await Promise.all([androidAvds(android), iosSimulators()]);
  return {
    devices: sortDevices([...android, ...avds, ...ios]),
    tools: { adb: !!t.adb, emulator: !!t.emulator, simctl: !!t.xcrun, idb: !!t.idb, resize: !!t.sips },
  };
}

// ── 켜기·끄기 ────────────────────────────────────────────────────────────────

function parseId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const scheme = s.slice(0, i);
  const value = s.slice(i + 1);
  if (!value) return null;
  // 셸을 거치지 않고 execFile 로만 부르지만, 인자 오염을 원천 차단한다.
  if (!/^[A-Za-z0-9._:@-]+$/.test(value)) return null;
  if (scheme !== 'android' && scheme !== 'avd' && scheme !== 'ios') return null;
  return { scheme, value };
}

async function boot(id) {
  const p = parseId(id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  if (p.scheme === 'avd') {
    if (!t.emulator) throw new Error('안드로이드 에뮬레이터를 찾을 수 없어요');
    // 켜는 데 수십 초가 걸린다 — 기다리지 않고 띄우기만 하고, 목록 갱신으로 확인하게 한다.
    const child = spawn(t.emulator, ['-avd', p.value, '-no-boot-anim'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, booting: true };
  }
  if (p.scheme === 'ios') {
    if (!t.xcrun) throw new Error('Xcode 명령줄 도구를 찾을 수 없어요');
    try { await run(t.xcrun, ['simctl', 'boot', p.value], { timeoutMs: 60000 }); }
    catch (e) {
      // 이미 켜져 있으면 simctl 이 실패로 끝난다 — 그건 실패가 아니다.
      if (!/current state: Booted/i.test(e.stderr || '')) throw e;
    }
    // 시뮬레이터 창을 띄운다(창이 없어도 스크린샷은 되지만, 사람이 직접 만질 수 있어야 한다).
    try { await run('/usr/bin/open', ['-a', 'Simulator'], { timeoutMs: 8000 }); } catch (_) { /* noop */ }
    return { ok: true, booting: true };
  }
  throw new Error('이미 켜져 있는 기기예요');
}

async function shutdown(id) {
  const p = parseId(id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  if (p.scheme === 'ios') {
    await run(t.xcrun, ['simctl', 'shutdown', p.value], { timeoutMs: 30000 });
    return { ok: true };
  }
  if (p.scheme === 'android') {
    if (p.value.startsWith('emulator-')) { await run(t.adb, ['-s', p.value, 'emu', 'kill'], { timeoutMs: 10000 }); return { ok: true }; }
    // 실기기는 우리가 끌 일이 아니다(사용자 폰을 끄는 셈).
    throw new Error('실기기는 여기서 끌 수 없어요');
  }
  throw new Error('꺼져 있는 기기예요');
}

// ── 프레임 ───────────────────────────────────────────────────────────────────

function tmpFile(ext) {
  const dir = path.join(os.homedir(), '.codingpt', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `emu-${process.pid}-${Math.floor(Math.random() * 1e9)}.${ext}`);
}

/**
 * PNG 원본 → 화면에 보낼 JPEG.
 *  sips 가 없으면(비-macOS) **원본 PNG 를 그대로** 보낸다 — 느릴 뿐 안 보이는 것보다 낫다.
 */
async function toJpeg(imgBuf, ext, maxWidth, quality) {
  const t = tools();
  const passthroughMime = ext === 'bmp' ? 'image/bmp' : 'image/png';
  if (!t.sips) return { mime: passthroughMime, buf: imgBuf };   // 비-macOS: 느릴 뿐, 안 보이는 것보다 낫다
  const src = tmpFile(ext);
  const dst = tmpFile('jpg');
  try {
    fs.writeFileSync(src, imgBuf);
    const args = [];
    // BMP 는 이미 우리가 줄여 놓았다 — 다시 줄이면 두 번 깎여 흐려진다.
    if (ext !== 'bmp') args.push('-Z', String(Math.max(120, Math.min(2000, maxWidth || 480))));
    args.push('-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(Math.max(20, Math.min(95, quality || 60))),
      src, '--out', dst);
    await run(t.sips, args, { timeoutMs: 12000 });
    return { mime: 'image/jpeg', buf: fs.readFileSync(dst) };
  } catch (_) {
    return { mime: passthroughMime, buf: imgBuf };
  } finally {
    for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
  }
}

/** PNG 헤더에서 크기 — 정규화 좌표를 픽셀로 되돌릴 때 쓴다(별도 명령 없이 공짜로 얻는다). */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * 안드로이드 `screencap`(압축 없는 raw) 파서.
 *
 * ★ 왜 `-p`(PNG) 를 안 쓰나 — **폰이 PNG 를 압축하느라 느리다.** 실측(SM-N960N, 1440x2960):
 *    `screencap -p` 2.68s / `screencap`(raw) 1.29s. raw 는 17MB 로 2.4배 크지만 USB 는
 *    13MB/s 라 전송이 1.3초, 나머지 1.4초가 전부 기기 안 PNG 인코딩이었다. 즉 **더 많이 보내는
 *    쪽이 더 빠르다**. (짐작이 아니라 두 경로를 각각 재서 나온 결론이다.)
 *
 * 헤더는 w,h,format(각 4B LE) + 안드로이드 13+ 는 colorspace 4B 가 더 붙는다 →
 *  전체 길이에서 역산해 헤더 크기를 정한다(버전 분기보다 정확하다).
 */
function parseRawScreencap(buf) {
  if (!buf || buf.length < 16) return null;
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  if (!w || !h || w > 20000 || h > 20000) return null;
  const head = buf.length - w * h * 4;
  if (head !== 12 && head !== 16) return null;   // RGBA_8888 이 아니다(다른 포맷은 다루지 않는다)
  return { w, h, offset: head, data: buf };
}

/**
 * raw RGBA → 24비트 BMP(축소 포함). sips 는 raw 를 못 읽지만 BMP 는 읽는다.
 *  축소를 **여기서** 하는 이유: 17MB 를 그대로 BMP 로 쓰면 디스크에 17MB 를 쓰고 sips 가 그걸
 *  다시 읽는다. 최근접 축소는 곱셈 몇 번이라 사실상 공짜고, 파일이 1/9 로 줄어든다.
 */
function rawToBmp(raw, maxWidth) {
  const cap = Math.max(120, Math.min(2000, maxWidth || 480));
  const scale = raw.w > cap ? cap / raw.w : 1;
  const ow = Math.max(1, Math.round(raw.w * scale));
  const oh = Math.max(1, Math.round(raw.h * scale));
  const rowBytes = (ow * 3 + 3) & ~3;            // BMP 는 줄마다 4바이트 정렬
  const pixBytes = rowBytes * oh;
  const out = Buffer.alloc(54 + pixBytes);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(54 + pixBytes, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(ow, 18);
  out.writeInt32LE(oh, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixBytes, 34);
  const src = raw.data;
  const off = raw.offset;
  // ★ 최근접(가장 가까운 픽셀 하나만 집기)이 아니라 **박스 평균**이다. 실측: 최근접으로 줄이면
  //   계단 노이즈가 생겨 JPEG 가 그걸 "디테일"로 알고 열심히 저장한다 — 같은 화면이 41KB → 185KB
  //   로 4.5배가 됐다(게다가 더 못생겼다). 평균은 곱셈 몇 번 더 하고 용량을 1/4 로 줄인다.
  const bx = Math.max(1, Math.floor(raw.w / ow));
  const by = Math.max(1, Math.floor(raw.h / oh));
  const area = bx * by;
  for (let y = 0; y < oh; y++) {
    const sy0 = Math.min(raw.h - by, Math.floor(y / scale));
    const dstRow = 54 + (oh - 1 - y) * rowBytes;   // BMP 는 아래에서 위로 쌓인다
    for (let x = 0; x < ow; x++) {
      const sx0 = Math.min(raw.w - bx, Math.floor(x / scale));
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < by; dy++) {
        let si = off + (sy0 + dy) * raw.w * 4 + sx0 * 4;
        for (let dx = 0; dx < bx; dx++) { r += src[si]; g += src[si + 1]; b += src[si + 2]; si += 4; }
      }
      const di = dstRow + x * 3;
      out[di] = (b / area) | 0;
      out[di + 1] = (g / area) | 0;
      out[di + 2] = (r / area) | 0;
    }
  }
  return out;
}

const lastSize = new Map();   // id → {w,h} — 입력 좌표 환산용(프레임을 본 적 있어야 조작한다)

async function frame(args) {
  const p = parseId(args && args.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  let png = null;
  let bmp = null;
  let size = null;
  if (p.scheme === 'android') {
    if (!t.adb) throw new Error('adb 를 찾을 수 없어요');
    // raw 로 받아 여기서 축소한다(왜 PNG 가 아닌지는 parseRawScreencap 주석 — 실측 2.7s → 1.3s).
    const buf = await run(t.adb, ['-s', p.value, 'exec-out', 'screencap'], { encoding: 'buffer', timeoutMs: 25000 });
    const raw = parseRawScreencap(buf);
    if (raw) {
      size = { w: raw.w, h: raw.h };
      bmp = rawToBmp(raw, args && args.maxWidth);
    } else {
      // 포맷이 낯설다(RGBA_8888 이 아님) → PNG 경로로 물러선다. 느리지만 확실하다.
      png = await run(t.adb, ['-s', p.value, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeoutMs: 25000 });
    }
  } else if (p.scheme === 'ios') {
    if (!t.xcrun) throw new Error('Xcode 명령줄 도구를 찾을 수 없어요');
    const out = tmpFile('png');
    try {
      await run(t.xcrun, ['simctl', 'io', p.value, 'screenshot', '--type=png', out], { timeoutMs: 20000 });
      png = fs.readFileSync(out);
    } finally { try { fs.unlinkSync(out); } catch (_) { /* noop */ } }
  } else {
    throw new Error('꺼져 있는 기기예요 — 먼저 켜 주세요');
  }
  if (!size) size = pngSize(png);
  if (size) lastSize.set(args.id, size);
  const img = bmp
    ? await toJpeg(bmp, 'bmp', args && args.maxWidth, args && args.quality)
    : await toJpeg(png, 'png', args && args.maxWidth, args && args.quality);
  return {
    mime: img.mime,
    base64: img.buf.toString('base64'),
    width: size ? size.w : 0,
    height: size ? size.h : 0,
    bytes: img.buf.length,
  };
}

// ── 입력 ─────────────────────────────────────────────────────────────────────

/** 화면 크기(픽셀) — 프레임에서 이미 봤으면 그 값을, 아니면 기기에 물어본다. */
async function screenSize(id, p) {
  const hit = lastSize.get(id);
  if (hit) return hit;
  const t = tools();
  if (p.scheme === 'android') {
    const out = await run(t.adb, ['-s', p.value, 'shell', 'wm', 'size'], { timeoutMs: 8000 });
    const m = /(\d+)x(\d+)/.exec(String(out).split('\n').reverse().join('\n'));
    if (m) { const s = { w: +m[1], h: +m[2] }; lastSize.set(id, s); return s; }
  }
  throw new Error('화면 크기를 알 수 없어요 — 화면을 한 번 불러온 뒤 조작해 주세요');
}

/** 0~1 → 픽셀. 범위를 벗어난 값은 잘라 낸다(밖을 누르면 기기가 이상하게 반응한다). */
function px(n, max) {
  const v = Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * max);
  return Math.max(0, Math.min(max - 1, v));
}

// 화면에 보이는 버튼만 — 임의 keyevent 를 열어 두면 전원·공장초기화까지 닿는다.
const ANDROID_KEYS = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER', del: 'KEYCODE_DEL', tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE',
  volumeUp: 'KEYCODE_VOLUME_UP', volumeDown: 'KEYCODE_VOLUME_DOWN', power: 'KEYCODE_POWER',
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
};
const IOS_BUTTONS = { home: 'HOME', lock: 'LOCK', siri: 'SIRI', appSwitch: 'APPLE_PAY' };

async function input(args) {
  const a = args || {};
  const p = parseId(a.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  const type = String(a.type || '');

  if (p.scheme === 'android') {
    if (!t.adb) throw new Error('adb 를 찾을 수 없어요');
    const adb = (rest, timeoutMs) => run(t.adb, ['-s', p.value, 'shell', ...rest], { timeoutMs: timeoutMs || 10000 });
    if (type === 'tap' || type === 'longPress') {
      const s = await screenSize(a.id, p);
      const x = px(a.x, s.w); const y = px(a.y, s.h);
      if (type === 'tap') await adb(['input', 'tap', String(x), String(y)]);
      else await adb(['input', 'swipe', String(x), String(y), String(x), String(y), '600']);
      return { ok: true };
    }
    if (type === 'swipe') {
      const s = await screenSize(a.id, p);
      const ms = Math.max(30, Math.min(3000, Number(a.durationMs) || 220));
      await adb(['input', 'swipe', String(px(a.x, s.w)), String(px(a.y, s.h)),
        String(px(a.x2, s.w)), String(px(a.y2, s.h)), String(ms)]);
      return { ok: true };
    }
    if (type === 'key') {
      const code = ANDROID_KEYS[String(a.key || '')];
      if (!code) throw new Error('보낼 수 없는 키예요');
      await adb(['input', 'keyevent', code]);
      return { ok: true };
    }
    if (type === 'text') {
      const s = String(a.text || '');
      if (!s) return { ok: true };
      // `input text` 는 공백을 %s 로 받고 일부 기호를 못 넣는다. 나눠 보내고 공백은 키로.
      for (const part of s.split(' ')) {
        if (part) await adb(['input', 'text', part]);
        await adb(['input', 'keyevent', 'KEYCODE_SPACE']);
      }
      return { ok: true };
    }
    throw new Error('알 수 없는 입력이에요');
  }

  if (p.scheme === 'ios') {
    if (!t.idb) {
      // 정직하게 못 한다고 말한다 — 조용히 성공을 돌려주면 사용자는 기기가 멈춘 줄 안다.
      throw new Error('iOS 시뮬레이터 조작에는 idb 가 필요해요 (brew install facebook/fb/idb-companion)');
    }
    const s = await screenSize(a.id, p).catch(() => null);
    const dev = ['--udid', p.value];
    if (type === 'tap' || type === 'longPress') {
      if (!s) throw new Error('화면을 한 번 불러온 뒤 조작해 주세요');
      const args2 = ['ui', 'tap', ...dev, String(px(a.x, s.w)), String(px(a.y, s.h))];
      if (type === 'longPress') args2.push('--duration', '0.6');
      await run(t.idb, args2, { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'swipe') {
      if (!s) throw new Error('화면을 한 번 불러온 뒤 조작해 주세요');
      await run(t.idb, ['ui', 'swipe', ...dev,
        String(px(a.x, s.w)), String(px(a.y, s.h)), String(px(a.x2, s.w)), String(px(a.y2, s.h))], { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'key') {
      const btn = IOS_BUTTONS[String(a.key || '')];
      if (!btn) throw new Error('보낼 수 없는 키예요');
      await run(t.idb, ['ui', 'button', ...dev, btn], { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'text') {
      await run(t.idb, ['ui', 'text', ...dev, String(a.text || '')], { timeoutMs: 10000 });
      return { ok: true };
    }
    throw new Error('알 수 없는 입력이에요');
  }
  throw new Error('꺼져 있는 기기예요 — 먼저 켜 주세요');
}

/** 주소 열기 — 딥링크·프리뷰 확인에 쓴다(탭이 안 되는 iOS 에서도 이건 된다). */
async function openUrl(args) {
  const p = parseId(args && args.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const url = String((args && args.url) || '');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) throw new Error('주소가 올바르지 않아요');
  const t = tools();
  if (p.scheme === 'android') {
    await run(t.adb, ['-s', p.value, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url], { timeoutMs: 15000 });
    return { ok: true };
  }
  if (p.scheme === 'ios') {
    await run(t.xcrun, ['simctl', 'openurl', p.value, url], { timeoutMs: 15000 });
    return { ok: true };
  }
  throw new Error('꺼져 있는 기기예요 — 먼저 켜 주세요');
}

/** RPC 진입점 — 유닉스 소켓(cpt)과 백엔드 릴레이(control.js)가 **둘 다** 여기로 온다. */
async function handle(method, params) {
  const m = String(method || '');
  if (m === 'emulator.list') return list();
  if (m === 'emulator.boot') return boot(params && params.id);
  if (m === 'emulator.shutdown') return shutdown(params && params.id);
  if (m === 'emulator.frame') return frame(params);
  if (m === 'emulator.input') return input(params);
  if (m === 'emulator.openUrl') return openUrl(params);
  throw new Error(`알 수 없는 메서드: ${m}`);
}

module.exports = {
  handle, list, boot, shutdown, frame, input, openUrl,
  // 테스트용
  _parseId: parseId, _px: px, _pngSize: pngSize, _resetTools, _tools: tools,
  _parseRawScreencap: parseRawScreencap, _rawToBmp: rawToBmp,
  _lastSize: lastSize, _sortDevices: sortDevices,
  ANDROID_KEYS, IOS_BUTTONS,
};
