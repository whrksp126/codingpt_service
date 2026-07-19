'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, redeemHandoffCode } from '@/lib/auth';
import Sidebar from '@/components/shell/Sidebar';

// 인증 앱셸 — 좌측 고정 사이드바 + 콘텐츠. <1024px 는 햄버거 오버레이 드로어.
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await redeemHandoffCode(); // ?hc= 일회용 코드 → 토큰 교환(있을 때만)
      if (cancelled) return;
      if (!getToken()) { router.replace(`/login?next=${encodeURIComponent(pathname)}`); return; }
      setAuthed(true);
    })();
    return () => { cancelled = true; };
  }, [pathname, router]);

  // 라우트 이동 시 모바일 드로어 닫기
  useEffect(() => { setDrawer(false); }, [pathname]);

  if (!authed) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;

  return (
    <div className="shell">
      <aside className={`shell-sidebar ${drawer ? 'open' : ''}`}>
        <Sidebar onNavigate={() => setDrawer(false)} />
      </aside>
      <div className={`shell-backdrop ${drawer ? 'open' : ''}`} onClick={() => setDrawer(false)} />

      <div className="shell-content">
        <div className="shell-topbar">
          <button onClick={() => setDrawer(true)} aria-label="메뉴" style={{ background: 'transparent', border: 'none', color: 'var(--text2)', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </button>
          <img src="/logo.png" alt="CodingPT" height={20} style={{ display: 'block' }} />
        </div>
        <div className="shell-scroll">{children}</div>
      </div>
    </div>
  );
}
