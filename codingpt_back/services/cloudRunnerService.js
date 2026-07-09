/**
 * 클라우드 러너 서비스(M5 Slice1) — 격리 컨테이너 러너의 수명주기.
 *
 * 로컬 데몬은 사람이 페어링 코드를 눈으로 옮겨 적지만, 클라우드 러너는 그럴 수 없다.
 * back 이 무인으로 DaemonDevice(runner_kind='cloud')를 만들고 deviceToken 을 발급해
 * 컨테이너 env(RUNNER_TOKEN)로 주입한다. 크레덴셜(claude)은 컨테이너 안에만 존재.
 *
 * (컨테이너 실제 기동은 Slice1-D sandboxManager 확장이 담당. 여기선 기기/토큰 프로비저닝.)
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

function genToken() {
  const deviceToken = 'cptc_' + crypto.randomBytes(32).toString('hex'); // cptc_ = cloud(로컬 데몬은 cptd_)
  const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
  return { deviceToken, tokenHash };
}

/**
 * 클라우드 러너용 DaemonDevice 확보 + 새 deviceToken 발급(무인 페어링).
 *  같은 (user, workspace) 의 기존 cloud 기기가 있으면 재사용(토큰 로테이트·동면 해제), 없으면 생성.
 *  deviceToken 원문은 여기서만 반환(저장은 해시) → 호출부가 컨테이너 env 로 주입.
 * @returns {Promise<{ deviceId:number, deviceToken:string, reused:boolean }>}
 */
async function provisionDevice(userId, { workspaceId = null, deviceName } = {}) {
  if (!userId) { const e = new Error('userId 가 필요합니다.'); e.statusCode = 400; throw e; }
  const { deviceToken, tokenHash } = genToken();
  let device = await DaemonDevice.findOne({
    where: { user_id: userId, runner_kind: 'cloud', workspace_id: workspaceId, revoked_at: null },
  });
  let reused = false;
  if (device) {
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
  return { deviceId: device.id, deviceToken, reused };
}

/**
 * 클라우드 러너 컨테이너 기동(prod) — 격리 HostConfig(CapDrop/cgroup) + env 주입.
 *  컨테이너는 부팅 시 RUNNER_SERVER_URL 로 back 에 아웃바운드 연결(clientType:cloud).
 *  docker.sock 이 있는 환경(agent-worker/prod 배포)에서만 동작. 로컬 back 은 수동 docker run 으로 검증.
 * @returns {Promise<{ containerId:string }>}
 */
async function launchContainer(userId, { deviceToken, deviceName, workspaceId, volumeName } = {}) {
  if (!docker) { const e = new Error('컨테이너 런타임을 사용할 수 없습니다(docker.sock 필요).'); e.statusCode = 503; throw e; }
  if (!deviceToken) throw new Error('deviceToken 이 필요합니다.');
  const container = await docker.createContainer({
    name: `cpt-runner-${userId}-${crypto.randomBytes(4).toString('hex')}`,
    Image: RUNNER_IMAGE,
    Labels: { 'cpt.role': 'cloud-runner', 'cpt.userId': String(userId), 'cpt.workspaceId': String(workspaceId || '') },
    Env: [
      `RUNNER_SERVER_URL=${RUNNER_SELF_URL}`,
      `RUNNER_TOKEN=${deviceToken}`,
      `RUNNER_DEVICE_NAME=${deviceName || 'Cloud Runner'}`,
      // 경로(RUNNER_ROOT/STATE_DIR/CLAUDE_CONFIG_DIR)는 이미지 기본값 사용.
    ],
    HostConfig: {
      Memory: RUNNER_MEM_MB * 1024 * 1024,
      NanoCpus: Math.round(RUNNER_CPUS * 1e9),
      PidsLimit: RUNNER_PIDS,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'no' },
      ...(RUNNER_NETWORK ? { NetworkMode: RUNNER_NETWORK } : {}),
      // 사용자 코드 영속 볼륨(동면/재개 간 유지). 미지정이면 컨테이너 수명과 함께.
      ...(volumeName ? { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/workspace' }] } : {}),
    },
  });
  await container.start();
  return { containerId: container.id };
}

async function stopContainer(containerId) {
  if (!docker || !containerId) return false;
  try { const c = docker.getContainer(containerId); await c.stop({ t: 5 }).catch(() => {}); await c.remove({ force: true }); return true; }
  catch (_) { return false; }
}

module.exports = { provisionDevice, launchContainer, stopContainer, RUNNER_IMAGE };
