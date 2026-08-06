/**
 * emulator — 이 PC 에 붙어 있는 **모바일 화면**(안드로이드 에뮬레이터/실기기, iOS 시뮬레이터)을
 *  폰·태블릿에서 보고 조작하게 해 주는 RPC.
 *
 * 화면을 얻는 길은 **둘**이고, 어느 쪽이든 바이트 계약은 같다([플래그 1바이트][Annex-B H.264]):
 *  · 라이브 영상 — 안드로이드는 scrcpy, iOS 는 serve-sim(시뮬레이터 프레임버퍼). 부드럽고 즉시다.
 *  · 프레임 폴링 — 위가 안 되는 환경(구형 웹뷰·인텔 맥 등)의 폴백. 클라이언트가 한 장씩 당겨 간다.
 *    느린 회선에서 저절로 느려질 뿐 밀리지 않는다(푸시였다면 지연이 눈덩이처럼 커진다).
 *
 * 좌표는 **0~1 정규화**로 주고받는다. 화면 크기를 클라이언트가 알 필요가 없고, 표시 배율·회전이
 *  달라도 어긋나지 않는다. 픽셀로 주고받으면 "폰에서 본 그림의 픽셀"과 "기기 실제 픽셀"이 갈린다.
 *  ★ iOS 는 여기에 더해 **표시 픽셀과 입력 단위가 다르다**(픽셀 vs 포인트) — 그래서 입력 좌표계
 *   캐시(inputSize)를 표시 크기(lastSize)와 따로 둔다. serve-sim 경로는 정규화 그대로라 환산이 없다.
 *
 * 입력 지원은 기기마다 다르다 — `caps.input` 으로 **정직하게** 알린다:
 *  · 안드로이드: scrcpy 컨트롤 소켓(빠름) → `adb shell input`(폴백).
 *  · iOS 시뮬레이터: serve-sim HID(항상 열려 있는 WS, 즉시) → idb(폴백, 탭마다 프로세스 기동).
 *    둘 다 없으면 보기 전용이라고 화면에 적는다 — 눌리는 척하다 아무 일도 안 일어나는 게 제일 나쁘다.
 */
//  ⚠ `spawn` 을 구조분해로 꺼내 두지 않는다 — 그러면 테스트가 stub 을 끼울 수 없고, 실제로
//   "부팅 계약을 확인하는 테스트가 진짜 에뮬레이터를 띄우는" 사고가 났다(2026-08-05).
const cp = require('child_process');
const { execFile } = cp;
const zlib = require('zlib');
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
      ...((opts && opts.env) ? { env: opts.env } : {}),
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
    //  우리가 만들어 둔 전용 venv 를 **먼저** 본다 — 시스템 파이썬을 더럽히지 않고 설치하는 위치라
    //   여기 있는 게 우리가 버전을 아는 유일한 idb 다(fb-idb 는 파이썬 패키지다).
    idb: firstExisting([
      path.join(os.homedir(), '.codingpt', 'idb', 'bin', 'idb'),
      '/usr/local/bin/idb', '/opt/homebrew/bin/idb', path.join(os.homedir(), '.local', 'bin', 'idb'),
    ]),
    //  ★ idb 는 **혼자 못 돈다** — 파이썬 CLI 는 실제 작업을 `idb_companion`(brew 로 깔리는 네이티브
    //   바이너리)에 시키고, 그 위치를 `shutil.which("idb_companion")` 로 **PATH 에서만** 찾는다.
    //   앱이 띄운 데몬의 PATH 는 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이라(2026-08-06 실사고) 애플
    //   실리콘의 /opt/homebrew/bin 이 안 보이고, idb 는 "/usr/local/bin/idb_companion 없음" 으로
    //   죽는다. 터미널에서만 되고 앱에서는 안 되던 진짜 이유. → 우리가 찾아서 PATH 에 얹어 준다.
    idbCompanion: firstExisting([
      '/opt/homebrew/bin/idb_companion', '/usr/local/bin/idb_companion',
      path.join(os.homedir(), '.codingpt', 'idb', 'bin', 'idb_companion'),
    ]),
  };
  return toolCache;
}
/** 테스트용 — 도구 경로 캐시를 비운다(설치 직후 재조회). */
function _resetTools() { toolCache = null; }

/** idb 는 이 둘이 **모두** 있어야 동작한다 — 하나만 있으면 조작은 100% 실패한다. */
function idbReady(t) { return !!(t.idb && t.idbCompanion); }

/**
 * idb 실행 — companion 이 있는 디렉터리를 PATH 앞에 얹는다.
 *  (PATH 를 통째로 갈아끼우지 않고 앞에만 붙인다 — 사용자가 자기 PATH 로 다른 companion 을
 *   쓰고 있을 수도 있지만, 우리가 찾은 게 확실히 존재하는 것이므로 우선한다.)
 */
function idbEnv(t, base) {
  const env = { ...(base || process.env) };
  if (!t || !t.idbCompanion) return env;
  const dir = path.dirname(t.idbCompanion);
  env.PATH = `${dir}${env.PATH ? `:${env.PATH}` : ''}`;
  return env;
}
function idbRun(args, opts) {
  const t = tools();
  return run(t.idb, args, { ...(opts || {}), env: idbEnv(t) });
}

// ── 목록 ─────────────────────────────────────────────────────────────────────

/**
 * `adb devices -l` → 붙어 있는 안드로이드(에뮬레이터 + **실기기**).
 *
 * ★ 에뮬레이터 행에는 `avdName` 을 반드시 실어 준다(2026-08-05 실사고). 꺼진 AVD 는 `avd:Pixel_9a`,
 *  켜지면 `android:emulator-5554` 로 **id 자체가 바뀐다**. 그래서 "켜기"를 누른 화면은 자기가 고른
 *  id 가 목록에서 사라진 채 남아 영원히 '꺼짐' 으로 보였다. 클라이언트가 새 행을 따라가려면
 *  두 행을 잇는 이름이 필요하다.
 */
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
      caps: { frame: state === 'device', input: state === 'device', keys: ANDROID_KEY_ROW },
    });
  }
  // 에뮬레이터의 AVD 이름 — 목록 중복 제거와 "켜기 후 따라가기" 가 **같은 근거**를 쓰게 한 번만 묻는다.
  await Promise.all(rows.map(async (d) => {
    if (d.physical || d.state !== 'booted') return;
    const serial = d.id.slice('android:'.length);
    try {
      const n = await run(t.adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 4000 });
      const name = String(n).split('\n')[0].trim();
      if (name && !/^(KO|error)/i.test(name)) d.avdName = name;
    } catch (_) { /* 이름을 못 얻으면 클라이언트가 '새로 나타난 에뮬레이터' 로 폴백한다 */ }
  }));
  return rows;
}

/** 꺼져 있는 AVD — 목록에 보여야 켤 수 있다. */
async function androidAvds(booted) {
  const t = tools();
  if (!t.emulator) return [];
  let out;
  try { out = await run(t.emulator, ['-list-avds']); } catch (_) { return []; }
  // 이미 떠 있는 에뮬레이터는 androidDevices 가 avdName 을 붙여 왔다 — 중복 표시를 막는다.
  const running = new Set(booted.map((d) => d.avdName).filter(Boolean));
  return String(out).split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((n) => !n.startsWith('INFO') && !running.has(n))
    .map((n) => ({
      id: `avd:${n}`, kind: 'android', name: n.replace(/_/g, ' '), avdName: n,
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
  //  ★ serve-sim 이 있으면 idb 없이도 조작된다(우리가 번들한다) — idb 는 글자 입력용 폴백으로만 남는다.
  const canInput = serveSim().available() || idbReady(t);
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
          //  조작할 방법이 하나도 없으면 **보기 전용**이라고 적는다 — 눌리는 척하다 아무 일도
          //  안 일어나는 게 제일 나쁘다.
          input: booted && canInput,
          keys: serveSim().available() ? IOS_KEY_ROW : IOS_KEY_ROW_IDB,
          //  이제 조작은 우리가 번들한 serve-sim 이 한다. 그게 못 도는 환경(인텔 맥 등)에서만
          //  idb 를 안내한다 — 무엇이 빠졌는지까지 말해 준다.
          inputHint: canInput ? ''
            : (t.idb && !t.idbCompanion)
              ? 'iOS 조작에 필요한 idb_companion 을 찾지 못했어요 (brew install facebook/fb/idb-companion)'
              : 'iOS 시뮬레이터 조작은 Apple 실리콘 Mac 에서만 돼요 (또는 brew install facebook/fb/idb-companion)',
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
    //  idb 는 companion 까지 있어야 "있다" 고 말한다 — 반쪽 설치를 초록불로 보여 주면 안 된다.
    tools: {
      adb: !!t.adb, emulator: !!t.emulator, simctl: !!t.xcrun, resize: !!t.sips,
      //  idb 는 companion 까지 있어야 "있다" 고 말한다 — 반쪽 설치를 초록불로 보여 주면 안 된다.
      idb: idbReady(t), serveSim: serveSim().available(),
    },
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
    const child = cp.spawn(t.emulator, ['-avd', p.value, '-no-boot-anim'], { detached: true, stdio: 'ignore' });
    child.unref();
    //  ★ avdName 을 돌려준다: 켜지면 이 기기의 id 가 `android:emulator-N` 으로 **바뀌므로**,
    //   화면은 이 이름으로 새 행을 찾아 따라가야 한다(안 그러면 영원히 '꺼짐' 이다).
    return { ok: true, booting: true, avdName: p.value };
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
    //  iOS 는 id(udid)가 그대로다 — 따라갈 필요가 없다.
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
/**
 * @param {{w:number,h:number}|null} srcSize 원본 픽셀 크기(알면 넘긴다). 넓히기를 막는 근거다.
 *
 * ★ 예전엔 `sips -Z` 를 썼다(2026-08-06 실사고). `-Z` 는 **긴 변**을 맞춘다 —
 *  세로 폰(1179x2556)에 maxWidth=480 을 주면 가로는 480x(1179/2556)= **221px** 이 된다.
 *  "480 을 보내고 있다" 고 믿은 화면이 실제로는 221px 이었고, 그걸 레티나에서 늘려 그리니
 *  글씨가 안 읽혔다. 가로를 맞추려면 `--resampleWidth` 여야 한다.
 */
async function toJpeg(imgBuf, ext, maxWidth, quality, srcSize) {
  const t = tools();
  const passthroughMime = ext === 'bmp' ? 'image/bmp' : 'image/png';
  if (!t.sips) return { mime: passthroughMime, buf: imgBuf };   // 비-macOS: 느릴 뿐, 안 보이는 것보다 낫다
  const src = tmpFile(ext);
  const dst = tmpFile('jpg');
  try {
    fs.writeFileSync(src, imgBuf);
    const args = [];
    // BMP 는 이미 우리가 줄여 놓았다 — 다시 줄이면 두 번 깎여 흐려진다.
    const want = Math.max(120, Math.min(2000, maxWidth || 480));
    //  원본보다 크게 요청하면 늘리지 않는다 — 늘려 봐야 용량만 커지고 더 선명해지지 않는다.
    if (ext !== 'bmp' && (!srcSize || srcSize.w > want)) args.push('--resampleWidth', String(want));
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
 * 왜 `-p`(PNG) 가 아니라 raw 인가 — raw 는 픽셀 배열이라 우리가 **그대로 줄여 쓸 수 있다**(PNG 는
 *  디코더가 필요하다). 전송량 문제는 기기 안 gzip 으로 푼다(androidRaw 주석에 실측이 있다).
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

const lastSize = new Map();   // id → {w,h} — **표시** 픽셀 크기(프레임이 알려 준다)
//  id → {w,h} — **입력** 좌표계. iOS 는 포인트라 표시 픽셀과 다르다(위 screenSize 주석 참고).
//  절대 lastSize 와 합치지 말 것: 합치는 순간 프레임이 입력 좌표를 덮어써 조작이 통째로 죽는다.
const inputSize = new Map();

/**
 * 기기별 화면 캡처 방식 — serial → 'gzip' | 'raw'. 한 번 정하면 유지한다(매 프레임 탐색 금지).
 */
const capMode = new Map();

/**
 * 안드로이드 화면 한 장(raw RGBA).
 *
 * ★ **기기 안에서 gzip 으로 눌러서 가져온다.** 실측(SM-N960N 1440x2960, USB):
 *
 *    화면        raw          png          raw|gzip -1
 *    다크 UI    1288ms 16.3MB  439ms 0.1MB   297ms 0.05MB   ← 4.3배
 *    컬러풀     1227ms 16.3MB  908ms 1.6MB   719ms 2.7MB    ← 1.7배
 *
 *  이전 주석은 "더 많이 보내는 쪽(raw)이 더 빠르다 — PNG 인코딩이 2.68s" 라고 적어 두었는데,
 *  같은 기기에서 다시 재니 PNG 는 0.44~0.91s 였다. 그때 무엇을 쟀든 **지금은 틀린 전제**다.
 *  raw 가 느린 이유는 단순하다: 16.3MB 를 USB 로 밀어야 한다(≈1.2s). gzip 은 그 16.3MB 를
 *  기기에서 0.05~2.7MB 로 줄이고, 압축 비용은 PNG 인코딩보다 훨씬 싸다. 푸는 값은 node 에서
 *  4ms 다(실측). 그래서 **화면이 단순하든 복잡하든** gzip 이 이긴다.
 *
 *  ⚠ `toybox gzip` 이 없는 기기가 있을 수 있다 → 첫 시도의 매직바이트로 판정하고, 아니면
 *   그 기기는 영원히 raw 로 간다(매 프레임 두 번 왕복하는 것이 제일 나쁘다).
 */
async function androidRaw(adb, serial) {
  if (capMode.get(serial) !== 'raw') {
    try {
      const gz = await run(adb, ['-s', serial, 'exec-out', 'sh', '-c', 'screencap | toybox gzip -1'],
        { encoding: 'buffer', timeoutMs: 25000 });
      if (gz && gz.length > 2 && gz[0] === 0x1f && gz[1] === 0x8b) {
        const buf = zlib.gunzipSync(gz, { maxOutputLength: EXEC_MAX * 4 });
        capMode.set(serial, 'gzip');
        return buf;
      }
    } catch (_) { /* 아래 raw 로 물러선다 */ }
    capMode.set(serial, 'raw');
  }
  return run(adb, ['-s', serial, 'exec-out', 'screencap'], { encoding: 'buffer', timeoutMs: 25000 });
}

async function frame(args) {
  const p = parseId(args && args.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  let png = null;
  let bmp = null;
  let size = null;
  if (p.scheme === 'android') {
    if (!t.adb) throw new Error('adb 를 찾을 수 없어요');
    // raw 로 받아 여기서 축소한다(가져오는 방법과 그 실측은 androidRaw 주석).
    const buf = await androidRaw(t.adb, p.value);
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
    ? await toJpeg(bmp, 'bmp', args && args.maxWidth, args && args.quality, size)
    : await toJpeg(png, 'png', args && args.maxWidth, args && args.quality, size);
  return {
    mime: img.mime,
    base64: img.buf.toString('base64'),
    width: size ? size.w : 0,
    height: size ? size.h : 0,
    bytes: img.buf.length,
  };
}

// ── 입력 ─────────────────────────────────────────────────────────────────────

/**
 * 조작 좌표계의 크기. **표시 크기(lastSize)와 절대 섞지 않는다.**
 *
 * ★ 안드로이드와 iOS 는 단위가 다르다(2026-08-06 실사고):
 *  · adb 는 기기 픽셀을 받는다 → 스크린샷 픽셀과 같은 좌표계라 lastSize 를 그대로 써도 된다.
 *  · idb 는 **포인트**를 받는다(iPhone 16 = 393x852). 스크린샷은 1179x2556 픽셀이라,
 *    픽셀을 그대로 넘기면 3배 밖을 눌러 **아무 일도 안 일어난다** — idb 는 rc=0 을 돌려주므로
 *    조용한 실패가 된다.
 *
 * ★★ 그리고 두 번째 실사고(같은 날): 포인트를 `lastSize` 에 캐시했더니 **frame() 이 그 자리에
 *  픽셀을 덮어썼다**. 실사용 순서는 항상 "화면 먼저 → 조작" 이라, 고친 좌표는 첫 프레임과 함께
 *  사라지고 iOS 는 여전히 조작이 안 됐다. 내 검증이 프레임 없이 새 프로세스에서 돌아 통과했던 것.
 *  → iOS 입력 좌표계는 **전용 캐시**(inputSize)에 둔다. 표시 크기와 절대 같은 칸을 쓰지 않는다.
 */
async function screenSize(id, p) {
  const t = tools();
  if (p.scheme === 'ios') {
    const hitPt = inputSize.get(id);
    if (hitPt) return hitPt;
    if (idbReady(t)) {
      try {
        const out = await idbRun(['describe', '--udid', p.value, '--json'], { timeoutMs: 20000 });
        const s2 = pointsFromIdbDescribe(out);
        if (s2) { inputSize.set(id, s2); return s2; }
      } catch (_) { /* 아래 오류로 떨어진다 */ }
    }
    throw new Error('화면 크기를 알 수 없어요 — 화면을 한 번 불러온 뒤 조작해 주세요');
  }
  const hit = lastSize.get(id);
  if (hit) return hit;
  if (p.scheme === 'android') {
    const out = await run(t.adb, ['-s', p.value, 'shell', 'wm', 'size'], { timeoutMs: 8000 });
    const m = /(\d+)x(\d+)/.exec(String(out).split('\n').reverse().join('\n'));
    if (m) { const s = { w: +m[1], h: +m[2] }; lastSize.set(id, s); return s; }
  }
  throw new Error('화면 크기를 알 수 없어요 — 화면을 한 번 불러온 뒤 조작해 주세요');
}

/**
 * `idb describe --json` 에서 **포인트** 크기를 꺼낸다.
 *  픽셀(width/height)이 아니라 width_points/height_points 여야 한다 — 배율로 나누지 않는 이유는
 *  기기마다 2배/3배가 다르고, idb 가 정답을 이미 알려 주기 때문이다.
 */
function pointsFromIdbDescribe(out) {
  let j = null;
  try { j = JSON.parse(String(out)); } catch (_) { return null; }
  const d = (j && j.screen_dimensions) || {};
  const w = Number(d.width_points), h = Number(d.height_points);
  return (w > 0 && h > 0) ? { w, h } : null;
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
//  ★ `appSwitch: 'APPLE_PAY'` 라는 옛 항목은 **거짓말**이었다 — APPLE_PAY 는 앱 전환이 아니라
//   측면 버튼 두 번(페이) 이다. iOS 시뮬레이터에는 앱 전환 버튼 자체가 없다.
const IOS_BUTTONS = { home: 'HOME', lock: 'LOCK', siri: 'SIRI', sideButton: 'SIDE_BUTTON', applePay: 'APPLE_PAY' };

/**
 * 이 기기가 **실제로 받는** 버튼 목록. 화면은 이 목록만 그린다.
 *  (안 그러면 iOS 에서 안드로이드 3버튼이 그려지고, '뒤로'·'최근 앱' 을 누를 때마다
 *   "보낼 수 없는 키예요" 오류만 나온다 — 2026-08-06 실사고.)
 */
//  순서 = 화면에 그릴 순서(왼쪽부터). 자리가 모자라면 화면이 뒤쪽부터 접는다.
const ANDROID_KEY_ROW = ['back', 'home', 'recents', 'rotateLeft', 'rotateRight', 'volumeUp', 'volumeDown', 'power'];
//  ★ 되는 것만 그린다(실측으로 하나씩 확인했다). Siri 는 시뮬레이터에서 뜨지 않아 뺐다.
//
//  ★★ 회전은 **한 번 잘못 빼고 되살렸다**(2026-08-06). 처음엔 "serve-sim 이 접수했다고 답하는데
//   화면은 그대로" 라고 판정했는데, 그 근거가 **스크린샷 픽셀 크기**였다. iOS 시뮬레이터는 회전해도
//   프레임버퍼 크기가 1206x2622 그대로고 **내용만 돈다** — 안드로이드(1080x2400 ↔ 2400x1080)와
//   달라서 같은 잣대를 쓴 게 틀렸다. 그림을 눈으로 보니 멀쩡히 돌아 있었다. Simulator 앱의
//   'Rotate Left' 메뉴로 대조해도 똑같이 크기는 그대로였다(= 크기는 회전의 증거가 아니다).
//  ★ 어떤 버튼을 그릴지는 **그 PC 에서 어느 경로가 살아 있는지**에 달렸다. idb 폴백은 볼륨을
//   아예 못 보낸다(idb 의 버튼 어휘는 HOME/LOCK/SIRI/SIDE_BUTTON/APPLE_PAY 뿐) — serve-sim 이
//   없는 기계에 볼륨 버튼을 그려 놓으면 누를 때마다 오류만 난다.
const IOS_KEY_ROW = ['home', 'rotateLeft', 'rotateRight', 'lock', 'volumeUp', 'volumeDown'];
//  idb 폴백은 회전도 볼륨도 못 한다(어휘에 HOME/LOCK/SIRI/SIDE_BUTTON/APPLE_PAY 뿐).
const IOS_KEY_ROW_IDB = ['home', 'lock'];

/**
 * 손가락을 따라가는 입력의 단계.
 *  begin=눌렀다 · move=끄는 중 · end=뗐다. 좌표는 **절대값(0~1)** 이라 중간 move 를 몇 개
 *  흘려도 화면이 어긋나지 않는다(느린 회선에서 마음 놓고 버릴 수 있다는 뜻이다 — H.264 델타와
 *  정반대다). cancel 은 end 와 같게 다룬다: 손이 화면 밖으로 나가도 기기에는 뗀 것으로 보여야 한다.
 */
const TOUCH_PHASES = new Set(['begin', 'move', 'end']);
/** 같은 단계를 scrcpy 어휘로. (iOS 는 serve-sim 이 begin/move/end 를 그대로 받는다.) */
const TOUCH_TO_SCRCPY = { begin: 'down', move: 'move', end: 'up' };

/**
 * 방향 고리 — 시계방향 순서다. serve-sim 이 쓰는 이름 그대로.
 *  ⚠ 아이폰은 `portrait_upside_down` 을 앱이 대개 거부한다(그 한 칸은 화면이 안 바뀐다).
 *   그래서 **좌/우 두 버튼**을 준다 — 실제 시뮬레이터 메뉴(Rotate Left/Right)와 안드로이드
 *   에뮬레이터 패널도 그렇게 두 개다. 한 버튼으로 네 방향을 돌리면 그 한 칸이 "고장" 처럼 보인다.
 */
const IOS_ORIENTATIONS = ['portrait', 'landscape_right', 'portrait_upside_down', 'landscape_left'];

/** 회전 키 → 방향(+1=시계, -1=반시계). `rotate` 는 옛 이름(=시계)으로 계속 받는다. */
const ROTATE_KEYS = { rotateRight: 1, rotateLeft: -1, rotate: 1 };

/**
 * serve-sim HID 버튼 표.
 *
 * ★ 이름이 **소문자**다(idb 는 대문자 — 그대로 넘기면 조용히 무시된다, 실측).
 * ★ 전원·볼륨처럼 HID 로 가는 버튼은 page/usage 를 같이 보내야 실제로 눌린다(serve-sim CLI 와 동일).
 * ★ 'lock' 은 serve-sim 어휘에 없다 — 전원 버튼이 곧 잠금이다.
 */
const IOS_SS_BUTTONS = {
  home: { button: 'home' },
  lock: { button: 'power', page: 12, usage: 48 },
  volumeUp: { button: 'volume-up', page: 12, usage: 233 },
  volumeDown: { button: 'volume-down', page: 12, usage: 234 },
};

/**
 * 컨트롤 소켓으로 보내기 — 세션이 없거나 소켓이 죽었으면 **null 을 돌려** 호출측이 adb 로 물러선다.
 *  조용히 성공을 돌려주면 사용자는 기기가 멈춘 줄 안다.
 */
async function inputViaScrcpy(a, p) {
  let sess = null;
  try { sess = require('./emulator-stream').sessionFor(p.value); } catch (_) { return null; }
  if (!sess) return null;
  const S = require('./scrcpy-protocol');
  const type = String(a.type || '');
  /**
   * ★ 좌표는 **영상 좌표계**여야 한다(기기 픽셀이 아니다). scrcpy 의 `getPhysicalPoint` 는 클라이언트가
   *  보낸 화면 크기가 지금 인코딩 중인 영상 크기와 다르면 그 이벤트를 **조용히 버린다**. 기기 픽셀
   *  (1440x2960)을 보내던 동안 RPC 는 `ok:true, via:'scrcpy'` 를 돌려주는데 화면은 꼼짝도 안 했다
   *  (2026-08-05 실측: 같은 드래그가 영상 좌표계로는 34프레임, 기기 좌표계로는 0프레임).
   *  회전하면 영상 크기가 바뀌므로, 화면이 지금 보고 있는 크기를 실어 보내면 그걸 우선한다.
   */
  const vw = Number(a.videoWidth) || (sess.meta && sess.meta.width) || 0;
  const vh = Number(a.videoHeight) || (sess.meta && sess.meta.height) || 0;
  if (!vw || !vh) return null;
  const W = vw, H = vh;
  const pt = (x, y) => ({ x: px(x, W), y: px(y, H), screenWidth: W, screenHeight: H, pointerId: 0 });

  //  ★ 손가락을 따라가는 입력 — iOS 쪽 주석과 같은 이유다. scrcpy 컨트롤 소켓은 down/move/up 을
  //   그대로 받으므로, 화면이 보내 주는 단계를 바꿔 끼우기만 하면 된다.
  if (type === 'touch') {
    const action = TOUCH_TO_SCRCPY[String(a.phase || '')];
    if (!action) throw new Error('알 수 없는 터치 단계예요');
    if (!sess.send(S.encodeTouch({ action, ...pt(a.x, a.y) }))) return null;
    return { ok: true, via: 'scrcpy' };
  }
  if (type === 'tap' || type === 'longPress') {
    if (!sess.send(S.encodeTouch({ action: 'down', ...pt(a.x, a.y) }))) return null;
    //  롱프레스는 누른 채로 기다렸다 뗀다(스와이프와 달리 좌표가 안 움직인다).
    await new Promise((r) => setTimeout(r, type === 'longPress' ? 600 : 60));
    sess.send(S.encodeTouch({ action: 'up', ...pt(a.x, a.y) }));
    return { ok: true, via: 'scrcpy' };
  }
  if (type === 'swipe') {
    const ms = Math.max(30, Math.min(3000, Number(a.durationMs) || 220));
    const steps = Math.max(2, Math.min(24, Math.round(ms / 16)));
    if (!sess.send(S.encodeTouch({ action: 'down', ...pt(a.x, a.y) }))) return null;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await new Promise((r) => setTimeout(r, ms / steps));
      sess.send(S.encodeTouch({
        action: 'move',
        ...pt(Number(a.x) + (Number(a.x2) - Number(a.x)) * k, Number(a.y) + (Number(a.y2) - Number(a.y)) * k),
      }));
    }
    sess.send(S.encodeTouch({ action: 'up', ...pt(a.x2, a.y2) }));
    return { ok: true, via: 'scrcpy' };
  }
  if (type === 'key') {
    //  ★ 회전은 여기서 처리하지 않는다. scrcpy 의 ROTATE_DEVICE(11) 는 우리 서버 jar 에서
    //   **ok 를 돌려주면서 아무 일도 안 했다**(2026-08-06 실측: 1080x2400 그대로). null 을 돌려
    //   아래 adb 경로(settings user_rotation)로 보낸다 — 그쪽은 실제로 돈다.
    if (ROTATE_KEYS[String(a.key || '')]) return null;
    const code = S.KEYCODES[String(a.key || '')];
    if (code == null) return null;   // 우리가 여는 키가 아니다 — adb 경로의 검증에 맡긴다
    if (!sess.send(S.encodeKeycode({ action: 'down', keycode: code }))) return null;
    sess.send(S.encodeKeycode({ action: 'up', keycode: code }));
    return { ok: true, via: 'scrcpy' };
  }
  if (type === 'text') {
    //  ★ 컨트롤 소켓은 UTF-8 을 그대로 받는다 — `adb shell input text` 가 못 넣던 한글·기호도 들어간다.
    if (!sess.send(S.encodeText(String(a.text || '')))) return null;
    return { ok: true, via: 'scrcpy' };
  }
  return null;
}

/**
 * iOS 조작 — **살아 있는 serve-sim 세션의 HID 채널**로 보낸다.
 *
 * 왜 idb 보다 이게 먼저인가: idb 는 탭 한 번마다 파이썬 CLI 를 띄우고 companion 을 붙잡아
 *  왕복이 수백 ms 다. serve-sim 은 이미 열려 있는 WebSocket 에 한 줄 쓰는 것이라 즉시 간다.
 *  게다가 좌표가 **0~1 정규화 그대로** 라 포인트/픽셀 환산이 아예 없다 — 오늘 두 번 터진 사고의
 *  근원(단위 불일치)이 구조적으로 사라진다.
 *
 * 화면을 폴링으로 보고 있어도(영상이 아직 안 붙었어도) 조작은 돼야 하므로, 세션이 없으면
 *  여기서 만든다. 세션은 linger 뒤 스스로 정리된다.
 *
 * @returns {Promise<{ok:true,via:string}|null>} null 이면 호출측이 idb 로 물러선다.
 */
async function inputViaServeSim(a, p) {
  if (p.scheme !== 'ios' || !serveSim().available()) return null;
  const stream = lazyStream();
  let sess = null;
  try { sess = stream.sessionFor(p.value); } catch (_) { return null; }
  if (!sess) {
    try { await streamStart({ id: a.id }); sess = stream.sessionFor(p.value); }
    catch (_) { return null; }
  }
  if (!sess || typeof sess.touch !== 'function') return null;
  //  영상 없이 조작만 하는 화면(폴링)도 세션을 살려 둔다 — 안 그러면 16초마다 헬퍼를 다시 띄운다.
  try { stream.keepAlive(p.value); } catch (_) { /* noop */ }
  const type = String(a.type || '');

  //  ★ 손가락을 **따라가는** 입력. 화면이 누르는 순간부터 begin/move/…/end 를 그대로 흘린다.
  //   왜 이게 따로 필요한가(2026-08-06, Orca 대조): 예전엔 손을 뗀 뒤에 swipe(시작→끝) 한 방을
  //   보내고 데몬이 직선으로 재생했다. 그러면 (1) 드래그하는 동안 화면이 안 움직이고,
  //   (2) iOS 제스처 인식기가 "뗀 뒤 몰아친 입력"을 아예 무시하기도 한다.
  if (type === 'touch') {
    const phase = String(a.phase || '');
    if (!TOUCH_PHASES.has(phase)) throw new Error('알 수 없는 터치 단계예요');
    if (!sess.touch(phase, a.x, a.y)) return null;
    return { ok: true, via: 'serve-sim' };
  }
  if (type === 'tap' || type === 'longPress') {
    if (!sess.touch('begin', a.x, a.y)) return null;
    await new Promise((r) => setTimeout(r, type === 'longPress' ? 600 : 60));
    sess.touch('end', a.x, a.y);
    return { ok: true, via: 'serve-sim' };
  }
  if (type === 'swipe') {
    const ms = Math.max(30, Math.min(3000, Number(a.durationMs) || 220));
    const steps = Math.max(2, Math.min(24, Math.round(ms / 16)));
    if (!sess.touch('begin', a.x, a.y)) return null;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      await new Promise((r) => setTimeout(r, ms / steps));
      sess.touch('move', Number(a.x) + (Number(a.x2) - Number(a.x)) * k, Number(a.y) + (Number(a.y2) - Number(a.y)) * k);
    }
    sess.touch('end', a.x2, a.y2);
    return { ok: true, via: 'serve-sim' };
  }
  if (type === 'key') {
    const key = String(a.key || '');
    //  회전은 버튼이 아니라 전용 메시지다. 지금 방향에서 한 칸 돌린다.
    const dir = ROTATE_KEYS[key];
    if (dir) {
      const n = IOS_ORIENTATIONS.length;
      const cur = IOS_ORIENTATIONS.indexOf(sess.orientation);
      const next = IOS_ORIENTATIONS[(((cur < 0 ? 0 : cur) + dir) % n + n) % n];
      if (!sess.rotate(next)) return null;
      //  ★ 기기가 **실제로 돌았는지** 확인해서 돌려준다. 아이폰 홈 화면처럼 회전을 거부하는
      //   화면이 있는데, 요청한 방향을 그대로 믿으면 똑바로 선 화면을 옆으로 눕혀 그리게 된다.
      const actual = typeof sess.confirmOrientation === 'function'
        ? await sess.confirmOrientation(next) : next;
      return { ok: true, via: 'serve-sim', orientation: actual };
    }
    const btn = IOS_SS_BUTTONS[key];
    if (!btn) return null;                 // 우리가 여는 버튼이 아니다 — 아래 검증에 맡긴다
    if (!sess.button(btn)) return null;
    return { ok: true, via: 'serve-sim' };
  }
  //  글자 입력은 아직 HID 태그로 옮기지 않았다(usage 코드 표가 필요하다) → idb 로 보낸다.
  return null;
}

async function input(args) {
  const a = args || {};
  const p = parseId(a.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  const t = tools();
  const type = String(a.type || '');

  if (p.scheme === 'android') {
    if (!t.adb) throw new Error('adb 를 찾을 수 없어요');
    //  ★ 라이브 스트림이 떠 있으면 **이미 열려 있는 컨트롤 소켓**으로 보낸다. `adb shell input tap`
    //   은 탭 한 번에 프로세스를 새로 띄워 100ms 가 넘게 든다 — 화면이 30fps 로 흘러도 손끝이
    //   그만큼 늦으면 여전히 굼떠 보인다. 소켓은 바이트만 쓴다.
    const viaControl = await inputViaScrcpy(a, p);
    if (viaControl) return viaControl;
    const adb = (rest, timeoutMs) => run(t.adb, ['-s', p.value, 'shell', ...rest], { timeoutMs: timeoutMs || 10000 });
    //  회전 폴백 — 라이브 세션이 없을 때. 자동회전을 끄고 사용자 회전값을 한 칸 돌린다
    //  (`adb emu rotate` 는 에뮬레이터에만 있어서 실기기에서 안 된다).
    if (type === 'key' && ROTATE_KEYS[String(a.key || '')]) {
      //  안드로이드의 user_rotation 은 **반시계** 방향으로 증가한다(0=세로, 1=왼쪽으로 눕힘).
      //   그래서 '왼쪽으로 회전' 이 +1 이다 — 화면에 그리는 방향과 값이 반대라 헷갈리는 자리다.
      const dir = ROTATE_KEYS[String(a.key || '')] === -1 ? 1 : -1;
      const cur = Number(String(await adb(['settings', 'get', 'system', 'user_rotation'])).trim()) || 0;
      const next = ((cur + dir) % 4 + 4) % 4;
      await adb(['settings', 'put', 'system', 'accelerometer_rotation', '0']);
      await adb(['settings', 'put', 'system', 'user_rotation', String(next)]);
      return { ok: true, rotation: next };
    }
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
    //  라이브 세션이 있으면 그 HID 채널이 항상 이긴다(즉시·정규화 좌표). idb 는 폴백이다.
    const live = await inputViaServeSim(a, p);
    if (live) return live;
    if (!idbReady(t)) {
      // 정직하게 못 한다고 말한다 — 조용히 성공을 돌려주면 사용자는 기기가 멈춘 줄 안다.
      throw new Error(t.idb && !t.idbCompanion
        ? 'iOS 조작에 필요한 idb_companion 을 찾지 못했어요 (brew install facebook/fb/idb-companion)'
        : 'iOS 시뮬레이터 조작에는 idb 가 필요해요 (brew install facebook/fb/idb-companion)');
    }
    const s = await screenSize(a.id, p).catch(() => null);
    const dev = ['--udid', p.value];
    if (type === 'tap' || type === 'longPress') {
      if (!s) throw new Error('화면을 한 번 불러온 뒤 조작해 주세요');
      const args2 = ['ui', 'tap', ...dev, String(px(a.x, s.w)), String(px(a.y, s.h))];
      if (type === 'longPress') args2.push('--duration', '0.6');
      await idbRun(args2, { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'swipe') {
      if (!s) throw new Error('화면을 한 번 불러온 뒤 조작해 주세요');
      await idbRun(['ui', 'swipe', ...dev,
        String(px(a.x, s.w)), String(px(a.y, s.h)), String(px(a.x2, s.w)), String(px(a.y2, s.h))], { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'key') {
      const btn = IOS_BUTTONS[String(a.key || '')];
      if (!btn) throw new Error('보낼 수 없는 키예요');
      await idbRun(['ui', 'button', ...dev, btn], { timeoutMs: 10000 });
      return { ok: true };
    }
    if (type === 'text') {
      await idbRun(['ui', 'text', ...dev, String(a.text || '')], { timeoutMs: 10000 });
      return { ok: true };
    }
    throw new Error('알 수 없는 입력이에요');
  }
  throw new Error('꺼져 있는 기기예요 — 먼저 켜 주세요');
}

// ── 화면을 "글자"로 읽기 ─────────────────────────────────────────────────────

/** 트리 한 번에 돌려주는 최대 요소 수 — 화면 하나에 이보다 많으면 어차피 사람이 못 읽는다. */
const AX_MAX_ELEMENTS = 400;

/**
 * 접근성 트리 — **AI 가 스크린샷을 눈으로 찍어 좌표를 추측하지 않게** 해 주는 것.
 *
 * 왜 필요한가: 지금까지 에이전트가 화면을 조작하려면 스크린샷을 받아 "설정 아이콘이 대충
 *  오른쪽 아래" 라고 찍어야 했다. 그건 맞을 때도 있고 아닐 때도 있는데, **틀려도 rc=0** 이라
 *  아무 일도 안 일어난 걸 알 방법이 없다(오늘 내가 세 번 당한 그 함정이다).
 *  라벨과 사각형을 글자로 주면 "'설정' 을 눌러" 가 결정적인 동작이 된다.
 *
 * 좌표는 우리 계약대로 **0~1 정규화**로 돌려준다(x,y = 중심). 그대로 `emulator.input tap` 에
 *  넣으면 된다 — 단위 환산을 클라이언트가 하지 않는다.
 */
async function axTree(args) {
  const a = args || {};
  const p = parseId(a.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  if (p.scheme === 'ios') return iosAx(a, p);
  if (p.scheme === 'android') return androidAx(a, p);
  throw new Error('꺼져 있는 기기예요 — 먼저 켜 주세요');
}

async function iosAx(a, p) {
  if (!serveSim().available()) throw new Error('이 PC 에서는 iOS 화면 읽기를 쓸 수 없어요');
  const stream = lazyStream();
  let sess = stream.sessionFor(p.value);
  if (!sess) { await streamStart({ id: a.id }); sess = stream.sessionFor(p.value); }
  if (!sess || typeof sess.axJson !== 'function') throw new Error('화면 읽기 준비가 안 됐어요');
  try { stream.keepAlive(p.value); } catch (_) { /* noop */ }
  const raw = await sess.axJson();
  return { kind: 'ios', ...normalizeIosAx(raw) };
}

/**
 * serve-sim `/ax` 는 **포인트** 좌표의 트리를 준다. 화면 크기는 별도로 안 주므로
 *  최상위 노드의 사각형을 화면으로 본다(serve-sim 자신도 같은 규칙을 쓴다).
 */
function normalizeIosAx(raw) {
  const roots = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const screen = (roots[0] && roots[0].frame) || { x: 0, y: 0, width: 1, height: 1 };
  const W = Number(screen.width) || 1;
  const H = Number(screen.height) || 1;
  const out = [];
  const walk = (node) => {
    if (!node || out.length >= AX_MAX_ELEMENTS) return;
    const f = node.frame || {};
    const label = String(node.AXLabel || '').trim();
    const value = String(node.AXValue || '').trim();
    //  화면 전체를 덮는 껍데기 노드는 버린다 — 그걸 누르면 아무 데나 누른 것과 같다.
    const isScreen = Math.abs((f.width || 0) - W) < 0.5 && Math.abs((f.height || 0) - H) < 0.5;
    if ((label || value) && !isScreen && f.width > 0 && f.height > 0) {
      out.push({
        label, value,
        role: String(node.role_description || node.type || ''),
        enabled: node.enabled !== false,
        x: clamp01((f.x + f.width / 2 - screen.x) / W),
        y: clamp01((f.y + f.height / 2 - screen.y) / H),
        w: clamp01(f.width / W),
        h: clamp01(f.height / H),
      });
    }
    for (const c of node.children || []) walk(c);
  };
  for (const r of roots) walk(r);
  return { screen: { w: W, h: H }, elements: out };
}

async function androidAx(a, p) {
  const t = tools();
  if (!t.adb) throw new Error('adb 를 찾을 수 없어요');
  const xml = await run(t.adb, ['-s', p.value, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeoutMs: 20000 });
  return { kind: 'android', ...parseAndroidAx(String(xml)) };
}

/**
 * `uiautomator dump` 의 XML → 우리 형식.
 *  bounds 는 `[x1,y1][x2,y2]` **픽셀**이다. 화면 크기는 최상위 노드의 bounds 로 잡는다
 *  (기기에 다시 물어보면 회전 직후 값이 어긋날 수 있다 — 같은 덤프 안에서 끝낸다).
 */
function parseAndroidAx(xml) {
  const nodes = String(xml).match(/<node\b[^>]*>/g) || [];
  const attr = (s, k) => {
    const m = new RegExp(`\\s${k}="([^"]*)"`).exec(s);
    return m ? m[1] : '';
  };
  const rect = (s) => {
    const m = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(s);
    return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null;
  };
  let W = 0, H = 0;
  for (const n of nodes) {
    const r = rect(n);
    if (r) { W = Math.max(W, r.x2); H = Math.max(H, r.y2); }
  }
  if (!W || !H) return { screen: { w: 0, h: 0 }, elements: [] };
  const out = [];
  for (const n of nodes) {
    if (out.length >= AX_MAX_ELEMENTS) break;
    const r = rect(n);
    if (!r) continue;
    const label = (attr(n, 'text') || attr(n, 'content-desc') || '').trim();
    //  글자도 설명도 없는 레이아웃 껍데기는 버린다(누를 수 있는 것만 예외로 남긴다).
    const clickable = attr(n, 'clickable') === 'true';
    if (!label && !clickable) continue;
    const w = r.x2 - r.x1, h = r.y2 - r.y1;
    if (w <= 0 || h <= 0) continue;
    if (w >= W && h >= H) continue;                 // 화면 전체 껍데기
    out.push({
      label,
      value: attr(n, 'resource-id'),
      role: (attr(n, 'class') || '').split('.').pop(),
      enabled: attr(n, 'enabled') !== 'false',
      x: clamp01((r.x1 + w / 2) / W),
      y: clamp01((r.y1 + h / 2) / H),
      w: clamp01(w / W),
      h: clamp01(h / H),
    });
  }
  return { screen: { w: W, h: H }, elements: out };
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
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

/**
 * 라이브 스트림 시작 — 화면이 H.264 를 직접 받는다(폴링이 아니라).
 *  안드로이드만 된다. iOS 시뮬레이터는 이런 인코더 경로가 없어 계속 프레임 폴링을 쓴다.
 */
async function streamStart(args) {
  const a = args || {};
  const p = parseId(a.id);
  if (!p) throw new Error('기기 id 가 올바르지 않아요');
  if (p.scheme !== 'android' && p.scheme !== 'ios') throw new Error('이 기기는 라이브 화면을 지원하지 않아요');
  const t = tools();
  if (p.scheme === 'android' && !t.adb) throw new Error('adb 를 찾을 수 없어요');
  if (p.scheme === 'ios' && !serveSim().available()) {
    //  ★ 실패해야 클라이언트가 폴링으로 물러선다 — 조용히 빈 스트림을 주면 화면이 검게 남는다.
    throw new Error('이 PC 에서는 iOS 라이브 화면을 쓸 수 없어요');
  }
  const stream = lazyStream();
  const r = await stream.start({
    adb: t.adb, serial: p.value, deviceId: a.id, kind: p.scheme,
    maxSize: a.maxSize, maxFps: a.maxFps, bitRate: a.bitRate,
  });
  //  화면 크기는 **기기 실제 픽셀**이어야 한다(스트림 해상도가 아니라) — 좌표 환산의 기준이다.
  if (!lastSize.get(a.id)) { try { await screenSize(a.id, p); } catch (_) { /* 조작할 때 다시 잰다 */ } }
  return r;
}

let _streamMod = null;
function lazyStream() {
  if (!_streamMod) _streamMod = require('./emulator-stream');
  return _streamMod;
}

/** serve-sim(iOS 라이브 화면·조작) 모듈 — 없는 환경에서도 목록·폴링은 돌아야 하므로 지연 로드. */
let _serveSimMod = null;
function serveSim() {
  if (!_serveSimMod) {
    try { _serveSimMod = require('./serve-sim-session'); }
    catch (_) { _serveSimMod = { available: () => false }; }
  }
  return _serveSimMod;
}

/** RPC 진입점 — 유닉스 소켓(cpt)과 백엔드 릴레이(control.js)가 **둘 다** 여기로 온다. */
async function handle(method, params) {
  const m = String(method || '');
  if (m === 'emulator.list') return list();
  if (m === 'emulator.stream.start') return streamStart(params);
  if (m === 'emulator.stream.stop') return lazyStream().stop(String((params || {}).streamId || ''));
  if (m === 'emulator.boot') return boot(params && params.id);
  if (m === 'emulator.shutdown') return shutdown(params && params.id);
  if (m === 'emulator.frame') return frame(params);
  if (m === 'emulator.input') return input(params);
  if (m === 'emulator.openUrl') return openUrl(params);
  //  화면을 글자로 읽는다 — 에이전트가 좌표를 추측하지 않게 하는 유일한 길.
  if (m === 'emulator.ax') return axTree(params);
  //  직접 연결(WebRTC) — 외부망에서 서버를 우회하는 경로. 세션 관리는 webrtc.js 가 한다.
  //   프레임은 이 파일이 만든 스트림에 **뷰어로 붙어서** 받으므로 바이트 계약이 갈라지지 않는다.
  if (m === 'emulator.webrtc.offer') {
    const w = require('./webrtc');
    const p = params || {};
    return w.createOffer({ id: p.id }, p.iceServers, { startFor: (a) => streamStart(a) });
  }
  if (m === 'emulator.webrtc.answer') return require('./webrtc').acceptAnswer(String((params || {}).sessionId || ''), (params || {}).sdp);
  if (m === 'emulator.webrtc.close') return require('./webrtc').close(String((params || {}).sessionId || ''));
  throw new Error(`알 수 없는 메서드: ${m}`);
}

module.exports = {
  handle, list, boot, shutdown, frame, input, openUrl, streamStart, axTree,
  // 테스트용
  _parseId: parseId, _px: px, _pngSize: pngSize, _resetTools, _tools: tools,
  _parseRawScreencap: parseRawScreencap, _rawToBmp: rawToBmp,
  _lastSize: lastSize, _inputSize: inputSize, _screenSize: screenSize, _toJpeg: toJpeg,
  _pointsFromIdbDescribe: pointsFromIdbDescribe, _sortDevices: sortDevices,
  _idbReady: idbReady, _idbEnv: idbEnv,
  _normalizeIosAx: normalizeIosAx, _parseAndroidAx: parseAndroidAx,
  ANDROID_KEYS, IOS_BUTTONS, IOS_SS_BUTTONS, ANDROID_KEY_ROW, IOS_KEY_ROW, IOS_KEY_ROW_IDB, ROTATE_KEYS,
};
