const { WebhookEvent } = require('../models');
const portoneService = require('../services/portoneService');
const billingService = require('../services/billingService');

// POST /api/billing/webhook — PortOne 웹훅 수신. raw body 필요(서명 검증).
// app.js 에서 express.json() 앞에 express.raw() 로 마운트된다. authMiddleware 없음.
const handlePortoneWebhook = async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  let parsed = {};
  try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch (_) { /* noop */ }

  const sig = portoneService.verifyWebhook(rawBody, req.headers);
  const paymentId = (parsed.data && parsed.data.paymentId) || parsed.paymentId || null;
  const eventType = parsed.type || null;

  // 원본 기록 + 빠른 ack
  let logRow = null;
  try {
    logRow = await WebhookEvent.create({
      provider: 'portone', event_type: eventType, payment_id: paymentId,
      signature_valid: !!sig.valid, raw_body: rawBody.toString('utf8'),
      processed: false, received_at: new Date(),
    });
  } catch (e) {
    console.error('[Webhook] 로그 적재 실패:', e.message);
  }
  res.status(200).json({ ok: true });

  // 비동기 재조정 — body 불신, 항상 getPayment 재조회로 정본 확인. paymentId 멱등.
  if (!paymentId) return;
  try {
    await billingService.verifyAndApplyPayment(paymentId);
    if (logRow) { logRow.processed = true; await logRow.save(); }
  } catch (e) {
    console.error(`[Webhook] 재조정 실패 (paymentId=${paymentId}):`, e.message);
  }
};

module.exports = { handlePortoneWebhook };
