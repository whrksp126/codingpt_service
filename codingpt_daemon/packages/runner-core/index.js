/**
 * @codingpt/runner-core — 러너 계약(runner-contract) 구현 한 벌.
 *
 * 로컬 데몬(@codingpt/daemon)과 클라우드 러너(@codingpt/cloud-runner)가 이 코어를 공유한다.
 * fs/pty/proxy/agent/sync/control/workspace = 계약의 유일 구현. 부트스트랩(전송 인증·경로 루트)만
 * 각 러너가 주입한다.
 */
module.exports = {
  config: require('./config'),
  control: require('./control'),
  pty: require('./pty'),
  fs: require('./fs'),
  agent: require('./agent'),
  sync: require('./sync'),
  proxy: require('./proxy'),
  workspace: require('./workspace'),
};
