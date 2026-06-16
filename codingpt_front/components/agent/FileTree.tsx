'use client';

import { useCallback, useEffect, useState } from 'react';
import { listAgentFiles } from '@/lib/agent';
import type { FileNode } from '@/lib/agentTypes';

// 워크스페이스 파일 트리 — GET /api/agent/files. 파일 클릭 → onSelect(path).

function Node({ node, depth, selected, onSelect }: { node: FileNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const pad = 8 + depth * 12;
  if (node.type === 'directory') {
    return (
      <div>
        <button onClick={() => setOpen((o) => !o)} style={{ ...rowStyle, paddingLeft: pad, color: 'var(--text2)' }}>
          <span style={{ width: 12, display: 'inline-block', color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 600 }}>{node.name}</span>
        </button>
        {open && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
      </div>
    );
  }
  const active = selected === node.path;
  return (
    <button onClick={() => onSelect(node.path)} style={{ ...rowStyle, paddingLeft: pad + 12, background: active ? 'var(--hover)' : 'transparent', color: active ? 'var(--text)' : 'var(--text2)' }}>
      <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{node.name}</span>
    </button>
  );
}

export default function FileTree({ wsId, selected, onSelect, reloadSignal }: { wsId: string; selected: string | null; onSelect: (p: string) => void; reloadSignal?: number }) {
  const [tree, setTree] = useState<FileNode[] | null>(null);

  const load = useCallback(() => {
    listAgentFiles(wsId).then(setTree).catch(() => setTree([]));
  }, [wsId]);

  useEffect(() => { load(); }, [load, reloadSignal]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>파일</span>
        <button onClick={load} style={{ fontSize: 11, color: 'var(--dim)', background: 'none', border: 'none', cursor: 'pointer' }}>새로고침</button>
      </div>
      <div style={{ padding: '6px 0' }}>
        {tree === null ? (
          <div style={{ padding: 14, color: 'var(--dim)', fontSize: 12.5 }}>불러오는 중…</div>
        ) : tree.length === 0 ? (
          <div style={{ padding: 14, color: 'var(--dim)', fontSize: 12.5, lineHeight: 1.6 }}>아직 파일이 없어요.<br />채팅으로 만들어 보세요.</div>
        ) : (
          tree.map((n) => <Node key={n.path} node={n} depth={0} selected={selected} onSelect={onSelect} />)
        )}
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left',
  padding: '4px 8px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13,
};
