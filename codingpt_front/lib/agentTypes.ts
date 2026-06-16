// 바이브코딩 웹 — 에이전트/워크스페이스/세션 타입. 앱(codingpt_app)과 동일 계약 유지(상호 운용).

export type AgentDiff =
  | { kind: 'edit'; oldString: string; newString: string }
  | { kind: 'multiedit'; edits: { oldString: string; newString: string }[] }
  | { kind: 'write'; oldContent: string; newContent: string }
  | null;

export type AgentEvent =
  | { type: 'agent_init'; sessionId: string; model: string; cwd: string }
  | { type: 'text'; role: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUseId: string; tool: string; input: any; relPath: string | null }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; content: string }
  | { type: 'permission_request'; requestId: string; tool: string; input: any; relPath: string | null; diff: AgentDiff }
  | { type: 'done'; ok: boolean; subtype?: string; summary?: string; costUsd?: number; usage?: any }
  | { type: 'error'; message: string };

// 렌더링용 메시지(세션 messages.json 에 영속 — 앱과 동일 shape)
export type AgentMsg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'thinking'; text: string }
  | { id: string; role: 'tool'; tool: string; relPath?: string; command?: string; ok?: boolean; output?: string };

export interface PendingPermission {
  requestId: string;
  tool: string;
  relPath?: string;
  diff: AgentDiff;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  description: string;
  stack: string[];
  thumb: 'list' | 'page' | 'chart';
  kind: 'chat' | 'project';
  unread: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  sdkSessionId: string | null;
  preview: string;
  msgCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PreviewState {
  mode: 'dev' | 'static';
  ready?: boolean;
  token?: string;
  url?: string;
  log?: string;
}

// 파일 트리 노드(백엔드 listWorkspaceFiles 와 동일 shape)
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

// 터미널(샌드박스 exec) SSE 이벤트
export type ExecEvent =
  | { type: 'start'; cwd: string }
  | { type: 'output'; data: string }
  | { type: 'cwd'; cwd: string }
  | { type: 'done'; exitCode: number; timedOut?: boolean }
  | { type: 'error'; message: string };
