'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken } from '@/lib/auth';
import { clientFetch, formatUnits, formatKRW } from '@/lib/api';
import CheckoutButtons from '@/components/CheckoutButtons';

interface UsageRow { id: number; metered_units: number; cost_usd: string; source: string; created_at: string }
interface PlanRow { code: string; name: string; price_krw: number }

// 내정보 — 구독 상태 + 사용량 + 사용 내역. 앱셸 콘텐츠(평탄 섹션, 카드 박스 없음).
export default function MyPage() {
  const [status, setStatus] = useState<any>(null);
  const [sub, setSub] = useState<any>(null);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
    const [st, sb, hist, pl] = await Promise.all([
      clientFetch('/api/usage/status', { token }),
      clientFetch('/api/subscription/me', { token }),
      clientFetch('/api/usage/history?limit=30', { token }),
      clientFetch('/api/subscription/plans', {}),
    ]);
    setStatus(st.data); setSub(sb.data);
    setRows(((hist.data as any)?.data ?? []) as UsageRow[]);
    setPlans(((pl.data as any) ?? []) as PlanRow[]);
    setLoading(false);
  };

  useEffect(() => { captureHandoff(); load(); }, []);

  const cancel = async () => {
    const token = getToken();
    if (!token) return;
    setMsg(null);
    const r = await clientFetch('/api/subscription/cancel', { method: 'POST', body: {}, token });
    if (r.ok) { setMsg('해지되었습니다. 다음 결제일부터 갱신이 중단됩니다.'); load(); }
    else setMsg(r.message || '해지에 실패했습니다.');
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  const pct = status && status.windowLimitUnits ? Math.min(100, Math.round((status.windowUsedUnits / status.windowLimitUnits) * 100)) : null;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px 64px' }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>내정보</h1>

      {/* 구독 */}
      <section style={sectionStyle}>
        <div className="dim" style={labelStyle}>구독 플랜</div>
        <div style={{ fontWeight: 800, fontSize: 24, margin: '6px 0' }}>
          {sub?.SubscriptionPlan?.name || (status?.plan === 'free' ? 'Free' : status?.plan || 'Free')}
        </div>
        {sub ? (
          <>
            <div className="muted" style={{ fontSize: 13.5 }}>
              상태: {sub.status}{sub.current_period_end ? ` · 다음 갱신 ${new Date(sub.current_period_end).toLocaleDateString('ko-KR')}` : ''}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
              <a href="/#plans" className="btn secondary" style={{ padding: '9px 16px', fontSize: 14 }}>플랜 변경</a>
              {!sub.cancel_at_period_end ? (
                <button className="btn secondary" onClick={cancel} style={{ padding: '9px 16px', fontSize: 14 }}>구독 해지</button>
              ) : <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>기간 말 해지 예약됨</span>}
            </div>
          </>
        ) : (
          <div style={{ marginTop: 8 }}>
            <p className="muted" style={{ fontSize: 13.5, marginBottom: 14 }}>활성 구독이 없습니다. 플랜을 선택해 구독하세요.</p>
            <div style={{ display: 'grid', gap: 10 }}>
              {plans.filter((p) => p.price_krw > 0).map((p) => (
                <div key={p.code} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{p.name}</div>
                    <div className="dim" style={{ fontSize: 13 }}>{formatKRW(p.price_krw)} / 월</div>
                  </div>
                  <div style={{ minWidth: 130 }}><CheckoutButtons code={p.code} label="구독하기" /></div>
                </div>
              ))}
            </div>
          </div>
        )}
        {msg ? <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>{msg}</p> : null}
      </section>

      {/* 사용량 */}
      <section style={sectionStyle}>
        <div className="dim" style={labelStyle}>현재 구간 사용량</div>
        <div className="price" style={{ marginTop: 6 }}>{pct == null ? '무제한' : `${pct}%`}</div>
        {status ? (
          <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
            {formatUnits(status.windowUsedUnits)} / {status.windowLimitUnits ? formatUnits(status.windowLimitUnits) : '무제한'}
            {status.windowResetAt ? ` · ${new Date(status.windowResetAt).toLocaleString('ko-KR')} 초기화` : ''}
          </div>
        ) : null}
      </section>

      {/* 사용 내역 */}
      <section style={sectionStyle}>
        <div className="dim" style={labelStyle}>사용 내역</div>
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>일시</th><th>사용량</th><th>원가(USD)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                <td>{formatUnits(Number(r.metered_units))}</td>
                <td className="muted">${Number(r.cost_usd).toFixed(4)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={3} className="muted">내역이 없습니다.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const sectionStyle: React.CSSProperties = { marginTop: 28, paddingTop: 24, borderTop: '1px solid var(--border)' };
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
