const express = require('express');
// mergeParams: 부모(workspaceRoutes)의 :workspaceId 를 이 라우터에서 접근하기 위함
const router = express.Router({ mergeParams: true });
const authMiddleware = require('../middlewares/authMiddleware');
const sessionController = require('../controllers/sessionController');

// 워크스페이스 하위 세션(채팅) — 전부 인증 필요(본인 워크스페이스만)
router.get('/', authMiddleware, sessionController.list);
router.post('/', authMiddleware, sessionController.create);
router.get('/:sessionId', authMiddleware, sessionController.getOne);
router.patch('/:sessionId', authMiddleware, sessionController.update);
router.delete('/:sessionId', authMiddleware, sessionController.remove);

module.exports = router;
