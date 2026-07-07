const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const daemonController = require('../controllers/daemonController');

// BYO-PC 데몬 — 페어링/상태/터미널. ws 업그레이드(/connect, /stream, /terminal)는 app.js 에서 처리.
router.post('/pair/code', authMiddleware, daemonController.createPairCode);
router.post('/pair/claim', daemonController.claimPairCode); // 무인증 — 일회용 코드가 비밀
router.get('/status', authMiddleware, daemonController.getStatus);
router.post('/devices/:deviceId/revoke', authMiddleware, daemonController.revokeDevice);
router.post('/terminal/start', authMiddleware, daemonController.startTerminal);

// 파일시스템(P1) — 제어 채널 RPC 프록시. 데몬 오프라인이면 409.
router.get('/fs/list', authMiddleware, daemonController.fsList);
router.get('/fs/tree', authMiddleware, daemonController.fsTree);
router.get('/fs/read', authMiddleware, daemonController.fsRead);
router.post('/fs/write', authMiddleware, daemonController.fsWrite);
router.post('/fs/watch', authMiddleware, daemonController.fsWatch);
router.post('/fs/unwatch', authMiddleware, daemonController.fsUnwatch);
// 파일 변경 이벤트 SSE(앱 구독) — 데몬 chokidar → back → 앱 즉시 반영.
router.get('/events', authMiddleware, daemonController.streamEvents);

// 워크스페이스(Slice2) — PC 에 결정적 스캐폴드. 데몬 오프라인이면 409.
router.get('/ws/root', authMiddleware, daemonController.wsGetRoot);
router.post('/ws/root', authMiddleware, daemonController.wsSetRoot);
router.post('/ws/root/default', authMiddleware, daemonController.wsUseDefaultRoot);
router.post('/ws/create', authMiddleware, daemonController.wsCreate);

// 프리뷰(데몬 dev 서버) — 포트 조회/시작은 인증, 프록시 진입(:token)은 무인증(불투명 토큰).
router.get('/preview/ports', authMiddleware, daemonController.previewPorts);
router.post('/preview/start', authMiddleware, daemonController.previewStart);
router.all('/preview/:token', daemonController.previewEntry);
router.all('/preview/:token/*', daemonController.previewEntry);

module.exports = router;
