'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getToken } from '@/lib/auth';
import { getWorkspace, listSessions, createSession } from '@/lib/workspaces';
import { useAgentSession } from '@/hooks/useAgentSession';
import Chat from '@/components/agent/Chat';
import Preview from '@/components/agent/Preview';
import PermissionModal from '@/components/agent/PermissionModal';
import LimitModal from '@/components/billing/LimitModal';
import FileTree from '@/components/agent/FileTree';
import { FileTypeIcon } from '@/components/ide/FileTypeIcon';
import { TerminalIcon, BrowserIcon } from '@/components/ide/ideIcons';
import type { WorkspaceMeta, SessionMeta } from '@/lib/agentTypes';

const Editor = dynamic(() => import('@/components/agent/Editor'), { ssr: false });
const Terminal = dynamic(() => import('@/components/agent/Terminal'), { ssr: false });

// 바이브코딩 코딩 화면 — 앱 MobileIDE 디자인을 그대로 따른다(색/아이콘/탭/breadcrumb 동일).
// [채팅] | 탐색기(고정) · 에디터(탭+breadcrumb, 고정) · 터미널(하단 토글) + 브라우저(오버레이 토글).

const baseOf = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

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
    if (!active) { const c = await createSession(wsId); active = c.id; setSessions([c]); }
    else setSessions(list);
    setSessionId(active);
  }, [wsId, search]);

  useEffect(() => {
    if (!getToken()) { router.replace(`/login?next=/workspace/${wsId}`); return; }
    getWorkspace(wsId).then(setWs).catch(() => router.replace('/workspace'));
    ensureSession().catch(() => { /* noop */ });
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sessionId) {
    return <div style={{ padding: 48, textAlign: 'center', color: '#475569', background: '#0A0D14', height: '100%' }}>불러오는 중…</div>;
  }

  return (
    <CodingView
      wsId={wsId} ws={ws} sessionId={sessionId} sessions={sessions}
      onNewChat={async () => {
        const c = await createSession(wsId);
        setSessions((p) => [c, ...p]); setSessionId(c.id);
        router.replace(`/workspace/${wsId}?s=${c.id}`);
      }}
      onPickSession={(id) => { setSessionId(id); router.replace(`/workspace/${wsId}?s=${id}`); }}
    />
  );
}

type Pane = 'chat' | 'files' | 'editor' | 'preview' | 'terminal';

// 상단바 토글 버튼 — 앱 TopBarButton(padding 6, radius 6, active bg #2A2F3A)
function TopBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ padding: 6, borderRadius: 6, border: 'none', cursor: 'pointer', background: active ? '#2A2F3A' : 'transparent', display: 'flex' }}>
      {children}
    </button>
  );
}

function CodingView({
  wsId, ws, sessionId, sessions, onNewChat, onPickSession,
}: {
  wsId: string; ws: WorkspaceMeta | null; sessionId: string; sessions: SessionMeta[];
  onNewChat: () => void; onPickSession: (id: string) => void;
}) {
  const router = useRouter();
  const [limit, setLimit] = useState<any>(null);
  const projectName = ws?.name || '작업영역';
  const [narrow, setNarrow] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [pane, setPane] = useState<Pane>('chat');

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const agent = useAgentSession(wsId, sessionId, {
    mode: ws?.kind === 'chat' ? 'chat' : 'code',
    onLimit: (info) => setLimit(info || { code: 'USAGE_LIMIT_REACHED' }),
  });
  useEffect(() => agent.subscribe((evt) => { if (evt.type === 'done') setReloadSignal((n) => n + 1); }), [agent]);

  const openFile = (path: string) => {
    setOpenTabs((t) => (t.includes(path) ? t : [...t, path]));
    setActivePath(path);
    if (narrow) setPane('editor');
  };
  const closeTab = (path: string) => {
    setOpenTabs((t) => {
      const idx = t.indexOf(path);
      const next = t.filter((p) => p !== path);
      if (activePath === path) setActivePath(next[idx] || next[idx - 1] || null);
      return next;
    });
  };

  // ── 패널 ──
  const chatPane = <Chat messages={agent.messages} running={agent.running} loading={agent.loading} onSend={agent.send} onAbort={agent.abort} onOpenFile={openFile} />;
  const filesPane = <FileTree wsId={wsId} projectName={projectName} selected={activePath} onSelect={openFile} reloadSignal={reloadSignal} />;
  const tabBar = openTabs.length > 0 ? (
    <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid #1C2230', background: '#0A0D14', flexShrink: 0 }}>
      {openTabs.map((p) => {
        const active = p === activePath;
        return (
          <div
            key={p}
            onClick={() => setActivePath(p)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, borderRight: '1px solid #1C2230', background: active ? '#11151F' : 'transparent', borderTop: `2px solid ${active ? '#3B82F6' : 'transparent'}`, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <FileTypeIcon name={p} />
            <span style={{ color: active ? '#fff' : '#94A3B8', fontSize: 13 }}>{baseOf(p)}</span>
            <button onClick={(e) => { e.stopPropagation(); closeTab(p); }} aria-label="닫기" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, marginLeft: 2 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke={active ? '#fff' : '#64748B'} strokeWidth={2} strokeLinecap="round" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  ) : null;
  const breadcrumb = activePath ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8, flexShrink: 0 }}>
      <span style={{ color: '#94A3B8', fontSize: 13, fontWeight: 700 }}>{projectName}</span>
      <span style={{ color: '#475569', fontSize: 12 }}>›</span>
      <FileTypeIcon name={activePath} size={14} />
      <span style={{ color: '#94A3B8', fontSize: 13 }}>{baseOf(activePath)}</span>
    </div>
  ) : null;
  const editorColumn = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: '#0A0D14' }}>
      {tabBar}
      {breadcrumb}
      <div style={{ flex: 1, minHeight: 0 }}><Editor wsId={wsId} path={activePath} /></div>
      {!narrow && showTerminal ? (
        <div style={{ height: 280, flexShrink: 0 }}><Terminal wsId={wsId} projectName={projectName} onClose={() => setShowTerminal(false)} /></div>
      ) : null}
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0A0D14', minHeight: 0 }}>
      {/* 상단바 (앱 MobileIDE 헤더) */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, paddingRight: 14, height: 48, borderBottom: '1px solid #1C2230', flexShrink: 0 }}>
        <button onClick={() => router.push('/workspace')} aria-label="목록" style={{ marginRight: 12, background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span style={{ color: '#fff', fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{projectName}</span>
        <div style={{ flex: 1 }} />
        <select value={sessionId} onChange={(e) => onPickSession(e.target.value)} style={selectStyle}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || '새 채팅'}</option>)}
        </select>
        <button onClick={onNewChat} style={newChatBtn}>+ 채팅</button>
        {/* 큰 화면: 채팅·탐색기는 항상 열림 → 터미널/브라우저만 토글. 작은 화면: 하단 탭으로 관리. */}
        {!narrow ? (
          <>
            <div style={{ width: 1, height: 22, background: '#1C2230', marginLeft: 8, marginRight: 8 }} />
            <div style={{ display: 'flex', gap: 4 }}>
              <TopBtn active={showTerminal} onClick={() => setShowTerminal((v) => !v)}><TerminalIcon size={20} color="#fff" filled={showTerminal} /></TopBtn>
              <TopBtn active={showBrowser} onClick={() => setShowBrowser((v) => !v)}><BrowserIcon size={20} color="#fff" filled={showBrowser} /></TopBtn>
            </div>
          </>
        ) : null}
      </div>

      {/* 본문 */}
      {!narrow ? (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 채팅 — 큰 화면에서 항상 열림 */}
          <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid #1C2230', display: 'flex', flexDirection: 'column', minHeight: 0, background: '#0A0D14' }}>{chatPane}</div>
          {/* IDE */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0, position: 'relative' }}>
            <div style={{ width: 220, flexShrink: 0, minHeight: 0 }}>{filesPane}</div>
            {editorColumn}
            {showBrowser ? (
              <div style={{ position: 'absolute', inset: 0, zIndex: 5 }}>
                <Preview wsId={wsId} reloadSignal={reloadSignal} onClose={() => setShowBrowser(false)} />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {pane === 'chat' ? <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{chatPane}</div>
              : pane === 'files' ? filesPane
              : pane === 'editor' ? <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{tabBar}{breadcrumb}<div style={{ flex: 1, minHeight: 0 }}><Editor wsId={wsId} path={activePath} /></div></div>
              : pane === 'preview' ? <Preview wsId={wsId} reloadSignal={reloadSignal} />
              : <Terminal wsId={wsId} projectName={projectName} />}
          </div>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'space-around', paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, borderTop: '1px solid #1C2230', background: '#0E1320', flexShrink: 0 }}>
            {(['chat', 'files', 'editor', 'preview', 'terminal'] as Pane[]).map((p) => (
              <button key={p} onClick={() => setPane(p)} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', background: pane === p ? '#2A2F3A' : 'transparent', color: pane === p ? '#fff' : '#94A3B8', fontSize: 12.5, cursor: 'pointer' }}>{PANE_LABEL[p]}</button>
            ))}
          </div>
        </div>
      )}

      <PermissionModal pending={agent.pendingPermission} onResolve={agent.resolvePermission} />
      <LimitModal info={limit} onClose={() => setLimit(null)} />
    </div>
  );
}

const PANE_LABEL: Record<Pane, string> = { chat: '채팅', files: '파일', editor: '코드', preview: '미리보기', terminal: '터미널' };
const selectStyle: React.CSSProperties = { padding: '6px 9px', borderRadius: 8, border: '1px solid #1C2230', background: '#11151F', color: '#94A3B8', fontSize: 12.5, maxWidth: 150 };
const newChatBtn: React.CSSProperties = { marginLeft: 6, padding: '6px 11px', borderRadius: 8, border: '1px solid #1C2230', background: '#11151F', color: '#CBD5E1', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' };
