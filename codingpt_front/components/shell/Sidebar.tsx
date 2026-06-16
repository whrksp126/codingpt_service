'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { clientFetch } from '@/lib/api';
import { listWorkspaces, listSessions } from '@/lib/workspaces';
import type { SessionMeta } from '@/lib/agentTypes';
import { ChatCircleDots, Folders, GraduationCap, Gear } from '@phosphor-icons/react';

// 앱 src/components/AppDrawer.tsx 를 웹 고정 사이드바로 1:1 이식.
// 네비(채팅/워크스페이스/배우기) + 최근 세션 + 푸터(프로필·설정 → 내정보). 내정보는 별도 nav 행이 아님.
const SHOW_LEARN = false; // 배우기(레슨 플레이어) 포팅 전까지 숨김 — 추후 true.

type RecentSession = SessionMeta & { wsId: string; wsName: string; wsKind: 'chat' | 'project' };

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [nickname, setNickname] = useState('코더');

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    clientFetch<any>('/api/users/me', { token }).then((r) => {
      const u = r.data || {};
      setNickname(u.nickname || u.name || u.username || '코더');
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
        const flat = (lists.flat() as RecentSession[]).filter((s) => s.wsKind === 'project');
        flat.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        setRecents(flat.slice(0, 15));
      } catch { /* noop */ }
    })();
  }, [pathname]);

  const go = (href: string) => { router.push(href); onNavigate?.(); };
  const isActive = (href: string) => pathname.startsWith(href);

  const NAV = [
    { href: '/chat', label: '채팅', Icon: ChatCircleDots },
    { href: '/workspace', label: '워크스페이스', Icon: Folders },
    ...(SHOW_LEARN ? [{ href: '/learn', label: '배우기', Icon: GraduationCap }] : []),
  ];

  const avatar = String(nickname).trim().charAt(0) || '코';

  return (
    <>
      {/* 헤더: 로고 */}
      <div style={{ padding: '12px 16px', flexShrink: 0 }}>
        <button onClick={() => go('/chat')} style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }} aria-label="CodingPT">
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

      {/* 최근 세션 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, letterSpacing: '0.4px', color: 'var(--dim)', marginTop: 18, marginBottom: 4, paddingLeft: 12 }}>최근 세션</div>
        {recents.length === 0 ? (
          <div style={{ color: 'var(--dim)', fontSize: 12.5, padding: '8px 12px' }}>최근 세션이 없어요</div>
        ) : (
          recents.map((s) => (
            <button
              key={`${s.wsId}:${s.id}`}
              onClick={() => go(`/workspace/${s.wsId}?s=${s.id}`)}
              title={s.title || '새 채팅'}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 10, border: 'none', background: 'transparent', cursor: 'pointer' }}
            >
              <ChatCircleDots size={16} color="var(--dim)" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', color: 'var(--text2)', fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || '새 채팅'}</span>
                <span style={{ display: 'block', color: 'var(--dim)', fontSize: 11, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.wsName}{s.updatedAt ? ` · ${relShort(s.updatedAt)}` : ''}</span>
              </span>
            </button>
          ))
        )}
      </div>

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

// 짧은 상대시간 (앱 relShort 동일)
function relShort(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const min = Math.floor((Date.now() - d) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  return `${Math.floor(day / 7)}주 전`;
}
