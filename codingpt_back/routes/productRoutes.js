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
router.post('/', createProduct);
router.get('/', getAllProducts);
router.get('/type/:type', getProductsByType);
router.get('/:id', getProductById);
router.get('/:id/classes', getProductClasses);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

module.exports = router;