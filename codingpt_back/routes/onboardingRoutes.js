const express = require('express');
const router = express.Router();
const { submit } = require('../controllers/onboardingController');

// 온보딩 설문 응답 제출 (로그인 전 익명 수집이므로 인증 미들웨어 없음)
router.post('/', submit);

module.exports = router;
