'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { getAgentFile, writeAgentFile } from '@/lib/agent';

// 코드 에디터(Monaco) — 앱 MobileIDE 에디터처럼 배경 #0A0D14, 자동 저장(디바운스).
// 탭/breadcrumb 은 코딩뷰가 렌더(여기선 에디터 본문만).

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', html: 'html', css: 'css', scss: 'scss', md: 'markdown', py: 'python', rb: 'ruby', php: 'php',
  go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', sh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
};
const langOf = (p: string) => EXT_LANG[(p.split('.').pop() || '').toLowerCase()] || 'plaintext';

export default function Editor({ wsId, path }: { wsId: string; path: string | null }) {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef('');

  useEffect(() => {
    if (!path) { setValue(''); return; }
    setLoading(true);
    getAgentFile(path, wsId)
      .then((r) => { setValue(r.content ?? ''); valueRef.current = r.content ?? ''; })
      .catch(() => setValue('// 파일을 불러올 수 없습니다.'))
      .finally(() => setLoading(false));
  }, [wsId, path]);

  const save = useCallback(async () => {
    if (!path) return;
    try { await writeAgentFile(path, valueRef.current, wsId); } catch (_) { /* noop */ }
  }, [path, wsId]);

  const onChange = (v?: string) => {
    const val = v ?? '';
    setValue(val); valueRef.current = val;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save(); }, 1500); // 앱과 동일 자동 저장
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  if (!path) {
    return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 13.5, background: '#0A0D14' }}>왼쪽 탐색기에서 파일을 여세요.</div>;
  }

  return (
    <div style={{ height: '100%', minHeight: 0, background: '#0A0D14' }}>
      {loading ? (
        <div style={{ padding: 16, color: '#475569', fontSize: 13 }}>불러오는 중…</div>
      ) : (
        <MonacoEditor
          height="100%"
          theme="codingpt-dark"
          language={langOf(path)}
          value={value}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme('codingpt-dark', {
              base: 'vs-dark', inherit: true, rules: [],
              colors: { 'editor.background': '#0A0D14', 'editorGutter.background': '#0A0D14', 'editor.lineHighlightBackground': '#11151F', 'editorLineNumber.foreground': '#475569' },
            });
          }}
          onChange={onChange}
          options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, padding: { top: 8 } }}
        />
      )}
    </div>
  );
}
