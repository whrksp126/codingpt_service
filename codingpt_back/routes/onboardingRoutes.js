const express = require('express');
const router = express.Router();
const onboardingController = require('../controllers/onboardingController');

// 온보딩 설문(익명) — 로그인 전 호출이라 인증 미들웨어 없음.
router.post('/', onboardingController.submit);

module.exports = router;
