/**
 * Agent SDK 통합 서비스 (바이브코딩 엔진)
 *
 * @anthropic-ai/claude-agent-sdk 의 query() 를 헤드리스로 실행하고,
 * SDK 이벤트 스트림(SDKMessage)을 기존 executorService SSE 와 일관된
 * { type, ... } 포맷으로 변환해 onEvent 콜백으로 흘린다.
 *
 * SDK 는 ESM-only(type:module) 이므로 CommonJS 백엔드에서는 동적 import 로 로드한다.
 *
 * 이벤트 계약(프론트 단일 onMessage 스위치에서 분기):
 *   { type:'agent_init', sessionId, model, cwd }
 *   { type:'text', role:'assistant', text }
 *   { type:'thinking', text }
 *   { type:'tool_use', toolUseId, tool, input }      // Edit/Write/Bash/Read/...
 *   { type:'tool_result', toolUseId, ok, content }   // Bash→터미널, Edit→성공여부
 *   { type:'done', ok, subtype, summary, costUsd, usage }
 *   { type:'error', message }                          // controller 에서 발행
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ESM-only SDK — 동적 import 결과를 캐싱
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdkPromise;
}

const DEFAULT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';

// 파일을 변경하는 도구만 사용자 승인(diff) 게이트를 건다. Read/Bash/Grep 등은 자동 허용.
const GATED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// 진행 중인 승인 요청: requestId → { resolve, userId }.
// canUseTool 콜백이 여기에 resolve 를 걸어두고, 별도 HTTP(POST /permission)가 풀어준다.
// (단일 프로세스 전제 — 멀티 인스턴스면 공유 스토어 필요. 로컬/현 배포는 단일 컨테이너라 OK.)
const pendingPermissions = new Map();

/**
 * 승인 응답 해소 — 컨트롤러(POST /api/agent/permission)에서 호출.
 * @returns {boolean} 대기 중 요청을 찾아 해소했으면 true
 */
function resolvePermissionResponse(requestId, userId, decision, message) {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false;
  // 본인이 띄운 요청만 해소 가능
  if (userId != null && String(entry.userId) !== String(userId)) return false;
  pendingPermissions.delete(requestId);
  entry.resolve({ decision: decision === 'allow' ? 'allow' : 'deny', message });
  return true;
}

// claude_code 프리셋에 덧붙이는 바이브코딩 에이전트 컨텍스트
const VIBE_SYSTEM_APPEND = [
  '너는 CodingPT 모바일 "바이브코딩" 서비스의 코딩 에이전트다.',
  '사용자는 모바일 IDE 안에서 너와 대화하며 코드를 만든다.',
  '- 작업 디렉토리(워크스페이스)가 단일 진실원이다. 파일을 직접 만들고 수정하라.',
  '- 변경은 가능한 한 작고 명확하게. 설명은 간결하게.',
  '- 코드 실행/확인이 필요하면 Bash 를 사용하라.',
].join('\n');

/**
 * 사용자(+프로젝트)별 임시 워크스페이스 디렉토리 확보 (M3-full 에서 격리 컨테이너로 대체 예정).
 * projectId 가 있으면 그 프로젝트 위에서 작업 → /tmp/cpt-agent/<userId>/<projectId>/
 */
function workspaceDir(userId, projectId) {
  // 워커에서는 AGENT_WORKSPACE_ROOT=/workspace(호스트 가시 named volume) 사용.
  // 미설정 시 기존 동작(컨테이너 /tmp) — back 직접 실행 폴백과 하위호환.
  const root = process.env.AGENT_WORKSPACE_ROOT || os.tmpdir();
  const parts = [root, 'cpt-agent', String(userId == null ? 'anon' : userId)];
  if (projectId) parts.push(String(projectId).replace(/[^a-zA-Z0-9_-]/g, '')); // 경로 안전화
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 워크스페이스 기준 안전 상대경로(경로 탐색 차단) → 절대경로. 밖이면 null.
function resolveInWorkspace(base, relPath) {
  const safeRel = path.normalize(String(relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(base, safeRel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * 워크스페이스 내 파일 읽기 (에이전트 편집 후 에디터 동기화용).
 */
function readWorkspaceFile(userId, projectId, relPath) {
  const base = workspaceDir(userId, projectId);
  const full = resolveInWorkspace(base, relPath);
  if (!full) throw new Error('잘못된 경로입니다.');
  return fs.readFileSync(full, 'utf-8');
}

/**
 * 절대 file_path 를 워크스페이스 기준 상대경로로 변환 (밖이면 null).
 */
function toWorkspaceRelative(userId, projectId, absPath) {
  if (!absPath) return null;
  const base = workspaceDir(userId, projectId);
  const full = path.resolve(String(absPath));
  if (full === base) return '';
  if (full.startsWith(base + path.sep)) return full.slice(base.length + 1);
  return null;
}

/**
 * 워크스페이스 시드 — 앱의 현재 파일들(편집분 포함)을 워크스페이스에 기록.
 * 에이전트가 "사용자가 보고 있는 실제 프로젝트" 위에서 작업하도록.
 */
function seedWorkspace(userId, projectId, files) {
  if (!Array.isArray(files)) return;
  const base = workspaceDir(userId, projectId);
  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    const full = resolveInWorkspace(base, f.path);
    if (!full) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(f.content == null ? '' : f.content));
  }
}

/**
 * 승인 모달용 diff 페이로드 생성. 앱이 "변경 전/후"를 시각화하는 데 사용.
 *  - Edit:      { kind:'edit', oldString, newString }
 *  - MultiEdit: { kind:'multiedit', edits:[{oldString,newString}] }
 *  - Write:     { kind:'write', oldContent(현재 파일, 신규면 ''), newContent }
 */
function buildDiff(toolName, input, userId, projectId) {
  try {
    if (toolName === 'Edit') {
      return { kind: 'edit', oldString: input.old_string || '', newString: input.new_string || '' };
    }
    if (toolName === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return {
        kind: 'multiedit',
        edits: edits.map((e) => ({ oldString: e.old_string || '', newString: e.new_string || '' })),
      };
    }
    if (toolName === 'Write') {
      let oldContent = '';
      try {
        const rel = toWorkspaceRelative(userId, projectId, input.file_path);
        if (rel != null) oldContent = readWorkspaceFile(userId, projectId, rel);
      } catch (_) {
        /* 신규 파일이면 현재 내용 없음 */
      }
      return { kind: 'write', oldContent, newContent: input.content || '' };
    }
  } catch (_) {
    /* diff 생성 실패해도 승인 흐름은 진행 */
  }
  return null;
}

/**
 * tool_result 의 content(문자열 | 블록배열)를 문자열로 정규화
 */
function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text') return b.text || '';
        return '';
      })
      .join('');
  }
  return String(content);
}

/**
 * 에이전트 질의 실행. SDKMessage → onEvent 로 우리 SSE 이벤트 변환.
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {string|number} [params.userId]
 * @param {string} [params.cwd]                  - 지정 시 워크스페이스 대신 사용
 * @param {string} [params.model]
 * @param {string} [params.resumeSessionId]      - 이전 세션 이어가기
 * @param {(evt:object)=>void} params.onEvent
 * @param {Function} [params.permissionResolver] - canUseTool 위임 (M2). 미지정 시 자동 승인
 * @param {AbortController} [params.abortController]
 * @returns {Promise<string>} 사용한 워크스페이스 경로
 */
async function runAgentQuery({
  prompt,
  userId,
  projectId,
  seedFiles,
  cwd,
  model,
  resumeSessionId,
  autoApprove,
  onEvent,
  permissionResolver,
  abortController,
}) {
  const { query } = await loadSdk();
  const workdir = cwd || workspaceDir(userId, projectId);
  // 앱의 현재 파일들로 워크스페이스를 시드 → 에이전트가 실제 프로젝트 위에서 작업
  if (seedFiles) seedWorkspace(userId, projectId, seedFiles);

  // 이 질의가 띄운 승인 요청들 — 세션 종료/중단 시 정리(canUseTool 가 영원히 매달리지 않게)
  const myPending = new Set();

  const options = {
    model: model || DEFAULT_MODEL,
    cwd: workdir,
    permissionMode: 'default',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: VIBE_SYSTEM_APPEND },
    // 서브프로세스(Claude Code CLI) stderr 디버깅
    stderr: (data) => console.error('[agent-stderr]', String(data).slice(0, 2000)),
    // 권한 게이트: 파일 변경 도구는 사용자 승인(diff) 대기. autoApprove 면 즉시 허용.
    canUseTool: async (toolName, input, opts) => {
      if (typeof permissionResolver === 'function') {
        return permissionResolver(toolName, input, opts);
      }
      if (autoApprove || !GATED_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
      // 승인 요청 발행 → 앱이 diff 모달을 띄우고 POST /permission 으로 응답할 때까지 대기
      const requestId = crypto.randomUUID();
      const fp = input && input.file_path;
      const relPath = fp ? toWorkspaceRelative(userId, projectId, fp) : null;
      const diff = buildDiff(toolName, input, userId, projectId);
      onEvent({ type: 'permission_request', requestId, tool: toolName, input, relPath, diff });
      const decision = await new Promise((resolve) => {
        pendingPermissions.set(requestId, { resolve, userId });
        myPending.add(requestId);
      });
      myPending.delete(requestId);
      if (decision && decision.decision === 'allow') {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: (decision && decision.message) || '사용자가 수정을 거부했습니다.' };
    },
  };
  if (abortController) options.abortController = abortController;
  if (resumeSessionId) options.resume = resumeSessionId;

  const q = query({ prompt, options });

  try {
    for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          onEvent({ type: 'agent_init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd });
        }
        break;

      case 'assistant': {
        const blocks = (msg.message && msg.message.content) || [];
        for (const b of blocks) {
          if (b.type === 'text') {
            onEvent({ type: 'text', role: 'assistant', text: b.text });
          } else if (b.type === 'thinking') {
            onEvent({ type: 'thinking', text: b.thinking });
          } else if (b.type === 'tool_use') {
            // 파일 도구면 워크스페이스 상대경로를 함께 실어 앱이 에디터 동기화에 사용
            const fp = b.input && b.input.file_path;
            const relPath = fp ? toWorkspaceRelative(userId, projectId, fp) : null;
            onEvent({ type: 'tool_use', toolUseId: b.id, tool: b.name, input: b.input, relPath });
          }
        }
        break;
      }

      case 'user': {
        const blocks = (msg.message && msg.message.content) || [];
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && b.type === 'tool_result') {
              onEvent({
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                ok: !b.is_error,
                content: normalizeContent(b.content),
              });
            }
          }
        }
        break;
      }

      case 'result':
        onEvent({
          type: 'done',
          ok: !msg.is_error,
          subtype: msg.subtype,
          summary: msg.result,
          costUsd: msg.total_cost_usd,
          usage: msg.usage,
        });
        break;

      default:
        // stream_event(partial), status, hook 등은 M1 범위 밖 — 무시
        break;
    }
    }
  } finally {
    // 세션 종료/중단 시 남은 승인 요청을 deny 로 풀어 canUseTool 가 매달리지 않게 정리
    for (const rid of myPending) {
      const entry = pendingPermissions.get(rid);
      if (entry) {
        pendingPermissions.delete(rid);
        entry.resolve({ decision: 'deny', message: '세션이 종료되었습니다.' });
      }
    }
  }

  return workdir;
}

module.exports = {
  runAgentQuery,
  resolvePermissionResponse,
  workspaceDir,
  seedWorkspace,
  readWorkspaceFile,
  toWorkspaceRelative,
  normalizeContent,
  DEFAULT_MODEL,
};
