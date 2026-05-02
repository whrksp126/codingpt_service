const { Product, Class, Section, Lesson, Slide, User, CodeFillGap } = require('../models');

class LessonService {
  // 특정 제품 조회 (리뷰 포함)
  async getSlidesByLesson() {
    const temp = 1; // productId
    const sides = await Slide.findByPk(temp);

    return sides;
  }

  // slide_id로 코드 빈칸 채우기 퀴즈 조회
  async getCodeFillGapsBySlideId(slideId) {
    const codeFillGaps = await CodeFillGap.findAll({
      where: { slide_id: slideId }
    });

    return codeFillGaps;
  }
}

module.exports = new LessonService(); 