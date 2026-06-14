const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const agentController = require('../controllers/agentController');

// 모든 에이전트 라우트는 인증 필요 (req.user.id 로 워크스페이스 스코핑)
router.post('/query', authMiddleware, agentController.runAgent);
router.get('/file', authMiddleware, agentController.getFile);
router.post('/:sessionId/permission', authMiddleware, agentController.permission);

module.exports = router;
