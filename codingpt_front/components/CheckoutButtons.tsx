'use client';

import { useCallback, useEffect, useState } from 'react';
import { clearToken, getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';

// 글로벌 웹 구독: 서버가 생성한 Lemon Squeezy 호스팅 체크아웃으로 이동한다.
export default function CheckoutButtons({ code, label }: { code: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(!!getToken());
  }, []);

  const goToLogin = useCallback(() => {
    window.location.href = `/login?next=${encodeURIComponent('/?support=1#pricing')}`;
  }, []);

  const startCheckout = useCallback(async () => {
    const token = getToken();
    if (!token) {
      goToLogin();
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const r = await clientFetch<{ url: string }>('/api/billing/lemonsqueezy/checkout', {
        method: 'POST', body: { code }, token,
      });
      if (r.ok && r.data?.url) {
        window.location.href = r.data.url;
      } else if (r.status === 401) {
        // 만료된 토큰을 그대로 두면 로그인 페이지가 다시 랜딩으로 보내는 루프가 생긴다.
        clearToken();
        goToLogin();
      } else {
        setMsg('결제 페이지를 열지 못했어요. 잠시 후 다시 시도해 주세요.');
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '결제 오류');
    } finally {
      setBusy(false);
    }
  }, [code, goToLogin]);

  useEffect(() => {
    if (!authed) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('support') !== '1') return;
    url.searchParams.delete('support');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    void startCheckout();
  }, [authed, startCheckout]);

  return (
    <div>
      <button className="btn" disabled={busy} onClick={startCheckout} style={{ width: '100%' }}>
        {busy ? '결제 페이지 여는 중…' : label}
      </button>
      {msg ? <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{msg}</p> : null}
    </div>
  );
}
