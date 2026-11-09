// stream-codec.js — codingpt_app/src/services/e2ee/streamCodec.js 의 동일 사본(import 경로만 다름). 뷰어 측 봉인 스트림 채널.
//  터미널 WebView 안(번들 문자열로 주입)과 RN(포트 포워더)이 같은 코드를 쓴다.
//  connId 는 여는 쪽(뷰어)이 정한다 — 데몬은 첫 수신 프레임에서 학습한다(pty.js wsPtyIo).
import core from './e2ee-core.js';
import { sealFrame, openFrame } from './e2ee-proto.js';

const DIR_V2H = 0x01;
const DIR_H2V = 0x02;
export const KIND_DATA = 0x0;
export const KIND_CTRL = 0x1;

/** keys = { kV2H, kH2V, sid } (b64u 문자열) */
export function createChannel(keys) {
  const kV2H = core.b64uDec(keys.kV2H);
  const kH2V = core.b64uDec(keys.kH2V);
  const sid = core.b64uDec(keys.sid);
  let connId = 0;
  while (connId === 0) { const r = core.randomBytes(4); connId = ((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0; }
  let sendCtr = 0;
  let recvCtr = 0;
  return {
    connId,
    /** 문자열 = 제어 JSON(ctrl), 바이트 = stdin(data). */
    seal(data) {
      const isText = typeof data === 'string';
      const payload = isText ? core.utf8(data) : (data instanceof ArrayBuffer ? new Uint8Array(data) : core.u8(data));
      sendCtr += 1;
      return sealFrame(kV2H, sid, DIR_V2H, isText ? KIND_CTRL : KIND_DATA, connId, sendCtr, payload);
    },
    /** @returns {{kind:number, payload:Uint8Array}|null} — 변조·리플레이·방향 혼동이면 null(프레임만 버린다). */
    open(frame) {
      const f = openFrame(kH2V, sid, frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame);
      if (!f || f.dir !== DIR_H2V || f.connId !== connId || f.counter <= recvCtr) return null;
      recvCtr = f.counter;
      return { kind: f.kind, payload: f.payload };
    },
    text(bytes) { return core.fromUtf8(bytes); },
  };
}

/** WebView 용: 순수 JS 난수원 연결(crypto.getRandomValues — 비보안 컨텍스트에서도 있다). */
export function installRandom(getRandomValues) {
  core.setRandomSource((n) => { const b = new Uint8Array(n); getRandomValues(b); return b; });
}
