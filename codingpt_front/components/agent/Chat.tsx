'use client';

import { useEffect, useRef, useState } from 'react';
import Message from './Message';
import type { AgentMsg } from '@/lib/agentTypes';

// 채팅 패널 — 메시지 목록 + 입력. 스트리밍 중엔 입력 비활성/중단 버튼.

export default function Chat({
  messages, running, loading, onSend, onAbort, placeholder,
}: {
  messages: AgentMsg[];
  running: boolean;
  loading: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  const submit = () => {
    const t = input.trim();
    if (!t || running) return;
    onSend(t);
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px', minHeight: 0 }}>
        {loading ? (
          <div style={{ color: 'var(--dim)', fontSize: 13.5, textAlign: 'center', marginTop: 40 }}>불러오는 중…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: 'var(--dim)', fontSize: 14, textAlign: 'center', marginTop: 48, lineHeight: 1.7 }}>
            만들고 싶은 걸 말해 보세요.<br />“운동 기록 앱을 만들어줘” 처럼요.
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} msg={m} />)
        )}
        {running ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dim)', fontSize: 13, margin: '8px 0' }}>
            <span className="cpt-dot" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />
            만드는 중…
          </div>
        ) : null}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: 12, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={placeholder || 'AI에게 만들고 싶은 걸 말해 보세요'}
            rows={1}
            style={{
              flex: 1, resize: 'none', maxHeight: 140, minHeight: 42, padding: '11px 14px',
              borderRadius: 12, border: '1px solid var(--border-control)', background: 'var(--surface)',
              color: 'var(--text)', fontSize: 14.5, lineHeight: 1.5, outline: 'none', fontFamily: 'inherit',
            }}
          />
          {running ? (
            <button onClick={onAbort} style={{ ...sendBtn, background: 'var(--surface)', color: 'var(--text2)', border: '1px solid var(--border)' }}>중단</button>
          ) : (
            <button onClick={submit} disabled={!input.trim()} style={{ ...sendBtn, opacity: input.trim() ? 1 : 0.5 }}>보내기</button>
          )}
        </div>
      </div>
    </div>
  );
}

const sendBtn: React.CSSProperties = {
  height: 42, padding: '0 18px', borderRadius: 12, border: 'none',
  background: 'var(--cta)', color: 'var(--on-accent)', fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0,
};
