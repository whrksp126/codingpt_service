const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const { 
  getSlidesByLesson,
  getCodeFillGapsBySlideId
} = require('../controllers/lessonController');

// 레슨 관련 라우트
// router.get('/:lessonId/slides', getSlidesByLesson); // 레슨별 슬라이드 조회
router.get('/slides', authMiddleware, getSlidesByLesson); // 레슨별 슬라이드 조회
router.get('/slides/:slideId/code-fill-gaps', authMiddleware, getCodeFillGapsBySlideId);

module.exports = router;