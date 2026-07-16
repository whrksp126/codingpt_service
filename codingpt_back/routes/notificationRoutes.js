const express = require('express');
const router = express.Router();
const accountAuth = require('../middlewares/accountAuth');
const notificationController = require('../controllers/notificationController');

// 알림 동기화 — 모바일(JWT)/PC(deviceToken) 겸용 인증(accountAuth). 라이브 팬아웃은 notif_event(WSS/SSE).
router.post('/', accountAuth, notificationController.create); // 알림 발행
router.get('/', accountAuth, notificationController.list); // 목록(최신순) + unreadCount
router.post('/read', accountAuth, notificationController.markRead); // ids 또는 scope{cwd,win} 읽음 처리
router.post('/read-all', accountAuth, notificationController.markAllRead); // 전체 읽음 처리

module.exports = router;
