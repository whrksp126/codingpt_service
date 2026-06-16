'use client';

// 바이브코딩 웹 — 단일 세션 채팅 상태 + 에이전트 스트리밍. 앱 AgentSessionContext 의 reducer 포팅.
// 이벤트(agent_init/text/thinking/tool_use/tool_result/permission_request/done/error) → AgentMsg[].
// done 시 세션 영속(updateSession: messages + sdkSessionId). 한도 도달 시 onLimit.

import { useCallback, useEffect, useRef, useState } from 'react';
import { streamAgentQuery, resolveAgentPermission } from '../lib/agent';
import { getSession, updateSession } from '../lib/workspaces';
import type { AgentEvent, AgentMsg, PendingPermission } from '../lib/agentTypes';

export interface UseAgentSession {
  messages: AgentMsg[];
  running: boolean;
  loading: boolean;
  pendingPermission: PendingPermission | null;
  send: (prompt: string) => void;
  resolvePermission: (decision: 'allow' | 'deny') => void;
  abort: () => void;
  /** IDE/프리뷰 side-effect 용 raw 이벤트 구독(파일 편집·dev 감지 등). */
  subscribe: (fn: (evt: AgentEvent) => void) => () => void;
}

export function useAgentSession(
  wsId: string,
  sessionId: string,
  opts: { mode: 'chat' | 'code'; onLimit?: (info: any) => void } = { mode: 'code' },
): UseAgentSession {
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);

  const messagesRef = useRef<AgentMsg[]>([]);
  const sdkSessionIdRef = useRef<string | null>(null);
  const firstTurnTitleRef = useRef<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const toolIndexRef = useRef<Record<string, number>>({});
  const listenersRef = useRef<Set<(evt: AgentEvent) => void>>(new Set());
  const uidRef = useRef(0);
  const uid = () => `a${++uidRef.current}`;

  const apply = useCallback((updater: (prev: AgentMsg[]) => AgentMsg[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  // 세션 로드(영속 메시지 복원 + sdk resume id)
  useEffect(() => {
    let alive = true;
    setLoading(true);
    sdkSessionIdRef.current = null;
    firstTurnTitleRef.current = null;
    getSession(wsId, sessionId)
      .then((s) => {
        if (!alive) return;
        const msgs = Array.isArray(s.messages) ? s.messages : [];
        messagesRef.current = msgs;
        setMessages(msgs);
        sdkSessionIdRef.current = s.meta?.sdkSessionId || null;
      })
      .catch(() => { if (alive) { messagesRef.current = []; setMessages([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      try { abortRef.current?.(); } catch (_) { /* noop */ }
    };
  }, [wsId, sessionId]);

  const persist = useCallback(async () => {
    try {
      await updateSession(wsId, sessionId, {
        messages: messagesRef.current,
        ...(sdkSessionIdRef.current ? { sdkSessionId: sdkSessionIdRef.current } : {}),
        ...(firstTurnTitleRef.current ? { title: firstTurnTitleRef.current } : {}),
      });
      firstTurnTitleRef.current = null;
    } catch (_) { /* 영속 실패는 조용히 — 다음 턴 재시도 */ }
  }, [wsId, sessionId]);

  const handleEvent = useCallback((evt: AgentEvent) => {
    switch (evt.type) {
      case 'agent_init':
        sdkSessionIdRef.current = evt.sessionId;
        break;
      case 'text':
        apply((m) => [...m, { id: uid(), role: 'assistant', text: evt.text }]);
        break;
      case 'thinking':
        apply((m) => [...m, { id: uid(), role: 'thinking', text: evt.text }]);
        break;
      case 'tool_use':
        apply((m) => {
          toolIndexRef.current[evt.toolUseId] = m.length;
          return [...m, {
            id: uid(), role: 'tool', tool: evt.tool,
            relPath: evt.relPath || undefined,
            command: evt.tool === 'Bash' ? evt.input?.command : undefined,
          }];
        });
        break;
      case 'tool_result': {
        const idx = toolIndexRef.current[evt.toolUseId];
        if (idx != null) {
          apply((m) => {
            if (!m[idx]) return m;
            const copy = m.slice();
            copy[idx] = { ...copy[idx], ok: evt.ok, output: evt.content } as AgentMsg;
            return copy;
          });
        }
        break;
      }
      case 'permission_request':
        setPendingPermission({ requestId: evt.requestId, tool: evt.tool, relPath: evt.relPath || undefined, diff: evt.diff });
        break;
      case 'done':
        setRunning(false);
        setPendingPermission(null);
        void persist();
        break;
      case 'error':
        apply((m) => [...m, { id: uid(), role: 'assistant', text: `⚠️ ${evt.message}` }]);
        setRunning(false);
        setPendingPermission(null);
        void persist();
        break;
    }
    listenersRef.current.forEach((fn) => { try { fn(evt); } catch (_) { /* noop */ } });
  }, [apply, persist]);

  const send = useCallback((prompt: string) => {
    if (!prompt.trim() || running) return;
    if (messagesRef.current.length === 0) firstTurnTitleRef.current = prompt.slice(0, 40);
    apply((m) => [...m, { id: uid(), role: 'user', text: prompt }]);
    setRunning(true);
    toolIndexRef.current = {};
    abortRef.current = streamAgentQuery(
      prompt,
      {
        onEvent: handleEvent,
        onError: (err) => {
          apply((m) => [...m, { id: uid(), role: 'assistant', text: `⚠️ ${err}` }]);
          setRunning(false);
          void persist();
        },
        onComplete: () => setRunning(false),
        onLimitReached: (info) => {
          setRunning(false);
          opts.onLimit?.(info);
          void persist();
        },
      },
      {
        sessionId: sdkSessionIdRef.current || undefined,
        projectId: wsId,
        autoApprove: false,
        mode: opts.mode,
      },
    );
  }, [running, apply, handleEvent, persist, wsId, opts]);

  const resolvePermission = useCallback((decision: 'allow' | 'deny') => {
    setPendingPermission((p) => {
      if (p) resolveAgentPermission(p.requestId, decision).catch(() => { /* noop */ });
      return null;
    });
  }, []);

  const abort = useCallback(() => {
    try { abortRef.current?.(); } catch (_) { /* noop */ }
    abortRef.current = null;
    setRunning(false);
  }, []);

  const subscribe = useCallback((fn: (evt: AgentEvent) => void) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  return { messages, running, loading, pendingPermission, send, resolvePermission, abort, subscribe };
}
