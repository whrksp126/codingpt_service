'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from '@phosphor-icons/react';
import Message from './Message';
import type { AgentMsg } from '@/lib/agentTypes';

// 채팅 패널 — 앱 components/agent/MessageList.tsx + ChatComposer.tsx 와 동일 스타일.
// 메시지: flex column gap 10, padding 16. 입력: #1B1F2A 박스 + 원형 send(#3B82F6 ArrowUp).

export default function Chat({
  messages, running, loading, onSend, onAbort, onOpenFile, placeholder,
}: {
  messages: AgentMsg[];
  running: boolean;
  loading: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onOpenFile?: (path: string) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  // textarea 자동 높이(최대 200)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px';
  }, [input]);

  const canSend = input.trim().length > 0 && !running;
  const submit = () => {
    if (!canSend) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#0A0D14' }}>
      {/* 메시지 목록 */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: 16, minHeight: 0 }}>
        {loading ? (
          <div style={{ color: '#64748B', fontSize: 13.5, textAlign: 'center', marginTop: 40 }}>불러오는 중…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: '#475569', fontSize: 14, textAlign: 'center', marginTop: 48, lineHeight: 1.7 }}>
            만들고 싶은 걸 말해 보세요.<br />“운동 기록 앱을 만들어줘” 처럼요.
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} msg={m} onOpenFile={onOpenFile} />)
        )}
      </div>

      {/* 입력 (ChatComposer) */}
      <div style={{ padding: '8px 14px 14px', flexShrink: 0 }}>
        <div style={{ background: '#1B1F2A', borderRadius: 14, padding: 12 }}>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={placeholder || '메시지 입력하기'}
            rows={1}
            disabled={running}
            style={{
              width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent',
              color: '#F8FAFC', fontSize: 14, lineHeight: 1.5, fontFamily: 'inherit', maxHeight: 200, minHeight: 24, padding: 0,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
            <div style={{ flex: 1 }} />
            <button
              onClick={running ? onAbort : submit}
              disabled={!running && !canSend}
              aria-label={running ? '중단' : '보내기'}
              style={{
                width: 36, height: 36, borderRadius: 18, border: 'none', cursor: 'pointer',
                background: '#3B82F6', display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: running || canSend ? 1 : 0.5, flexShrink: 0,
              }}
            >
              {running ? <span className="cpt-spin" style={{ width: 16, height: 16, borderRadius: 999, border: '2px solid rgba(255,255,255,0.45)', borderTopColor: '#fff' }} /> : <ArrowUp size={18} color="#fff" weight="bold" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
