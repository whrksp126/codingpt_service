'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { captureHandoff, getToken } from '@/lib/auth';
import { getWorkspace, listSessions, createSession } from '@/lib/workspaces';
import { useAgentSession } from '@/hooks/useAgentSession';
import Chat from '@/components/agent/Chat';
import Preview from '@/components/agent/Preview';
import PermissionModal from '@/components/agent/PermissionModal';
import type { WorkspaceMeta, SessionMeta } from '@/lib/agentTypes';

// 바이브코딩 코딩 화면 — 채팅(좌) + 라이브 프리뷰(우). 세션 전환/생성.

export default function WorkspacePage() {
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();
  const wsId = String(params.wsId);

  const [authed, setAuthed] = useState(false);
  const [ws, setWs] = useState<WorkspaceMeta | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'chat' | 'preview'>('chat');
  const [reloadSignal, setReloadSignal] = useState(0);

  // 세션 결정: ?s= → 최신 → 없으면 생성
  const ensureSession = useCallback(async () => {
    const list = await listSessions(wsId);
    const wanted = search.get('s');
    let active = wanted && list.find((s) => s.id === wanted)?.id;
    if (!active) active = list[0]?.id;
    if (!active) {
      const created = await createSession(wsId);
      active = created.id;
      setSessions([created]);
    } else {
      setSessions(list);
    }
    setSessionId(active);
  }, [wsId, search]);

  useEffect(() => {
    captureHandoff();
    if (!getToken()) { router.replace(`/login?next=/app/${wsId}`); return; }
    setAuthed(true);
    getWorkspace(wsId).then(setWs).catch(() => router.replace('/app'));
    ensureSession().catch(() => { /* noop */ });
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!authed || !sessionId) {
    return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;
  }

  return (
    <CodingView
      wsId={wsId}
      ws={ws}
      sessionId={sessionId}
      sessions={sessions}
      mobileTab={mobileTab}
      setMobileTab={setMobileTab}
      reloadSignal={reloadSignal}
      onTurnDone={() => setReloadSignal((n) => n + 1)}
      onNewChat={async () => {
        const created = await createSession(wsId);
        setSessions((p) => [created, ...p]);
        setSessionId(created.id);
        router.replace(`/app/${wsId}?s=${created.id}`);
      }}
      onPickSession={(id) => { setSessionId(id); router.replace(`/app/${wsId}?s=${id}`); }}
    />
  );
}

function CodingView({
  wsId, ws, sessionId, sessions, mobileTab, setMobileTab, reloadSignal, onTurnDone, onNewChat, onPickSession,
}: {
  wsId: string; ws: WorkspaceMeta | null; sessionId: string; sessions: SessionMeta[];
  mobileTab: 'chat' | 'preview'; setMobileTab: (t: 'chat' | 'preview') => void;
  reloadSignal: number; onTurnDone: () => void;
  onNewChat: () => void; onPickSession: (id: string) => void;
}) {
  const router = useRouter();
  const limitHit = useRef(false);
  const agent = useAgentSession(wsId, sessionId, {
    mode: ws?.kind === 'chat' ? 'chat' : 'code',
    onLimit: () => {
      if (limitHit.current) return;
      limitHit.current = true;
      alert('사용량 한도에 도달했어요. 플랜을 업그레이드하면 계속할 수 있어요.');
      router.push('/#plans');
    },
  });

  // 턴 종료 시 프리뷰 새로고침 트리거
  useEffect(() => agent.subscribe((evt) => { if (evt.type === 'done') onTurnDone(); }), [agent, onTurnDone]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'flex', flexDirection: 'column', background: 'var(--base)' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => router.push('/app')} style={ghostBtn} aria-label="목록">←</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ws?.name || '프로젝트'}</div>
        </div>
        <div style={{ flex: 1 }} />
        <select value={sessionId} onChange={(e) => onPickSession(e.target.value)} style={selectStyle}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || '새 채팅'}</option>)}
        </select>
        <button onClick={onNewChat} style={ghostBtn}>+ 새 채팅</button>
        {/* 모바일 탭 */}
        <div className="cpt-mobile-tabs" style={{ display: 'none', gap: 4 }}>
          <button onClick={() => setMobileTab('chat')} style={tabBtn(mobileTab === 'chat')}>채팅</button>
          <button onClick={() => setMobileTab('preview')} style={tabBtn(mobileTab === 'preview')}>미리보기</button>
        </div>
      </div>

      {/* 본문: 채팅 | 프리뷰 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div className={`cpt-pane-chat ${mobileTab === 'chat' ? 'cpt-active' : ''}`} style={{ flex: '1 1 0', minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex' }}>
          <div style={{ width: '100%', maxWidth: 620, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Chat
              messages={agent.messages}
              running={agent.running}
              loading={agent.loading}
              onSend={agent.send}
              onAbort={agent.abort}
            />
          </div>
        </div>
        <div className={`cpt-pane-preview ${mobileTab === 'preview' ? 'cpt-active' : ''}`} style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>
          <div style={{ width: '100%' }}><Preview wsId={wsId} reloadSignal={reloadSignal} /></div>
        </div>
      </div>

      <PermissionModal pending={agent.pendingPermission} onResolve={agent.resolvePermission} />
    </div>
  );
}

const ghostBtn: React.CSSProperties = { padding: '7px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, maxWidth: 180 };
const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: active ? 'var(--accent-tint)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text2)', fontSize: 13, cursor: 'pointer' });
