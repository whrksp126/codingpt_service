'use client';

import { useEffect, useState } from 'react';
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
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ko-KR') : '–');

// 결제 내역(영수증) — 구독 결제·갱신·업그레이드·환불 기록.
export default function BillingPage() {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) { window.location.href = '/login?next=/billing'; return; }
      const res = await clientFetch('/api/billing/payments?limit=50', { token });
      setRows(((res.data as any)?.data ?? []) as Receipt[]);
      setLoading(false);
    })();
  }, []);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px 64px' }}>
      <a href="/me" className="dim" style={{ fontSize: 13, textDecoration: 'none' }}>← 내정보</a>
      <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 10 }}>결제 내역</h1>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>구독 결제·갱신·업그레이드·환불 영수증이에요.</p>

      <div style={{ marginTop: 22, display: 'grid', gap: 10 }}>
        {rows.map((r) => (
          <a key={r.id} href={`/billing/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700 }}>
                  {r.kindLabel}{r.planName ? ` · ${r.planName}` : ''}
                </div>
                <div className="dim" style={{ fontSize: 12, marginTop: 3 }}>
                  {fmt(r.paidAt || r.createdAt)}{r.periodStart ? ` · ${fmt(r.periodStart)}~${fmt(r.periodEnd)}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{formatKRW(r.amountKrw)}</div>
                <div className="dim" style={{ fontSize: 11.5, marginTop: 2, color: r.status === 'paid' ? 'var(--accent)' : 'var(--dim)' }}>
                  {STATUS_LABEL[r.status] || r.status}{r.refundedAmountKrw > 0 ? ` · ${formatKRW(r.refundedAmountKrw)} 환불` : ''}
                </div>
              </div>
            </div>
          </a>
        ))}
        {rows.length === 0 ? <p className="muted" style={{ fontSize: 13.5 }}>결제 내역이 없습니다.</p> : null}
      </div>
    </div>
  );
}
