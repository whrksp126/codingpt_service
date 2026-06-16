const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const billingController = require('../controllers/billingController');

// 월 구독 결제. (크레딧 충전 모델 제거됨)
router.post('/checkout', authMiddleware, billingController.checkout);
router.post('/subscribe', authMiddleware, billingController.subscribe);
router.get('/payments', authMiddleware, billingController.getPayments);
router.post('/web-session', authMiddleware, billingController.createWebSession);

// 주의: POST /webhook 은 raw body 가 필요하므로 app.js 에서 express.json() 앞에 별도 마운트됨.
module.exports = router;
