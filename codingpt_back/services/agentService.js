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

// ESM-only SDK — 동적 import 결과를 캐싱
let _sdkPromise = null;
function loadSdk() {
  if (!_sdkPromise) {
    _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return _sdkPromise;
}

const DEFAULT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';

// claude_code 프리셋에 덧붙이는 바이브코딩 에이전트 컨텍스트
const VIBE_SYSTEM_APPEND = [
  '너는 CodingPT 모바일 "바이브코딩" 서비스의 코딩 에이전트다.',
  '사용자는 모바일 IDE 안에서 너와 대화하며 코드를 만든다.',
  '- 작업 디렉토리(워크스페이스)가 단일 진실원이다. 파일을 직접 만들고 수정하라.',
  '- 변경은 가능한 한 작고 명확하게. 설명은 간결하게.',
  '- 코드 실행/확인이 필요하면 Bash 를 사용하라.',
].join('\n');

/**
 * 사용자별 임시 워크스페이스 디렉토리 확보 (M3 에서 격리 컨테이너로 대체 예정)
 */
function ensureWorkspace(userId) {
  const dir = path.join(os.tmpdir(), 'cpt-agent', String(userId == null ? 'anon' : userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 워크스페이스 내 파일 읽기 (에이전트 편집 후 에디터 동기화용).
 * 경로 탐색 공격 방지 — 워크스페이스 밖 접근 차단.
 */
function readWorkspaceFile(userId, relPath) {
  const base = ensureWorkspace(userId);
  const safeRel = path.normalize(String(relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(base, safeRel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('잘못된 경로입니다.');
  }
  return fs.readFileSync(full, 'utf-8');
}

/**
 * 절대 file_path 를 워크스페이스 기준 상대경로로 변환 (없으면 null).
 * 에이전트 이벤트의 file_path 는 절대경로(/tmp/cpt-agent/<userId>/foo.js)로 온다.
 */
function toWorkspaceRelative(userId, absPath) {
  if (!absPath) return null;
  const base = ensureWorkspace(userId);
  const full = path.resolve(String(absPath));
  if (full === base) return '';
  if (full.startsWith(base + path.sep)) return full.slice(base.length + 1);
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
  cwd,
  model,
  resumeSessionId,
  onEvent,
  permissionResolver,
  abortController,
}) {
  const { query } = await loadSdk();
  const workdir = cwd || ensureWorkspace(userId);

  const options = {
    model: model || DEFAULT_MODEL,
    cwd: workdir,
    permissionMode: 'default',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: VIBE_SYSTEM_APPEND },
    // 서브프로세스(Claude Code CLI) stderr 디버깅
    stderr: (data) => console.error('[agent-stderr]', String(data).slice(0, 2000)),
    // 권한 게이트: M1 은 자동 승인, M2 에서 사용자 승인(diff) 연결
    canUseTool: async (toolName, input, opts) => {
      if (typeof permissionResolver === 'function') {
        return permissionResolver(toolName, input, opts);
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };
  if (abortController) options.abortController = abortController;
  if (resumeSessionId) options.resume = resumeSessionId;

  const q = query({ prompt, options });

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
            const relPath = fp ? toWorkspaceRelative(userId, fp) : null;
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

  return workdir;
}

module.exports = {
  runAgentQuery,
  ensureWorkspace,
  readWorkspaceFile,
  toWorkspaceRelative,
  normalizeContent,
  DEFAULT_MODEL,
};
