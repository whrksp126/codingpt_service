'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { GraduationCap, Gear } from '@phosphor-icons/react';

// 앱 src/components/AppDrawer.tsx 를 웹 고정 사이드바로 이식.
// M0(BYO 피벗): 채팅/워크스페이스 나비·최근 세션은 웹 AI 동결로 제거. 프로필·설정(→ 내정보)만 유지.
const SHOW_LEARN = false; // 배우기(레슨 플레이어) 포팅 전까지 숨김 — 추후 true.

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [nickname, setNickname] = useState('코더');

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    clientFetch<any>('/api/users/me', { token }).then((r) => {
      const u = r.data || {};
      setNickname(u.nickname || u.name || u.username || '코더');
    }).catch(() => { /* noop */ });
  }, [pathname]);

  const go = (href: string) => { router.push(href); onNavigate?.(); };
  const isActive = (href: string) => pathname.startsWith(href);

  const NAV = [
    ...(SHOW_LEARN ? [{ href: '/learn', label: '배우기', Icon: GraduationCap }] : []),
  ];

  const avatar = String(nickname).trim().charAt(0) || '코';

  return (
    <>
      {/* 헤더: 로고 */}
      <div style={{ padding: '12px 16px', flexShrink: 0 }}>
        <button onClick={() => go('/me')} style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }} aria-label="CodingPT">
          <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
        </button>
      </div>

      {/* 네비게이션 */}
      <nav style={{ padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        {NAV.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <button
              key={href}
              onClick={() => go(href)}
              style={{
                display: 'flex', alignItems: 'center', height: 46, paddingLeft: 12, paddingRight: 12,
                borderRadius: 10, border: 'none', cursor: 'pointer',
                background: active ? 'var(--accent-tint)' : 'transparent',
              }}
            >
              <span style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', marginRight: 14 }}>
                <Icon size={19} weight={active ? 'fill' : 'regular'} color={active ? 'var(--accent)' : 'var(--text2)'} />
              </span>
              <span style={{ color: active ? 'var(--accent)' : 'var(--text)', fontSize: 14.5, fontWeight: 500 }}>{label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minHeight: 0 }} />

      {/* 푸터: 프로필 + 설정 → 내정보 */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => go('/me')} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px', borderRadius: 10, border: 'none', background: 'transparent', cursor: 'pointer' }}>
          <span style={{ width: 34, height: 34, borderRadius: 17, background: 'var(--accent-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 700 }}>{avatar}</span>
          </span>
          <span style={{ flex: 1, minWidth: 0, color: 'var(--text)', fontSize: 14, fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nickname}</span>
        </button>
        <button onClick={() => go('/me')} aria-label="설정" style={{ width: 40, height: 40, borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer' }}>
          <Gear size={20} color="var(--text2)" />
        </button>
      </div>
    </>
  );
}
