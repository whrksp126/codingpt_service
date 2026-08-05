// LAN 직결(기능4) 서버측 게이팅 — env 스위치만 모아 둔 곳(순수 함수, 테스트 노출).
//
// 왜 별도 파일인가: LAN 직결은 "데몬의 인바운드 포트 0" 불변식을 깨는 유일한 기능이라
//  되돌리기 스위치가 한 곳에 모여 있어야 한다. 이 파일의 두 함수만 false/빈배열이 되면
//  · caps 에서 `lan.v1` 이 사라져 데몬이 리스너를 아예 열지 않고(config/caps.js)
//  · /api/daemon/lan/grant 가 404 LAN_UNSUPPORTED 를 돌려줘 클라이언트가 릴레이로 회귀한다.
//
// 규율
//  · **기본은 꺼짐**(명시적으로 켜야 함). 다른 env 스위치들(APPROVAL_ENABLED 등)은 "미설정=켜짐"
//    이지만 LAN 은 반대다 — 사용자 PC 에 리스너를 여는 기능이라 실수로 켜지면 안 된다(fail-closed).
//  · scope 는 단계적 개방(F1 프리뷰 → F2 fs → F3 터미널). 기본 'tcp'(프리뷰 포워딩) 하나뿐이라
//    fs/터미널은 서버가 grant 에 scope 를 안 실어 주는 것만으로 기존 릴레이 경로에 남는다.
//    회귀 위험이 큰 터미널(pty)을 클라이언트 코드가 아니라 **서버 한 줄로** 통제하는 게 요점.

// 명시적으로 켜져 있는가('1'|'true'|'on'|'yes'). 미설정/그 외 = 꺼짐.
function envOn(v) {
  return /^(1|true|on|yes)$/i.test(String(v == null ? '' : v).trim());
}

// LAN 직결 전체 스위치.
function lanEnabled(env = process.env) {
  return envOn(env.LAN_DIRECT_ENABLED);
}

// 존재하는 scope 전체(와이어 계약 §2.3 의 scopes) — 이 밖의 문자열은 전부 버린다.
//  tcp = 프리뷰 포트 포워딩(raw TCP 채널) / rpc = fs 등 제어 RPC / pty = 터미널 스트림
//  emu = 모바일 화면 라이브 영상(H.264). 2026-08-05 실측으로 들어왔다 — 폰의 화면 지연이
//        릴레이 310~420ms vs LAN 직결 96~109ms 였다(인코딩 자체는 64ms). 남는 250ms 가
//        전부 "폰→CF→홈서버→CF→PC" 우회 값이라, 같은 Wi-Fi 일 때만 그 우회를 뺀다.
const SCOPES_ALL = ['tcp', 'rpc', 'pty', 'emu'];

// 서버가 grant 에 실어 줄 수 있는 scope 집합. 미설정 기본 = ['tcp'] (프리뷰만).
//  LAN_SCOPES='tcp,rpc' 로 fs 를, 'tcp,rpc,pty' 로 터미널까지 단계 개방한다.
function allowedScopes(env = process.env) {
  const raw = env.LAN_SCOPES == null ? 'tcp' : String(env.LAN_SCOPES);
  const out = [];
  for (const part of raw.split(',')) {
    const s = part.trim().toLowerCase();
    if (SCOPES_ALL.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// grant 수명(ms). 기본 10분. 30초~1시간 밖의 값은 무시(오타로 영구 토큰이 되는 것 방지).
function grantTtlMs(env = process.env) {
  const n = Number(env.LAN_GRANT_TTL_MS);
  if (Number.isFinite(n) && n >= 30 * 1000 && n <= 60 * 60 * 1000) return Math.floor(n);
  return 10 * 60 * 1000;
}

module.exports = { lanEnabled, allowedScopes, grantTtlMs, SCOPES_ALL, _envOn: envOn };
