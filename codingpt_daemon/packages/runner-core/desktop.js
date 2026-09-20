'use strict';

/**
 * desktop — **에이전트 PC**: 이 맥 안에서 에이전트가 쓰는 별도의 macOS(게스트 VM).
 *
 *  사용자는 자기 화면·마우스·키보드를 그대로 쓰고, 에이전트는 이 게스트에서 전면 컴퓨터 유즈를 한다.
 *  사용자는 PC·폰의 "모바일 화면" pane 과 같은 파이프로 이 화면을 보고 손댄다(기기 id `desktop:main`).
 *
 *  층:
 *   · 하이퍼바이저 = Lume(Virtualization.framework 래퍼) CLI. 우리는 run/stop/get/ssh 만 쓴다. 인터페이스를 여기
 *     한 파일 뒤로 좁혀 두어 나중에 자체 VZ 래퍼로 바꿀 수 있게 한다.
 *   · 화면·입력 = VNC(desktop-rfb.js). 게스트에 아무것도 설치하지 않아도 된다.
 *   · 셸 = `lume ssh`(게스트 sshd). 앱 열기·클립보드 타이핑·osascript 가 이 길로 간다.
 *
 *  단위: **맥 한 대에 데스크톱 1대**(macOS 가 게스트 macOS 를 동시 2대까지만 허용). 워크스페이스는 여기에
 *  "연결"(폴더 공유)할 뿐이다. 공유 폴더는 VM 시작 시 고정되므로 연결이 바뀌면 재기동한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const runtime = require('./runtime');
const { RfbClient } = require('./desktop-rfb');

const VM_NAME = 'cpt-agent-desktop';
const IMAGE = 'macos-tahoe-vanilla:latest';
//  게스트 OS 선택(2026-09-21) — macOS(기본) 또는 Linux(경량 ~5GB). settings.osKind 로 정해지고, VM 이름·이미지가 갈린다.
//  기존 사용자는 osKind 없음 → macos. VM_NAME 은 macOS 상수(SNAP_PREFIX·테스트·export 호환)로 남기고, 런타임 조작은 vmName().
const VM_LINUX = 'cpt-agent-linux';
function osKind() { try { return loadSettings().osKind === 'linux' ? 'linux' : 'macos'; } catch (_) { return 'macos'; } }
function isLinux() { return osKind() === 'linux'; }
function vmName() { return isLinux() ? VM_LINUX : VM_NAME; }
function snapPrefix() { return vmName() + '--snap-'; }
const LX = () => require('./desktop-linux');
//  프로비저닝 완료 표식은 OS별(하나로 두면 macOS 설정 뒤 Linux 로 바꿔도 '이미 됨'으로 오판해 cloud-init 을 건너뛴다).
const PROV_KEY = () => (isLinux() ? 'provisionedLinux' : 'provisioned');
function provisionedVer() { return Number(loadSettings()[PROV_KEY()] || 0); }
function markProvisioned(v) { saveSettings({ ...loadSettings(), [PROV_KEY()]: v }); }
const VNC_PORT = 5951;                       // 고정 — 재시작해도 뷰어가 같은 곳을 본다
const MIN_HOST_GB = 32;                      // 이 아래 맥에서는 기능을 켜지 않는다(호스트가 숨 막힌다)
const BOOT_TIMEOUT_MS = 120000;
const SSH_USER = 'lume';
const SSH_PASSWORD = 'lume';                 // vanilla 이미지 기본 — 자체 이미지에서 바꾼다
/**
 * 첫 부팅 프로비저닝 — 공용 vanilla 이미지에 "누구에게나 필요한 첫 세팅"을 **각 사용자 맥에서** 한 번 한다.
 *  이미지를 새로 굽거나 우리가 나눠 주지 않는다(21GB 를 우리 회선으로 흘릴 이유가 없고, 사용자 VM 은 밖으로 안 나간다).
 *  하는 일: 자동 로그인(켤 때마다 lume/lume 을 치던 것) · 절전/화면보호기/잠금 끔(에이전트가 일하는 중에 화면이 잠기면
 *  끝) · 첫 로그인 설정 도우미(Apple ID·Siri·화면 시간 …) 건너뜀 · 소프트웨어 업데이트/충돌 보고 창 끔.
 *  TCC(접근성·화면 기록)는 SIP 가 켜져 있어 여기서 못 만진다(2026-09-19 실측: `csrutil status` enabled) — 필요한 순간
 *  게스트가 띄우는 허용 창을 pane 에서 한 번 눌러 준다. 번호를 올리면 이미 준비된 VM 에도 다시 돈다.
 */
const PROVISION_VER = 2;   // 2 = Safari 첫 실행 안내(검색 제안)·Tips 알림("macOS 새 기능") 끄기
/**
 * /etc/kcpassword — 자동 로그인 비밀번호 파일. `sysadminctl -autologin set` 은 이 이미지에서 `SACSetAutoLoginPassword error:22`
 *  로 실패한다(2026-09-19 실측) — loginwindow 가 읽는 파일을 직접 쓴다. 형식: 11바이트 키로 XOR, 12의 배수로 0 패딩.
 */
function kcpassword(pw) {
  const key = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xb3, 0xdd, 0xbf, 0x5f, 0xe5, 0x12];
  const raw = Buffer.from(pw, 'utf8');
  const out = Buffer.alloc(Math.ceil((raw.length + 1) / 12) * 12, 0);
  raw.copy(out);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  return out.toString('base64');
}
//  ssh 에 tty 가 없어 sudo 타임스탬프가 안 남는다 — 매번 비밀번호를 stdin 으로 준다(sudo 함수). 그래서 sudo 뒤 명령에
//  파이프로 뭘 먹일 수 없다(stdin 은 비밀번호가 차지) — 파일 쓰기는 `sudo sh -c` 안에서 한다.
const PROVISION_SCRIPT = `set -e
P="${SSH_PASSWORD}"
sudo() { echo "$P" | command sudo -S -p "" "$@"; }
sudo sh -c 'echo "${kcpassword(SSH_PASSWORD)}" | base64 -d > /etc/kcpassword && chmod 600 /etc/kcpassword'
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string ${SSH_USER}
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
defaults -currentHost write com.apple.screensaver idleTime -int 0
sysadminctl -screenLock off -password "$P" >/dev/null 2>&1 || true
for k in DidSeeCloudSetup DidSeeSiriSetup DidSeeAppearanceSetup DidSeeTouchIDSetup DidSeeScreenTime DidSeePrivacy DidSeeActivationLock DidSeeiCloudLoginForStorageServices DidSeeAccessibility DidSeeTrueTonePrivacy DidSeeSyncSetup DidSeeSyncSetup2 DidSeeIntelligence SkipFirstLoginOptimization; do defaults write com.apple.SetupAssistant "$k" -bool true; done
defaults write com.apple.SetupAssistant LastSeenCloudProductVersion "$(sw_vers -productVersion)"
defaults write com.apple.SetupAssistant LastSeenBuddyBuildVersion "$(sw_vers -buildVersion)"
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled -bool false
defaults write com.apple.CrashReporter DialogType none
# v2 — 게스트 Safari 의 "검색 제안" 첫 실행 안내(Safari 는 샌드박스라 컨테이너 안 plist 가 정본 — ssh 는 Full Disk Access 라 쓸 수 있다, 실측)
mkdir -p ~/Library/Containers/com.apple.Safari/Data/Library/Preferences
defaults write ~/Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari UniversalSearchFeatureNotificationHasBeenDisplayed -bool true
defaults write com.apple.Safari UniversalSearchFeatureNotificationHasBeenDisplayed -bool true
# v2 — Tips("See what's new in macOS") 알림 에이전트 — SIP 때문에 bootout 은 못 하지만 disable 은 다음 로그인부터 먹는다(실측)
launchctl disable gui/$(id -u)/com.apple.tipsd 2>/dev/null || true
pkill -x tipsd 2>/dev/null || true
[ "$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser)" = "${SSH_USER}" ] && sudo test -s /etc/kcpassword && echo CPT_PROVISION_OK
`;

//  ★ 켤 때마다 다시 거는 것 — ByHost(하드웨어 UUID) 에 묶인 설정은 VM 의 식별자가 바뀌면 조용히 사라진다.
//   실측(2026-09-20): 복원된 VM 의 IOPlatformUUID 가 프로비저닝 때와 달라 화면보호기 idleTime=0 이 안 먹고
//   20분 뒤 잠금 화면("Enter Password") 으로 떨어졌다 → 에이전트가 손을 못 대는 상태. 첫 설정 한 번으론 부족.
const SETTLE_SCRIPT = `P="${SSH_PASSWORD}"
defaults -currentHost write com.apple.screensaver idleTime -int 0
sysadminctl -screenLock off -password "$P" >/dev/null 2>&1 || true
launchctl disable gui/$(id -u)/com.apple.tipsd 2>/dev/null || true
sysadminctl -screenLock status 2>&1 | grep -q 'screenLock is off' && [ "$(defaults -currentHost read com.apple.screensaver idleTime)" = 0 ] && echo CPT_SETTLE_OK
`;

/** 켠 뒤 한 번 — ByHost 설정을 다시 건다(위 SETTLE_SCRIPT). 실패해도 켜기는 막지 않는다(로그만). */
async function settle() {
  try {
    const out = await exec(isLinux() ? LX().SETTLE_CMD : SETTLE_SCRIPT, { timeoutMs: 20000 });
    if (!/CPT_SETTLE_OK/.test(out)) console.warn('[desktop] settle 미완료:', out.trim().slice(0, 200));
    return true;
  } catch (e) { console.warn('[desktop] settle 실패:', String(e && e.message || e).slice(0, 200)); return false; }
}

let toolCache = null;
function lumeBin() {
  if (toolCache !== null) return toolCache;
  const cands = [
    process.env.CPT_LUME,
    path.join(runtime.stateDir(), 'bin', 'lume'),
    process.env.CPT_SIDECAR_DIR ? path.join(process.env.CPT_SIDECAR_DIR, 'lume') : null,
    '/opt/homebrew/bin/lume', '/usr/local/bin/lume',
  ].filter(Boolean);
  toolCache = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
  return toolCache;
}
function _resetTools() { toolCache = null; }

function settingsFile() { return path.join(runtime.stateDir(), 'desktop.json'); }
function loadSettings() {
  try { const s = { sharedDirs: [], idleOffMin: IDLE_OFF_DEFAULT_MIN, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; return { ...s, sharedDirs: normalizeDirs(s.sharedDirs) }; }
  catch (_) { return { sharedDirs: [], idleOffMin: IDLE_OFF_DEFAULT_MIN }; }
}
/**
 * 공유 폴더 항목 → 절대 경로. PC 앱은 워크스페이스 id(홈-상대 `other/project/x`)를, cpt 는 절대 경로를 보낸다 —
 *  둘 다 받아 한 모양으로 맞춘다(안 맞추면 lume 이 상대 경로를 자기 cwd 기준으로 읽고, 해제가 같은 폴더를 못 찾는다).
 */
function absDir(d) {
  const str = String(d || '').trim();
  if (!str) return '';
  return path.isAbsolute(str) ? path.normalize(str) : path.join(os.homedir(), str);
}
function normalizeDirs(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(absDir).filter(Boolean))];
}
/** 절대 경로 → 워크스페이스 id(홈-상대). 홈 밖이면 절대 경로 그대로 — PC 앱 체크박스가 이 값으로 자기 워크스페이스를 찾는다. */
function dirId(d) {
  const rel = path.relative(os.homedir(), absDir(d)).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : absDir(d);
}
function withIds(s) { return { ...s, sharedIds: (s.sharedDirs || []).map(dirId) }; }
function saveSettings(s) {
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...s, sharedDirs: normalizeDirs(s.sharedDirs) }, null, 2));
}

function run(bin, args, o = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(bin, args, { timeout: o.timeoutMs || 30000, maxBuffer: 32 * 1024 * 1024, encoding: o.encoding || 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8' } },
      (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || ''); err.stdout = String(stdout || ''); reject(err); return; }
        resolve(stdout);
      });
  });
}
const lume = (args, o) => run(lumeBin(), args, o);

function hostGB() { return Math.round(os.totalmem() / 1024 / 1024 / 1024); }
function defaultResources() {
  const total = hostGB();
  const memGB = Math.max(8, Math.min(16, Math.floor(total / 4)));
  const cpu = Math.max(4, Math.min(8, Math.floor(os.cpus().length / 2)));
  return { memGB, cpu };
}

/** `lume get -f json` — 없으면 null. 필드 이름은 Lume 0.5 기준(status/ipAddress/vncUrl/cpuCount/memorySize). */
let _infoCache = { at: 0, v: null, p: null };
const INFO_TTL_MS = 1500;   // 기기 목록 폴링(pane 여러 개)이 `lume get` 프로세스를 초당 몇 번씩 띄우지 않게
async function vmInfo(fresh) {
  if (!lumeBin()) return null;
  const now = Date.now();
  if (!fresh && _infoCache.p) return _infoCache.p;
  if (!fresh && now - _infoCache.at < INFO_TTL_MS) return _infoCache.v;
  const p = (async () => {
    try {
      const out = await lume(['get', vmName(), '-f', 'json'], { timeoutMs: 15000 });
      //  Lume 0.5.3 실측: 로그 줄 뒤에 **배열** `[ {…} ]` 로 온다(한 VM 이어도). 첫 '[' 또는 '{' 부터 파싱.
      const str = String(out);
      const i = Math.min(...['[', '{'].map((ch) => str.indexOf(ch)).filter((n) => n >= 0));
      if (!Number.isFinite(i)) return null;
      const j = JSON.parse(str.slice(i));
      return Array.isArray(j) ? (j[0] || null) : j;
    } catch (_) { return null; }
  })();
  _infoCache.p = p;
  const v = await p;
  _infoCache = { at: Date.now(), v, p: null };
  return v;
}
function invalidateInfo() { _infoCache = { at: 0, v: null, p: null }; }

// ── 상태 ─────────────────────────────────────────────────────────────────────
/**
 * 화면·cpt 가 보는 단일 상태. `phase`:
 *  unsupported(인텔/램 부족/맥 아님) · no-tool(lume 없음) · no-image(VM 없음) · stopped · starting · running
 */
async function status() {
  const s = loadSettings();
  const base = {
    vm: vmName(), hostGB: hostGB(), minHostGB: MIN_HOST_GB, sharedDirs: s.sharedDirs, ...defaultResources(),
    vnc: { port: VNC_PORT }, lume: lumeBin() || null, osKind: osKind(),
  };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { ...base, phase: 'unsupported', reason: 'Apple 실리콘 Mac 에서만 쓸 수 있어요' };
  if (base.hostGB < MIN_HOST_GB) return { ...base, phase: 'unsupported', reason: `메모리 ${MIN_HOST_GB}GB 이상인 Mac 에서만 켤 수 있어요 (이 Mac: ${base.hostGB}GB)` };
  if (!lumeBin()) return { ...base, phase: 'no-tool', reason: 'VM 도구(lume)가 없어요' };
  const info = await vmInfo();
  if (!info) {
    if (isLinux()) {
      if (_linuxBuild && _linuxBuild.running) return { ...base, phase: 'pulling', pull: _linuxBuild, image: 'ubuntu-24.04-arm64' };
      return { ...base, phase: 'no-image', reason: (_linuxBuild && _linuxBuild.error) || '에이전트 PC(Linux) 이미지가 없어요 (첫 켜기 때 준비 — 다운로드 약 0.6GB)', image: 'ubuntu-24.04-arm64' };
    }
    if (pullState && pullState.running) return { ...base, phase: 'pulling', pull: pullState, image: IMAGE };
    return { ...base, phase: 'no-image', reason: (pullState && pullState.error) || `에이전트 PC 이미지가 없어요 (${IMAGE}, 약 21GB)`, image: IMAGE };
  }
  const running = /running/i.test(String(info.status || ''));
  return {
    ...base,
    phase: _starting ? 'starting' : (running ? 'running' : 'stopped'), step: _starting ? _step : '',
    //  비동기 켜기가 실패했으면(꺼진 채) 사유를 보여 준다 — RPC 는 이미 빨리 돌아갔으니 여기가 유일한 통로.
    ...((!running && !_starting && _startErr) ? { reason: _startErr } : {}),
    provisioned: provisionedVer() >= PROVISION_VER,
    os: info.os, ip: info.ipAddress || null, cpuCount: info.cpuCount, memorySize: info.memorySize, diskSize: info.diskSize,
    display: info.display, vncUrl: running ? (info.vncUrl || null) : null,
    screen: rfb && rfb.ready ? { width: rfb.width, height: rfb.height } : null,
    paused: !!agentPaused,
  };
}

// ── 수명주기 ───────────────────────────────────────────────────────────────
let _starting = null;   // Promise | null
let _startErr = null;   // 백그라운드 start() 실패 사유(비동기 켜기라 RPC 로 못 던진다 → status.reason 으로 보여 준다)
let _linuxBuild = null;   // Linux 이미지 준비 상태(status 가 phase 'pulling' 으로 보고) | null
/**
 * 유휴 자동 끄기 — 켜진 VM 은 메모리 16GB 를 쥔다. 아무도 안 보고(프레임·영상) 에이전트도 안 쓰면(입력·exec·ax…) 이만큼 뒤 끈다.
 *  설정 idleOffMin(0 = 안 끔). 개입 대기(handoff) 중엔 끄지 않는다 — 사용자가 와서 해야 할 일이 남아 있다.
 */
const IDLE_OFF_DEFAULT_MIN = 60;
let lastUse = Date.now();
function touchUse() { lastUse = Date.now(); }
let _idleTimer = null;
function armIdleWatch() {
  if (_idleTimer) return;
  _idleTimer = setInterval(() => idleTick(), 60000);
  _idleTimer.unref?.();
}
async function idleTick() {
    try {
      const min = Number(loadSettings().idleOffMin) || 0;
      if (min <= 0 || _starting || pendingHandoff()) return;
      if (Date.now() - lastUse < min * 60000) return;
      const info = await vmInfo();
      if (!info || !/running/i.test(String(info.status || ''))) return;
      console.log(`[desktop] ${min}분 동안 쓰지 않아 에이전트 PC 를 끕니다`);
      touchUse();                 // 끄는 동안 되풀이 방지
      await stop();
      return true;
    } catch (_) { /* 다음 틱에 */ }
    return false;
}
let _step = '';         // 'boot' | 'provision' | 'reboot' — status().step (PC 가 "처음이라 설정 중" 을 보여 준다)
let rfb = null;         // RfbClient | null
let vncPassword = '';
let agentPaused = false; // 사용자가 화면을 만지는 동안 에이전트 입력을 막는다

/**
 * 이미지 내려받기(21GB, 회선 6MB/s 면 한 시간). **백그라운드로** 돌리고 진행률은 status().pull 로 읽는다 — 화면이
 *  한 시간짜리 RPC 를 붙들고 있을 수는 없다. 이미 도는 중이면 그 상태를 돌려준다.
 *  진행 줄 실측: `N/200 done | 9.6 GB/19.6 GB | 26m 52s` (\r 로 덮어쓰는 한 줄).
 */
let pullState = null;   // { running, done, bytes, total, elapsed, error, at }
function pull() {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  if (pullState && pullState.running) return pullState;
  pullState = { running: true, done: 0, total: 0, bytes: '', totalBytes: '', elapsed: '', error: null, at: Date.now() };
  const child = cp.spawn(lumeBin(), ['pull', IMAGE, vmName()], { env: { ...process.env, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const onChunk = (d) => {
    const str = String(d); tail = (tail + str).slice(-4000);
    const m = /(\d+)\/(\d+) done \| ([\d.]+ [KMG]B)\/([\d.]+ [KMG]B) \| ([^\r\n]+)/g;
    let last = null, x; while ((x = m.exec(str))) last = x;
    if (last) Object.assign(pullState, { done: +last[1], total: +last[2], bytes: last[3], totalBytes: last[4], elapsed: last[5].trim() });
  };
  child.stdout.on('data', onChunk); child.stderr.on('data', onChunk);
  child.on('exit', (code) => { pullState.running = false; if (code !== 0) pullState.error = `이미지 내려받기 실패(${code}): ${tail.slice(-300)}`; invalidateInfo(); });
  child.on('error', (e) => { pullState.running = false; pullState.error = e.message; });
  child.unref();
  return pullState;
}

// ── 스냅샷(되돌리기) ─────────────────────────────────────────────────────────
/**
 * 에이전트가 VM 을 망쳤을 때를 위한 보험. `lume clone` = APFS 클론이라 2초·디스크 0 증가(실측 2026-09-17).
 *  일관성을 위해 **끈 채로** 복제한다(켜져 있으면 끄고 → 복제 → 다시 켬, ~30초). 이름은 `<VM>--snap-<시각>[-라벨]`,
 *  최대 SNAP_MAX 개(오래된 것부터 지움). 되돌리기 = 지금 VM 삭제 → 스냅샷을 VM 이름으로 복제 → 켬(스냅샷은 남는다).
 */
const SNAP_PREFIX = `${VM_NAME}--snap-`;
const SNAP_MAX = 5;
function snapName(label) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const lab = String(label || '').trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return snapPrefix() + ts + (lab ? '-' + lab : '');
}
async function lumeLs() {
  const out = String(await lume(['ls', '-f', 'json'], { timeoutMs: 15000 }));
  const i = out.indexOf('['); if (i < 0) return [];
  try { return JSON.parse(out.slice(i)); } catch (_) { return []; }
}
async function snapshots() {
  const rows = (await lumeLs()).filter((v) => String(v.name || '').startsWith(snapPrefix()));
  return rows.map((v) => {
    const rest = String(v.name).slice(snapPrefix().length);
    const m = /^(\d{8})-(\d{6})(?:-(.*))?$/.exec(rest);
    const at = m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)) : 0;
    return { name: v.name, label: m && m[3] ? m[3] : '', at, allocated: v.diskSize && v.diskSize.allocated };
  }).sort((a, b) => b.at - a.at);
}
/** 켜져 있으면 끄고 fn 을 돌린 뒤 다시 켠다 — 스냅샷·되돌리기가 같은 모양을 쓴다. */
async function withStopped(fn) {
  const wasRunning = (await status()).phase === 'running';
  if (wasRunning) await stop();
  const r = await fn();
  invalidateInfo();
  if (wasRunning) await start();
  return { ...r, restarted: wasRunning };
}
/**
 * ★ `lume clone` 은 machineIdentifier·macAddress 를 새로 만든다 — 게스트 macOS 는 "다른 맥"으로 알고 로그인 때 Setup Assistant 를
 *  다시 띄운다(실측 2026-09-19: 복원 뒤 검은 화면 → SA 가 창 없이 멈춤, 죽이면 로그아웃, 재로그인 세션에선 ssh 의 AX 가 창을 못 봄).
 *  디스크 속 macOS 가 아는 정체를 config.json 에 되살린다. 스냅샷은 절대 동시에 켜지 않으므로 같은 정체를 들어도 된다.
 */
function vmConfigPath(name) { return path.join(os.homedir(), '.lume', name, 'config.json'); }
function carryIdentity(fromName, toName) {
  try {
    const from = JSON.parse(fs.readFileSync(vmConfigPath(fromName), 'utf8'));
    const toPath = vmConfigPath(toName);
    const to = JSON.parse(fs.readFileSync(toPath, 'utf8'));
    if (from.machineIdentifier) to.machineIdentifier = from.machineIdentifier;
    if (from.macAddress) to.macAddress = from.macAddress;
    fs.writeFileSync(toPath, JSON.stringify(to, null, 2));
    return true;
  } catch (_) { return false; }
}
async function snapshot(label) {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  if (!(await vmInfo(true))) throw new Error('에이전트 PC 가 아직 없어요');
  const name = snapName(label);
  return withStopped(async () => {
    await lume(['clone', vmName(), name], { timeoutMs: 120000 });
    carryIdentity(vmName(), name);
    //  오래된 것 정리 — 지금 만든 것은 목록 맨 앞이라 안 지워진다.
    const all = await snapshots();
    for (const s of all.slice(SNAP_MAX)) { try { await lume(['delete', s.name, '--force'], { timeoutMs: 60000 }); } catch (_) { /* 다음에 */ } }
    return { ok: true, name, snapshots: await snapshots() };
  });
}
async function restore(name) {
  const n = String(name || '');
  if (!n.startsWith(snapPrefix())) throw new Error('스냅샷 이름이 아니에요');
  if (!(await snapshots()).some((s) => s.name === n)) throw new Error(`스냅샷이 없어요: ${n}`);
  return withStopped(async () => {
    await lume(['delete', vmName(), '--force'], { timeoutMs: 60000 });
    await lume(['clone', n, vmName()], { timeoutMs: 120000 });
    carryIdentity(n, vmName());
    return { ok: true, name: n };
  });
}
async function snapshotDelete(name) {
  const n = String(name || '');
  if (!n.startsWith(snapPrefix())) throw new Error('스냅샷 이름이 아니에요');
  await lume(['delete', n, '--force'], { timeoutMs: 60000 });
  return { ok: true, snapshots: await snapshots() };
}

/** 에이전트 PC 삭제 — 게스트 디스크·설정을 지운다(캐시 이미지는 남긴다). 켜져 있으면 먼저 끈다. */
async function remove() {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  await stop();
  await lume(['delete', vmName(), '--force'], { timeoutMs: 60000 });
  invalidateInfo();
  return { ok: true };
}

/** 켠다(이미 켜져 있으면 VNC 만 확인). 공유 폴더는 설정의 sharedDirs. */
async function start(o = {}) {
  touchUse(); armIdleWatch();
  _startErr = null;
  if (_starting) return _starting;
  _starting = (async () => {
    let st = await status();
    if (st.phase === 'unsupported' || st.phase === 'no-tool') throw new Error(st.reason);
    if (st.phase === 'no-image') {
      if (!isLinux()) throw new Error(st.reason);   // macOS 는 pull(desktop.pull)로 따로 받는다
      //  Linux: 이미지 준비(클라우드 이미지 다운로드→raw 변환→lume create→seed). 진행은 status 가 'pulling' 으로 보고.
      _step = 'provision';
      const res = defaultResources(); const cfg = loadSettings();
      try {
        _linuxBuild = { running: true, phase: 'download', pct: 0 };
        await LX().ensureImage({ lumeBin, vmName: vmName(), cpu: cfg.cpu || res.cpu, memGB: cfg.memGB || res.memGB,
          onProgress: (x) => { _linuxBuild = { running: true, ...x }; } });
      } catch (e) { _linuxBuild = { running: false, error: String((e && e.message) || e) }; throw e; }
      _linuxBuild = { running: false };
      st = await status();
    }
    if (st.phase !== 'running') await launch(o);
    _step = 'boot';
    await waitRunning();
    if (provisionedVer() < PROVISION_VER) {
      if (isLinux()) {
        //  Linux: cloud-init 이 설치(apt xfce4·firefox·at-spi ~8분)+재부팅까지 스스로 한다. ★재부팅해도 lume run 이 안 죽는다
        //   (macOS 와 반대 — VZ 가 Linux reboot 은 제자리 재시작으로 처리). 로그인될 때까지 넉넉히 기다린다.
        _step = 'provision';
        await waitLoggedIn(780000);
        _step = 'ax';
        await settle();
        markProvisioned(PROVISION_VER);
      } else {
        //  첫 설정 → 정상 종료 → 다시 켜기. macOS 게스트 안 `reboot` 는 못 쓴다(VZ 가 "정지"로 봐 lume run 종료).
        await provision();
        _step = 'reboot';
        await stop();
        await launch(o);
        await waitRunning();
        await waitLoggedIn();
        _step = 'ax';
        await sleep(4000);   // 로그인 직후 Dock/Finder 가 뜨는 동안
        try { await ensureAx(); } catch (_) { /* 첫 ax 호출 때 다시 */ }
      }
    }
    await connectRfb({ waitMs: 30000 });
    //  화면이 붙은 뒤 뒤에서 — 켜기를 기다리는 쪽을 ssh 왕복만큼 더 세우지 않는다.
    void settle();
  })();
  try { await _starting; } finally { _starting = null; _step = ''; }
  return status();     // _starting 을 비운 뒤에 읽어야 phase 가 'running' 으로 나온다
}

/** VM 프로세스를 띄운다(설정의 자원·공유 폴더). 켜졌는지는 waitRunning 이 본다. */
async function launch(o = {}) {
  _axOk = false;   // 권한은 VM 안에 남지만 확인은 다시 한다(재시작 뒤 첫 ax 호출 1회)
  await reapForeignVm();   // OS 전환: 다른 OS 의 VM 이 VNC 포트(공유 5951)를 쥐고 있으면 이 OS 가 못 켜진다
  await reapVmProcess();   // 꺼진 채 남은 옛 프로세스(같은 OS)가 포트를 쥐고 있으면 켜기가 실패한다
  const s = loadSettings();
  const res = defaultResources();
  try { await lume(['set', vmName(), '--cpu', String(s.cpu || res.cpu), '--memory', `${s.memGB || res.memGB}GB`], { timeoutMs: 20000 }); } catch (_) { /* 켜진 채면 실패 — 무시 */ }
  //  영숫자만 — base64url 은 '-' 로 시작할 수 있어 lume 이 `--vnc-password -xxx` 를 플래그로 읽고 죽는다(0.1.335 실사고).
  //  ★ VNC 인증(DES)은 비밀번호 **앞 8바이트만** 쓴다 — 16진수 8자는 32비트에 그친다. 대소문자+숫자로 62^8≈47비트.
  //   (VNC 서버는 lume 이 모든 인터페이스에 열고 바인드 옵션이 없다 — 비밀번호가 유일한 문이라 강도를 올린다.)
  vncPassword = strongVncPassword();
  const args = ['run', vmName(), ...(isLinux() ? ['--no-display'] : ['--display', 'none']), '--vnc-port', String(VNC_PORT), '--vnc-password', vncPassword];
  //  Linux 첫 부팅엔 cloud-init seed 를 mount 한다(자동 로그인·데스크톱·접근성 설치). 프로비저닝 뒤엔 안 붙인다.
  if (isLinux() && provisionedVer() < 1) args.push('--mount', LX().seedFile());
  for (const d of normalizeDirs(o.sharedDirs || s.sharedDirs)) args.push('--shared-dir', `${d}:rw`);
  //  ★ `--detach` 대신 우리가 **자기 세션으로** 떼어 띄운다(detached + unref). 실측(2026-09-17): 같은 프로세스 그룹에
  //   남은 VM 이 부모 셸 정리에 휩쓸려 5분 만에 소리 없이 죽었다. 데몬이 재시작해도 VM 은 tmux 처럼 살아 있어야 한다.
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  const logFd = fs.openSync(path.join(runtime.stateDir(), 'desktop-vm.log'), 'a');
  const child = cp.spawn(lumeBin(), args, { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, LANG: 'en_US.UTF-8' } });
  child.on('error', () => { /* waitRunning 이 시간 초과로 알린다 */ });
  child.unref();
  fs.closeSync(logFd);
  invalidateInfo();
}

/** 자동 로그인 증거 — `who` 에 console 세션이 보일 때까지(부팅 직후 ssh 가 잠깐 안 될 수 있다). */
async function waitLoggedIn(limitMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    try { const w = await exec(isLinux() ? LX().LOGIN_CHECK : 'who', { timeoutMs: 10000 }); if (isLinux() ? /LOGGED_IN/.test(w) : /console/.test(w)) return true; } catch (_) { /* 부팅 중 */ }
    if (Date.now() - t0 > limitMs) throw new Error('에이전트 PC 가 자동 로그인되지 않았어요');
    await sleep(2000);
  }
}

async function waitRunning() {
  const t0 = Date.now();
  for (;;) {
    const info = await vmInfo(true);
    if (info && /running/i.test(String(info.status || '')) && info.vncUrl) return info;
    if (Date.now() - t0 > BOOT_TIMEOUT_MS) throw new Error('에이전트 PC 가 시간 안에 켜지지 않았어요');
    await sleep(700);
  }
}

/**
 * 프로비저닝 본체 — ssh 로 스크립트를 넣는다(로그인 화면에서도 sshd 는 떠 있다). 자동 로그인 확인은 start() 가
 *  끄고 다시 켜서 한다(waitLoggedIn). ssh 가 아직 안 뜬 직후엔 60초까지 되풀이. 성공해야 settings.provisioned 를 올린다.
 */
async function provision() {
  _step = 'provision';
  const t0 = Date.now();
  let out = '';
  for (;;) {
    try { out = await exec(PROVISION_SCRIPT, { timeoutMs: 90000 }); break; }
    catch (e) {
      if (Date.now() - t0 > 60000) throw new Error(`에이전트 PC 첫 설정에 실패했어요: ${String(e.message || e).slice(0, 200)}`);
      await sleep(2000);
    }
  }
  if (!/CPT_PROVISION_OK/.test(out)) throw new Error('에이전트 PC 첫 설정에 실패했어요 (자동 로그인이 켜지지 않음)');
  markProvisioned(PROVISION_VER);
  return { ok: true, version: PROVISION_VER };
}

/**
 * 폴더 연결/해제 — 에이전트가 **필요한 순간에** 붙인다(사용자 결정 2026-09-19: 자동 연결 없음, 어떤 경로든 에이전트 판단).
 *  공유 폴더는 부팅 때 고정이라, 켜져 있으면 여기서 끄고 다시 켠다(~20~40초) — 에이전트가 사용자에게 재시작을
 *  부탁하고 멈추는 일이 없게. 돌려주는 guest 경로로 바로 쓸 수 있다.
 */
async function connectDir(dir, on) {
  const abs = absDir(dir);
  if (!abs) throw new Error('폴더 경로가 필요해요');
  if (on) { try { if (!fs.statSync(abs).isDirectory()) throw new Error(); } catch (_) { throw new Error(`폴더가 없어요: ${abs}`); } }
  const s = loadSettings();
  const set = new Set(normalizeDirs(s.sharedDirs));
  const had = set.has(abs);
  if (on) set.add(abs); else set.delete(abs);
  const changed = on ? !had : had;
  if (changed) saveSettings({ ...s, sharedDirs: [...set] });
  let restarted = false;
  if (changed && (await status()).phase === 'running') {
    await stop();
    await start();
    restarted = true;
  }
  return { ok: true, host: abs, guest: on ? path.posix.join('/Volumes/My Shared Files', path.basename(abs)) : null, changed, restarted, sharedDirs: [...set] };
}

/** 대소문자+숫자 12자(앞 8자가 실효) — crypto.randomInt 로 편향 없이. */
function strongVncPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += A[crypto.randomInt(A.length)];
  //  첫 글자가 숫자여도 lume 은 플래그로 안 읽는다('-' 만 문제) — 그래도 글자로 시작하게 해 둔다.
  return /^[A-Za-z]/.test(out) ? out : 'k' + out.slice(1);
}

/** vncUrl = vnc://:password@host:port — 우리가 준 비밀번호가 아니면(이미 켜져 있던 VM) URL 의 것을 쓴다. */
function parseVncUrl(u) {
  const m = /^vnc:\/\/(?:([^:@]*):)?([^@]*)@([^:]+):(\d+)/.exec(String(u || ''));
  if (!m) return null;
  return { password: decodeURIComponent(m[2] || ''), host: m[3], port: Number(m[4]) };
}

/**
 * VNC 에 붙는다(이미 붙어 있으면 그대로).
 *  ★ 꺼진 VM 이면 **즉시** 실패한다 — 예전엔 프레임 요청 하나가 30초 동안 접속을 되풀이했고, PC 앱은 그 30초를
 *   메인 스레드에서 기다렸다(무지개 커서, 2026-09-17 실사고). 부팅 직후의 되풀이(waitMs)는 start() 만 쓴다.
 *  @param {{waitMs?:number}} o  접속 실패를 되풀이할 상한(기본 0 = 한 번만)
 */
async function connectRfb(o = {}) {
  if (rfb && rfb.ready && !rfb.closed) return rfb;
  const info = await vmInfo();
  if (!info || !/running/i.test(String(info.status || ''))) throw new Error('에이전트 PC 가 꺼져 있어요 (cpt desktop start)');
  const v = parseVncUrl(info && info.vncUrl) || { host: '127.0.0.1', port: VNC_PORT, password: vncPassword };
  const waitMs = Number(o.waitMs) || 0;
  const t0 = Date.now();
  for (;;) {
    try {
      const c = new RfbClient({ host: v.host === '0.0.0.0' ? '127.0.0.1' : v.host, port: v.port, password: v.password || vncPassword, connectTimeoutMs: waitMs ? 8000 : 3000 });
      await c.connect();
      c.on('close', () => { if (rfb === c) rfb = null; });
      c.on('error', () => { /* close 가 뒤따른다 */ });
      rfb = c;
      await c.requestUpdate(false, 4000);
      return c;
    } catch (e) {
      if (Date.now() - t0 >= waitMs) throw new Error(`에이전트 PC 화면(VNC)에 붙을 수 없어요: ${e.message}`);
      await sleep(600);
    }
  }
}

/**
 * 끈다 — 게스트 안에서 정상 종료(`lume shutdown` = ssh `shutdown -h now`) 를 먼저, 30초 안에 안 내려가면 VM 프로세스에
 *  SIGINT → SIGKILL. `lume stop` 은 쓰지 않는다: 우리가 자기 세션으로 떼어 띄운 VM 에 대해 아무 로그 없이 exit 130 으로
 *  죽고 VM 은 그대로 남았다(2026-09-17 실측, 원인 미상). 정상 종료가 되면 어차피 그쪽이 더 안전하다(디스크 일관성).
 */
async function stop() {
  if (rfb) { try { rfb.close(); } catch (_) { /* noop */ } rfb = null; }
  if (!lumeBin()) return { ok: true };
  const info = await vmInfo(true);
  if (!info || !/running/i.test(String(info.status || ''))) { invalidateInfo(); return { ok: true, already: true }; }
  try { await lume(['shutdown', vmName(), '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', '20'], { timeoutMs: 30000 }); } catch (_) { /* ssh 가 안 되면 아래 신호로 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const i = await vmInfo(true);
    if (!i || !/running/i.test(String(i.status || ''))) { await reapVmProcess(); invalidateInfo(); return { ok: true, graceful: true }; }
    await sleep(1000);
  }
  const pid = vmPid();
  if (pid) {
    try { process.kill(pid, 'SIGINT'); } catch (_) { /* noop */ }
    for (let i = 0; i < 10; i++) { await sleep(1000); if (!alive(pid)) { invalidateInfo(); return { ok: true, forced: 'SIGINT' }; } }
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
    await sleep(500);
  }
  invalidateInfo();
  return { ok: true, forced: 'SIGKILL' };
}
/**
 * 게스트는 내려갔는데 `lume run` 프로세스가 남아 VNC 포트를 쥐고 있는 경우가 있다(2026-09-19 실측: 정상 종료 뒤
 *  status=stopped 인데 프로세스 생존 → 다음 켜기가 "port 5951 already in use" 로 실패). 잠깐 기다렸다 신호로 거둔다.
 */
async function reapVmProcess(name) {
  for (let i = 0; i < 8; i++) { const pid = vmPid(name); if (!pid) return; await sleep(500); }
  const pid = vmPid(name); if (!pid) return;
  try { process.kill(pid, 'SIGINT'); } catch (_) { /* noop */ }
  for (let i = 0; i < 10; i++) { await sleep(500); if (!alive(pid)) return; }
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
  await sleep(500);
}
/**
 * OS 전환의 함정 — macOS/Linux VM 은 **VNC 포트 5951 을 공유**한다. 전환 때 옛 OS 의 `lume run` 이 남아 있으면
 *  새 OS 가 "port 5951 already in use" 로 못 켜진다(2026-09-21 실사고: macOS→Linux 전환 뒤 cpt-agent-desktop 이
 *  포트를 쥐고 있어 Linux 가 영영 안 켜졌다). 켜기 전에 **다른 OS 의 VM** 을 정상 종료 시도 후 확실히 거둔다.
 */
async function reapForeignVm() {
  const other = vmName() === VM_LINUX ? VM_NAME : VM_LINUX;
  if (!vmPid(other)) return;
  try { await lume(['stop', other], { timeoutMs: 15000 }); } catch (_) { /* 아래 신호로 */ }
  await reapVmProcess(other);
}
/** VM 프로세스 pid — Lume 이 VM 디렉터리에 남기는 owner 파일(실측 `.native-display-owner.json`), 없으면 pgrep. name 생략 시 현재 OS. */
function vmPid(name) {
  const nm = name || vmName();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lume', nm, '.native-display-owner.json'), 'utf8'));
    if (j && j.processIdentifier > 0 && alive(j.processIdentifier)) return j.processIdentifier;
  } catch (_) { /* noop */ }
  try {
    const out = cp.execFileSync('/usr/bin/pgrep', ['-f', `lume run ${nm}\\b`], { encoding: 'utf8' });
    const n = Number(String(out).trim().split('\n')[0]);
    return n > 0 ? n : 0;
  } catch (_) { return 0; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }

/** 게스트 셸. 문자열 한 줄로 받는다(lume ssh 가 원격 셸에 그대로 넘긴다). */
async function exec(cmd, o = {}) {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  touchUse();
  //  부팅 직후엔 VNC 는 떴는데 sshd 가 몇 초 늦는다(실측: 스냅샷 뒤 다시 켠 직후 "SSH is not available") — 그 오류만 20초까지 되풀이.
  const t0 = Date.now();
  for (;;) {
    try {
      const out = await lume(['ssh', vmName(), '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', String(Math.ceil((o.timeoutMs || 30000) / 1000)), String(cmd)],
        { timeoutMs: (o.timeoutMs || 30000) + 5000 });
      return String(out);
    } catch (e) {
      if (!/SSH is not available|has no IP address/i.test(String(e && e.message)) || Date.now() - t0 > 30000) throw e;
      await sleep(1500);
    }
  }
}

// ── 화면 ─────────────────────────────────────────────────────────────────────
async function frame(o = {}) {
  touchUse();
  const c = await connectRfb();
  await c.requestUpdate(true, o.waitMs || 400);
  const bmp = c.toBmp(o.maxWidth);          // 여기서 이미 줄였다 — toJpeg 에는 원본 크기라고 말해 재축소를 막는다
  const { toJpeg } = require('./emulator');
  const img = await toJpeg(bmp.buf, 'bmp', bmp.width, o.quality, { w: bmp.width, h: bmp.height });
  return { mime: img.mime, base64: img.buf.toString('base64'), width: c.width, height: c.height, bytes: img.buf.length };
}

// ── 라이브 영상(H.264) ─────────────────────────────────────────────────────────
/**
 * VNC 프레임버퍼(BGRX) → vt-h264(VideoToolbox, 하드웨어) → Annex-B 조각. `ScrcpySession`/`ServeSimSession` 과
 *  **같은 인터페이스**(start/configPacket/closed/close/meta) 라 emulator-stream 의 뷰어·GOP·배압 배관을 그대로 탄다.
 *  프레임 폴링(frame)과 같은 RFB 연결을 쓴다 — 갱신 요청은 pending 큐로 겹쳐도 안전하다.
 *  해상도가 바뀌면(로그인 1280×720 → 1440×900) 인코더를 새로 띄운다(SPS 가 바뀐다 — configPacket 도 새로).
 */
const STREAM_FPS = 20;
function vtH264Bin() {
  const cands = [process.env.CPT_VT_H264, path.join(runtime.stateDir(), 'bin', 'vt-h264'),
    process.env.CPT_SIDECAR_DIR ? path.join(process.env.CPT_SIDECAR_DIR, 'vt-h264') : null].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
}
/** 개발 편의 — 번들이 없으면 swiftc 로 한 번 빌드해 ~/.codingpt/bin 에 둔다(사용자 맥에는 번들이 있다). */
async function ensureVtH264() {
  const have = vtH264Bin();
  if (have) return have;
  const src = path.join(__dirname, 'native', 'vt-h264.swift');
  const out = path.join(runtime.stateDir(), 'bin', 'vt-h264');
  if (!fs.existsSync(src) || !fs.existsSync('/usr/bin/swiftc')) throw new Error('이 PC 에서는 에이전트 PC 라이브 화면을 쓸 수 없어요 (vt-h264 없음)');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await run('/usr/bin/swiftc', ['-O', '-o', out, src], { timeoutMs: 180000 });
  return out;
}
class DesktopStreamSession {
  constructor(cb) {
    this.cb = cb || {};
    this.closed = false;
    this.configPacket = null;
    this.meta = null;
    this.orientationKnown = false;
    this.orientation = 'landscape';
    this.enc = null;
    this.pending = Buffer.alloc(0);
  }
  static async start(_opts, cb) {
    const s = new DesktopStreamSession(cb);
    s.bin = await ensureVtH264();
    s.rfb = await connectRfb();
    s.meta = { width: s.rfb.width, height: s.rfb.height, codec: 'h264' };
    try { s.cb.onMeta?.(s.meta); } catch (_) { /* noop */ }
    s._spawnEncoder();
    s._onResize = ({ width, height }) => { s.meta = { width, height, codec: 'h264' }; try { s.cb.onMeta?.(s.meta); } catch (_) { /* noop */ } s._spawnEncoder(); };
    s.rfb.on('resize', s._onResize);
    s._onClose = () => s._fail('에이전트 PC 화면(VNC)이 끊겼어요');
    s.rfb.on('close', s._onClose);
    void s._loop();
    return s;
  }
  _spawnEncoder() {
    if (this.enc) { try { this.enc.kill('SIGKILL'); } catch (_) { /* noop */ } this.enc = null; }
    this.configPacket = null; this.pending = Buffer.alloc(0);
    const { width, height } = this.meta;
    const enc = cp.spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.enc = enc;
    enc.stdin.on('error', () => { /* 종료 경합 — 루프가 closed 를 본다 */ });
    enc.stdout.on('data', (d) => this._onChunk(enc, d));
    enc.on('exit', () => { if (this.enc === enc && !this.closed) this._fail('영상 인코더가 끝났어요'); });
    enc.stdin.write(`${width} ${height} ${STREAM_FPS} 4000000\n`);
    this._sizeAtSpawn = width * height * 4;
  }
  _onChunk(enc, d) {
    if (this.enc !== enc) return;                 // 옛 인코더의 꼬리 — 버린다(해상도가 바뀐 뒤)
    this.pending = Buffer.concat([this.pending, d]);
    for (;;) {
      if (this.pending.length < 5) return;
      const n = this.pending.readUInt32BE(0);
      if (this.pending.length < 5 + n) return;
      const flags = this.pending[4]; const data = Buffer.from(this.pending.subarray(5, 5 + n));
      this.pending = this.pending.subarray(5 + n);
      //  ★ SPS 에 VUI bitstream_restriction(재정렬 0) 을 붙인다 — 없으면 폰 하드웨어 디코더가 프레임을 쥐고 있어
      //   정지 화면(1fps) 에서 변화가 4~5초 뒤에 보였다(h264-sps.js 주석, 2026-09-20 실측).
      if (flags & 1) { const cfg = require('./h264-sps').patchConfigPacket(data); this.configPacket = cfg; this._emit({ config: true, keyFrame: false, data: cfg }); }
      else this._emit({ config: false, keyFrame: !!(flags & 2), data });
    }
  }
  _emit(f) { try { this.cb.onFrame?.(f); } catch (e) { console.warn(`[desktop] 프레임 처리 실패: ${(e && e.message) || e}`); } }
  async _loop() {
    const gap = Math.round(1000 / STREAM_FPS);
    let lastSent = 0;
    while (!this.closed) {
      const t0 = Date.now();
      let changed = false;
      try { changed = await this.rfb.requestUpdate(true, gap); } catch (_) { if (!this.closed) this._fail('VNC 갱신 실패'); return; }
      if (this.closed) return;
      //  바뀐 프레임만 인코더에 넣되, 1초에 한 장은 그대로 넣는다 — 정지 화면에서도 키프레임 주기가 살아 있어
      //   늦게 붙는 화면이 GOP 되감기로 바로 그린다.
      const now = Date.now();
      touchUse();
      if ((changed || this.rfb.dirty || now - lastSent > 1000) && this.enc && this.rfb.fb && this.rfb.fb.length === this._sizeAtSpawn) {
        this.rfb.dirty = false; lastSent = now;
        try { this.enc.stdin.write(this.rfb.fb); } catch (_) { /* exit 핸들러가 정리 */ }
      }
      const spent = Date.now() - t0;
      if (spent < gap) await sleep(gap - spent);
    }
  }
  _fail(msg) {
    if (this.closed) return;
    try { this.cb.onError?.(new Error(msg)); } catch (_) { /* noop */ }
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.rfb?.off('resize', this._onResize); this.rfb?.off('close', this._onClose); } catch (_) { /* noop */ }
    if (this.enc) { try { this.enc.stdin.end(); this.enc.kill('SIGKILL'); } catch (_) { /* noop */ } this.enc = null; }
    try { this.cb.onClose?.(); } catch (_) { /* noop */ }
  }
}

// ── 입력 ─────────────────────────────────────────────────────────────────────
const B_LEFT = 1, B_RIGHT = 4, B_WHEEL_UP = 8, B_WHEEL_DOWN = 16;
function px(n, max) { const v = Number(n); return Math.max(0, Math.min(max - 1, Math.round((Number.isFinite(v) ? v : 0) * max))); }

/**
 * 좌표는 0~1 정규화(모바일 화면과 같은 계약). 타입:
 *  touch(phase begin/move/end) · tap · longPress(=우클릭) · swipe(드래그) · scroll(dy 눈금) · key("cmd+c") · text
 *  `from` 이 'agent' 인 입력은 사용자가 화면을 만지는 동안(agentPaused) 거절한다 — 손 아래에서 커서가 튀는 게 제일 나쁘다.
 */
/**
 * 입력은 **한 줄로 세운다**. 폰 키보드는 글자마다 RPC 를 따로 보내는데(await 없이) 두 typeAscii 가 같은 RFB 소켓에서 겹치면
 *  키 down/down/up/up 이 되어 글자가 빠진다(실측 2026-09-20: "hello" → "Helo"). 순서도 보존된다.
 */
let _inputQ = Promise.resolve();
function input(a = {}) {
  const run = () => inputNow(a);
  const p = _inputQ.then(run, run);
  _inputQ = p.catch(() => {});
  return p;
}
async function inputNow(a = {}) {
  touchUse();
  const c = await connectRfb();
  const type = String(a.type || '');
  if (a.from === 'agent' && agentPaused) throw new Error('사용자가 에이전트 PC 를 조작하는 동안에는 에이전트 입력이 멈춰 있어요 (cpt desktop resume)');
  const X = px(a.x, c.width), Y = px(a.y, c.height);
  if (type === 'touch') {
    const ph = String(a.phase || '');
    if (ph === 'begin') c.pointer(X, Y, B_LEFT);
    else if (ph === 'move') c.pointer(X, Y, c.buttons);
    else if (ph === 'end' || ph === 'cancel') c.pointer(X, Y, 0);
    else throw new Error('알 수 없는 터치 단계예요');
    return { ok: true, via: 'vnc' };
  }
  if (type === 'move') { c.pointer(X, Y, 0); return { ok: true, via: 'vnc' }; }
  if (type === 'tap' || type === 'click') {
    const btn = String(a.button || '') === 'right' ? B_RIGHT : B_LEFT;
    const n = Math.max(1, Math.min(3, Number(a.count) || 1));
    c.pointer(X, Y, 0); await sleep(20);
    for (let i = 0; i < n; i++) { c.pointer(X, Y, btn); await sleep(40); c.pointer(X, Y, 0); if (i < n - 1) await sleep(60); }
    return { ok: true, via: 'vnc' };
  }
  if (type === 'longPress' || type === 'rightClick') {
    c.pointer(X, Y, 0); await sleep(20); c.pointer(X, Y, B_RIGHT); await sleep(60); c.pointer(X, Y, 0);
    return { ok: true, via: 'vnc' };
  }
  if (type === 'swipe' || type === 'drag') {
    const ms = Math.max(60, Math.min(3000, Number(a.durationMs) || 300));
    const steps = Math.max(3, Math.min(40, Math.round(ms / 16)));
    const X2 = px(a.x2, c.width), Y2 = px(a.y2, c.height);
    c.pointer(X, Y, 0); await sleep(20); c.pointer(X, Y, B_LEFT); await sleep(40);
    for (let i = 1; i <= steps; i++) { await sleep(ms / steps); c.pointer(X + (X2 - X) * i / steps, Y + (Y2 - Y) * i / steps, B_LEFT); }
    await sleep(30); c.pointer(X2, Y2, 0);
    return { ok: true, via: 'vnc' };
  }
  if (type === 'scroll') {
    const dy = Number(a.dy) || 0;
    const clicks = Math.max(1, Math.min(30, Math.round(Math.abs(dy)) || 1));
    const b = dy < 0 ? B_WHEEL_UP : B_WHEEL_DOWN;
    c.pointer(X, Y, 0);
    for (let i = 0; i < clicks; i++) { c.pointer(X, Y, b); c.pointer(X, Y, 0); await sleep(8); }
    return { ok: true, via: 'vnc' };
  }
  if (type === 'key') { await c.chord(String(a.key || '')); return { ok: true, via: 'vnc' }; }
  if (type === 'text') return typeText(String(a.text || ''), c);
  throw new Error(`알 수 없는 입력 종류예요: ${type}`);
}

/** 글자 입력. ASCII 는 키로 치고, 그 밖(한글 등)은 게스트 클립보드에 넣고 ⌘V — IME 조합에 기대지 않는다. */
async function typeText(text, c) {
  if (!text) return { ok: true };
  if (/^[\x20-\x7e\n]*$/.test(text)) { await c.typeAscii(text); return { ok: true, via: 'vnc' }; }
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  //  LANG 이 없는 ssh 세션에서 pbcopy 는 입력을 MacRoman 으로 읽어 한글이 깨진다(실측) — UTF-8 을 명시한다.
  await exec(`printf %s '${b64}' | base64 -d | LANG=en_US.UTF-8 pbcopy`, { timeoutMs: 15000 });
  await c.chord('cmd+v');
  return { ok: true, via: 'clipboard' };
}

// ── 접근성 트리(AX) ───────────────────────────────────────────────────────────
/**
 * 에이전트가 화면을 **읽는** 길 — 스크린샷 좌표 추정 대신 요소(role·title·value·frame 0~1)를 JSON 으로.
 *  게스트에서 JXA(desktop-ax.jxa.js)를 osascript 로 돌린다. 스크립트는 해시 이름으로 게스트 홈에 한 번 넣는다(ssh 1왕복).
 *  ssh 로 띄운 프로세스는 TCC 에 `sshd-keygen-wrapper` 로 잡힌다 — 접근성 권한이 없으면 ensureAx() 가 스스로 켠다.
 */
const AX_SRC = fs.readFileSync(path.join(__dirname, 'desktop-ax.jxa.js'), 'utf8');
const AX_HASH = crypto.createHash('sha1').update(AX_SRC).digest('hex').slice(0, 10);
const AX_PATH = `~/.cpt/ax-${AX_HASH}.js`;
/**
 * 접근성이 **실제로** 되는가 — AXIsProcessTrusted() 만 믿지 않는다. 실측(2026-09-19): 스냅샷 복원(머신 식별자 변경) 뒤
 *  AXIsProcessTrusted 는 true 인데 System Events UI 스크립팅은 -25211 로 거절됐다(트리에 메뉴만 나옴). 진짜 조회로 판정.
 */
async function axTrusted() {
  let out = '';
  try {
    out = await exec(`osascript -l JavaScript -e 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()' 2>&1; osascript -e 'tell application "System Events" to get count of windows of process "Finder"' 2>&1; true`, { timeoutMs: 15000 });
  } catch (_) { return false; }
  return /^true\s*$/m.test(out) && /^\d+\s*$/m.test(out) && !/not allowed|-25211|-1728|-1743/.test(out);
}
async function axTree(target) {
  if (isLinux()) {
    const info = await vmInfo(true);
    const screen = (info && info.display) || '1440x900';
    const out = await exec(LX().axCmd(target, screen), { timeoutMs: 60000 });
    const i = out.indexOf('{');
    if (i < 0) throw new Error(`접근성 트리를 읽지 못했어요: ${out.trim().slice(0, 200)}`);
    const j = JSON.parse(out.slice(i));
    if (j.error) throw new Error(j.error);
    return j;
  }
  await ensureAx();
  const arg = target ? shq(String(target)) : '';
  const cmd = `[ -f ${AX_PATH} ] || { mkdir -p ~/.cpt && printf %s '${Buffer.from(AX_SRC, 'utf8').toString('base64')}' | base64 -d > ${AX_PATH}; }; osascript -l JavaScript ${AX_PATH} ${arg} 2>&1`;
  const out = await exec(cmd, { timeoutMs: 60000 });
  const i = out.indexOf('{');
  if (i < 0) throw new Error(`접근성 트리를 읽지 못했어요: ${out.trim().slice(0, 200)}`);
  const j = JSON.parse(out.slice(i));
  if (j.error) throw new Error(j.error);
  return j;
}
/** 글자로 요소 찾기 — title/desc/value/placeholder/id 를 정확 → 포함 순으로, 조작 가능한 role 을 먼저. */
const AX_CLICKABLE = /^(Button|CheckBox|RadioButton|MenuItem|MenuBarItem|PopUpButton|Link|TextField|TextArea|Tab|Cell|Row|ComboBox|Slider|Incrementor|DisclosureTriangle|Image|StaticText)$/;
function axFind(tree, text, o = {}) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return null;
  const nodes = tree.nodes.filter((n) => n.w > 0 && n.h > 0 && !n.disabled && (!o.role || n.role === o.role));
  const label = (n) => [n.title, n.desc, n.value, n.ph, n.id, n.help].filter((v) => v != null).map((v) => String(v).toLowerCase());
  const score = (n) => { const ls = label(n); if (ls.some((l) => l === q)) return 2; if (ls.some((l) => l.includes(q))) return 1; return 0; };
  const hits = nodes.map((n) => ({ n, s: score(n) })).filter((x) => x.s > 0)
    .sort((a, b) => (b.s - a.s) || (Number(AX_CLICKABLE.test(b.n.role)) - Number(AX_CLICKABLE.test(a.n.role))) || (a.n.w * a.n.h - b.n.w * b.n.h));
  return hits.length ? hits[0].n : null;
}
async function axTap(text, o = {}) {
  //  ★ 앱을 지정했으면 먼저 앞으로 가져온다 — 클릭은 좌표로 가니 다른 창이 덮고 있으면 그 창이 눌린다(실측: Safari 링크를
  //   노렸는데 위에 있던 설정 앱의 Siri 가 눌렸다). 앞으로 온 뒤 트리를 읽어야 좌표도 맞다.
  if (o.app && !/^\d+$/.test(String(o.app))) { await openApp(o.app); await sleep(700); }
  const tree = await axTree(o.app);
  const n = axFind(tree, text, o);
  if (!n) throw new Error(`"${text}" 요소를 못 찾았어요 (${tree.app}, ${tree.nodes.length}개 중)`);
  const x = n.x + n.w / 2, y = n.y + n.h / 2;
  await input({ type: 'tap', x, y, button: o.button, from: o.from });
  return { ok: true, app: tree.app, node: n, x: +x.toFixed(4), y: +y.toFixed(4) };
}

/**
 * 접근성 권한을 스스로 켠다(없을 때만). 게스트 이미지가 고정(macos-tahoe-vanilla 26.4, 1440×900)이라 창 위치가 결정적이다:
 *  ① System Events 자동화 프롬프트 [Allow] ② 접근성 안내 창은 Esc ③ 설정 앱을 접근성 패널로 열어 첫 줄(sshd-keygen-wrapper)
 *  토글 → 비밀번호 → 확인. 어느 단계든 안 되면 에이전트에게 handoff 로 사용자에게 넘기라고 알린다(사용자는 pane 에서 켠다).
 *  SIP 가 켜져 있어 TCC.db 를 직접 못 쓴다(실측) — 이 길이 유일하다.
 */
let _axOk = false;
async function ensureAx() {
  if (isLinux()) { _axOk = true; return true; }   // Linux 는 TCC 없음(접근성은 settle 이 세션에서 켠다)
  if (_axOk) return true;
  if (await axTrusted()) { _axOk = true; return true; }
  //  "켜져 있는데 안 되는" 반쪽 상태(복원 뒤)면 목록의 토글이 이미 ON 이라 한 번 누르면 꺼진다 — 먼저 지워서 OFF/부재로 맞춘다.
  await exec('tccutil reset Accessibility >/dev/null 2>&1; true', { timeoutMs: 15000 });
  const c = await connectRfb();
  const tap = async (x, y) => { c.pointer(px(x, c.width), px(y, c.height), B_LEFT); await sleep(80); c.pointer(px(x, c.width), px(y, c.height), 0); };
  //  프롬프트가 떠 있는 동안 osascript 는 **답을 기다리며 멈춘다**(실측 25초 넘게) — 짧게 자르고 시간 초과 = 프롬프트로 본다.
  const se = async (script, ms = 8000) => { try { return await exec(`osascript -e ${shq(script)} 2>&1; true`, { timeoutMs: ms }); } catch (_) { return 'TIMEOUT'; } };
  //  ① 자동화(System Events) — 안 돼 있으면 프롬프트가 화면 가운데 뜬다 → [Allow]
  for (let i = 0; i < 3; i++) {
    const r = await se('tell application "System Events" to get name of first process');
    if (!/TIMEOUT|-1743|not allowed|Not authorized/i.test(r)) break;
    await sleep(800); await tap(0.582, 0.628); await sleep(1500);
  }
  //  ② 접근성 — 한 번 실패시켜 목록에 올린다(안내 창이 뜬다 → Esc)
  await se('tell application "System Events" to tell (first process whose frontmost is true) to get name of every window');
  await sleep(1200); await c.chord('escape'); await sleep(600);
  //  ③ 설정 → 접근성 패널 → 첫 줄 토글 → 비밀번호
  await exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { timeoutMs: 15000 });
  await sleep(3000);
  await tap(0.9345, 0.314);
  await sleep(1800);
  await c.typeAscii(SSH_PASSWORD); await sleep(200); await c.chord('enter');
  await sleep(2500);
  const ok = await axTrusted();
  await exec('pkill -x "System Settings"; true', { timeoutMs: 10000 });   // `quit application` 은 또 다른 자동화 프롬프트를 부른다
  if (!ok) throw new Error('에이전트 PC 의 접근성 권한을 켤 수 없었어요 — `cpt desktop handoff "접근성 권한을 허용해 주세요"` 로 사용자에게 넘기세요 (설정 › 개인정보 보호 및 보안 › 손쉬운 사용 › sshd-keygen-wrapper)');
  _axOk = true;
  return true;
}

// ── 앱·주소 ───────────────────────────────────────────────────────────────────
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
async function openApp(name) {
  if (!/^[\w .+-]{1,64}$/.test(String(name || ''))) throw new Error('앱 이름이 올바르지 않아요');
  await exec(isLinux() ? LX().openAppCmd(name) : `open -a ${shq(name)}`, { timeoutMs: 20000 });
  return { ok: true };
}
async function openUrl(url) {
  const u = String(url || '');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) throw new Error('주소가 올바르지 않아요');
  await exec(`open ${shq(guestUrl(u))}`, { timeoutMs: 20000 });
  return { ok: true, url: guestUrl(u) };
}
/** 호스트 localhost 는 게스트에서 NAT 게이트웨이(192.168.64.1)로 닿는다. */
function guestUrl(u) { return u.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i, '$1192.168.64.1'); }
/** 호스트 경로 → 게스트 공유 폴더 경로. 연결된 sharedDirs 중 하나 아래여야 한다. */
function guestPath(p) {
  const abs = path.resolve(String(p || ''));
  for (const d of normalizeDirs(loadSettings().sharedDirs)) {
    const root = d;
    if (abs === root || abs.startsWith(root + path.sep)) return path.posix.join('/Volumes/My Shared Files', path.basename(root), path.relative(root, abs).split(path.sep).join('/'));
  }
  return null;
}

// ── 사용자 개입 ────────────────────────────────────────────────────────────────
let handoff = null; // {reason, at, resolve}
/** 에이전트가 "사용자가 대신 해 주세요"(로그인 등) — 카드가 뜨고, 사용자가 [계속] 을 누르면 풀린다. */
function requestHandoff(reason, o = {}) {
  if (handoff) handoff.resolve({ ok: false, superseded: true });
  agentPaused = true;
  return new Promise((resolve) => {
    handoff = { reason: String(reason || '사용자 조작이 필요해요'), at: Date.now(), resolve };
    if (o.timeoutMs) setTimeout(() => { if (handoff && handoff.resolve === resolve) { handoff = null; agentPaused = false; resolve({ ok: false, timeout: true }); } }, o.timeoutMs).unref();
  });
}
function resume() { agentPaused = false; if (handoff) { const h = handoff; handoff = null; h.resolve({ ok: true }); } return { ok: true }; }
function pause() { agentPaused = true; return { ok: true }; }
function pendingHandoff() { return handoff ? { reason: handoff.reason, at: handoff.at } : null; }

// ── 기기 목록에 끼워 넣기(모바일 화면 pane 재사용) ─────────────────────────────
const DEVICE_ID = 'desktop:main';
async function deviceRow() {
  if (process.platform !== 'darwin') return null;
  armIdleWatch();
  const st = await status();
  if (st.phase === 'unsupported' || st.phase === 'no-tool') return null;
  const running = st.phase === 'running';
  return {
    id: DEVICE_ID, kind: 'desktop', name: '에이전트 PC', state: running ? 'booted' : 'shutdown', physical: false,
    desktop: { phase: st.phase, reason: st.reason || '', paused: st.paused, handoff: pendingHandoff() },
    caps: { frame: running, input: running, keys: [], inputHint: running ? '' : (st.reason || '에이전트 PC 가 꺼져 있어요') },
  };
}

/** RPC — `desktop.*` 와, emulator.js 가 `desktop:` id 로 넘겨 주는 frame/input/openUrl. */
const POLL_METHODS = new Set(['desktop.status', 'desktop.snapshots', 'desktop.settings.get']);
async function handle(method, p = {}) {
  const m = String(method);
  armIdleWatch();
  if (!POLL_METHODS.has(m)) touchUse();
  if (m === 'desktop.status') return { ...(await status()), handoff: pendingHandoff(), idleOffMin: Number(loadSettings().idleOffMin) || 0, idleMin: Math.floor((Date.now() - lastUse) / 60000) };
  if (m === 'desktop.pull') return pull();
  if (m === 'desktop.delete') return remove();
  if (m === 'desktop.start') {
    //  ★ Linux 첫 부팅은 cloud-init 설치로 8~12분 — start() 를 RPC 로 끝까지 기다리면 클라 소켓이 타임아웃한다
    //   ("응답 수신 실패: Resource temporarily unavailable (os error 35)", 2026-09-21 실사고). 켜기를 백그라운드로
    //   돌리고 바로 status 를 돌려준다(폴링이 진행 phase 'pulling'/'starting'→'running' 을 본다). 실패는 status.reason.
    const pr = start(p); pr.catch((e) => { _startErr = String((e && e.message) || e); });
    await Promise.race([pr.catch(() => {}), sleep(2500)]);
    return status();
  }
  if (m === 'desktop.stop') return stop();
  if (m === 'desktop.provision') { markProvisioned(0); if ((await status()).phase === 'running') await stop(); return start(p); }
  if (m === 'desktop.exec') return { out: await exec(String(p.cmd || ''), { timeoutMs: p.timeoutMs }) };
  if (m === 'desktop.frame') return frame(p);
  if (m === 'desktop.input') return input(p);
  if (m === 'desktop.openApp') return openApp(p.name);
  if (m === 'desktop.openUrl') return openUrl(p.url);
  if (m === 'desktop.path') return { host: p.path, guest: guestPath(p.path) };
  if (m === 'desktop.snapshots') return { snapshots: await snapshots(), max: SNAP_MAX };
  if (m === 'desktop.snapshot') return snapshot(p.label);
  if (m === 'desktop.restore') return restore(p.name);
  if (m === 'desktop.snapshot.delete') return snapshotDelete(p.name);
  if (m === 'desktop.ax') return axTree(p.app || p.pid);
  if (m === 'desktop.tap') return axTap(String(p.text || ''), { app: p.app, role: p.role, button: p.button, from: p.from });
  if (m === 'desktop.connect' || m === 'desktop.disconnect') return connectDir(String(p.dir || ''), m === 'desktop.connect');
  if (m === 'desktop.handoff') return requestHandoff(p.reason, { timeoutMs: p.timeoutMs });
  if (m === 'desktop.resume') return resume();
  if (m === 'desktop.pause') return pause();
  if (m === 'desktop.settings.get') return withIds(loadSettings());
  if (m === 'desktop.settings.set') { const np = { ...p }; if (np.osKind != null && np.osKind !== 'macos' && np.osKind !== 'linux') throw new Error('osKind 는 macos 또는 linux'); const s = { ...loadSettings(), ...np }; saveSettings(s); return withIds(loadSettings()); }
  throw new Error(`알 수 없는 메서드: ${m}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  settle, SETTLE_SCRIPT,
  handle, status, start, stop, pull, remove, exec, frame, input, openApp, openUrl, guestUrl, guestPath, deviceRow, DEVICE_ID, VM_NAME, IMAGE,
  requestHandoff, resume, pause, pendingHandoff, provision, connectDir, axTree, axFind, axTap, ensureAx, DesktopStreamSession, vtH264Bin, strongVncPassword, snapshots, snapshot, restore, snapshotDelete, snapName, SNAP_PREFIX, carryIdentity, IDLE_OFF_DEFAULT_MIN, _idleState: () => ({ lastUse }), _idleTest: (ageMs) => { lastUse = Date.now() - ageMs; return idleTick(); }, PROVISION_VER, PROVISION_SCRIPT, loadSettings, saveSettings, absDir, normalizeDirs, dirId, _resetTools, lumeBin, osKind, isLinux, vmName, snapPrefix,
};
