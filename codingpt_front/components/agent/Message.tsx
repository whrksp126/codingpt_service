'use client';

import type { AgentMsg } from '@/lib/agentTypes';

// 단일 대화 메시지 렌더 — 앱 components/agent/MessageList.tsx 와 동일 스타일/색.
// user 버블(#1D4ED8) / assistant 무버블(#E2E8F0) / thinking 이탤릭(#475569) / tool 카드(#11151F).

// 앱 toolLabel() 과 동일
function toolLabel(msg: Extract<AgentMsg, { role: 'tool' }>): string {
  const { tool, command, relPath } = msg;
  if (tool === 'Bash') return `$ ${command || ''}`;
  if (tool === 'Write') return `파일 생성 · ${relPath || ''}`;
  if (tool === 'Edit' || tool === 'MultiEdit') return `파일 수정 · ${relPath || ''}`;
  if (tool === 'Read') return `읽기 · ${relPath || ''}`;
  return `${tool}${relPath ? ` · ${relPath}` : ''}`;
}

export default function Message({ msg, onOpenFile }: { msg: AgentMsg; onOpenFile?: (path: string) => void }) {
  if (msg.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '88%', background: '#1D4ED8', borderRadius: 14, borderTopRightRadius: 4, padding: '9px 12px' }}>
        <span style={{ color: '#fff', fontSize: 14, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</span>
      </div>
    );
  }

  if (msg.role === 'thinking') {
    return (
      <div style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
        <span style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>💭 {msg.text}</span>
      </div>
    );
  }

  if (msg.role === 'tool') {
    const ok = msg.ok;
    const statusColor = ok === undefined ? '#64748B' : ok ? '#34D399' : '#F87171';
    const statusMark = ok === undefined ? '…' : ok ? '✓' : '✕';
    const label = toolLabel(msg);
    const tappable = !!msg.relPath && !!onOpenFile;
    return (
      <div
        onClick={tappable ? () => onOpenFile!(msg.relPath!) : undefined}
        style={{ alignSelf: 'flex-start', maxWidth: '92%', background: '#11151F', border: '1px solid #1C2230', borderRadius: 10, padding: '8px 11px', cursor: tappable ? 'pointer' : 'default' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: statusColor, fontSize: 12, flexShrink: 0 }}>{statusMark}</span>
          <span style={{ color: '#CBD5E1', fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          {tappable ? <span style={{ color: '#60A5FA', fontSize: 11, flexShrink: 0 }}>열기 ›</span> : null}
        </div>
        {msg.tool === 'Bash' && msg.output ? (
          <div style={{ color: '#94A3B8', fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace', marginTop: 5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
            {String(msg.output).replace(/\n$/, '')}
          </div>
        ) : null}
      </div>
    );
  }

  // assistant — 무버블
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
      <span style={{ color: '#E2E8F0', fontSize: 14, lineHeight: '21px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</span>
    </div>
  );
}
