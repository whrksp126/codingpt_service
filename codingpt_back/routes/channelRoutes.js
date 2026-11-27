const express = require('express');
const router = express.Router();
const accountAuth = require('../middlewares/accountAuth');
const c = require('../controllers/channelController');

// 알림 채널 — 앱(JWT)·PC(deviceToken) 겸용. 외부 서비스용 입구는 /api/v1/hooks/:token · /api/v1/channels(externalRoutes).
router.use(accountAuth);
router.get('/', c.list);
router.get('/templates', c.botTemplates);   // 봇 템플릿 + 공식 MCP 카탈로그(/:id 보다 먼저)
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
// 봇 — 할 일 · 자동화
router.get('/:id/items', c.items);
router.post('/:id/items/:n/answer', c.itemAnswer);
router.get('/:id/automations', c.automations);
router.post('/:id/automations', c.automationCreate);
router.patch('/:id/automations/:aid', c.automationUpdate);
router.delete('/:id/automations/:aid', c.automationRemove);
router.post('/:id/automations/:aid/run', c.automationRun);

module.exports = router;
