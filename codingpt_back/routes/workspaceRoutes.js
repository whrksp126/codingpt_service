const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const workspaceController = require('../controllers/workspaceController');
const sessionRoutes = require('./sessionRoutes');

// 바이브코딩 사용자 워크스페이스 — 전부 인증 필요(본인 워크스페이스만)
// 이름 추천(고정 경로) — :workspaceId 파라미터 라우트보다 먼저 선언
router.post('/suggest-name', authMiddleware, workspaceController.suggestName);
router.get('/', authMiddleware, workspaceController.list);
router.post('/', authMiddleware, workspaceController.create);
router.get('/:workspaceId', authMiddleware, workspaceController.getOne);
router.patch('/:workspaceId', authMiddleware, workspaceController.update);
router.post('/:workspaceId/duplicate', authMiddleware, workspaceController.duplicate);
router.delete('/:workspaceId', authMiddleware, workspaceController.remove);
// 프로젝트 그룹 수동 교정 — 자동 연결(이름/remote)이 틀렸을 때 분리/합치기(결과는 영구 저장)
router.post('/:workspaceId/project/detach', authMiddleware, workspaceController.projectDetach);
router.post('/:workspaceId/project/attach', authMiddleware, workspaceController.projectAttach);

// 워크스페이스 하위 세션(채팅) — /:workspaceId/sessions/*
router.use('/:workspaceId/sessions', sessionRoutes);

module.exports = router;
