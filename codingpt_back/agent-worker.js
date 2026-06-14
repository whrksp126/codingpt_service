/**
 * 바이브코딩 에이전트 워커 서버 (M3-full Phase 1)
 *
 * Agent SDK query() 를 **메인 API 프로세스(back) 밖** 별도 컨테이너에서 실행한다.
 * back 은 /api/agent/* 를 이 워커로 SSE/HTTP 프록시(agentProxyService)만 한다.
 * 워크스페이스는 호스트 가시 named volume(/workspace, AGENT_WORKSPACE_ROOT)에 둔다.
 *
 * 구조 선례: executor-server.js(별도 실행 서버) + executeService.js(SSE 프록시).
 *
 * 보안: 이 워커는 **내부 네트워크 전용**(compose expose 만, ports 매핑 금지).
 *       userId 는 back 이 인증 후 신뢰 가능한 값으로 실어 보낸다(워커는 재검증 안 함).
 *
 * 주의: pendingPermissions(승인 대기)는 이 프로세스 메모리에 있으므로 **단일 인스턴스(replica=1)** 유지.
 *       /query 의 permission_request 와 /permission 응답이 같은 워커 프로세스에서 처리돼야 한다.
 */
const express = require('express');
const agentService = require('./services/agentService');

const app = express();
const PORT = process.env.AGENT_WORKER_PORT || 5400;

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'agent-worker', workspaceRoot: process.env.AGENT_WORKSPACE_ROOT || '(tmp)' });
});

/**
 * 에이전트 실행 — SDKMessage 를 SSE 로 스트리밍.
 * body: { prompt, userId, projectId, files, model, resumeSessionId, autoApprove }
 */
app.post('/query', async (req, res) => {
  const { prompt, userId, projectId, files, model, resumeSessionId, autoApprove } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, message: '프롬프트가 필요합니다.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. 워커 .env 에 추가 후 재시작하세요.',
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (o) => {
    try {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
    } catch (_) {
      /* noop */
    }
  };

  // 클라이언트(back 프록시)가 끊으면 query() 중단. 정상 종료(finished)면 abort 안 함.
  const abortController = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) {
      try {
        abortController.abort();
      } catch (_) {
        /* noop */
      }
    }
  });

  try {
    await agentService.runAgentQuery({
      prompt,
      userId,
      projectId,
      seedFiles: files,
      model,
      resumeSessionId,
      autoApprove: !!autoApprove,
      abortController,
      onEvent: send,
    });
  } catch (error) {
    console.error('[agent-worker] 에이전트 실행 오류:', error);
    send({ type: 'error', message: error.message || '에이전트 실행 중 오류가 발생했습니다.' });
  } finally {
    finished = true;
    try {
      res.end();
    } catch (_) {
      /* noop */
    }
  }
});

/**
 * 수정 승인 응답 — 대기 중인 canUseTool 해소.
 * body: { requestId, userId, decision, message }
 */
app.post('/permission', (req, res) => {
  const { requestId, userId, decision, message } = req.body || {};
  if (!requestId || (decision !== 'allow' && decision !== 'deny')) {
    return res.status(400).json({ success: false, message: 'requestId 와 decision(allow|deny) 이 필요합니다.' });
  }
  const ok = agentService.resolvePermissionResponse(requestId, userId, decision, message);
  if (!ok) {
    return res.status(404).json({ success: false, message: '대기 중인 승인 요청을 찾을 수 없습니다.' });
  }
  return res.json({ success: true, requestId, decision });
});

/**
 * 워크스페이스 파일 읽기 — 에이전트 편집 후 에디터 동기화용.
 * GET /file?path=<rel>&projectId=<id>&userId=<id>
 */
app.get('/file', (req, res) => {
  const { path: relPath, projectId, userId } = req.query;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ success: false, message: 'path 가 필요합니다.' });
  }
  try {
    const content = agentService.readWorkspaceFile(userId, projectId, relPath);
    return res.json({ success: true, path: relPath, content });
  } catch (error) {
    const notFound = error.code === 'ENOENT';
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: notFound ? '파일을 찾을 수 없습니다.' : error.message || '파일을 읽을 수 없습니다.',
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 [agent-worker] listening on :${PORT} (workspaceRoot=${process.env.AGENT_WORKSPACE_ROOT || 'tmp'})`);
});
