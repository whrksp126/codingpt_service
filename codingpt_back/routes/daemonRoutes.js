const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middlewares/authMiddleware');
const accountAuth = require('../middlewares/accountAuth');
const daemonController = require('../controllers/daemonController');
const syncController = require('../controllers/syncController');
const approvalController = require('../controllers/approvalController');
const deviceTrustController = require('../controllers/deviceTrustController');

// BYO-PC 데몬 — 페어링/상태/터미널. ws 업그레이드(/connect, /stream, /terminal)는 app.js 에서 처리.
router.post('/pair/code', authMiddleware, daemonController.createPairCode); // 레거시 — 앱이 코드 발급
router.post('/pair/session', daemonController.createPairSession); // 무인증 — PC가 QR 세션 발급(넷플릭스 방식)
router.post('/pair/approve', authMiddleware, daemonController.approvePairSession); // 로그인된 앱이 QR 코드 승인
router.post('/pair/claim', daemonController.claimPairCode); // 무인증 — 코드/secret 이 비밀
router.post('/pair/grant', authMiddleware, daemonController.pairGrant); // 승인 직후 앱이 PC 공개키로 봉인한 MK 업로드(추가 탭 0)
router.get('/status', authMiddleware, daemonController.getStatus);
// PC 데스크톱 GUI — deviceToken 인증(핸들러 내부). 사이드바 워크스페이스 목록 + 클라우드 터미널 토큰.
router.get('/me', daemonController.daemonMe); // deviceToken 인증 — PC GUI 계정 표시(웹 로그인 후)
router.patch('/me', daemonController.updateMe); // JWT|deviceToken — 닉네임 등 프로필 수정
router.delete('/account', daemonController.deleteAccount); // JWT|deviceToken — 회원 탈퇴(본인 계정)
router.get('/devices', daemonController.daemonDevices); // deviceToken 인증 — 계정의 모든 기기 목록(멀티기기)
router.post('/devices/register', daemonController.registerController); // JWT|deviceToken — 컨트롤러(모바일/태블릿) 자기 등록
router.patch('/devices/:deviceId/name', daemonController.renameOwnDevice); // 자기 기기 별칭만 변경
router.get('/workspaces', daemonController.daemonWorkspaces);
router.post('/workspaces/:wsId/claim', daemonController.daemonClaimWorkspaceHost); // 호스트 귀속 클레임(deviceToken)
router.get('/workspaces/:wsId/session', daemonController.daemonGetSession); // 세션 이어받기(deviceToken)
router.put('/workspaces/:wsId/session', daemonController.daemonPutSession);
router.post('/workspaces', daemonController.daemonCreateWorkspace);
router.post('/workspaces/:wsId/project/detach', daemonController.daemonProjectDetach); // 프로젝트 그룹 분리(deviceToken)
router.post('/workspaces/:wsId/project/attach', daemonController.daemonProjectAttach); // 프로젝트 그룹 합치기(deviceToken)
router.post('/workspaces/:wsId/git', daemonController.daemonReportGit); // 신선도 보고(deviceToken) — 사이드바 배지
router.delete('/workspaces/:wsId', daemonController.daemonDeleteWorkspace); // 목록에서 삭제(deviceToken) — 로컬 폴더/파일은 안 건드림
router.post('/terminal/device-start', daemonController.daemonTerminalStart);
router.post('/devices/:deviceId/revoke', daemonController.revokeDevice); // JWT|deviceToken(핸들러 resolveAccount)
router.post('/runner/activate', authMiddleware, daemonController.activateRunner); // M5: 활성 러너 전환(핸드오프, runnerId 또는 kind)
router.post('/runner/cloud/ensure', authMiddleware, daemonController.ensureCloudRunner); // M5 Slice4: 클라우드 러너 확보(핸드오프 진입점)
router.post('/terminal/start', authMiddleware, daemonController.startTerminal);
router.post('/ui/ticket', accountAuth, daemonController.uiTicket); // deviceToken 기기(PC)용 agent/stream 1회용 티켓
router.get('/ui/clients', accountAuth, daemonController.uiClients); // 접속 중 UI 화면 목록(기기 타겟팅 --on / cpt devices)
router.post('/pc/update', accountAuth, daemonController.pcUpdate); // 폰에서 그 PC 에 업데이트 적용 지시(원격)
router.get('/terminal/list', authMiddleware, daemonController.terminalList);
router.post('/terminal/new', authMiddleware, daemonController.terminalNew);
router.post('/terminal/select', authMiddleware, daemonController.terminalSelect);
router.post('/terminal/close', authMiddleware, daemonController.terminalClose);
router.post('/terminal/unview', authMiddleware, daemonController.terminalUnview);

// 에이전트 관리 — 이 PC 에 설치된 AI CLI 감지·배선·실행(모바일에서도 조작 가능, 사용자 확정 2026-07-27).
//  accountAuth = JWT|deviceToken 겸용 + ?hostDeviceId 라우팅(fs.* 와 같은 규율 — 다른 PC 도 조회).
router.get('/agents', accountAuth, daemonController.agentsList);
router.post('/agents/wire', accountAuth, daemonController.agentsWire);
router.post('/agents/rescan', accountAuth, daemonController.agentsRescan);
router.post('/agents/launch', accountAuth, daemonController.agentsLaunch);

// 파일시스템(P1) — 제어 채널 RPC 프록시. 데몬 오프라인이면 409.
//  accountAuth(JWT|deviceToken 겸용) — PC 앱이 다른 PC 워크스페이스 IDE 를 열 때 deviceToken 으로 호출.
//  ?hostDeviceId= / body.hostDeviceId 로 대상 호스트 지정(활성 러너 무변경), 미지정=활성 러너.
router.get('/fs/list', accountAuth, daemonController.fsList);
router.get('/fs/tree', accountAuth, daemonController.fsTree);
router.get('/fs/read', accountAuth, daemonController.fsRead);
router.get('/fs/grep', accountAuth, daemonController.fsGrep);
router.post('/fs/write', accountAuth, daemonController.fsWrite);
router.post('/fs/mkdir', accountAuth, daemonController.fsMkdir);
router.post('/fs/create', accountAuth, daemonController.fsCreateFile);
router.post('/fs/rename', accountAuth, daemonController.fsRename);
router.post('/fs/delete', accountAuth, daemonController.fsDelete);
router.post('/fs/watch', accountAuth, daemonController.fsWatch);
router.post('/fs/unwatch', accountAuth, daemonController.fsUnwatch);
// 파일 변경 이벤트 SSE(앱 구독) — 데몬 chokidar → back → 앱 즉시 반영.
router.get('/events', authMiddleware, daemonController.streamEvents);

// BYO 에이전트(M1) — 데몬이 사용자 claude spawn. 커맨드는 RPC, 이벤트는 /events SSE(agent_event).
router.post('/agent/start', authMiddleware, daemonController.agentStart);
router.post('/agent/input', authMiddleware, daemonController.agentInput);
router.post('/agent/approve', authMiddleware, daemonController.agentApprove);
router.post('/agent/interrupt', authMiddleware, daemonController.agentInterrupt);
router.post('/agent/stop', authMiddleware, daemonController.agentStop);
router.get('/agent/status', authMiddleware, daemonController.agentStatus);
router.get('/agent/backlog', authMiddleware, daemonController.agentBacklog);
router.get('/agent/sessions', authMiddleware, daemonController.agentSessions);
router.get('/agent/doctor', authMiddleware, daemonController.agentDoctor);
// BYO 로그인(M5 Slice2) — 활성 러너(클라우드 컨테이너)에서 사용자 claude 계정 로그인. URL/코드만 중계.
router.post('/agent/login', authMiddleware, daemonController.agentLogin);
router.post('/agent/login/submit', authMiddleware, daemonController.agentLoginSubmit);
router.post('/agent/login/cancel', authMiddleware, daemonController.agentLoginCancel);
router.get('/agent/login/status', authMiddleware, daemonController.agentLoginStatus);

// 원격 승인 인박스(기능1) — 훅이 블로킹 대기하는 동안 어느 기기에서든 응답.
//  경로가 `/api/daemon/*` 인 이유: PC 앱 브리지가 이 접두사만 화이트리스트로 통과시킨다(Rust 무수정).
//  accountAuth(JWT|deviceToken 겸용) — 생성/취소는 컨트롤러가 실 deviceToken 기기인지 추가 검사(403).
router.post('/approvals', accountAuth, approvalController.create);            // 데몬 → back(등록)
router.get('/approvals', accountAuth, approvalController.list);               // 클라 캐치업(pull 이 정본)
router.post('/approvals/:id/respond', accountAuth, approvalController.respond); // 클라 → back → 데몬
router.post('/approvals/:id/cancel', accountAuth, approvalController.cancel);   // 데몬 → back(마감/훅 종료)

// 기기 신뢰 / E2EE 열쇠 배포(기능2 A단계) — 트래픽은 아직 평문. 열쇠 배포 표면만 단독 검증한다.
//  경로가 `/api/daemon/*` 인 이유: 승인 인박스와 동일 — PC 앱 브리지가 이 접두사만 통과시킨다.
//  accountAuth 통일(JWT=모바일 / deviceToken=PC 데몬·앱). 서버는 **봉인문(암호문)만** 다룬다.
router.post('/e2ee/enroll', accountAuth, deviceTrustController.enroll);       // 기기 등록 신청(멱등)
router.post('/e2ee/bootstrap', accountAuth, deviceTrustController.bootstrap); // 계정 최초 1회(MK_1)
router.get('/e2ee/pending', accountAuth, deviceTrustController.pending);      // 신뢰 기기 승인 시트(pull 이 정본)
router.post('/e2ee/approve', accountAuth, deviceTrustController.approve);     // 승인 = 봉인문 업로드
router.post('/e2ee/deny', accountAuth, deviceTrustController.deny);           // 거절
router.post('/e2ee/nudge', accountAuth, deviceTrustController.nudge);
//  기기 연동(QR/코드) — 개정 12: 승인 절차 대신 코드가 채널이다(deviceTrustService C-0 주석).
router.post('/e2ee/link/start', accountAuth, deviceTrustController.linkStart);
router.post('/e2ee/link/claim', accountAuth, deviceTrustController.linkClaim);
router.post('/e2ee/link/fulfill', accountAuth, deviceTrustController.linkFulfill);
router.get('/e2ee/link/:linkId', accountAuth, deviceTrustController.linkGet);         // 연동 요청 재발송(기기 목록 [연동])
router.get('/e2ee/keyring', accountAuth, deviceTrustController.keyring);      // 감사 UI + 내 봉인문 수령
router.post('/e2ee/rotate', accountAuth, deviceTrustController.rotate);       // 기기 해제 후 epoch+1 재봉인
router.patch('/e2ee/policy', accountAuth, deviceTrustController.policy);      // off|preferred|required
router.post('/e2ee/recovery', accountAuth, deviceTrustController.recovery);   // 복구 코드 봉인문

// 봉투 RPC(기능2 B단계) — 봉인된 봉투를 데몬으로 **그대로** 중계하고 응답 봉투를 그대로 돌려준다.
//  서버는 봉투를 열지 않는다(메서드명조차 보이지 않는다). 라우트가 없으면 404 → 클라가 10분
//  UNSUPPORTED 캐시 후 평문 REST(fs/*) 로 폴백하므로, 404 자체가 게이팅이다.
//  accountAuth 통일(JWT=모바일 / deviceToken=PC 앱·데몬) — fs/* 와 같은 규약.
router.post('/rpc', accountAuth, daemonController.rpcSealed);

// 트랜스크립트 채팅(기능5) — 데몬 JSONL 리더의 얇은 callRpc 프록시. 새 배관 없음(라우트만).
//  ⚠ accountAuth 필수 — agent* 처럼 JWT 전용으로 두면 PC 앱(deviceToken)이 못 쓴다(같은 실수 반복 금지).
//  라이브 델타는 데몬 chat_event → agent/stream WSS 팬아웃(daemonRelayService.fanoutChatEvent).
router.get('/chat/sessions', accountAuth, daemonController.chatSessions);
router.post('/chat/open', accountAuth, daemonController.chatOpen);
router.get('/chat/since', accountAuth, daemonController.chatSince);
router.post('/chat/close', accountAuth, daemonController.chatClose);
router.get('/chat/detail', accountAuth, daemonController.chatDetail);
router.get('/chat/attachment', accountAuth, daemonController.chatAttachment);
router.post('/chat/input', accountAuth, daemonController.chatInput);
router.post('/chat/answer', accountAuth, daemonController.chatAnswer); // TUI 폴백 질문에 원격 답변(다이얼로그 조작)
router.post('/chat/mode', accountAuth, daemonController.chatMode);
router.post('/chat/commands', accountAuth, daemonController.chatCommands); // TUI `/` 명령 목록(팔레트)
router.post('/chat/dialog', accountAuth, daemonController.chatDialog);     // TUI 선택 화면 카드 조작
router.post('/chat/file', accountAuth, daemonController.chatFile);   // 대화가 참조한 파일 바이트(이미지/영상 인라인 표시)   // 에이전트 권한 모드 조회/전환(TUI shift+tab 드라이브)

// 워크스페이스(Slice2) — PC 에 결정적 스캐폴드. 데몬 오프라인이면 409.
router.get('/ws/root', authMiddleware, daemonController.wsGetRoot);
router.post('/ws/root', authMiddleware, daemonController.wsSetRoot);
router.post('/ws/create', authMiddleware, daemonController.wsCreate);
router.post('/ws/clone', authMiddleware, daemonController.wsClone); // GitHub 레포 git clone → 로컬 워크스페이스
router.post('/ws/fulldisk', authMiddleware, daemonController.wsSetFullDisk); // 전체 디스크 접근 토글(홈 jail 완화)

// 동기화(M4) — objectstore git-bundle 체크포인트/머티리얼라이즈/충돌. 데몬 오프라인이면 409.
//  checkpoint/checkpoints 는 accountAuth(JWT|deviceToken 겸용) — PC 앱 자동 체크포인트가 deviceToken 으로 호출.
router.post('/sync/checkpoint', accountAuth, syncController.checkpoint);
// 2단계 체크포인트(데몬 자율 실행) — 데몬이 begin 으로 좌표만 받고, 로컬 작업/업로드는 스스로 한 뒤
//  commit 으로 매니페스트에 등록한다. 구 경로(/sync/checkpoint)는 **남긴다**(모바일 + 스테일 데몬 폴백).
//  accountAuth 필수 — 데몬은 deviceToken 으로 호출한다(JWT 전용이면 401 → 영구 구 경로 폴백).
router.post('/sync/checkpoint/begin', accountAuth, syncController.checkpointBegin);
router.post('/sync/checkpoint/commit', accountAuth, syncController.checkpointCommit);
router.post('/sync/multipart/:action', accountAuth, syncController.multipart); // 대용량 번들 파트 업로드(데몬 콜백)
router.post('/sync/materialize', authMiddleware, syncController.materialize);
router.get('/sync/status', authMiddleware, syncController.status);
router.post('/sync/resolve', authMiddleware, syncController.resolve);
router.get('/sync/checkpoints', accountAuth, syncController.listCheckpoints);

// 프리뷰(데몬 dev 서버) — 포트 조회/시작은 인증, 프록시 진입(:token)은 무인증(불투명 토큰).
//  포트/시작도 accountAuth + hostDeviceId 지정 지원(PC 앱 원격 프리뷰).
router.get('/preview/ports', accountAuth, daemonController.previewPorts);
router.post('/preview/start', accountAuth, daemonController.previewStart);
router.post('/forward/start', accountAuth, daemonController.forwardStart); // 포트 포워딩 토큰(WS 는 app.js upgrade)
// LAN 직결 소개장(기능4) — 뷰어(폰/PC/데몬)가 대상 PC 의 사설 IP + 단명 grant 를 받는다.
//  IP당 15분/60회. Cloudflare→nginx 뒤라 req.ip 가 엣지 IP 로 잡히므로 실 클라이언트 IP 로 키를 고정
//  (userRoutes.js:10 realClientIp 와 동일 규칙 — 그쪽을 고치면 여기도 같이 고칠 것).
//  IPv6 는 /64 를 한 사용자로 묶는다(ipKeyGenerator) — 안 묶으면 IPv6 사용자가 주소를 바꿔 상한을 우회한다.
const lanClientIp = (req) => {
  const raw = (() => {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xr = req.headers['x-real-ip'];
    if (xr) return String(xr).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.ip;
  })();
  return typeof rateLimit.ipKeyGenerator === 'function' ? rateLimit.ipKeyGenerator(raw) : raw;
};
const lanGrantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: lanClientIp,
  // 클라이언트는 code 로 분기한다 — 429 도 LAN 전용 코드로 통일(오프라인 오탐 문구 금지 §5.3).
  message: { success: false, message: '직결 요청이 너무 많습니다.', code: 'LAN_RATE_LIMITED' },
});
router.post('/lan/grant', lanGrantLimiter, accountAuth, daemonController.lanGrant);

router.all('/preview/:token', daemonController.previewEntry);
router.all('/preview/:token/*', daemonController.previewEntry);

module.exports = router;
