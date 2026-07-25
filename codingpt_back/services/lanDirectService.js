// LAN 직결 시그널링(기능4) — 순수 검증/발급 로직.
//
// 역할: "같은 Wi-Fi 라면 폰↔PC 가 서버를 안 거치게" 하기 위해 서버는 **소개장만** 발급한다.
//   ① 데몬이 제어 WS 로 자기 사설 IP 후보를 신고(hello.lan / lan_update) → conn 에 보관(DB 무접촉)
//   ② 뷰어가 POST /api/daemon/lan/grant → 서버가 단명 grant 를 만들어 데몬에 미리 통지 + 뷰어에 회신
//   ③ 뷰어가 사설 IP:포트로 raw TCP 직결 → grant 를 **와이어에 흘리지 않고** challenge-response 로 증명
//
// 서버가 secret 을 안다는 사실이 무해해야 한다는 요구(E2EE 아님)의 근거:
//   grant 는 "누가 접속해도 되는가"만 정한다. LAN 리스너는 사설 대역 피어만 받고(아래 isPrivateHost),
//   secret 은 nonce 와 묶인 MAC 으로만 쓰이므로 재사용/재생이 불가하다. 서버가 악의적이어도
//   같은 LAN 안에 들어와 있지 않으면 이 grant 로 아무것도 못 한다(네트워크 인접성이 2요소).
//
// ★ 이 파일은 소켓/WS 를 모르고 throw 하지 않는(=배관 안전) 순수 함수만 갖는다.
//   실제 전송/conn 조회는 daemonRelayService.issueLanGrant 가 한다.
const crypto = require('crypto');

const SCOPES_ALL = ['tcp', 'rpc', 'pty']; // config/lanDirect.js 와 같은 집합(여기선 데몬 신고 정규화용)
const ADDRS_MAX = 8;          // 인터페이스 후보 상한(응답/메모리 비대 방지)
const IFNAME_MAX = 24;
const HOST_MAX = 45;          // IPv6 최대 표기 길이

// ── 사설 대역 판정 ─────────────────────────────────────────────────────
// 공용 IP 를 절대 받아들이지 않는 게 이 기능의 보안 축이다(데몬이 WAN 에 서비스를 노출하는 사고 방지).
// 반환: 4 | 6 (사설/루프백) · 0 (거부). 호스트명·CIDR·포트 표기는 전부 거부(IP 리터럴만).

function parseIPv4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]];
  // 선행 0 거부 — '010.0.0.1' 을 8진수로 읽는 파서가 섞이면 대역 판정이 우회된다.
  if (parts.some((p) => p.length > 1 && p[0] === '0')) return null;
  const o = parts.map(Number);
  if (o.some((x) => x > 255)) return null;
  return o;
}

function isPrivate4(o) {
  if (o[0] === 10) return true;                       // 10/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
  if (o[0] === 192 && o[1] === 168) return true;      // 192.168/16
  if (o[0] === 127) return true;                      // 루프백(같은 기기 — 무해)
  return false;                                       // 169.254(링크로컬)·공용 전부 거부
}

// IPv6 는 ULA(fc00::/7)와 루프백(::1)만 받는다. fe80(링크로컬)은 zone id 없이는 못 붙고
//  스코프 혼동 사고가 잦아 거부. ::ffff:a.b.c.d 는 v4 로 환산해 판정.
function ipv6Family(hRaw) {
  const h = hRaw.toLowerCase();
  if (h.includes('%')) return 0;                       // zone id 포함 = 거부
  if (!/^[0-9a-f:.]+$/.test(h)) return 0;
  if (h === '::1') return 6;
  const v4mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4mapped) { const o = parseIPv4(v4mapped[1]); return o && isPrivate4(o) ? 4 : 0; }
  if (!h.includes(':')) return 0;
  // 그룹 수 검사(느슨하지만 문법 오류/주입 문자열 차단용) — '::' 축약 허용.
  const groups = h.split(':');
  if (groups.length > 8) return 0;
  if (groups.some((g) => g.length > 4)) return 0;
  // fc00::/7 = 첫 바이트가 0xfc|0xfd
  return /^f[cd]/.test(h) ? 6 : 0;
}

function isPrivateHost(hostRaw) {
  const host = String(hostRaw == null ? '' : hostRaw).trim();
  if (!host || host.length > HOST_MAX) return 0;
  const o = parseIPv4(host);
  if (o) return isPrivate4(o) ? 4 : 0;
  return ipv6Family(host);
}

// ── hello.lan / lan_update 정규화 ──────────────────────────────────────
// 데몬이 신고하는 "자기 신고" 값이므로 그대로 저장하지 않는다(caps 와 동일 신뢰 경계).
//  실패는 null 반환 = "이 데몬은 LAN 미지원" → grant 라우트가 404 LAN_UNSUPPORTED.
function normLanInfo(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const port = Number(v.port);
  // 1024 미만(특권 포트)은 데몬이 열 수 없고, 열려 있다면 우리 것이 아니다.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const proto = Number.isInteger(v.proto) && v.proto > 0 && v.proto < 1000 ? v.proto : 1;
  const addrs = [];
  if (Array.isArray(v.addrs)) {
    for (const a of v.addrs) {
      if (addrs.length >= ADDRS_MAX) break;
      if (!a || typeof a !== 'object') continue;
      const host = typeof a.host === 'string' ? a.host.trim() : '';
      const family = isPrivateHost(host);
      if (!family) continue;                                  // 공용/링크로컬/문법오류 = 폐기
      if (addrs.some((x) => x.host === host)) continue;        // 중복 제거
      addrs.push({ host, ifname: typeof a.ifname === 'string' ? a.ifname.slice(0, IFNAME_MAX) : '', family });
    }
  }
  if (!addrs.length) return null;
  // 데몬이 신고한 자기 scope(CPT_LAN_SCOPE 로 데몬쪽에서도 단계 개방한다). 신고가 없으면(구버전)
  //  제약을 걸지 않는다 — 대신 데몬이 핸드셰이크에서 자기 기준으로 다시 교집합을 낸다(이중 방어).
  const daemonScopes = Array.isArray(v.scopes)
    ? v.scopes.filter((s) => typeof s === 'string' && SCOPES_ALL.includes(s.trim().toLowerCase())).map((s) => s.trim().toLowerCase())
    : null;
  return { proto, port, addrs, daemonScopes };
}

// 두 lan 정보가 실질적으로 같은가(lan_update 팬아웃 필요 판정 — 무의미한 재랜더 방지).
function sameLanInfo(a, b) {
  if (!a || !b) return a === b;
  if (a.port !== b.port || a.proto !== b.proto || a.addrs.length !== b.addrs.length) return false;
  if (String(a.daemonScopes || '') !== String(b.daemonScopes || '')) return false;
  for (let i = 0; i < a.addrs.length; i++) {
    if (a.addrs[i].host !== b.addrs[i].host) return false;
  }
  return true;
}

// ── scope 협상 ────────────────────────────────────────────────────────
// 클라 요청 ∩ 서버 허용. 순서는 **서버 허용 순서**를 따른다(클라가 순서로 우선권을 못 만들게).
//  요청이 비었으면 "허용 전체"가 아니라 ['tcp'] 로 최소 부여한다(과다 부여 금지).
function normScopes(requested, allowed) {
  const allow = Array.isArray(allowed) ? allowed : [];
  const req = Array.isArray(requested)
    ? requested.filter((s) => typeof s === 'string').map((s) => s.trim().toLowerCase())
    : ['tcp'];
  const want = req.length ? req : ['tcp'];
  return allow.filter((s) => want.includes(s));
}

// ── grant 발급 ────────────────────────────────────────────────────────
// grantId  — 로그/매칭용 공개 식별자(비밀 아님)
// secret   — HMAC 키(32B). 와이어에는 절대 흐르지 않는다(challenge-response 의 키로만 쓰임).
function newGrant(opts) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 10 * 60 * 1000;
  return {
    grantId: 'lg-' + crypto.randomBytes(12).toString('hex'),
    secret: crypto.randomBytes(32).toString('base64'),
    clientKey: String(opts.clientKey || '').slice(0, 128),
    kind: opts.kind === 'pc' ? 'pc' : 'mobile',
    scopes: Array.isArray(opts.scopes) ? opts.scopes.slice() : [],
    hostDeviceId: opts.hostDeviceId,
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
    issuedAt: now,
  };
}

// grant 발급 폭주 방지(대상 데몬 보호) — (userId, hostDeviceId) 당 1분 창 카운터.
//  ★ 이건 클라이언트 재시도 버그로 데몬이 초당 수십 grant 를 받아 메모리를 먹는 사고를 막는 안전판이다.
//  IP 기준 라우트 rate limit(라우트 레이어)과 목적이 다르므로 둘 다 둔다.
const GRANT_RATE_WINDOW_MS = 60 * 1000;
const GRANT_RATE_MAX = 20;
const grantRate = new Map(); // key → { windowStart, count }

function allowGrant(userId, hostDeviceId, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const key = `${userId}:${hostDeviceId}`;
  let r = grantRate.get(key);
  if (!r || t - r.windowStart >= GRANT_RATE_WINDOW_MS) { r = { windowStart: t, count: 0 }; grantRate.set(key, r); }
  r.count += 1;
  return r.count <= GRANT_RATE_MAX;
}

function sweepGrantRate(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  for (const [k, r] of grantRate) { if (t - r.windowStart >= GRANT_RATE_WINDOW_MS) grantRate.delete(k); }
}

// grant 응답의 endpoints — 뷰어가 순서대로 시도한다. IPv4 를 먼저(대부분의 홈망에서 성공률·지연 우위).
function endpointsOf(lan) {
  if (!lan) return [];
  const v4 = lan.addrs.filter((a) => a.family === 4);
  const v6 = lan.addrs.filter((a) => a.family === 6);
  return [...v4, ...v6].map((a) => ({ host: a.host, port: lan.port, family: a.family }));
}

module.exports = {
  isPrivateHost, normLanInfo, sameLanInfo, normScopes, newGrant, endpointsOf,
  allowGrant, sweepGrantRate,
  _ADDRS_MAX: ADDRS_MAX,
};
