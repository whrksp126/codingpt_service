'use client';

import { useEffect, useRef, useState } from 'react';
import { captureHandoff, setToken, getToken, clearToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';

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
      <p className="muted" style={{ fontSize: 13 }}>
        CodingPT 데스크톱 앱을 이 계정에 연결합니다.
        {code ? <> 연결 코드 <b style={{ letterSpacing: 1 }}>{code}</b></> : ' 연결 코드가 감지되지 않았습니다.'}
      </p>

      {!token ? (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>먼저 로그인하세요.</p>
          {GOOGLE_CLIENT_ID ? (
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
              <div ref={gbtn} />
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 12 }}>구글 로그인이 구성되지 않았습니다.</p>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            이메일 계정은 <a href={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/desktop-login')}`}>여기</a>에서 로그인 후 돌아오세요.
          </p>
        </>
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

      {msg ? <p style={{ fontSize: 13, marginTop: 12, color: 'var(--error, #f87171)' }}>{msg}</p> : null}
    </div>
  );
}

const wrap: React.CSSProperties = { maxWidth: 420, margin: '24px auto', textAlign: 'center' };
const cta: React.CSSProperties = {
  background: 'var(--cta, #08875d)', color: '#fff', border: 'none',
  borderRadius: 10, padding: '12px 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
