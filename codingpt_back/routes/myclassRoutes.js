const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const { 
  getAllMyclass, 
  getMyClasstById,
  getLessonResult,
  completeLessonWithResult,
  createMyclass
} = require('../controllers/myclassController');

// 내강의 관련 라우트
// 구체적인 라우트를 동적 라우트보다 먼저 정의해야 함
// 모든 엔드포인트에 인증 미들웨어 적용 (사용자별 데이터 접근)
router.get('/check', authMiddleware, getMyClasstById);                // 특정 상품 수강 여부 조회
router.patch('/complete', authMiddleware, completeLessonWithResult);  // 레슨별 슬라이드 결과값 업데이트
router.post('/', authMiddleware, createMyclass);                      // 내강의 등록
router.get('/:userId/lesson/:lessonId/result', authMiddleware, getLessonResult); // 특정 레슨 결과 조회
router.get('/:userId', authMiddleware, getAllMyclass);                // 모든 내강의 조회 (가장 마지막에 배치)

module.exports = router; 