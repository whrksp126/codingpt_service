'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken, clearToken } from '@/lib/auth';
import { clientFetch, formatUnits } from '@/lib/api';

interface UsageRow { id: number; metered_units: number; cost_usd: string; source: string; created_at: string }

// 마이페이지 — 구독 상태 + 사용량 + 사용 내역(로그인 후 진입).
export default function MyPage() {
  const [status, setStatus] = useState<any>(null);
  const [sub, setSub] = useState<any>(null);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
    const [st, sb, hist] = await Promise.all([
      clientFetch('/api/usage/status', { token }),
      clientFetch('/api/subscription/me', { token }),
      clientFetch('/api/usage/history?limit=30', { token }),
    ]);
    setStatus(st.data); setSub(sb.data);
    setRows(((hist.data as any)?.data ?? []) as UsageRow[]);
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

  const logout = () => { clearToken(); window.location.href = '/'; };

  if (loading) return <p className="muted">불러오는 중…</p>;

  const pct = status && status.windowLimitUnits ? Math.min(100, Math.round((status.windowUsedUnits / status.windowLimitUnits) * 100)) : null;

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1>마이페이지</h1>
        <button className="btn secondary" onClick={logout} style={{ padding: '8px 14px', fontSize: 13 }}>로그아웃</button>
      </div>

      {/* 구독 */}
      <section className="card">
        <div className="dim" style={{ fontSize: 13 }}>구독 플랜</div>
        <div style={{ fontWeight: 800, fontSize: 22, margin: '4px 0' }}>
          {sub?.SubscriptionPlan?.name || (status?.plan === 'free' ? 'Free' : status?.plan || 'Free')}
        </div>
        {sub ? (
          <>
            <div className="muted" style={{ fontSize: 13 }}>
              상태: {sub.status}{sub.current_period_end ? ` · 다음 갱신 ${new Date(sub.current_period_end).toLocaleDateString('ko-KR')}` : ''}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
              <a href="/#plans" className="btn" style={{ padding: '10px 16px', fontSize: 14 }}>플랜 변경</a>
              {!sub.cancel_at_period_end ? (
                <button className="btn secondary" onClick={cancel} style={{ padding: '10px 16px', fontSize: 14 }}>구독 해지</button>
              ) : <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>기간 말 해지 예약됨</span>}
            </div>
          </>
        ) : (
          <div style={{ marginTop: 8 }}>
            <p className="muted" style={{ fontSize: 13 }}>활성 구독이 없습니다.</p>
            <a href="/#plans" className="btn" style={{ marginTop: 8, padding: '10px 16px', fontSize: 14 }}>구독 시작</a>
          </div>
        )}
        {msg ? <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>{msg}</p> : null}
      </section>

      {/* 사용량 */}
      <section className="card">
        <div className="dim" style={{ fontSize: 13 }}>현재 구간 사용량</div>
        <div className="price">{pct == null ? '무제한' : `${pct}%`}</div>
        {status ? (
          <div className="muted" style={{ fontSize: 13 }}>
            {formatUnits(status.windowUsedUnits)} / {status.windowLimitUnits ? formatUnits(status.windowLimitUnits) : '무제한'}
            {status.windowResetAt ? ` · ${new Date(status.windowResetAt).toLocaleString('ko-KR')} 초기화` : ''}
          </div>
        ) : null}
      </section>

      {/* 사용 내역 */}
      <section>
        <h2 style={{ fontSize: 18 }}>사용 내역</h2>
        <table>
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
