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
/**
 * **따라잡기용** 조각 — 디코더를 지금 시점까지 데려오려고 되감아 주는 것이지, **보여 줄 그림이 아니다.**
 *
 * ★ 왜 필요한가(2026-08-06 폰 실측): 새 시청자가 붙으면 지금 GOP(키프레임~현재)를 통째로 되감아
 *  준다 — 안 그러면 다음 키프레임까지 검은 화면이다. 그런데 받는 쪽이 그걸 **한 장씩 다 그리면**
 *  방금 지나간 몇 초가 빨리감기로 재생된다. 사용자에겐 "탭을 갔다 오면 화면이 저절로 올라갔다
 *  내려간다" 로 보인다(기기 화면은 1바이트도 안 바뀌었는데도).
 * ★ 받는 쪽에서 "밀린 프레임은 안 그린다" 만으로는 부족하다 — 조각이 몇 tick 에 나눠 도착하면
 *  그 사이사이 그려져서 결국 재생된다. **보내는 쪽이 표시**해야 결정적으로 막힌다.
 * ★ 이 비트를 모르는 구 화면은 그냥 다 그린다(= 예전 동작) — 하위호환이 깨지지 않는다.
 */
const FLAG_CATCHUP = 4;

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

/**
 * 지금 GOP(마지막 키프레임 + 그 뒤 델타 전부)의 보관 상한. 넘으면 버린다 —
 *  늦게 들어온 사람 하나 때문에 메모리를 무한히 쓰지 않는다.
 */
const GOP_MAX_BYTES = 6 * 1024 * 1024;

/**
 * 이미 돌고 있는 세션에 **나중에 들어온 화면**을 위한 되감기.
 *
 * ★ 2026-08-05 실측으로 잡은 것: scrcpy 2.4 는 키프레임을 **세션이 시작할 때 한 번** 보내고
 *  그 뒤엔 거의 안 보낸다(5.3초 세션에서 0장, 정지 화면에서는 영영 0장). 그래서 두 번째 시청자는
 *  config 만 받고 델타만 계속 받는데, H.264 델타는 키프레임 없이 못 푼다 → 화면이 영영 안 뜬다.
 *  실제로 폰이 12초를 기다리다 "화면이 오지 않아요" 로 폴링에 떨어졌다.
 *  키프레임 요청 메시지(RESET_VIDEO)는 scrcpy 3.x 에서 생겼고 우리 서버 jar 는 2.4 라 못 쓴다.
 *  → 대신 **마지막 키프레임부터 지금까지를 그대로 다시 틀어 준다**. 그러면 디코더가 즉시 따라잡는다.
 */
function rememberFrame(entry, flags, data) {
  if (flags & FLAG_CONFIG) return;                 // config 는 session.configPacket 이 들고 있다
  if (flags & FLAG_KEY) { entry.gop = [[flags, data]]; entry.gopBytes = data.length; return; }
  if (!entry.gop || !entry.gop.length) return;     // 키프레임을 아직 못 봤다 — 모아 봐야 못 푼다
  entry.gopBytes += data.length;
  if (entry.gopBytes > GOP_MAX_BYTES) { entry.gop = []; entry.gopBytes = 0; return; }
  entry.gop.push([flags, data]);
}

function attach(entry, viewer) {
  entry.clients.add(viewer);
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  //  새로 붙은 화면에 **먼저 SPS/PPS 를 준다** — 없으면 다음 키프레임이 올 때까지 검은 화면이다.
  if (entry.session.configPacket) send(viewer, FLAG_CONFIG, entry.session.configPacket);
  //  그 다음 지금 GOP 를 되감아 준다(위 주석). 첫 시청자면 비어 있고, 곧 키프레임이 온다.
  //  되감아 주되 **마지막 한 장만 그리게** 한다(위 FLAG_CATCHUP 주석).
  if (entry.gop) {
    for (let i = 0; i < entry.gop.length; i++) {
      const [f, d] = entry.gop[i];
      send(viewer, i === entry.gop.length - 1 ? f : (f | FLAG_CATCHUP), d);
    }
  }
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
async function start({ adb, serial, deviceId, kind, maxSize, maxFps, bitRate }) {
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
    //  마지막 키프레임 이후의 프레임들(늦게 들어온 화면에게 되감아 준다 — rememberFrame 주석).
    gop: [], gopBytes: 0,
  };
  //  ★ 기기 종류마다 화면을 얻는 방법이 다르다 — **바이트 계약은 같다.**
  //   안드로이드=scrcpy(adb), iOS=serve-sim(시뮬레이터 프레임버퍼). 둘 다 Annex-B H.264 를
  //   `{config,keyFrame,data}` 로 올려 주므로, 아래 뷰어·GOP·배압 배관은 한 벌로 끝난다.
  const makeSession = (cbs) => {
    if (kind === 'ios') {
      const { ServeSimSession } = require('./serve-sim-session');
      return ServeSimSession.start({ udid: serial }, cbs);
    }
    //  긴 변 1280 — pane 폭이 800~900px 인 경우가 흔해서 1024 는 눈에 띄게 무르다. 픽셀은 1.5배지만
    //   H.264 라 대역폭은 그만큼 안 오른다(정지 화면은 여전히 사실상 0).
    return ScrcpySession.start(
      { adb, serial, maxSize: maxSize || 1280, maxFps: maxFps || 30, bitRate: bitRate || 6_000_000 }, cbs);
  };
  entry.session = await makeSession(
    {
      onMeta: (m) => { entry.meta = m; },
      onFrame: (f) => {
        const flags = (f.config ? FLAG_CONFIG : 0) | (f.keyFrame ? FLAG_KEY : 0);
        rememberFrame(entry, flags, f.data);
        //  ★ 한 시청자에서 난 예외가 **나머지 전부의 화면을 멈추면 안 된다.** 예전엔 여기서 던지면
        //   상위 try/catch 가 삼켜서, 두 번째 시청자부터는 프레임이 영영 안 갔다(2026-08-06 실사고:
        //   WebRTC 뷰어 하나가 조용히 전체 브로드캐스트를 죽였다 — GOP 는 자라는데 송신은 0이었다).
        for (const v of entry.clients) {
          try { send(v, flags, f.data); }
          catch (e) { console.warn(`[emulator] 시청자 전송 실패: ${(e && e.message) || e}`); }
        }
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
    //  ★ 지금 기기가 어느 방향인가 — **아는 경우에만** 싣는다. serve-sim 헬퍼는 새로 뜰 때
    //   무조건 'portrait' 라고 말하므로(기기에 묻지 않는다) 그걸 그대로 넘기면 이미 눕혀 둔 기기에서
    //   화면이 거짓말을 믿게 된다. 모르면 필드를 아예 빼서 화면이 "안 돌린 상태" 로 두게 한다.
    //   안드로이드는 인코딩 크기 자체가 바뀌므로 이 값이 애초에 없다.
    orientation: entry.session && entry.session.orientationKnown ? entry.session.orientation : undefined,
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
 * "아직 쓰는 중" 이라고 알린다 — linger 타이머를 처음부터 다시 센다.
 *
 * 왜 필요한가: 영상 없이 **조작만** 하는 경우가 있다(폴링으로 보는 화면). 그때는 시청자가 없어서
 *  세션이 16초 뒤 스스로 닫히고, 다음 탭은 헬퍼를 다시 띄우느라 1초 가까이 걸린다. 조작도 사용의
 *  증거로 친다 — 마지막 조작 뒤 16초가 지나야 닫힌다.
 */
function keepAlive(serial) {
  for (const [id, e] of streams) {
    if (e.serial !== serial || e.session.closed) continue;
    if (e.clients.size) return true;                  // 보는 사람이 있으면 타이머 자체가 없다
    if (e.closeTimer) clearTimeout(e.closeTimer);
    e.closeTimer = setTimeout(() => stop(id), LINGER_MS * 2);
    return true;
  }
  return false;
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
  start, stop, stopAll, sessionFor, keepAlive, openRelayStream, openLanStream,
  attach, attachWs, detach, wsViewer, rememberFrame,
  _streams: streams, FLAG_CONFIG, FLAG_KEY, FLAG_CATCHUP, LINGER_MS, BACKPRESSURE_MAX, GOP_MAX_BYTES,
};
