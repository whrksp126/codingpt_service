// capability 협상 사전 — 구버전 데몬/앱/PC 가 섞여 붙는 환경에서 "기능 켜도 되는가"를
//  버전 문자열 비교가 아니라 능력 문자열 교집합으로 판정하기 위한 정본.
//  (설계: docs/구현설계-2026-07-25/통합리스크-검증계획.md §2-(d))
//
// 규칙
//  · 게이팅 = 데몬caps ∩ SERVER_CAPS ∩ (해당 기기 caps). 하나라도 없으면 폴백 = "기존 동작".
//  · 따라서 SERVER_CAPS 에는 **서버가 실제로 처리 코드를 가진 것만** 넣는다.
//    아직 안 만든 기능을 미리 선언하면 데몬이 그 기능을 켜고 서버는 프레임을 버려 조용히 유실된다.
//  · 능력 문자열은 `<도메인>.v<N>` 형식. 계약이 바뀌면 v 를 올리고(구 문자열 유지 기간 확보) 교체한다.
//
// 지금 선언하는 것
//  · caps.v1      — "이 서버는 caps 협상 자체를 이해한다"는 자기기술 마커(기능 아님).
//  · approval.v1  — 원격 승인 인박스(기능1). 서버측 = approvalService + /api/daemon/approvals/*
//                   + approval_event 팬아웃 + 승인 알림/푸시. 서버 킬스위치 APPROVAL_ENABLED=0 으로
//                   끄면 이 능력을 **선언하지 않는다** → 데몬 교집합이 깨져 훅이 기존 동작(TUI)으로 폴백.
//  · transcript.v1 — 트랜스크립트(채팅) 릴레이(기능5). 서버측 = /api/daemon/chat/* callRpc 프록시
//                   + chat_event 라이브 팬아웃. TRANSCRIPT_ENABLED=0 으로 끌 수 있다.
//
// 앞으로 추가될 자리(해당 기능의 서버측 코드가 머지되는 커밋에서 함께 켠다)
//  · 'agentstate.v1'  — 데몬 agent_state 수신·rseq 부여·팬아웃이 들어갈 때 (기능3 2단계)

// env 값이 명시적으로 꺼져 있는가('0'|'false'|'off'). 미설정 = 켜짐(기본값).
function envOff(v) {
  return /^(0|false|off|no)$/i.test(String(v == null ? '' : v).trim());
}

// 순수 함수(테스트 노출) — env 객체를 받아 선언 목록을 만든다.
function computeServerCaps(env = process.env) {
  const caps = ['caps.v1'];
  if (!envOff(env.APPROVAL_ENABLED)) caps.push('approval.v1');
  if (!envOff(env.TRANSCRIPT_ENABLED)) caps.push('transcript.v1');
  return caps;
}

const SERVER_CAPS = computeServerCaps(process.env);

module.exports = { SERVER_CAPS, computeServerCaps, _envOff: envOff };
