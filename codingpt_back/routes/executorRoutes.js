const express = require('express');
const router = express.Router();
const executorController = require('../controllers/executorController');

// 코드 실행
router.post('/execute', executorController.executeCode);

// S3 파일 기반 코드 실행
router.post('/execute-s3', executorController.executeS3File);

// 프리뷰 세션 생성
router.post('/preview', executorController.createPreview);

// 인라인(편집 반영) 프리뷰 세션 생성 — 모바일 IDE 세션 내 편집 프리뷰
router.post('/preview-inline', executorController.createPreviewInline);

// 프리뷰 세션 만료
router.post('/:sessionId/expire', executorController.expirePreview);

// 헬스 체크
router.get('/health', executorController.healthCheck);

// 프리뷰 파일 제공 (가장 마지막에 정의하여 다른 라우트와 충돌 방지)
router.get('/:sessionId/*', executorController.servePreview);

module.exports = router;

