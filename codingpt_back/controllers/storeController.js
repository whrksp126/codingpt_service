const storeService = require('../services/storeService');
const { successResponse, errorResponse } = require('../utils/response');

// 모든 상품카테고리 & 상품 관련 데이터 조회
const getAllCategoriesWithProducts = async (req, res) => {
  try {
    const data = await storeService.getAllProducts();
    successResponse(res, data, '상점 데이터를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('상점 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

module.exports = {
  getAllCategoriesWithProducts
}; 