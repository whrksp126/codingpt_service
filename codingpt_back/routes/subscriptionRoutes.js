const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const subscriptionController = require('../controllers/subscriptionController');

// 플랜 카탈로그는 공개 (웹 pricing 페이지)
router.get('/plans', subscriptionController.getPlans);
// 구독 상태/해지는 인증 필요. (구독 결제/활성화는 Phase 3 billing 흐름에서 처리)
router.get('/me', authMiddleware, subscriptionController.getMine);
router.post('/cancel', authMiddleware, subscriptionController.cancel);

module.exports = router;
