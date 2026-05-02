const lessonService = require('../services/lessonService');
const { successResponse, errorResponse } = require('../utils/response');

// 레슨별 슬라이드 데이터 조회
const getSlidesByLesson = async (req, res) => {
  try {
    const data = await lessonService.getSlidesByLesson();
    successResponse(res, data, '레슨별 슬라이드 데이터를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('슬라이드 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// slide_id로 코드 빈칸 채우기 퀴즈 조회
const getCodeFillGapsBySlideId = async (req, res) => {
  try {
    const { slideId } = req.params;
    const userId = req.user.id;
    
    if (!userId) {
      return errorResponse(res, new Error('사용자 정보가 없습니다.'), 400);
    }
    if (!slideId) {
      return errorResponse(res, new Error('slideId가 필요합니다.'), 400);
    }

    const data = await lessonService.getCodeFillGapsBySlideId(parseInt(slideId));
    successResponse(res, data, '코드 빈칸 채우기 퀴즈를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('코드 빈칸 채우기 퀴즈 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

module.exports = {
  getSlidesByLesson,
  getCodeFillGapsBySlideId
}; 