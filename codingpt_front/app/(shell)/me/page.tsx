'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken, clearToken } from '@/lib/auth';
import { clientFetch, formatUnits, formatKRW } from '@/lib/api';
import CheckoutButtons from '@/components/CheckoutButtons';

interface UsageRow { id: number; metered_units: number; cost_usd: string; source: string; created_at: string }
interface PlanRow {
  code: string; name: string; price_krw: number;
  tagline?: string | null; features?: string[]; badge?: string | null; display_multiplier?: string | null;
}

// 사용량 진행 바 — 원시 unit 대신 % + 다음 충전 시간으로 가독화.
function UsageBar({ label, used, limit, resetAt }: { label: string; used: number; limit: number | null; resetAt?: string | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const over = pct != null && pct >= 100;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span className="dim" style={{ fontSize: 12.5 }}>{label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: over ? 'var(--danger, #F87171)' : 'var(--text2)' }}>{pct == null ? '무제한' : `${pct}%`}</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ width: pct == null ? '0%' : `${pct}%`, height: '100%', borderRadius: 999, background: over ? 'var(--danger, #F87171)' : 'var(--accent)', transition: 'width .3s' }} />
      </div>
      {resetAt ? <div className="dim" style={{ fontSize: 11.5, marginTop: 5 }}>다음 충전 {new Date(resetAt).toLocaleString('ko-KR')}</div> : null}
    </div>
  );
}

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

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px 64px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>내정보</h1>
        <button className="btn secondary" onClick={() => { clearToken(); window.location.href = '/'; }} style={{ padding: '8px 14px', fontSize: 13 }}>로그아웃</button>
      </div>

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
            <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>활성 구독이 없습니다(현재 Free — 채팅만 사용 가능). 워크스페이스 바이브코딩은 Pro부터예요.</p>
            <div style={{ display: 'grid', gap: 18 }}>
              {plans.filter((p) => p.price_krw > 0).map((p) => (
                <div key={p.code} style={{ borderTop: `2px solid ${p.badge ? 'var(--accent)' : 'var(--border)'}`, paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</span>
                      {p.display_multiplier ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-tint)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 999, padding: '2px 8px' }}>{p.display_multiplier}</span> : null}
                      {p.badge ? <span style={{ fontSize: 11, fontWeight: 700, color: '#0A0D14', background: 'var(--accent)', borderRadius: 999, padding: '2px 8px' }}>{p.badge}</span> : null}
                    </div>
                    <div className="dim" style={{ fontSize: 14, fontWeight: 600 }}>{formatKRW(p.price_krw)} / 월</div>
                  </div>
                  {p.tagline ? <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{p.tagline}</div> : null}
                  {p.features && p.features.length ? (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 7 }}>
                      {p.features.map((f) => (
                        <li key={f} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text2)' }}>
                          <span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span><span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div style={{ marginTop: 14 }}><CheckoutButtons code={p.code} label="구독하기" /></div>
                </div>
              ))}
            </div>
          </div>
        )}
        {msg ? <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>{msg}</p> : null}
      </section>

      {/* 사용량 */}
      <section style={sectionStyle}>
        <div className="dim" style={labelStyle}>사용량</div>
        {status ? (
          <>
            <UsageBar label="현재 구간 (5시간)" used={status.windowUsedUnits} limit={status.windowLimitUnits} resetAt={status.windowResetAt} />
            {status.weeklyLimitUnits != null ? (
              <UsageBar label="이번 주" used={status.weeklyUsedUnits} limit={status.weeklyLimitUnits} resetAt={status.weeklyResetAt} />
            ) : null}
            {status.enforced === false ? (
              <div className="dim" style={{ fontSize: 11.5, marginTop: 12 }}>* 현재는 사용량만 표시되며 한도 초과로 차단되지 않아요.</div>
            ) : null}
          </>
        ) : <div className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>사용량 정보를 불러올 수 없습니다.</div>}
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
