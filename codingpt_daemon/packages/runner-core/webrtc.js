/**
 * 모바일 화면 **WebRTC 송신** — 외부망에서 서버를 우회한다.
 *
 * 왜(2026-08-06, 실측에서 나온 결론):
 *  같은 Wi-Fi 는 LAN 직결로 ~120ms 를 냈지만(emulator-stream 의 openLanStream), 밖에서는
 *  폰→CF→홈서버→CF→PC 를 돌아 **310~420ms** 다. 그 250ms 는 서버를 거치는 거리 값이라
 *  코드로 못 줄인다 — 서버를 **안 거치면** 줄어든다. 그게 WebRTC 다.
 *  · P2P 가 뚫리면 폰↔PC 직결(서버 부하 0)
 *  · 안 뚫리면 TURN 중계(홈서버 coturn 재사용)
 *  · 둘 다 실패하면 기존 릴레이가 그대로 남아 있다(이 파일은 **순수 추가 경로**다)
 *
 * WebRTC 를 쓰는 두 번째 이유는 P2P 보다 실은 이쪽이 더 크다: **혼잡 제어**.
 *  지금 릴레이는 3.4Mbps 를 무조건 밀어 넣어서, 회선이 못 따라가면 큐가 자라고 지연이 계속
 *  커지다가 우리가 시청자를 끊는다. RTP/RTCP 는 링크를 재서 화질을 낮춘다 — "느려짐" 대신 "흐려짐".
 *
 * 설계 규율
 *  · **바이트 계약은 하나다.** 이 세션은 emulator-stream 에 **뷰어로 붙는다**(attach). 그래서
 *    config 선행·GOP 되감기·수명 관리가 로컬/릴레이/LAN 과 완전히 같은 코드다. 여기서 프레임을
 *    따로 긁어오지 않는다.
 *  · **지연 require.** node-datachannel 은 네이티브 모듈이라 번들이 깨진 환경에서도 데몬 전체가
 *    죽으면 안 된다 — 못 부르면 이 기능만 없는 것으로 조용히 내려간다(lan.js 의 pty 와 같은 규율).
 *  · **non-trickle ICE.** 데몬 쪽 후보 수집이 실측 131ms 라(TURN relay 포함) trickle 로 얻을 게
 *    거의 없다. offer/answer 각 한 번씩, RPC 두 번 왕복으로 끝난다 — 새 이벤트 타입이 필요 없다.
 */
const crypto = require('crypto');
const stream = require('./emulator-stream');

/** 세션이 answer 를 받지 못하면 이만큼 뒤 정리한다(폰이 도중에 꺼진 경우). */
const ANSWER_TIMEOUT_MS = 30_000;
/** 연결이 붙지 않으면 이만큼 뒤 포기한다 — 붙지도 못한 세션이 인코더를 잡고 있으면 안 된다. */
const CONNECT_TIMEOUT_MS = 25_000;

const H264_PAYLOAD_TYPE = 96;
const CLOCK_RATE = 90_000;

/** sessionId → { pc, track, entry, detach, timers } */
const sessions = new Map();

let dcLib = null;
let dcTried = false;
function lib() {
  if (dcTried) return dcLib;
  dcTried = true;
  try { dcLib = require('node-datachannel'); } catch (e) {
    console.warn(`[webrtc] 사용 불가(${e.message}) — 릴레이/LAN 경로만 씁니다`);
    dcLib = null;
  }
  return dcLib;
}

function available() { return !!lib(); }

/**
 * 클라이언트가 준 ICE 서버 목록을 libdatachannel 형식으로 옮긴다.
 *  브라우저 형식(`{urls, username, credential}`)을 그대로 받아서, 서버(back)가 정본을 쥐고
 *  데몬은 해석만 한다 — 데몬에 TURN 시크릿을 두지 않기 위해서다(자격증명 무접촉 규율의 연장).
 */
function toIceServers(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const urls = typeof s === 'string' ? [s] : [].concat(s.urls || []);
    for (const raw of urls) {
      const u = String(raw || '');
      const m = /^(stun|turn|turns):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(u);
      if (!m) continue;
      const [, scheme, host, port, transport] = m;
      if (scheme.toLowerCase() === 'stun') { out.push(`stun:${host}:${port || 3478}`); continue; }
      if (!s.username || !s.credential) continue;   // TURN 은 크리덴셜 없이 의미가 없다
      out.push({
        hostname: host,
        port: Number(port || (scheme.toLowerCase() === 'turns' ? 5349 : 3478)),
        username: String(s.username),
        password: String(s.credential),
        relayType: scheme.toLowerCase() === 'turns' ? 'TurnTls'
          : (transport === 'tcp' ? 'TurnTcp' : 'TurnUdp'),
      });
    }
  }
  return out;
}

/**
 * 송신 세션을 만들고 **offer(SDP)** 를 돌려준다. 후보 수집이 끝난 뒤의 완성된 SDP 다(non-trickle).
 *
 * @param {{ id?: string }} params      emulator.streamStart 와 같은 인자
 * @param {Array} iceServers            브라우저 형식 ICE 서버(단명 TURN 크리덴셜 포함)
 * @param {{ startFor: Function }} deps
 * @returns {Promise<{ sessionId, sdp, type }>}
 */
async function createOffer(params, iceServers, deps) {
  const dc = lib();
  if (!dc) throw new Error('이 PC 는 직접 연결(WebRTC)을 지원하지 않아요');

  const info = await deps.startFor(params || {});
  const entry = stream._streams.get(info.streamId);
  if (!entry) throw new Error('스트림을 찾지 못했어요');

  const sessionId = crypto.randomBytes(8).toString('hex');
  const pc = new dc.PeerConnection(`cpt-${sessionId}`, {
    iceServers: toIceServers(iceServers),
    //  둘 다 시도한다. 뚫리면 P2P(서버 부하 0), 아니면 TURN 이 받아 준다.
    iceTransportPolicy: 'all',
  });

  const video = new dc.Video('video', 'SendOnly');
  video.addH264Codec(H264_PAYLOAD_TYPE);
  const track = pc.addTrack(video);

  //  RTP 파이프라인: 패킷화(Annex-B 그대로) → 발신자 리포트 → NACK 응답.
  //   scrcpy 가 주는 바이트가 이미 start code 구분자라 변환이 필요 없다.
  const rtpConfig = new dc.RtpPacketizationConfig(
    crypto.randomBytes(4).readUInt32BE(0), 'cpt', H264_PAYLOAD_TYPE, CLOCK_RATE,
  );
  const packetizer = new dc.H264RtpPacketizer('StartSequence', rtpConfig);
  packetizer.addToChain(new dc.RtcpSrReporter(rtpConfig));
  packetizer.addToChain(new dc.RtcpNackResponder());
  track.setMediaHandler(packetizer);

  const sess = {
    sessionId, pc, track, rtpConfig, entry,
    detach: null, lastSendAt: 0, connected: false,
    answerTimer: null, connectTimer: null,
    //  진단용 — "붙었는데 화면이 검다" 를 소켓 바이트 세지 않고 바로 알기 위해서다.
    sent: 0, droppedClosed: 0, config: null,
  };
  sessions.set(sessionId, sess);

  //  ★ 프레임은 emulator-stream 의 **뷰어**로 받는다 — 로컬/릴레이/LAN 과 같은 한 벌.
  //   받는 모양은 `[플래그 1바이트][H.264 Annex-B]` 이고, 여기서 머리 1바이트만 떼면 된다.
  const viewer = {
    alive: () => sessions.has(sessionId),
    //  네이티브 호출은 트랙 상태에 따라 던질 수 있다 — 밀린 양을 못 재는 건 0으로 본다.
    backlog: () => { try { return track.isOpen() ? track.bufferedAmount() : 0; } catch (_) { return 0; } },
    write: (buf) => feed(sess, buf),
    close: () => close(sessionId),
  };
  //  attach 는 config 선행 + GOP 되감기까지 해 준다(늦게 들어온 화면이 즉시 뜨는 이유).
  stream.attach(entry, viewer);
  sess.detach = () => stream.detach(entry, viewer);

  track.onOpen(() => {
    sess.connected = true;
    clearTimeout(sess.connectTimer);
    //  ★ attach 가 준 config/GOP 는 트랙이 열리기 **전에** 왔다 — 그때 보낸 건 전부 버려진다.
    //   그리고 scrcpy 2.4 는 키프레임을 거의 안 보내므로(실측 5.3초에 0장) 그냥 두면 수신측은
    //   델타만 받아 영영 못 푼다. 열리는 즉시 지금 GOP 를 다시 틀어 준다.
    replayGop(sess);
  });
  track.onClosed(() => close(sessionId));
  pc.onStateChange((st) => {
    if (st === 'disconnected' || st === 'failed' || st === 'closed') close(sessionId);
  });

  const sdp = await gatherOffer(pc);
  sess.answerTimer = setTimeout(() => close(sessionId), ANSWER_TIMEOUT_MS);
  sess.connectTimer = setTimeout(() => { if (!sess.connected) close(sessionId); }, CONNECT_TIMEOUT_MS);
  return { sessionId, sdp: sdp.sdp, type: sdp.type, width: info.width, height: info.height };
}

/** 지금 GOP(마지막 키프레임 + 그 뒤 델타)를 트랙에 다시 넣는다 — emulator-stream 의 되감기와 같은 재료. */
function replayGop(sess) {
  const e = sess.entry;
  if (!e) return;
  if (e.session && e.session.configPacket) sess.config = Buffer.from(e.session.configPacket);
  for (const [flags, data] of e.gop || []) {
    const head = Buffer.alloc(1); head.writeUInt8(flags, 0);
    feed(sess, Buffer.concat([head, data]));
  }
}

/** 후보 수집이 끝난 완성 SDP 를 기다린다(non-trickle). */
function gatherOffer(pc) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const d = pc.localDescription();
      if (!d) { reject(new Error('연결 정보를 만들지 못했어요')); return; }
      resolve(d);
    };
    pc.onGatheringStateChange((st) => { if (st === 'complete') finish(); });
    //  수집이 영영 안 끝나는 망도 있다(방화벽). 모아 둔 것만으로 시작한다 — 실측 정상값은 131ms.
    setTimeout(finish, 5000);
    pc.setLocalDescription();
  });
}

/** 폰이 만든 answer 를 넣는다. */
function acceptAnswer(sessionId, sdp) {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error('연결 세션을 찾지 못했어요');
  clearTimeout(sess.answerTimer);
  sess.answerTimer = null;
  sess.pc.setRemoteDescription(String(sdp), 'answer');
  return { ok: true };
}

/**
 * 프레임 한 장을 트랙에 넣는다.
 *  타임스탬프는 **보내는 시각 기준**으로 진행시킨다. scrcpy 의 PTS 를 쓸 수도 있지만 뷰어
 *  인터페이스에는 안 실려 있고, 우리는 도착 즉시 보내므로 벽시계와 사실상 같다.
 */
function feed(sess, buf) {
  if (!buf || buf.length < 2) return;
  const flags = buf[0];
  const body = buf.subarray(1);
  //  config(SPS/PPS)는 단독으로 보내지 않고 들고 있다가 키프레임 앞에 붙인다 — Annex-B 는
  //   첫 IDR 앞에 SPS/PPS 가 있어야 하고, 이 규칙이 WebCodecs 클라이언트와 **같아야** 한다.
  if (flags & stream.FLAG_CONFIG) { sess.config = Buffer.from(body); return; }
  if (!sess.track.isOpen()) { sess.droppedClosed += 1; return; }

  const now = Date.now();
  if (sess.lastSendAt) {
    const dt = now - sess.lastSendAt;
    sess.rtpConfig.timestamp = (sess.rtpConfig.timestamp + Math.max(1, Math.round(dt * (CLOCK_RATE / 1000)))) >>> 0;
  }
  sess.lastSendAt = now;

  const isKey = !!(flags & stream.FLAG_KEY);
  const payload = (isKey && sess.config) ? Buffer.concat([sess.config, body]) : body;
  try { sess.track.sendMessageBinary(payload); sess.sent += 1; } catch (_) { /* 끊긴 트랙 — onClosed 가 정리한다 */ }
}

function close(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return { ok: true };
  sessions.delete(sessionId);
  clearTimeout(sess.answerTimer);
  clearTimeout(sess.connectTimer);
  try { sess.detach?.(); } catch (_) { /* noop */ }
  try { sess.track.close(); } catch (_) { /* noop */ }
  try { sess.pc.close(); } catch (_) { /* noop */ }
  return { ok: true };
}

function closeAll() { for (const id of [...sessions.keys()]) close(id); }

//  데몬이 죽을 때 세션을 남기지 않는다(인코더가 계속 도는 것 방지 — emulator-stream 과 같은 규율).
process.once('exit', () => { try { closeAll(); } catch (_) { /* noop */ } });

module.exports = {
  available, createOffer, acceptAnswer, close, closeAll, toIceServers,
  _feed: feed, _replayGop: replayGop,
  _sessions: sessions, ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, H264_PAYLOAD_TYPE, CLOCK_RATE,
};
