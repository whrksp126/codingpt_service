const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const daemonController = require('../controllers/daemonController');
const syncController = require('../controllers/syncController');

// BYO-PC 데몬 — 페어링/상태/터미널. ws 업그레이드(/connect, /stream, /terminal)는 app.js 에서 처리.
router.post('/pair/code', authMiddleware, daemonController.createPairCode); // 레거시 — 앱이 코드 발급
router.post('/pair/session', daemonController.createPairSession); // 무인증 — PC가 QR 세션 발급(넷플릭스 방식)
router.post('/pair/approve', authMiddleware, daemonController.approvePairSession); // 로그인된 앱이 QR 코드 승인
router.post('/pair/claim', daemonController.claimPairCode); // 무인증 — 코드/secret 이 비밀
router.get('/status', authMiddleware, daemonController.getStatus);
// PC 데스크톱 GUI — deviceToken 인증(핸들러 내부). 사이드바 워크스페이스 목록 + 클라우드 터미널 토큰.
router.get('/me', daemonController.daemonMe); // deviceToken 인증 — PC GUI 계정 표시(웹 로그인 후)
router.patch('/me', daemonController.updateMe); // JWT|deviceToken — 닉네임 등 프로필 수정
router.delete('/account', daemonController.deleteAccount); // JWT|deviceToken — 회원 탈퇴(본인 계정)
router.get('/devices', daemonController.daemonDevices); // deviceToken 인증 — 계정의 모든 기기 목록(멀티기기)
router.post('/devices/register', daemonController.registerController); // JWT|deviceToken — 컨트롤러(모바일/태블릿) 자기 등록
router.get('/workspaces', daemonController.daemonWorkspaces);
router.post('/workspaces/:wsId/claim', daemonController.daemonClaimWorkspaceHost); // 호스트 귀속 클레임(deviceToken)
router.get('/workspaces/:wsId/session', daemonController.daemonGetSession); // 세션 이어받기(deviceToken)
router.put('/workspaces/:wsId/session', daemonController.daemonPutSession);
router.post('/workspaces', daemonController.daemonCreateWorkspace);
router.post('/terminal/device-start', daemonController.daemonTerminalStart);
router.post('/devices/:deviceId/revoke', daemonController.revokeDevice); // JWT|deviceToken(핸들러 resolveAccount)
router.post('/runner/activate', authMiddleware, daemonController.activateRunner); // M5: 활성 러너 전환(핸드오프, runnerId 또는 kind)
router.post('/runner/cloud/ensure', authMiddleware, daemonController.ensureCloudRunner); // M5 Slice4: 클라우드 러너 확보(핸드오프 진입점)
router.post('/terminal/start', authMiddleware, daemonController.startTerminal);
router.get('/terminal/list', authMiddleware, daemonController.terminalList);
router.post('/terminal/new', authMiddleware, daemonController.terminalNew);
router.post('/terminal/select', authMiddleware, daemonController.terminalSelect);
router.post('/terminal/close', authMiddleware, daemonController.terminalClose);
router.post('/terminal/unview', authMiddleware, daemonController.terminalUnview);

// 파일시스템(P1) — 제어 채널 RPC 프록시. 데몬 오프라인이면 409.
router.get('/fs/list', authMiddleware, daemonController.fsList);
router.get('/fs/tree', authMiddleware, daemonController.fsTree);
router.get('/fs/read', authMiddleware, daemonController.fsRead);
router.get('/fs/grep', authMiddleware, daemonController.fsGrep);
router.post('/fs/write', authMiddleware, daemonController.fsWrite);
router.post('/fs/mkdir', authMiddleware, daemonController.fsMkdir);
router.post('/fs/create', authMiddleware, daemonController.fsCreateFile);
router.post('/fs/rename', authMiddleware, daemonController.fsRename);
router.post('/fs/delete', authMiddleware, daemonController.fsDelete);
router.post('/fs/watch', authMiddleware, daemonController.fsWatch);
router.post('/fs/unwatch', authMiddleware, daemonController.fsUnwatch);
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

// 워크스페이스(Slice2) — PC 에 결정적 스캐폴드. 데몬 오프라인이면 409.
router.get('/ws/root', authMiddleware, daemonController.wsGetRoot);
router.post('/ws/root', authMiddleware, daemonController.wsSetRoot);
router.post('/ws/root/default', authMiddleware, daemonController.wsUseDefaultRoot);
router.post('/ws/create', authMiddleware, daemonController.wsCreate);
router.post('/ws/clone', authMiddleware, daemonController.wsClone); // GitHub 레포 git clone → 로컬 워크스페이스
router.post('/ws/fulldisk', authMiddleware, daemonController.wsSetFullDisk); // 전체 디스크 접근 토글(홈 jail 완화)

// 동기화(M4) — objectstore git-bundle 체크포인트/머티리얼라이즈/충돌. 데몬 오프라인이면 409.
router.post('/sync/checkpoint', authMiddleware, syncController.checkpoint);
router.post('/sync/materialize', authMiddleware, syncController.materialize);
router.get('/sync/status', authMiddleware, syncController.status);
router.post('/sync/resolve', authMiddleware, syncController.resolve);
router.get('/sync/checkpoints', authMiddleware, syncController.listCheckpoints);

// 프리뷰(데몬 dev 서버) — 포트 조회/시작은 인증, 프록시 진입(:token)은 무인증(불투명 토큰).
router.get('/preview/ports', authMiddleware, daemonController.previewPorts);
router.post('/preview/start', authMiddleware, daemonController.previewStart);
router.all('/preview/:token', daemonController.previewEntry);
router.all('/preview/:token/*', daemonController.previewEntry);

module.exports = router;
