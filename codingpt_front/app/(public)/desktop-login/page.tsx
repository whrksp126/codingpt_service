'use client';

import { useEffect, useRef, useState } from 'react';
import { captureHandoff, setToken, getToken, clearToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { appleSignIn } from '@/lib/appleSignIn';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID || '';

// 데스크톱(PC 앱) 웹 로그인 — 클로드 코드 방식.
//  PC 앱이 페어링 세션을 열고 이 페이지를 브라우저로 띄운다(?code=XXXX-XXXX).
//  사용자가 여기서 구글 로그인 후 "이 PC 연결"을 누르면 기존 /api/daemon/pair/approve 로 세션을 승인 →
//  PC 앱이 폴링(claim)으로 deviceToken 을 받아 로그인 완료. (승인 = 로그인된 사용자가 기기를 계정에 연결)
export default function DesktopLogin() {
  const [code, setCode] = useState('');
  const [token, setTok] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const gbtn = useRef<HTMLDivElement>(null);
  const autoRef = useRef(false); // 자동 승인 1회 가드

  useEffect(() => {
    captureHandoff();
    setTok(getToken());
    try {
      const c = new URL(window.location.href).searchParams.get('code') || '';
      setCode(c.trim().toUpperCase());
    } catch { /* noop */ }
  }, []);

  // 구글 idToken → /api/users/login → 토큰 저장
  const onGoogleCredential = async (idToken: string) => {
    setBusy(true); setMsg(null);
    const r = await clientFetch<{ accessToken: string }>('/api/users/login', { method: 'POST', body: { idToken } });
    setBusy(false);
    if (r.ok && r.data?.accessToken) { setToken(r.data.accessToken); setTok(r.data.accessToken); }
    else setMsg(r.message || '구글 로그인에 실패했습니다.');
  };

  // Apple 로그인 — 팝업 id_token → /api/users/apple-login (PC 앱이 이 페이지를 브라우저로 열어 재사용)
  const onApple = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await appleSignIn();
      if (!res) { setBusy(false); return; }
      const r = await clientFetch<{ accessToken: string }>('/api/users/apple-login', {
        method: 'POST', body: { identityToken: res.identityToken, name: res.name, authorizationCode: res.authorizationCode },
      });
      setBusy(false);
      if (r.ok && r.data?.accessToken) { setToken(r.data.accessToken); setTok(r.data.accessToken); }
      else setMsg(r.message || 'Apple 로그인에 실패했습니다.');
    } catch {
      setBusy(false); setMsg('Apple 로그인 중 오류가 발생했습니다.');
    }
  };

  useEffect(() => {
    if (token || !GOOGLE_CLIENT_ID) return;
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
  }, [token]);

  const onApprove = async () => {
    if (!code) { setMsg('연결 코드가 없습니다. PC 앱에서 다시 시도하세요.'); return; }
    setBusy(true); setMsg(null);
    const r = await clientFetch('/api/daemon/pair/approve', { method: 'POST', body: { code }, token });
    setBusy(false);
    if (r.ok) { setDone(true); setMsg(null); return; }
    autoRef.current = false;
    // 저장된 토큰이 만료/무효(401)면 비우고 재로그인 유도 — 클로드 CLI식 재인증.
    //  기존 로그인 토큰(15분 만료)이 남아 자동 승인이 실패하는 경우를 처리.
    if (r.status === 401) {
      clearToken();
      setTok(null);
      setMsg('세션이 만료되었어요. 다시 로그인해 주세요.');
    } else {
      setMsg(r.message || '연결에 실패했습니다. 코드가 만료되었을 수 있어요.');
    }
  };

  // 로그인되면(토큰 획득) 자동으로 이 기기를 승인 — 클로드 CLI식 자동 완료(별도 승인 버튼 없음).
  //  웹에서 로그인만 하면 PC 앱이 폴링으로 즉시 로그인 완료된다.
  useEffect(() => {
    if (token && code && !done && !autoRef.current) {
      autoRef.current = true;
      void onApprove();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, code]);

  if (done) {
    return (
      <div className="card" style={wrap}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #34d399)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto' }} aria-hidden>
          <circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9.5" />
        </svg>
        <h1 style={{ fontSize: 20, marginTop: 8 }}>PC에 로그인되었습니다</h1>
        <p className="muted" style={{ fontSize: 13 }}>이 창을 닫고 CodingPT 앱으로 돌아가세요. 곧 자동으로 연결됩니다.</p>
      </div>
    );
  }

  return (
    <div className="card" style={wrap}>
      <h1 style={{ fontSize: 20 }}>PC 로그인</h1>

      {!token ? (
        <div style={{ marginTop: 20, display: 'grid', gap: 14, justifyItems: 'center' }}>
          {GOOGLE_CLIENT_ID ? (
            <div ref={gbtn} />
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>구글 로그인이 구성되지 않았습니다.</p>
          )}
          <button onClick={onApple} disabled={busy} style={appleBtn} aria-label="Apple로 계속하기">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M17.05 12.04c-.03-2.85 2.33-4.22 2.44-4.28-1.33-1.95-3.4-2.22-4.14-2.25-1.76-.18-3.44 1.04-4.33 1.04-.89 0-2.27-1.02-3.73-.99-1.92.03-3.69 1.12-4.68 2.84-2 3.46-.51 8.58 1.43 11.39.95 1.38 2.08 2.92 3.56 2.87 1.43-.06 1.97-.92 3.7-.92 1.72 0 2.21.92 3.72.89 1.54-.03 2.51-1.4 3.45-2.79 1.09-1.6 1.54-3.15 1.56-3.23-.03-.02-2.99-1.15-3.02-4.56zM14.23 3.66c.79-.96 1.32-2.29 1.17-3.62-1.14.05-2.51.76-3.32 1.71-.73.85-1.37 2.2-1.2 3.5 1.27.1 2.57-.64 3.35-1.59z" /></svg>
            <span>Apple로 계속하기</span>
          </button>
          <a
            className="muted"
            style={{ fontSize: 13, textDecoration: 'none' }}
            href={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/desktop-login')}`}
          >
            이메일로 로그인
          </a>
        </div>
      ) : (
        <div style={{ marginTop: 16, display: 'grid', gap: 10, justifyItems: 'center' }}>
          {!msg ? (
            <p className="muted" style={{ fontSize: 13 }}>이 PC에 로그인하는 중…</p>
          ) : (
            <button className="btn" disabled={busy || !code} onClick={() => { autoRef.current = false; void onApprove(); }} style={cta}>
              {busy ? '연결 중…' : '다시 시도'}
            </button>
          )}
        </div>
      )}

      {!code ? <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>연결 코드가 없습니다. PC 앱에서 다시 시도하세요.</p> : null}
      {msg ? <p style={{ fontSize: 13, marginTop: 12, color: 'var(--error, #f87171)' }}>{msg}</p> : null}
    </div>
  );
}

const wrap: React.CSSProperties = { maxWidth: 420, margin: '24px auto', textAlign: 'center' };
const appleBtn: React.CSSProperties = {
  width: 320, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  background: '#000', color: '#fff', border: 'none', borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
const cta: React.CSSProperties = {
  background: 'var(--cta, #08875d)', color: '#fff', border: 'none',
  borderRadius: 10, padding: '12px 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
