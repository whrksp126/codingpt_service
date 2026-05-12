const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const {
  getSlidesByLesson,
  getLessonRuntime,
  getCodeFillGapsBySlideId,
} = require('../controllers/lessonController');
const lessonEditor = require('../controllers/lessonEditorController');

// === Existing learner-facing reads (auth required) ===
router.get('/slides', authMiddleware, getSlidesByLesson);
router.get('/slides/:slideId/code-fill-gaps', authMiddleware, getCodeFillGapsBySlideId);

// === RN 학습자용: 레슨 runtime 데이터 (auth required, must come before /:id) ===
router.get('/runtime/:id', authMiddleware, getLessonRuntime);

// === Editor: 단일 사용자 운영 — 인증 없음. ===
// === Editor: characters catalog (must come before /:id) ===
router.get('/characters', lessonEditor.listCharacters);

// === Editor: code-fill-gaps (slide_id 기준 upsert) ===
router.get('/code-fill-gaps/:slideId', lessonEditor.getCodeFillGap);
router.put('/code-fill-gaps/:slideId', lessonEditor.upsertCodeFillGap);
router.delete('/code-fill-gaps/:slideId', lessonEditor.deleteCodeFillGap);

// === Editor: lessons CRUD ===
router.get('/', lessonEditor.listLessons);
router.post('/', lessonEditor.createLesson);
router.get('/:id', lessonEditor.getLesson);
router.put('/:id', lessonEditor.updateLessonMeta);
router.delete('/:id', lessonEditor.deleteLesson);

// === Editor: slides CRUD (specific paths first) ===
router.post('/:id/slides/reorder', lessonEditor.reorderSlides);
router.post('/:id/slides', lessonEditor.addSlide);
router.put('/:id/slides/:slideId', lessonEditor.updateSlideContents);
router.delete('/:id/slides/:slideId', lessonEditor.deleteSlide);

module.exports = router;
