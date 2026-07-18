'use client';

import { useEffect, useRef, useState } from 'react';
import { setToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { appleSignIn } from '@/lib/appleSignIn';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID || '';

// 공용 로그인 패널 — [로고][애플][구글][구분선][이메일 버튼(로그인/회원가입)][약관].
//  성공 시 setToken 저장 후 onAuthed(accessToken) 호출 → 페이지가 후처리(리다이렉트/PC연결/앱핸드오프).
//  only='email' 이면 애플/구글/구분선을 숨기고 이메일 폼만 노출(앱에서 이미 이메일을 택한 경우).
export default function AuthPanel({ onAuthed, title, only }: { onAuthed: (accessToken: string) => void; title?: string; only?: 'email' | null }) {
  const emailOnly = only === 'email';
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(emailOnly);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [forgot, setForgot] = useState(false); // 비밀번호 찾기 화면
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const gbtn = useRef<HTMLDivElement>(null);

  const done = (accessToken: string) => { setToken(accessToken); onAuthed(accessToken); };

  const onGoogleCredential = async (idToken: string) => {
    setBusy(true); setMsg(null);
    const r = await clientFetch<{ accessToken: string }>('/api/users/login', { method: 'POST', body: { idToken } });
    setBusy(false);
    if (r.ok && r.data?.accessToken) done(r.data.accessToken);
    else setMsg(r.message || '구글 로그인에 실패했어요.');
  };

  const onApple = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await appleSignIn();
      if (!res) { setBusy(false); return; }
      const r = await clientFetch<{ accessToken: string }>('/api/users/apple-login', {
        method: 'POST', body: { identityToken: res.identityToken, name: res.name, authorizationCode: res.authorizationCode },
      });
      setBusy(false);
      if (r.ok && r.data?.accessToken) done(r.data.accessToken);
      else setMsg(r.message || 'Apple 로그인에 실패했어요.');
    } catch {
      setBusy(false); setMsg('Apple 로그인 중 오류가 발생했어요.');
    }
  };

  const onEmailSubmit = async () => {
    if (!email || !pw) { setMsg('이메일과 비밀번호를 입력해 주세요.'); return; }
    if (mode === 'signup') {
      if (pw.length < 8) { setMsg('비밀번호는 8자 이상이어야 해요.'); return; }
      if (pw !== pw2) { setMsg('비밀번호가 일치하지 않아요.'); return; }
    }
    setBusy(true); setMsg(null);
    const path = mode === 'signup' ? '/api/users/register-local' : '/api/users/login-local';
    const r = await clientFetch<{ accessToken: string }>(path, { method: 'POST', body: { email, password: pw } });
    setBusy(false);
    if (r.ok && r.data?.accessToken) done(r.data.accessToken);
    else setMsg(r.message || (mode === 'signup' ? '회원가입에 실패했어요.' : '로그인에 실패했어요.'));
  };

  // 비밀번호 찾기 — 재설정 안내 요청(현재 메일 발송은 준비 중, 백엔드는 존재 노출 없이 일반 응답).
  const onForgotSubmit = async () => {
    if (!email) { setForgotMsg('이메일을 입력해 주세요.'); return; }
    setBusy(true); setForgotMsg(null);
    const r = await clientFetch<{ pending?: boolean }>('/api/users/password/forgot', { method: 'POST', body: { email } });
    setBusy(false);
    if (r.ok) {
      setForgotMsg(r.data?.pending
        ? '비밀번호 재설정 기능은 준비 중이에요. 곧 이메일로 안내해 드릴게요.'
        : '가입된 이메일이라면 재설정 안내를 보내 드렸어요. 메일함을 확인해 주세요.');
    } else {
      setForgotMsg(r.message || '요청 처리에 실패했어요. 잠시 후 다시 시도해 주세요.');
    }
  };

  // 구글 GSI 버튼 렌더 (이메일 전용 모드에선 렌더하지 않음)
  useEffect(() => {
    if (emailOnly || !GOOGLE_CLIENT_ID) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => {
      const g = (window as any).google;
      if (!g?.accounts?.id || !gbtn.current) return;
      g.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (resp: any) => onGoogleCredential(resp.credential) });
      g.accounts.id.renderButton(gbtn.current, { theme: 'filled_black', size: 'large', shape: 'pill', width: 320, text: 'continue_with' });
    };
    document.body.appendChild(s);
    return () => { s.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card" style={{ maxWidth: 400, margin: '24px auto', textAlign: 'center' }}>
      <img src="/logo.png" alt="CodingPT" height={30} style={{ display: 'block', margin: '4px auto 6px' }} />
      {title ? <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>{title}</p> : null}

      {/* 애플/구글/구분선 — 이메일 전용 모드에선 숨김(앱에서 이미 이메일을 택함). */}
      {!emailOnly ? (
        <>
          <div style={{ marginTop: 18, display: 'grid', gap: 10, justifyItems: 'center' }}>
            {/* Apple */}
            <button onClick={onApple} disabled={busy} style={appleBtn} aria-label="Apple로 계속하기">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff" aria-hidden><path d="M17.05 12.04c-.03-2.85 2.33-4.22 2.44-4.28-1.33-1.95-3.4-2.22-4.14-2.25-1.76-.18-3.44 1.04-4.33 1.04-.89 0-2.27-1.02-3.73-.99-1.92.03-3.69 1.12-4.68 2.84-2 3.46-.51 8.58 1.43 11.39.95 1.38 2.08 2.92 3.56 2.87 1.43-.06 1.97-.92 3.7-.92 1.72 0 2.21.92 3.72.89 1.54-.03 2.51-1.4 3.45-2.79 1.09-1.6 1.54-3.15 1.56-3.23-.03-.02-2.99-1.15-3.02-4.56zM14.23 3.66c.79-.96 1.32-2.29 1.17-3.62-1.14.05-2.51.76-3.32 1.71-.73.85-1.37 2.2-1.2 3.5 1.27.1 2.57-.64 3.35-1.59z" /></svg>
              <span>Apple로 계속하기</span>
            </button>
            {/* Google */}
            {GOOGLE_CLIENT_ID ? <div ref={gbtn} /> : null}
          </div>

          {/* 구분선 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px auto', width: 320 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span className="dim" style={{ fontSize: 12 }}>또는</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>
        </>
      ) : null}

      {/* 이메일 — 버튼 형식. 누르면 로그인/회원가입 폼 펼침. */}
      {forgot ? (
        <div style={{ display: 'grid', gap: 10, width: 320, margin: '0 auto', textAlign: 'left' }}>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 2px' }}>가입한 이메일을 입력하면 재설정 안내를 보내 드려요.</p>
          <input placeholder="이메일" type="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} style={inp} />
          <button className="btn" disabled={busy} onClick={onForgotSubmit} style={cta}>
            {busy ? '처리 중…' : '재설정 안내 받기'}
          </button>
          {forgotMsg ? <p style={{ fontSize: 13, color: 'var(--text2)' }}>{forgotMsg}</p> : null}
          <button onClick={() => { setForgot(false); setForgotMsg(null); setMsg(null); }} style={linkBtn}>← 로그인으로 돌아가기</button>
        </div>
      ) : !showEmail ? (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button onClick={() => { setShowEmail(true); setMsg(null); }} style={emailBtn}>이메일로 계속하기</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, width: 320, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: 6, background: 'var(--surface)', borderRadius: 10, padding: 4 }}>
            {(['login', 'signup'] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); setMsg(null); }}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
                  background: mode === m ? 'var(--cta, #08875d)' : 'transparent', color: mode === m ? '#fff' : 'var(--text2)' }}>
                {m === 'login' ? '로그인' : '회원가입'}
              </button>
            ))}
          </div>
          <input placeholder="이메일" type="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} style={inp} />
          <input placeholder="비밀번호" type="password" value={pw} onChange={(e) => setPw(e.target.value)} style={inp} />
          {mode === 'signup' ? (
            <input placeholder="비밀번호 확인" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} style={inp} />
          ) : null}
          <button className="btn" disabled={busy} onClick={onEmailSubmit} style={cta}>
            {busy ? '처리 중…' : (mode === 'signup' ? '회원가입' : '로그인')}
          </button>
          {mode === 'login' ? (
            <button onClick={() => { setForgot(true); setForgotMsg(null); setMsg(null); }} style={linkBtn}>비밀번호를 잊으셨나요?</button>
          ) : null}
        </div>
      )}

      {msg ? <p style={{ fontSize: 13, marginTop: 12, color: 'var(--error, #f87171)' }}>{msg}</p> : null}

      {/* 약관 — 맨 아래 */}
      <p className="muted" style={{ fontSize: 12, marginTop: 18, lineHeight: 1.6 }}>
        계속하면 <a href="/legal/terms" style={{ color: 'var(--text2)' }}>서비스 약관</a>과{' '}
        <a href="/legal/privacy" style={{ color: 'var(--text2)' }}>개인정보 처리방침</a>에 동의하게 돼요.
      </p>
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
const emailBtn: React.CSSProperties = {
  width: 320, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-control)',
  borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
const cta: React.CSSProperties = {
  background: 'var(--cta, #08875d)', color: '#fff', border: 'none',
  borderRadius: 10, padding: '12px 14px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text2)', fontSize: 13,
  cursor: 'pointer', padding: '2px 0', textAlign: 'center',
};
