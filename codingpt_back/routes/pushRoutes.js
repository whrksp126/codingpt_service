const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const pushController = require('../controllers/pushController');

// 푸시 기기 등록/해제(M3-3). 발송은 서버가 done/승인대기/크래시 트리거로 수행.
router.post('/register', authMiddleware, pushController.register);
router.post('/unregister', authMiddleware, pushController.unregister);

module.exports = router;
