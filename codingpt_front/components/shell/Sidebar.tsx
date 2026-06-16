'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken, getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { listWorkspaces, listSessions } from '@/lib/workspaces';
import type { WorkspaceMeta, SessionMeta } from '@/lib/agentTypes';

// 배우기(레슨) 탭은 학습 플레이어 포팅 전까지 숨김 — 추후 true 로 복원.
const SHOW_LEARN = false;

type RecentSession = SessionMeta & { wsId: string; wsName: string; wsKind: 'chat' | 'project' };

// 좌측 고정 사이드바 = 앱 AppDrawer 상시화. 네비 + 최근 세션 + 프로필.
export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [profile, setProfile] = useState<{ name: string; email: string } | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    clientFetch<any>('/api/users/me', { token }).then((r) => {
      const u = r.data || {};
      setProfile({ name: u.nickname || u.name || u.username || '내 계정', email: u.email || '' });
    }).catch(() => { /* noop */ });

    (async () => {
      try {
        const wss = await listWorkspaces();
        const lists = await Promise.all(wss.map(async (w) => {
          try {
            const ss = await listSessions(w.id);
            return ss.map((s) => ({ ...s, wsId: w.id, wsName: w.name, wsKind: w.kind }));
          } catch { return [] as RecentSession[]; }
        }));
        const flat = lists.flat() as RecentSession[];
        flat.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        setRecents(flat.slice(0, 12));
      } catch { /* noop */ }
    })();
  }, [pathname]);

  const go = (href: string) => { router.push(href); onNavigate?.(); };
  const isActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href);

  const NAV = [
    { href: '/chat', label: '채팅', icon: IconChat },
    ...(SHOW_LEARN ? [{ href: '/learn', label: '배우기', icon: IconLearn }] : []),
    { href: '/workspace', label: '워크스페이스', icon: IconWorkspace },
    { href: '/me', label: '내정보', icon: IconUser },
  ];

  const openRecent = (s: RecentSession) => {
    if (s.wsKind === 'chat') go('/chat');
    else go(`/workspace/${s.wsId}?s=${s.id}`);
  };

  const logout = () => { clearToken(); router.push('/'); };

  return (
    <>
      <div style={{ padding: '16px 16px 8px', flexShrink: 0 }}>
        <button onClick={() => go('/chat')} style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }} aria-label="CodingPT">
          <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
        </button>
      </div>

      <nav style={{ padding: '4px 10px', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        {NAV.map(({ href, label, icon: Icon }) => (
          <button key={href} className={`shell-nav-item ${isActive(href) ? 'active' : ''}`} onClick={() => go(href)}>
            <Icon active={isActive(href)} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 10px 8px' }}>
        {recents.length > 0 ? (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--dim)', letterSpacing: '0.02em', padding: '4px 12px 8px' }}>최근 세션</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {recents.map((s) => (
                <button key={`${s.wsId}:${s.id}`} className="shell-session-item" onClick={() => openRecent(s)} title={s.title || '새 채팅'}>
                  {s.title || s.preview || '새 채팅'}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 999, background: 'var(--accent-tint)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
          {(profile?.name || '?').slice(0, 1)}
        </div>
        <button onClick={() => go('/me')} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile?.name || '내 계정'}</div>
          {profile?.email ? <div style={{ fontSize: 11.5, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.email}</div> : null}
        </button>
        <button onClick={logout} title="로그아웃" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--dim)', padding: 4, flexShrink: 0 }} aria-label="로그아웃">
          <IconLogout />
        </button>
      </div>
    </>
  );
}

// ── 인라인 아이콘(앱 lucide 톤) ──
function IconChat({ active }: { active?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}
function IconWorkspace({ active }: { active?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
}
function IconUser({ active }: { active?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
}
function IconLearn({ active }: { active?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>;
}
function IconLogout() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>;
}
