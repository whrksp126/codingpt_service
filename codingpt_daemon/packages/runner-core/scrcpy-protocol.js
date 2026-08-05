/**
 * scrcpy 서버 와이어 프로토콜 — **순수 함수만** 둔다(I/O 없음 → 바이트 계약을 테스트로 못박는다).
 *
 * 왜 scrcpy 인가(2026-08-05, 사용자 지적 "안드로이드 스튜디오는 전혀 안 느린데"):
 *  우리는 `adb exec-out screencap` 을 폴링했다. 그건 매 프레임 **전체 프레임버퍼를 유저공간으로
 *  읽어 내리는** 일이라 기기 안에서만 수백 ms 가 든다. 안드로이드 스튜디오의 Running Devices 도,
 *  scrcpy 도 그 길을 안 간다 — 화면을 **MediaCodec(하드웨어 인코더)로 H.264 로 인코딩해 흘린다.**
 *  GPU 가 하는 일이라 싸고, 화면이 안 바뀌면 아무것도 안 보낸다.
 *
 * 실측(SM-N960N Android 10, USB, max_size=1024):
 *   폴링(screencap|gzip)   3.4 fps · 55 KB/s · 프레임당 지연 300ms
 *   scrcpy(H.264)         20.5 fps · 85 KB/s · 첫 프레임 118ms · **정지 시 6 KB/s**
 *  정지 화면에서 폴링은 계속 55KB/s 를 태우지만 H.264 는 사실상 0 이다 — 빠른 것보다 이게 더 중요하다.
 *
 * 버전 결합: 옵션 이름·순서·핸드셰이크는 서버 jar 버전에 묶여 있다. SCRCPY_VERSION 을 올리면
 *  반드시 실기기로 다시 확인할 것(이 파일의 테스트는 바이트 계약만 지킨다).
 */

const SCRCPY_VERSION = '2.4';
const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar';

/** 핸드셰이크 — 영상 소켓은 [더미 1바이트][기기이름 64바이트][코덱메타 12바이트] 로 시작한다. */
const DUMMY_BYTE = 1;
const DEVICE_NAME_BYTES = 64;
const CODEC_META_SIZE = 12;
const FRAME_HEADER_SIZE = 12;

/** PTS 상위 2비트가 플래그다(설정 패킷 / 키프레임). */
const CONFIG_FLAG = 1n << 63n;
const KEY_FRAME_FLAG = 1n << 62n;
const PTS_MASK = (1n << 62n) - 1n;

/** 이보다 큰 프레임은 스트림이 어긋난 것이다 — 버퍼를 키우며 OOM 으로 가지 말고 즉시 실패한다. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** `adb push` 인자. */
function pushArgs(serial, localJar, deviceJar = DEVICE_JAR_PATH) {
  return ['-s', serial, 'push', localJar, deviceJar];
}

/**
 * `adb forward` 인자. tunnel_forward=true 면 서버가 추상 소켓에서 듣고, adb 가 PC 의 TCP 포트를
 *  거기로 이어 준다. 포트 0 을 주면 adb 가 비어 있는 포트를 골라 stdout 으로 알려 준다.
 */
function forwardArgs(serial, localPort, scid) {
  return ['-s', serial, 'forward', `tcp:${localPort}`, `localabstract:scrcpy_${scid}`];
}
function removeForwardArgs(serial, localPort) {
  return ['-s', serial, 'forward', '--remove', `tcp:${localPort}`];
}

/**
 * 서버 기동 인자.
 *  · `control=true` 를 켜는 이유는 조작 때문만이 아니다 — 탭 한 번에 `adb shell input tap` 프로세스를
 *    새로 띄우면 100ms 가 넘게 든다. 컨트롤 소켓은 이미 열려 있는 TCP 라 바이트만 쓰면 된다.
 *  · `audio=false` — 우리는 화면만 본다. 켜면 오디오 소켓까지 기다리느라 시작이 느려진다.
 *  · `max_size` 는 **긴 변** 기준 상한이다. 폰 화면 안에서 볼 그림이라 1024 면 충분하고,
 *    올릴수록 인코딩·대역폭이 같이 오른다.
 */
function serverArgs(serial, opts) {
  const o = opts || {};
  const params = [
    `scid=${o.scid}`,
    'log_level=warn',
    'tunnel_forward=true',
    'audio=false',
    'control=true',
    'cleanup=true',
    'clipboard_autosync=false',
    'video_codec=h264',
  ];
  if (o.maxSize != null) params.push(`max_size=${o.maxSize}`);
  if (o.maxFps != null) params.push(`max_fps=${o.maxFps}`);
  if (o.videoBitRate != null) params.push(`video_bit_rate=${o.videoBitRate}`);
  return [
    '-s', serial, 'shell', `CLASSPATH=${o.deviceJar || DEVICE_JAR_PATH}`,
    'app_process', '/', 'com.genymobile.scrcpy.Server', o.version || SCRCPY_VERSION,
    ...params,
  ];
}

/** 코덱 id 는 널 패딩된 4바이트 아스키다("h264"). */
function parseCodecMeta(buf) {
  if (!buf || buf.length < CODEC_META_SIZE) return null;
  let id = '';
  for (const b of buf.subarray(0, 4)) if (b) id += String.fromCharCode(b);
  return { codec: id, width: buf.readUInt32BE(4), height: buf.readUInt32BE(8) };
}

/**
 * `pending + chunk` 에서 **완성된 프레임만** 꺼내고, 덜 온 조각은 그대로 돌려준다.
 *  TCP 는 우리가 쓴 경계를 지켜 주지 않는다 — 한 청크에 프레임이 3개 들어오기도 하고 헤더가
 *  반만 오기도 한다. 그 조립을 여기 한 곳에서만 한다.
 */
function parseFrames(pending, chunk) {
  const buf = pending && pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const frames = [];
  let off = 0;
  while (buf.length - off >= FRAME_HEADER_SIZE) {
    const meta = buf.readBigUInt64BE(off);
    const size = buf.readUInt32BE(off + 8);
    if (size > MAX_FRAME_BYTES) {
      throw new Error(`scrcpy 프레임 크기 ${size} 가 상한을 넘었어요 — 스트림이 어긋났습니다`);
    }
    const start = off + FRAME_HEADER_SIZE;
    if (buf.length - start < size) break;
    frames.push({
      config: (meta & CONFIG_FLAG) !== 0n,
      keyFrame: (meta & KEY_FRAME_FLAG) !== 0n,
      pts: meta & PTS_MASK,
      data: Buffer.from(buf.subarray(start, start + size)),
    });
    off = start + size;
  }
  return { frames, pending: off > 0 ? Buffer.from(buf.subarray(off)) : buf };
}

// ── 컨트롤 메시지 ────────────────────────────────────────────────────────────
// 전부 빅엔디언이다(서버가 DataInputStream 으로 읽는다).

const MSG = { KEYCODE: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4 };
const TOUCH_ACTION = { down: 0, up: 1, move: 2 };
const KEY_ACTION = { down: 0, up: 1 };
const BUTTON_PRIMARY = 1;
const PRESSURE_MAX = 0xffff;

/** 압력은 0xFFFF 가 1.0 인 고정소수점이다. 손을 떼는 순간(up)은 0 이어야 한다. */
function encodeTouch(p) {
  const pressure = p.pressure != null ? p.pressure : (p.action === 'up' ? 0 : 1);
  const fixed = Math.max(0, Math.min(PRESSURE_MAX, Math.round(pressure * PRESSURE_MAX)));
  const b = Buffer.alloc(32);
  b.writeUInt8(MSG.TOUCH, 0);
  b.writeUInt8(TOUCH_ACTION[p.action], 1);
  b.writeBigUInt64BE(BigInt(p.pointerId == null ? 0 : p.pointerId), 2);
  b.writeInt32BE(p.x, 10);
  b.writeInt32BE(p.y, 14);
  b.writeUInt16BE(p.screenWidth, 18);
  b.writeUInt16BE(p.screenHeight, 20);
  b.writeUInt16BE(fixed, 22);
  b.writeUInt32BE(BUTTON_PRIMARY, 24);
  b.writeUInt32BE(p.action === 'up' ? 0 : BUTTON_PRIMARY, 28);
  return b;
}

function encodeKeycode(p) {
  const b = Buffer.alloc(14);
  b.writeUInt8(MSG.KEYCODE, 0);
  b.writeUInt8(KEY_ACTION[p.action], 1);
  b.writeInt32BE(p.keycode, 2);
  b.writeInt32BE(p.repeat || 0, 6);
  b.writeInt32BE(p.metaState || 0, 10);
  return b;
}

/** 길이 접두사는 **UTF-8 바이트 수**다 — 한글은 글자 수와 다르다. */
function encodeText(text) {
  const payload = Buffer.from(String(text == null ? '' : text), 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(MSG.TEXT, 0);
  b.writeUInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

/** 스크롤 — 좌표는 터치와 같고, h/v 는 16.16 고정소수점이다. */
function encodeScroll(p) {
  const fx = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 65536)));
  const b = Buffer.alloc(21);
  b.writeUInt8(MSG.SCROLL, 0);
  b.writeInt32BE(p.x, 1);
  b.writeInt32BE(p.y, 5);
  b.writeUInt16BE(p.screenWidth, 9);
  b.writeUInt16BE(p.screenHeight, 11);
  b.writeInt32BE(fx(p.h || 0), 13);
  b.writeInt32BE(fx(p.v || 0), 17);
  return b;
}

/**
 * 안드로이드 keycode — 화면에 보이는 것만 연다(우리 `emulator.input` 의 키 목록과 같은 규율:
 *  임의 keyevent 를 열면 전원·공장초기화까지 닿는다).
 */
const KEYCODES = {
  home: 3, back: 4, recents: 187, enter: 66, del: 67, tab: 61, escape: 111,
  volumeUp: 24, volumeDown: 25, power: 26,
  up: 19, down: 20, left: 21, right: 22,
};

module.exports = {
  SCRCPY_VERSION, DEVICE_JAR_PATH,
  DUMMY_BYTE, DEVICE_NAME_BYTES, CODEC_META_SIZE, FRAME_HEADER_SIZE, MAX_FRAME_BYTES,
  pushArgs, forwardArgs, removeForwardArgs, serverArgs,
  parseCodecMeta, parseFrames,
  encodeTouch, encodeKeycode, encodeText, encodeScroll,
  KEYCODES, MSG,
};
