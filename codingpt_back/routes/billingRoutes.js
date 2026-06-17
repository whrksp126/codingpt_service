const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const billingController = require('../controllers/billingController');
const rcWebhookController = require('../controllers/rcWebhookController');

// 월 구독 결제. (크레딧 충전 모델 제거됨)
router.post('/checkout', authMiddleware, billingController.checkout);
router.post('/subscribe', authMiddleware, billingController.subscribe);
router.get('/payments', authMiddleware, billingController.getPayments);
router.post('/web-session', authMiddleware, billingController.createWebSession);

// 스토어 IAP (RevenueCat). 구매 직후 앱이 동기화 호출 → 즉시 플랜 반영(웹훅 지연 보정).
router.post('/iap/sync', authMiddleware, billingController.iapSync);
// RC 웹훅 — JSON body(express.json 이후). 인증은 컨트롤러 내 Authorization 헤더 시크릿.
router.post('/rc/webhook', rcWebhookController.handleRcWebhook);

// 주의: PortOne POST /webhook 은 raw body 가 필요하므로 app.js 에서 express.json() 앞에 별도 마운트됨.
module.exports = router;
