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
const { DaemonDevice, User } = require('../models');
const daemonRelayService = require('../services/daemonRelayService');
const workspaceService = require('../services/workspaceService');
const cloudRunnerService = require('../services/cloudRunnerService');
const usageService = require('../services/usageService');
const deviceTrustService = require('../services/deviceTrustService'); // E2EE 열쇠 배포(기능2) — 페어링에 열쇠 전달을 얹는다
const BILLING = require('../config/billing');
const RUNNER = require('../config/runner'); // CLOUD_RUNNER_ENABLED — 클라우드 러너 제공 잠정 중단 게이트
const { SERVER_CAPS } = require('../config/caps'); // capability 협상 사전(§2-(d)) — 클라이언트 기능 게이팅용
const { successResponse, errorResponse } = require('../utils/response');

// 클라우드 실행시간 초 쿼터 프리플라이트(M5 Slice5). ENFORCE 꺼져 있으면 항상 통과(실측 전 안전).
//  차단 시 402 + 메시지. 앱은 402=페이월 트리거로 보고 상세는 GET /api/usage/status 로 조회. 로컬은 무제한이라 호출 안 함.
async function cloudAllowanceGate(res, userId) {
  if (!BILLING.ENFORCE) return true;
  const a = await usageService.checkAllowance(userId).catch(() => ({ allowed: true }));
  if (a.allowed) return true;
  const msg = a.reason === 'weekly_exceeded' ? '주간 클라우드 실행시간 한도에 도달했어요.' : '클라우드 실행시간 한도에 도달했어요.';
  errorResponse(res, new Error(msg), 402);
  return false;
}

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
// code → 세션. 한 Map이 두 페어링 모드를 공유한다:
//  · 레거시(앱이 코드 발급):  { userId, expiresAt }               → PC claim 시 device 생성
//  · QR(PC가 세션 발급):      { userId:null, expiresAt, status:'pending'|'approved',
//                              secretHash, meta, deviceId?, deviceName?, deviceToken? }
//    status 필드 유무로 두 모드를 구분한다.
const pairCodes = new Map();

const _sweeper = setInterval(() => {
  const now = Date.now();
  for (const [c, s] of pairCodes) { if (s.expiresAt < now) pairCodes.delete(c); }
}, 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

// 헷갈리는 문자(0/O, 1/I/L) 제외 — QR 미인식 시 눈으로 옮겨 적을 수도 있는 코드.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genPairCode() {
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return `${pick(4)}-${pick(4)}`;
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// deviceToken 발급 + DaemonDevice 생성/재사용 (레거시 claim / QR approve 공용).
//  machineId(데몬이 ~/.codingpt/machine.json 에 영속 보관)가 오면 같은 물리 머신의 기존 host 행을
//  재사용(업서트)한다 — 재로그인/계정 전환마다 새 행이 생기면 워크스페이스 hostDeviceId 가 죽은
//  기기에 고아로 묶여 터미널이 영구 409(DAEMON_OFFLINE)가 된다(실측). 계정이 바뀌면 행을 새 계정으로
//  이관한다(물리 PC 의 주인이 바뀐 것 — 이전 계정의 데몬 토큰은 자동 무효화). machineId 는 자격증명이
//  아닌 서버로만 전송되는 랜덤 UUID — controller 의 deviceUuid 재귀속(registerController)과 동일 원칙.
async function createDeviceForUser(userId, meta) {
  const deviceToken = 'cptd_' + crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(deviceToken);
  const machineId = meta && meta.machineId ? String(meta.machineId).trim().slice(0, 64) : '';
  const fields = {
    user_id: userId,
    device_name: String((meta && meta.deviceName) || 'PC').slice(0, 128),
    platform: meta && meta.platform ? String(meta.platform).slice(0, 32) : null,
    daemon_version: meta && meta.daemonVersion ? String(meta.daemonVersion).slice(0, 32) : null,
    token_hash: tokenHash,
  };
  if (machineId) {
    const existing = await DaemonDevice.findOne({ where: { machine_id: machineId, role: 'host' } });
    if (existing) {
      await existing.update({ ...fields, revoked_at: null, last_seen_at: new Date(), updated_at: new Date() });
      console.log(`[daemon] 기기 재사용(machineId) device=#${existing.id} user=${userId}`);
      return { device: existing, deviceToken };
    }
  }
  const device = await DaemonDevice.create({ ...fields, machine_id: machineId || null });
  return { device, deviceToken };
}

// 컨트롤러(모바일/태블릿) 기기의 안정 식별키 — 앱이 보관하는 deviceUuid 로 파생.
//  컨트롤러는 user JWT 로 인증하므로 deviceToken 이 없지만, token_hash(NOT NULL unique)에
//  이 값을 넣어 upsert 키로 재사용한다(실제 인증 토큰 아님).
function controllerTokenHash(deviceUuid) {
  return sha256('ctrl:' + String(deviceUuid || '').trim());
}

// POST /api/daemon/devices/register  (JWT|deviceToken) — 컨트롤러가 로그인 시 자신을 계정에 등록.
//  deviceUuid(앱 영구 보관) 로 upsert → "내 기기" 목록에 노출. role='controller'.
async function registerController(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const { deviceUuid, deviceName, platform, daemonVersion } = req.body || {};
    const uuid = String(deviceUuid || '').trim();
    if (!uuid) return errorResponse(res, new Error('deviceUuid 가 필요합니다.'), 400);
    const tokenHash = controllerTokenHash(uuid);
    // token_hash 는 전역 unique — 같은 기기(deviceUuid)를 다른 계정이 먼저 등록했을 수 있으므로
    //  token_hash "단독"으로 찾아 현재 사용자로 재귀속한다(user_id 로 필터하면 create 가 unique 위반→500).
    //  deviceUuid 는 자격증명이 아니므로(표시용 메타 행) 재귀속은 안전.
    let device = await DaemonDevice.findOne({ where: { token_hash: tokenHash } });
    if (device) {
      await device.update({
        user_id: acct.userId,
        device_name: String(deviceName || device.device_name || '기기').slice(0, 128),
        platform: platform ? String(platform).slice(0, 32) : device.platform,
        daemon_version: daemonVersion ? String(daemonVersion).slice(0, 32) : device.daemon_version,
        role: 'controller',
        last_seen_at: new Date(),
        revoked_at: null,
        updated_at: new Date(),
      });
    } else {
      device = await DaemonDevice.create({
        user_id: acct.userId,
        device_name: String(deviceName || '기기').slice(0, 128),
        platform: platform ? String(platform).slice(0, 32) : null,
        daemon_version: daemonVersion ? String(daemonVersion).slice(0, 32) : null,
        token_hash: tokenHash,
        role: 'controller',
        runner_kind: 'local',
        last_seen_at: new Date(),
      });
    }
    return successResponse(res, { deviceId: device.id, deviceName: device.device_name, role: 'controller' });
  } catch (e) {
    console.error('registerController 오류:', e && e.name, e && e.message);
    return errorResponse(res, e, 500);
  }
}

// 모양 설정 화이트리스트 — 알 수 없는 키/값은 버린다(전 기기 동기화 페이로드라 오염 방지).
const APPEARANCE_KEYS = {
  uiFont: ['pretendard', 'notoserif', 'gowun', 'gmarket'],
  codeFont: ['default', 'jetbrains', 'fira', 'd2coding'],
  termStyle: ['auto', 'ghostty', 'one', 'dracula', 'solarized'],
};
function sanitizeAppearance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, allowed] of Object.entries(APPEARANCE_KEYS)) {
    if (typeof raw[k] === 'string' && allowed.includes(raw[k])) out[k] = raw[k];
  }
  return Object.keys(out).length ? out : null;
}

// PATCH /api/daemon/me  (JWT|deviceToken) — 프로필(닉네임)·모양 설정(appearance) 수정.
//  appearance 는 계정 전체 동기화 — 저장 후 appearance_event 로 전 기기 팬아웃.
async function updateMe(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const nickname = String((req.body && req.body.nickname) || '').trim().slice(0, 40);
    const appearancePatch = sanitizeAppearance(req.body && req.body.appearance);
    if (!nickname && !appearancePatch) return errorResponse(res, new Error('변경할 내용이 없습니다.'), 400);
    const patch = {};
    if (nickname) patch.nickname = nickname;
    let mergedAppearance = null;
    if (appearancePatch) {
      const cur = await User.findByPk(acct.userId, { attributes: ['appearance'] });
      mergedAppearance = { ...((cur && cur.appearance) || {}), ...appearancePatch };
      patch.appearance = mergedAppearance;
    }
    await User.update(patch, { where: { id: acct.userId } });
    if (mergedAppearance) {
      try { daemonRelayService.fanoutAppearance(acct.userId, mergedAppearance); } catch (_) { /* best-effort */ }
    }
    const u = await User.findByPk(acct.userId, { attributes: ['id', 'email', 'nickname', 'profile_img', 'appearance'] });
    return successResponse(res, { id: u.id, email: u.email, nickname: u.nickname, profileImg: u.profile_img, appearance: u.appearance || null });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// DELETE /api/daemon/account  (JWT|deviceToken) — 회원 탈퇴(PC 앱 경로). 파괴적.
//  앱 경로(userController.deleteUser)와 동일 정리: 탈퇴 통지 팬아웃 → 라이브 기기/클라우드 정리 →
//  objectstore 정리 → DB 트랜잭션 삭제(userService — 연관 테이블 포함).
async function deleteAccount(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const userId = acct.userId;
    try { daemonRelayService.fanoutAccountDeleted(userId); } catch (_) { /* best-effort */ }
    const devices = await DaemonDevice.findAll({ where: { user_id: userId } });
    for (const d of devices) {
      try {
        daemonRelayService.disconnectDevice(d.id);
        if (d.runner_kind === 'cloud' && d.container_id) await cloudRunnerService.stopContainer(d.container_id).catch(() => {});
      } catch (_) { /* best-effort */ }
    }
    try { await require('../services/workspaceService').deleteAllForUser(userId); } catch (e) { console.warn('탈퇴 objectstore 정리 실패(계속 진행):', e.message); }
    await require('../services/userService').deleteUser(userId); // 트랜잭션 — user + 연관(FK CASCADE 포함)
    return successResponse(res, { deleted: true });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// Authorization: Bearer <deviceToken> → DaemonDevice / 계정 스코프 인증(deviceToken|JWT 겸용).
//  middlewares/accountAuth.js 로 추출됨(알림 등 신규 라우트가 미들웨어로 공용). 여기선 기존 동작
//  유지를 위해 같은 함수를 import 해 그대로 사용한다(하위호환).
const { resolveAccount, resolveDeviceUser } = require('../middlewares/accountAuth');

// GET /api/daemon/workspaces  (deviceToken 인증) → 소유자 워크스페이스(클라우드+로컬) 목록.
//  PC 데스크톱 GUI 가 사이드바 목록을 채운다. 별도 OAuth 없이 device 소유권으로 인가.
async function daemonWorkspaces(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const userId = acct.userId;
    const list = await workspaceService.listWorkspaces(userId);
    // 멀티기기: 호스트 이름/온라인 상태 인리치 — JWT 목록(/api/workspaces)과 동일한 공용 헬퍼.
    const enriched = await workspaceService.enrichHosts(userId, list);
    return successResponse(res, enriched);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// GET /api/daemon/me  (deviceToken|JWT) → 이 계정의 사용자 프로필(+모양 설정).
//  PC 데스크톱 GUI 설정 모달의 "계정" 표시용 + 모바일 appearance 부트 동기화(JWT 폴백 허용).
async function daemonMe(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const device = acct.device || null;
    const u = await User.findByPk(acct.userId, {
      attributes: ['id', 'email', 'nickname', 'profile_img', 'role', 'appearance'],
    });
    if (!u) return errorResponse(res, new Error('사용자를 찾을 수 없습니다.'), 404);
    return successResponse(res, {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      profileImg: u.profile_img,
      role: u.role,
      appearance: u.appearance || null,
      deviceId: device ? device.id : null,
      deviceName: device ? device.device_name : null,
    });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// GET /api/daemon/devices  (deviceToken 인증) → 계정의 모든 기기 + 온라인 상태 + 논리 클라우드 호스트.
//  멀티기기: 로그인=자동 등록된 기기들을 한 목록으로. 클라우드 러너(runner_kind=cloud)는 개별 노출하지 않고
//  "항상 켜진 클라우드 호스트" 하나로 접는다. 설계: docs/multi-device-design.md
async function daemonDevices(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const userId = acct.userId;
    const rows = await DaemonDevice.findAll({
      where: { user_id: userId, revoked_at: null },
      order: [['last_seen_at', 'DESC']],
    });
    const online = new Set(daemonRelayService.listRunners(userId).map((r) => r.deviceId));
    // 현재 기기 식별: deviceToken 이면 acct.deviceId, JWT(컨트롤러)면 x-device-uuid 헤더로 파생.
    let currentDeviceId = acct.deviceId;
    if (currentDeviceId == null) {
      const uuid = String(req.headers['x-device-uuid'] || '').trim();
      if (uuid) {
        const self = rows.find((d) => d.token_hash === controllerTokenHash(uuid));
        if (self) currentDeviceId = self.id;
      }
    }
    const devices = [];
    for (const d of rows) {
      if (d.runner_kind === 'cloud') continue; // 클라우드 러너는 아래 논리 호스트로 통합
      devices.push({
        id: d.id,
        name: d.device_name,
        platform: d.platform,
        role: d.role || 'host',
        runnerKind: d.runner_kind,
        online: d.id === currentDeviceId // 이 요청을 보낸 현재 기기는 항상 온라인
          ? true
          : d.role === 'controller'
            ? !!(d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 10 * 60 * 1000)
            : online.has(d.id),
        lastSeenAt: d.last_seen_at,
        isCurrent: d.id === currentDeviceId,
        createdAt: d.created_at,
      });
    }
    // 항상 켜진 클라우드 호스트(우리 제공) — 콜드스타트로 상시 사용 가능한 논리 기기 1개.
    //  클라우드 러너 제공 중단(CLOUD_RUNNER_ENABLED=false) 중엔 노출하지 않는다(진입점 숨김).
    if (RUNNER.CLOUD_ENABLED) {
      devices.push({
        id: 'cloud',
        name: '클라우드',
        platform: 'cloud',
        role: 'host',
        runnerKind: 'cloud',
        online: true,
        virtual: true,
        isCurrent: false,
      });
    }
    return successResponse(res, { devices, currentDeviceId: acct.deviceId });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/workspaces/:wsId/claim  (deviceToken 인증) → 이 로컬 워크스페이스를 요청 호스트에 귀속.
//  멀티기기 백필: hostDeviceId 없던 기존 로컬 워크스페이스를, 그 파일을 실제로 가진 호스트가 클레임.
async function daemonClaimWorkspaceHost(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const wsId = String(req.params.wsId || '');
    const meta = await workspaceService.setWorkspaceHost(device.user_id, wsId, device.id);
    return successResponse(res, meta);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// GET /api/daemon/workspaces/:wsId/session  (deviceToken 인증) → 워크스페이스 세션 상태(이어받기).
//  열린 터미널(tmux window)·IDE 파일·프리뷰 + 레이아웃. 없으면 { session: null }.
async function daemonGetSession(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const wsId = String(req.params.wsId || '');
    const stored = await workspaceService.getWorkspaceSession(acct.userId, wsId);
    return successResponse(res, stored || { session: null });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// PUT /api/daemon/workspaces/:wsId/session  (deviceToken 인증) → 세션 상태 저장(디바운스 푸시).
//  body: { session, updatedBy?:'pc'|'mobile' }. 서버가 updatedAt 을 스탬프.
async function daemonPutSession(req, res) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const wsId = String(req.params.wsId || '');
    const b = req.body || {};
    const saved = await workspaceService.saveWorkspaceSession(acct.userId, wsId, b.session, b.updatedBy);
    return successResponse(res, saved);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/workspaces  (deviceToken 인증) → 새 로컬 워크스페이스 생성. PC GUI 의 "+" 버튼.
// 요청한 hostDeviceId 가 이 사용자 소유의 기기면 그 id 를, 아니면 fallback(요청 기기) 을 반환(권한 우회 방지).
async function resolveOwnedHost(userId, requestedId, fallbackId) {
  const rid = Number(requestedId);
  if (!Number.isInteger(rid) || rid === fallbackId) return fallbackId;
  try {
    const owned = await DaemonDevice.findOne({ where: { id: rid, user_id: userId, revoked_at: null } });
    return owned ? rid : fallbackId;
  } catch (_) { return fallbackId; }
}

async function daemonCreateWorkspace(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const b = req.body || {};
    const isLocal = b.compute === 'local';
    // 클라우드 러너 잠정 중단 — 새 클라우드 워크스페이스 생성 거부(기존 것의 조회/삭제는 그대로).
    if (!isLocal && !RUNNER.CLOUD_ENABLED) {
      return errorResponse(res, new Error('클라우드 워크스페이스 생성이 잠정 중단되어 있어요. 내 PC 폴더에 만들어 주세요.'), 403);
    }
    const meta = await workspaceService.createWorkspace(device.user_id, {
      name: b.name,
      compute: isLocal ? 'local' : 'cloud',
      localPath: typeof b.localPath === 'string' ? b.localPath : undefined,
      // 멀티기기: 로컬 워크스페이스는 호스트 기기에 귀속. 클라이언트가 다른 PC(외부)를 지정하면(b.hostDeviceId)
      //  그 기기(본인 소유 검증)에, 아니면 이 요청을 보낸 기기에 귀속.
      hostDeviceId: isLocal ? (await resolveOwnedHost(device.user_id, b.hostDeviceId, device.id)) : undefined,
      remoteUrl: typeof b.remoteUrl === 'string' ? b.remoteUrl : undefined, // 프로젝트 자동 연결 보조 신호
      stack: Array.isArray(b.stack) ? b.stack : undefined,
    });
    return successResponse(res, meta);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/workspaces/:wsId/project/detach|attach  (deviceToken 인증)
//  PC GUI 의 프로젝트 그룹 수동 교정 — JWT 라우트(workspaceRoutes)와 동일 동작.
async function daemonProjectDetach(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const meta = await workspaceService.detachProject(device.user_id, req.params.wsId);
    return successResponse(res, meta);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

async function daemonProjectAttach(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const meta = await workspaceService.attachProject(device.user_id, req.params.wsId, (req.body || {}).targetWorkspaceId);
    return successResponse(res, meta);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/workspaces/:wsId/git  (deviceToken) — 호스트 데몬의 신선도(브랜치·미커밋·미푸시) 보고.
//  변화 없으면 서비스가 쓰기를 생략한다. 사이드바 배지의 데이터 원천.
async function daemonReportGit(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const meta = await workspaceService.updateGitStatus(device.user_id, req.params.wsId, req.body || {});
    return successResponse(res, { id: meta.id, git: meta.git || null });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// DELETE /api/daemon/workspaces/:wsId  (deviceToken) — 워크스페이스를 목록(objectstore 메타)에서만 삭제.
//  로컬 폴더/파일은 절대 건드리지 않는다(서버 메타 삭제 = 사이드바에서 사라짐). JWT 라우트(/api/workspaces/:id)와 동일 동작.
async function daemonDeleteWorkspace(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const wsId = String(req.params.wsId || '');
    const result = await workspaceService.deleteWorkspace(device.user_id, wsId);
    return successResponse(res, result);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/terminal/start  (deviceToken 인증) → { token } — 클라우드 워크스페이스 pane 용.
//  로컬 워크스페이스는 로컬 tmux 직결이라 이 경로를 안 탄다.
async function daemonTerminalStart(req, res) {
  try {
    const device = await resolveDeviceUser(req);
    if (!device) return errorResponse(res, new Error('유효하지 않은 기기 토큰'), 401);
    const b = req.body || {};
    const cwd = typeof b.cwd === 'string' ? b.cwd : '';
    const paneId = typeof b.paneId === 'string' ? b.paneId : '';
    const win = Number.isInteger(b.win) ? b.win : undefined;
    const client = typeof b.client === 'string' ? b.client : '';
    // hostDeviceId — 다른 PC(호스트)의 워크스페이스를 열 때 대상 러너 지정(활성 러너 무변경).
    const token = daemonRelayService.issueTerminalToken(device.user_id, cwd, paneId, win, client, b.hostDeviceId);
    return successResponse(res, { token });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/ui/ticket  (accountAuth: deviceToken|JWT) → { ticket, wsUrl }
//  deviceToken 기기(PC)는 user JWT 가 없어 /agent/stream?token= 을 못 쓴다 → 60초 1회용 불투명
//  티켓을 발급받아 GET /api/daemon/agent/stream?ticket=<t>(&client=pc) 로 업그레이드한다.
async function uiTicket(req, res) {
  try {
    const ticket = daemonRelayService.issueUiTicket(req.account.userId);
    // 프록시(nginx/Cloudflare) 뒤에서도 올바른 스킴/호스트로 조립.
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    // client=pc 필수 — 이게 없으면 서버가 PC 스트림을 'mobile' 로 태깅해 hasActiveMobileClient 가
    //  항상 true 가 되고(=PC 켜두면) FCM 푸시가 영구 억제된다. PC 티켓 경로는 데스크톱 전용이므로 pc 고정.
    const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${host}/api/daemon/agent/stream?ticket=${encodeURIComponent(ticket)}&client=pc`;
    return successResponse(res, { ticket, wsUrl });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// GET /api/daemon/ui/clients  (accountAuth) → 접속 중인 UI 화면 목록(기기 타겟팅/executor 표기용)
async function uiClients(req, res) {
  try {
    return successResponse(res, { clients: daemonRelayService.listUiClients(req.user.id) });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/pair/code  (인증) → { code, expiresAt }   [레거시 — 앱이 코드 발급]
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

// POST /api/daemon/pair/session  (무인증) → { code, sessionSecret, deepLink, expiresAt }
//  넷플릭스 TV 방식: PC가 세션을 열고 QR(code)을 표시 → 로그인된 앱이 스캔·승인한다.
//  sessionSecret 은 PC만 보관(QR 에는 없음) → 승인 후 이 PC 만 토큰을 claim 할 수 있어 탈취 레이스를 막는다.
async function createPairSession(req, res) {
  try {
    const { deviceName, platform, daemonVersion, machineId, ikX, ikEd } = req.body || {};
    const code = genPairCode();
    const sessionSecret = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    pairCodes.set(code, {
      userId: null,
      expiresAt,
      status: 'pending',
      secretHash: sha256(sessionSecret),
      // machineId → approve 시 기기 행 재사용 키.
      // ikX/ikEd(옵셔널, 기능2) = PC 데몬의 E2EE 신원 공개키. 앱이 승인 시 이 키로 MK 를 봉인해 올린다
      //  → PC 는 claim 응답으로 열쇠까지 함께 받는다(추가 탭 0, 사용자 확정 제약 3).
      //  구 데몬은 안 보내므로 undefined → 열쇠 전달만 생략되고 페어링은 그대로 성공한다.
      meta: { deviceName, platform, daemonVersion, machineId, ikX, ikEd },
    });
    const deepLink = `codingpt://pair?code=${encodeURIComponent(code)}`;
    return successResponse(res, { code, sessionSecret, deepLink, expiresAt: new Date(expiresAt).toISOString() });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// QR 승인 응답에 붙는 E2EE 블록(기능2) — 앱이 "이 PC 공개키로 MK 를 봉인해 달라"는 지시를 받는 자리.
//  · ikX 는 PC 가 pair/session 에 실어 보낸 값이며, QR 에는 그 지문(k=)이 들어 있다 → 앱이 자동 대조한다
//    (오프라인 채널 핀닝 = Orca 공개키 핀닝 등가. 사용자 조작/탭 수는 그대로 0 추가).
//  · 키가 없거나(구 데몬) 기능이 꺼져 있으면 블록 자체를 생략한다 → 기존 페어링 그대로 성공.
async function pairE2eeBlock(userId, sess) {
  const ikX = sess && sess.meta && sess.meta.ikX;
  if (!ikX || !deviceTrustService.ENABLED) return {};
  try {
    const k = await deviceTrustService.keyring(userId, {});
    return { e2ee: { ikX, ikEd: sess.meta.ikEd || null, epoch: k.epoch, policy: k.policy, suite: k.suite, needsGrant: k.epoch > 0 } };
  } catch (e) {
    console.warn('[daemon] 페어링 e2ee 블록 생략:', e && e.message);
    return {};
  }
}

// POST /api/daemon/pair/grant  (인증) — 승인 직후 앱이 PC 공개키로 봉인한 MK 를 업로드.
//  body { code, ikX(에코), sealed, sig, epoch, approverIkX }
//  왜 approve 와 분리했나: approve 는 "기기 생성 + deviceToken 준비"라는 기존 계약을 그대로 둬야 하고
//   (구 앱도 계속 돌아야 한다), 봉인은 앱이 서버 응답의 ikX 를 받은 **뒤에야** 만들 수 있다.
//   구 앱은 이 라우트를 안 부르고 → PC 는 열쇠 없이 페어링만 끝난 뒤 /e2ee/enroll 로 4자리 승인 폴백.
async function pairGrant(req, res) {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const b = req.body || {};
    const normalized = String(b.code || '').trim().toUpperCase();
    const sess = pairCodes.get(normalized);
    if (!sess || sess.expiresAt < Date.now() || sess.status !== 'approved' || String(sess.userId) !== String(userId)) {
      return errorResponse(res, new Error('연결 코드가 유효하지 않거나 만료되었습니다.'), 400);
    }
    if (!sess.meta || !sess.meta.ikX) {
      return errorResponse(res, Object.assign(new Error('이 PC 는 열쇠 전달을 지원하지 않습니다.'),
        { publicDetail: { code: 'HOST_UNSUPPORTED' } }), 409);
    }
    // ★ 앱이 에코한 ikX 가 세션의 것과 다르면 중간에서 대상 키가 바뀐 것 → 봉인 거부.
    if (String(b.ikX || '') !== String(sess.meta.ikX)) {
      return errorResponse(res, Object.assign(new Error('기기 공개키가 일치하지 않습니다.'),
        { publicDetail: { code: 'KEY_MISMATCH' } }), 409);
    }
    const r = await deviceTrustService.grantForPairing(userId, {
      ikX: sess.meta.ikX, ikEd: sess.meta.ikEd || b.ikEd, label: sess.deviceName || (sess.meta.deviceName || 'PC'),
      platform: sess.meta.platform, sealed: b.sealed, sig: b.sig, epoch: b.epoch,
      approverIkX: b.approverIkX, deviceId: sess.deviceId,
    });
    // claim 이 아직 안 왔으면 세션에 실어 둔다(PC 가 폴링으로 받아간다). 이미 claim 했으면 enroll 로 받는다.
    sess.e2ee = r.grant ? { epoch: r.epoch, keyId: r.keyId, ...r.grant } : null;
    return successResponse(res, { ok: true, keyId: r.keyId, epoch: r.epoch });
  } catch (e) {
    return errorResponse(res, e, (e && e.statusCode) || 500);
  }
}

// POST /api/daemon/pair/approve  (인증) — 앱이 스캔한 QR 코드를 승인 → device 생성.
//  body: { code } → { deviceId, deviceName }.  실제 deviceToken 은 PC가 claim 으로 가져간다.
async function approvePairSession(req, res) {
  try {
    const userId = req.user && req.user.id;
    // 유저 실존 확인 — 탈퇴한 계정의 스테일 토큰이면 FK 위반(500) 대신 깔끔한 401 로 재로그인 유도.
    const account = userId != null ? await User.findByPk(userId, { attributes: ['id'] }) : null;
    if (!account) {
      return errorResponse(res, new Error('세션이 만료되었어요. 다시 로그인해 주세요.'), 401);
    }
    const normalized = String((req.body && req.body.code) || '').trim().toUpperCase();
    const sess = pairCodes.get(normalized);
    if (!sess || sess.expiresAt < Date.now() || sess.status == null) {
      return errorResponse(res, new Error('연결 코드가 유효하지 않거나 만료되었습니다.'), 400);
    }
    if (sess.status === 'approved') {
      return successResponse(res, { deviceId: sess.deviceId, deviceName: sess.deviceName, alreadyApproved: true, ...(await pairE2eeBlock(userId, sess)) });
    }
    const { device, deviceToken } = await createDeviceForUser(userId, sess.meta);
    sess.status = 'approved';
    sess.userId = userId;
    sess.deviceId = device.id;
    sess.deviceName = device.device_name;
    sess.deviceToken = deviceToken; // 단명 — PC claim 시 반환하고 세션 폐기
    console.log(`[daemon] QR 승인 userId=${userId} device=${device.device_name}(#${device.id})`);
    // e2ee 블록이 있으면 앱은 곧바로 POST /pair/grant 로 봉인문을 올린다(사용자 탭 추가 0).
    return successResponse(res, { deviceId: device.id, deviceName: device.device_name, ...(await pairE2eeBlock(userId, sess)) });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/pair/claim  (무인증 — 코드/secret 이 비밀)
//  레거시: { code[, deviceName, ...] }        → device 생성 후 { deviceId, deviceToken }
//  QR    : { code, sessionSecret }            → pending 이면 { pending:true }, approved 면 { deviceId, deviceToken }
async function claimPairCode(req, res) {
  try {
    const { code, sessionSecret, deviceName, platform, daemonVersion, machineId } = req.body || {};
    const normalized = String(code || '').trim().toUpperCase();
    const sess = pairCodes.get(normalized);
    if (!sess || sess.expiresAt < Date.now()) {
      pairCodes.delete(normalized);
      return errorResponse(res, new Error('페어링 코드가 유효하지 않거나 만료되었습니다.'), 400);
    }

    // QR 세션(status 존재) → secret 검증 후 승인 상태로 분기
    if (sess.status != null) {
      if (!sessionSecret || sess.secretHash !== sha256(sessionSecret)) {
        return errorResponse(res, new Error('세션 인증에 실패했습니다.'), 403);
      }
      if (sess.status === 'pending') {
        return successResponse(res, { pending: true }); // 아직 앱 승인 전 — PC가 폴링 지속
      }
      pairCodes.delete(normalized); // approved & single-use
      // 열쇠 봉인문이 이미 올라와 있으면 함께 준다(구 데몬은 이 필드를 무시 → 회귀 0).
      //  세션에 없으면 키링에서 한 번 더 조회한다(앱 grant 와 PC claim 폴링의 레이스 흡수).
      let e2ee = sess.e2ee || null;
      if (!e2ee && sess.meta && sess.meta.ikX) {
        e2ee = await deviceTrustService.grantForDevice(sess.userId, sess.meta.ikX);
      }
      return successResponse(res, { deviceId: sess.deviceId, deviceToken: sess.deviceToken, ...(e2ee ? { e2ee } : {}) });
    }

    // 레거시(앱이 코드 발급) — 즉시 device 생성/재사용
    pairCodes.delete(normalized);
    const { device, deviceToken } = await createDeviceForUser(sess.userId, { deviceName, platform, daemonVersion, machineId });
    console.log(`[daemon] 기기 페어링 완료(레거시) userId=${sess.userId} device=${device.device_name}(#${device.id})`);
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
      // 클라우드 러너 제공 여부 — off 면 앱이 클라우드 생성/전환 진입점을 숨긴다(config/runner.js).
      cloudEnabled: RUNNER.CLOUD_ENABLED,
      // 서버가 처리 코드를 가진 신규 능력 목록(config/caps.js). 클라이언트는 자기 caps 와의 교집합으로만
      //  기능을 켠다 — 구 클라이언트는 이 필드를 무시하므로 무영향(additive).
      serverCaps: SERVER_CAPS,
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
    // 클라우드 러너 제공 잠정 중단(CLOUD_RUNNER_ENABLED=false) — 프로비저닝/깨우기 진입 자체를 차단.
    if (!RUNNER.CLOUD_ENABLED) {
      return errorResponse(res, new Error('클라우드 러너 제공이 잠정 중단되어 있어요. 내 PC를 연결해 작업해 주세요.'), 403);
    }
    const workspaceId = (req.body && req.body.workspaceId) || null;
    if (!workspaceId) return errorResponse(res, new Error('workspaceId 가 필요합니다.'), 400);
    // 프리플라이트: 클라우드 실행시간 초 쿼터 초과면 러너 기동/깨우기 차단(ENFORCE 시).
    if (!(await cloudAllowanceGate(res, req.user.id))) return;
    const { deviceId, deviceToken, wasDormant } = await cloudRunnerService.provisionDevice(req.user.id, { workspaceId, deviceName: '클라우드 러너' });
    // 동면 상태였다면(볼륨에 크레덴셜·코드 존재) 콜드스타트 = "환경 깨우는 중…" 진행 표시(best-effort).
    if (wasDormant) { try { daemonRelayService.fanoutSyncEvent(req.user.id, { type: 'sync_progress', phase: 'wake' }); } catch (_) { /* noop */ } }
    let launched = false;
    let needsManualRun = false;
    try {
      // 동시 실행 캡: 이 기기 컨테이너를 올리면 유저당/전역 한도를 넘는지 검사(초과 시 429). RAM 소진 방지.
      await cloudRunnerService.assertCapacity(req.user.id, deviceId);
      const { containerId } = await cloudRunnerService.launchContainer(req.user.id, { deviceToken, deviceName: '클라우드 러너', workspaceId });
      // 동면 시 컨테이너를 찾으려면 container_id 를, 실행시간 계측 위해 container_started_at 를 DB 에 남긴다.
      await DaemonDevice.update({ container_id: containerId, container_started_at: new Date(), updated_at: new Date() }, { where: { id: deviceId } }).catch(() => {});
      launched = true;
    } catch (e) {
      // docker.sock 미가용(로컬 dev): 명시 503 또는 소켓 연결 실패(ENOENT/ECONNREFUSED) → graceful 수동 기동.
      const noDocker = e && (e.statusCode === 503 || e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || /docker\.sock/i.test(e.message || ''));
      if (noDocker) {
        needsManualRun = true;
        const net = process.env.CLOUD_RUNNER_NETWORK || 'codingpt_service_codingpt_local';
        const v = cloudRunnerService.volNames(req.user.id, workspaceId);
        // 개발자 수동 기동용 힌트(토큰은 콘솔에만, 응답엔 안 실림). 3볼륨 마운트 포함 → 수동 검증도 동면/재개 일관.
        console.log(`[cloudRunner] docker.sock 미가용 — 수동 기동:\n  docker run -d --name cpt-runner-${req.user.id}-${deviceId} --network ${net} -v ${v.work}:/workspace -v ${v.claude}:/root/.claude -v ${v.state}:/var/lib/codingpt -e RUNNER_SERVER_URL=${process.env.CLOUD_RUNNER_SERVER_URL || 'http://back:5300'} -e RUNNER_TOKEN=${deviceToken} ${cloudRunnerService.RUNNER_IMAGE}`);
      } else { throw e; }
    }
    return successResponse(res, { runnerId: deviceId, launched, needsManualRun, wasDormant });
  } catch (e) {
    return errorResponse(res, e, (e && e.statusCode) || 500);
  }
}

// POST /api/daemon/devices/:deviceId/revoke  (인증) — 기기 연결 해제(재페어링 필요)
async function revokeDevice(req, res) {
  try {
    const acct = await resolveAccount(req); // deviceToken(PC) | JWT(모바일) 모두 허용
    const userId = acct && acct.userId;
    if (!userId) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    const deviceId = Number(req.params.deviceId);
    const device = await DaemonDevice.findOne({ where: { id: deviceId, user_id: userId, revoked_at: null } });
    if (!device) return errorResponse(res, new Error('기기를 찾을 수 없습니다.'), 404);
    await device.update({ revoked_at: new Date() });
    daemonRelayService.disconnectDevice(deviceId);
    // E2EE 열쇠 무력화 + 회전 유도(기능2) — 해제된 기기는 더 이상 남의 승인자가 될 수 없고,
    //  남은 신뢰 기기에 rotate_needed 가 팬아웃된다. 실패해도 기기 해제 자체는 성공시킨다.
    deviceTrustService.onDeviceRevoked(userId, deviceId).catch(() => {});
    // 클라우드 러너 revoke → 실행시간 계측 마감 + 컨테이너 정지 + 워크스페이스 볼륨 3종 GC(best-effort).
    if (device.runner_kind === 'cloud') {
      await cloudRunnerService.endComputeSpan(device).catch(() => {});
      if (device.container_id) cloudRunnerService.stopContainer(device.container_id).catch(() => {});
      cloudRunnerService.removeVolumes(userId, device.workspace_id).catch(() => {});
    }
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
    // paneId — pane 별 grouped tmux view(여러 터미널 pane 이 각자 다른 window 동시 표시). 없으면 공유 세션.
    const paneId = (req.body && typeof req.body.paneId === 'string') ? req.body.paneId : '';
    // win — 이 pane 이 표시할 tmux window(정수). grouped view attach 시 이 window 로 select(경쟁 방지).
    const winRaw = req.body && req.body.win;
    const win = Number.isInteger(winRaw) ? winRaw : (typeof winRaw === 'string' && /^\d+$/.test(winRaw) ? parseInt(winRaw, 10) : undefined);
    // client — 요청 기기의 안정 키. pane 세션을 기기별로 분리(같은 세션 다중 attach 시 tmux 크기 공유 방지).
    const client = (req.body && typeof req.body.client === 'string') ? req.body.client : '';
    // hostDeviceId — 다른 PC(호스트) 지정(멀티 PC). 없으면 활성 러너(기존 동작).
    const token = daemonRelayService.issueTerminalToken(userId, cwd, paneId, win, client, req.body && req.body.hostDeviceId);
    return successResponse(res, { token });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// ── 멀티 터미널(tmux window) 관리 — 스트림과 별개의 RPC. 데몬이 -L codingpt 세션의 window 를 조작 ──
// GET /api/daemon/terminal/list?cwd=  (인증) → { windows:[{index,active,command}] }
async function terminalList(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.list', { cwd: req.query.cwd || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/new  (인증) body:{ cwd } → { index }
async function terminalNew(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.new', { cwd: (req.body && req.body.cwd) || '', paneId: (req.body && req.body.paneId) || '', client: (req.body && req.body.client) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/select  (인증) body:{ cwd, index, claim } → { ok }
//  claim=true(사용자 터치/포커스/탭 클릭)일 때만 데몬이 창 크기를 이 기기로 리사이즈.
async function terminalSelect(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.select', { cwd: (req.body && req.body.cwd) || '', index: (req.body && req.body.index) | 0, paneId: (req.body && req.body.paneId) || '', client: (req.body && req.body.client) || '', claim: !!(req.body && req.body.claim) }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/close  (인증) body:{ cwd, index } → { ok }
async function terminalClose(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.close', { cwd: (req.body && req.body.cwd) || '', index: (req.body && req.body.index) | 0, paneId: (req.body && req.body.paneId) || '', client: (req.body && req.body.client) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/terminal/unview  (인증) body:{ cwd, index, paneId, client } → { ok }
//  pane 뷰에서 탭 제거(풀 터미널은 보존) — 탭 드래그 이동의 src 측.
async function terminalUnview(req, res) {
  try {
    const b = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'terminal.unview', { cwd: b.cwd || '', index: b.index | 0, paneId: b.paneId || '', client: b.client || '' }, undefined, connOptsOf(req));
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

// fs/프리뷰 RPC 의 대상 호스트 지정 — 터미널 device-start 와 동일 규약(hostDeviceId=DaemonDevice.id).
//  미지정이면 기존대로 활성 러너. 활성 러너를 바꾸지 않고 특정 PC 를 직결한다(PC 앱 원격 IDE/프리뷰).
function connOptsOf(req) {
  const raw = (req.query && req.query.hostDeviceId) != null ? req.query.hostDeviceId
    : (req.body && req.body.hostDeviceId);
  if (raw == null || raw === '') return undefined;
  const rid = Number(raw);
  return Number.isInteger(rid) ? { runnerId: rid } : undefined;
}

// GET /api/daemon/fs/list?path=  (인증) — 데몬 파일 목록
async function fsList(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.list', { path: req.query.path || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/tree?path=  (인증) — 선택 폴더 아래 파일 flat 목록(모바일 IDE 소스용)
async function fsTree(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.tree', { path: req.query.path || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/read?path=&base64=1  (인증) — 텍스트 파일 내용(base64=1 이면 이미지 등 원본 바이트)
async function fsRead(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.read', { path: req.query.path || '', base64: req.query.base64 === '1' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/grep?path=&q=  (인증) — 프로젝트 폴더 내 리터럴(대소문자무시) 검색
async function fsGrep(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.grep', { path: req.query.path || '', query: req.query.q || '' }, 20000, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/write  (인증) body:{ path, content, base64? } — 텍스트 저장(base64=true 면 바이너리 첨부)
async function fsWrite(req, res) {
  try {
    const { path: p, content, base64 } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.write', { path: p, content, base64: !!base64 }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/mkdir  (인증) body:{ path } — 디렉토리 생성
async function fsMkdir(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.mkdir', { path: (req.body && req.body.path) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/fs/create  (인증) body:{ path } — 빈 파일 생성
async function fsCreateFile(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.createFile', { path: (req.body && req.body.path) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/fs/rename  (인증) body:{ path, dest } — 이름변경/이동
async function fsRename(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.rename', { path: (req.body && req.body.path) || '', dest: (req.body && req.body.dest) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}
// POST /api/daemon/fs/delete  (인증) body:{ path } — 삭제(재귀)
async function fsDelete(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.delete', { path: (req.body && req.body.path) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/watch  (인증) body:{ path } — 그 디렉토리 변경을 감시(단일). 이벤트는 /events SSE 로.
async function fsWatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.watch', { path: (req.body && req.body.path) || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/unwatch  (인증)
async function fsUnwatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.unwatch', {}, undefined, connOptsOf(req));
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


// POST /api/daemon/ws/create  (인증) body:{ name, parentPath? } — 선택한 폴더 아래 새 워크스페이스 스캐폴드
//  parentPath: 사용자가 이번 생성마다 고르는 목적지 부모(홈-기준 상대, 전체 디스크 모드면 절대경로).
async function wsCreate(req, res) {
  try {
    const params = { name: (req.body && req.body.name) || '' };
    // path=선택 폴더 자체를 워크스페이스로 지정(designate). parentPath=(레거시) 하위폴더 생성.
    if (req.body && typeof req.body.path === 'string') params.path = req.body.path;
    if (req.body && req.body.parentPath) params.parentPath = req.body.parentPath;
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.create', params);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/clone  (인증) body:{ url, name?, parentPath? } — GitHub 레포를 선택한 폴더 아래로 clone
//  url 검증은 데몬(ws.clone)이 화이트리스트로 수행. clone 은 네트워크 fetch라 넉넉한 타임아웃(120s).
async function wsClone(req, res) {
  try {
    const url = (req.body && req.body.url) || '';
    const name = (req.body && req.body.name) || '';
    const params = { url, name };
    if (req.body && req.body.parentPath) params.parentPath = req.body.parentPath;
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.clone', params, 120000);
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/fulldisk  (인증) body:{ enabled } — 전체 디스크 접근 토글(홈 jail 완화)
//  실제 무프롬프트 접근은 사용자가 데몬에 macOS 전체 디스크 접근(FDA)을 부여해야 완성됨(앱이 안내).
async function wsSetFullDisk(req, res) {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.setFullDisk', { enabled });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// ── BYO 에이전트(M1) — 데몬이 사용자 claude 를 spawn. 커맨드는 RPC, 이벤트는 /events SSE(agent_event). ──
// POST /api/daemon/agent/start  body:{ cwd, prompt?, resumeId? } → { sessionId }
async function agentStart(req, res) {
  try {
    const { cwd, prompt, resumeId } = req.body || {};
    // 활성 러너가 클라우드면 실행시간 초 쿼터 프리플라이트(ENFORCE 시). 로컬 활성이면 무제한 → 게이트 스킵.
    const conn = daemonRelayService.getConnection(req.user.id);
    if (conn && conn.kind === 'cloud') { if (!(await cloudAllowanceGate(res, req.user.id))) return; }
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

// ── 트랜스크립트 채팅(기능5) — 데몬 JSONL 리더 RPC 의 얇은 프록시 ──────────────────────────
// 기존 callRpc 릴레이로 충분하므로 새 배관을 만들지 않는다(라우트+얇은 래퍼만).
//  · 인증 = accountAuth(라우트에 부착) → JWT|deviceToken 겸용. PC 앱도 deviceToken 으로 호출한다.
//  · hostDeviceId 지정 = connOptsOf(req)(멀티 PC). 미지정이면 활성 러너.
//  · 라이브 델타는 여기가 아니라 데몬 chat_event → fanoutChatEvent(WSS/SSE). 캐치업은 chat.since pull.
//  · 킬스위치 TRANSCRIPT_ENABLED=0 → 즉시 403(caps 도 선언되지 않아 클라이언트가 탭을 숨긴다).
const TRANSCRIPT_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.TRANSCRIPT_ENABLED || '').trim());
function chatRpc(method, paramsOf, timeoutMs) {
  return async (req, res) => {
    if (!TRANSCRIPT_ENABLED) {
      return errorResponse(res, Object.assign(new Error('트랜스크립트 기능이 꺼져 있습니다.'),
        { publicDetail: { code: 'TRANSCRIPT_DISABLED' } }), 403);
    }
    try {
      const result = await daemonRelayService.callRpc(req.user.id, method, paramsOf(req), timeoutMs, connOptsOf(req));
      return successResponse(res, result);
    } catch (e) { return mapRpcError(res, e); }
  };
}
const qOf = (req) => req.query || {};
const bOf = (req) => req.body || {};
// GET  /api/daemon/chat/sessions?cwd=            → { supported, agent, sessions:[…] }
const chatSessions = chatRpc('chat.sessions', (req) => ({ cwd: qOf(req).cwd || '' }), 20000);
// POST /api/daemon/chat/open      { cwd, tid?, sessionId?, limit? } → { chatId, epoch, headSeq, messages }
const chatOpen = chatRpc('chat.open', (req) => ({
  cwd: bOf(req).cwd || '', tid: bOf(req).tid, sessionId: bOf(req).sessionId, limit: bOf(req).limit,
}), 25000);
// GET  /api/daemon/chat/since?chatId=&sinceSeq=&epoch=  → { epoch, headSeq, messages } | { epochChanged }
const chatSince = chatRpc('chat.since', (req) => ({
  chatId: qOf(req).chatId || '', sinceSeq: Number(qOf(req).sinceSeq) || 0, epoch: qOf(req).epoch || '',
}), 20000);
// POST /api/daemon/chat/close     { chatId } → { ok }
const chatClose = chatRpc('chat.close', (req) => ({ chatId: bOf(req).chatId || '' }), 8000);
// GET  /api/daemon/chat/detail?chatId=&seq=     → { raw, truncated }
const chatDetail = chatRpc('chat.detail', (req) => ({ chatId: qOf(req).chatId || '', seq: Number(qOf(req).seq) || 0 }), 15000);
// GET  /api/daemon/chat/attachment?chatId=&seq=&idx=  → { mediaType, base64, bytes }
const chatAttachment = chatRpc('chat.attachment', (req) => ({
  chatId: qOf(req).chatId || '', seq: Number(qOf(req).seq) || 0, idx: Number(qOf(req).idx) || 0,
}), 20000);
// POST /api/daemon/chat/input     { cwd, tid, text, submit?, submitDelayMs? } → { ok, tid, bytes }
//  입력은 데몬이 tmux bracketed paste 로 넣는다(터미널 세션 재사용 — 새 세션/attach 금지).
const chatInput = chatRpc('chat.input', (req) => ({
  cwd: bOf(req).cwd || '', tid: bOf(req).tid, text: typeof bOf(req).text === 'string' ? bOf(req).text : '',
  submit: bOf(req).submit !== false, submitDelayMs: bOf(req).submitDelayMs,
}), 15000);

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
  // client=pc|mobile(기본 mobile) — 구독 기기 종류 태그. FCM 억제 판정(hasActiveMobileClient)에 사용.
  daemonRelayService.addEventClient(userId, res, req.query.client);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { /* noop */ } }, 25000);
  req.on('close', () => { clearInterval(ka); daemonRelayService.removeEventClient(userId, res); });
}

// ── 프리뷰(데몬 dev 서버) ──────────────────────────────────────────────
// 사용자가 PC 에서 직접 띄운 dev 서버를 폰 웹뷰로 미리보기. WebView 는 URL 을 직접 로드하므로
// JWT 를 못 싣는다 → 불투명 토큰(userId:port 결정론적 HMAC)으로 사용자/포트 바인딩.
// 사용자 Vite 등은 base='/' 라 런타임 절대경로(/node_modules/…)가 토큰 경로 밖으로 나간다 →
// 첫 로드 시 dpv 쿠키를 심고, 이후 non-/api 루트 요청을 쿠키로 데몬 프록시에 라우팅(previewCookieMiddleware).
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewTokens = new Map(); // token → { userId, port, runnerId, expiresAt }
const _pvSweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, s] of previewTokens) { if (s.expiresAt < now) previewTokens.delete(t); }
}, 5 * 60 * 1000);
if (_pvSweeper.unref) _pvSweeper.unref();

// 프리뷰 토큰은 예측 불가능한 랜덤 값(맵이 진실원본). 과거의 결정론적 HMAC(userId:port) 방식은
//  하드코딩 시크릿 폴백과 결합해 오프라인 계산으로 타인 dev 서버에 무인증 접근을 허용했다 → 랜덤화.
function previewTokenFor() {
  return 'dpv-' + crypto.randomBytes(24).toString('hex');
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
    // cwd(워크스페이스 폴더, 홈-기준 상대) — 그 폴더 안에서 실행 중인 프로세스의 포트만 감지.
    const result = await daemonRelayService.callRpc(req.user.id, 'net.ports', { cwd: req.query.cwd || '' }, undefined, connOptsOf(req));
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/preview/start  (인증) body:{ port, hostDeviceId? } → 그 포트로의 무인증 프록시 토큰
//  hostDeviceId 지정 시 그 PC 의 dev 서버로 터널(활성 러너 무변경) — 미지정=기존대로 활성 러너.
async function previewStart(req, res) {
  const port = parseInt((req.body || {}).port, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    return errorResponse(res, new Error('유효한 port 가 필요합니다.'), 400);
  }
  const opts = connOptsOf(req);
  const runnerId = opts ? opts.runnerId : null;
  if (opts && !daemonRelayService.pickConn(req.user.id, opts)) {
    return errorResponse(res, new Error('해당 PC 데몬이 연결되어 있지 않습니다.'), 409);
  }
  const token = previewTokenFor(req.user.id, port, runnerId);
  previewTokens.set(token, { userId: req.user.id, port, runnerId, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return successResponse(res, { token, url: `/api/daemon/preview/${token}/`, port });
}

// POST /api/daemon/forward/start  (인증) body:{ port, hostDeviceId? } — 원격 기기 로컬 포트 포워딩 토큰.
//  원격 기기가 자기 127.0.0.1:<port> 리스너의 TCP 연결 1개당 WS(/api/daemon/forward/:token) 1개를 열어
//  raw 바이트를 파이프(ssh -L 모델). hostDeviceId 규약은 previewStart 와 동일.
async function forwardStart(req, res) {
  const port = parseInt((req.body || {}).port, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    return errorResponse(res, new Error('유효한 port 가 필요합니다.'), 400);
  }
  const opts = connOptsOf(req);
  const runnerId = opts ? opts.runnerId : null;
  if (opts && !daemonRelayService.pickConn(req.user.id, opts)) {
    return errorResponse(res, new Error('해당 PC 데몬이 연결되어 있지 않습니다.'), 409);
  }
  try {
    const token = daemonRelayService.issueForwardToken(req.user.id, port, runnerId);
    return successResponse(res, { token, port });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/daemon/lan/grant  (accountAuth) body:{ hostDeviceId?, clientKey, kind?, scopes? }
//  같은 Wi-Fi 의 대상 PC 에 직결하기 위한 **단명 소개장**. 서버는 주소 후보 + grant 만 주고
//  바이트는 지나가지 않는다. hostDeviceId 규약은 forwardStart/previewStart 와 동일(미지정=활성 러너).
//
//  ★ 응답 규약(클라이언트 계약): 실패는 전부 `code` 로 분기한다. 문구로 판정하지 말 것.
//    404 LAN_UNSUPPORTED   — 서버 스위치 off / 구 데몬 / 클라우드 러너 → **정상 상태**로 취급해 릴레이 유지
//    409 LAN_HOST_OFFLINE  — 대상 PC 가 릴레이에도 없음(오프라인 UX 는 기존 경로가 판정)
//    403 LAN_SCOPE / 429 LAN_RATE_LIMITED / 502 LAN_NOTIFY_FAILED
//    어떤 경우에도 '데몬이 연결'·'DAEMON_OFFLINE' 문구를 쓰지 않는다(모바일 오프라인 오탐 방지 §5.3).
async function lanGrant(req, res) {
  const b = req.body || {};
  const opts = connOptsOf(req);
  const hostDeviceId = opts ? opts.runnerId : null;
  const clientKey = typeof b.clientKey === 'string' ? b.clientKey.trim() : '';
  if (!clientKey) return errorResponse(res, new Error('clientKey 가 필요합니다.'), 400);
  try {
    const grant = daemonRelayService.issueLanGrant(req.user.id, hostDeviceId, {
      clientKey, kind: b.kind === 'pc' ? 'pc' : 'mobile',
      scopes: Array.isArray(b.scopes) ? b.scopes : undefined,
    });
    return successResponse(res, grant);
  } catch (e) {
    // code 는 errorResponse 의 publicDetail 규약으로 실어 보낸다(응답 본문 { detail:{ code } }).
    //  클라이언트는 문구가 아니라 이 코드로만 분기한다.
    e.publicDetail = { code: e.code || 'LAN_ERROR' };
    return errorResponse(res, e, e.statusCode || 500);
  }
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
  return daemonRelayService.proxyHttp(sess.userId, sess.port, path, req, res, sess.runnerId != null ? { runnerId: sess.runnerId } : undefined);
}

// 미들웨어 — non-/api 루트 요청에 dpv 쿠키가 있으면 데몬 dev 서버로 프록시(Vite 절대경로/에셋).
function previewCookieMiddleware(req, res, next) {
  if (req.url.startsWith('/api/')) return next();
  const token = parseCookies(req.headers.cookie).dpv;
  if (!token) return next();
  const sess = resolvePreviewToken(token);
  if (!sess) return next();
  return daemonRelayService.proxyHttp(sess.userId, sess.port, req.originalUrl, req, res, sess.runnerId != null ? { runnerId: sess.runnerId } : undefined);
}

module.exports = {
  daemonWorkspaces, daemonCreateWorkspace, daemonTerminalStart, daemonMe, updateMe, deleteAccount, daemonDevices,
  daemonGetSession, daemonPutSession, daemonClaimWorkspaceHost, daemonProjectDetach, daemonProjectAttach, daemonReportGit, daemonDeleteWorkspace,
  createPairCode, createPairSession, approvePairSession, pairGrant, claimPairCode, registerController, getStatus, revokeDevice, activateRunner, ensureCloudRunner, startTerminal, uiTicket, uiClients,
  terminalList, terminalNew, terminalSelect, terminalClose, terminalUnview,
  fsList, fsTree, fsRead, fsWrite, fsMkdir, fsCreateFile, fsRename, fsDelete, fsWatch, fsUnwatch, fsGrep, streamEvents,
  wsGetRoot, wsSetRoot, wsCreate, wsClone, wsSetFullDisk,
  agentStart, agentInput, agentApprove, agentInterrupt, agentStop, agentStatus, agentBacklog, agentSessions, agentDoctor,
  agentLogin, agentLoginSubmit, agentLoginCancel, agentLoginStatus,
  chatSessions, chatOpen, chatSince, chatClose, chatDetail, chatAttachment, chatInput,
  previewPorts, previewStart, forwardStart, lanGrant, previewEntry, previewCookieMiddleware, resolvePreviewToken,
};
