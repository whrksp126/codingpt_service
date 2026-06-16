const crypto = require('crypto');

// PortOne V2 클라이언트 (raw fetch). SkySwarm 동일 패턴 + 채널 2개(충전/구독) 분리.
// 환경변수:
//   PORTONE_API_BASE          (기본 https://api.portone.io)
//   PORTONE_API_SECRET        서버 시크릿 (검증/취소/빌링키 청구) — 백엔드만 보유
//   PORTONE_STORE_ID          상점 ID (publishable)
//   PORTONE_CHANNEL_KEY_CHARGE   충전용 KG이니시스 신용카드 일시불 채널(환금성)
//   PORTONE_CHANNEL_KEY_BILLING  구독용 빌링키(정기결제 특약) 채널
//   PORTONE_WEBHOOK_SECRET    웹훅 서명 시크릿 (Standard Webhooks, 'whsec_...')

const API_BASE = process.env.PORTONE_API_BASE || 'https://api.portone.io';
const API_SECRET = process.env.PORTONE_API_SECRET || '';
const STORE_ID = process.env.PORTONE_STORE_ID || '';
const CHANNEL_CHARGE = process.env.PORTONE_CHANNEL_KEY_CHARGE || '';
const CHANNEL_BILLING = process.env.PORTONE_CHANNEL_KEY_BILLING || '';
const WEBHOOK_SECRET = process.env.PORTONE_WEBHOOK_SECRET || '';

function authHeader() {
  return { Authorization: `PortOne ${API_SECRET}`, 'Content-Type': 'application/json' };
}

async function call(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeader(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`PortOne ${method} ${path} 실패 (${res.status}): ${json.message || text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

class PortoneService {
  isEnabled() {
    return !!API_SECRET;
  }

  getStoreId() { return STORE_ID; }

  getChannelKey(type) {
    return type === 'subscription' || type === 'inicis_billing' ? CHANNEL_BILLING : CHANNEL_CHARGE;
  }

  // 결제 단건 조회 (서버 검증의 정본). status, amount.total, customData 등 포함.
  async getPayment(paymentId) {
    return call('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  // 결제 취소(환불). amount 미지정 시 전액 취소.
  async cancelPayment(paymentId, { amountKrw = null, reason = '사용자 결제 취소' } = {}) {
    const body = { reason };
    if (amountKrw != null) body.amount = amountKrw;
    return call('POST', `/payments/${encodeURIComponent(paymentId)}/cancel`, body);
  }

  // 빌링키 즉시 결제 (구독 갱신). PortOne V2: POST /payments/{paymentId}/billing-key
  async payWithBillingKey({ paymentId, billingKey, orderName, amountKrw, customData = {} }) {
    return call('POST', `/payments/${encodeURIComponent(paymentId)}/billing-key`, {
      billingKey,
      orderName,
      channelKey: CHANNEL_BILLING || undefined,
      amount: { total: amountKrw },
      currency: 'KRW',
      customData: typeof customData === 'string' ? customData : JSON.stringify(customData),
    });
  }

  /**
   * 웹훅 서명 검증 (Standard Webhooks). 실패해도 호출부는 항상 getPayment 재조회로 정본 확인(방어).
   * headers: webhook-id, webhook-timestamp, webhook-signature
   */
  verifyWebhook(rawBody, headers = {}) {
    try {
      if (!WEBHOOK_SECRET) return { valid: false, reason: 'no_secret' };
      const id = headers['webhook-id'] || headers['Webhook-Id'];
      const ts = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
      const sigHeader = headers['webhook-signature'] || headers['Webhook-Signature'];
      if (!id || !ts || !sigHeader) return { valid: false, reason: 'missing_headers' };

      const secretB64 = WEBHOOK_SECRET.startsWith('whsec_') ? WEBHOOK_SECRET.slice(6) : WEBHOOK_SECRET;
      const secretBytes = Buffer.from(secretB64, 'base64');
      const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
      const signedContent = `${id}.${ts}.${payload}`;
      const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

      const provided = String(sigHeader)
        .split(' ')
        .map((p) => (p.includes(',') ? p.split(',')[1] : p));
      const valid = provided.some((p) => {
        try {
          return p && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected));
        } catch (_) { return false; }
      });
      return { valid };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  }
}

module.exports = new PortoneService();
