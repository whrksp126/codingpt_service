const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const usageController = require('../controllers/usageController');

// 모든 사용량 라우트는 인증 필요 (req.user.id 스코핑)
router.get('/status', authMiddleware, usageController.getStatus);
router.get('/history', authMiddleware, usageController.getHistory);

module.exports = router;
