'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { listWorkspaces, createWorkspace, listSessions, createSession } from '@/lib/workspaces';
import { useAgentSession } from '@/hooks/useAgentSession';
import Chat from '@/components/agent/Chat';
import PermissionModal from '@/components/agent/PermissionModal';
import LimitModal from '@/components/billing/LimitModal';
import type { SessionMeta } from '@/lib/agentTypes';

// 채팅 탭 — 메인 채팅(kind:'chat' 워크스페이스, 단일 패널). 앱 HomeScreen 의 채팅에 해당.
export default function ChatPage() {
  const router = useRouter();
  const [wsId, setWsId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // 메인 채팅 워크스페이스 보장(없으면 생성) → 최신 세션 선택/생성. (앱 ensureChatWorkspace 포팅)
  const boot = useCallback(async () => {
    const wss = await listWorkspaces();
    let chat = wss.find((w) => w.kind === 'chat');
    if (!chat) chat = await createWorkspace({ name: '채팅', kind: 'chat' });
    setWsId(chat.id);
    const ss = await listSessions(chat.id);
    if (ss.length) { setSessions(ss); setSessionId(ss[0].id); }
    else { const c = await createSession(chat.id); setSessions([c]); setSessionId(c.id); }
  }, []);

  useEffect(() => {
    if (!getToken()) { router.replace('/login?next=/chat'); return; }
    boot().catch(() => { /* noop */ });
  }, [boot, router]);

  const newChat = async () => {
    if (!wsId) return;
    const c = await createSession(wsId);
    setSessions((p) => [c, ...p]);
    setSessionId(c.id);
  };

  if (!wsId || !sessionId) {
    return <div style={{ padding: 48, textAlign: 'center', color: 'var(--dim)' }}>불러오는 중…</div>;
  }

  return <ChatView wsId={wsId} sessionId={sessionId} sessions={sessions} onPick={setSessionId} onNew={newChat} />;
}

function ChatView({
  wsId, sessionId, sessions, onPick, onNew,
}: {
  wsId: string; sessionId: string; sessions: SessionMeta[]; onPick: (id: string) => void; onNew: () => void;
}) {
  const [limit, setLimit] = useState<any>(null);
  const agent = useAgentSession(wsId, sessionId, {
    mode: 'chat',
    onLimit: (info) => setLimit(info || { code: 'USAGE_LIMIT_REACHED' }),
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.02em' }}>채팅</div>
        <div style={{ flex: 1 }} />
        <select value={sessionId} onChange={(e) => onPick(e.target.value)} style={selectStyle}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || '새 채팅'}</option>)}
        </select>
        <button onClick={onNew} style={ghostBtn}>+ 새 채팅</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Chat messages={agent.messages} running={agent.running} loading={agent.loading} onSend={agent.send} onAbort={agent.abort} />
        </div>
      </div>

      <PermissionModal pending={agent.pendingPermission} onResolve={agent.resolvePermission} />
      <LimitModal info={limit} onClose={() => setLimit(null)} />
    </div>
  );
}

const ghostBtn: React.CSSProperties = { padding: '7px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle: React.CSSProperties = { padding: '7px 9px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12.5, maxWidth: 180 };
