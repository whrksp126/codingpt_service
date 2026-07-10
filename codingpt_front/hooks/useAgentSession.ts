'use client';

// 바이브코딩 웹 — 단일 세션 채팅 상태 + 에이전트 스트리밍(BYO, M5-웹 W2).
// M0 에서 제거된 우리키 /api/agent/query 대신 데몬 릴레이(lib/daemon)에 재배선:
//  · 이벤트: 영속 WSS 구독 subscribeDaemonAgentEvents(세션ID 필터 + seq 디덥). 프레임의 event 를 handleEvent 로.
//  · 커맨드: 첫 턴/재개는 startAgent(cwd, prompt, resumeId), 라이브 세션은 inputAgent. 승인은 approveAgent.
// 이벤트(agent_init/text/thinking/tool_use/tool_result/permission_request/done/error) → AgentMsg[].
// done 시 세션 영속(updateSession: messages + sdkSessionId). BYO 는 사용자 자기 claude 직결이라 402/429 없음.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscribeDaemonAgentEvents, startAgent, inputAgent, approveAgent, stopAgent,
  type DaemonAgentFrame,
} from '../lib/daemon';
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
  opts: { mode: 'chat' | 'code'; cwd?: string; onLimit?: (info: any) => void } = { mode: 'code' },
): UseAgentSession {
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);

  const messagesRef = useRef<AgentMsg[]>([]);
  const sdkSessionIdRef = useRef<string | null>(null);
  const firstTurnTitleRef = useRef<string | null>(null);
  const toolIndexRef = useRef<Record<string, number>>({});
  const listenersRef = useRef<Set<(evt: AgentEvent) => void>>(new Set());
  // BYO 라이브 세션 추적 + 프레임 디덥/버퍼.
  const liveRef = useRef(false);              // startAgent 성공 후 세션이 살아있는가(다음 턴=inputAgent).
  const lastSeqRef = useRef(-1);              // 이 세션에서 처리한 마지막 daemon seq(중복 방지).
  const bufRef = useRef<DaemonAgentFrame[]>([]); // sdkSessionId 확정 전 도착 프레임 버퍼.
  const subRef = useRef<(() => void) | null>(null);
  const uidRef = useRef(0);
  const uid = () => `a${++uidRef.current}`;

  const apply = useCallback((updater: (prev: AgentMsg[]) => AgentMsg[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

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

  // 데몬 프레임 라우팅 — 현재 세션(sdkSessionId)만, seq 중복 제거. sdkSessionId 미확정이면 버퍼.
  const routeFrame = useCallback((f: DaemonAgentFrame) => {
    const sid = sdkSessionIdRef.current;
    // agent_init 은 sdkSessionId 를 확정하므로 항상 통과(그 안에서 sid 세팅).
    if (!sid && f.event.type !== 'agent_init') { bufRef.current.push(f); return; }
    if (sid && f.sessionId !== sid) return;           // 다른 세션 프레임 무시
    if (typeof f.seq === 'number') {
      if (f.seq <= lastSeqRef.current) return;         // 이미 처리(리플레이 중복)
      lastSeqRef.current = f.seq;
    }
    handleEvent(f.event);
    // agent_init 으로 sid 가 방금 확정됐다면 버퍼 flush.
    if (f.event.type === 'agent_init' && bufRef.current.length) {
      const buffered = bufRef.current.filter((b) => b.sessionId === sdkSessionIdRef.current);
      bufRef.current = [];
      buffered.forEach((b) => {
        if (typeof b.seq === 'number') { if (b.seq <= lastSeqRef.current) return; lastSeqRef.current = b.seq; }
        handleEvent(b.event);
      });
    }
  }, [handleEvent]);

  // 세션 로드(영속 메시지 복원 + sdk resume id) + 영속 이벤트 구독 마운트.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    sdkSessionIdRef.current = null;
    firstTurnTitleRef.current = null;
    liveRef.current = false;
    lastSeqRef.current = -1;
    bufRef.current = [];
    toolIndexRef.current = {};
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

    // 영속 WSS 구독(세션 단위). 데몬이 사용자 claude 이벤트를 여기로 팬아웃.
    subRef.current = subscribeDaemonAgentEvents((f) => { if (alive) routeFrame(f); });

    return () => {
      alive = false;
      try { subRef.current?.(); } catch (_) { /* noop */ }
      subRef.current = null;
    };
  }, [wsId, sessionId, routeFrame]);

  const send = useCallback((prompt: string) => {
    if (!prompt.trim() || running) return;
    if (messagesRef.current.length === 0) firstTurnTitleRef.current = prompt.slice(0, 40);
    apply((m) => [...m, { id: uid(), role: 'user', text: prompt }]);
    setRunning(true);
    toolIndexRef.current = {};
    const cwd = opts.cwd || wsId; // BYO 러너 작업 폴더(미지정 시 워크스페이스 식별자)
    (async () => {
      try {
        if (sdkSessionIdRef.current && liveRef.current) {
          await inputAgent(sdkSessionIdRef.current, prompt);
        } else {
          const { sessionId: sid } = await startAgent(cwd, prompt, sdkSessionIdRef.current || undefined);
          if (sid) sdkSessionIdRef.current = sid;
          liveRef.current = true;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : '에이전트를 시작할 수 없어요.';
        apply((m) => [...m, { id: uid(), role: 'assistant', text: `⚠️ ${msg}` }]);
        setRunning(false);
        void persist();
      }
    })();
  }, [running, apply, persist, wsId, opts]);

  const resolvePermission = useCallback((decision: 'allow' | 'deny') => {
    setPendingPermission((p) => {
      const sid = sdkSessionIdRef.current;
      if (p && sid) approveAgent(sid, p.requestId, decision).catch(() => { /* noop */ });
      return null;
    });
  }, []);

  const abort = useCallback(() => {
    const sid = sdkSessionIdRef.current;
    if (sid) stopAgent(sid).catch(() => { /* noop */ });
    liveRef.current = false;
    setRunning(false);
  }, []);

  const subscribe = useCallback((fn: (evt: AgentEvent) => void) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  return { messages, running, loading, pendingPermission, send, resolvePermission, abort, subscribe };
}
