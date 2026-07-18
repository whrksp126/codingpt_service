'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, setToken, getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import AuthPanel from '@/components/AuthPanel';

// 로그인 — 웹/앱 공용. 앱(모바일)이 openAuth 로 ?app=1 을 붙여 열면 로그인/가입 후
//  일회용 핸드오프 코드를 발급받아 codingpt://email-auth?code= 로 앱에 되돌려준다.
export default function Login() {
  const [appMode, setAppMode] = useState(false);
  const [handing, setHanding] = useState(false);
  const [emailOnly, setEmailOnly] = useState(false); // ?method=email (앱에서 이메일 선택 → 이메일 폼만)

  const redirectNext = () => {
    const raw = new URL(window.location.href).searchParams.get('next') || '/me';
    // 오픈 리다이렉트/`javascript:` 주입 차단 — 같은 출처의 절대경로(/...)만 허용.
    const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/me';
    window.location.href = next;
  };

  // 앱으로 토큰 전달 — 로그인된 상태에서 핸드오프 코드 발급 → 커스텀 스킴 딥링크.
  const handoffToApp = async () => {
    setHanding(true);
    const r = await clientFetch<{ code: string }>('/api/users/handoff/issue', { method: 'POST', token: getToken() });
    if (r.ok && r.data?.code) {
      window.location.href = `codingpt://email-auth?code=${encodeURIComponent(r.data.code)}`;
    } else {
      setHanding(false);
    }
  };

  const onAuthed = () => { if (appMode) void handoffToApp(); else redirectNext(); };

  useEffect(() => {
    captureHandoff();
    const sp = new URL(window.location.href).searchParams;
    const app = sp.get('app') === '1';
    setAppMode(app);
    setEmailOnly(sp.get('method') === 'email');
    if (getToken()) { if (app) void handoffToApp(); else redirectNext(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (handing) {
    return (
      <div className="card" style={{ maxWidth: 400, margin: '24px auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: 20 }}>로그인 완료</h1>
        <p className="muted" style={{ fontSize: 13 }}>앱으로 돌아가는 중이에요. 자동으로 넘어가지 않으면 이 창을 닫아 주세요.</p>
      </div>
    );
  }

  return <AuthPanel onAuthed={onAuthed} title={appMode ? '앱에 로그인' : undefined} only={emailOnly ? 'email' : null} />;
}
