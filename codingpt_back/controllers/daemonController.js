/**
 * BYO-PC 데몬 컨트롤러 — 페어링/상태/터미널 토큰 HTTP API
 *
 * 페어링(기기 등록):
 *  1) 앱(인증됨) POST /api/daemon/pair/code → 8자리 일회용 코드 발급(10분)
 *  2) PC 데몬    POST /api/daemon/pair/claim {code, deviceName, ...} → deviceToken 발급
 *     (무인증 — 코드 자체가 비밀. 코드는 single-use, 만료 시 폐기)
 *  3) 데몬은 deviceToken 으로 제어 WS(/api/daemon/connect) 인증. 원문은 데몬만 보관,
 *     서버는 sha256 해시만 저장(daemon_device.token_hash).
 */
const crypto = require('crypto');
const { DaemonDevice } = require('../models');
const daemonRelayService = require('../services/daemonRelayService');
const cloudRunnerService = require('../services/cloudRunnerService');
const { successResponse, errorResponse } = require('../utils/response');

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const pairCodes = new Map(); // code → { userId, expiresAt }

const _sweeper = setInterval(() => {
  const now = Date.now();
  for (const [c, s] of pairCodes) { if (s.expiresAt < now) pairCodes.delete(c); }
}, 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

// 헷갈리는 문자(0/O, 1/I/L) 제외 — 사용자가 눈으로 옮겨 적는 코드.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genPairCode() {
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return `${pick(4)}-${pick(4)}`;
}

// POST /api/daemon/pair/code  (인증) → { code, expiresAt }
async function createPairCode(req, res) {
  try {
    const userId = req.user && req.user.id;
    const code = genPairCode();
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    pairCodes.set(code, { userId, expiresAt });
    return successResponse(res, { code, expiresAt: new Date(expiresAt).toISOString() });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/pair/claim  (무인증 — 코드가 비밀)
// body: { code, deviceName, platform, daemonVersion } → { deviceId, deviceToken }
async function claimPairCode(req, res) {
  try {
    const { code, deviceName, platform, daemonVersion } = req.body || {};
    const normalized = String(code || '').trim().toUpperCase();
    const sess = pairCodes.get(normalized);
    if (!sess || sess.expiresAt < Date.now()) {
      pairCodes.delete(normalized);
      return errorResponse(res, new Error('페어링 코드가 유효하지 않거나 만료되었습니다.'), 400);
    }
    pairCodes.delete(normalized); // single-use

    const deviceToken = 'cptd_' + crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
    const device = await DaemonDevice.create({
      user_id: sess.userId,
      device_name: String(deviceName || 'PC').slice(0, 128),
      platform: platform ? String(platform).slice(0, 32) : null,
      daemon_version: daemonVersion ? String(daemonVersion).slice(0, 32) : null,
      token_hash: tokenHash,
    });
    console.log(`[daemon] 기기 페어링 완료 userId=${sess.userId} device=${device.device_name}(#${device.id})`);
    return successResponse(res, { deviceId: device.id, deviceToken });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// GET /api/daemon/status  (인증) → { online, current, devices }
async function getStatus(req, res) {
  try {
    const userId = req.user && req.user.id;
    const conn = daemonRelayService.getConnection(userId);
    const devices = await DaemonDevice.findAll({
      where: { user_id: userId, revoked_at: null },
      order: [['created_at', 'DESC']],
    });
    return successResponse(res, {
      online: !!conn,
      current: conn ? {
        deviceId: conn.deviceId,
        deviceName: conn.deviceName,
        platform: conn.platform,
        daemonVersion: conn.daemonVersion,
        connectedAt: new Date(conn.connectedAt).toISOString(),
      } : null,
      runners: daemonRelayService.listRunners(userId), // M5: 연결된 러너 목록(local+cloud), active 표식

      devices: devices.map((d) => ({
        deviceId: d.id,
        deviceName: d.device_name,
        platform: d.platform,
        daemonVersion: d.daemon_version,
        lastSeenAt: d.last_seen_at,
        online: !!(conn && conn.deviceId === d.id),
      })),
    });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/runner/activate  (인증) body:{ runnerId } 또는 { kind:'local'|'cloud' } → 활성 러너 전환(핸드오프, M5)
//  로컬↔클라우드 러너가 둘 다 연결돼 있을 때 RPC/스트림 라우팅 대상을 바꾼다.
//  kind 로 주면 그 종류의 연결된 러너를 골라 활성화(앱이 status 왕복 없이 전환).
async function activateRunner(req, res) {
  try {
    const b = req.body || {};
    let runnerId = Number(b.runnerId);
    if (!runnerId && (b.kind === 'local' || b.kind === 'cloud')) {
      const match = daemonRelayService.listRunners(req.user.id).find((r) => r.kind === b.kind);
      if (!match) return errorResponse(res, new Error(`연결된 ${b.kind} 러너가 없습니다.`), 409);
      runnerId = match.deviceId;
    }
    if (!runnerId) return errorResponse(res, new Error('runnerId 또는 kind 가 필요합니다.'), 400);
    const ok = daemonRelayService.setActiveRunner(req.user.id, runnerId);
    if (!ok) return errorResponse(res, new Error('해당 러너가 연결되어 있지 않습니다.'), 409);
    return successResponse(res, { active: runnerId, runners: daemonRelayService.listRunners(req.user.id) });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/runner/cloud/ensure  (인증) body:{ workspaceId } → 클라우드 러너 확보(핸드오프 진입점, M5 Slice4)
//  (user,workspace)별 cloud DaemonDevice 프로비저닝 + 컨테이너 기동. docker.sock 없으면(로컬 dev)
//  graceful: launched=false·needsManualRun=true 로 반환하고 back 콘솔에 수동 docker run 힌트를 남긴다.
//  deviceToken 원문은 앱에 반환하지 않는다(컨테이너 env 주입용). 앱은 runnerId 로 연결 대기→activate.
async function ensureCloudRunner(req, res) {
  try {
    const workspaceId = (req.body && req.body.workspaceId) || null;
    if (!workspaceId) return errorResponse(res, new Error('workspaceId 가 필요합니다.'), 400);
    const { deviceId, deviceToken } = await cloudRunnerService.provisionDevice(req.user.id, { workspaceId, deviceName: '클라우드 러너' });
    const volumeName = `cpt-vol-${req.user.id}-${String(workspaceId).replace(/[^A-Za-z0-9_.-]/g, '')}`;
    let launched = false;
    let needsManualRun = false;
    try {
      await cloudRunnerService.launchContainer(req.user.id, { deviceToken, deviceName: '클라우드 러너', workspaceId, volumeName });
      launched = true;
    } catch (e) {
      // docker.sock 미가용(로컬 dev): 명시 503 또는 소켓 연결 실패(ENOENT/ECONNREFUSED) → graceful 수동 기동.
      const noDocker = e && (e.statusCode === 503 || e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || /docker\.sock/i.test(e.message || ''));
      if (noDocker) {
        needsManualRun = true;
        const net = process.env.CLOUD_RUNNER_NETWORK || 'codingpt_service_codingpt_local';
        // 개발자 수동 기동용 힌트(토큰은 콘솔에만, 응답엔 안 실림).
        console.log(`[cloudRunner] docker.sock 미가용 — 수동 기동:\n  docker run -d --rm --name cpt-runner-${req.user.id}-${deviceId} --network ${net} -e RUNNER_SERVER_URL=${process.env.CLOUD_RUNNER_SERVER_URL || 'http://back:5300'} -e RUNNER_TOKEN=${deviceToken} ${cloudRunnerService.RUNNER_IMAGE}`);
      } else { throw e; }
    }
    return successResponse(res, { runnerId: deviceId, launched, needsManualRun });
  } catch (e) {
    return errorResponse(res, e, (e && e.statusCode) || 500);
  }
}

// POST /api/daemon/devices/:deviceId/revoke  (인증) — 기기 연결 해제(재페어링 필요)
async function revokeDevice(req, res) {
  try {
    const userId = req.user && req.user.id;
    const deviceId = Number(req.params.deviceId);
    const device = await DaemonDevice.findOne({ where: { id: deviceId, user_id: userId, revoked_at: null } });
    if (!device) return errorResponse(res, new Error('기기를 찾을 수 없습니다.'), 404);
    await device.update({ revoked_at: new Date() });
    daemonRelayService.disconnectDevice(deviceId);
    return successResponse(res, { deviceId, revoked: true });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/terminal/start  (인증) → { token } — ws 업그레이드는 app.js 에서
async function startTerminal(req, res) {
  try {
    const userId = req.user && req.user.id;
    // cwd: 진입한 워크스페이스 폴더(데몬 홈-기준 상대). 없으면 홈.
    const cwd = (req.body && typeof req.body.cwd === 'string') ? req.body.cwd : '';
    const token = daemonRelayService.issueTerminalToken(userId, cwd);
    return successResponse(res, { token });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// ── 멀티 터미널(tmux window) 관리 — 스트림과 별개의 RPC. 데몬이 -L codingpt 세션의 window 를 조작 ──
// GET /api/daemon/terminal/list?cwd=  (인증) → { windows:[{index,active,command}] }
async function terminalList(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.list', { cwd: req.query.cwd || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/new  (인증) body:{ cwd } → { index }
async function terminalNew(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.new', { cwd: (req.body && req.body.cwd) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/select  (인증) body:{ cwd, index } → { ok }
async function terminalSelect(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.select', { cwd: (req.body && req.body.cwd) || '', index: (req.body && req.body.index) | 0 });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/close  (인증) body:{ cwd, index } → { ok }
async function terminalClose(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.close', { cwd: (req.body && req.body.cwd) || '', index: (req.body && req.body.index) | 0 });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// 데몬 오프라인 시 통일된 409.
function mapRpcError(res, e) {
  if (e.message === 'DAEMON_OFFLINE') {
    return errorResponse(res, new Error('PC 데몬이 연결되어 있지 않습니다.'), 409);
  }
  return errorResponse(res, e, 500);
}

// GET /api/daemon/fs/list?path=  (인증) — 데몬 파일 목록
async function fsList(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.list', { path: req.query.path || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/tree?path=  (인증) — 선택 폴더 아래 파일 flat 목록(모바일 IDE 소스용)
async function fsTree(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.tree', { path: req.query.path || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/read?path=&base64=1  (인증) — 텍스트 파일 내용(base64=1 이면 이미지 등 원본 바이트)
async function fsRead(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.read', { path: req.query.path || '', base64: req.query.base64 === '1' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/grep?path=&q=  (인증) — 프로젝트 폴더 내 리터럴(대소문자무시) 검색
async function fsGrep(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.grep', { path: req.query.path || '', query: req.query.q || '' }, 20000);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/write  (인증) body:{ path, content } — 텍스트 저장
async function fsWrite(req, res) {
  try {
    const { path: p, content } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.write', { path: p, content });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/watch  (인증) body:{ path } — 그 디렉토리 변경을 감시(단일). 이벤트는 /events SSE 로.
async function fsWatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.watch', { path: (req.body && req.body.path) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/unwatch  (인증)
async function fsUnwatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.unwatch', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// ── 워크스페이스(Slice2) — PC 에 결정적 스캐폴드 ──
// GET /api/daemon/ws/root  (인증) — 지정된 워크스페이스 루트(홈-기준 상대) 또는 null
async function wsGetRoot(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.getRoot', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/root  (인증) body:{ path } — 워크스페이스 루트 최초 1회(또는 변경) 지정
async function wsSetRoot(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.setRoot', { path: (req.body && req.body.path) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/root/default  (인증) — 권장 루트(~/CodingPT/workspaces, TCC 프롬프트 없음) 생성+지정
async function wsUseDefaultRoot(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.useDefaultRoot', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/create  (인증) body:{ name } — 루트 아래 새 워크스페이스 폴더 스캐폴드
async function wsCreate(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.create', { name: (req.body && req.body.name) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/clone  (인증) body:{ url, name? } — GitHub 레포를 루트 아래로 git clone
//  url 검증은 데몬(ws.clone)이 화이트리스트로 수행. clone 은 네트워크 fetch라 넉넉한 타임아웃(120s).
async function wsClone(req, res) {
  try {
    const url = (req.body && req.body.url) || '';
    const name = (req.body && req.body.name) || '';
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.clone', { url, name }, 120000);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// ── BYO 에이전트(M1) — 데몬이 사용자 claude 를 spawn. 커맨드는 RPC, 이벤트는 /events SSE(agent_event). ──
// POST /api/daemon/agent/start  body:{ cwd, prompt?, resumeId? } → { sessionId }
async function agentStart(req, res) {
  try {
    const { cwd, prompt, resumeId } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.start', { cwd: cwd || '', prompt, resumeId }, 30000);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/input  body:{ sessionId, text }
async function agentInput(req, res) {
  try {
    const { sessionId, text } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.input', { sessionId, text });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/approve  body:{ sessionId, requestId, decision, message? }
async function agentApprove(req, res) {
  try {
    const { sessionId, requestId, decision, message } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.approve', { sessionId, requestId, decision, message });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/interrupt  body:{ sessionId }
async function agentInterrupt(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.interrupt', { sessionId: (req.body || {}).sessionId });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/stop  body:{ sessionId }
async function agentStop(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.stop', { sessionId: (req.body || {}).sessionId });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/agent/status?sessionId=
async function agentStatus(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.status', { sessionId: req.query.sessionId });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/agent/backlog?sessionId=&sinceSeq=  — SSE 유실 보정(이벤트 리플레이)
async function agentBacklog(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.backlog', { sessionId: req.query.sessionId, sinceSeq: req.query.sinceSeq });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/agent/sessions?cwd=  — 이어받기 목록(~/.claude/projects 대화 로그)
async function agentSessions(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.sessions', { cwd: req.query.cwd || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/agent/doctor  — 온보딩 점검(claude/tmux 설치 여부). 데몬이 크레덴셜은 열람하지 않음.
async function agentDoctor(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.doctor', {}, 8000);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// ── BYO 로그인(M5 Slice2) — 활성 러너(주로 클라우드 컨테이너)에서 사용자 claude 계정 로그인 ──
// 크레덴셜(토큰)은 그 러너의 CLAUDE_CONFIG_DIR 에만 안착. 우리는 인증 URL/코드만 중계한다.
// runnerId 를 주면 특정 러너로, 없으면 활성 러너로 라우팅(핸드오프 후 클라우드가 활성).

// POST /api/daemon/agent/login  { runnerId?, useConsole? } — 로그인 시작, 인증 URL 반환.
async function agentLogin(req, res) {
  try {
    const b = req.body || {};
    const opts = b.runnerId != null ? { runnerId: b.runnerId } : undefined;
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.login', { useConsole: !!b.useConsole }, 25000, opts);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/login/submit  { runnerId?, code } — 인증 코드 제출 → 로그인 완료.
async function agentLoginSubmit(req, res) {
  try {
    const b = req.body || {};
    const opts = b.runnerId != null ? { runnerId: b.runnerId } : undefined;
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.loginSubmit', { code: b.code }, 45000, opts);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/agent/login/cancel  { runnerId? } — 진행 중인 로그인 취소.
async function agentLoginCancel(req, res) {
  try {
    const b = req.body || {};
    const opts = b.runnerId != null ? { runnerId: b.runnerId } : undefined;
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.loginCancel', {}, 8000, opts);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/agent/login/status  (runnerId?) — 러너의 claude 로그인 상태(토큰 미노출).
async function agentLoginStatus(req, res) {
  try {
    const opts = req.query.runnerId != null ? { runnerId: req.query.runnerId } : undefined;
    const result = await daemonRelayService.callRpc(req.user.id, 'agent.loginStatus', {}, 8000, opts);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/events  (인증) — 파일 변경 이벤트 SSE. 데몬 fs_event 를 앱으로 push.
function streamEvents(req, res) {
  const userId = req.user && req.user.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  daemonRelayService.addEventClient(userId, res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { /* noop */ } }, 25000);
  req.on('close', () => { clearInterval(ka); daemonRelayService.removeEventClient(userId, res); });
}

// ── 프리뷰(데몬 dev 서버) ──────────────────────────────────────────────
// 사용자가 PC 에서 직접 띄운 dev 서버를 폰 웹뷰로 미리보기. WebView 는 URL 을 직접 로드하므로
// JWT 를 못 싣는다 → 불투명 토큰(userId:port 결정론적 HMAC)으로 사용자/포트 바인딩.
// 사용자 Vite 등은 base='/' 라 런타임 절대경로(/node_modules/…)가 토큰 경로 밖으로 나간다 →
// 첫 로드 시 dpv 쿠키를 심고, 이후 non-/api 루트 요청을 쿠키로 데몬 프록시에 라우팅(previewCookieMiddleware).
const PREVIEW_SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || 'cpt-preview-secret';
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewTokens = new Map(); // token → { userId, port, expiresAt }
const _pvSweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, s] of previewTokens) { if (s.expiresAt < now) previewTokens.delete(t); }
}, 5 * 60 * 1000);
if (_pvSweeper.unref) _pvSweeper.unref();

function previewTokenFor(userId, port) {
  return 'dpv-' + crypto.createHmac('sha256', PREVIEW_SECRET).update(`${userId}:${port}`).digest('hex').slice(0, 18);
}
function resolvePreviewToken(token) {
  const s = previewTokens.get(token);
  if (!s || s.expiresAt < Date.now()) { if (s) previewTokens.delete(token); return null; }
  s.expiresAt = Date.now() + PREVIEW_TTL_MS;
  return s;
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// GET /api/daemon/preview/ports  (인증) — PC 에서 LISTEN 중인 포트 목록
async function previewPorts(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'net.ports', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/preview/start  (인증) body:{ port } → 그 포트로의 무인증 프록시 토큰
async function previewStart(req, res) {
  const port = parseInt((req.body || {}).port, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    return errorResponse(res, new Error('유효한 port 가 필요합니다.'), 400);
  }
  const token = previewTokenFor(req.user.id, port);
  previewTokens.set(token, { userId: req.user.id, port, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return successResponse(res, { token, url: `/api/daemon/preview/${token}/`, port });
}

// ALL /api/daemon/preview/:token(/*)  (무인증) — 진입 프록시. dpv 쿠키를 심고 토큰 경로를 벗겨 데몬으로.
function previewEntry(req, res) {
  const { token } = req.params;
  const sess = resolvePreviewToken(token);
  if (!sess) return res.status(404).end('preview session not found or expired');
  // 이후 이 WebView 의 루트 절대경로 요청을 이 토큰으로 라우팅.
  res.setHeader('Set-Cookie', `dpv=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  const prefix = `/api/daemon/preview/${token}`;
  let path = req.originalUrl.slice(prefix.length) || '/';
  if (!path.startsWith('/')) path = '/' + path;
  return daemonRelayService.proxyHttp(sess.userId, sess.port, path, req, res);
}

// 미들웨어 — non-/api 루트 요청에 dpv 쿠키가 있으면 데몬 dev 서버로 프록시(Vite 절대경로/에셋).
function previewCookieMiddleware(req, res, next) {
  if (req.url.startsWith('/api/')) return next();
  const token = parseCookies(req.headers.cookie).dpv;
  if (!token) return next();
  const sess = resolvePreviewToken(token);
  if (!sess) return next();
  return daemonRelayService.proxyHttp(sess.userId, sess.port, req.originalUrl, req, res);
}

module.exports = {
  createPairCode, claimPairCode, getStatus, revokeDevice, activateRunner, ensureCloudRunner, startTerminal,
  terminalList, terminalNew, terminalSelect, terminalClose,
  fsList, fsTree, fsRead, fsWrite, fsWatch, fsUnwatch, fsGrep, streamEvents,
  wsGetRoot, wsSetRoot, wsUseDefaultRoot, wsCreate, wsClone,
  agentStart, agentInput, agentApprove, agentInterrupt, agentStop, agentStatus, agentBacklog, agentSessions, agentDoctor,
  agentLogin, agentLoginSubmit, agentLoginCancel, agentLoginStatus,
  previewPorts, previewStart, previewEntry, previewCookieMiddleware, resolvePreviewToken,
};
