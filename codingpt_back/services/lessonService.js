const { Op } = require('sequelize');
const { Product, Class, Section, Lesson, Slide, LessonSlideMap, User, CodeFillGap } = require('../models');
const { computeCodeHash } = require('../utils/codeHash');
const { transformContentsDeep } = require('../utils/lessonContentsMigration');
const codeFillExecutionUtils = require('./codeFillExecutionUtils');

// 언어 약어 정규화 (terminal/codeFillTheGapV2 모듈은 'js'/'py' 같은 약어 사용)
const normLang = (l) => {
  const x = String(l || '').toLowerCase();
  if (x === 'js') return 'javascript';
  if (x === 'py') return 'python';
  return x;
};

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

  // enabled === false 인 항목들을 RN 응답에서 제거 + simpleTerminal/terminal 의 stale cache 정리.
  //   - module.tts.enabled === false → tts 필드 제거
  //   - module.speeches[].tts.enabled === false → 해당 speech.tts 제거
  //   - cachedResult.codeHash 가 현재 연결/자체 코드 해시와 불일치 → cachedResult 제거 (RN 측에서 라이브 fallback)
  _stripDisabled(modules) {
    if (!Array.isArray(modules)) return modules;
    const cleaned = modules.map((m) => this._stripDisabledModule(m)).filter((m) => m && m.enabled !== false);
    for (const m of cleaned) this._stripStaleCache(m, cleaned);
    return cleaned;
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

    return out;
  }

  // 모듈별 stale cache 제거. 현재 코드/answers 의 해시와 비교.
  _stripStaleCache(m, allModules) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'simpleTerminal') {
      if (!m.cachedResult && !m.cachedResults) return;
      const linked = allModules?.find((x) => String(x?.id) === String(m.linkedModuleId));
      if (!linked) { delete m.cachedResult; delete m.cachedResults; return; }
      if (linked.type === 'code' && m.cachedResult) {
        const first = linked.files?.[0];
        if (!first) { delete m.cachedResult; return; }
        const hash = computeCodeHash(normLang(first.language), first.content || '');
        if (hash !== m.cachedResult.codeHash) delete m.cachedResult;
      }
      if (linked.type === 'codeFillTheGapV2' && m.cachedResults && typeof m.cachedResults === 'object') {
        const plainCode = String(linked.plainCode || '');
        const blanks = Array.isArray(linked.blanks) ? linked.blanks : [];
        const execLang = normLang(linked.language);
        const next = {};
        for (const [key, cr] of Object.entries(m.cachedResults)) {
          try {
            const parsed = JSON.parse(key);
            const answers = parsed.map((p) => ({ userAnswer: p?.[1] ?? '' }));
            const synth = codeFillExecutionUtils.synthesizeCodeForAnswers(plainCode, blanks, answers);
            const hash = computeCodeHash(execLang, synth);
            if (hash === cr.codeHash) next[key] = cr;
          } catch (_) { /* invalid key — drop */ }
        }
        if (Object.keys(next).length === 0) delete m.cachedResults;
        else m.cachedResults = next;
      }
      return;
    }
    if (m.type === 'terminal') {
      // 단일 cachedResult (일반 terminal — 토큰 없는 경우): 자신의 코드 해시 비교
      if (Array.isArray(m.files) && m.files.length > 0) {
        for (const tab of m.files) {
          if (!tab?.cachedResult) continue;
          const code = (tab.script || []).filter((s) => !s?.type || s.type === 'input').map((s) => s?.text ?? '').join('\n');
          const hash = computeCodeHash(normLang(tab.language || m.language), code);
          if (hash !== tab.cachedResult.codeHash) delete tab.cachedResult;
        }
      } else if (m.cachedResult) {
        const code = (m.script || []).filter((s) => !s?.type || s.type === 'input').map((s) => s?.text ?? '').join('\n');
        const hash = computeCodeHash(normLang(m.language), code);
        if (hash !== m.cachedResult.codeHash) delete m.cachedResult;
      }

      // 일반 terminal 의 cachedResults (옵션 조합별) 은 이제 simpleTerminal 로 마이그레이션되어 처리됨.
      return;
    }
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
      // 안전망: legacy 결과영역 / codeRunResult 가 남아있으면 응답 시점에 평면화 + trigger 부여.
      // DB 마이그레이션이 누락된 슬라이드 보호 (idempotent).
      const c = transformContentsDeep(slide.contents);

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