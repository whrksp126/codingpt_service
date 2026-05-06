const { Op } = require('sequelize');
const { sequelize, Lesson, Slide, LessonSlideMap, CodeFillGap } = require('../models');
const lessonSchema = require('./lessonSchema');

const buildEmptySlideContents = (role = 'custom') => {
  const preset = lessonSchema.SLIDE_TYPE_PRESETS[role] || lessonSchema.SLIDE_TYPE_PRESETS.custom;
  return {
    title: '',
    role,
    background: preset.background,
    modules: [],
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

      await Lesson.update({ updated_at: new Date() }, { where: { id: lessonId }, transaction: t });
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

      await Lesson.update({ updated_at: new Date() }, { where: { id: lessonId }, transaction: t });

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
    const validated = validateSlideContents(contents);
    await Slide.update(
      { contents: validated, updated_at: new Date() },
      { where: { id: slideId } },
    );
    await Lesson.update({ updated_at: new Date() }, { where: { id: lessonId } });
    return { id: slideId, contents: validated };
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

      await Lesson.update({ updated_at: new Date() }, { where: { id: lessonId }, transaction: t });
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
      await Lesson.update({ updated_at: new Date() }, { where: { id: lessonId }, transaction: t });
      return { lessonId, orderedSlideIds: orderedSlideIds.map(Number) };
    });
  }

  async listCharacters() {
    return lessonSchema.BUILTIN_CHARACTERS.map((c) => ({
      ...c,
      url: lessonSchema.buildCharacterUrl(c.key),
    }));
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
    if (existing) {
      await existing.update({ content });
      return { id: existing.id, content };
    }
    const created = await CodeFillGap.create({ slide_id: slideId, content });
    return { id: created.id, content };
  }

  async deleteCodeFillGap(slideId) {
    await CodeFillGap.destroy({ where: { slide_id: slideId } });
    return { ok: true };
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
        return {
          id: m.slide_id,
          order_no: idx,
          contents: slide ? slide.contents : null,
          updated_at: slide ? slide.updated_at : null,
        };
      }),
    };
  }
}

module.exports = new LessonEditorService();
