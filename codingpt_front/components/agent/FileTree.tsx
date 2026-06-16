'use client';

import { useCallback, useEffect, useState } from 'react';
import { listAgentFiles, writeAgentFile } from '@/lib/agent';
import type { FileNode } from '@/lib/agentTypes';
import { FileTypeIcon } from '@/components/ide/FileTypeIcon';
import { FilePlus, FolderPlus, DownloadSimple } from '@phosphor-icons/react';

// 앱 MobileIDE 탐색기와 동일 디자인 — ▾/▸ 트리 + FileTypeIcon + active #1F2430.
// GET /api/agent/files. 파일 클릭 → onSelect(path).

function Node({ node, depth, selected, onSelect }: { node: FileNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', paddingTop: 5, paddingBottom: 5, paddingLeft: depth * 14 + 8 }}
        >
          <span style={{ color: '#94A3B8', fontSize: 11, width: 10 }}>{open ? '▾' : '▸'}</span>
          <span style={{ color: '#E2E8F0', fontSize: 13 }}>{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
      </div>
    );
  }
  const active = selected === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', paddingTop: 5, paddingBottom: 5, paddingRight: 8, paddingLeft: depth * 14 + 22, background: active ? '#1F2430' : 'transparent', borderRadius: 4 }}
    >
      <FileTypeIcon name={node.name} />
      <span style={{ color: active ? '#fff' : '#CBD5E1', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
    </button>
  );
}

export default function FileTree({ wsId, projectName, selected, onSelect, reloadSignal }: { wsId: string; projectName?: string; selected: string | null; onSelect: (p: string) => void; reloadSignal?: number }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);

  const load = useCallback(() => {
    listAgentFiles(wsId).then(setTree).catch(() => setTree([]));
  }, [wsId]);

  useEffect(() => { load(); }, [load, reloadSignal]);

  // 새 파일/폴더 — 빈 파일/.gitkeep 작성 후 트리 갱신.
  const createEntry = useCallback(async (kind: 'file' | 'folder') => {
    const raw = (typeof window !== 'undefined' ? window.prompt(kind === 'folder' ? '새 폴더 이름 (예: components)' : '새 파일 이름 (예: index.html)') : '')?.trim().replace(/^\/+|\/+$/g, '');
    if (!raw) return;
    const path = kind === 'folder' ? `${raw}/.gitkeep` : raw;
    try { await writeAgentFile(path, '', wsId); load(); if (kind === 'file') onSelect(path); } catch { /* noop */ }
  }, [wsId, load, onSelect]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0A0D14', borderRight: '1px solid #1C2230' }}>
      {/* 탐색기 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 12, paddingRight: 6, paddingTop: 6, paddingBottom: 6, flexShrink: 0 }}>
        <span style={{ color: '#64748B', fontSize: 12, flex: 1 }}>탐색기</span>
        <button onClick={() => createEntry('file')} aria-label="새 파일" style={{ padding: 5, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}>
          <FilePlus size={16} color="#94A3B8" />
        </button>
        <button onClick={() => createEntry('folder')} aria-label="새 폴더" style={{ padding: 5, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}>
          <FolderPlus size={16} color="#94A3B8" />
        </button>
        <button onClick={load} aria-label="새로고침" style={{ padding: 5, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}>
          <DownloadSimple size={16} color="#94A3B8" style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
        <div style={{ color: '#94A3B8', fontSize: 13, fontWeight: 700, paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4 }}>▾ {projectName || '작업영역'}</div>
        {tree === null ? (
          <div style={{ padding: 14, color: '#475569', fontSize: 12.5 }}>불러오는 중…</div>
        ) : tree.length === 0 ? (
          <div style={{ padding: 14, color: '#475569', fontSize: 12.5, lineHeight: 1.6 }}>아직 파일이 없어요.<br />채팅으로 만들어 보세요.</div>
        ) : (
          tree.map((n) => <Node key={n.path} node={n} depth={0} selected={selected} onSelect={onSelect} />)
        )}
      </div>
    </div>
  );
}
