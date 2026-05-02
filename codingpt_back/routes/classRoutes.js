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
router.post('/', createClass);                     // 클래스 생성
router.get('/', getAllClasses);                    // 모든 클래스 조회
router.get('/:id', getClassById);                 // 특정 클래스 조회 (섹션 포함)
router.get('/:id/products', getClassProducts);    // 클래스별 제품 조회
router.get('/:id/curriculums', getClassCurriculums); // 클래스별 커리큘럼 조회
router.put('/:id', updateClass);                  // 클래스 수정
router.delete('/:id', deleteClass);               // 클래스 삭제
router.post('/:classId/sections/:sectionId', addSectionToClass);     // 클래스에 섹션 추가
router.delete('/:classId/sections/:sectionId', removeSectionFromClass); // 클래스에서 섹션 제거

module.exports = router; 