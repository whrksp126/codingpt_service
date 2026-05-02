const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const ttsController = require('../controllers/ttsController');

// 인증은 선택적 (토큰이 있으면 사용, 없으면 null)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // 토큰이 있으면 인증 미들웨어 실행
    return authMiddleware(req, res, next);
  } else {
    // 토큰이 없으면 req.user를 null로 설정하고 계속 진행
    req.user = null;
    next();
  }
};

// 모든 라우트에 선택적 인증 미들웨어 적용
router.use(optionalAuth);

// ElevenLabs 모델 목록 조회
router.get('/models', ttsController.getModels);

// 특정 모델의 지원 설정 정보 조회
router.get('/models/:modelId/settings', ttsController.getModelSettings);

// ElevenLabs 목소리 목록 조회
router.get('/voices', ttsController.getVoices);

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

module.exports = router;
