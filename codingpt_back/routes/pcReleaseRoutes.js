// PC 앱 릴리스 — 자동 업데이트 확인 + 배포물 다운로드(공개, 무인증. 시크릿/개인정보 없음)
const express = require('express');
const router = express.Router();
const pcReleaseController = require('../controllers/pcReleaseController');

router.get('/update/:target/:arch/:version', pcReleaseController.update);
router.get('/dl/*', pcReleaseController.download);

module.exports = router;
