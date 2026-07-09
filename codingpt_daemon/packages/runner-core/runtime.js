/**
 * runner-core 런타임 설정 — 러너별로 다른 "경로 루트/상태 위치/플랫폼"을 한 곳에서 주입한다.
 *
 *  로컬 데몬(@codingpt/daemon): 기본값(사용자 홈 기반). init 안 해도 홈 기준으로 동작(하위호환).
 *  클라우드 러너(@codingpt/cloud-runner): 부트스트랩이 컨테이너 workdir/상태경로로 init.
 *
 * 반드시 **지연 평가**로 쓴다(getter). lib 모듈이 로드되는 시점이 아니라 사용 시점에 값을 읽어,
 * 부트스트랩이 require 이후 init 해도 반영되게 한다.
 *
 * 경계: claudeHome 은 러너 HOME 의 ~/.claude(사용자 자신의 크레덴셜) — 우리는 읽지 않으며(대화로그 제외),
 * 클라우드에선 컨테이너 안에만 존재. 이 모듈은 경로를 알려줄 뿐 크레덴셜을 다루지 않는다.
 */
const os = require('os');
const path = require('path');

let _cfg = null;

function defaults() {
  const home = os.homedir();
  return {
    root: home,                                 // fs 홈 jail 루트(safeResolve 기준)
    stateDir: path.join(home, '.codingpt'),     // 우리 상태(daemon.json·sessions·tmp)
    claudeHome: path.join(home, '.claude'),     // claude OAuth/대화로그(~/.claude)
    platform: process.platform,                 // 'darwin'|'linux' — 플랫폼별 가드(TCC/HIDDEN_DIRS 등)
  };
}

// 부트스트랩이 1회 호출(부분 override 가능). 이후 get()이 이 값을 돌려준다.
function init(cfg) {
  _cfg = { ...defaults(), ...(cfg || {}) };
  return _cfg;
}

function get() {
  return _cfg || (_cfg = defaults());
}

// 편의 getter(지연 평가).
const root = () => get().root;
const stateDir = () => get().stateDir;
const claudeHome = () => get().claudeHome;
const platform = () => get().platform;
const isDarwin = () => get().platform === 'darwin';

module.exports = { init, get, root, stateDir, claudeHome, platform, isDarwin };
