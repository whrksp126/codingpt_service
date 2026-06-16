'use client';

// 바이브코딩 웹 — 백엔드 /api/agent/* + /api/preview/* 호출(브라우저, JWT bearer).
// 앱 agentService.ts 의 계약과 동일. 스트리밍은 fetch + ReadableStream 으로 SSE 라인 파싱.

import { BACKEND_PUBLIC } from './api';
import { getToken } from './auth';
import type { AgentEvent, PreviewState, FileNode, ExecEvent } from './agentTypes';

export interface StreamHandlers {
  onEvent: (evt: AgentEvent) => void;
  onError?: (msg: string) => void;
  onComplete?: () => void;
  onLimitReached?: (info: any) => void;
}

export interface StreamOpts {
  sessionId?: string; // SDK resume id
  projectId?: string; // = workspaceId (샌드박스/프리뷰 식별)
  model?: string;
  autoApprove?: boolean;
  mode?: 'chat' | 'code';
}

function processLine(line: string, onEvent: (e: AgentEvent) => void) {
  const t = line.trim();
  if (!t.startsWith('data:')) return;
  try {
    onEvent(JSON.parse(t.slice(5).trim()) as AgentEvent);
  } catch (_) {
    /* 부분 라인/노이즈 무시 */
  }
}

/**
 * 에이전트 질의 스트림. SSE `data:` 라인을 파싱해 onEvent 로 흘린다.
 * @returns abort 함수
 */
export function streamAgentQuery(prompt: string, handlers: StreamHandlers, opts: StreamOpts = {}): () => void {
  const controller = new AbortController();
  const token = getToken();

  (async () => {
    let res: Response;
    try {
      res = await fetch(`${BACKEND_PUBLIC}/api/agent/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          prompt,
          sessionId: opts.sessionId,
          projectId: opts.projectId,
          model: opts.model,
          autoApprove: opts.autoApprove,
          mode: opts.mode,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : '네트워크 연결 에러가 발생했습니다.');
      return;
    }

    if (res.status === 401) {
      handlers.onError?.('인증이 만료되었습니다. 다시 로그인해주세요.');
      return;
    }
    // 사용량 한도(프리플라이트 게이트) — SSE 시작 전 일반 JSON
    if (res.status === 402 || res.status === 429) {
      let info: any = null;
      try { info = await res.json(); } catch (_) { /* noop */ }
      if (handlers.onLimitReached) handlers.onLimitReached(info || { code: 'USAGE_LIMIT_REACHED' });
      else handlers.onError?.(info?.message || '사용량 한도에 도달했습니다.');
      return;
    }
    if (!res.ok || !res.body) {
      handlers.onError?.(`서버 에러: ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) processLine(line, handlers.onEvent);
      }
      if (pending) processLine(pending, handlers.onEvent);
      handlers.onComplete?.();
    } catch (e: any) {
      if (e?.name !== 'AbortError') handlers.onError?.(e?.message || '스트림 중단');
    }
  })();

  return () => { try { controller.abort(); } catch (_) { /* noop */ } };
}

// ── 단순 JSON 호출 헬퍼(bearer) ───────────────────────────────
async function jsonFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BACKEND_PUBLIC}${path}`, {
    method: init.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch (_) { /* noop */ }
  if (!res.ok) throw new Error(data?.message || `요청 실패(${res.status})`);
  return data as T;
}

/** 워크스페이스 파일 트리(IDE 파일트리) */
export const listAgentFiles = (projectId: string) =>
  jsonFetch<{ success: boolean; tree: FileNode[] }>(`/api/agent/files?projectId=${encodeURIComponent(projectId)}`)
    .then((r) => r.tree || []);

/** 워크스페이스 파일 읽기(에디터 동기화) */
export const getAgentFile = (relPath: string, projectId?: string) =>
  jsonFetch<{ path: string; content: string }>(
    `/api/agent/file?path=${encodeURIComponent(relPath)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
  );

/** 워크스페이스 파일 쓰기(에디터 편집 → 샌드박스 FS → HMR) */
export const writeAgentFile = (relPath: string, content: string, projectId?: string) =>
  jsonFetch<{ success: boolean; path: string }>('/api/agent/file', {
    method: 'POST',
    body: { path: relPath, content, projectId },
  });

/** 수정 승인/거부 — diff 모달에서 호출 */
export const resolveAgentPermission = (requestId: string, decision: 'allow' | 'deny', message?: string) =>
  jsonFetch<{ success: boolean }>('/api/agent/permission', {
    method: 'POST',
    body: { requestId, decision, message },
  });

// ── 터미널(샌드박스 exec) ─────────────────────────────────────
/** 샌드박스 셸 명령 실행 — 출력 SSE 스트리밍. @returns abort 함수 */
export function streamExec(
  payload: { command: string; cwd?: string; projectId?: string },
  handlers: { onEvent: (e: ExecEvent) => void; onError?: (m: string) => void; onComplete?: () => void },
): () => void {
  const controller = new AbortController();
  const token = getToken();
  (async () => {
    let res: Response;
    try {
      res = await fetch(`${BACKEND_PUBLIC}/api/agent/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e.message : '네트워크 에러');
      return;
    }
    if (!res.ok || !res.body) { handlers.onError?.(`서버 에러: ${res.status}`); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const emit = (line: string) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      try { handlers.onEvent(JSON.parse(t.slice(5).trim()) as ExecEvent); } catch (_) { /* noop */ }
    };
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) emit(l);
      }
      if (pending) emit(pending);
      handlers.onComplete?.();
    } catch (e: any) {
      if (e?.name !== 'AbortError') handlers.onError?.(e?.message || '스트림 중단');
    }
  })();
  return () => { try { controller.abort(); } catch (_) { /* noop */ } };
}

/** dev 서버 기동 명령인지(미리보기로 라우팅) */
export const isDevServerCommand = (raw: string): boolean =>
  /(^|\s|&&|;)(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(raw)
  || /(^|\s|&&|;)(vite|next\s+dev|react-scripts\s+start)\b/.test(raw);

// ── 프리뷰(dev 서버) ──────────────────────────────────────────
/** dev 서버 시작 → { mode, token, url } (url 은 /api/preview/{token}/ 상대경로) */
export const startPreview = (projectId: string) =>
  jsonFetch<PreviewState>('/api/preview/dev/start', { method: 'POST', body: { projectId } });

export const stopPreview = (projectId: string) =>
  jsonFetch<{ ok?: boolean }>('/api/preview/dev/stop', { method: 'POST', body: { projectId } });

/** 프리뷰 토큰 경로 → 브라우저가 로드할 절대 URL (무인증 프록시) */
export const previewUrl = (relUrlOrToken: string) => {
  if (relUrlOrToken.startsWith('http')) return relUrlOrToken;
  const rel = relUrlOrToken.startsWith('/') ? relUrlOrToken : `/api/preview/${relUrlOrToken}/`;
  return `${BACKEND_PUBLIC}${rel}`;
};
