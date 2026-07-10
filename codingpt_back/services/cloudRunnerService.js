/**
 * 클라우드 러너 서비스(M5 Slice1 + Slice3) — 격리 컨테이너 러너의 수명주기.
 *
 * 로컬 데몬은 사람이 페어링 코드를 눈으로 옮겨 적지만, 클라우드 러너는 그럴 수 없다.
 * back 이 무인으로 DaemonDevice(runner_kind='cloud')를 만들고 deviceToken 을 발급해
 * 컨테이너 env(RUNNER_TOKEN)로 주입한다. 크레덴셜(claude)은 컨테이너 안에만 존재.
 *
 * Slice3(동면/콜드스타트): 컨테이너의 /workspace(코드)·/root/.claude(크레덴셜)·
 *  /var/lib/codingpt(세션상태)를 결정적 이름의 named volume 으로 마운트한다. named volume 은
 *  container.remove() 로 삭제되지 않으므로(-v 없을 때), idle 러너를 동면(컨테이너 제거)해도
 *  홈서버 디스크에 남는다. 콜드스타트 = 같은 볼륨 재마운트 → 로그인·세션 자동 복원(재로그인 0).
 *  크레덴셜은 홈서버 밖으로 나가지 않고 우리 앱 코드가 읽지도 않는다(규율 준수).
 */
const crypto = require('crypto');
const { DaemonDevice } = require('../models');

let Docker = null;
try { Docker = require('dockerode'); } catch (_) { /* docker 미가용 환경 폴백 */ }
const docker = Docker ? new Docker() : null;

// 클라우드 러너 컨테이너 격리/리소스(sandboxManager 패턴 재사용).
const RUNNER_IMAGE = process.env.CLOUD_RUNNER_IMAGE || 'codingpt-runner:dev';
const RUNNER_NETWORK = process.env.CLOUD_RUNNER_NETWORK || ''; // egress allowlist 네트워크(prod). 빈 값=기본 bridge
const RUNNER_MEM_MB = Number(process.env.CLOUD_RUNNER_MEM_MB || 2048);
const RUNNER_CPUS = Number(process.env.CLOUD_RUNNER_CPUS || 1);
const RUNNER_PIDS = Number(process.env.CLOUD_RUNNER_PIDS || 512);
// 컨테이너가 릴레이(back)에 붙을 URL — 컨테이너 네트워크 기준(prod=서비스 별칭 http://back:5300).
const RUNNER_SELF_URL = process.env.CLOUD_RUNNER_SERVER_URL || 'http://back:5300';
// 동면 스위퍼: idle TTL(기본 15분) · 검사 주기(60s). sandboxManager.startIdleSweeper 패턴.
const IDLE_TTL_MS = Number(process.env.CLOUD_RUNNER_IDLE_TTL_MS || 15 * 60 * 1000);
const SWEEP_INTERVAL_MS = Number(process.env.CLOUD_RUNNER_SWEEP_MS || 60 * 1000);

// 이미지 내부 마운트 지점(Dockerfile.runner 의 RUNNER_ROOT/STATE_DIR/CLAUDE_CONFIG_DIR 와 일치해야 함).
const MOUNT_TARGETS = { work: '/workspace', claude: '/root/.claude', state: '/var/lib/codingpt' };

function sanitizeWs(workspaceId) {
  return String(workspaceId || '').replace(/[^A-Za-z0-9_.-]/g, '');
}

// 결정적 볼륨명 — userId+workspaceId 로만 계산되어 최초 기동/콜드스타트/GC 가 항상 같은 볼륨을 가리킨다.
//  work=코드, claude=로그인 크레덴셜(/root/.claude), state=세션상태(/var/lib/codingpt).
function volNames(userId, workspaceId) {
  const ws = sanitizeWs(workspaceId);
  return {
    work: `cpt-vol-${userId}-${ws}`,      // 기존 규칙 유지(하위호환)
    claude: `cpt-claude-${userId}-${ws}`, // 크레덴셜 볼륨(동면 간 로그인 유지)
    state: `cpt-state-${userId}-${ws}`,   // 세션상태 볼륨(claude --resume 유지)
  };
}

function genToken() {
  const deviceToken = 'cptc_' + crypto.randomBytes(32).toString('hex'); // cptc_ = cloud(로컬 데몬은 cptd_)
  const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
  return { deviceToken, tokenHash };
}

/**
 * 클라우드 러너용 DaemonDevice 확보 + 새 deviceToken 발급(무인 페어링).
 *  같은 (user, workspace) 의 기존 cloud 기기가 있으면 재사용(토큰 로테이트·동면 해제), 없으면 생성.
 *  deviceToken 원문은 여기서만 반환(저장은 해시) → 호출부가 컨테이너 env 로 주입.
 * @returns {Promise<{ deviceId:number, deviceToken:string, reused:boolean, wasDormant:boolean }>}
 */
async function provisionDevice(userId, { workspaceId = null, deviceName } = {}) {
  if (!userId) { const e = new Error('userId 가 필요합니다.'); e.statusCode = 400; throw e; }
  const { deviceToken, tokenHash } = genToken();
  let device = await DaemonDevice.findOne({
    where: { user_id: userId, runner_kind: 'cloud', workspace_id: workspaceId, revoked_at: null },
  });
  let reused = false;
  let wasDormant = false;
  if (device) {
    wasDormant = !!device.dormant_at; // 동면 상태였는지(볼륨에 이전 크레덴셜/코드 존재) — 콜드스타트 판정.
    await device.update({ token_hash: tokenHash, dormant_at: null, updated_at: new Date() });
    reused = true;
  } else {
    device = await DaemonDevice.create({
      user_id: userId,
      device_name: String(deviceName || 'Cloud Runner').slice(0, 128),
      platform: 'linux',
      runner_kind: 'cloud',
      workspace_id: workspaceId,
      token_hash: tokenHash,
    });
  }
  return { deviceId: device.id, deviceToken, reused, wasDormant };
}

/**
 * 클라우드 러너 컨테이너 기동(prod) — 격리 HostConfig(CapDrop/cgroup) + env 주입 + 3볼륨 마운트.
 *  컨테이너는 부팅 시 RUNNER_SERVER_URL 로 back 에 아웃바운드 연결(clientType:cloud).
 *  docker.sock 이 있는 환경(back/prod 배포)에서만 동작. 로컬 back 은 수동 docker run 으로 검증.
 * @returns {Promise<{ containerId:string }>}
 */
async function launchContainer(userId, { deviceToken, deviceName, workspaceId } = {}) {
  if (!docker) { const e = new Error('컨테이너 런타임을 사용할 수 없습니다(docker.sock 필요).'); e.statusCode = 503; throw e; }
  if (!deviceToken) throw new Error('deviceToken 이 필요합니다.');
  // 3볼륨 마운트 — Docker 는 없으면 자동 생성(최초 기동/콜드스타트 동일 코드). 볼륨은 remove 로 삭제 안 됨.
  const vols = volNames(userId, workspaceId);
  const mounts = [
    { Type: 'volume', Source: vols.work, Target: MOUNT_TARGETS.work },
    { Type: 'volume', Source: vols.claude, Target: MOUNT_TARGETS.claude },
    { Type: 'volume', Source: vols.state, Target: MOUNT_TARGETS.state },
  ];
  const container = await docker.createContainer({
    name: `cpt-runner-${userId}-${crypto.randomBytes(4).toString('hex')}`,
    Image: RUNNER_IMAGE,
    Labels: { 'cpt.role': 'cloud-runner', 'cpt.userId': String(userId), 'cpt.workspaceId': String(workspaceId || '') },
    Env: [
      `RUNNER_SERVER_URL=${RUNNER_SELF_URL}`,
      `RUNNER_TOKEN=${deviceToken}`,
      `RUNNER_DEVICE_NAME=${deviceName || 'Cloud Runner'}`,
      // 경로(RUNNER_ROOT/STATE_DIR/CLAUDE_CONFIG_DIR)는 이미지 기본값 사용(마운트 타겟과 일치).
    ],
    HostConfig: {
      Memory: RUNNER_MEM_MB * 1024 * 1024,
      NanoCpus: Math.round(RUNNER_CPUS * 1e9),
      PidsLimit: RUNNER_PIDS,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'no' },
      ...(RUNNER_NETWORK ? { NetworkMode: RUNNER_NETWORK } : {}),
      Mounts: mounts, // 동면/재개 간 코드·크레덴셜·세션상태 유지.
    },
  });
  await container.start();
  return { containerId: container.id };
}

// 컨테이너 정지+제거(볼륨은 유지 — -v 절대 금지). 동면/정리 공용.
async function stopContainer(containerId) {
  if (!docker || !containerId) return false;
  try { const c = docker.getContainer(containerId); await c.stop({ t: 5 }).catch(() => {}); await c.remove({ force: true }); return true; }
  catch (_) { return false; }
}

// 워크스페이스 볼륨 3종 제거(best-effort) — device revoke/삭제 시 고아 볼륨 정리.
async function removeVolumes(userId, workspaceId) {
  if (!docker) return;
  const vols = volNames(userId, workspaceId);
  for (const name of [vols.work, vols.claude, vols.state]) {
    try { await docker.getVolume(name).remove({ force: true }); } catch (_) { /* 없거나 사용 중이면 무시 */ }
  }
}

/**
 * 동면(scale-to-zero) — idle 클라우드 러너의 컨테이너를 제거하고 볼륨만 남긴다.
 *  가드는 스위퍼가 이미 검사(라이브 터미널/인플라이트 없음)하지만, 여기서도 container_id 존재만 확인.
 *  DB: dormant_at 세팅 + container_id null. 앱엔 sync_progress{phase:'dormant'} 통지(best-effort).
 * @returns {Promise<boolean>} 실제 동면 수행 여부
 */
async function dormant(userId, deviceId) {
  const device = await DaemonDevice.findOne({
    where: { id: deviceId, user_id: userId, runner_kind: 'cloud', revoked_at: null },
  });
  if (!device || !device.container_id) return false;
  await stopContainer(device.container_id);
  await device.update({ dormant_at: new Date(), container_id: null, updated_at: new Date() });
  try { require('./daemonRelayService').fanoutSyncEvent(userId, { type: 'sync_progress', phase: 'dormant' }); } catch (_) { /* noop */ }
  console.log(`[cloudRunner] 동면 userId=${userId} device=#${deviceId}`);
  return true;
}

// idle 스위퍼 — 연결된 클라우드 러너 중 TTL 초과 & 라이브 터미널/인플라이트 없음 → 동면.
//  릴레이 in-memory 활동시각(lastActivityAt)을 신뢰. back 재시작 시 재연결 시각이 활동으로 리셋되어
//  조기 동면을 방지(안전측). docker 없으면(로컬 dev) 동면 불가하므로 스위퍼도 돌지 않는다.
function startDormancySweeper() {
  if (!docker) return null;
  const t = setInterval(async () => {
    try {
      const relay = require('./daemonRelayService');
      const now = Date.now();
      const runners = relay.listCloudRunners ? relay.listCloudRunners() : [];
      for (const r of runners) {
        if (now - (r.lastActivityAt || 0) < IDLE_TTL_MS) continue;
        if (r.hasLiveTerminal || r.hasInflight) continue;
        await dormant(r.userId, r.deviceId).catch(() => {});
      }
    } catch (_) { /* noop */ }
  }, SWEEP_INTERVAL_MS);
  if (t.unref) t.unref();
  return t;
}

// 모듈 로드 시 자동 시작(docker 가용 환경에서만). daemonController 가 require 하는 시점=app 부팅.
const _dormancySweeper = startDormancySweeper();

module.exports = {
  provisionDevice, launchContainer, stopContainer, dormant, removeVolumes,
  volNames, startDormancySweeper, RUNNER_IMAGE,
  _dormancySweeper,
};
