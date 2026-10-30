const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const c = require('../controllers/externalController');

// 외부 연동 공개 API — 정본 문서 public-external/API.md. 키 관리는 /api/daemon/api-keys(사람 전용).
router.get('/docs', c.publicFile('docs'));
router.get('/skill', c.publicFile('skill'));
router.get('/sdk/codingpt.mjs', c.publicFile('sdk'));

const keyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'k' + req.apiKey.id,
  message: { success: false, message: '요청이 너무 많습니다.', detail: { code: 'RATE_LIMITED' } },
});
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

module.exports = router;
