const { Op } = require('sequelize');
const { sequelize, Lesson, Slide, LessonSlideMap, CodeFillGap, TTSAsset } = require('../models');
const lessonSchema = require('./lessonSchema');
const { transformContentsDeep } = require('../utils/lessonContentsMigration');
const { collectAssetIds, hydrate, dehydrate } = require('../utils/ttsHydration');
const ttsAssetService = require('./ttsAssetService');

const buildEmptySlideContents = (role = 'custom') => {
  const preset = lessonSchema.SLIDE_TYPE_PRESETS[role] || lessonSchema.SLIDE_TYPE_PRESETS.custom;
  return {
    title: '',
    role,
    background: preset.background,
    modules: [
      {
        id: 0,
        type: 'paragraph',
        content: '<p>여기에 텍스트를 입력하세요</p>',
        icon: {
          name: 'KeyReturn',
          size: 32,
          fill: '#08875D',
          backgroundSize: 64,
          backgroundColor: '#EDFDF8',
        },
      },
    ],
    schemaVersion: '1',
  };
};

const ROLE_BY_FIRST_COLOR = {
  '#D7F3E0': 'intro',
  '#F2E1C0': 'goal',
  '#DBEAFE': 'concept',
  '#F7DCDE': 'quiz',
  '#E6DFF7': 'ending',
};

const detectRoleFromBackground = (bg) => {
  if (!bg || !Array.isArray(bg.colors) || bg.colors.length === 0) return null;
  const first = String(bg.colors[0] || '').toUpperCase();
  return ROLE_BY_FIRST_COLOR[first] || null;
};

const normalizeSliderToNewSchema = (slider, parentContents = {}) => {
  const bg = slider.background || parentContents.background;
  const detectedRole = detectRoleFromBackground(bg);
  const validRoles = lessonSchema.SLIDE_ROLES;
  const sliderRole = slider.role && validRoles.includes(slider.role) ? slider.role : null;
  return {
    title: slider.title || '',
    role: sliderRole || detectedRole || 'custom',
    background: bg || lessonSchema.SLIDE_TYPE_PRESETS.custom.background,
    modules: Array.isArray(slider.modules) ? slider.modules : [],
    schemaVersion: '1',
  };
};

const isLegacyContents = (c) => c && Array.isArray(c.sliders);

const validateSlideContents = (contents) => {
  const result = lessonSchema.slideContentsSchema.safeParse(contents);
  if (!result.success) {
    const err = new Error('슬라이드 콘텐츠 검증 실패');
    err.name = 'ValidationError';
    err.statusCode = 422;
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
};

const validateLessonMeta = (patch) => {
  const result = lessonSchema.lessonMetaSchema.partial().safeParse(patch);
  if (!result.success) {
    const err = new Error('레슨 메타 검증 실패');
    err.name = 'ValidationError';
    err.statusCode = 422;
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
};

class LessonEditorService {
  async listLessons({ search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    const offset = (page - 1) * limit;
    const { rows, count } = await Lesson.findAndCountAll({
      where,
      order: [['updated_at', 'DESC']],
      limit,
      offset,
      attributes: ['id', 'name', 'type', 'description', 'default_character', 'characters', 'published_at', 'updated_at', 'created_at'],
    });
    return { lessons: rows, total: count, page, limit };
  }

  async createLesson({ name, type = '이론', description } = {}) {
    if (!name || !name.trim()) {
      const err = new Error('레슨 이름이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    return sequelize.transaction(async (t) => {
      const maxOrder = await Lesson.max('order_no', { transaction: t });
      const lesson = await Lesson.create({
        name: name.trim(),
        type,
        description: description || null,
        order_no: (maxOrder == null ? 0 : maxOrder + 1),
        meta: {},
      }, { transaction: t });

      const slide = await Slide.create({
        contents: buildEmptySlideContents('intro'),
      }, { transaction: t });

      await LessonSlideMap.create({
        lesson_id: lesson.id,
        slide_id: slide.id,
        order_no: 0,
      }, { transaction: t });

      return this._loadLesson(lesson.id, t);
    });
  }

  async getLesson(id) {
    await this._normalizeLegacyContents(id);
    const lesson = await this._loadLesson(id);
    if (!lesson) {
      const err = new Error('레슨을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }
    return lesson;
  }

  async _normalizeLegacyContents(lessonId) {
    return sequelize.transaction(async (t) => {
      const maps = await LessonSlideMap.findAll({
        where: { lesson_id: lessonId },
        order: [['order_no', 'ASC']],
        transaction: t,
      });
      if (maps.length === 0) return;

      const slideIds = maps.map((m) => m.slide_id);
      const slides = await Slide.findAll({
        where: { id: { [Op.in]: slideIds } },
        transaction: t,
      });
      const slideById = new Map(slides.map((s) => [s.id, s]));

      const hasLegacy = maps.some((m) => isLegacyContents(slideById.get(m.slide_id)?.contents));
      if (!hasLegacy) return;

      // Build flat list of (existingSlideId|null, contents) entries.
      const newEntries = [];
      for (const m of maps) {
        const slide = slideById.get(m.slide_id);
        if (!slide) continue;
        const c = slide.contents || {};

        if (isLegacyContents(c)) {
          // If this slide is referenced by other lessons, never mutate it — always create new slide rows.
          const usedElsewhere = await LessonSlideMap.count({
            where: { slide_id: slide.id, lesson_id: { [Op.ne]: lessonId } },
            transaction: t,
          });
          if (c.sliders.length === 0) {
            newEntries.push({
              slideId: usedElsewhere === 0 ? slide.id : null,
              contents: {
                title: c.title || '',
                role: detectRoleFromBackground(c.background) || 'custom',
                background: c.background || lessonSchema.SLIDE_TYPE_PRESETS.custom.background,
                modules: [],
                schemaVersion: '1',
              },
            });
          } else {
            c.sliders.forEach((slider, idx) => {
              newEntries.push({
                slideId: (idx === 0 && usedElsewhere === 0) ? slide.id : null,
                contents: normalizeSliderToNewSchema(slider, c),
              });
            });
          }
        } else {
          newEntries.push({ slideId: slide.id, contents: c });
        }
      }

      // Wipe old maps for this lesson, then recreate.
      await LessonSlideMap.destroy({ where: { lesson_id: lessonId }, transaction: t });

      for (let i = 0; i < newEntries.length; i++) {
        const e = newEntries[i];
        let sid = e.slideId;
        if (sid == null) {
          const created = await Slide.create({ contents: e.contents }, { transaction: t });
          sid = created.id;
        } else {
          await Slide.update(
            { contents: e.contents, updated_at: new Date() },
            { where: { id: sid }, transaction: t },
          );
        }
        await LessonSlideMap.create({
          lesson_id: lessonId,
          slide_id: sid,
          order_no: i,
        }, { transaction: t });
      }

      // Clean up orphan slides (referenced by no lesson) that we left behind.
      const stillUsed = await LessonSlideMap.findAll({
        where: { slide_id: { [Op.in]: slideIds } },
        transaction: t,
      });
      const stillUsedSet = new Set(stillUsed.map((r) => r.slide_id));
      const orphanIds = slideIds.filter((id) => !stillUsedSet.has(id));
      if (orphanIds.length) {
        await Slide.destroy({ where: { id: { [Op.in]: orphanIds } }, transaction: t });
      }

      await this._touchLesson(lessonId, t);
    });
  }

  async updateLessonMeta(id, patch) {
    const validated = validateLessonMeta(patch);
    const [count] = await Lesson.update(validated, { where: { id } });
    if (count === 0) {
      const err = new Error('레슨을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }
    return this._loadLesson(id);
  }

  async deleteLesson(id) {
    return sequelize.transaction(async (t) => {
      const slideRows = await LessonSlideMap.findAll({
        where: { lesson_id: id },
        transaction: t,
      });
      const slideIds = slideRows.map((r) => r.slide_id);
      await LessonSlideMap.destroy({ where: { lesson_id: id }, transaction: t });
      if (slideIds.length) {
        const sharedMaps = await LessonSlideMap.findAll({
          where: { slide_id: { [Op.in]: slideIds } },
          transaction: t,
        });
        const stillUsed = new Set(sharedMaps.map((r) => r.slide_id));
        const orphanIds = slideIds.filter((sid) => !stillUsed.has(sid));
        if (orphanIds.length) {
          await Slide.destroy({ where: { id: { [Op.in]: orphanIds } }, transaction: t });
        }
      }
      const count = await Lesson.destroy({ where: { id }, transaction: t });
      if (count === 0) {
        const err = new Error('레슨을 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }
      return { id };
    });
  }

  async addSlide(lessonId, { role = 'custom', insertAfter = null } = {}) {
    return sequelize.transaction(async (t) => {
      const lesson = await Lesson.findByPk(lessonId, { transaction: t });
      if (!lesson) {
        const err = new Error('레슨을 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }

      const maps = await LessonSlideMap.findAll({
        where: { lesson_id: lessonId },
        order: [['order_no', 'ASC']],
        transaction: t,
      });

      let insertIdx = maps.length;
      if (insertAfter != null) {
        const i = maps.findIndex((m) => m.slide_id === Number(insertAfter));
        if (i !== -1) insertIdx = i + 1;
      }

      for (let i = maps.length - 1; i >= insertIdx; i--) {
        await LessonSlideMap.update(
          { order_no: maps[i].order_no + 1 },
          {
            where: { lesson_id: lessonId, slide_id: maps[i].slide_id },
            transaction: t,
          },
        );
      }

      const slide = await Slide.create({
        contents: buildEmptySlideContents(role),
      }, { transaction: t });

      await LessonSlideMap.create({
        lesson_id: lessonId,
        slide_id: slide.id,
        order_no: insertIdx,
      }, { transaction: t });

      await this._touchLesson(lessonId, t);

      return {
        id: slide.id,
        contents: slide.contents,
        order_no: insertIdx,
      };
    });
  }

  async updateSlideContents(lessonId, slideId, contents) {
    const map = await LessonSlideMap.findOne({
      where: { lesson_id: lessonId, slide_id: slideId },
    });
    if (!map) {
      const err = new Error('슬라이드를 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }
    // tts:{assetId,url,timestamps} → {assetId,enabled?} 로 슬림화(인라인 데이터 부활 방지)
    const validated = validateSlideContents(dehydrate(contents));
    await Slide.update(
      { contents: validated, updated_at: new Date() },
      { where: { id: slideId } },
    );
    await this._touchLesson(lessonId);
    return { id: slideId, contents: validated };
  }

  // 슬라이드 contents 중 특정 모듈만 patcher 로 변형 후 저장. 트랜잭션으로 자동저장과의 race 보호.
  // 모듈 검색은 재귀적 — 최상위 modules 뿐 아니라 각 모듈의 result/allResult/correctResult/incorrectResult.modules
  // 안의 중첩 모듈(예: codeFillTheGapV2 결과 영역의 terminal)도 찾는다.
  //
  // patcher(module, slideContents) → 반환값이 truthy 면 그것으로 슬롯 교체.
  // 사용처: precompute 컨트롤러가 cachedResult/cachedResults 패치할 때.
  async patchSlideModule(lessonId, slideId, moduleId, patcher) {
    return sequelize.transaction(async (t) => {
      const map = await LessonSlideMap.findOne({
        where: { lesson_id: lessonId, slide_id: slideId },
        transaction: t,
      });
      if (!map) {
        const err = new Error('슬라이드를 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }
      const slide = await Slide.findByPk(slideId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!slide || !slide.contents) {
        const err = new Error('슬라이드 콘텐츠가 비어있습니다.');
        err.statusCode = 404;
        throw err;
      }
      // 깊은 복사 — JSONB 직접 mutate 시 Sequelize change tracking 실패 회피
      const contents = JSON.parse(JSON.stringify(slide.contents));

      // 재귀 검색 + patch. 찾으면 patchedModule 객체 반환, 못 찾으면 null.
      let patchedModule = null;
      const visit = async (modules) => {
        if (!Array.isArray(modules)) return false;
        for (let i = 0; i < modules.length; i++) {
          const m = modules[i];
          if (!m) continue;
          if (String(m.id) === String(moduleId)) {
            const patched = await patcher(m, contents);
            if (patched && patched !== m) modules[i] = patched;
            patchedModule = modules[i];
            return true;
          }
          // 중첩 result 영역
          for (const bucket of ['allResult', 'correctResult', 'incorrectResult', 'result']) {
            if (m[bucket]?.modules && Array.isArray(m[bucket].modules)) {
              if (await visit(m[bucket].modules)) return true;
            }
          }
        }
        return false;
      };

      const found = await visit(Array.isArray(contents.modules) ? contents.modules : []);
      if (!found) {
        const err = new Error('모듈을 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }
      const validated = validateSlideContents(dehydrate(contents));
      await Slide.update(
        { contents: validated, updated_at: new Date() },
        { where: { id: slideId }, transaction: t },
      );
      await this._touchLesson(lessonId, t);
      return { id: slideId, contents: validated, module: patchedModule };
    });
  }

  async deleteSlide(lessonId, slideId) {
    return sequelize.transaction(async (t) => {
      const map = await LessonSlideMap.findOne({
        where: { lesson_id: lessonId, slide_id: slideId },
        transaction: t,
      });
      if (!map) {
        const err = new Error('슬라이드를 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }
      await LessonSlideMap.destroy({
        where: { lesson_id: lessonId, slide_id: slideId },
        transaction: t,
      });

      const otherMaps = await LessonSlideMap.findAll({
        where: { lesson_id: lessonId },
        order: [['order_no', 'ASC']],
        transaction: t,
      });
      for (let i = 0; i < otherMaps.length; i++) {
        if (otherMaps[i].order_no !== i) {
          await LessonSlideMap.update(
            { order_no: i },
            { where: { lesson_id: lessonId, slide_id: otherMaps[i].slide_id }, transaction: t },
          );
        }
      }

      const usedElsewhere = await LessonSlideMap.count({
        where: { slide_id: slideId },
        transaction: t,
      });
      if (usedElsewhere === 0) {
        await Slide.destroy({ where: { id: slideId }, transaction: t });
      }

      await this._touchLesson(lessonId, t);
      return { id: slideId };
    });
  }

  async reorderSlides(lessonId, orderedSlideIds) {
    if (!Array.isArray(orderedSlideIds)) {
      const err = new Error('orderedSlideIds는 배열이어야 합니다.');
      err.statusCode = 400;
      throw err;
    }
    return sequelize.transaction(async (t) => {
      const maps = await LessonSlideMap.findAll({
        where: { lesson_id: lessonId },
        transaction: t,
      });
      const existingIds = new Set(maps.map((m) => m.slide_id));
      const expected = new Set(orderedSlideIds.map(Number));
      if (existingIds.size !== expected.size || [...existingIds].some((id) => !expected.has(id))) {
        const err = new Error('orderedSlideIds가 현재 슬라이드 집합과 일치하지 않습니다.');
        err.statusCode = 400;
        throw err;
      }
      for (let i = 0; i < orderedSlideIds.length; i++) {
        await LessonSlideMap.update(
          { order_no: i },
          { where: { lesson_id: lessonId, slide_id: Number(orderedSlideIds[i]) }, transaction: t },
        );
      }
      await this._touchLesson(lessonId, t);
      return { lessonId, orderedSlideIds: orderedSlideIds.map(Number) };
    });
  }

  async listCharacters() {
    return lessonSchema.BUILTIN_CHARACTERS.map((c) => ({
      ...c,
      url: lessonSchema.buildCharacterUrl(c.key),
    }));
  }

  async getUsedAssetMap() {
    const slides = await Slide.findAll({
      attributes: ['id', 'contents'],
      include: [{
        model: LessonSlideMap,
        attributes: ['lesson_id', 'order_no'],
        include: [{ model: Lesson, attributes: ['id', 'name'] }],
      }],
    });
    // 주의: 폴더명에 공백(예: 'HTML 역할')이 있을 수 있어 \s 를 제외 문자에서 빼야 함.
    // (JSON 문자열 안의 URL 이라 따옴표 등에서 자연 종료됨)
    const URL_RE = /https:\/\/objectstore\.ghmate\.com\/codingpt\/(?:lesson-assets|tts\/static)\/[^"'<>)\]]+/g;
    const map = {};
    for (const s of slides) {
      const c = s.contents;
      if (!c) continue;
      const text = typeof c === 'string' ? c : JSON.stringify(c);
      const urls = new Set(text.match(URL_RE) || []);
      if (urls.size === 0) continue;
      const slideTitle = (typeof c === 'object' && c && c.title) ? String(c.title) : '';
      const maps = s.LessonSlideMaps || [];
      for (const url of urls) {
        if (!map[url]) map[url] = [];
        if (maps.length === 0) {
          map[url].push({ lessonId: null, lessonName: '(연결된 레슨 없음)', slideId: s.id, slideTitle, orderNo: null });
        }
        for (const m of maps) {
          const lesson = m.Lesson;
          if (!lesson) continue;
          map[url].push({
            lessonId: lesson.id,
            lessonName: lesson.name,
            slideId: s.id,
            slideTitle,
            orderNo: m.order_no,
          });
        }
      }
    }
    return map;
  }

  async updateAssetUrls(replacements) {
    if (!Array.isArray(replacements) || replacements.length === 0) {
      return { updatedSlides: 0, updatedReferences: 0 };
    }
    // 유효성 검사: 각 항목은 {oldPrefix, newPrefix} 또는 {oldUrl, newUrl}
    const normalized = replacements.map((r) => {
      if (r.oldPrefix && r.newPrefix) return { type: 'prefix', from: r.oldPrefix, to: r.newPrefix };
      if (r.oldUrl && r.newUrl) return { type: 'exact', from: r.oldUrl, to: r.newUrl };
      return null;
    }).filter(Boolean);
    if (normalized.length === 0) return { updatedSlides: 0, updatedReferences: 0 };

    const slides = await Slide.findAll({ attributes: ['id', 'contents'] });
    let updatedSlides = 0;
    let updatedReferences = 0;

    for (const s of slides) {
      const c = s.contents;
      if (!c) continue;
      const original = typeof c === 'string' ? c : JSON.stringify(c);
      let text = original;
      for (const rep of normalized) {
        // prefix 치환은 모든 등장 위치 치환. exact는 동일 URL 정확 매칭.
        // JSON 안에 있으니 단순 split-join 사용 (정규식 이스케이프 부담 회피).
        if (text.includes(rep.from)) {
          const parts = text.split(rep.from);
          updatedReferences += parts.length - 1;
          text = parts.join(rep.to);
        }
      }
      if (text !== original) {
        let nextContents;
        try {
          nextContents = typeof c === 'string' ? text : JSON.parse(text);
        } catch (err) {
          console.warn('[lessonEditor] slide', s.id, 'JSON 재구성 실패, 변경 건너뜀:', err.message);
          continue;
        }
        await Slide.update(
          { contents: nextContents, updated_at: new Date() },
          { where: { id: s.id } },
        );
        updatedSlides += 1;
      }
    }
    return { updatedSlides, updatedReferences };
  }

  async getCodeFillGap(slideId) {
    const row = await CodeFillGap.findOne({ where: { slide_id: slideId } });
    return { content: row?.content || '' };
  }

  async upsertCodeFillGap(slideId, content) {
    const slide = await Slide.findByPk(slideId);
    if (!slide) {
      const err = new Error('슬라이드 없음');
      err.statusCode = 404;
      throw err;
    }
    const existing = await CodeFillGap.findOne({ where: { slide_id: slideId } });
    let result;
    if (existing) {
      await existing.update({ content });
      result = { id: existing.id, content };
    } else {
      const created = await CodeFillGap.create({ slide_id: slideId, content });
      result = { id: created.id, content };
    }
    await this._touchLessonsContainingSlide(slideId);
    return result;
  }

  async deleteCodeFillGap(slideId) {
    await CodeFillGap.destroy({ where: { slide_id: slideId } });
    await this._touchLessonsContainingSlide(slideId);
    return { ok: true };
  }

  // Sequelize의 Model.update는 timestamps 필드만 단독으로 넘기면 SQL 자체를
  // 생성하지 않는다(자동관리 필드로 보고 무시). 그래서 부모 레슨의 updated_at만
  // bump하려면 raw SQL로 직접 쳐야 한다.
  async _touchLesson(lessonId, transaction) {
    await sequelize.query(
      'UPDATE lesson SET updated_at = NOW() WHERE id = :id',
      { replacements: { id: lessonId }, transaction },
    );
  }

  async _touchLessonsContainingSlide(slideId, transaction) {
    const maps = await LessonSlideMap.findAll({
      where: { slide_id: slideId },
      transaction,
    });
    if (!maps.length) return;
    const lessonIds = [...new Set(maps.map((m) => m.lesson_id))];
    await sequelize.query(
      'UPDATE lesson SET updated_at = NOW() WHERE id IN (:ids)',
      { replacements: { ids: lessonIds }, transaction },
    );
  }

  async _loadLesson(id, transaction) {
    const lesson = await Lesson.findByPk(id, { transaction });
    if (!lesson) return null;
    const maps = await LessonSlideMap.findAll({
      where: { lesson_id: id },
      order: [['order_no', 'ASC']],
      transaction,
    });
    const slideIds = maps.map((m) => m.slide_id);
    const slides = slideIds.length
      ? await Slide.findAll({
        where: { id: { [Op.in]: slideIds } },
        transaction,
      })
      : [];
    const slideMap = new Map(slides.map((s) => [s.id, s]));
    // 에디터 표시용 TTS 하이드레이션: tts.assetId → {url,timestamps,duration} (저장 시 dehydrate 됨)
    const ttsAssetMap = await this._buildTtsAssetMap(slides);
    return {
      id: lesson.id,
      name: lesson.name,
      type: lesson.type,
      description: lesson.description,
      default_character: lesson.default_character,
      characters: lesson.characters || [],
      meta: lesson.meta,
      published_at: lesson.published_at,
      created_at: lesson.created_at,
      updated_at: lesson.updated_at,
      slides: maps.map((m, idx) => {
        const slide = slideMap.get(m.slide_id);
        // 안전망: legacy 결과영역 / codeRunResult 가 남아있으면 응답 시점에 평면화 + trigger 부여.
        // DB 마이그레이션이 누락된 슬라이드 보호 (idempotent). 어드민은 변환된 데이터로 편집 → 저장 시 자연스레 새 구조로 영구화.
        return {
          id: m.slide_id,
          order_no: idx,
          contents: slide ? hydrate(transformContentsDeep(slide.contents), ttsAssetMap) : null,
          updated_at: slide ? slide.updated_at : null,
        };
      }),
    };
  }

  // 슬라이드들이 참조하는 tts.assetId 를 모아 일괄 조회 → Map<id, {url,timestamps,duration}>.
  async _buildTtsAssetMap(slides) {
    const ids = new Set();
    for (const s of slides) {
      if (!s || !s.contents) continue;
      for (const id of collectAssetIds(s.contents)) ids.add(id);
    }
    const map = new Map();
    if (ids.size === 0) return map;
    const assets = await TTSAsset.findAll({ where: { id: { [Op.in]: [...ids] } } });
    for (const a of assets) {
      map.set(a.id, {
        url: ttsAssetService.audioUrlForAsset(a),
        timestamps: a.timestamps,
        duration: a.duration,
        voiceId: a.voice_id,
        modelId: a.model_id,
      });
    }
    return map;
  }
}

module.exports = new LessonEditorService();
