const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/contentTreeController');

router.get('/tree', ctrl.getTree);

router.post('/sections', ctrl.createSection);
router.put('/sections/:id', ctrl.updateSection);
router.delete('/sections/:id', ctrl.deleteSection);

router.post('/products/:productId/classes/:classId', ctrl.linkProductClass);
router.delete('/products/:productId/classes/:classId', ctrl.unlinkProductClass);

router.post('/classes/:classId/sections/:sectionId', ctrl.linkClassSection);
router.delete('/classes/:classId/sections/:sectionId', ctrl.unlinkClassSection);

router.post('/sections/:sectionId/lessons/:lessonId', ctrl.linkSectionLesson);
router.delete('/sections/:sectionId/lessons/:lessonId', ctrl.unlinkSectionLesson);

router.post('/classes/:classId/sections/reorder', ctrl.reorderSectionsInClass);
router.post('/sections/:sectionId/lessons/reorder', ctrl.reorderLessonsInSection);

module.exports = router;
