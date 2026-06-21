'use client';

import { clientFetch } from './api';

// @portone/browser-sdk 는 모듈 로드 시 window 에 접근 → SSR/SSG(서버에서 클라 컴포넌트 렌더) 중
// 최상단 import 하면 크래시(랜딩 `/` 가 notFound 로 빌드되던 근본 원인). 결제 클릭 시점에만 동적 import.

// PortOne V2 결제 흐름 (클라이언트). 월 구독=빌링키(정기 특약) 발급.
// 금액·상품은 항상 서버 /api/billing/checkout 가 권위. 여기선 그 값으로 결제창만 띄운다.

const STORE_ID = process.env.NEXT_PUBLIC_PORTONE_STORE_ID || '';
const CH_BILLING = process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY_BILLING || '';

interface CheckoutIntent {
  paymentId: string; amountKrw: number; orderName: string;
  storeId?: string; channelKey?: string; customData: Record<string, unknown>;
}

// 구독 — 빌링키 발급 후 서버가 첫 청구/활성화.
export async function paySubscription(planCode: string, token: string): Promise<{ ok: boolean; message?: string }> {
  const intent = await clientFetch<CheckoutIntent>('/api/billing/checkout', {
    method: 'POST', body: { type: 'subscription', code: planCode }, token,
  });
  if (!intent.ok || !intent.data) return { ok: false, message: intent.message || '결제 준비 실패' };
  const c = intent.data;

  // INICIS V2 빌링키 발급은 고객 정보가 필요(PC: email·phoneNumber 필수, fullName 필수). 프로필에서 채운다.
  const me = await clientFetch<any>('/api/users/me', { token });
  const u = me.data || {};
  const customer = {
    fullName: u.nickname || u.name || u.username || '구독자',
    email: u.email || undefined,
    phoneNumber: u.phone || u.phone_number || u.phoneNumber || '01012345678',
  };

  // 정기결제: 빌링키 발급. (서버가 빌링키로 첫 청구 + 구독 활성화)
  const PortOne = await import('@portone/browser-sdk/v2');
  const res = await PortOne.requestIssueBillingKey({
    storeId: STORE_ID || c.storeId || '',
    channelKey: CH_BILLING || c.channelKey || '',
    billingKeyMethod: 'CARD',
    issueId: c.paymentId,
    issueName: c.orderName,
    customer,
    customData: c.customData,
  });
  if (res?.code) return { ok: false, message: res.message || '빌링키 발급이 취소되었습니다.' };

  // 빌링키 발급 성공 → 서버가 첫 달 청구 + 구독 활성화
  const apply = await clientFetch('/api/billing/subscribe', {
    method: 'POST', body: { paymentId: c.paymentId, billingKey: (res as any)?.billingKey }, token,
  });
  if (!apply.ok) return { ok: false, message: apply.message || '구독 활성화 실패' };
  return { ok: true };
}

export interface ChangeResult {
  effect: 'upgraded' | 'downgrade_scheduled' | 'schedule_cleared';
  planCode: string; currentPeriodEnd?: string | null; scheduledPlanCode?: string | null;
  effectiveAt?: string | null; payment?: { paymentId: string; amountKrw: number; kind: string } | null;
}

// 플랜 변경 — 업=즉시 비례정산(서버가 보관된 빌링키로 차액 청구), 다운=기간말 예약. PortOne SDK 불필요.
export async function changePlan(planCode: string, token: string): Promise<{ ok: boolean; message?: string; data?: ChangeResult }> {
  const r = await clientFetch<ChangeResult>('/api/subscription/change', {
    method: 'POST', body: { code: planCode }, token,
  });
  if (!r.ok) return { ok: false, message: r.message || '플랜 변경 실패' };
  return { ok: true, data: r.data || undefined };
}

// 결제수단(카드) 변경 — 새 빌링키만 발급(청구 없음) → 서버에 교체. 연체 시 즉시 재시도.
export async function updatePaymentMethod(token: string): Promise<{ ok: boolean; message?: string; recovered?: boolean }> {
  const me = await clientFetch<any>('/api/users/me', { token });
  const u = me.data || {};
  const customer = {
    fullName: u.nickname || u.name || u.username || '구독자',
    email: u.email || undefined,
    phoneNumber: u.phone || u.phone_number || u.phoneNumber || '01012345678',
  };
  // storeId/channelKey 는 NEXT_PUBLIC 우선, 비면 백엔드 config 폴백(paySubscription 과 동일 패턴).
  let storeId = STORE_ID, channelKey = CH_BILLING;
  if (!storeId || !channelKey) {
    const cfg = await clientFetch<{ storeId: string; channelKey: string }>('/api/billing/portone-config', { token });
    storeId = storeId || cfg.data?.storeId || '';
    channelKey = channelKey || cfg.data?.channelKey || '';
  }
  const issueId = `pm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const PortOne = await import('@portone/browser-sdk/v2');
  const res = await PortOne.requestIssueBillingKey({
    storeId, channelKey,
    billingKeyMethod: 'CARD', issueId, issueName: '결제 수단 변경', customer,
  });
  if (res?.code) return { ok: false, message: res.message || '결제 수단 변경이 취소되었습니다.' };
  const apply = await clientFetch<{ updated: boolean; recovered: boolean }>('/api/billing/payment-method', {
    method: 'POST', body: { billingKey: (res as any)?.billingKey, retryNow: true }, token,
  });
  if (!apply.ok) return { ok: false, message: apply.message || '결제 수단 변경 실패' };
  return { ok: true, recovered: !!apply.data?.recovered };
}
