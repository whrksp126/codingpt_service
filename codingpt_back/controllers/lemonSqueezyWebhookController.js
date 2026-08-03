const { UserSubscription, SubscriptionPlan } = require('../models');
const lemonSqueezyService = require('../services/lemonSqueezyService');

const SUPPORTED_EVENTS = new Set([
  'subscription_created', 'subscription_updated', 'subscription_cancelled',
  'subscription_resumed', 'subscription_expired', 'subscription_paused',
  'subscription_unpaused', 'subscription_payment_failed',
  'subscription_payment_success', 'subscription_payment_recovered',
]);

function asDate(value) { return value ? new Date(value) : null; }

async function syncLemonSqueezyWebhook(req, res) {
  const raw = req.body;
  if (!lemonSqueezyService.verifyWebhook(raw, req.get('X-Signature'))) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'bad_json' }); }

  const event = body && body.meta && body.meta.event_name;
  if (!SUPPORTED_EVENTS.has(event)) return res.status(200).json({ ok: true, note: 'ignored' });

  const attrs = (body.data && body.data.attributes) || {};
  const paymentEvent = event.startsWith('subscription_payment_');
  const externalId = String(paymentEvent ? attrs.subscription_id : ((body.data && body.data.id) || ''));
  const existing = externalId
    ? await UserSubscription.findOne({ where: { source: 'lemonsqueezy', billing_key: externalId } })
    : null;
  if (!externalId || (!existing && !lemonSqueezyService.isSupporterVariant(attrs.variant_id))) {
    return res.status(200).json({ ok: true, note: 'unknown_subscription' });
  }

  const customUserId = Number(body.meta && body.meta.custom_data && body.meta.custom_data.user_id);
  const userId = existing ? existing.user_id : customUserId;
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'missing_user' });

  const plan = await SubscriptionPlan.findOne({ where: { code: 'supporter' } });
  if (!plan) return res.status(503).json({ error: 'supporter_plan_missing' });

  const lsStatus = String(attrs.status || '');
  let status = ['active', 'on_trial', 'cancelled'].includes(lsStatus) ? 'active' : 'past_due';
  if (lsStatus === 'expired') status = 'canceled';
  if (lsStatus === 'paused') status = 'paused';
  if (event === 'subscription_payment_failed') status = 'past_due';
  if (['subscription_payment_success', 'subscription_payment_recovered', 'subscription_resumed', 'subscription_unpaused'].includes(event)) status = 'active';

  const patch = {
    user_id: userId,
    plan_id: plan.id,
    status,
    source: 'lemonsqueezy',
    billing_key: externalId,
    card_brand: attrs.card_brand || (existing && existing.card_brand) || null,
    card_last4: attrs.card_last_four || (existing && existing.card_last4) || null,
    current_period_start: existing ? existing.current_period_start : new Date(),
    current_period_end: asDate(attrs.renews_at || attrs.ends_at) || (existing && existing.current_period_end),
    cancel_at_period_end: paymentEvent ? Boolean(existing && existing.cancel_at_period_end) : Boolean(attrs.cancelled) && status !== 'canceled',
    canceled_at: status === 'canceled' ? (asDate(attrs.ends_at) || new Date()) : null,
    past_due_since: status === 'past_due' ? ((existing && existing.past_due_since) || new Date()) : null,
    renewal_attempts: status === 'past_due' ? ((existing && existing.renewal_attempts) || 0) + 1 : 0,
    updated_at: new Date(),
  };

  if (existing) await existing.update(patch);
  else await UserSubscription.create({ ...patch, created_at: new Date() });

  console.log(JSON.stringify({ provider: 'lemonsqueezy', event, subscriptionId: externalId, userId, status }));
  return res.status(200).json({ ok: true });
}

async function handleLemonSqueezyWebhook(req, res) {
  try { return await syncLemonSqueezyWebhook(req, res); }
  catch (e) {
    console.error('[lemonsqueezy] 웹훅 처리 실패:', e && e.message);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }
}

module.exports = { handleLemonSqueezyWebhook };
