const express = require('express');
const router = express.Router();
const { 
  getAllProducts, 
  getProductById, 
  getProductClasses, 
  getProductsByType,
  createProduct,
  updateProduct,
  deleteProduct
} = require('../controllers/productController');

// 제품 관련 라우트
router.post('/', createProduct);                    // 제품 생성
router.get('/', getAllProducts);                    // 모든 제품 조회
router.get('/type/:type', getProductsByType);      // 타입별 제품 조회
router.get('/:id', getProductById);                // 특정 제품 조회 (리뷰 포함)
router.get('/:id/classes', getProductClasses);     // 제품별 클래스 조회
router.put('/:id', updateProduct);                 // 제품 수정
router.delete('/:id', deleteProduct);              // 제품 삭제

module.exports = router; 