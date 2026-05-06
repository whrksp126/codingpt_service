const express = require('express');
const router = express.Router();
const {
    getAllCategoriesWithProducts
} = require('../controllers/storeController');

// 상점 관련 라우트
router.get('/', getAllCategoriesWithProducts);

module.exports = router;