const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/contentTreeController');

router.get('/tree', ctrl.getTree);

router.post('/sections', ctrl.createSection);
router.put('/sections/:id', ctrl.updateSection);
router.delete('/sections/:id', ctrl.deleteSection);

// reorder 라우트는 link 라우트(:classId, :sectionId, :lessonId)보다 먼저 등록해야 함
// — Express는 첫 매칭을 사용하므로, "reorder"가 동적 파라미터로 잡히는 걸 막아야 함.
router.post('/products/:productId/classes/reorder', ctrl.reorderClassesInProduct);
router.post('/classes/:classId/sections/reorder', ctrl.reorderSectionsInClass);
router.post('/sections/:sectionId/lessons/reorder', ctrl.reorderLessonsInSection);

router.post('/products/:productId/classes/:classId', ctrl.linkProductClass);
router.delete('/products/:productId/classes/:classId', ctrl.unlinkProductClass);

router.post('/classes/:classId/sections/:sectionId', ctrl.linkClassSection);
router.delete('/classes/:classId/sections/:sectionId', ctrl.unlinkClassSection);

router.post('/sections/:sectionId/lessons/:lessonId', ctrl.linkSectionLesson);
router.delete('/sections/:sectionId/lessons/:lessonId', ctrl.unlinkSectionLesson);

module.exports = router;
