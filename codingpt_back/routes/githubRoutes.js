const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const githubController = require('../controllers/githubController');

// GitHub 연동 라우트
router.get('/authorize', authMiddleware, githubController.authorize);
router.get('/callback', githubController.callback); // GitHub 가 직접 호출 (state 로 사용자 검증)
router.get('/status', authMiddleware, githubController.status);
router.get('/repos', authMiddleware, githubController.repos); // 레포 목록(GitHub에서 열기 피커)
router.delete('/disconnect', authMiddleware, githubController.disconnect);
router.post('/push', authMiddleware, githubController.push);

module.exports = router;
