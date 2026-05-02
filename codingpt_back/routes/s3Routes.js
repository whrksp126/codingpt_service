const express = require('express');
const router = express.Router();
const s3Controller = require('../controllers/s3Controller');

// S3 파일 목록 조회 (POST 또는 GET)
router.post('/files', s3Controller.listFiles);
router.get('/files', s3Controller.listFiles);

// S3 파일 내용 조회 (POST 또는 GET)
router.post('/file', s3Controller.getFileContent);
router.get('/file', s3Controller.getFileContent);

// S3 파일 저장/업데이트 (PUT)
router.put('/file', s3Controller.saveFile);

// S3 파일 삭제 (DELETE)
router.delete('/file', s3Controller.deleteFile);

// S3 폴더 생성 (POST)
router.post('/folder', s3Controller.createFolder);

// S3 파일/폴더명 수정 (통합 API) (PUT)
router.put('/rename', s3Controller.rename);

// S3 파일/폴더 이동 (통합 API) (POST)
router.post('/move', s3Controller.move);

// CloudFront 캐시 무효화 (POST 또는 PUT)
router.post('/invalidate', s3Controller.invalidateCache);
router.put('/invalidate', s3Controller.invalidateCache);

module.exports = router;

