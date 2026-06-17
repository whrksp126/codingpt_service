const express = require('express');
const router = express.Router();
const adminUsageController = require('../controllers/adminUsageController');

// 사용량 실측 집계 (관리자 전용 — 본인 전용 서비스라 별도 인증 없음, githubRepoRoutes 컨벤션).
router.get('/summary', adminUsageController.getSummary);

module.exports = router;
