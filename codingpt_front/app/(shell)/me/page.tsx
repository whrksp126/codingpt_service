'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken, clearToken } from '@/lib/auth';
import { clientFetch, formatKRW } from '@/lib/api';
import { updatePaymentMethod } from '@/lib/portone';
import PlansPanel from '@/components/PlansPanel';
import LegalDoc from '@/components/legal/LegalDoc';
import Toast from '@/components/Toast';
import { TERMS, PRIVACY, EFFECTIVE_DATE } from '@/config/legal';

const APP_VERSION = '1.0.0';

interface SubInfo {
  status: string; planCode: string | null; planName: string | null; priceKrw: number | null; source: string;
  currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; canceledAt: string | null;
  scheduledPlan: { code: string; name: string; priceKrw: number } | null;
  pastDue: { since: string; attempts: number; graceEndsAt: string | null } | null;
  paymentMethod: { brand: string | null; last4: string } | null;
  manageInStore: boolean;
}
interface Receipt {
  id: number; kindLabel: string; planName: string | null; amountKrw: number;
  refundedAmountKrw: number; status: string; paidAt: string | null; createdAt: string;
}
interface UserInfo { id: number; nickname?: string; name?: string; email?: string }
interface GithubStatus { connected: boolean; login?: string }

const RECEIPT_STATUS: Record<string, string> = { paid: '결제 완료', ready: '대기', failed: '실패', cancelled: '취소', partial_cancelled: '부분 취소' };
const CANCEL_REASONS = ['요금이 부담돼요', '자주 사용하지 않아요', '일시적으로 멈추고 싶어요', '기능이 기대와 달라요', '기타'];
const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ko-KR') : null);

type Panel = 'main' | 'account' | 'billing' | 'settings' | 'theme' | 'plans' | 'usage' | 'terms' | 'privacy';

// ── 아이콘 (이모지 금지 → 인라인 SVG) ──
const IconGear = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
const IconBack = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
);
const IconChevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--dim)' }}><polyline points="9 18 15 12 9 6" /></svg>
);

// ── 공용 행 컴포넌트 (앱 v2 스타일 이식) ──
function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      {label ? <div className="dim" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</div> : null}
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>{children}</div>
    </div>
  );
}
function Row({ label, value, onClick, danger, center, last, chevron = true, right }: { label: string; value?: string; onClick?: () => void; danger?: boolean; center?: boolean; last?: boolean; chevron?: boolean; right?: React.ReactNode }) {
  const clickable = !!onClick;
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', borderBottom: last ? 'none' : '1px solid var(--border)', cursor: clickable ? 'pointer' : 'default' }}>
      <span style={{ flex: 1, fontSize: 14.5, fontWeight: center ? 600 : 400, textAlign: center ? 'center' : 'left', color: danger ? 'var(--danger, #F87171)' : 'var(--text)' }}>{label}</span>
      {value ? <span className="dim" style={{ fontSize: 13.5 }}>{value}</span> : null}
      {right}
      {clickable && !danger && !center && chevron ? <IconChevron /> : null}
    </div>
  );
}
function ConnRow({ name, meta, status, tone, action, onAction, last }: { name: string; meta: string; status?: string; tone: 'on' | 'wait' | 'off'; action?: string; onAction?: () => void; last?: boolean }) {
  const dot = tone === 'on' ? 'var(--accent)' : tone === 'wait' ? 'var(--warn, #FBBF24)' : 'var(--dim)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 14px', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{name}</div>
        <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>{meta}</div>
      </div>
      {action ? (
        <span onClick={onAction} style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>{action}</span>
      ) : status ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: dot }} />{status}
        </span>
      ) : null}
    </div>
  );
}
function UsageBar({ label, used, limit, resetAt }: { label: string; used: number; limit: number | null; resetAt?: string | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const over = pct != null && pct >= 100;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span className="dim" style={{ fontSize: 12 }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: over ? 'var(--danger, #F87171)' : 'var(--text2)' }}>{pct == null ? '무제한' : `${pct}%`}</span>
      </div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ width: pct == null ? '0%' : `${pct}%`, height: '100%', borderRadius: 999, background: over ? 'var(--danger, #F87171)' : 'var(--accent)', transition: 'width .3s' }} />
      </div>
      {resetAt ? <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>다음 충전 {new Date(resetAt).toLocaleString('ko-KR')}</div> : null}
    </div>
  );
}

export default function MyPage() {
  const [panel, setPanel] = useState<Panel>('main');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<{ brand: string | null; last4: string } | null>(null);
  const [github, setGithub] = useState<GithubStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [notify, setNotify] = useState(true);

  const load = async () => {
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
    const [me, st, sb, pay, pm, gh] = await Promise.all([
      clientFetch('/api/users/me', { token }),
      clientFetch('/api/usage/status', { token }),
      clientFetch('/api/subscription/me', { token }),
      clientFetch('/api/billing/payments?limit=20', { token }),
      clientFetch('/api/billing/payment-method', { token }),
      clientFetch('/api/github/status', { token }),
    ]);
    setUser((me.data as UserInfo) || null);
    setStatus(st.data); setSub((sb.data as SubInfo) || null);
    setReceipts(((pay.data as any)?.data ?? []) as Receipt[]);
    setPaymentMethod((pm.data as any) || null);
    setGithub((gh.data as GithubStatus) || { connected: false });
    setLoading(false);
  };
  useEffect(() => { captureHandoff(); load(); }, []);

  // 패널 깊이를 브라우저 히스토리에 싱크 — 좌상단 뒤로가기 + OS 뒤로가기 모두 동작.
  const goPanel = (p: Panel) => {
    setMsg(null); // 패널 이동 시 안내 메시지 제거
    setPanel(p);
    if (typeof window !== 'undefined') window.history.pushState({ mePanel: p }, '');
  };
  const goBack = () => { if (typeof window !== 'undefined') window.history.back(); };
  useEffect(() => {
    const onPop = (e: PopStateEvent) => { setMsg(null); setPanel(((e.state && (e.state as any).mePanel) as Panel) || 'main'); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 안내 메시지는 잠깐만 — 4초 후 자동 사라짐.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const cancel = async () => {
    const token = getToken(); if (!token) return;
    setMsg(null); setBusy('cancel');
    const r = await clientFetch('/api/subscription/cancel', { method: 'POST', body: { reason: cancelReason || null }, token });
    setBusy(null); setConfirmingCancel(false);
    if (r.ok) { setMsg('해지 예약되었습니다. 이용 기간 종료일까지는 그대로 사용할 수 있어요.'); load(); } else setMsg(r.message || '해지에 실패했습니다.');
  };
  const resume = async () => {
    const token = getToken(); if (!token) return;
    setMsg(null); setBusy('resume');
    const r = await clientFetch<{ resumed: boolean; storeManaged?: boolean }>('/api/subscription/resume', { method: 'POST', body: {}, token });
    setBusy(null);
    if (r.ok && r.data?.storeManaged) setMsg('스토어 구독은 앱에서 해지를 취소해 주세요.');
    else if (r.ok) { setMsg('구독이 계속 유지됩니다.'); load(); } else setMsg(r.message || '재개에 실패했습니다.');
  };
  const changeCard = async () => {
    const token = getToken(); if (!token) return;
    setMsg(null); setBusy('card');
    try {
      const r = await updatePaymentMethod(token);
      if (r.ok) { setMsg(r.recovered ? '결제 수단을 변경했고 결제가 정상 처리됐어요.' : '결제 수단을 변경했어요.'); load(); } else setMsg(r.message || '결제 수단 변경에 실패했습니다.');
    } finally { setBusy(null); }
  };
  const connectGithub = async () => {
    const token = getToken(); if (!token) return;
    const r = await clientFetch<{ authorizeUrl: string }>('/api/github/authorize', { token });
    if (r.ok && r.data?.authorizeUrl) window.location.href = r.data.authorizeUrl;
    else setMsg('GitHub 연결을 시작할 수 없어요.');
  };
  const logout = () => { clearToken(); window.location.href = '/'; };
  const deleteAccount = async () => {
    const token = getToken(); if (!token || !user) return;
    if (!confirm('정말 탈퇴하시겠어요? 계정과 데이터가 삭제되며 되돌릴 수 없습니다.')) return;
    setBusy('delete');
    const r = await clientFetch(`/api/users/${user.id}`, { method: 'DELETE', token });
    setBusy(null);
    if (r.ok) { clearToken(); window.location.href = '/'; } else setMsg(r.message || '탈퇴에 실패했습니다.');
  };

  const planName = sub?.planName || (status?.plan === 'free' ? 'Free' : status?.plan || 'Free');
  const periodEnd = fmtDate(sub?.currentPeriodEnd);
  const isStore = !!sub?.manageInStore;
  const isPaid = !!sub && (sub.planCode === 'pro' || sub.planCode === 'max'); // 유료 구독(해지/결제수단 대상)
  const hasWindowLimit = !!(status && status.windowLimitUnits);
  const cardLabel = paymentMethod ? `${paymentMethod.brand ? paymentMethod.brand + ' ' : '카드 '}···· ${paymentMethod.last4}` : null;
  const avatar = String(user?.nickname || user?.name || '코').trim().charAt(0).toUpperCase();

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  const TITLES: Record<Panel, string> = { main: '내 정보', account: '계정', billing: '결제', settings: '설정', theme: '테마', plans: '구독 플랜', usage: '사용량', terms: '이용약관', privacy: '개인정보 처리방침' };

  return (
    <div style={{ padding: '20px 28px 64px' }}>
      {/* 헤더 바 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, marginBottom: 10 }}>
        {panel !== 'main' ? (
          <button onClick={goBack} aria-label="뒤로" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', display: 'flex', padding: 2, marginLeft: -4 }}><IconBack /></button>
        ) : null}
        <h1 style={{ flex: 1, fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em' }}>{TITLES[panel]}</h1>
        {panel === 'main' ? (
          <button onClick={() => goPanel('settings')} aria-label="설정" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text2)', display: 'flex', padding: 4 }}><IconGear /></button>
        ) : null}
      </div>


      {/* ───── main ───── */}
      {panel === 'main' ? (
        <>
          {/* 프로필 */}
          <div onClick={() => goPanel('account')} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '10px 4px 18px', cursor: 'pointer' }}>
            <div style={{ width: 54, height: 54, borderRadius: 27, background: 'var(--elevated, #1B1F2A)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, fontWeight: 700, color: 'var(--text2)' }}>{avatar}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{user?.nickname || user?.name || '사용자'}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', border: '1px solid rgba(52,211,153,0.4)', borderRadius: 999, padding: '1px 8px' }}>{planName}</span>
              </div>
              <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{user?.email}</div>
            </div>
            <IconChevron />
          </div>

          {/* 구독 플랜 (인라인 요약) */}
          {sub?.pastDue ? (
            <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--danger, #F87171)', background: 'rgba(248,113,113,0.08)' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--danger, #F87171)' }}>결제에 실패했어요</div>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{fmtDate(sub.pastDue.graceEndsAt) ? `${fmtDate(sub.pastDue.graceEndsAt)}까지 결제 수단을 업데이트해 주세요.` : '결제 수단을 업데이트해 주세요.'}</p>
            </div>
          ) : null}
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: 16, marginBottom: 22 }}>
            <div className="dim" style={{ fontSize: 12, fontWeight: 600 }}>구독 플랜</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{planName}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {isPaid
                ? <>{sub!.status === 'past_due' ? '결제 실패' : sub!.cancelAtPeriodEnd ? `${periodEnd}까지 이용 가능` : periodEnd ? `다음 갱신 ${periodEnd}` : '이용 중'}{sub!.scheduledPlan ? ` · ${sub!.scheduledPlan.name}로 변경 예정` : ''}{isStore ? ' · 스토어 결제' : ''}</>
                : '무료로 채팅을 이용 중이에요. 워크스페이스 바이브코딩은 Pro부터예요.'}
            </div>
            {!isStore ? (
              <button onClick={() => goPanel('plans')} className="btn secondary" style={{ width: '100%', marginTop: 14, padding: '9px 16px', fontSize: 13.5 }}>{isPaid ? '플랜 변경' : '업그레이드'}</button>
            ) : (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>스토어 구독이에요. 변경·해지는 앱에서 진행해 주세요.</p>
            )}
          </div>

          {/* 연결 · 동기화 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, padding: '0 2px' }}>
            <span className="dim" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>연결 · 동기화</span>
            <span onClick={() => goPanel('account')} style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>연결 관리</span>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)', marginBottom: 22 }}>
            <ConnRow name="내 PC · 데스크톱" meta="연결 대기 중" status="대기" tone="wait" />
            <ConnRow name="GitHub" meta={github.connected ? `${github.login} · 자동 푸시` : '아직 연결되지 않았어요'} status={github.connected ? '연결됨' : undefined} tone={github.connected ? 'on' : 'off'} action={github.connected ? undefined : '연결'} onAction={connectGithub} />
            <ConnRow name="서버 · 클라우드 컴퓨팅" meta="PC 오프라인 시 자동 전환" status="대기" tone="wait" />
            <ConnRow name="동기화" meta="로컬 ↔ 서버 자동 동기화" status="켜짐" tone="on" last />
          </div>

          {/* 메뉴 */}
          <Group>
            <Row label="결제" onClick={() => goPanel('billing')} />
            <Row label="사용량" onClick={() => goPanel('usage')} last />
          </Group>
        </>
      ) : null}

      {/* ───── account ───── */}
      {panel === 'account' ? (
        <>
          <Group label="계정">
            <Row label="이메일" value={user?.email || '–'} />
            <Row label="로그인 연결" value="Google / 이메일" />
            <Row label="GitHub" value={github.connected ? `@${github.login}` : '연결 안됨'} onClick={github.connected ? undefined : connectGithub} chevron={!github.connected} last />
          </Group>
          <Group>
            <Row label={busy === 'delete' ? '처리 중…' : '회원 탈퇴'} onClick={deleteAccount} danger center last />
          </Group>
        </>
      ) : null}

      {/* ───── billing (무료 포함 항상 표시) ───── */}
      {panel === 'billing' ? (
        isStore ? (
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>스토어(App Store / Google Play)에서 구독한 플랜이에요. 결제 수단·해지·영수증은 앱의 구독 관리에서 확인해 주세요.</p>
        ) : (
          <>
            {/* 결제 수단 — 무료 계정도 등록/변경 가능 */}
            <Group label="결제 수단">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 15px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 34, height: 22, borderRadius: 5, background: 'var(--elevated, #1B1F2A)', border: '1px solid var(--border)', display: 'inline-block' }} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{cardLabel || '등록된 결제 수단이 없어요'}</span>
                </div>
                <button className="btn secondary" onClick={changeCard} disabled={busy === 'card'} style={{ padding: '7px 14px', fontSize: 13 }}>{busy === 'card' ? '처리 중…' : cardLabel ? '변경' : '등록'}</button>
              </div>
            </Group>

            {/* 구독 상태 */}
            <Group label="구독 상태">
              <div style={{ padding: '14px 15px' }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{planName} 플랜</div>
                {isPaid ? (
                  <>
                    <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                      {sub!.status === 'past_due' ? '결제에 실패했어요. 결제 수단을 업데이트해 주세요.' : sub!.cancelAtPeriodEnd ? (periodEnd ? `${periodEnd}까지 이용 후 해지될 예정이에요.` : '기간 말 해지 예약됨') : (periodEnd ? `${periodEnd}에 ${formatKRW(sub!.priceKrw || 0)} 자동 결제` : '매월 자동 갱신')}
                      {sub!.scheduledPlan ? ` · ${sub!.scheduledPlan.name}로 변경 예정` : ''}
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <button onClick={() => goPanel('plans')} className="btn secondary" style={{ padding: '8px 16px', fontSize: 13.5 }}>플랜 변경</button>
                      {sub!.cancelAtPeriodEnd ? (
                        <button className="btn" onClick={resume} disabled={busy === 'resume'} style={{ padding: '8px 16px', fontSize: 13.5 }}>{busy === 'resume' ? '처리 중…' : '구독 계속하기'}</button>
                      ) : (
                        <button className="btn secondary" onClick={() => setConfirmingCancel(true)} style={{ padding: '8px 16px', fontSize: 13.5, color: 'var(--danger, #F87171)' }}>구독 해지</button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>무료로 채팅을 이용 중이에요. 워크스페이스 바이브코딩은 Pro부터예요.</div>
                    <button onClick={() => goPanel('plans')} className="btn" style={{ marginTop: 12, padding: '8px 16px', fontSize: 13.5 }}>업그레이드</button>
                  </>
                )}
              </div>
            </Group>

            {/* 청구 내역 */}
            <div className="dim" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>청구 내역</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {receipts.map((r) => (
                <a key={r.id} href={`/billing/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{r.kindLabel}{r.planName ? ` · ${r.planName}` : ''}</div>
                      <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{fmtDate(r.paidAt || r.createdAt)}</div>
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 14.5, fontWeight: 800 }}>{formatKRW(r.amountKrw)}</div>
                      <div style={{ fontSize: 11.5, marginTop: 1, color: r.status === 'paid' ? 'var(--accent)' : 'var(--dim)' }}>{RECEIPT_STATUS[r.status] || r.status}{r.refundedAmountKrw > 0 ? ` · ${formatKRW(r.refundedAmountKrw)} 환불` : ''}</div>
                    </div>
                  </div>
                </a>
              ))}
              {receipts.length === 0 ? <p className="muted" style={{ fontSize: 13.5 }}>결제 내역이 없습니다.</p> : null}
            </div>
          </>
        )
      ) : null}

      {/* ───── settings ───── */}
      {panel === 'settings' ? (
        <>
          <Group label="환경">
            <Row label="테마" value="다크" onClick={() => goPanel('theme')} />
            <Row label="알림" onClick={() => setNotify((v) => !v)} chevron={false} last right={
              <span style={{ width: 42, height: 25, borderRadius: 999, background: notify ? 'var(--accent)' : 'var(--borderControl, #2A2F3A)', position: 'relative', transition: 'background .2s' }}>
                <span style={{ position: 'absolute', top: 3, left: notify ? 20 : 3, width: 19, height: 19, borderRadius: 999, background: '#fff', transition: 'left .2s' }} />
              </span>
            } />
          </Group>
          <Group label="정보">
            <Row label="서비스 약관" onClick={() => goPanel('terms')} />
            <Row label="개인정보 처리방침" onClick={() => goPanel('privacy')} />
            <Row label="버전 정보" value={APP_VERSION} chevron={false} last />
          </Group>
          <Group>
            <Row label="로그아웃" onClick={logout} danger center last />
          </Group>
        </>
      ) : null}

      {/* ───── theme ───── */}
      {panel === 'theme' ? (
        <Group label="테마">
          {[['system', '시스템 설정'], ['light', '라이트'], ['dark', '다크']].map(([k, label], i, arr) => (
            <Row key={k} label={label} chevron={false} last={i === arr.length - 1} right={
              <span style={{ fontSize: 16, color: k === 'dark' ? 'var(--accent)' : 'var(--dim)' }}>{k === 'dark' ? '●' : '○'}</span>
            } />
          ))}
        </Group>
      ) : null}
      {panel === 'theme' ? <p className="muted" style={{ fontSize: 12.5 }}>현재 웹은 다크 모드로 제공돼요.</p> : null}

      {/* ───── plans (구독 플랜 변경 — /plans 와 동일 컴포넌트, 패널 스텝) ───── */}
      {panel === 'plans' ? <PlansPanel onAfterChange={load} /> : null}

      {/* ───── usage (사용량 탭) ───── */}
      {panel === 'usage' ? (
        status ? (
          hasWindowLimit ? (
            <div>
              <UsageBar label="현재 구간 (5시간)" used={status.windowUsedUnits} limit={status.windowLimitUnits} resetAt={status.windowResetAt} />
              {status.weeklyLimitUnits ? <UsageBar label="이번 주" used={status.weeklyUsedUnits} limit={status.weeklyLimitUnits} resetAt={status.weeklyResetAt} /> : null}
              {status.enforced === false ? <div className="dim" style={{ fontSize: 11.5, marginTop: 14 }}>* 현재는 사용량만 표시되며 한도 초과로 차단되지 않아요.</div> : null}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13.5 }}>아직 사용 내역이 없어요.</p>
          )
        ) : (
          <p className="muted" style={{ fontSize: 13.5 }}>사용량 정보를 불러올 수 없습니다.</p>
        )
      ) : null}

      {/* ───── 약관 / 개인정보 (패널 스텝, 전체 재로딩 없음) ───── */}
      {panel === 'terms' ? <LegalDoc title="이용약관" sections={TERMS} effectiveDate={EFFECTIVE_DATE} hideTitle /> : null}
      {panel === 'privacy' ? <LegalDoc title="개인정보 처리방침" sections={PRIVACY} effectiveDate={EFFECTIVE_DATE} hideTitle /> : null}

      {/* 해지 확인 모달 */}
      {confirmingCancel ? (
        <div onClick={() => busy !== 'cancel' && setConfirmingCancel(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, background: 'var(--elevated, #1B1F2A)', border: '1px solid var(--border)', borderRadius: 16, padding: '24px 22px 20px' }}>
            <h2 style={{ fontSize: 19, fontWeight: 800 }}>정말 해지하시겠어요?</h2>
            <p className="muted" style={{ fontSize: 13.5, marginTop: 8, lineHeight: 1.6 }}>
              현재 <b style={{ color: 'var(--text)' }}>{planName}</b> 플랜을 이용 중이에요.
              {periodEnd ? <> 지금 해지해도 <b style={{ color: 'var(--text)' }}>{periodEnd}까지</b>는 그대로 이용할 수 있고, 이후 Free로 전환돼요.</> : <> 다음 결제일부터 자동 갱신이 중단돼요.</>}
            </p>
            <div style={{ marginTop: 16, padding: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
              <div className="dim" style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>해지하면 이런 점이 달라져요</div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 }}>
                {['워크스페이스 바이브코딩(Pro 이상 전용) 사용이 중단돼요.', '사용량 한도가 Free 수준으로 줄어들어요.', '진행 중인 프로젝트의 실행·편집이 제한될 수 있어요.'].map((t) => (
                  <li key={t} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5 }}><span style={{ color: 'var(--danger, #F87171)', fontWeight: 800 }}>·</span><span>{t}</span></li>
                ))}
              </ul>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>해지 이유 (선택)</div>
              <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ width: '100%', padding: '9px 11px', fontSize: 13.5, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <option value="">선택 안 함</option>
                {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>비용이 부담된다면 <span onClick={() => { setConfirmingCancel(false); goPanel('plans'); }} style={{ color: 'var(--accent)', cursor: 'pointer' }}>더 낮은 플랜으로 변경</span>하는 방법도 있어요. 환불은 <a href="/legal/refund">환불·취소 정책</a>을 따릅니다.</p>
            <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => setConfirmingCancel(false)} disabled={busy === 'cancel'} style={{ flex: 1, padding: '11px 16px', fontSize: 14 }}>계속 이용하기</button>
              <button className="btn secondary" onClick={cancel} disabled={busy === 'cancel'} style={{ flex: 1, padding: '11px 16px', fontSize: 14, color: 'var(--danger, #F87171)' }}>{busy === 'cancel' ? '처리 중…' : '해지하기'}</button>
            </div>
          </div>
        </div>
      ) : null}

      <Toast message={msg} />
    </div>
  );
}
