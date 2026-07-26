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
//  · e2ee.keys.v1 — **열쇠 배포만**(기능2 A단계). 서버측 = deviceTrustService + /api/daemon/e2ee/*
//                   + device_approval_event 팬아웃 + 페어링 grant 전달. E2EE_ENABLED=0 으로 회수.
//  · e2ee.rpc.v1  — 봉투 RPC 프록시(기능2 B단계). 서버측 = POST /api/daemon/rpc →
//                   callRpc(…,'sealed',{env,hostDeviceId}) 중계 + 데몬 응답 봉투 그대로 회신.
//                   **서버는 봉투를 열지 않는다**(env 를 파싱·기록·재작성하지 않음 = 계약 불변식).
//                   E2EE_ENABLED=0 으로 함께 회수(열쇠가 없으면 봉투도 무의미) — 회수는 caps 선언에서
//                   끝나지 않고 `daemonController.rpcSealed` 가 **같은 문자열을 보고 501** 을 낸다
//                   (선언만 회수하면 이미 열쇠를 가진 클라는 계속 봉투를 왕복한다 — 실증된 결함).
//
//    ★ 2026-07-25 사건 기록 — "선언은 정직했는데 발현이 0" (다음 사람이 같은 실수를 하지 않도록)
//      이 문자열이 선언된 커밋에서 서버측 라우트는 실제로 있었다(선언 조건은 지켜졌다). 그런데도
//      실제 트래픽은 100% 평문이었다: **PC 데몬에 열쇠를 얻는 경로가 없었다**(enroll/keyring 호출 0건,
//      `bootstrapMasterKey`/`acceptGrant` 호출자 = 테스트뿐). 그래서 데몬 caps 는 항상 [] 이고,
//      앱이 봉인해 보내면 데몬이 "열쇠 없음" → back 이 502 → 앱은 폴백해 평문으로 갔다.
//      = 교집합의 **데몬 항**이 비어 있으면 서버 선언이 정직해도 기능은 무발현이다. 그리고 폴백이
//      워낙 견고해서 화면은 정상이라 **아무 신호가 없었다**(잠금 배지만 켜진 "암호화된 척하는 평문").
//      → 교훈 1: caps 선언 조건 점검은 "서버에 코드가 있나" 로 끝나면 안 된다. **교집합의 세 항이 전부
//        찰 수 있는가**(데몬이 그 능력의 전제인 열쇠/상태를 실제로 취득할 수 있는가)까지 봐야 한다.
//      → 교훈 2: 무발현이 로그 0건이면 안 된다. 지금은 (a) 데몬이 '열쇠 없음'을 정직한 코드로 회신하고
//        back 이 501 로 매핑하며(config/e2eeCodes.js), (b) runner_status.e2eeEpoch=0 을 팬아웃해
//        클라이언트가 **호스트별** 자물쇠를 '이 PC 는 평문(열쇠 없음)' 으로 그린다.
//
//    ★ 선언 조건을 "데몬 caps 가 e2ee 를 싣고 올 때만 그 커넥션에 봉인 경로를 연다"로 바꿀지 검토 →
//      **바꾸지 않는다.** 근거:
//       ① SERVER_CAPS 는 *서버가* 무엇을 처리하는지의 자기기술이다(그 지시대상은 라우트다). 커넥션별
//          가능성은 다른 축이고, 그것을 이 배열에 섞으면 hello_ack 이 러너마다 달라져야 한다(불가능 —
//          hello_ack 은 그 데몬 1개에게만 가지만 SERVER_CAPS 는 프로세스 전역 상수다).
//       ② 커넥션별 하드 게이트를 `conn.caps` 로 걸면 **조용한 영구 평문**이 새로 생긴다: hello 는
//          연결 시 1회뿐이고(daemon control.js:368) 데몬이 사용자 승인으로 열쇠를 **연결 중에** 얻어도
//          caps 는 갱신되지 않는다 → 승인 직후부터 재접속까지 서버가 봉투를 거절한다. 우리가 지금
//          닫으려는 결함과 정확히 같은 종류다.
//       ③ 라우트를 열어 두는 비용은 왕복 1회이고, 그 왕복의 결과가 **정직한 코드**(E2EE_NO_KEY→501)라서
//          클라가 10분 캐시로 왕복을 스스로 줄인다. 반면 얻는 것(진단 가능성)은 크다.
//      대신 커넥션별 정직성은 **라이브 값**으로 다룬다: `conn.e2eeEpoch`(hello + 갱신 프레임)로
//      명백히 낡은 세대만 선차단(`rpcSealed` 의 epoch 선대조, 정본 판정은 데몬) + 잠금 배지 팬아웃.
//      ※ 데몬 담당에게: 열쇠 취득/회전 시 `hello` 를 다시 보내면(또는 e2eeEpoch 를 실은 프레임)
//        back 이 그 자리에서 conn.e2eeEpoch 를 갱신하고 runner_status 를 재팬아웃한다(:248 분기).
//        지금은 재접속 전까지 배지가 0 으로 고착한다.
//  · e2ee.hint.v1 — **열쇠 변화 힌트 푸시**(기능2 A단계 후속). 서버측 = `fanoutDeviceApproval` 이
//                   같은 이벤트를 UI 클라이언트에 팬아웃하면서 **연결된 데몬들에게도**
//                   `{type:'e2ee_hint', kind}` 를 내려보낸다(daemonRelayService.notifyRunnersE2ee).
//                   왜 별 문자열인가: 이 능력의 지시대상은 "데몬이 이 프레임을 처리한다" 이고,
//                   `e2ee.keys.v1`(REST 열쇠 배포)를 가진 구 데몬은 이 프레임을 그냥 버린다 —
//                   한 문자열로 뭉치면 back 이 프레임을 쏘는데 데몬은 폴링만 하는 조용한 유실이 된다.
//                   ★ 이 프레임은 **힌트일 뿐**이다: epoch/policy 같은 상태 주장을 싣지 않는다(스키마에
//                     그런 필드가 아예 없다). 서버가 세대를 주장해 데몬을 옛/새 세대로 몰아넣을 수 있게
//                     되면 그 순간 서버는 신뢰 경계 안으로 들어온다 — 정본은 항상 데몬의 keyring
//                     왕복 + 승인자 Ed25519 서명 검증(e2ee-account.acceptGrant).
//                   E2EE_ENABLED=0 으로 함께 회수(열쇠 배포가 없으면 알릴 변화도 없다).
//  · e2ee.stream.v1 — 스트림 선협상(기능2 D단계). 서버측 = 터미널/포워딩 토큰 발급 시
//                   callRpc(…,'e2ee.begin',…) 로 세션을 미리 확정하고, 토큰에 sid 를 보관해
//                   stream_open params 에 실어 준다(데몬 pty.js/proxy.js 가 이미 읽는 자리).
//                   실패는 전부 평문 폴백(`e2ee:false` + `e2eeReason`) — 스트림을 죽이지 않는다.
//                   회수 스위치는 E2EE_ENABLED=0 또는 E2EE_STREAM_ENABLED=0(D단계만 되돌리기).
//
// ★ E2EE 능력은 단계별로 쪼갠다(한 문자열로 뭉치면 안 된다)
//   `e2ee.v1` 같은 뭉뚱그린 문자열을 선언하면 신버전 데몬이 아직 배관이 없는 단계까지 켜고
//   서버는 그 프레임을 버린다 = 조용한 유실(이 파일 최상단 경고 그대로).
//   따라서 단계 이름은 **각 단계의 서버 코드가 실제로 머지되는 커밋에서만** 추가한다:
//    · 'e2ee.rpc.v1'    — (이 커밋에서 켜짐) POST /api/daemon/rpc 봉투 프록시 = B단계
//    · 'e2ee.stream.v1' — (이 커밋에서 켜짐) e2ee.begin 선협상 + 토큰 sid = D단계
//    · 'e2ee.snap.v1'   — **아직 선언하지 않는다**. 이 커밋의 서버는 체크포인트 commit(구 경로 포함)이
//                   보내온 `enc`/`epoch` 를 매니페스트 entry 에 **보관**하는 데까지만 왔다.
//                   봉인 스냅샷의 복원측 처리(epoch 열쇠 확인·잠금 배지·복호 실패 진단)가 없어서
//                   지금 선언하면 데몬 sync.js:serverKnowsSealedSnapshots() 가 번들을 봉인해 올리는데
//                   서버는 그것이 정말 복원 가능한지 아무것도 확인하지 못한다(C단계 미검증).
//                   → 그 처리 코드가 들어오는 커밋에서 이 줄을 지우고 문자열을 추가할 것.
//
//  · lan.v1       — LAN 직결 시그널링(기능4). 서버측 = hello.lan/lan_update 수집 +
//                   POST /api/daemon/lan/grant + 제어 WS lan_grant 통지. **기본 꺼짐**:
//                   `LAN_DIRECT_ENABLED=1` 일 때만 선언한다(config/lanDirect.js 참조).
//                   선언되지 않으면 데몬이 LAN 리스너를 열지 않는다 = 인바운드 포트 0 불변식 유지.
//                   ※ 이 능력은 "시그널링을 처리한다"는 뜻이고, 어떤 scope(tcp/rpc/pty)까지 쓸 수
//                     있는지는 grant 응답의 scopes 가 정본이다(LAN_SCOPES 로 단계 개방).
//
//  · agentstate.v1 — 데몬 agent_state 수신·검증·팬아웃(기능3 2단계). 서버측 =
//                   daemonRelayService 의 제어 WS `agent_state` 분기 + normAgentState 검증
//                   + fanoutAgentState(SSE/WSS) + ui_hello 라스트-스테이트 리플레이.
//                   버퍼링(rseq)은 **하지 않는다** — 상태 프레임을 agentBuf 에 넣으면 알림 리플레이
//                   항목을 축출한다(chat_event 를 버퍼에 넣지 않는 것과 같은 이유).
//                   AGENTSTATE_ENABLED=0 으로 회수 → 데몬 sendEvent 가 false = 기존 tab.cmd 폴백.

// env 값이 명시적으로 꺼져 있는가('0'|'false'|'off'). 미설정 = 켜짐(기본값).
function envOff(v) {
  return /^(0|false|off|no)$/i.test(String(v == null ? '' : v).trim());
}

// 순수 함수(테스트 노출) — env 객체를 받아 선언 목록을 만든다.
function computeServerCaps(env = process.env) {
  const caps = ['caps.v1'];
  if (!envOff(env.APPROVAL_ENABLED)) caps.push('approval.v1');
  if (!envOff(env.TRANSCRIPT_ENABLED)) caps.push('transcript.v1');
  if (!envOff(env.AGENTSTATE_ENABLED)) caps.push('agentstate.v1');
  if (!envOff(env.E2EE_ENABLED)) {
    caps.push('e2ee.keys.v1');
    caps.push('e2ee.rpc.v1');
    // 열쇠 변화 힌트 푸시 — 처리 코드(notifyRunnersE2ee + fanoutDeviceApproval 호출부)가 이 커밋에 있다.
    caps.push('e2ee.hint.v1');
    // 스트림 단계만 따로 되돌릴 수 있게 별도 스위치를 둔다 — sid 주입이 잘못되면 증상이
    //  "터미널이 4090 으로 무한 재연결"(가장 위험한 회귀)이라 즉시 회수 수단이 필요하다.
    if (!envOff(env.E2EE_STREAM_ENABLED)) caps.push('e2ee.stream.v1');
  }
  // LAN 직결은 fail-closed — 명시적으로 켠 경우에만 선언한다(다른 스위치와 기본값 방향이 반대).
  if (require('./lanDirect').lanEnabled(env)) caps.push('lan.v1');
  return caps;
}

const SERVER_CAPS = computeServerCaps(process.env);

module.exports = { SERVER_CAPS, computeServerCaps, _envOff: envOff };
