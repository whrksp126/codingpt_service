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
const WebSocket = require('ws');
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
      attachWs(entry, ws);
    });
  });
}

/**
 * **뷰어** — 프레임을 받는 한 사람. 전송 수단만 다르고 바이트는 같다.
 *  로컬 웹뷰(127.0.0.1 WS) · 릴레이(back 다이얼백 WS) · LAN 직결(cpt-lan 채널) 셋이
 *  전부 이 인터페이스로 들어온다. 예전엔 ws 를 직접 다뤄서 새 경로가 생길 때마다 바이트 조립이
 *  한 벌씩 늘어날 뻔했다 — 여기 한 곳만 남긴다.
 *
 *  { alive() , backlog() , write(buf) , close(code, reason) }
 */
function wsViewer(ws) {
  ws.binaryType = 'nodebuffer';
  return {
    ws,
    alive: () => ws.readyState === 1,
    backlog: () => ws.bufferedAmount,
    write: (buf) => { try { ws.send(buf); } catch (_) { /* noop */ } },
    close: (code, reason) => { try { ws.close(code, reason); } catch (_) { /* noop */ } },
  };
}

function attach(entry, viewer) {
  entry.clients.add(viewer);
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  //  새로 붙은 화면에 **먼저 SPS/PPS 를 준다** — 없으면 다음 키프레임이 올 때까지 검은 화면이다.
  if (entry.session.configPacket) send(viewer, FLAG_CONFIG, entry.session.configPacket);
}

/** 뷰어가 떠났다 — 마지막 한 명이면 조금 기다렸다 인코더를 끈다. */
function detach(entry, viewer) {
  if (!entry.clients.delete(viewer)) return;
  if (entry.clients.size === 0 && !entry.closeTimer) {
    entry.closeTimer = setTimeout(() => stop(entry.id), LINGER_MS);
  }
}

/** ws 를 붙일 때의 편의 — 수명 배선까지 한 번에. */
function attachWs(entry, ws) {
  const viewer = wsViewer(ws);
  attach(entry, viewer);
  ws.on('close', () => detach(entry, viewer));
  ws.on('error', () => { try { ws.close(); } catch (_) { /* noop */ } });
  return viewer;
}

/**
 * 회선이 못 따라갈 때의 상한. 넘으면 **그 시청자만 끊는다**(아래 이유).
 */
const BACKPRESSURE_MAX = 8 * 1024 * 1024;

function send(viewer, flags, data) {
  if (!viewer.alive()) return;
  //  ★ 밀린다고 프레임을 **버리면 안 된다.** H.264 델타는 앞 프레임에 기대어 있어서, 하나를 빼면
  //   다음 키프레임이 올 때까지 화면이 깨진 채로 남는다. 그런데 scrcpy 는 화면이 바뀔 때만 보내고
  //   키프레임은 몇 분에 한 번이라(실측: 11초에 1장), "잠깐 깨짐"이 아니라 "한참 깨짐"이 된다.
  //   그래서 밀리면 **끊는다** — 화면이 다시 붙으면 config 를 먼저 받아 깨끗하게 시작한다.
  if (viewer.backlog() > BACKPRESSURE_MAX) {
    viewer.close(4003, 'too slow');
    return;
  }
  const head = Buffer.alloc(1);
  head.writeUInt8(flags, 0);
  viewer.write(Buffer.concat([head, data]));
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
        for (const v of entry.clients) send(v, flags, f.data);
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
  for (const v of entry.clients) v.close(code, reason);
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

/**
 * back 릴레이용 스트림 — **폰·다른 PC** 가 이 화면을 볼 때 쓰는 길.
 *
 * 로컬 웹뷰는 위의 127.0.0.1 WebSocket 에 직접 붙지만, 다른 기기는 그 주소에 닿을 수 없다.
 *  대신 back 이 `stream_open kind='emu'` 를 지시하면 데몬이 back 으로 **다이얼백**해서 같은
 *  프레임을 흘린다(터미널 pty·프리뷰 tcp 스트림과 같은 배관 — 새로 여는 포트가 없다).
 *
 * ⚠ 보내는 바이트는 로컬 WS 와 **글자 그대로 같다**([플래그 1바이트][H.264]). 두 경로가 다른 모양이면
 *  화면 코드가 두 벌이 되고, 그러면 반드시 한쪽만 고쳐진다.
 */
function openRelayStream({ serverUrl, deviceToken }, { streamToken, params }, deps) {
  const a = params || {};
  const url = String(serverUrl).replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${deviceToken}` } });
  let entry = null;
  let viewer = null;
  const leave = () => {
    if (entry && viewer) detach(entry, viewer);
    entry = null; viewer = null;
  };
  ws.on('open', async () => {
    try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ }
    try {
      //  세션 준비는 emulator.js 가 한다(도구 찾기·id 검증이 거기 있다) — 여기서 다시 만들지 않는다.
      const info = await deps.startFor(a);
      entry = streams.get(info.streamId);
      if (!entry) throw new Error('스트림을 찾지 못했어요');
      //  화면이 먼저 알아야 하는 것: 영상 크기(좌표 환산의 기준). 프레임 앞에 텍스트 한 줄로 보낸다.
      ws.send(JSON.stringify({ type: 'meta', width: info.width, height: info.height, codec: info.codec }));
      viewer = wsViewer(ws);
      attach(entry, viewer);
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', message: (e && e.message) || String(e) })); } catch (_) { /* noop */ }
      try { ws.close(); } catch (_) { /* noop */ }
    }
  });
  ws.on('close', leave);
  ws.on('error', leave);
}

/**
 * LAN 직결 스트림 — **같은 Wi-Fi 에 있는 폰**이 이 화면을 볼 때 쓰는 길(lan.js 의 `emu` 채널).
 *
 * 왜 이게 필요한가(2026-08-05 실측). 폰의 화면 지연을 시계 화면으로 재 봤다:
 *   릴레이(폰→CF→홈서버→CF→PC)   310~420 ms
 *   LAN 직결(폰→PC)                 96~109 ms   ← 같은 디코딩 코드, 같은 바이트
 *  인코딩 자체는 64ms 다(터치→첫 프레임). 즉 **남는 250ms 는 전부 우회 경로 값**이었다.
 *  릴레이는 지우지 않는다 — 셀룰러·외부 접속의 영구 폴백이다.
 *
 * ⚠ 흘리는 바이트는 로컬/릴레이와 **글자 그대로 같다**([플래그 1바이트][H.264]). 화면 코드가
 *  경로마다 갈라지면 반드시 한쪽만 고쳐진다 — 그래서 뷰어 인터페이스 하나로 모은다.
 *
 * @param {{ id?: string }} params  emulator.streamStart 와 같은 인자
 * @param {{ sendText, sendBinary, closed:()=>boolean, backlog:()=>number, close:Function }} chan
 * @param {{ startFor: Function }} deps
 * @returns {Promise<{ detach: Function }>}
 */
async function openLanStream(params, chan, deps) {
  const info = await deps.startFor(params || {});
  const entry = streams.get(info.streamId);
  if (!entry) throw new Error('스트림을 찾지 못했어요');
  //  릴레이와 같은 순서: meta(텍스트) 먼저, 그 다음 config, 그 다음 프레임.
  chan.sendText(JSON.stringify({ type: 'meta', width: info.width, height: info.height, codec: info.codec }));
  const viewer = {
    alive: () => !chan.closed(),
    backlog: () => chan.backlog(),
    write: (buf) => chan.sendBinary(buf),
    close: () => chan.close(),
  };
  attach(entry, viewer);
  return { detach: () => detach(entry, viewer) };
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

module.exports = {
  start, stop, stopAll, sessionFor, openRelayStream, openLanStream,
  attach, attachWs, detach, wsViewer,
  _streams: streams, FLAG_CONFIG, FLAG_KEY, LINGER_MS, BACKPRESSURE_MAX,
};
