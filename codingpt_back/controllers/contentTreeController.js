const svc = require('../services/contentTreeService');
const { successResponse, errorResponse } = require('../utils/response');

const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    successResponse(res, data);
  } catch (e) {
    console.error('[contentTree] error:', e);
    errorResponse(res, e, e.statusCode || 500);
  }
};

module.exports = {
  getTree: wrap(() => svc.getTree()),

  createSection: wrap((req) => svc.createSection(req.body || {})),
  updateSection: wrap((req) => svc.updateSection(parseInt(req.params.id, 10), req.body || {})),
  deleteSection: wrap((req) => svc.deleteSection(parseInt(req.params.id, 10))),

  linkProductClass: wrap((req) => svc.linkProductClass(parseInt(req.params.productId, 10), parseInt(req.params.classId, 10))),
  unlinkProductClass: wrap((req) => svc.unlinkProductClass(parseInt(req.params.productId, 10), parseInt(req.params.classId, 10))),

  linkClassSection: wrap((req) => svc.linkClassSection(parseInt(req.params.classId, 10), parseInt(req.params.sectionId, 10))),
  unlinkClassSection: wrap((req) => svc.unlinkClassSection(parseInt(req.params.classId, 10), parseInt(req.params.sectionId, 10))),

  linkSectionLesson: wrap((req) => svc.linkSectionLesson(parseInt(req.params.sectionId, 10), parseInt(req.params.lessonId, 10))),
  unlinkSectionLesson: wrap((req) => svc.unlinkSectionLesson(parseInt(req.params.sectionId, 10), parseInt(req.params.lessonId, 10))),

  reorderClassesInProduct: wrap((req) => svc.reorderClassesInProduct(parseInt(req.params.productId, 10), (req.body || {}).orderedClassIds)),
  reorderSectionsInClass: wrap((req) => svc.reorderSectionsInClass(parseInt(req.params.classId, 10), (req.body || {}).orderedSectionIds)),
  reorderLessonsInSection: wrap((req) => svc.reorderLessonsInSection(parseInt(req.params.sectionId, 10), (req.body || {}).orderedLessonIds)),
};
