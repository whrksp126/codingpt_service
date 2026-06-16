'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { captureHandoff, getToken } from '@/lib/auth';
import { getWorkspace, listSessions, createSession } from '@/lib/workspaces';
import { useAgentSession } from '@/hooks/useAgentSession';
import Chat from '@/components/agent/Chat';
import Preview from '@/components/agent/Preview';
import PermissionModal from '@/components/agent/PermissionModal';
import FileTree from '@/components/agent/FileTree';
import type { WorkspaceMeta, SessionMeta } from '@/lib/agentTypes';

// Monaco/xterm 은 window 의존 + React Context 라 SSR/SSG 시 번들에 들어가면 프리렌더가 깨진다(useContext null).
// 클라이언트 전용(ssr:false)으로 분리 — 다른 정적 페이지(랜딩/약관) 빌드에 영향 없게.
const Editor = dynamic(() => import('@/components/agent/Editor'), { ssr: false });
const Terminal = dynamic(() => import('@/components/agent/Terminal'), { ssr: false });

// 바이브코딩 코딩 화면 — 채팅(좌) + IDE/프리뷰/터미널(우). 세션 전환/생성.

export default function WorkspacePage() {
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();
  const wsId = String(params.wsId);

  const [authed, setAuthed] = useState(false);
  const [ws, setWs] = useState<WorkspaceMeta | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const ensureSession = useCallback(async () => {
    const list = await listSessions(wsId);
    const wanted = search.get('s');
    let active = (wanted && list.find((s) => s.id === wanted)?.id) || list[0]?.id;
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
    if (!getToken()) { router.replace(`/login?next=/workspace/${wsId}`); return; }
    setAuthed(true);
    getWorkspace(wsId).then(setWs).catch(() => router.replace('/workspace'));
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
      onNewChat={async () => {
        const created = await createSession(wsId);
        setSessions((p) => [created, ...p]);
        setSessionId(created.id);
        router.replace(`/workspace/${wsId}?s=${created.id}`);
      }}
      onPickSession={(id) => { setSessionId(id); router.replace(`/workspace/${wsId}?s=${id}`); }}
    />
  );
}

type RightView = 'code' | 'preview' | 'terminal';

function CodingView({
  wsId, ws, sessionId, sessions, onNewChat, onPickSession,
}: {
  wsId: string; ws: WorkspaceMeta | null; sessionId: string; sessions: SessionMeta[];
  onNewChat: () => void; onPickSession: (id: string) => void;
}) {
  const router = useRouter();
  const limitHit = useRef(false);
  const [rightView, setRightView] = useState<RightView>('preview');
  const [mobileChat, setMobileChat] = useState(true); // 모바일: 채팅 vs 우측뷰
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);

  const agent = useAgentSession(wsId, sessionId, {
    mode: ws?.kind === 'chat' ? 'chat' : 'code',
    onLimit: () => {
      if (limitHit.current) return;
      limitHit.current = true;
      alert('사용량 한도에 도달했어요. 플랜을 업그레이드하면 계속할 수 있어요.');
      router.push('/#plans');
    },
  });

  // 턴 종료 → 프리뷰/파일트리 새로고침
  useEffect(() => agent.subscribe((evt) => { if (evt.type === 'done') setReloadSignal((n) => n + 1); }), [agent]);

  const pickTab = (v: RightView) => { setRightView(v); setMobileChat(false); };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'flex', flexDirection: 'column', background: 'var(--base)' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => router.push('/workspace')} style={ghostBtn} aria-label="목록">←</button>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>{ws?.name || '프로젝트'}</div>
        <div style={{ flex: 1 }} />
        {/* 우측 뷰 탭(데스크톱 전용) */}
        <div className="cpt-desktop-tabs" style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => pickTab('code')} style={tabBtn(rightView === 'code')}>코드</button>
          <button onClick={() => pickTab('preview')} style={tabBtn(rightView === 'preview')}>미리보기</button>
          <button onClick={() => pickTab('terminal')} style={tabBtn(rightView === 'terminal')}>터미널</button>
        </div>
        <select value={sessionId} onChange={(e) => onPickSession(e.target.value)} style={selectStyle}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || '새 채팅'}</option>)}
        </select>
        <button onClick={onNewChat} style={ghostBtn}>+ 채팅</button>
      </div>

      {/* 본문 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div className={`cpt-pane-chat ${mobileChat ? 'cpt-active' : ''}`} style={{ flex: '1 1 0', minWidth: 0, borderRight: '1px solid var(--border)', display: 'flex' }}>
          <div style={{ width: '100%', maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Chat messages={agent.messages} running={agent.running} loading={agent.loading} onSend={agent.send} onAbort={agent.abort} />
          </div>
        </div>

        <div className={`cpt-pane-right ${!mobileChat ? 'cpt-active' : ''}`} style={{ flex: '1.2 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {rightView === 'code' ? (
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ width: 220, flexShrink: 0 }}>
                <FileTree wsId={wsId} selected={selectedFile} onSelect={setSelectedFile} reloadSignal={reloadSignal} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Editor wsId={wsId} path={selectedFile} />
              </div>
            </div>
          ) : rightView === 'preview' ? (
            <Preview wsId={wsId} reloadSignal={reloadSignal} />
          ) : (
            <Terminal wsId={wsId} />
          )}
        </div>
      </div>

      {/* 모바일 하단 탭(채팅 복귀) */}
      <div className="cpt-mobile-bar" style={{ display: 'none' }}>
        <button onClick={() => setMobileChat(true)} style={tabBtn(mobileChat)}>채팅</button>
        <button onClick={() => pickTab('code')} style={tabBtn(!mobileChat && rightView === 'code')}>코드</button>
        <button onClick={() => pickTab('preview')} style={tabBtn(!mobileChat && rightView === 'preview')}>미리보기</button>
        <button onClick={() => pickTab('terminal')} style={tabBtn(!mobileChat && rightView === 'terminal')}>터미널</button>
      </div>

      <PermissionModal pending={agent.pendingPermission} onResolve={agent.resolvePermission} />
    </div>
  );
}

const ghostBtn: React.CSSProperties = { padding: '7px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle: React.CSSProperties = { padding: '7px 9px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12.5, maxWidth: 150 };
const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: active ? 'var(--accent-tint)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' });
