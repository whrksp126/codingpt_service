const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const agentController = require('../controllers/agentController');

// 모든 에이전트 라우트는 인증 필요 (req.user.id 로 워크스페이스 스코핑)
router.post('/query', authMiddleware, agentController.runAgent);
router.get('/file', authMiddleware, agentController.getFile);
router.get('/files', authMiddleware, agentController.getFiles); // IDE 파일트리(워크스페이스 파일 목록)
router.post('/file', authMiddleware, agentController.writeFile); // IDE 에디터 편집 → 샌드박스 FS
router.post('/permission', authMiddleware, agentController.permission);
router.post('/exec', authMiddleware, agentController.terminalExec); // 샌드박스 터미널(실셸)

module.exports = router;
