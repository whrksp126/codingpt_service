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

// 페어링 해제 — 자격(deviceToken/deviceId)만 지우고 serverUrl 은 보존.
//  serverUrl 까지 지우면 dev 빌드가 기본값(localhost)으로 떨어져, 재로그인 버튼이
//  로컬 프론트(localhost:3400)를 여는 사고가 난다(실측). 서버 좌표는 비밀이 아니므로 유지.
function clearCredentials() {
  const cur = load();
  if (!cur) return false;
  const keep = {};
  if (cur.serverUrl) keep.serverUrl = cur.serverUrl;
  if (cur.workspaceRoot) keep.workspaceRoot = cur.workspaceRoot;
  if (Object.keys(keep).length) { save(keep); return true; }
  return remove();
}

// 물리 머신 영속 식별자 — <stateDir>/machine.json (unpair/재로그인에도 유지, 자격증명 아님).
//  페어링에 함께 보내 서버가 같은 머신의 기존 device 행을 재사용(업서트)하게 한다 →
//  재로그인마다 새 device 행이 생겨 워크스페이스 hostDeviceId 가 고아가 되는 문제의 근본 차단.
function machineId() {
  const crypto = require('crypto');
  const file = path.join(runtime.stateDir(), 'machine.json');
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v.machineId === 'string' && v.machineId.trim()) return v.machineId.trim();
  } catch (_) { /* 없음/손상 → 새로 생성 */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(runtime.stateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ machineId: id }, null, 2) + '\n', { mode: 0o600 });
  } catch (_) { /* 저장 실패해도 이번 페어링엔 사용(다음번엔 재생성) */ }
  return id;
}

module.exports = { load, save, remove, clearCredentials, configFile, machineId };
