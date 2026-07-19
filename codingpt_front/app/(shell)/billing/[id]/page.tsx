'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { clientFetch, formatKRW } from '@/lib/api';

interface Receipt {
  id: number; paymentId: string; kind: string; kindLabel: string; description: string | null;
  planName: string | null; amountKrw: number; refundedAmountKrw: number; status: string;
  source: string; channel: string | null; periodStart: string | null; periodEnd: string | null;
  paidAt: string | null; createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  paid: '결제 완료', ready: '대기', failed: '실패', cancelled: '취소', partial_cancelled: '부분 취소',
};
const SOURCE_LABEL: Record<string, string> = { portone: '카드(웹 결제)', revenuecat: '앱 스토어' };
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString('ko-KR') : '–');

// 단건 영수증.
export default function ReceiptPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id as string);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) { window.location.href = '/login?next=/billing'; return; }
      const res = await clientFetch<Receipt>(`/api/billing/payments/${id}`, { token });
      if (res.ok && res.data) setReceipt(res.data);
      else setError(res.message || '영수증을 불러올 수 없습니다.');
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '32px 24px 64px' }}>
      <a href="/billing" className="dim" style={{ fontSize: 13, textDecoration: 'none' }}>← 결제 내역</a>
      {error || !receipt ? (
        <p className="muted" style={{ fontSize: 14, marginTop: 20 }}>{error || '영수증이 없습니다.'}</p>
      ) : (
        <>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10 }}>영수증</h1>
          <div style={{ marginTop: 8, fontWeight: 800, fontSize: 30 }}>{formatKRW(receipt.amountKrw)}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {STATUS_LABEL[receipt.status] || receipt.status}
            {receipt.refundedAmountKrw > 0 ? ` · ${formatKRW(receipt.refundedAmountKrw)} 환불됨` : ''}
          </div>

          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)' }}>
            {[
              ['항목', receipt.kindLabel],
              ['플랜', receipt.planName || '–'],
              ['설명', receipt.description || '–'],
              ['결제 수단', SOURCE_LABEL[receipt.source] || receipt.source],
              ['이용 기간', receipt.periodStart ? `${fmt(receipt.periodStart)} ~ ${fmt(receipt.periodEnd)}` : '–'],
              ['결제 일시', fmt(receipt.paidAt || receipt.createdAt)],
              ['주문번호', receipt.paymentId],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="dim" style={{ fontSize: 13 }}>{k}</span>
                <span style={{ fontSize: 13.5, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
