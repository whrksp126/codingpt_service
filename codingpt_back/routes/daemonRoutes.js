const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const daemonController = require('../controllers/daemonController');
const syncController = require('../controllers/syncController');

// BYO-PC 데몬 — 페어링/상태/터미널. ws 업그레이드(/connect, /stream, /terminal)는 app.js 에서 처리.
router.post('/pair/code', authMiddleware, daemonController.createPairCode);
router.post('/pair/claim', daemonController.claimPairCode); // 무인증 — 일회용 코드가 비밀
router.get('/status', authMiddleware, daemonController.getStatus);
router.post('/devices/:deviceId/revoke', authMiddleware, daemonController.revokeDevice);
router.post('/runner/activate', authMiddleware, daemonController.activateRunner); // M5: 활성 러너 전환(핸드오프)
router.post('/terminal/start', authMiddleware, daemonController.startTerminal);
router.get('/terminal/list', authMiddleware, daemonController.terminalList);
router.post('/terminal/new', authMiddleware, daemonController.terminalNew);
router.post('/terminal/select', authMiddleware, daemonController.terminalSelect);
router.post('/terminal/close', authMiddleware, daemonController.terminalClose);

// 파일시스템(P1) — 제어 채널 RPC 프록시. 데몬 오프라인이면 409.
router.get('/fs/list', authMiddleware, daemonController.fsList);
router.get('/fs/tree', authMiddleware, daemonController.fsTree);
router.get('/fs/read', authMiddleware, daemonController.fsRead);
router.get('/fs/grep', authMiddleware, daemonController.fsGrep);
router.post('/fs/write', authMiddleware, daemonController.fsWrite);
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

// 워크스페이스(Slice2) — PC 에 결정적 스캐폴드. 데몬 오프라인이면 409.
router.get('/ws/root', authMiddleware, daemonController.wsGetRoot);
router.post('/ws/root', authMiddleware, daemonController.wsSetRoot);
router.post('/ws/root/default', authMiddleware, daemonController.wsUseDefaultRoot);
router.post('/ws/create', authMiddleware, daemonController.wsCreate);
router.post('/ws/clone', authMiddleware, daemonController.wsClone); // GitHub 레포 git clone → 로컬 워크스페이스

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
