const express = require('express');
const router = express.Router();
const { 
    getAllCategoriesWithProducts
} = require('../controllers/storeController');

// 상점 관련 라우트
router.get('/', getAllCategoriesWithProducts); // 모든 상점 카테고리 & 상품 조회 (ALL)

module.exports = router; 