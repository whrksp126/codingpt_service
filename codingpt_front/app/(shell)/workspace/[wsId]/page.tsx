'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { getWorkspace, listSessions, createSession } from '@/lib/workspaces';
import { useAgentSession } from '@/hooks/useAgentSession';
import Chat from '@/components/agent/Chat';
import Preview from '@/components/agent/Preview';
import PermissionModal from '@/components/agent/PermissionModal';
import FileTree from '@/components/agent/FileTree';
import type { WorkspaceMeta, SessionMeta } from '@/lib/agentTypes';

// Monaco/xterm 은 window 의존 + React Context 라 SSR/SSG 시 프리렌더가 깨진다 — 클라 전용(ssr:false).
const Editor = dynamic(() => import('@/components/agent/Editor'), { ssr: false });
const Terminal = dynamic(() => import('@/components/agent/Terminal'), { ssr: false });

// 바이브코딩 코딩 화면 — 앱셸 콘텐츠 영역을 채운다(사이드바 유지).
// 데스크톱: [채팅] | 탐색기(고정) · 에디터(고정) · [미리보기|터미널 토글].
// 좁은 화면: 채팅/파일/코드/미리보기/터미널 단일 패널 + 하단 탭.

export default function WorkspacePage() {
  const router = useRouter();
  const params = useParams();
  const search = useSearchParams();
  const wsId = String(params.wsId);

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
    if (!getToken()) { router.replace(`/login?next=/workspace/${wsId}`); return; }
    getWorkspace(wsId).then(setWs).catch(() => router.replace('/workspace'));
    ensureSession().catch(() => { /* noop */ });
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sessionId) {
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

type RightPanel = 'preview' | 'terminal' | null;
type Pane = 'chat' | 'files' | 'editor' | 'preview' | 'terminal';

function CodingView({
  wsId, ws, sessionId, sessions, onNewChat, onPickSession,
}: {
  wsId: string; ws: WorkspaceMeta | null; sessionId: string; sessions: SessionMeta[];
  onNewChat: () => void; onPickSession: (id: string) => void;
}) {
  const router = useRouter();
  const limitHit = useRef(false);
  const [narrow, setNarrow] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);                       // 데스크톱: 채팅 열림
  const [rightPanel, setRightPanel] = useState<RightPanel>('preview');  // 데스크톱: 우측 토글(미리보기/터미널)
  const [pane, setPane] = useState<Pane>('chat');                       // 좁은 화면: 활성 단일 패널
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const agent = useAgentSession(wsId, sessionId, {
    mode: ws?.kind === 'chat' ? 'chat' : 'code',
    onLimit: () => {
      if (limitHit.current) return;
      limitHit.current = true;
      alert('사용량 한도에 도달했어요. 플랜을 업그레이드하면 계속할 수 있어요.');
      router.push('/me');
    },
  });

  // 턴 종료 → 프리뷰/파일트리 새로고침
  useEffect(() => agent.subscribe((evt) => { if (evt.type === 'done') setReloadSignal((n) => n + 1); }), [agent]);

  const pickFile = (p: string | null) => { setSelectedFile(p); if (narrow && p) setPane('editor'); };
  // 데스크톱 우측 패널 토글(같은 걸 누르면 닫힘)
  const toggleRight = (v: 'preview' | 'terminal') => setRightPanel((cur) => (cur === v ? null : v));

  const chatPane = (
    <Chat messages={agent.messages} running={agent.running} loading={agent.loading} onSend={agent.send} onAbort={agent.abort} />
  );
  const filesPane = <FileTree wsId={wsId} selected={selectedFile} onSelect={pickFile} reloadSignal={reloadSignal} />;
  const editorPane = <Editor wsId={wsId} path={selectedFile} />;
  const previewPane = <Preview wsId={wsId} reloadSignal={reloadSignal} />;
  const terminalPane = <Terminal wsId={wsId} />;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--base)', minHeight: 0 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => router.push('/workspace')} style={ghostBtn} aria-label="목록">←</button>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{ws?.name || '프로젝트'}</div>
        <div style={{ flex: 1 }} />
        {!narrow ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setChatOpen((v) => !v)} style={tabBtn(chatOpen)}>채팅</button>
            <button onClick={() => toggleRight('preview')} style={tabBtn(rightPanel === 'preview')}>미리보기</button>
            <button onClick={() => toggleRight('terminal')} style={tabBtn(rightPanel === 'terminal')}>터미널</button>
          </div>
        ) : null}
        <select value={sessionId} onChange={(e) => onPickSession(e.target.value)} style={selectStyle}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || '새 채팅'}</option>)}
        </select>
        <button onClick={onNewChat} style={ghostBtn}>+ 채팅</button>
      </div>

      {/* 본문 */}
      {!narrow ? (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {chatOpen ? (
            <div style={{ width: 360, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {chatPane}
            </div>
          ) : null}
          {/* IDE: 탐색기(고정) · 에디터(고정) · 우측 토글 패널 */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
            <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', minHeight: 0 }}>{filesPane}</div>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{editorPane}</div>
            {rightPanel ? (
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                {rightPanel === 'preview' ? previewPane : terminalPane}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {pane === 'chat' ? <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{chatPane}</div>
              : pane === 'files' ? filesPane
              : pane === 'editor' ? editorPane
              : pane === 'preview' ? previewPane
              : terminalPane}
          </div>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'space-around', padding: '8px 10px', borderTop: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
            {(['chat', 'files', 'editor', 'preview', 'terminal'] as Pane[]).map((p) => (
              <button key={p} onClick={() => setPane(p)} style={tabBtn(pane === p)}>{PANE_LABEL[p]}</button>
            ))}
          </div>
        </div>
      )}

      <PermissionModal pending={agent.pendingPermission} onResolve={agent.resolvePermission} />
    </div>
  );
}

const PANE_LABEL: Record<Pane, string> = { chat: '채팅', files: '파일', editor: '코드', preview: '미리보기', terminal: '터미널' };
const ghostBtn: React.CSSProperties = { padding: '7px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' };
const selectStyle: React.CSSProperties = { padding: '7px 9px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12.5, maxWidth: 150 };
const tabBtn = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: active ? 'var(--accent-tint)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text2)', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' });
