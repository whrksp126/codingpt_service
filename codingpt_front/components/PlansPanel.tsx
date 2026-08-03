'use client';

import { useEffect, useState } from 'react';
import { getToken } from '@/lib/auth';
import { clientFetch, formatKRW } from '@/lib/api';
import { changePlan } from '@/lib/portone';
import CheckoutButtons from '@/components/CheckoutButtons';
import Toast from '@/components/Toast';

interface PlanRow {
  code: string; name: string; price_krw: number; sort_order?: number;
  tagline?: string | null; features?: string[]; badge?: string | null; display_multiplier?: string | null;
}
interface SubInfo {
  status: string; planCode: string | null; source: string; currentPeriodEnd: string | null;
  scheduledPlan: { code: string; name: string } | null; manageInStore: boolean; manageInPortal?: boolean;
}
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ko-KR') : null);

// 신규 구독 판매 on/off (M0 BYO 피벗). 'false' 면 비구독자 '구독하기' CTA 를 감춘다.
// 기존 구독자의 업그레이드/다운그레이드/해지는 그대로 노출된다.
const SALES_OPEN = process.env.NEXT_PUBLIC_SUBSCRIPTION_SALES_ENABLED === 'true';

// 구독 플랜 선택/변경 본문 (페이지 헤더 없음). /plans 페이지 + /me 의 '플랜' 패널이 공유.
// onAfterChange: 변경 성공 시 부모가 자기 데이터를 다시 불러올 수 있게 알림.
export default function PlansPanel({ onAfterChange }: { onAfterChange?: () => void }) {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [current, setCurrent] = useState<string>('free');
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<{ plan: PlanRow; isUpgrade: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [modalErr, setModalErr] = useState<string | null>(null);

  const load = async () => {
    const token = getToken();
    const [pl, st, sb] = await Promise.all([
      clientFetch('/api/subscription/plans', {}),
      token ? clientFetch('/api/usage/status', { token }) : Promise.resolve({ data: null } as any),
      token ? clientFetch('/api/subscription/me', { token }) : Promise.resolve({ data: null } as any),
    ]);
    setPlans(((pl.data as any) ?? []) as PlanRow[]);
    const s = (sb.data as SubInfo) || null;
    setSub(s);
    setCurrent((s?.planCode as string) || ((st.data as any)?.plan as string) || 'free');
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);

  const doChange = async () => {
    if (!confirm) return;
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
    setBusy(true); setMsg(null); setModalErr(null);
    const r = await changePlan(confirm.plan.code, token);
    setBusy(false);
    if (r.ok) {
      const planName = confirm.plan.name;
      setConfirm(null);
      if (r.data?.effect === 'upgraded') setMsg(`${planName} 플랜으로 업그레이드됐어요.`);
      else if (r.data?.effect === 'downgrade_scheduled') setMsg(`${fmtDate(r.data.effectiveAt)}부터 ${planName} 플랜으로 변경 예정이에요.`);
      load(); onAfterChange?.();
    } else { setModalErr(r.message || '플랜 변경에 실패했습니다.'); }
  };

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  const paid = plans.filter((p) => p.price_krw > 0).sort((a, b) => (a.sort_order || a.price_krw || 0) - (b.sort_order || b.price_krw || 0));
  const isPaidNow = current === 'supporter' || current === 'pro' || current === 'max';
  const isStore = !!sub?.manageInStore;
  const isPortalManaged = !!sub?.manageInPortal;
  const currentPrice = plans.find((p) => p.code === current)?.price_krw ?? 0;

  return (
    <div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 14, padding: '18px', background: !isPaidNow ? 'var(--accent-tint)' : 'transparent' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Personal</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 5 }}>내 PC의 AI 코딩을 어디서나 그대로. 개인 사용은 무료예요.</div>
          </div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>무료</div>
        </div>
      </div>
      {isStore ? <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>스토어(App Store / Google Play)에서 구독한 플랜이에요. 변경은 앱의 구독 관리에서 진행해 주세요.</p> : null}

      <div style={{ display: 'grid', gap: 16, marginTop: 18 }}>
        {paid.map((p) => {
          const isCurrent = p.code === current;
          const isScheduled = sub?.scheduledPlan?.code === p.code;
          const isUpgrade = isPaidNow ? p.price_krw > currentPrice : true;
          const label = isPaidNow ? '플랜 변경' : 'Supporter 시작하기';
          return (
            <div key={p.code} style={{ border: `1px solid ${isCurrent ? 'var(--border-control)' : 'var(--border)'}`, borderRadius: 14, padding: '18px 18px 20px', background: isCurrent ? 'var(--accent-tint)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 18 }}>{p.name}</span>
                  {isScheduled ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', background: 'var(--accent-tint)', border: '1px solid var(--border-control)', borderRadius: 999, padding: '2px 8px' }}>변경 예정</span>
                  ) : !isCurrent && p.badge ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', background: 'var(--accent-tint)', border: '1px solid var(--border-control)', borderRadius: 999, padding: '2px 8px' }}>{p.badge}</span>
                  ) : null}
                  {p.display_multiplier ? <span className="dim" style={{ fontSize: 12 }}>{p.display_multiplier}</span> : null}
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{formatKRW(p.price_krw)}<span className="dim" style={{ fontSize: 13, fontWeight: 500 }}> / 월</span></div>
              </div>
              {p.tagline ? <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{p.tagline}</div> : null}
              {p.features && p.features.length ? (
                <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 7 }}>
                  {p.features.map((f) => (
                    <li key={f} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--text2)' }}><span style={{ color: 'var(--dim)', fontWeight: 800 }}>✓</span><span>{f}</span></li>
                  ))}
                </ul>
              ) : null}
              <div style={{ marginTop: 16 }}>
                {isCurrent ? (
                  isPortalManaged ? (
                    <button className="btn secondary" onClick={async () => {
                      const token = getToken(); if (!token) return;
                      const r = await clientFetch<{ url: string }>('/api/billing/lemonsqueezy/portal', { token });
                      if (r.ok && r.data?.url) window.location.href = r.data.url;
                      else setMsg(r.message || '구독 관리 페이지를 열지 못했어요.');
                    }} style={{ width: '100%' }}>결제·구독 관리</button>
                  ) : <button className="btn secondary" disabled style={{ width: '100%', opacity: 0.6, cursor: 'default' }}>현재 이용 중</button>
                ) : isStore ? (
                  <button className="btn secondary" disabled style={{ width: '100%', opacity: 0.5 }}>앱에서 변경</button>
                ) : isPaidNow ? (
                  <button className="btn" onClick={() => setConfirm({ plan: p, isUpgrade })} style={{ width: '100%' }}>{label}</button>
                ) : SALES_OPEN ? (
                  <CheckoutButtons code={p.code} label={label} />
                ) : (
                  <button className="btn secondary" disabled style={{ width: '100%', opacity: 0.6, cursor: 'default' }}>Supporter 준비 중</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="muted" style={{ fontSize: 12.5, marginTop: 22, lineHeight: 1.6 }}>
        Supporter는 선택형 월 후원 구독이며 언제든 해지할 수 있어요. Personal의 핵심 기능은 구독 여부와 관계없이 무료입니다. 환불은 <a href="/legal/refund">환불·취소 정책</a>을 따릅니다.
      </p>

      {confirm ? (
        <div onClick={() => { if (!busy) { setConfirm(null); setModalErr(null); } }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, background: 'var(--elevated, #1B1F2A)', border: '1px solid var(--border)', borderRadius: 16, padding: '24px 22px 20px' }}>
            <h2 style={{ fontSize: 18, fontWeight: 800 }}>{confirm.plan.name}{confirm.isUpgrade ? '로 업그레이드' : '로 다운그레이드'}</h2>
            <p className="muted" style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.6 }}>
              {confirm.isUpgrade ? (
                <>지금 즉시 적용되고, 남은 기간만큼 <b style={{ color: 'var(--text)' }}>차액이 비례정산으로 청구</b>돼요. 다음 갱신부터는 {formatKRW(confirm.plan.price_krw)}/월이 청구됩니다.</>
              ) : (
                <><b style={{ color: 'var(--text)' }}>{fmtDate(sub?.currentPeriodEnd) || '다음 갱신일'}부터</b> {confirm.plan.name} 플랜으로 변경돼요. 그때까지 현재 혜택은 그대로 유지되고, 지금 추가 청구는 없어요.</>
              )}
            </p>
            {modalErr ? <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--danger, #F87171)', background: 'rgba(248,113,113,0.08)', fontSize: 12.5, color: 'var(--danger, #F87171)', lineHeight: 1.5 }}>{modalErr}</div> : null}
            <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
              <button className="btn secondary" onClick={() => { setConfirm(null); setModalErr(null); }} disabled={busy} style={{ flex: 1, padding: '11px 16px', fontSize: 14 }}>취소</button>
              <button className="btn" onClick={doChange} disabled={busy} style={{ flex: 1, padding: '11px 16px', fontSize: 14 }}>{busy ? '처리 중…' : confirm.isUpgrade ? '업그레이드' : '다운그레이드'}</button>
            </div>
          </div>
        </div>
      ) : null}
      <Toast message={msg} />
    </div>
  );
}
