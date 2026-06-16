'use client';

import { useEffect, useRef, useState } from 'react';
import { captureHandoff, setToken, getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID || '';

// 로그인 — 구글(앱과 동일) + 앱 핸드오프 + 카드사 심사용 ID/PW.
export default function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gbtn = useRef<HTMLDivElement>(null);

  const redirectNext = () => {
    const next = new URL(window.location.href).searchParams.get('next') || '/me';
    window.location.href = next;
  };

  // 구글 idToken → 백엔드 /api/users/login → 토큰 저장
  const onGoogleCredential = async (idToken: string) => {
    setBusy(true); setMsg(null);
    const r = await clientFetch<{ accessToken: string }>('/api/users/login', { method: 'POST', body: { idToken } });
    setBusy(false);
    if (r.ok && r.data?.accessToken) { setToken(r.data.accessToken); redirectNext(); }
    else setMsg(r.message || '구글 로그인에 실패했습니다.');
  };

  useEffect(() => {
    captureHandoff();
    if (getToken()) { redirectNext(); return; }
    if (!GOOGLE_CLIENT_ID) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => {
      const g = (window as any).google;
      if (!g?.accounts?.id || !gbtn.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (resp: any) => onGoogleCredential(resp.credential),
      });
      g.accounts.id.renderButton(gbtn.current, { theme: 'filled_black', size: 'large', shape: 'pill', width: 320, text: 'continue_with' });
    };
    document.body.appendChild(s);
    return () => { s.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLocalLogin = async () => {
    setBusy(true); setMsg(null);
    const r = await clientFetch<{ accessToken: string }>('/api/users/login-local', {
      method: 'POST', body: { email, password: pw },
    });
    setBusy(false);
    if (r.ok && r.data?.accessToken) { setToken(r.data.accessToken); redirectNext(); }
    else setMsg(r.message || '로그인에 실패했습니다.');
  };

  return (
    <div className="card" style={{ maxWidth: 420, margin: '24px auto' }}>
      <h1 style={{ fontSize: 20 }}>로그인</h1>
      <p className="muted" style={{ fontSize: 13 }}>앱에서 진입하면 자동으로 로그인됩니다.</p>

      {GOOGLE_CLIENT_ID ? (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
          <div ref={gbtn} />
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <span className="dim" style={{ fontSize: 12 }}>또는 이메일</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <input placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} style={inp} />
        <input placeholder="비밀번호" type="password" value={pw} onChange={(e) => setPw(e.target.value)} style={inp} />
        <button className="btn" disabled={busy} onClick={onLocalLogin}>{busy ? '로그인 중…' : '로그인'}</button>
        {msg ? <p className="muted" style={{ fontSize: 13 }}>{msg}</p> : null}
      </div>
    </div>
  );
}

const inp: React.CSSProperties = {
  background: 'var(--elevated2)', border: '1px solid var(--border-control)', color: 'var(--text)',
  borderRadius: 10, padding: '12px 14px', fontSize: 15,
};
