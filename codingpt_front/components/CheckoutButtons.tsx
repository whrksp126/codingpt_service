'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken } from '@/lib/auth';
import { paySubscription } from '@/lib/portone';

// 구독 결제 버튼(클라이언트). 핸드오프 토큰 캡처 → PortOne 빌링키 발급 → 서버 활성화.
export default function CheckoutButtons({ code, label }: { code: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    captureHandoff();
    setAuthed(!!getToken());
  }, []);

  const onClick = async () => {
    const token = getToken();
    if (!token) { window.location.href = '/login?next=/me'; return; }
    setBusy(true); setMsg(null);
    try {
      const r = await paySubscription(code, token);
      if (r.ok) { window.location.href = '/me'; }
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
