const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const accountAuth = require('../middlewares/accountAuth');
const subscriptionController = require('../controllers/subscriptionController');

// 플랜 카탈로그는 공개 (웹 pricing 페이지)
router.get('/plans', subscriptionController.getPlans);
// 플랜 편집은 어드민 전용 — 본인 전용 서비스라 별도 인증 없음(githubRepoRoutes 컨벤션).
router.put('/plans/:id', subscriptionController.updatePlan);
// 구독 상태/해지는 인증 필요. (구독 결제/활성화는 Phase 3 billing 흐름에서 처리)
// PC 앱은 deviceToken, 웹/모바일은 JWT를 사용한다. 구독 상태는 동일 계정 범위로 조회한다.
router.get('/me', accountAuth, subscriptionController.getMine);
router.post('/cancel', authMiddleware, subscriptionController.cancel);
router.post('/resume', authMiddleware, subscriptionController.resume);
router.post('/change', authMiddleware, subscriptionController.change);

module.exports = router;
