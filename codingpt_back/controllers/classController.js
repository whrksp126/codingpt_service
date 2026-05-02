const classService = require('../services/classService');
const { successResponse, errorResponse } = require('../utils/response');

// 모든 클래스 조회
const getAllClasses = async (req, res) => {
  try {
    const classes = await classService.getAllClasses();
    successResponse(res, classes, '클래스 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('클래스 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 특정 클래스 조회 (섹션 포함)
const getClassById = async (req, res) => {
  try {
    const { id } = req.params;
    const classData = await classService.getClassById(id);
    successResponse(res, classData, '클래스 정보를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('클래스 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 클래스별 제품 조회
const getClassProducts = async (req, res) => {
  try {
    const { id } = req.params;
    const products = await classService.getClassProducts(id);
    successResponse(res, products, '클래스의 제품 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('클래스 제품 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 클래스별 커리큘럼 조회
const getClassCurriculums = async (req, res) => {
  try {
    const { id } = req.params;
    const curriculums = await classService.getClassCurriculums(id);
    successResponse(res, curriculums, '클래스의 커리큘럼 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('클래스 커리큘럼 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 클래스 생성
const createClass = async (req, res) => {
  try {
    const classData = await classService.createClass(req.body);
    successResponse(res, classData, '클래스가 성공적으로 생성되었습니다.', 201);
  } catch (error) {
    console.error('클래스 생성 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 클래스 수정
const updateClass = async (req, res) => {
  try {
    const { id } = req.params;
    const classData = await classService.updateClass(id, req.body);
    successResponse(res, classData, '클래스 정보가 성공적으로 수정되었습니다.');
  } catch (error) {
    console.error('클래스 수정 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 클래스 삭제
const deleteClass = async (req, res) => {
  try {
    const { id } = req.params;
    await classService.deleteClass(id);
    successResponse(res, null, '클래스가 성공적으로 삭제되었습니다.');
  } catch (error) {
    console.error('클래스 삭제 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 클래스에 섹션 추가
const addSectionToClass = async (req, res) => {
  try {
    const { classId, sectionId } = req.params;
    await classService.addSectionToClass(classId, sectionId);
    successResponse(res, null, '섹션이 클래스에 성공적으로 추가되었습니다.');
  } catch (error) {
    console.error('섹션 추가 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 클래스에서 섹션 제거
const removeSectionFromClass = async (req, res) => {
  try {
    const { classId, sectionId } = req.params;
    await classService.removeSectionFromClass(classId, sectionId);
    successResponse(res, null, '섹션이 클래스에서 성공적으로 제거되었습니다.');
  } catch (error) {
    console.error('섹션 제거 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

module.exports = {
  getAllClasses,
  getClassById,
  getClassProducts,
  getClassCurriculums,
  createClass,
  updateClass,
  deleteClass,
  addSectionToClass,
  removeSectionFromClass
}; 