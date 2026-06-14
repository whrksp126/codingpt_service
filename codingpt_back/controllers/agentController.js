/**
 * 바이브코딩 에이전트 컨트롤러
 * POST /api/agent/query              — 에이전트 실행 (SSE 스트림)
 * POST /api/agent/:sessionId/permission — 수정 승인 응답 (M2 에서 활성화)
 */
const agentService = require('../services/agentService');
const agentProxyService = require('../services/agentProxyService');

/**
 * 에이전트 실행 — SDK 이벤트를 SSE 로 스트리밍
 * body: { prompt, sessionId?, model? }
 */
const runAgent = async (req, res) => {
  const { prompt, sessionId, model, projectId, files, autoApprove } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, message: '프롬프트가 필요합니다.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 에 추가 후 서버를 재시작하세요.',
    });
  }

  // SSE 헤더 (executorService 패턴과 동일)
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

  // 클라이언트가 스트림 도중 끊으면 SDK 질의 중단.
  // 주의: 버퍼링된 POST 는 body 파싱 직후 req 'close' 가 조기 발화하므로
  //       res 'close' 로 감지하고, 정상 종료(finished) 시엔 abort 하지 않는다.
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
    const userId = req.user && req.user.id;
    if (agentProxyService.isEnabled()) {
      // 워커로 SSE 프록시 (실행은 격리된 agent-worker 컨테이너)
      await agentProxyService.proxyQuery(
        { prompt, userId, projectId, files, model, resumeSessionId: sessionId, autoApprove: !!autoApprove },
        { onEvent: send, abortController },
      );
    } else {
      // 폴백: 워커 미설정 시 back 프로세스에서 직접 실행 (기존 동작)
      await agentService.runAgentQuery({
        prompt,
        userId,
        projectId,
        seedFiles: files,
        model,
        resumeSessionId: sessionId,
        autoApprove: !!autoApprove,
        abortController,
        onEvent: send,
      });
    }
  } catch (error) {
    console.error('[AgentController] 에이전트 실행 오류:', error);
    send({ type: 'error', message: error.message || '에이전트 실행 중 오류가 발생했습니다.' });
  } finally {
    finished = true;
    try {
      res.end();
    } catch (_) {
      /* noop */
    }
  }
};

/**
 * 워크스페이스 파일 읽기 — 에이전트 편집 후 에디터 동기화용
 * GET /api/agent/file?path=<relative>
 */
const getFile = async (req, res) => {
  const relPath = req.query.path;
  const projectId = req.query.projectId;
  const userId = req.user && req.user.id;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ success: false, message: 'path 가 필요합니다.' });
  }
  if (agentProxyService.isEnabled()) {
    try {
      const { status, body } = await agentProxyService.getFile({ userId, projectId, path: relPath });
      return res.status(status || 200).json(body);
    } catch (e) {
      return res.status(502).json({ success: false, message: '워커 연결 실패: ' + e.message });
    }
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
};

/**
 * 수정 승인 응답 — diff 모달에서 사용자가 승인/거부한 결과를 받아 대기 중인 canUseTool 을 해소.
 * POST /api/agent/permission  body: { requestId, decision: 'allow'|'deny', message? }
 */
const permission = async (req, res) => {
  const { requestId, decision, message } = req.body || {};
  const userId = req.user && req.user.id;
  if (!requestId || (decision !== 'allow' && decision !== 'deny')) {
    return res.status(400).json({
      success: false,
      message: 'requestId 와 decision(allow|deny) 이 필요합니다.',
    });
  }
  if (agentProxyService.isEnabled()) {
    try {
      const { status, body } = await agentProxyService.proxyPermission({ requestId, userId, decision, message });
      return res.status(status || 200).json(body);
    } catch (e) {
      return res.status(502).json({ success: false, message: '워커 연결 실패: ' + e.message });
    }
  }
  const ok = agentService.resolvePermissionResponse(requestId, userId, decision, message);
  if (!ok) {
    return res.status(404).json({
      success: false,
      message: '대기 중인 승인 요청을 찾을 수 없습니다. (이미 처리되었거나 만료됨)',
    });
  }
  return res.json({ success: true, requestId, decision });
};

module.exports = { runAgent, getFile, permission };
