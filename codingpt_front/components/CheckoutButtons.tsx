'use client';

import { useEffect, useState } from 'react';
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

  const onClick = async () => {
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
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
  };

  return (
    <div>
      <button className="btn" disabled={busy} onClick={onClick} style={{ width: '100%' }}>
        {busy ? '처리 중…' : authed ? label : '로그인 후 구독'}
      </button>
      {msg ? <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{msg}</p> : null}
    </div>
  );
}
