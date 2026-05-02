const productService = require('../services/productService');
const { successResponse, errorResponse } = require('../utils/response');

// 모든 제품 조회
const getAllProducts = async (req, res) => {
  try {
    const products = await productService.getAllProducts();
    successResponse(res, products, '제품 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('제품 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 특정 제품 조회 (리뷰 포함)
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await productService.getProductById(id);
    successResponse(res, product, '제품 정보를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('제품 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 제품별 클래스 조회
const getProductClasses = async (req, res) => {
  try {
    const { id } = req.params;
    const classes = await productService.getProductClasses(id);
    successResponse(res, classes, '제품의 클래스 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('제품 클래스 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 제품 타입별 조회
const getProductsByType = async (req, res) => {
  try {
    const { type } = req.params;
    const products = await productService.getProductsByType(type);
    successResponse(res, products, `${type} 타입의 제품 목록을 성공적으로 조회했습니다.`);
  } catch (error) {
    console.error('제품 타입별 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 제품 생성
const createProduct = async (req, res) => {
  try {
    const product = await productService.createProduct(req.body);
    successResponse(res, product, '제품이 성공적으로 생성되었습니다.', 201);
  } catch (error) {
    console.error('제품 생성 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 제품 수정
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await productService.updateProduct(id, req.body);
    successResponse(res, product, '제품 정보가 성공적으로 수정되었습니다.');
  } catch (error) {
    console.error('제품 수정 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 제품 삭제
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    await productService.deleteProduct(id);
    successResponse(res, null, '제품이 성공적으로 삭제되었습니다.');
  } catch (error) {
    console.error('제품 삭제 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

module.exports = {
  getAllProducts,
  getProductById,
  getProductClasses,
  getProductsByType,
  createProduct,
  updateProduct,
  deleteProduct
}; 