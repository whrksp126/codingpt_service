const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/githubRepoController');

// 레포 정의 관리 (관리자 전용, /api/admin/github-repos). 본인 전용 서비스라 별도 인증 없음.
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
