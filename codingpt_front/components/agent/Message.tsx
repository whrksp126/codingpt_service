'use client';

import type { AgentMsg } from '@/lib/agentTypes';

// 단일 대화 메시지 렌더 — user/assistant/thinking/tool. (앱 IDE 의 메시지 카드와 동일 정보)

const TOOL_LABEL: Record<string, string> = {
  Write: '파일 작성', Edit: '파일 수정', MultiEdit: '파일 수정', Read: '파일 읽기',
  Bash: '명령 실행', Glob: '파일 검색', Grep: '코드 검색', WebFetch: '웹 조회', TodoWrite: '할 일 정리',
};

export default function Message({ msg }: { msg: AgentMsg }) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '10px 0' }}>
        <div style={{ maxWidth: '82%', background: 'var(--accent-tint)', color: 'var(--text)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: 14, borderBottomRightRadius: 4, padding: '10px 14px', fontSize: 14.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.role === 'thinking') {
    return (
      <div style={{ margin: '8px 0', color: 'var(--dim)', fontSize: 13, fontStyle: 'italic', lineHeight: 1.6, whiteSpace: 'pre-wrap', paddingLeft: 4, borderLeft: '2px solid var(--border)' }}>
        <span style={{ paddingLeft: 10, display: 'inline-block' }}>{msg.text}</span>
      </div>
    );
  }

  if (msg.role === 'tool') {
    const label = TOOL_LABEL[msg.tool] || msg.tool;
    const ok = msg.ok;
    return (
      <div style={{ margin: '8px 0', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 12px', fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: ok === false ? 'var(--error)' : ok === true ? 'var(--accent)' : 'var(--dim)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{label}</span>
          {msg.relPath ? <span style={{ color: 'var(--dim)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{msg.relPath}</span> : null}
        </div>
        {msg.command ? (
          <pre style={{ margin: '8px 0 0', padding: '8px 10px', background: 'var(--base)', borderRadius: 7, color: 'var(--text2)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>$ {msg.command}</pre>
        ) : null}
        {msg.output ? (
          <pre style={{ margin: '6px 0 0', padding: '8px 10px', background: 'var(--base)', borderRadius: 7, color: 'var(--dim)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 160 }}>{String(msg.output).slice(0, 1200)}</pre>
        ) : null}
      </div>
    );
  }

  // assistant
  return (
    <div style={{ margin: '10px 0', color: 'var(--text)', fontSize: 14.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {msg.text}
    </div>
  );
}
