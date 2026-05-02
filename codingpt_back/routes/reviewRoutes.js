const express = require('express');
const router = express.Router();
const { createReview, getReviewsByProductId, updateReview, deleteReview, getMyReviews } = require('../controllers/reviewController');
const authMiddleware = require('../middlewares/authMiddleware');

// 리뷰 관련 라우트
router.post('/', authMiddleware, createReview);              // 리뷰 등록
router.get('/my', authMiddleware, getMyReviews);             // 내가 등록한 리뷰 조회
router.get('/product/:productId', getReviewsByProductId);    // 특정 상품의 리뷰 조회
router.put('/:reviewId', authMiddleware, updateReview);      // 리뷰 수정
router.delete('/:reviewId', authMiddleware, deleteReview);   // 리뷰 삭제

module.exports = router;