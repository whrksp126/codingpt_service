// WebRTC ICE(STUN/TURN) 서버 발급 — 직접 연결(기능 C) 서버측 게이팅.
//
// 왜 서버가 발급하나: TURN 시크릿은 **서버에만** 둔다. 데몬도 폰도 시크릿을 모르고, 단명
//  크리덴셜만 받아 쓴다(데몬의 "자격증명 무접촉" 규율의 연장). 크리덴셜이 새도 TTL 이 지나면
//  죽고, 우리 TURN 은 중계만 하므로 피해 범위가 좁다.
//
// coturn 의 `use-auth-secret`(REST API) 규약:
//   username   = "<만료 epoch초>:<식별자>"
//   credential = base64( HMAC-SHA1( static-auth-secret, username ) )
// 서버끼리 시각만 맞으면 되고, 사용자 목록을 coturn 에 넣을 필요가 없다.
//
// 규율
//  · **기본은 꺼짐.** TURN_SECRET 이 없으면 빈 목록을 돌려주고, 클라이언트는 직접 연결을
//    건너뛰고 기존 릴레이/LAN 을 그대로 쓴다(fail-closed — LAN 직결과 같은 원칙).
//  · STUN 만 켤 수도 있다(TURN_URLS 에 stun: 만). P2P 는 되고 중계는 안 하는 구성.
const crypto = require('crypto');

/** 크리덴셜 수명. 짧을수록 좋지만 통화 도중 만료되면 재협상이 필요하다 — 10분이 통상값. */
const DEFAULT_TTL_SEC = 600;

/** `turn:host:3478?transport=udp,stun:host:3478` 형태. 미설정이면 빈 배열 = 기능 꺼짐. */
function urls(env = process.env) {
  return String(env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^(stun|turn|turns):/i.test(s));
}

function ttlSec(env = process.env) {
  const n = Number(env.TURN_TTL_SEC);
  if (Number.isFinite(n) && n >= 60 && n <= 3600) return Math.floor(n);
  return DEFAULT_TTL_SEC;
}

/** 켜져 있는가 = 주소가 하나라도 있는가. TURN 은 시크릿까지 있어야 실제로 쓰인다. */
function enabled(env = process.env) { return urls(env).length > 0; }

/**
 * 브라우저 `RTCConfiguration.iceServers` 형식으로 돌려준다 — 폰과 데몬이 **같은 값**을 쓴다.
 *  (데몬은 이 형식을 libdatachannel 형식으로 옮기기만 한다.)
 *
 * @param {string|number} subject  크리덴셜에 박히는 식별자(사용자/기기). 비밀 아님.
 */
function iceServers(subject, env = process.env) {
  const list = urls(env);
  if (!list.length) return [];
  const secret = String(env.TURN_SECRET || '');
  const expiry = Math.floor(Date.now() / 1000) + ttlSec(env);
  const username = `${expiry}:${String(subject || 'cpt').replace(/[^\w.-]/g, '')}`;
  const credential = secret
    ? crypto.createHmac('sha1', secret).update(username).digest('base64')
    : '';
  return list.map((u) => {
    //  STUN 은 인증이 없다 — 크리덴셜을 실으면 일부 구현이 오히려 거부한다.
    if (/^stun:/i.test(u)) return { urls: u };
    //  시크릿이 없으면 TURN 항목은 의미가 없다(데몬/브라우저가 어차피 버린다) → 아예 안 준다.
    return secret ? { urls: u, username, credential } : null;
  }).filter(Boolean);
}

module.exports = { urls, ttlSec, enabled, iceServers, DEFAULT_TTL_SEC };
