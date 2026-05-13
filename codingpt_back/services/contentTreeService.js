const { Op } = require('sequelize');
const {
  sequelize,
  Product,
  Class,
  Section,
  Lesson,
  ProductClassMap,
  ClassSectionMap,
  SectionLessonMap,
} = require('../models');

class ContentTreeService {
  async getTree() {
    const products = await Product.findAll({
      attributes: ['id', 'name', 'description', 'type', 'price', 'category', 'difficulty', 'is_active', 'updated_at'],
      order: [['id', 'ASC']],
      include: [
        {
          model: Class,
          as: 'Classes',
          through: { model: ProductClassMap, attributes: [] },
          attributes: ['id', 'name', 'description', 'order_no', 'updated_at'],
          include: [
            {
              model: Section,
              as: 'Sections',
              through: { model: ClassSectionMap, attributes: [] },
              attributes: ['id', 'order_no', 'name', 'updated_at'],
              include: [
                {
                  model: Lesson,
                  as: 'Lessons',
                  through: { model: SectionLessonMap, attributes: [] },
                  attributes: ['id', 'order_no', 'name', 'type', 'description', 'published_at', 'updated_at'],
                },
              ],
            },
          ],
        },
      ],
    });

    const result = products.map((p) => p.toJSON());

    result.forEach((p) => {
      (p.Classes || []).sort((a, b) => (a.order_no || 0) - (b.order_no || 0));
      (p.Classes || []).forEach((c) => {
        (c.Sections || []).sort((a, b) => (a.order_no || 0) - (b.order_no || 0));
        (c.Sections || []).forEach((s) => {
          (s.Lessons || []).sort((a, b) => (a.order_no || 0) - (b.order_no || 0));
        });
      });
    });

    const classIds = new Set();
    const sectionIds = new Set();
    const lessonIds = new Set();
    result.forEach((p) => {
      (p.Classes || []).forEach((c) => {
        classIds.add(c.id);
        (c.Sections || []).forEach((s) => {
          sectionIds.add(s.id);
          (s.Lessons || []).forEach((l) => lessonIds.add(l.id));
        });
      });
    });

    const orphanClasses = await Class.findAll({
      where: { id: { [Op.notIn]: Array.from(classIds).length ? Array.from(classIds) : [0] } },
      attributes: ['id', 'name', 'description', 'updated_at'],
    });
    const orphanSections = await Section.findAll({
      where: { id: { [Op.notIn]: Array.from(sectionIds).length ? Array.from(sectionIds) : [0] } },
      attributes: ['id', 'order_no', 'name', 'updated_at'],
    });
    const orphanLessons = await Lesson.findAll({
      where: { id: { [Op.notIn]: Array.from(lessonIds).length ? Array.from(lessonIds) : [0] } },
      attributes: ['id', 'order_no', 'name', 'type', 'description', 'published_at', 'updated_at'],
    });

    return {
      products: result,
      orphans: {
        classes: orphanClasses,
        sections: orphanSections,
        lessons: orphanLessons,
      },
    };
  }

  async createSection({ name, doc_concept = {} }) {
    if (!name || !name.trim()) {
      const err = new Error('섹션 이름이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    const max = await Section.max('order_no');
    const section = await Section.create({
      name: name.trim(),
      order_no: (max == null ? 0 : max + 1),
      doc_concept: doc_concept || {},
    });
    return section;
  }

  async updateSection(id, patch) {
    const section = await Section.findByPk(id);
    if (!section) {
      const err = new Error('섹션을 찾을 수 없습니다.');
      err.statusCode = 404;
      throw err;
    }
    const allowed = {};
    if (patch.name != null) allowed.name = patch.name;
    if (patch.order_no != null) allowed.order_no = patch.order_no;
    if (patch.doc_concept != null) allowed.doc_concept = patch.doc_concept;
    await section.update(allowed);
    return section;
  }

  async deleteSection(id) {
    return sequelize.transaction(async (t) => {
      await ClassSectionMap.destroy({ where: { section_id: id }, transaction: t });
      await SectionLessonMap.destroy({ where: { section_id: id }, transaction: t });
      const count = await Section.destroy({ where: { id }, transaction: t });
      if (count === 0) {
        const err = new Error('섹션을 찾을 수 없습니다.');
        err.statusCode = 404;
        throw err;
      }
      return { id };
    });
  }

  async linkProductClass(productId, classId) {
    const [, created] = await ProductClassMap.findOrCreate({
      where: { product_id: productId, class_id: classId },
      defaults: { product_id: productId, class_id: classId },
    });
    return { product_id: productId, class_id: classId, created };
  }

  async unlinkProductClass(productId, classId) {
    const count = await ProductClassMap.destroy({
      where: { product_id: productId, class_id: classId },
    });
    return { removed: count };
  }

  async linkClassSection(classId, sectionId) {
    const [, created] = await ClassSectionMap.findOrCreate({
      where: { class_id: classId, section_id: sectionId },
      defaults: { class_id: classId, section_id: sectionId },
    });
    return { class_id: classId, section_id: sectionId, created };
  }

  async unlinkClassSection(classId, sectionId) {
    const count = await ClassSectionMap.destroy({
      where: { class_id: classId, section_id: sectionId },
    });
    return { removed: count };
  }

  async linkSectionLesson(sectionId, lessonId) {
    const [, created] = await SectionLessonMap.findOrCreate({
      where: { section_id: sectionId, lesson_id: lessonId },
      defaults: { section_id: sectionId, lesson_id: lessonId },
    });
    return { section_id: sectionId, lesson_id: lessonId, created };
  }

  async unlinkSectionLesson(sectionId, lessonId) {
    const count = await SectionLessonMap.destroy({
      where: { section_id: sectionId, lesson_id: lessonId },
    });
    return { removed: count };
  }

  async reorderClassesInProduct(productId, orderedClassIds) {
    if (!Array.isArray(orderedClassIds)) {
      const err = new Error('orderedClassIds 배열이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    return sequelize.transaction(async (t) => {
      for (let i = 0; i < orderedClassIds.length; i++) {
        await Class.update(
          { order_no: i },
          { where: { id: Number(orderedClassIds[i]) }, transaction: t },
        );
      }
      return { product_id: Number(productId), orderedClassIds: orderedClassIds.map(Number) };
    });
  }

  async reorderSectionsInClass(classId, orderedSectionIds) {
    if (!Array.isArray(orderedSectionIds)) {
      const err = new Error('orderedSectionIds 배열이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    return sequelize.transaction(async (t) => {
      for (let i = 0; i < orderedSectionIds.length; i++) {
        await Section.update(
          { order_no: i },
          { where: { id: Number(orderedSectionIds[i]) }, transaction: t },
        );
      }
      return { class_id: Number(classId), orderedSectionIds: orderedSectionIds.map(Number) };
    });
  }

  async reorderLessonsInSection(sectionId, orderedLessonIds) {
    if (!Array.isArray(orderedLessonIds)) {
      const err = new Error('orderedLessonIds 배열이 필요합니다.');
      err.statusCode = 400;
      throw err;
    }
    return sequelize.transaction(async (t) => {
      for (let i = 0; i < orderedLessonIds.length; i++) {
        await Lesson.update(
          { order_no: i },
          { where: { id: Number(orderedLessonIds[i]) }, transaction: t },
        );
      }
      return { section_id: Number(sectionId), orderedLessonIds: orderedLessonIds.map(Number) };
    });
  }
}

module.exports = new ContentTreeService();
