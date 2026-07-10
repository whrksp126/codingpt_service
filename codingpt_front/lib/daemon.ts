'use client';

// M5-웹 W1 — 웹 데몬 클라이언트(BYO). 앱 daemonService.ts 의 웹 이식.
//  백엔드 계약(/api/daemon/*)은 클라이언트 비종속(JWT bearer REST + 쿼리/불투명 토큰 WSS + SSE)이라
//  전송층만 웹으로 교체한다: apiRequest→clientFetch, AsyncStorage→getToken, XHR SSE→fetch stream, WS 동일.
//  (RN refreshAccessToken 은 웹에 없음 — 토큰은 핸드오프 JWT. 만료 시 재핸드오프로 복구.)

import { clientFetch, BACKEND_PUBLIC } from './api';
import { getToken } from './auth';
import type { AgentEvent } from './agentTypes';

// successResponse 규약(성공=data 직접 반환)에 맞춘 얇은 호출 헬퍼. 실패면 throw.
async function call<T>(path: string, method = 'GET', body?: unknown, opts?: { silent?: boolean }): Promise<T> {
  const r = await clientFetch<T>(path, { method, body, token: getToken() });
  if (!r.ok) {
    const msg = r.message || `요청 실패(${r.status})`;
    if (!opts?.silent) console.warn('[daemon] ' + method + ' ' + path + ' → ' + msg);
    const e = new Error(msg) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return r.data as T;
}
// 실패해도 throw 하지 않고 fallback 반환(silent 경로).
async function callSafe<T>(path: string, method: string, body: unknown, fallback: T): Promise<T> {
  try { return await call<T>(path, method, body, { silent: true }); } catch (_) { return fallback; }
}

// ── 상태/러너 ────────────────────────────────────────────────
export interface DaemonDeviceInfo { deviceId: number; deviceName: string; platform: string | null; daemonVersion: string | null; lastSeenAt?: string | null; online: boolean; }
export interface DaemonRunner { deviceId: number; kind: 'local' | 'cloud'; deviceName: string; platform: string | null; active: boolean; connectedAt: number; }
export interface DaemonStatus {
  online: boolean;
  current: { deviceId: number; deviceName: string; platform: string | null; daemonVersion: string | null; connectedAt: string } | null;
  runners: DaemonRunner[];
  devices: DaemonDeviceInfo[];
}

export async function getStatus(): Promise<DaemonStatus> {
  const d = await call<DaemonStatus>('/api/daemon/status');
  return { ...d, runners: d.runners || [] };
}
export async function activateRunner(target: number | { kind: 'local' | 'cloud' }): Promise<{ active: number; runners: DaemonRunner[] }> {
  const body = typeof target === 'number' ? { runnerId: target } : { kind: target.kind };
  return call('/api/daemon/runner/activate', 'POST', body);
}
export async function ensureCloudRunner(workspaceId: string): Promise<{ runnerId: number; launched: boolean; needsManualRun: boolean; wasDormant?: boolean }> {
  return call('/api/daemon/runner/cloud/ensure', 'POST', { workspaceId });
}
export async function createPairCode(): Promise<{ code: string; expiresAt: string }> {
  return call('/api/daemon/pair/code', 'POST');
}
export async function revokeDevice(deviceId: number): Promise<void> {
  await call(`/api/daemon/devices/${deviceId}/revoke`, 'POST');
}

// ── 터미널(PTY) ──────────────────────────────────────────────
export interface DaemonTerminalWindow { index: number; active: boolean; command: string; }
export async function startTerminal(cwd = ''): Promise<string> {
  const d = await call<{ token: string }>('/api/daemon/terminal/start', 'POST', { cwd });
  return d.token;
}
export function buildTerminalWsUrl(token: string): string {
  const base = BACKEND_PUBLIC.replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${base}/api/daemon/terminal/${token}`;
}
export async function listTerminals(cwd = ''): Promise<DaemonTerminalWindow[]> {
  const d = await callSafe<{ windows: DaemonTerminalWindow[] }>(`/api/daemon/terminal/list?cwd=${encodeURIComponent(cwd)}`, 'GET', undefined, { windows: [] });
  return d.windows || [];
}
export async function newTerminal(cwd = ''): Promise<{ index: number }> {
  return call('/api/daemon/terminal/new', 'POST', { cwd });
}
export async function selectTerminal(cwd: string, index: number): Promise<void> {
  await callSafe('/api/daemon/terminal/select', 'POST', { cwd, index }, null);
}
export async function closeTerminal(cwd: string, index: number): Promise<void> {
  await callSafe('/api/daemon/terminal/close', 'POST', { cwd, index }, null);
}

// ── 파일시스템 ───────────────────────────────────────────────
export interface DaemonFsEntry { name: string; path: string; dir: boolean; text: boolean; }
export interface DaemonFsList { root: string; items: DaemonFsEntry[]; }
export interface DaemonFsTree { root: string; items: { path: string; text: boolean }[]; truncated?: boolean; }
export interface DaemonFsRead { path: string; content?: string; base64?: string; size: number; binary?: boolean; tooLarge?: boolean; }
export interface DaemonGrepMatch { path: string; line: number; col: number; text: string; }
export interface DaemonGrepResult { matches: DaemonGrepMatch[]; truncated: boolean; }

export async function fsList(path = ''): Promise<DaemonFsList> {
  return call(`/api/daemon/fs/list?path=${encodeURIComponent(path)}`);
}
export async function fsTree(root = ''): Promise<DaemonFsTree> {
  return call(`/api/daemon/fs/tree?path=${encodeURIComponent(root)}`);
}
export async function fsRead(path: string, opts?: { base64?: boolean }): Promise<DaemonFsRead> {
  const qs = `path=${encodeURIComponent(path)}${opts?.base64 ? '&base64=1' : ''}`;
  return call(`/api/daemon/fs/read?${qs}`, 'GET', undefined, { silent: true });
}
export async function fsGrep(root: string, query: string): Promise<DaemonGrepResult> {
  const q = query.trim();
  if (!q) return { matches: [], truncated: false };
  return callSafe(`/api/daemon/fs/grep?path=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`, 'GET', undefined, { matches: [], truncated: false });
}
export async function fsWrite(path: string, content: string): Promise<{ path: string; size: number }> {
  return call('/api/daemon/fs/write', 'POST', { path, content });
}
export async function fsWatch(path: string): Promise<void> { await callSafe('/api/daemon/fs/watch', 'POST', { path }, null); }
export async function fsUnwatch(): Promise<void> { await callSafe('/api/daemon/fs/unwatch', 'POST', {}, null); }

// ── 워크스페이스 스캐폴드(PC) ────────────────────────────────
export interface DaemonWsRoot { root: string | null; recommended: string; protected?: boolean; }
export interface DaemonWsCreated { path: string; name: string; slug: string; gitInit: boolean; }
export interface DaemonWsCloned { path: string; name: string; slug: string; owner: string; repo: string; }
export async function wsGetRoot(): Promise<DaemonWsRoot> {
  const d = await call<DaemonWsRoot>('/api/daemon/ws/root');
  return { root: d.root ?? null, recommended: d.recommended || 'CodingPT/workspaces', protected: d.protected };
}
export async function wsSetRoot(path: string): Promise<string> {
  const d = await call<{ root: string }>('/api/daemon/ws/root', 'POST', { path });
  return d.root;
}
export async function wsUseDefaultRoot(): Promise<string> {
  const d = await call<{ root: string }>('/api/daemon/ws/root/default', 'POST', {});
  return d.root;
}
export async function wsCreate(name: string): Promise<DaemonWsCreated> {
  return call('/api/daemon/ws/create', 'POST', { name });
}
export async function wsClone(url: string, name?: string): Promise<DaemonWsCloned> {
  return call('/api/daemon/ws/clone', 'POST', { url, name });
}

// ── 프리뷰(PC dev 서버) ──────────────────────────────────────
export async function previewPorts(): Promise<number[]> {
  const d = await call<{ ports: number[] }>('/api/daemon/preview/ports');
  return d.ports || [];
}
export async function previewStart(port: number): Promise<{ token: string; url: string; port: number }> {
  return call('/api/daemon/preview/start', 'POST', { port });
}
export function buildDaemonPreviewUrl(token: string): string {
  return `${BACKEND_PUBLIC.replace(/\/+$/, '')}/api/daemon/preview/${token}/`;
}

// ── 에이전트(BYO) 커맨드 ─────────────────────────────────────
export interface DaemonAgentFrame { type: 'agent_event'; sessionId: string; seq: number; event: AgentEvent; rseq?: number; }
export interface DaemonAgentSession { id: string; title: string; lastAt: string; turns: number; source: 'app' | 'external'; }
export async function startAgent(cwd: string, prompt?: string, resumeId?: string): Promise<{ sessionId: string }> {
  return call('/api/daemon/agent/start', 'POST', { cwd, prompt, resumeId });
}
export async function inputAgent(sessionId: string, text: string): Promise<void> {
  await call('/api/daemon/agent/input', 'POST', { sessionId, text });
}
export async function approveAgent(sessionId: string, requestId: string, decision: 'allow' | 'deny', message?: string): Promise<void> {
  await callSafe('/api/daemon/agent/approve', 'POST', { sessionId, requestId, decision, message }, null);
}
export async function interruptAgent(sessionId: string): Promise<void> { await callSafe('/api/daemon/agent/interrupt', 'POST', { sessionId }, null); }
export async function stopAgent(sessionId: string): Promise<void> { await callSafe('/api/daemon/agent/stop', 'POST', { sessionId }, null); }
export async function agentBacklog(sessionId: string, sinceSeq: number): Promise<DaemonAgentFrame[]> {
  const d = await callSafe<{ events: DaemonAgentFrame[] }>(`/api/daemon/agent/backlog?sessionId=${encodeURIComponent(sessionId)}&sinceSeq=${sinceSeq}`, 'GET', undefined, { events: [] });
  return d.events || [];
}
export async function listAgentSessions(cwd: string): Promise<DaemonAgentSession[]> {
  const d = await callSafe<{ sessions: DaemonAgentSession[] }>(`/api/daemon/agent/sessions?cwd=${encodeURIComponent(cwd)}`, 'GET', undefined, { sessions: [] });
  return d.sessions || [];
}

// ── BYO 로그인(claude 계정) ──────────────────────────────────
export interface DaemonLoginStatus { loggedIn: boolean; authMethod?: string | null; email?: string | null; subscriptionType?: string | null; }
export interface DaemonDoctor {
  claude: { installed: boolean; version: string | null; bin: string; error?: string };
  tmux: { installed: boolean; path: string | null };
  platform?: string;
  login?: DaemonLoginStatus & { probed: boolean };
}
export async function agentDoctor(): Promise<DaemonDoctor> {
  return call('/api/daemon/agent/doctor', 'GET', undefined, { silent: true });
}
export async function agentLoginStart(opts?: { runnerId?: number; useConsole?: boolean }): Promise<{ url: string; authMethod?: string }> {
  return call('/api/daemon/agent/login', 'POST', { runnerId: opts?.runnerId, useConsole: opts?.useConsole });
}
export async function agentLoginSubmit(code: string, opts?: { runnerId?: number }): Promise<{ ok: boolean; message?: string; status?: DaemonLoginStatus }> {
  return call('/api/daemon/agent/login/submit', 'POST', { code, runnerId: opts?.runnerId });
}
export async function agentLoginCancel(opts?: { runnerId?: number }): Promise<void> {
  await callSafe('/api/daemon/agent/login/cancel', 'POST', { runnerId: opts?.runnerId }, null);
}
export async function agentLoginStatus(opts?: { runnerId?: number }): Promise<DaemonLoginStatus> {
  const qs = opts?.runnerId != null ? `?runnerId=${opts.runnerId}` : '';
  return call(`/api/daemon/agent/login/status${qs}`, 'GET', undefined, { silent: true });
}

// ── 동기화(objectstore git-bundle) ──────────────────────────
export interface DaemonCheckpoint { id?: string; checkpointId?: string; reason?: string; at?: string; baseCommit?: string | null; commit?: string | null; bundleKey?: string; sessionKey?: string | null; sizeBytes?: number; hasSession?: boolean; skipped?: boolean; unchanged?: boolean; }
export interface SyncStatus { state: 'clean' | 'syncing' | 'conflict'; base: string | null; head: string | null; dirty: boolean; lastCheckpointId?: string | null; lastAt?: string | null; }
export interface MaterializeResult { checkpointId: string; targetCwd: string; restored?: boolean; restoredSessions?: number; baseCommit?: string | null; conflict?: boolean; conflictId?: string; files?: string[]; merged?: boolean; }
export interface SyncConflictFile { path: string; kind: 'text' | 'binary'; }
export interface DaemonSyncEvent {
  type: 'sync_progress' | 'sync_status' | 'sync_conflict';
  phase?: 'checkpoint' | 'upload' | 'materialize' | 'reinstall' | 'wake' | 'dormant';
  state?: 'clean' | 'syncing' | 'conflict';
  checkpointId?: string; conflictId?: string; pct?: number;
  head?: string; base?: string | null; lastCheckpointId?: string;
  files?: SyncConflictFile[]; canBulkPick?: boolean;
}
export async function syncCheckpoint(workspaceId: string, reason = 'manual', cwd?: string): Promise<DaemonCheckpoint> {
  return call('/api/daemon/sync/checkpoint', 'POST', { workspaceId, reason, cwd });
}
export async function syncMaterialize(workspaceId: string, opts: { checkpointId?: string; targetCwd: string; reinstall?: boolean }): Promise<MaterializeResult> {
  return call('/api/daemon/sync/materialize', 'POST', { workspaceId, ...opts });
}
export async function syncStatus(workspaceId: string, cwd?: string): Promise<SyncStatus> {
  const qs = `workspaceId=${encodeURIComponent(workspaceId)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`;
  return call(`/api/daemon/sync/status?${qs}`, 'GET', undefined, { silent: true });
}
export async function syncResolve(workspaceId: string, opts: { conflictId: string; choices?: { path: string; side: 'local' | 'cloud' }[]; bulk?: 'local' | 'cloud' }): Promise<{ resolved: number; rescueBranch: string; head: string }> {
  return call('/api/daemon/sync/resolve', 'POST', { workspaceId, ...opts });
}
export async function listCheckpoints(workspaceId: string): Promise<{ head: unknown; checkpoints: DaemonCheckpoint[] }> {
  return callSafe(`/api/daemon/sync/checkpoints?workspaceId=${encodeURIComponent(workspaceId)}`, 'GET', undefined, { head: null, checkpoints: [] });
}

// ── SSE 공용 리더(fetch + ReadableStream) ────────────────────
// 브라우저는 Authorization 헤더가 필요한 SSE 를 EventSource 로 못 붙이므로 fetch 스트림으로 라인 파싱한다.
function sseStream(path: string, onLine: (line: string) => void, onError?: (msg: string) => void): () => void {
  let aborted = false;
  let controller: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReconnect = () => { if (aborted) return; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => void run(), 3000); };
  const run = async () => {
    if (aborted) return;
    const token = getToken();
    controller = new AbortController();
    try {
      const res = await fetch(`${BACKEND_PUBLIC}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      if (!res.ok || !res.body) { if (res.status === 401) { onError?.('인증이 만료되었습니다.'); return; } scheduleReconnect(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (aborted) return;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        lines.forEach(onLine);
      }
      scheduleReconnect(); // 스트림 종료(데몬 끊김 등) → 재연결
    } catch (_) {
      if (!aborted) scheduleReconnect();
    }
  };
  void run();
  return () => { aborted = true; if (reconnectTimer) clearTimeout(reconnectTimer); try { controller?.abort(); } catch (_) { /* noop */ } };
}

function parseDataLine(line: string): any | null {
  const t = line.trim();
  if (!t.startsWith('data:')) return null; // 주석(: ka) 무시
  try { return JSON.parse(t.substring(5).trim()); } catch (_) { return null; }
}

// 파일 변경 이벤트 SSE 구독.
export interface DaemonFsEvent { type: 'fs_event'; event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string; }
export function streamDaemonEvents(onEvent: (e: DaemonFsEvent) => void, onError?: (msg: string) => void): () => void {
  return sseStream('/api/daemon/events', (line) => { const m = parseDataLine(line); if (m && m.type === 'fs_event') onEvent(m as DaemonFsEvent); }, onError);
}

// 동기화 이벤트 SSE 구독(sync_event 프레임 필터).
export function subscribeDaemonSyncEvents(onSync: (e: DaemonSyncEvent) => void, onError?: (msg: string) => void): () => void {
  return sseStream('/api/daemon/events', (line) => { const m = parseDataLine(line); if (m && m.type === 'sync_event' && m.event) onSync(m.event as DaemonSyncEvent); }, onError);
}

// 에이전트 이벤트 SSE 폴백(agent_event 프레임 필터).
function subscribeDaemonAgentEventsSse(onFrame: (f: DaemonAgentFrame) => void, onError?: (msg: string) => void): () => void {
  return sseStream('/api/daemon/events', (line) => { const m = parseDataLine(line); if (m && m.type === 'agent_event') onFrame(m as DaemonAgentFrame); }, onError);
}

/**
 * 에이전트 이벤트 구독 — WSS(리플레이 버퍼) 우선, 실패 시 SSE 폴백.
 *  attach(lastRseq)→놓친 구간 리플레이→라이브. 첫 구독=지금부터(-1), 재접속=마지막 rseq.
 *  브라우저 WebSocket 은 헤더 못 싣으므로 토큰을 쿼리로 전달(백엔드 설계와 일치).
 */
export function subscribeDaemonAgentEvents(onFrame: (f: DaemonAgentFrame) => void, onError?: (msg: string) => void): () => void {
  let aborted = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let sseUnsub: (() => void) | null = null;
  let everOpened = false;
  let preOpenFails = 0;
  let lastRseq: number | null = null;

  const scheduleReconnect = () => { if (aborted) return; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => void connect(), 3000); };
  const fallbackToSse = () => { if (aborted || sseUnsub) return; sseUnsub = subscribeDaemonAgentEventsSse(onFrame, onError); };
  const connect = async () => {
    if (aborted || sseUnsub) return;
    const tok = getToken();
    if (!tok) { fallbackToSse(); return; }
    const base = BACKEND_PUBLIC.replace(/^http/, 'ws').replace(/\/+$/, '');
    let sock: WebSocket;
    try { sock = new WebSocket(`${base}/api/daemon/agent/stream?token=${encodeURIComponent(tok)}`); }
    catch (_) { preOpenFails += 1; if (preOpenFails >= 2 && !everOpened) fallbackToSse(); else scheduleReconnect(); return; }
    ws = sock;
    let openedThis = false;
    sock.onopen = () => {
      openedThis = true; everOpened = true; preOpenFails = 0;
      try { sock.send(JSON.stringify({ type: 'attach', lastRseq: lastRseq === null ? -1 : lastRseq })); } catch (_) { /* noop */ }
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (aborted) return;
      let m: any; try { m = JSON.parse(String(ev.data)); } catch (_) { return; }
      if (!m) return;
      if (m.type === 'attach_ack') { if (lastRseq === null) lastRseq = Number(m.headRseq) || 0; return; }
      if (m.type === 'agent_event') { if (typeof m.rseq === 'number') lastRseq = m.rseq; onFrame(m as DaemonAgentFrame); }
    };
    sock.onerror = () => { /* onclose 가 뒤따른다 */ };
    sock.onclose = () => {
      if (aborted) return;
      if (!openedThis) {
        if (!everOpened) { preOpenFails += 1; if (preOpenFails >= 2) { fallbackToSse(); return; } }
        scheduleReconnect(); return;
      }
      scheduleReconnect();
    };
  };
  void connect();
  return () => {
    aborted = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch (_) { /* noop */ }
    if (sseUnsub) { try { sseUnsub(); } catch (_) { /* noop */ } }
  };
}

const daemonClient = {
  getStatus, activateRunner, ensureCloudRunner, createPairCode, revokeDevice,
  startTerminal, buildTerminalWsUrl, listTerminals, newTerminal, selectTerminal, closeTerminal,
  fsList, fsTree, fsRead, fsWrite, fsWatch, fsUnwatch, fsGrep,
  wsGetRoot, wsSetRoot, wsUseDefaultRoot, wsCreate, wsClone,
  previewPorts, previewStart, buildDaemonPreviewUrl,
  startAgent, inputAgent, approveAgent, interruptAgent, stopAgent, agentBacklog, listAgentSessions,
  agentDoctor, agentLoginStart, agentLoginSubmit, agentLoginCancel, agentLoginStatus,
  syncCheckpoint, syncMaterialize, syncStatus, syncResolve, listCheckpoints,
  streamDaemonEvents, subscribeDaemonSyncEvents, subscribeDaemonAgentEvents,
};
export default daemonClient;
