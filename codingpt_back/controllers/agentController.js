/**
 * 바이브코딩 에이전트 컨트롤러
 * POST /api/agent/query              — 에이전트 실행 (SSE 스트림)
 * POST /api/agent/:sessionId/permission — 수정 승인 응답 (M2 에서 활성화)
 */
const agentService = require('../services/agentService');
const agentProxyService = require('../services/agentProxyService');
const usageService = require('../services/usageService');
const subscriptionService = require('../services/subscriptionService');
const BILLING = require('../config/billing');

/**
 * 에이전트 실행 — SDK 이벤트를 SSE 로 스트리밍
 * body: { prompt, sessionId?, model? }
 */
const runAgent = async (req, res) => {
  const { prompt, sessionId, model, projectId, files, autoApprove, mode } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, message: '프롬프트가 필요합니다.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 에 추가 후 서버를 재시작하세요.',
    });
  }

  // Free 플랜 게이트 — 워크스페이스(바이브코딩, mode!=='chat')는 Pro 이상만. 채팅(mode==='chat')은 free 허용.
  // BILLING.ENFORCE 와 독립(항상 적용 — 무료 남용 방지). 조회 실패 시 허용(fail-open).
  if (req.user && req.user.id && mode !== 'chat') {
    try {
      const plan = await subscriptionService.resolvePlanForUser(req.user.id);
      if (plan && plan.code === 'free') {
        return res.status(403).json({
          success: false,
          code: 'PLAN_REQUIRED',
          planCode: 'free',
          upgradeUrl: `${BILLING.PAYMENT_WEB_URL}/me`,
          message: '워크스페이스 바이브코딩은 Pro 이상에서 사용할 수 있어요. 플랜을 업그레이드하세요.',
        });
      }
    } catch (e) {
      console.error('[AgentController] 플랜 게이트 확인 실패(허용 처리):', e.message);
    }
  }

  // 사용량 프리플라이트 게이트 — SSE 헤더 쓰기 전(일반 JSON 으로 429/402 반환 가능).
  // BILLING.ENFORCE 가 켜져 있을 때만 차단. 게이트 조회 실패 시엔 허용(fail-open).
  if (BILLING.ENFORCE && req.user && req.user.id) {
    try {
      const gate = await usageService.checkAllowance(req.user.id);
      if (!gate.allowed) {
        const httpStatus = gate.reason === 'weekly_exceeded' ? 402 : 429;
        return res.status(httpStatus).json({
          success: false,
          code: 'USAGE_LIMIT_REACHED',
          reason: gate.reason,
          planCode: gate.planCode,
          windowResetAt: gate.windowResetAt,
          weeklyResetAt: gate.weeklyResetAt,
          windowUsedUnits: gate.windowUsedUnits,
          windowLimitUnits: gate.windowLimitUnits,
          weeklyUsedUnits: gate.weeklyUsedUnits,
          weeklyLimitUnits: gate.weeklyLimitUnits,
          upgradeUrl: `${BILLING.PAYMENT_WEB_URL}/pricing`,
          message: '사용량 한도에 도달했습니다. 한도 초기화를 기다리거나 플랜을 업그레이드하세요.',
        });
      }
    } catch (e) {
      console.error('[AgentController] 사용량 게이트 확인 실패(허용 처리):', e.message);
    }
  }

  // SSE 헤더 (executorService 패턴과 동일)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 사용량 미터링: agent_init 에서 session_id 포착, done 에서 1회 적재(fire-and-forget).
  // 스트림을 절대 블록/중단하지 않는다 — 실패는 로그만.
  let meterSessionId = sessionId || null;
  let metered = false;
  const send = (o) => {
    try {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
    } catch (_) {
      /* noop */
    }
    try {
      if (o && o.type === 'agent_init' && o.sessionId) meterSessionId = o.sessionId;
      if (o && o.type === 'done' && !metered) {
        metered = true;
        usageService
          .recordTurn({
            userId: req.user && req.user.id,
            sessionId: meterSessionId,
            projectId,
            costUsd: o.costUsd,
            usage: o.usage,
          })
          .catch((e) => console.error('[AgentController] 사용량 적재 실패:', e.message));
      }
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
        { prompt, userId, projectId, files, model, mode, resumeSessionId: sessionId, autoApprove: !!autoApprove },
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
        mode,
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
 * 워크스페이스 파일 트리 — IDE 파일트리용.
 * GET /api/agent/files?projectId=<id>
 */
const getFiles = async (req, res) => {
  const projectId = req.query.projectId;
  const userId = req.user && req.user.id;
  if (agentProxyService.isEnabled()) {
    try {
      const { status, body } = await agentProxyService.listFiles({ userId, projectId });
      return res.status(status || 200).json(body);
    } catch (e) {
      return res.status(502).json({ success: false, message: '워커 연결 실패: ' + e.message });
    }
  }
  try {
    const tree = agentService.listWorkspaceFiles(userId, projectId);
    return res.json({ success: true, tree });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || '파일 목록을 읽을 수 없습니다.' });
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

/**
 * 워크스페이스 파일 쓰기 — IDE 에디터 편집을 샌드박스 FS 에 반영(dev 서버/HMR 감지).
 * POST /api/agent/file  body: { path, content, projectId? }
 */
const writeFile = async (req, res) => {
  const { path: relPath, content, projectId } = req.body || {};
  const userId = req.user && req.user.id;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ success: false, message: 'path 가 필요합니다.' });
  }
  if (agentProxyService.isEnabled()) {
    try {
      const { status, body } = await agentProxyService.writeFile({ userId, projectId, path: relPath, content });
      return res.status(status || 200).json(body);
    } catch (e) {
      return res.status(502).json({ success: false, message: '워커 연결 실패: ' + e.message });
    }
  }
  try {
    agentService.writeWorkspaceFile(userId, projectId, relPath, content);
    return res.json({ success: true, path: relPath });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || '파일을 쓸 수 없습니다.' });
  }
};

/**
 * 샌드박스 터미널 — 임의 셸 명령을 사용자 샌드박스에서 실행하고 출력을 SSE 로 스트리밍.
 * POST /api/agent/exec  body: { command, cwd?, projectId? }
 */
const terminalExec = async (req, res) => {
  const { command, cwd, projectId } = req.body || {};
  const userId = req.user && req.user.id;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, message: 'command 가 필요합니다.' });
  }
  if (!agentProxyService.isEnabled()) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', message: '터미널은 샌드박스(워커) 환경에서만 사용할 수 있습니다.' })}\n\n`);
    return res.end();
  }
  return agentProxyService.proxyExec({ userId, projectId, command, cwd }, res);
};

module.exports = { runAgent, getFile, getFiles, writeFile, permission, terminalExec };
