'use client';

import { useEffect, useRef, useState } from 'react';
import { captureHandoff, setToken, getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { appleSignIn } from '@/lib/appleSignIn';

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

  // Apple 로그인 — 팝업으로 id_token 획득 → 백엔드 /api/users/apple-login
  const onApple = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await appleSignIn();
      if (!res) { setBusy(false); return; } // 취소
      const r = await clientFetch<{ accessToken: string }>('/api/users/apple-login', {
        method: 'POST', body: { identityToken: res.identityToken, name: res.name },
      });
      setBusy(false);
      if (r.ok && r.data?.accessToken) { setToken(r.data.accessToken); redirectNext(); }
      else setMsg(r.message || 'Apple 로그인에 실패했습니다.');
    } catch {
      setBusy(false); setMsg('Apple 로그인 중 오류가 발생했습니다.');
    }
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

      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
        <button onClick={onApple} disabled={busy} style={appleBtn} aria-label="Apple로 계속하기">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M17.05 12.04c-.03-2.85 2.33-4.22 2.44-4.28-1.33-1.95-3.4-2.22-4.14-2.25-1.76-.18-3.44 1.04-4.33 1.04-.89 0-2.27-1.02-3.73-.99-1.92.03-3.69 1.12-4.68 2.84-2 3.46-.51 8.58 1.43 11.39.95 1.38 2.08 2.92 3.56 2.87 1.43-.06 1.97-.92 3.7-.92 1.72 0 2.21.92 3.72.89 1.54-.03 2.51-1.4 3.45-2.79 1.09-1.6 1.54-3.15 1.56-3.23-.03-.02-2.99-1.15-3.02-4.56zM14.23 3.66c.79-.96 1.32-2.29 1.17-3.62-1.14.05-2.51.76-3.32 1.71-.73.85-1.37 2.2-1.2 3.5 1.27.1 2.57-.64 3.35-1.59z" /></svg>
          <span>Apple로 계속하기</span>
        </button>
      </div>

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

const appleBtn: React.CSSProperties = {
  width: 320, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  background: '#000', color: '#fff', border: 'none', borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
