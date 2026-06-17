const crypto = require('crypto');
const { WebhookEvent } = require('../models');
const rcBillingService = require('../services/rcBillingService');

// POST /api/billing/rc/webhook — RevenueCat 웹훅. JSON body(express.json 이후 마운트).
// 인증: RC 대시보드에 설정한 Authorization 헤더를 RC_WEBHOOK_AUTH(env) 와 상수시간 비교.
// (PortOne 웹훅과 동일하게 authMiddleware 없음 — 시크릿 헤더만.)
const EXPECTED = process.env.RC_WEBHOOK_AUTH || '';

function authOk(req) {
  if (!EXPECTED) return false;
  const got = req.headers['authorization'] || req.headers['Authorization'] || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(EXPECTED);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

const handleRcWebhook = async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false });

  const body = req.body || {};
  const ev = body.event || {};

  let logRow = null;
  try {
    logRow = await WebhookEvent.create({
      provider: 'revenuecat', event_type: ev.type || null,
      payment_id: ev.transaction_id ? String(ev.transaction_id) : null,
      signature_valid: true, raw_body: JSON.stringify(body),
      processed: false, received_at: new Date(),
    });
  } catch (e) {
    console.error('[RC Webhook] 로그 적재 실패:', e.message);
  }

  // 빠른 ack 후 비동기 처리 (멱등 — transaction_id/플랜 기준).
  res.status(200).json({ ok: true });
  try {
    const result = await rcBillingService.handleEvent(ev);
    if (logRow) { logRow.processed = true; await logRow.save(); }
    console.log('[RC Webhook]', ev.type, JSON.stringify(result));
  } catch (e) {
    console.error(`[RC Webhook] 처리 실패 (type=${ev.type}):`, e.message);
  }
};

module.exports = { handleRcWebhook };
