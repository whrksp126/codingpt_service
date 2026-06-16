'use client';

// 바이브코딩 웹 — 워크스페이스/세션 CRUD(브라우저, JWT bearer). 백엔드 /api/workspaces/*.
// 성공 응답은 data 직접 반환(successResponse 규약).

import { clientFetch } from './api';
import { getToken } from './auth';
import type { WorkspaceMeta, SessionMeta, AgentMsg } from './agentTypes';

function tok() { return getToken(); }

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await clientFetch<T>(path, { method, body, token: tok() });
  if (!r.ok) throw new Error(r.message || `요청 실패(${r.status})`);
  return r.data as T;
}

// ── 워크스페이스 ──────────────────────────────────────────────
export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  const d = await call<{ workspaces: WorkspaceMeta[] }>('/api/workspaces');
  return d.workspaces || [];
}

export async function createWorkspace(input: {
  name?: string; description?: string; stack?: string[]; thumb?: string; kind?: 'chat' | 'project';
}): Promise<WorkspaceMeta> {
  const d = await call<{ workspace: WorkspaceMeta }>('/api/workspaces', 'POST', input);
  return d.workspace;
}

export async function getWorkspace(wsId: string): Promise<WorkspaceMeta> {
  const d = await call<{ workspace: WorkspaceMeta }>(`/api/workspaces/${encodeURIComponent(wsId)}`);
  return d.workspace;
}

export async function deleteWorkspace(wsId: string): Promise<void> {
  await call(`/api/workspaces/${encodeURIComponent(wsId)}`, 'DELETE');
}

export async function suggestNames(description: string): Promise<string[]> {
  const d = await call<{ names: string[] }>('/api/workspaces/suggest-name', 'POST', { description });
  return d.names || [];
}

// ── 세션(채팅) ────────────────────────────────────────────────
export async function listSessions(wsId: string): Promise<SessionMeta[]> {
  const d = await call<{ sessions: SessionMeta[] }>(`/api/workspaces/${encodeURIComponent(wsId)}/sessions`);
  return d.sessions || [];
}

export async function createSession(wsId: string, title?: string): Promise<SessionMeta> {
  const d = await call<{ session: SessionMeta }>(`/api/workspaces/${encodeURIComponent(wsId)}/sessions`, 'POST', { title });
  return d.session;
}

export async function getSession(wsId: string, sessionId: string): Promise<{ meta: SessionMeta; messages: AgentMsg[] }> {
  return call<{ meta: SessionMeta; messages: AgentMsg[] }>(
    `/api/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function updateSession(
  wsId: string,
  sessionId: string,
  patch: { title?: string; sdkSessionId?: string; messages?: AgentMsg[] },
): Promise<SessionMeta> {
  const d = await call<{ session: SessionMeta }>(
    `/api/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sessionId)}`,
    'PATCH',
    patch,
  );
  return d.session;
}

export async function deleteSession(wsId: string, sessionId: string): Promise<void> {
  await call(`/api/workspaces/${encodeURIComponent(wsId)}/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');
}
