const express = require('express');
const router = express.Router();
const {
  getAllClasses,
  getClassById,
  getClassProducts,
  getClassCurriculums,
  createClass,
  updateClass,
  deleteClass,
  addSectionToClass,
  removeSectionFromClass
} = require('../controllers/classController');

// 클래스 관련 라우트
router.post('/', createClass);
router.get('/', getAllClasses);
router.get('/:id', getClassById);
router.get('/:id/products', getClassProducts);
router.get('/:id/curriculums', getClassCurriculums);
router.put('/:id', updateClass);
router.delete('/:id', deleteClass);
router.post('/:classId/sections/:sectionId', addSectionToClass);
router.delete('/:classId/sections/:sectionId', removeSectionFromClass);

module.exports = router;