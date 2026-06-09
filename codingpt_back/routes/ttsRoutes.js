const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const ttsController = require('../controllers/ttsController');
const ttsAssetController = require('../controllers/ttsAssetController');

// 진짜 선택적 인증: 토큰이 있고 유효하면 req.user 설정, 없거나 무효면 익명(null)으로 통과.
// (과거엔 무효/만료 토큰이면 401 을 던져서, localStorage 에 stale 토큰이 있는 브라우저에서
//  voices/assets 호출이 전부 401 로 깨졌음. 단일 관리자 서비스라 인증 강제 불필요.)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], process.env.ACCESS_SECRET);
    } catch (e) {
      req.user = null; // 무효/만료 토큰 → 익명 처리 (401 던지지 않음)
    }
  } else {
    req.user = null;
  }
  next();
};

// 모든 라우트에 선택적 인증 미들웨어 적용
router.use(optionalAuth);

// ElevenLabs 모델 목록 조회
router.get('/models', ttsController.getModels);

// 특정 모델의 지원 설정 정보 조회
router.get('/models/:modelId/settings', ttsController.getModelSettings);

// Gemini 목소리 목록 조회
router.get('/voices', ttsController.getVoices);

// 보이스 샘플(▶) — 없으면 1회 생성+캐시 후 URL 반환 (무료 티어 rate limit 대응 lazy)
router.get('/voices/:voiceId/sample', ttsAssetController.voiceSample);

// 음성 생성 요청
router.post('/generate', ttsController.generate);

// 임시 생성 데이터 삭제
router.delete('/request/:requestId', ttsController.deleteRequest);

// 최종 저장
router.post('/save', ttsController.save);

// 저장된 파일 목록 조회
router.get('/saved', ttsController.getSavedFiles);

// 저장된 파일 삭제
router.delete('/saved/:savedFileId', ttsController.deleteSavedFile);

// 오디오 파일 프록시 (CORS 문제 해결용)
router.get('/audio/:requestId', ttsController.getAudioProxy);

// ───────────────────────────────────────────────
// 중앙 관리형 TTS 자산 라이브러리 (생성+영구저장 1단계, 수정=재생성, 삭제)
// ───────────────────────────────────────────────
router.post('/assets/generate-file', ttsAssetController.generateFile);
router.post('/assets/preview', ttsAssetController.preview);
router.post('/assets/save-preview', ttsAssetController.savePreview);
router.post('/assets', ttsAssetController.create);
router.get('/assets', ttsAssetController.list);
router.get('/assets/:id', ttsAssetController.getById);
router.put('/assets/:id', ttsAssetController.regenerate);
router.delete('/assets/:id', ttsAssetController.remove);

module.exports = router;
