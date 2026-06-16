'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { getAgentFile, writeAgentFile } from '@/lib/agent';

// 코드 에디터(Monaco) — 워크스페이스 파일 읽기/저장. Ctrl/Cmd+S 또는 저장 버튼.

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', html: 'html', css: 'css', scss: 'scss', md: 'markdown', py: 'python', rb: 'ruby', php: 'php',
  go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', sh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
};
const langOf = (p: string) => EXT_LANG[(p.split('.').pop() || '').toLowerCase()] || 'plaintext';

export default function Editor({ wsId, path }: { wsId: string; path: string | null }) {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) { setValue(''); loadedPathRef.current = null; return; }
    setLoading(true); setDirty(false);
    getAgentFile(path, wsId)
      .then((r) => { setValue(r.content ?? ''); loadedPathRef.current = path; })
      .catch(() => setValue('// 파일을 불러올 수 없습니다.'))
      .finally(() => setLoading(false));
  }, [wsId, path]);

  const save = useCallback(async () => {
    if (!path || saving) return;
    setSaving(true);
    try { await writeAgentFile(path, value, wsId); setDirty(false); }
    catch (_) { /* noop */ }
    finally { setSaving(false); }
  }, [path, value, wsId, saving]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  if (!path) {
    return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)', fontSize: 13.5 }}>왼쪽에서 파일을 선택하세요.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, color: 'var(--text2)' }}>{path}{dirty ? ' •' : ''}</span>
        <div style={{ flex: 1 }} />
        <button onClick={save} disabled={!dirty || saving} style={{ padding: '5px 12px', borderRadius: 8, border: 'none', background: dirty ? 'var(--cta)' : 'var(--surface)', color: dirty ? 'var(--on-accent)' : 'var(--dim)', fontSize: 12.5, fontWeight: 600, cursor: dirty ? 'pointer' : 'default' }}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--dim)', fontSize: 13 }}>불러오는 중…</div>
        ) : (
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            language={langOf(path)}
            value={value}
            onChange={(v) => { setValue(v ?? ''); setDirty(true); }}
            options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2 }}
          />
        )}
      </div>
    </div>
  );
}
