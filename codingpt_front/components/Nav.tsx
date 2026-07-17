'use client';

import { useEffect, useState } from 'react';
import { captureHandoff, getToken } from '@/lib/auth';

// 상단 네비 — 로고 + (로그인 / 마이페이지). 요금·구독은 랜딩에서 한 번에 처리.
export default function Nav() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => { captureHandoff(); setAuthed(!!getToken()); }, []);

  return (
    <nav className="nav">
      <a href="/" style={{ display: 'flex', alignItems: 'center' }}>
        <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
      </a>
      <span style={{ flex: 1 }} />
      <a href="/download" style={{ marginRight: 18 }}>PC 앱 다운로드</a>
      {authed
        ? <a href="/me">마이페이지</a>
        : <a href="/login" className="muted">로그인</a>}
    </nav>
  );
}
