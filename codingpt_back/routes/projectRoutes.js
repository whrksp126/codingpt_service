const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const projectController = require('../controllers/projectController');

// 바이브코딩 사용자 프로젝트 — 전부 인증 필요(본인 워크스페이스만)
router.get('/', authMiddleware, projectController.list);
router.post('/', authMiddleware, projectController.create);
router.get('/:projectId', authMiddleware, projectController.getOne);
router.patch('/:projectId', authMiddleware, projectController.update);
router.post('/:projectId/duplicate', authMiddleware, projectController.duplicate);
router.delete('/:projectId', authMiddleware, projectController.remove);

module.exports = router;
