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

// ── E2EE 열쇠 보관 — <stateDir>/e2ee.json (0600) ───────────────────────────────
//  daemon.json 과 파일을 분리한다: deviceToken(서버가 해시를 아는 자격)과 계정 마스터키(서버가
//  절대 못 보는 열쇠)는 수명·백업·삭제 정책이 다르고, PC 앱(Tauri Rust)이 같은 머신에서 이 파일
//  하나만 공유해 읽는다(기기=머신 1단위). 스키마는 e2ee.js 참조.
const e2eeFile = () => path.join(runtime.stateDir(), 'e2ee.json');

/**
 * 상태 읽기 — **'파일 없음' 과 '파싱 실패' 를 구분한다.**
 *  구현이 둘을 뭉개면(둘 다 null) 상위 `ensureIdentity` 가 손상본을 새 blankState 로 즉시 덮어써
 *  신원키와 **전 세대 MK 가 백업 없이 영구 소실**된다(디스크 꽉 참·쓰기 중 강제종료로 절단된 파일).
 *  사용자에게 보이는 결과는 "폰에 뜬금없이 새 기기 승인 요청 + 지난 알림/스냅샷이 영구 🔒" 이고
 *  로그는 0건이다. 그래서 손상은 **손상으로 보고**하고, 손상본은 그대로 남긴 뒤 사본을 백업한다.
 * @returns {{state:object|null, corrupt:boolean, backup:string|null}}
 */
function readE2ee() {
  const file = e2eeFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { state: null, corrupt: false, backup: null };   // 없음 = 정상적인 신규 설치
  }
  try {
    return { state: JSON.parse(text), corrupt: false, backup: null };
  } catch (_) {
    // 원본은 **지우지 않는다**(사람이 되살릴 유일한 근거). 사본만 떠 둔다.
    //  파일명을 내용 해시로 짓는다 — 손상 상태에서는 이 경로가 반복 호출되므로(PC 가 60초마다 조회),
    //  타임스탬프로 지으면 같은 손상본 사본이 무한히 쌓인다. 다른 손상은 다른 해시라 그대로 남는다.
    let backup = null;
    try {
      const tag = require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8);
      backup = `${file}.corrupt-${tag}`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text, { mode: 0o600 });
    } catch (_) { backup = null; }
    return { state: null, corrupt: true, backup };
  }
}

function loadE2ee() {
  return readE2ee().state;
}

/**
 * 상태 쓰기 — **원자적**(임시 파일 + fsync + rename). 열쇠 파일에 부분 쓰기가 남으면 그 순간
 *  계정 전체(신원키 + 전 세대 MK)를 잃는다. 표시용 값 하나를 갱신하는 경로까지 이 파일을 재작성
 *  하므로(userRef·policy·pruneEpochs·정기 폴링) 토린 라이트 확률을 구조적으로 0 으로 만든다.
 */
function saveE2ee(state) {
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  const file = e2eeFile();
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(state, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch (_) { /* 일부 파일시스템은 fsync 미지원 — rename 순서만으로도 원자적 */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* 기존 파일 덮어쓰기 시 mode 무시되는 플랫폼 대비 */ }
  return file;
}

function removeE2ee() {
  try { fs.unlinkSync(e2eeFile()); return true; } catch (_) { return false; }
}

// 페어링 해제 — 자격(deviceToken/deviceId)만 지우고 serverUrl 은 보존.
//  serverUrl 까지 지우면 dev 빌드가 기본값(localhost)으로 떨어져, 재로그인 버튼이
//  로컬 프론트(localhost:3400)를 여는 사고가 난다(실측). 서버 좌표는 비밀이 아니므로 유지.
// E2EE 열쇠는 로그아웃만으로 지우지 않는다. 계정 전환 시 e2ee-account가 userRef를 확인해
// 계정별 보관소로 전환한다. 앱 완전 재설치는 네이티브가 active+보관소를 모두 삭제한다.
function clearCredentials() {
  const cur = load();
  if (!cur) return false;
  const keep = {};
  if (cur.serverUrl) keep.serverUrl = cur.serverUrl;
  if (cur.workspaceRoot) keep.workspaceRoot = cur.workspaceRoot;
  if (Object.keys(keep).length) { save(keep); return true; }
  return remove();
}

// 계정 전환용 E2EE 슬롯. 활성 파일 형식/경로는 암호 코어와의 기존 계약을 유지하고, 비활성 계정만
// e2ee-accounts/<userRef>.json 에 둔다. userRef는 서버 숫자 id만 허용해 경로 탈출을 원천 차단한다.
function switchE2eeAccount(userRef) {
  const next = String(userRef == null ? '' : userRef);
  if (!/^\d+$/.test(next)) return false;
  const active = e2eeFile();
  const slots = path.join(runtime.stateDir(), 'e2ee-accounts');
  let old = '';
  try {
    const cur = JSON.parse(fs.readFileSync(active, 'utf8'));
    old = /^\d+$/.test(String(cur && cur.userRef || '')) ? String(cur.userRef) : '';
  } catch (_) { /* 활성 키 없음 */ }
  if (old === next) return false;
  fs.mkdirSync(slots, { recursive: true });
  if (old && fs.existsSync(active)) {
    const oldPath = path.join(slots, `${old}.json`);
    fs.copyFileSync(active, oldPath);
    fs.chmodSync(oldPath, 0o600);
  }
  const nextPath = path.join(slots, `${next}.json`);
  if (fs.existsSync(nextPath)) {
    fs.copyFileSync(nextPath, active);
    fs.chmodSync(active, 0o600);
  } else {
    try { fs.unlinkSync(active); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
  }
  return true;
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

module.exports = {
  load, save, remove, clearCredentials, configFile, machineId, switchE2eeAccount,
  e2eeFile, loadE2ee, readE2ee, saveE2ee, removeE2ee,
};
