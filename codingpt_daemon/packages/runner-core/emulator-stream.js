/**
 * 모바일 화면 **라이브 스트림** — scrcpy 세션을 들고, 화면(PC 웹뷰)에 H.264 를 그대로 흘린다.
 *
 * 왜 유닉스 소켓(cpt.sock)이 아니라 로컬 WebSocket 인가:
 *  cpt.sock 은 NDJSON 요청/응답 한 판이다. 초당 20~30개의 바이너리 프레임을 흘릴 통로가 아니고,
 *  웹뷰는 유닉스 소켓에 직접 붙지도 못한다. `ws` 는 이미 데몬의 의존성이라 새로 들이는 것도 없다.
 *
 * 보안: **127.0.0.1 에만** 바인딩하고, 스트림마다 1회용 토큰을 요구한다. 토큰 없이 붙으면 즉시 끊는다.
 *  (같은 기계의 다른 프로세스가 화면을 훔쳐보는 것까지 막지는 못한다 — 그건 adb 를 직접 부르면
 *   되는 일이라 이 통로가 새로 만드는 위험이 아니다.)
 *
 * 수명: 보는 사람이 없으면 끈다. 화면을 닫고도 인코더가 계속 돌면 배터리·CPU 를 조용히 먹는다.
 */
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ScrcpySession } = require('./scrcpy-session');

/** 마지막 시청자가 떠난 뒤 이만큼 더 살려 둔다(탭을 잠깐 옮겼다 돌아오는 경우). */
const LINGER_MS = 8000;

/** 프레임 앞에 붙이는 1바이트 머리 — 화면이 config/키프레임을 구분해야 디코더를 켤 수 있다. */
const FLAG_CONFIG = 1;
const FLAG_KEY = 2;

let wss = null;
let wssPort = 0;
/** streamId → { session, token, clients:Set, meta, closeTimer, serial } */
const streams = new Map();

function ensureServer() {
  if (wss) return Promise.resolve(wssPort);
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      wssPort = wss.address().port;
      resolve(wssPort);
    });
    wss.on('error', (e) => { wss = null; reject(e); });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', 'ws://127.0.0.1');
      const id = url.searchParams.get('s') || '';
      const token = url.searchParams.get('t') || '';
      const entry = streams.get(id);
      //  토큰 비교는 길이가 같을 때만 timingSafeEqual 이 된다 — 다르면 그냥 거절.
      const ok = entry && token.length === entry.token.length
        && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(entry.token));
      if (!ok) { ws.close(4001, 'unauthorized'); return; }
      attach(entry, ws);
    });
  });
}

function attach(entry, ws) {
  entry.clients.add(ws);
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  ws.binaryType = 'nodebuffer';
  //  새로 붙은 화면에 **먼저 SPS/PPS 를 준다** — 없으면 다음 키프레임이 올 때까지 검은 화면이다.
  if (entry.session.configPacket) send(ws, FLAG_CONFIG, entry.session.configPacket);
  ws.on('close', () => {
    entry.clients.delete(ws);
    if (entry.clients.size === 0 && !entry.closeTimer) {
      entry.closeTimer = setTimeout(() => stop(entry.id), LINGER_MS);
    }
  });
  ws.on('error', () => { try { ws.close(); } catch (_) { /* noop */ } });
}

function send(ws, flags, data) {
  if (ws.readyState !== 1) return;
  const head = Buffer.alloc(1);
  head.writeUInt8(flags, 0);
  //  ⚠ 프레임이 밀리면 **버리지 않고 쌓인다** — 느린 회선에서 지연이 눈덩이가 되므로,
  //   보낼 것이 이미 쌓여 있으면 키프레임이 아닌 프레임은 흘려보낸다.
  if (ws.bufferedAmount > 4 * 1024 * 1024 && !(flags & (FLAG_KEY | FLAG_CONFIG))) return;
  try { ws.send(Buffer.concat([head, data])); } catch (_) { /* noop */ }
}

/**
 * 스트림을 연다(같은 기기면 기존 세션을 재사용한다 — 화면 두 개가 각자 인코더를 띄우면 안 된다).
 * @returns {{ streamId, url, token, width, height, codec }}
 */
async function start({ adb, serial, deviceId, maxSize, maxFps, bitRate }) {
  const port = await ensureServer();
  for (const [, e] of streams) {
    if (e.serial === serial && !e.session.closed) {
      if (e.closeTimer) { clearTimeout(e.closeTimer); e.closeTimer = null; }
      return descriptor(e, port);
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const entry = {
    id, serial, deviceId,
    token: crypto.randomBytes(24).toString('base64url'),
    clients: new Set(), meta: null, closeTimer: null, session: null,
  };
  entry.session = await ScrcpySession.start(
    //  긴 변 1280 — pane 폭이 800~900px 인 경우가 흔해서 1024 는 눈에 띄게 무르다. 픽셀은 1.5배지만
    //   H.264 라 대역폭은 그만큼 안 오른다(정지 화면은 여전히 사실상 0).
    { adb, serial, maxSize: maxSize || 1280, maxFps: maxFps || 30, bitRate: bitRate || 6_000_000 },
    {
      onMeta: (m) => { entry.meta = m; },
      onFrame: (f) => {
        const flags = (f.config ? FLAG_CONFIG : 0) | (f.keyFrame ? FLAG_KEY : 0);
        for (const ws of entry.clients) send(ws, flags, f.data);
      },
      onError: () => { closeClients(entry, 4002, 'stream error'); },
      onClose: () => { closeClients(entry, 1000, 'closed'); streams.delete(id); },
    },
  );
  streams.set(id, entry);
  //  아무도 안 붙으면 그냥 켜 둔 채로 남는다 — 시작하자마자 linger 타이머를 걸어 둔다.
  entry.closeTimer = setTimeout(() => stop(id), LINGER_MS * 2);
  return descriptor(entry, port);
}

function descriptor(entry, port) {
  return {
    streamId: entry.id,
    url: `ws://127.0.0.1:${port}/?s=${entry.id}&t=${encodeURIComponent(entry.token)}`,
    width: entry.meta ? entry.meta.width : 0,
    height: entry.meta ? entry.meta.height : 0,
    codec: entry.meta ? entry.meta.codec : 'h264',
  };
}

function closeClients(entry, code, reason) {
  for (const ws of entry.clients) { try { ws.close(code, reason); } catch (_) { /* noop */ } }
  entry.clients.clear();
}

function stop(streamId) {
  const e = streams.get(streamId);
  if (!e) return { ok: true };
  if (e.closeTimer) { clearTimeout(e.closeTimer); e.closeTimer = null; }
  streams.delete(streamId);
  closeClients(e, 1000, 'stopped');
  e.session.close();
  return { ok: true };
}

/** 이 기기에 살아 있는 세션 — `emulator.input` 이 컨트롤 소켓을 쓰려고 물어본다. */
function sessionFor(serial) {
  for (const [, e] of streams) if (e.serial === serial && !e.session.closed) return e.session;
  return null;
}

/** 프로세스 종료·데몬 재시작 때 인코더를 남기지 않는다. */
function stopAll() {
  for (const id of [...streams.keys()]) stop(id);
  try { wss?.close(); } catch (_) { /* noop */ }
  wss = null; wssPort = 0;
}

//  데몬이 죽을 때 기기에 인코더를 남기지 않는다. scrcpy 의 cleanup=true 가 대개 알아서 정리하지만,
//   그건 서버가 연결이 끊긴 걸 알아챈 뒤의 이야기다 — 우리가 먼저 확실히 끊는다.
process.once('exit', () => { try { stopAll(); } catch (_) { /* noop */ } });

module.exports = { start, stop, stopAll, sessionFor, _streams: streams, FLAG_CONFIG, FLAG_KEY, LINGER_MS };
