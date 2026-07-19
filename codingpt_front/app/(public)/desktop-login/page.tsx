'use client';

import { useEffect, useState } from 'react';
import { getToken, clearToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import AuthPanel from '@/components/AuthPanel';

// 데스크톱(PC 앱) 웹 로그인 — PC 앱이 페어링 세션을 열고 이 페이지를 브라우저로 띄운다(?code=XXXX-XXXX).
//  여기서 로그인(구글/애플/이메일)하면 자동으로 이 기기를 계정에 승인(pair/approve) → PC 앱이 폴링(claim)으로 완료.
export default function DesktopLogin() {
  const [code, setCode] = useState('');
  const [token, setTok] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setTok(getToken());
    try {
      const c = new URL(window.location.href).searchParams.get('code') || '';
      setCode(c.trim().toUpperCase());
    } catch { /* noop */ }
  }, []);

  const onApprove = async () => {
    if (!code) { setMsg('연결 코드가 없습니다. PC 앱에서 다시 시도하세요.'); return; }
    setBusy(true); setMsg(null);
    const r = await clientFetch('/api/daemon/pair/approve', { method: 'POST', body: { code }, token: getToken() });
    setBusy(false);
    if (r.ok) { setDone(true); setMsg(null); return; }
    if (r.status === 401) { clearToken(); setTok(null); setMsg('세션이 만료되었어요. 다시 로그인해 주세요.'); }
    else setMsg(r.message || '연결에 실패했습니다. 코드가 만료되었을 수 있어요.');
  };
  // 보안: 자동 승인하지 않는다. 악성 사이트가 로그인된 사용자를 /desktop-login?code=공격자코드 로 유도해
  //  피해자 계정에 공격자 PC를 페어링하는 CSRF를 막기 위해, 사용자가 코드를 확인하고 직접 눌러야 승인된다.

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

  // 로그인 전 — 공용 AuthPanel. 로그인 성공 시 토큰 저장 후 자동 승인.
  if (!token) {
    return (
      <div>
        <AuthPanel onAuthed={(t) => setTok(t)} title="이 PC를 내 계정에 연결" />
        {!code ? <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: -8 }}>연결 코드가 없습니다. PC 앱에서 다시 시도하세요.</p> : null}
      </div>
    );
  }

  // 로그인 후 — 사용자가 코드를 확인하고 직접 승인(자동 승인 금지, CSRF 방지).
  return (
    <div className="card" style={wrap}>
      <h1 style={{ fontSize: 20 }}>이 PC를 연결할까요?</h1>
      {code ? (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>PC 화면에 표시된 코드와 같은지 확인하세요.</p>
          <div style={{ margin: '14px auto', fontSize: 26, fontWeight: 700, letterSpacing: 3, fontFamily: 'monospace' }}>{code}</div>
          <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
            <button className="btn" disabled={busy} onClick={() => void onApprove()} style={cta}>
              {busy ? '연결 중…' : '이 PC 연결'}
            </button>
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>연결 코드가 없습니다. PC 앱에서 다시 시도하세요.</p>
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
