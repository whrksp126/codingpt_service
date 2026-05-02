const reviewService = require('../services/reviewService');
const { successResponse, errorResponse } = require('../utils/response');

// 리뷰 등록
const createReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { product_id, score, review_text } = req.body;
    if (!userId || !product_id || !score || !review_text) {
      throw new Error('필수 파라미터가 누락되었습니다.');
    }
    const review = await reviewService.createReview(userId, product_id, score, review_text);
    if (review) {
      successResponse(res, review, '리뷰가 성공적으로 등록되었습니다.', 201);
    } else {
      errorResponse(res, '리뷰 등록 실패', 400);
    }
  } catch (error) {
    console.error('리뷰 등록 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 특정 상품의 리뷰 조회
const getReviewsByProductId = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!productId) {
      throw new Error('상품 ID가 필요합니다.');
    }
    const reviews = await reviewService.getReviewsByProductId(productId);
    if (reviews) {
      successResponse(res, reviews, '리뷰 목록을 성공적으로 조회했습니다.');
    } else {
      errorResponse(res, '리뷰 목록을 조회할 수 없습니다.', 400);
    }
  } catch (error) {
    console.error('리뷰 조회 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 리뷰 수정
const updateReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reviewId } = req.params;
    const { score, review_text } = req.body;

    if (!reviewId) {
      throw new Error('리뷰 ID가 필요합니다.');
    }

    const review = await reviewService.updateReview(reviewId, userId, { score, review_text });

    if (review) {
      successResponse(res, '리뷰가 성공적으로 수정되었습니다.', 200);
    } else {
      errorResponse(res, '리뷰 수정 실패', 400);
    }
  } catch (error) {
    console.error('리뷰 수정 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 리뷰 삭제
const deleteReview = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reviewId } = req.params;

    if (!reviewId) {
      throw new Error('리뷰 ID가 필요합니다.');
    }

    const result = await reviewService.deleteReview(reviewId, userId);
    if (result) {
      successResponse(res, null, '리뷰가 성공적으로 삭제되었습니다.');
    } else {
      errorResponse(res, '리뷰 삭제 실패', 400);
    }
  } catch (error) {
    console.error('리뷰 삭제 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 내가 등록한 리뷰 조회
const getMyReviews = async (req, res) => {
  try {
    const userId = req.user.id;
    const reviews = await reviewService.getMyReviews(userId);
    if (reviews) {
      successResponse(res, reviews, '내 리뷰 목록을 성공적으로 조회했습니다.');
    } else {
      errorResponse(res, '리뷰 목록을 조회할 수 없습니다.', 400);
    }
  } catch (error) {
    console.error('내 리뷰 조회 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

module.exports = {
  createReview,
  getReviewsByProductId,
  updateReview,
  deleteReview,
  getMyReviews
};
