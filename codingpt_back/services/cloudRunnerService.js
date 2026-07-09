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

module.exports = { provisionDevice };
