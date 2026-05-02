const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const { 
    getMyHearts,
    spendOneHeart,
} = require('../controllers/heartController');

// 하트 관련 라우트
router.get('', authMiddleware, getMyHearts);
router.post('/spend', authMiddleware, spendOneHeart);

module.exports = router;