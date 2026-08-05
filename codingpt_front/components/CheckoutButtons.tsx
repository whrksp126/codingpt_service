'use client';

import { useCallback, useEffect, useState } from 'react';
import { getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';

// 글로벌 웹 구독: 서버가 생성한 Lemon Squeezy 호스팅 체크아웃으로 이동한다.
export default function CheckoutButtons({ code, label }: { code: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(!!getToken());
  }, []);

  const startCheckout = useCallback(async () => {
    const token = getToken();
    if (!token) {
      window.location.href = `/login?next=${encodeURIComponent('/?support=1#pricing')}`;
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const r = await clientFetch<{ url: string }>('/api/billing/lemonsqueezy/checkout', {
        method: 'POST', body: { code }, token,
      });
      if (r.ok && r.data?.url) { window.location.href = r.data.url; }
      else setMsg(r.message || '결제에 실패했습니다.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '결제 오류');
    } finally {
      setBusy(false);
    }
  }, [code]);

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
