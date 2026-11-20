const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const c = require('../controllers/externalController');

// 외부 연동 공개 API — 정본 문서 public-external/API.md. 키 관리는 /api/daemon/api-keys(사람 전용).
router.get('/docs', c.publicFile('docs'));
router.get('/skill', c.publicFile('skill'));
router.get('/docs/channels', c.publicFile('channels'));
router.get('/sdk/codingpt.mjs', c.publicFile('sdk'));

const keyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'k' + req.apiKey.id,
  message: { success: false, message: '요청이 너무 많습니다.', detail: { code: 'RATE_LIMITED' } },
});
// 알림 채널 웹훅 — 토큰이 URL 에 들어 있어 헤더 없이 어디서든 보낸다(curl·cron·다른 서버). 키 인증보다 먼저.
const ch = require('../controllers/channelController');
const hookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'h' + req.hookChannel.id,
  message: { success: false, message: '알림이 너무 많습니다. dedupeKey 로 묶어 보내세요.', detail: { code: 'RATE_LIMITED' } },
});
const hookBody = [express.text({ type: ['text/*'], limit: '64kb' })];
router.get('/hooks/:token', ch.hookInfo);
router.post('/hooks/:token', hookBody, ch.resolveHook, hookLimiter, ch.hookPost);

router.use(c.apiKeyAuth, keyLimiter);

router.get('/agents', c.caps);
router.get('/workspaces', c.workspaces);
router.post('/workspaces', c.workspaceCreate);
router.post('/sessions', c.createSession);
router.get('/sessions', c.listSessions);
router.get('/sessions/:id', c.getSession);
router.get('/sessions/:id/events', c.events);
router.patch('/sessions/:id', c.update);
router.delete('/sessions/:id', c.remove);
router.post('/sessions/:id/messages', c.send);
router.post('/sessions/:id/requests/:requestId', c.respond);
router.post('/sessions/:id/interrupt', c.interrupt);
router.post('/sessions/:id/stop', c.stop);
router.get('/channels', ch.keyList);
router.post('/channels', ch.keyEnsure);
router.post('/channels/:id/messages', ch.keySend);

module.exports = router;
