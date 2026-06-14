/**
 * 바이브코딩 에이전트 컨트롤러
 * POST /api/agent/query              — 에이전트 실행 (SSE 스트림)
 * POST /api/agent/:sessionId/permission — 수정 승인 응답 (M2 에서 활성화)
 */
const agentService = require('../services/agentService');

/**
 * 에이전트 실행 — SDK 이벤트를 SSE 로 스트리밍
 * body: { prompt, sessionId?, model? }
 */
const runAgent = async (req, res) => {
  const { prompt, sessionId, model } = req.body || {};

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
    await agentService.runAgentQuery({
      prompt,
      userId: req.user && req.user.id,
      model,
      resumeSessionId: sessionId,
      abortController,
      onEvent: send,
    });
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
 * 수정 승인 응답 — M2 에서 활성화 (M1 은 자동 승인이라 미사용)
 */
const permission = (req, res) => {
  return res.status(501).json({
    success: false,
    message: '수정 승인 기능은 M2(IDE 연결)에서 활성화됩니다.',
  });
};

module.exports = { runAgent, permission };
