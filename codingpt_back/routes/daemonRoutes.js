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

module.exports = router;
