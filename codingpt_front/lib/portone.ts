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

  // 정기결제: 빌링키 발급. (서버가 빌링키로 첫 청구 + 구독 활성화)
  const PortOne = await import('@portone/browser-sdk/v2');
  const res = await PortOne.requestIssueBillingKey({
    storeId: STORE_ID || c.storeId || '',
    channelKey: CH_BILLING || c.channelKey || '',
    billingKeyMethod: 'CARD',
    issueId: c.paymentId,
    issueName: c.orderName,
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
