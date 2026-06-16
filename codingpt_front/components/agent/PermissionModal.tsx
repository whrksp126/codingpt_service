'use client';

import type { PendingPermission } from '@/lib/agentTypes';

// 수정 승인/거부 모달 — 에이전트가 파일을 바꾸기 전 diff 확인. allow/deny → /api/agent/permission.

function DiffView({ p }: { p: PendingPermission }) {
  const d = p.diff;
  if (!d) return null;
  const rows: { sign: '-' | '+'; text: string }[] = [];
  if (d.kind === 'edit') {
    rows.push({ sign: '-', text: d.oldString }, { sign: '+', text: d.newString });
  } else if (d.kind === 'write') {
    if (d.oldContent) rows.push({ sign: '-', text: d.oldContent });
    rows.push({ sign: '+', text: d.newContent });
  } else if (d.kind === 'multiedit') {
    d.edits.forEach((e) => rows.push({ sign: '-', text: e.oldString }, { sign: '+', text: e.newString }));
  }
  return (
    <pre style={{ margin: 0, maxHeight: 320, overflow: 'auto', background: 'var(--base)', borderRadius: 8, padding: 12, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ color: r.sign === '+' ? 'var(--accent)' : 'var(--error)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {r.sign} {r.text}
        </div>
      ))}
    </pre>
  );
}

export default function PermissionModal({ pending, onResolve }: { pending: PendingPermission | null; onResolve: (d: 'allow' | 'deny') => void }) {
  if (!pending) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 560, background: 'var(--elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>변경을 적용할까요?</div>
        <div style={{ color: 'var(--dim)', fontSize: 13, marginTop: 4 }}>
          {pending.tool}{pending.relPath ? ` · ${pending.relPath}` : ''}
        </div>
        <div style={{ marginTop: 14 }}><DiffView p={pending} /></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={() => onResolve('deny')} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 14, cursor: 'pointer' }}>거부</button>
          <button onClick={() => onResolve('allow')} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--cta)', color: 'var(--on-accent)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>적용</button>
        </div>
      </div>
    </div>
  );
}
