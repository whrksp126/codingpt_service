const crypto = require('crypto');
const BILLING = require('../config/billing');

const API_BASE = 'https://api.lemonsqueezy.com/v1';

function assertConfigured() {
  if (!BILLING.LEMON_SQUEEZY_API_KEY || !BILLING.LEMON_SQUEEZY_STORE_ID || !BILLING.LEMON_SQUEEZY_SUPPORTER_VARIANT_ID) {
    const e = new Error('Supporter 결제를 준비하고 있어요.');
    e.code = 'billing_not_configured';
    throw e;
  }
}

async function api(path, options = {}) {
  assertConfigured();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${BILLING.LEMON_SQUEEZY_API_KEY}`,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('[lemonsqueezy] API 오류', response.status, body && body.errors ? body.errors.map((x) => x.title).join(', ') : 'unknown');
    const e = new Error('결제 페이지를 열지 못했어요. 잠시 후 다시 시도해 주세요.');
    e.statusCode = 502;
    throw e;
  }
  return body;
}

async function createSupporterCheckout({ userId, email, name }) {
  const body = await api('/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: email || undefined,
            name: name || undefined,
            custom: { user_id: String(userId), plan_code: 'supporter' },
          },
          product_options: {
            redirect_url: `${BILLING.PAYMENT_WEB_URL}/?support=success#pricing`,
          },
        },
        relationships: {
          store: { data: { type: 'stores', id: String(BILLING.LEMON_SQUEEZY_STORE_ID) } },
          variant: { data: { type: 'variants', id: String(BILLING.LEMON_SQUEEZY_SUPPORTER_VARIANT_ID) } },
        },
      },
    }),
  });
  return body && body.data && body.data.attributes && body.data.attributes.url;
}

async function getCustomerPortalUrl(subscriptionId) {
  const body = await api(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return body && body.data && body.data.attributes && body.data.attributes.urls
    ? body.data.attributes.urls.customer_portal
    : null;
}

function verifyWebhook(rawBody, signature) {
  const secret = BILLING.LEMON_SQUEEZY_WEBHOOK_SECRET;
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isSupporterVariant(variantId) {
  return String(variantId || '') === String(BILLING.LEMON_SQUEEZY_SUPPORTER_VARIANT_ID || '');
}

module.exports = { createSupporterCheckout, getCustomerPortalUrl, verifyWebhook, isSupporterVariant };
