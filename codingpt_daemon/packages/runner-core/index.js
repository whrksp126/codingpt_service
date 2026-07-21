/**
 * @codingpt/runner-core — 러너 계약(runner-contract) 구현 한 벌.
 *
 * 로컬 데몬(@codingpt/daemon)과 클라우드 러너(@codingpt/cloud-runner)가 이 코어를 공유한다.
 * fs/pty/proxy/agent/sync/control/workspace = 계약의 유일 구현. 부트스트랩(전송 인증·경로 루트)만
 * 각 러너가 주입한다.
 */
module.exports = {
  runtime: require('./runtime'),   // 부트스트랩이 init({root,stateDir,claudeHome,platform}) 로 러너별 경로 주입
  config: require('./config'),
  control: require('./control'),
  pty: require('./pty'),
  fs: require('./fs'),
  agent: require('./agent'),
  sync: require('./sync'),
  proxy: require('./proxy'),
  freshness: require('./freshness'),
  workspace: require('./workspace'),
  cptServer: require('./cpt-server'), // cpt CLI 컨트롤 소켓(터미널 안 AI 의 서비스 조작 진입점)
  skills: require('./skills'),        // cpt 스킬 스텁 설치(claude 가 cpt 를 인지하게)
};
