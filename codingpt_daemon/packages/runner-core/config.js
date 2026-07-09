/**
 * 러너 설정 — <stateDir>/daemon.json  (기본 stateDir = ~/.codingpt)
 * { serverUrl, deviceId, deviceToken, deviceName, workspaceRoot? }
 * deviceToken 은 이 파일에만 존재(서버는 해시만 보관) → 0600 권한.
 *
 * 경로는 runtime.stateDir() 지연 평가 — 로컬=홈, 클라우드 러너=주입된 상태 볼륨.
 * (클라우드 러너는 인증을 env 로 주입받으므로 이 파일에 의존하지 않을 수 있다.)
 */
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const configFile = () => path.join(runtime.stateDir(), 'daemon.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function save(config) {
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  const file = configFile();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return file;
}

function remove() {
  try { fs.unlinkSync(configFile()); return true; } catch (_) { return false; }
}

module.exports = { load, save, remove, configFile };
