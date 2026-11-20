const express = require('express');
const router = express.Router();
const accountAuth = require('../middlewares/accountAuth');
const c = require('../controllers/channelController');

// 알림 채널 — 앱(JWT)·PC(deviceToken) 겸용. 외부 서비스용 입구는 /api/v1/hooks/:token · /api/v1/channels(externalRoutes).
router.use(accountAuth);
router.get('/', c.list);
router.post('/', c.create);
router.get('/:id', c.get);
router.patch('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/token', c.rotate);
router.post('/:id/read', c.read);
router.post('/:id/test', c.test);
router.get('/:id/messages', c.messages);
router.post('/:id/messages', c.send);
router.post('/:id/conversation', c.newConversation);
router.post('/:id/requests/:requestId', c.respond);
router.post('/:id/interrupt', c.interrupt);

module.exports = router;
