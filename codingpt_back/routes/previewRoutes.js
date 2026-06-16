const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const previewProxyController = require('../controllers/previewProxyController');

// dev 서버 제어 — 인증 필요(앱이 JWT 로 호출)
router.post('/dev/start', authMiddleware, previewProxyController.startDev);
router.post('/dev/stop', authMiddleware, previewProxyController.stopDev);

// 에셋 서빙 — WebView 가 URL 을 직접 로드(JWT 못 실음) → 불투명 토큰으로 보호, 무인증 프록시.
// 토큰 경로 하위 전부(빈 경로 포함) 프록시. (dev/start·dev/stop 이 위에서 먼저 매칭됨)
router.all('/:token/*', previewProxyController.proxy);
router.all('/:token', previewProxyController.proxy);

module.exports = router;
