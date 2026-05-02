const express = require('express');
const router = express.Router();
const executeController = require('../controllers/executeController');

/**
 * POST /api/execute
 * JavaScript 코드를 실행하고 SSE로 결과를 전송
 * 
 * Request Body:
 * {
 *   "code": "console.log('Hello, World!');"
 * }
 */
router.post('/', executeController.executeCode);

module.exports = router;

