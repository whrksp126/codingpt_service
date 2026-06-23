const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const terminalProxyController = require('../controllers/terminalProxyController');

// 터미널 세션 시작 — 인증 필요(앱이 JWT 로 호출). 토큰 발급.
// 실제 ws 업그레이드(GET /api/terminal/:token)는 app.js 의 server.on('upgrade') 가 토큰으로 처리.
router.post('/start', authMiddleware, terminalProxyController.startTerminal);

module.exports = router;
