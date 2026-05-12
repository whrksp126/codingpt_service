const { Op } = require('sequelize');
const { Product, Class, Section, Lesson, Slide, LessonSlideMap, User, CodeFillGap } = require('../models');

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

  // enabled === false 인 항목들을 RN 응답에서 제거 (관리자에서 비활성 상태로 저장한 데이터는 DB에 보존하되 학습 화면에서는 숨김)
  // 처리 대상:
  //   - module.tts.enabled === false → tts 필드 제거
  //   - module.speeches[].tts.enabled === false → 해당 speech.tts 제거
  //   - module.result.modules[].enabled === false → result.modules 배열에서 제거
  _stripDisabled(modules) {
    if (!Array.isArray(modules)) return modules;
    return modules.map((m) => this._stripDisabledModule(m)).filter((m) => m && m.enabled !== false);
  }

  _stripDisabledModule(m) {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };

    if (out.tts && typeof out.tts === 'object' && out.tts.enabled === false) {
      delete out.tts;
    }

    if (Array.isArray(out.speeches)) {
      out.speeches = out.speeches.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const sOut = { ...s };
        if (sOut.tts && typeof sOut.tts === 'object' && sOut.tts.enabled === false) {
          delete sOut.tts;
        }
        return sOut;
      });
    }

    if (out.result && typeof out.result === 'object' && Array.isArray(out.result.modules)) {
      out.result = {
        ...out.result,
        modules: this._stripDisabled(out.result.modules),
      };
    }

    return out;
  }

  // RN(학습자) 화면용: 레슨 → { id, title, sliders: [...] } 평탄화
  // 신/구 contents 스키마 모두 지원 (구: { sliders: [...] }, 신: { title, role, modules, ... })
  async getLessonRuntime(lessonId) {
    const lesson = await Lesson.findByPk(lessonId);
    if (!lesson) return null;

    const maps = await LessonSlideMap.findAll({
      where: { lesson_id: lessonId },
      order: [['order_no', 'ASC']],
    });
    const slideIds = maps.map((m) => m.slide_id);
    const slides = slideIds.length
      ? await Slide.findAll({ where: { id: { [Op.in]: slideIds } } })
      : [];
    const slideById = new Map(slides.map((s) => [s.id, s]));

    const sliders = [];
    let sliderIdx = 0;
    for (const m of maps) {
      const slide = slideById.get(m.slide_id);
      if (!slide || !slide.contents) continue;
      const c = slide.contents;

      // 구 스키마: { sliders: [...] }
      if (Array.isArray(c.sliders)) {
        for (const s of c.sliders) {
          sliders.push({
            id: sliderIdx++,
            title: s.title || '',
            role: s.role,
            background: s.background,
            modules: this._stripDisabled(Array.isArray(s.modules) ? s.modules : []),
            visibility: s.visibility,
            autoAdvance: s.autoAdvance,
          });
        }
      } else {
        // 신 스키마: { title, role, background, modules, ... }
        sliders.push({
          id: sliderIdx++,
          title: c.title || '',
          role: c.role,
          background: c.background,
          modules: this._stripDisabled(Array.isArray(c.modules) ? c.modules : []),
          visibility: c.visibility,
          autoAdvance: c.autoAdvance,
        });
      }
    }

    return {
      id: lesson.id,
      title: lesson.name,
      isCompleted: false,
      sliders,
    };
  }
}

module.exports = new LessonService();