'use client';

import { useEffect, useState } from 'react';
import { getToken } from '@/lib/auth';

// 상단 네비 — 로고 + [문서][기능] + 다운로드/인증. BYO 다운로드 유도가 주 CTA.
export default function Nav() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => { setAuthed(!!getToken()); }, []);

  return (
    <nav className="nav">
      <a href="/" style={{ display: 'flex', alignItems: 'center', marginRight: 26 }}>
        <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
      </a>
      <a
        href="/docs"
        style={{ color: 'var(--text3)', fontWeight: 600, fontSize: 14, marginRight: 22 }}
      >
        문서
      </a>
      <a
        href="/#features"
        style={{ color: 'var(--text3)', fontWeight: 600, fontSize: 14 }}
      >
        기능
      </a>
      <span style={{ flex: 1 }} />
      <a
        href="/#start"
        style={{
          background: 'var(--accent)',
          color: 'var(--on-accent)',
          padding: '8px 16px',
          borderRadius: 9,
          fontWeight: 680,
          fontSize: 13.5,
          marginRight: 18,
        }}
      >
        다운로드
      </a>
      {authed
        ? <a href="/me" style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>마이페이지</a>
        : <a href="/login" style={{ color: 'var(--text3)', fontWeight: 600, fontSize: 14 }}>로그인</a>}
    </nav>
  );
}
