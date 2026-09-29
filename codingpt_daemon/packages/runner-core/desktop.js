'use strict';

/**
 * desktop — **에이전트 PC**: 이 맥 안에서 에이전트가 쓰는 별도의 컴퓨터(게스트 VM). macOS·Linux 두 종을 지원한다.
 *
 *  ★ 2026-09-21: macOS·Linux 를 **동시에** 독립 pane 으로 쓸 수 있게 OS별 인스턴스로 분리했다.
 *   - 기기 id 는 `desktop:macos` · `desktop:linux`(레거시 `desktop:main` = 옛 osKind).
 *   - VM 이름·VNC 포트·화면(RFB)·켜기/끄기/입력 상태·설정을 **OS별로** 따로 둔다(둘 다 동시에 켜질 수 있다).
 *   - 공유(무상태) 헬퍼는 모듈 스코프, OS별 상태·수명주기는 `createVm(os)` 클로저, 라우터가 id/os 로 고른다.
 *
 *  층: 하이퍼바이저=Lume(Virtualization.framework) · 화면·입력=VNC(desktop-rfb) · 셸=`lume ssh`.
 *  단위: 맥 한 대에 macOS·Linux VM 각 1대(총 2대까지 동시). 워크스페이스는 여기에 폴더 공유로 "연결".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const runtime = require('./runtime');
const { RfbClient } = require('./desktop-rfb');

const VM_NAME = 'cpt-agent-desktop';        // macOS VM
const VM_LINUX = 'cpt-agent-linux';         // Linux VM
const IMAGE = 'macos-tahoe-vanilla:latest';
const LX = () => require('./desktop-linux');
const MIN_HOST_GB = 32;                      // 이 아래 맥에서는 기능을 켜지 않는다
const BOOT_TIMEOUT_MS = 120000;
const SSH_USER = 'lume';
const SSH_PASSWORD = 'lume';
const PROVISION_VER = 2;
const SNAP_MAX = 5;
const IDLE_OFF_DEFAULT_MIN = 60;
const STREAM_FPS = 20;
const B_LEFT = 1, B_RIGHT = 4, B_WHEEL_UP = 8, B_WHEEL_DOWN = 16;
//  VNC 포트는 OS별로 다르다 — 둘이 동시에 켜지므로 5951(macOS)/5952(Linux) 로 나눈다(예전엔 공유 5951 이라 충돌).
function vncPortFor(osk) { return osk === 'linux' ? 5952 : 5951; }
function vmNameFor(osk) { return osk === 'linux' ? VM_LINUX : VM_NAME; }

// ── /etc/kcpassword(자동 로그인) ──────────────────────────────────────────────
function kcpassword(pw) {
  const key = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xb3, 0xdd, 0xbf, 0x5f, 0xe5, 0x12];
  const raw = Buffer.from(pw, 'utf8');
  const out = Buffer.alloc(Math.ceil((raw.length + 1) / 12) * 12, 0);
  raw.copy(out);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length];
  return out.toString('base64');
}
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
mkdir -p ~/Library/Containers/com.apple.Safari/Data/Library/Preferences
defaults write ~/Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari UniversalSearchFeatureNotificationHasBeenDisplayed -bool true
defaults write com.apple.Safari UniversalSearchFeatureNotificationHasBeenDisplayed -bool true
launchctl disable gui/$(id -u)/com.apple.tipsd 2>/dev/null || true
pkill -x tipsd 2>/dev/null || true
[ "$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser)" = "${SSH_USER}" ] && sudo test -s /etc/kcpassword && echo CPT_PROVISION_OK
`;
const SETTLE_SCRIPT = `P="${SSH_PASSWORD}"
defaults -currentHost write com.apple.screensaver idleTime -int 0
sysadminctl -screenLock off -password "$P" >/dev/null 2>&1 || true
launchctl disable gui/$(id -u)/com.apple.tipsd 2>/dev/null || true
sysadminctl -screenLock status 2>&1 | grep -q 'screenLock is off' && [ "$(defaults -currentHost read com.apple.screensaver idleTime)" = 0 ] && echo CPT_SETTLE_OK
`;

// ── 공유 무상태 헬퍼 ──────────────────────────────────────────────────────────
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

function run(bin, args, o = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(bin, args, { timeout: o.timeoutMs || 30000, maxBuffer: 1 << 26, env: { ...process.env, LANG: 'en_US.UTF-8' } },
      (err, stdout, stderr) => { if (err) { err.message = `${err.message}\n${stderr || ''}`.slice(0, 1000); reject(err); } else resolve(stdout); });
    child.on('error', reject);
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

// ── 설정(OS별) ────────────────────────────────────────────────────────────────
//  파일은 하나(desktop.json)지만 OS별로 나눠 담는다: { macos:{memGB,cpu,idleOffMin,sharedDirs,provisioned}, linux:{...} }.
//  레거시 평면 키(sharedDirs·idleOffMin·provisioned·provisionedLinux·osKind)는 읽을 때 OS별로 흡수한다(마이그레이션).
function settingsFile() { return path.join(runtime.stateDir(), 'desktop.json'); }
function loadRaw() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; }
  catch (_) { return {}; }
}
function saveRaw(s) { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }
function absDir(d) {
  const s = String(d || '');
  if (!s) return '';
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(os.homedir(), s);   // PC 앱이 홈-상대 워크스페이스 id 를 보낸다
}
function normalizeDirs(list) {
  const out = [];
  for (const d of (Array.isArray(list) ? list : [])) { const a = absDir(d); if (a && !out.includes(a)) out.push(a); }
  return out;
}
function dirId(d) { const a = absDir(d); const home = os.homedir(); return a.startsWith(home + path.sep) ? path.relative(home, a) : a; }
function legacyOsKind() { const r = loadRaw(); return r.osKind === 'linux' ? 'linux' : 'macos'; }
/** OS별 설정을 흡수(마이그레이션)해 돌려준다. provisioned 는 OS별 키(macos=provisioned·linux=provisionedLinux) 도 흡수. */
function osSettings(osk) {
  const raw = loadRaw();
  const o = raw[osk] && typeof raw[osk] === 'object' ? raw[osk] : {};
  const legacyProv = osk === 'linux' ? raw.provisionedLinux : raw.provisioned;
  return {
    memGB: o.memGB, cpu: o.cpu,
    idleOffMin: o.idleOffMin != null ? o.idleOffMin : (raw.idleOffMin != null ? raw.idleOffMin : IDLE_OFF_DEFAULT_MIN),
    sharedDirs: normalizeDirs(o.sharedDirs != null ? o.sharedDirs : raw.sharedDirs),
    provisioned: Number(o.provisioned != null ? o.provisioned : (legacyProv || 0)) || 0,
  };
}
function saveOsSettings(osk, patch) {
  const raw = loadRaw();
  const cur = raw[osk] && typeof raw[osk] === 'object' ? raw[osk] : {};
  const next = { ...cur, ...patch };
  if (patch.sharedDirs != null) next.sharedDirs = normalizeDirs(patch.sharedDirs);
  raw[osk] = next;
  saveRaw(raw);
}
function withIds(s) { return { ...s, sharedIds: (s.sharedDirs || []).map(dirId) }; }
//  레거시 호환(테스트·옛 호출) — 평면 loadSettings/saveSettings 은 기본 OS(레거시 osKind)의 설정을 본다.
function loadSettings() { return osSettings(legacyOsKind()); }
function saveSettings(patch) { const { sharedDirs, memGB, cpu, idleOffMin, provisioned } = patch || {}; saveOsSettings(legacyOsKind(), { sharedDirs, memGB, cpu, idleOffMin, provisioned }); }

function strongVncPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += A[crypto.randomInt(A.length)];
  return /^[A-Za-z]/.test(out) ? out : 'k' + out.slice(1);
}
function parseVncUrl(u) {
  const m = /^vnc:\/\/(?:([^:@]*):)?([^@]*)@([^:]+):(\d+)/.exec(String(u || ''));
  if (!m) return null;
  return { password: decodeURIComponent(m[2] || ''), host: m[3], port: Number(m[4]) };
}
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
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function px(n, max) { const v = Number(n); return Math.max(0, Math.min(max - 1, Math.round((Number.isFinite(v) ? v : 0) * max))); }

function vtH264Bin() {
  const cands = [process.env.CPT_VT_H264, path.join(runtime.stateDir(), 'bin', 'vt-h264'),
    process.env.CPT_SIDECAR_DIR ? path.join(process.env.CPT_SIDECAR_DIR, 'vt-h264') : null].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
}
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

const AX_SRC = fs.readFileSync(path.join(__dirname, 'desktop-ax.jxa.js'), 'utf8');
const AX_HASH = crypto.createHash('sha1').update(AX_SRC).digest('hex').slice(0, 10);
const AX_PATH = `~/.cpt/ax-${AX_HASH}.js`;
const AX_CLICKABLE = /^(Button|CheckBox|RadioButton|MenuItem|MenuBarItem|PopUpButton|Link|TextField|TextArea|Tab|Cell|Row|ComboBox|Slider|Incrementor|DisclosureTriangle|Image|StaticText)$/;
/** 글자로 요소 찾기(무상태) — tree 는 axTree 결과. */
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
function mkSnapName(prefix, label) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const lab = String(label || '').trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return prefix + ts + (lab ? '-' + lab : '');
}

// ── 라이브 영상(H.264) 세션 — connectRfb 를 주입받아 그 VM 의 화면을 인코딩 ────────────────
class DesktopStreamSession {
  constructor(cb) {
    this.cb = cb || {};
    this.closed = false;
    this.configPacket = null;
    this.meta = null;
    this.enc = null;
    this.pending = Buffer.alloc(0);
  }
  static async start(_opts, cb, connectRfb) {
    const s = new DesktopStreamSession(cb);
    s.bin = await ensureVtH264();
    s.rfb = await (connectRfb || _defaultConnectRfb)();
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
    enc.stdin.on('error', () => { /* 종료 경합 */ });
    enc.stdout.on('data', (d) => this._onChunk(enc, d));
    enc.on('exit', () => { if (this.enc === enc && !this.closed) this._fail('영상 인코더가 끝났어요'); });
    enc.stdin.write(`${width} ${height} ${STREAM_FPS} 4000000\n`);
    this._sizeAtSpawn = width * height * 4;
  }
  _onChunk(enc, d) {
    if (this.enc !== enc) return;
    this.pending = Buffer.concat([this.pending, d]);
    for (;;) {
      if (this.pending.length < 5) return;
      const n = this.pending.readUInt32BE(0);
      if (this.pending.length < 5 + n) return;
      const flags = this.pending[4]; const data = Buffer.from(this.pending.subarray(5, 5 + n));
      this.pending = this.pending.subarray(5 + n);
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
      const now = Date.now();
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
//  DesktopStreamSession.start 를 connectRfb 없이 부르던 옛 경로 호환(기본 OS).
function _defaultConnectRfb() { return VMS[legacyOsKind()].connectRfb(); }

// ── OS별 인스턴스 ──────────────────────────────────────────────────────────────
/** 한 OS(macOS 또는 Linux)의 VM 을 관장한다. 상태·수명주기·화면·입력·AX 를 클로저에 가둔다(둘이 동시에 살아 있어도 안 섞인다). */
function createVm(osk) {
  const isLinux = osk === 'linux';
  const vmName = vmNameFor(osk);
  const VNC_PORT = vncPortFor(osk);
  const snapPrefix = vmName + '--snap-';
  const PROV_KEY = isLinux ? 'provisionedLinux' : 'provisioned';   // (레거시 파일 마이그레이션용 이름 — 저장은 osSettings 로)
  const DEVICE_ID = `desktop:${osk}`;

  // per-vm 상태
  let _infoCache = { at: 0, v: null, p: null };
  let _starting = null, _startErr = null, _linuxBuild = null, _step = '';
  let rfb = null, vncPassword = '', agentPaused = false;
  let pullState = null;
  let lastUse = Date.now(), _idleTimer = null;
  let _inputQ = Promise.resolve();
  let _axOk = false;
  let handoff = null;

  function loadS() { return osSettings(osk); }
  function provisionedVer() { return Number(loadS().provisioned || 0); }
  function markProvisioned(v) { saveOsSettings(osk, { provisioned: v }); }
  function touchUse() { lastUse = Date.now(); }

  async function settle() {
    try {
      const out = await exec(isLinux ? LX().SETTLE_CMD : SETTLE_SCRIPT, { timeoutMs: 20000 });
      if (!/CPT_SETTLE_OK/.test(out)) console.warn('[desktop] settle 미완료:', out.trim().slice(0, 200));
      return true;
    } catch (e) { console.warn('[desktop] settle 실패:', String(e && e.message || e).slice(0, 200)); return false; }
  }

  const INFO_TTL_MS = 1500;
  async function vmInfo(fresh) {
    if (!lumeBin()) return null;
    const now = Date.now();
    if (!fresh && _infoCache.p) return _infoCache.p;
    if (!fresh && now - _infoCache.at < INFO_TTL_MS) return _infoCache.v;
    const p = (async () => {
      try {
        const out = await lume(['get', vmName, '-f', 'json'], { timeoutMs: 15000 });
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

  async function status() {
    const s = loadS();
    const base = {
      vm: vmName, hostGB: hostGB(), minHostGB: MIN_HOST_GB, sharedDirs: s.sharedDirs, memGB: s.memGB || defaultResources().memGB, cpu: s.cpu || defaultResources().cpu,
      vnc: { port: VNC_PORT }, lume: lumeBin() || null, osKind: osk, deviceId: DEVICE_ID,
    };
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return { ...base, phase: 'unsupported', reason: 'Apple 실리콘 Mac 에서만 쓸 수 있어요' };
    if (base.hostGB < MIN_HOST_GB) return { ...base, phase: 'unsupported', reason: `메모리 ${MIN_HOST_GB}GB 이상인 Mac 에서만 켤 수 있어요 (이 Mac: ${base.hostGB}GB)` };
    if (!lumeBin()) return { ...base, phase: 'no-tool', reason: 'VM 도구(lume)가 없어요' };
    const info = await vmInfo();
    if (!info) {
      if (isLinux) {
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
      ...((!running && !_starting && _startErr) ? { reason: _startErr } : {}),
      provisioned: provisionedVer() >= PROVISION_VER,
      os: info.os, ip: info.ipAddress || null, cpuCount: info.cpuCount, memorySize: info.memorySize, diskSize: info.diskSize,
      display: info.display, vncUrl: running ? (info.vncUrl || null) : null,
      screen: rfb && rfb.ready ? { width: rfb.width, height: rfb.height } : null,
      paused: !!agentPaused,
    };
  }

  function armIdleWatch() {
    if (_idleTimer) return;
    _idleTimer = setInterval(() => idleTick(), 60000);
    _idleTimer.unref?.();
  }
  async function idleTick() {
    try {
      const min = Number(loadS().idleOffMin) || 0;
      if (min <= 0 || _starting || pendingHandoff()) return;
      if (Date.now() - lastUse < min * 60000) return;
      const info = await vmInfo();
      if (!info || !/running/i.test(String(info.status || ''))) return;
      console.log(`[desktop:${osk}] ${min}분 동안 쓰지 않아 에이전트 PC 를 끕니다`);
      touchUse();
      await stop();
      return true;
    } catch (_) { /* 다음 틱에 */ }
    return false;
  }

  function pull() {
    if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
    if (pullState && pullState.running) return pullState;
    pullState = { running: true, done: 0, total: 0, bytes: '', totalBytes: '', elapsed: '', error: null, at: Date.now() };
    const child = cp.spawn(lumeBin(), ['pull', IMAGE, vmName], { env: { ...process.env, LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // ── 스냅샷 ──
  async function lumeLs() {
    const out = String(await lume(['ls', '-f', 'json'], { timeoutMs: 15000 }));
    const i = out.indexOf('['); if (i < 0) return [];
    try { return JSON.parse(out.slice(i)); } catch (_) { return []; }
  }
  async function snapshots() {
    const rows = (await lumeLs()).filter((v) => String(v.name || '').startsWith(snapPrefix));
    return rows.map((v) => {
      const rest = String(v.name).slice(snapPrefix.length);
      const m = /^(\d{8})-(\d{6})(?:-(.*))?$/.exec(rest);
      const at = m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4), +m[2].slice(4, 6)) : 0;
      return { name: v.name, label: m && m[3] ? m[3] : '', at, allocated: v.diskSize && v.diskSize.allocated };
    }).sort((a, b) => b.at - a.at);
  }
  async function withStopped(fn) {
    const wasRunning = (await status()).phase === 'running';
    if (wasRunning) await stop();
    const r = await fn();
    invalidateInfo();
    if (wasRunning) await start();
    return { ...r, restarted: wasRunning };
  }
  async function snapshot(label) {
    if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
    if (!(await vmInfo(true))) throw new Error('에이전트 PC 가 아직 없어요');
    const name = mkSnapName(snapPrefix, label);
    return withStopped(async () => {
      await lume(['clone', vmName, name], { timeoutMs: 120000 });
      carryIdentity(vmName, name);
      const all = await snapshots();
      for (const s of all.slice(SNAP_MAX)) { try { await lume(['delete', s.name, '--force'], { timeoutMs: 60000 }); } catch (_) { /* 다음에 */ } }
      return { ok: true, name, snapshots: await snapshots() };
    });
  }
  async function restore(name) {
    const n = String(name || '');
    if (!n.startsWith(snapPrefix)) throw new Error('스냅샷 이름이 아니에요');
    if (!(await snapshots()).some((s) => s.name === n)) throw new Error(`스냅샷이 없어요: ${n}`);
    return withStopped(async () => {
      await lume(['delete', vmName, '--force'], { timeoutMs: 60000 });
      await lume(['clone', n, vmName], { timeoutMs: 120000 });
      carryIdentity(n, vmName);
      return { ok: true, name: n };
    });
  }
  async function snapshotDelete(name) {
    const n = String(name || '');
    if (!n.startsWith(snapPrefix)) throw new Error('스냅샷 이름이 아니에요');
    await lume(['delete', n, '--force'], { timeoutMs: 60000 });
    return { ok: true, snapshots: await snapshots() };
  }
  async function remove() {
    if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
    await stop();
    await lume(['delete', vmName, '--force'], { timeoutMs: 60000 });
    invalidateInfo();
    return { ok: true };
  }

  // ── 수명주기 ──
  async function start(o = {}) {
    touchUse(); armIdleWatch();
    _startErr = null;
    if (_starting) return _starting;
    _starting = (async () => {
      let st = await status();
      if (st.phase === 'unsupported' || st.phase === 'no-tool') throw new Error(st.reason);
      if (st.phase === 'no-image') {
        if (!isLinux) throw new Error(st.reason);
        _step = 'provision';
        const res = defaultResources(); const cfg = loadS();
        try {
          _linuxBuild = { running: true, phase: 'download', pct: 0 };
          await LX().ensureImage({ lumeBin, vmName, cpu: cfg.cpu || res.cpu, memGB: cfg.memGB || res.memGB,
            onProgress: (x) => { _linuxBuild = { running: true, ...x }; } });
        } catch (e) { _linuxBuild = { running: false, error: String((e && e.message) || e) }; throw e; }
        _linuxBuild = { running: false };
        st = await status();
      }
      if (st.phase !== 'running') await launch(o);
      _step = 'boot';
      await waitRunning();
      if (provisionedVer() < PROVISION_VER) {
        if (isLinux) {
          _step = 'provision';
          await waitLoggedIn(780000);
          _step = 'ax';
          await settle();
          markProvisioned(PROVISION_VER);
        } else {
          await provision();
          _step = 'reboot';
          await stop();
          await launch(o);
          await waitRunning();
          await waitLoggedIn();
          _step = 'ax';
          await sleep(4000);
          try { await ensureAx(); } catch (_) { /* 첫 ax 때 다시 */ }
        }
      }
      await connectRfb({ waitMs: 30000 });
      void settle();
    })();
    try { await _starting; } finally { _starting = null; _step = ''; }
    return status();
  }

  async function launch(o = {}) {
    _axOk = false;
    await reapVmProcess();   // 같은 OS 의 옛 프로세스가 포트를 쥐고 있으면 거둔다(다른 OS 는 이제 안 건드린다 — 동시 실행).
    const s = loadS();
    const res = defaultResources();
    try { await lume(['set', vmName, '--cpu', String(s.cpu || res.cpu), '--memory', `${s.memGB || res.memGB}GB`], { timeoutMs: 20000 }); } catch (_) { /* 켜진 채면 무시 */ }
    vncPassword = strongVncPassword();
    const args = ['run', vmName, ...(isLinux ? ['--no-display'] : ['--display', 'none']), '--vnc-port', String(VNC_PORT), '--vnc-password', vncPassword];
    if (isLinux && provisionedVer() < 1) args.push('--mount', LX().seedFile());
    for (const d of normalizeDirs(o.sharedDirs || s.sharedDirs)) args.push('--shared-dir', `${d}:rw`);
    fs.mkdirSync(runtime.stateDir(), { recursive: true });
    const logFd = fs.openSync(path.join(runtime.stateDir(), `desktop-vm-${osk}.log`), 'a');
    const child = cp.spawn(lumeBin(), args, { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, LANG: 'en_US.UTF-8' } });
    child.on('error', () => { /* waitRunning 이 시간 초과로 알린다 */ });
    child.unref();
    fs.closeSync(logFd);
    invalidateInfo();
  }

  async function waitLoggedIn(limitMs = 90000) {
    const t0 = Date.now();
    for (;;) {
      try { const w = await exec(isLinux ? LX().LOGIN_CHECK : 'who', { timeoutMs: 10000 }); if (isLinux ? /LOGGED_IN/.test(w) : /console/.test(w)) return true; } catch (_) { /* 부팅 중 */ }
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
  async function connectDir(dir, on) {
    const abs = absDir(dir);
    if (!abs) throw new Error('폴더 경로가 필요해요');
    if (on) { try { if (!fs.statSync(abs).isDirectory()) throw new Error(); } catch (_) { throw new Error(`폴더가 없어요: ${abs}`); } }
    const s = loadS();
    const set = new Set(normalizeDirs(s.sharedDirs));
    const had = set.has(abs);
    if (on) set.add(abs); else set.delete(abs);
    const changed = on ? !had : had;
    if (changed) saveOsSettings(osk, { sharedDirs: [...set] });
    let restarted = false;
    if (changed && (await status()).phase === 'running') { await stop(); await start(); restarted = true; }
    return { ok: true, host: abs, guest: on ? path.posix.join('/Volumes/My Shared Files', path.basename(abs)) : null, changed, restarted, sharedDirs: [...set] };
  }

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

  async function stop() {
    if (rfb) { try { rfb.close(); } catch (_) { /* noop */ } rfb = null; }
    if (!lumeBin()) return { ok: true };
    const info = await vmInfo(true);
    if (!info || !/running/i.test(String(info.status || ''))) { invalidateInfo(); return { ok: true, already: true }; }
    try { await lume(['shutdown', vmName, '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', '20'], { timeoutMs: 30000 }); } catch (_) { /* 아래 신호로 */ }
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
  async function reapVmProcess() {
    for (let i = 0; i < 8; i++) { const pid = vmPid(); if (!pid) return; await sleep(500); }
    const pid = vmPid(); if (!pid) return;
    try { process.kill(pid, 'SIGINT'); } catch (_) { /* noop */ }
    for (let i = 0; i < 10; i++) { await sleep(500); if (!alive(pid)) return; }
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
    await sleep(500);
  }
  function vmPid() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lume', vmName, '.native-display-owner.json'), 'utf8'));
      if (j && j.processIdentifier > 0 && alive(j.processIdentifier)) return j.processIdentifier;
    } catch (_) { /* noop */ }
    try {
      const out = cp.execFileSync('/usr/bin/pgrep', ['-f', `lume run ${vmName}\\b`], { encoding: 'utf8' });
      const n = Number(String(out).trim().split('\n')[0]);
      return n > 0 ? n : 0;
    } catch (_) { return 0; }
  }

  async function exec(cmd, o = {}) {
    if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
    touchUse();
    const t0 = Date.now();
    for (;;) {
      try {
        const out = await lume(['ssh', vmName, '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', String(Math.ceil((o.timeoutMs || 30000) / 1000)), String(cmd)],
          { timeoutMs: (o.timeoutMs || 30000) + 5000 });
        return String(out);
      } catch (e) {
        if (!/SSH is not available|has no IP address/i.test(String(e && e.message)) || Date.now() - t0 > 30000) throw e;
        await sleep(1500);
      }
    }
  }

  async function frame(o = {}) {
    touchUse();
    const c = await connectRfb();
    await c.requestUpdate(true, o.waitMs || 400);
    const bmp = c.toBmp(o.maxWidth);
    const { toJpeg } = require('./emulator');
    const img = await toJpeg(bmp.buf, 'bmp', bmp.width, o.quality, { w: bmp.width, h: bmp.height });
    return { mime: img.mime, base64: img.buf.toString('base64'), width: c.width, height: c.height, bytes: img.buf.length };
  }
  function startStream(cbs) { return DesktopStreamSession.start({}, cbs, connectRfb); }

  // ── 입력 ──
  function input(a = {}) {
    const runFn = () => inputNow(a);
    const p = _inputQ.then(runFn, runFn);
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
  async function typeText(text, c) {
    if (!text) return { ok: true };
    if (/^[\x20-\x7e\n]*$/.test(text)) { await c.typeAscii(text); return { ok: true, via: 'vnc' }; }
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    await exec(`printf %s '${b64}' | base64 -d | LANG=en_US.UTF-8 pbcopy`, { timeoutMs: 15000 });
    await c.chord('cmd+v');
    return { ok: true, via: 'clipboard' };
  }

  // ── 접근성(AX) ──
  async function axTrusted() {
    let out = '';
    try {
      out = await exec(`osascript -l JavaScript -e 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()' 2>&1; osascript -e 'tell application "System Events" to get count of windows of process "Finder"' 2>&1; true`, { timeoutMs: 15000 });
    } catch (_) { return false; }
    return /^true\s*$/m.test(out) && /^\d+\s*$/m.test(out) && !/not allowed|-25211|-1728|-1743/.test(out);
  }
  async function axTree(target) {
    if (isLinux) {
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
  async function axTap(text, o = {}) {
    if (o.app && !/^\d+$/.test(String(o.app))) { await openApp(o.app); await sleep(700); }
    const tree = await axTree(o.app);
    const n = axFind(tree, text, o);
    if (!n) throw new Error(`"${text}" 요소를 못 찾았어요 (${tree.app}, ${tree.nodes.length}개 중)`);
    const x = n.x + n.w / 2, y = n.y + n.h / 2;
    await input({ type: 'tap', x, y, button: o.button, from: o.from });
    return { ok: true, app: tree.app, node: n, x: +x.toFixed(4), y: +y.toFixed(4) };
  }
  async function ensureAx() {
    if (isLinux) { _axOk = true; return true; }
    if (_axOk) return true;
    if (await axTrusted()) { _axOk = true; return true; }
    await exec('tccutil reset Accessibility >/dev/null 2>&1; true', { timeoutMs: 15000 });
    const c = await connectRfb();
    const tap = async (x, y) => { c.pointer(px(x, c.width), px(y, c.height), B_LEFT); await sleep(80); c.pointer(px(x, c.width), px(y, c.height), 0); };
    const se = async (script, ms = 8000) => { try { return await exec(`osascript -e ${shq(script)} 2>&1; true`, { timeoutMs: ms }); } catch (_) { return 'TIMEOUT'; } };
    for (let i = 0; i < 3; i++) {
      const r = await se('tell application "System Events" to get name of first process');
      if (!/TIMEOUT|-1743|not allowed|Not authorized/i.test(r)) break;
      await sleep(800); await tap(0.582, 0.628); await sleep(1500);
    }
    await se('tell application "System Events" to tell (first process whose frontmost is true) to get name of every window');
    await sleep(1200); await c.chord('escape'); await sleep(600);
    await exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { timeoutMs: 15000 });
    await sleep(3000);
    await tap(0.9345, 0.314);
    await sleep(1800);
    await c.typeAscii(SSH_PASSWORD); await sleep(200); await c.chord('enter');
    await sleep(2500);
    const ok = await axTrusted();
    await exec('pkill -x "System Settings"; true', { timeoutMs: 10000 });
    if (!ok) throw new Error('에이전트 PC 의 접근성 권한을 켤 수 없었어요 — `cpt desktop handoff "접근성 권한을 허용해 주세요"` 로 사용자에게 넘기세요 (설정 › 개인정보 보호 및 보안 › 손쉬운 사용 › sshd-keygen-wrapper)');
    _axOk = true;
    return true;
  }

  // ── 앱·주소 ──
  async function openApp(name) {
    if (!/^[\w .+-]{1,64}$/.test(String(name || ''))) throw new Error('앱 이름이 올바르지 않아요');
    await exec(isLinux ? LX().openAppCmd(name) : `open -a ${shq(name)}`, { timeoutMs: 20000 });
    return { ok: true };
  }
  async function openUrl(url) {
    const u = String(url || '');
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) throw new Error('주소가 올바르지 않아요');
    await exec(`open ${shq(guestUrl(u))}`, { timeoutMs: 20000 });
    return { ok: true, url: guestUrl(u) };
  }
  function guestPath(p) {
    const abs = path.resolve(String(p || ''));
    for (const d of normalizeDirs(loadS().sharedDirs)) {
      const root = d;
      if (abs === root || abs.startsWith(root + path.sep)) return path.posix.join('/Volumes/My Shared Files', path.basename(root), path.relative(root, abs).split(path.sep).join('/'));
    }
    return null;
  }

  // ── 사용자 개입 ──
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

  async function deviceRow() {
    armIdleWatch();
    const st = await status();
    if (st.phase === 'unsupported' || st.phase === 'no-tool') return null;
    const running = st.phase === 'running';
    return {
      id: DEVICE_ID, kind: 'desktop', osKind: osk, name: osk === 'linux' ? 'Linux · VM' : 'macOS · VM', state: running ? 'booted' : 'shutdown', physical: false,
      desktop: { phase: st.phase, reason: st.reason || '', paused: st.paused, handoff: pendingHandoff(), osKind: osk },
      caps: { frame: running, input: running, keys: [], inputHint: running ? '' : (st.reason || '에이전트 PC 가 꺼져 있어요') },
    };
  }

  const POLL = new Set(['desktop.status', 'desktop.snapshots', 'desktop.settings.get']);
  async function handle(method, p = {}) {
    const m = String(method);
    armIdleWatch();
    if (!POLL.has(m)) touchUse();
    if (m === 'desktop.status') return { ...(await status()), handoff: pendingHandoff(), idleOffMin: Number(loadS().idleOffMin) || 0, idleMin: Math.floor((Date.now() - lastUse) / 60000) };
    if (m === 'desktop.pull') return pull();
    if (m === 'desktop.delete') return remove();
    if (m === 'desktop.start') {
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
    if (m === 'desktop.settings.get') return withIds(loadS());
    if (m === 'desktop.settings.set') {
      const patch = {};
      for (const k of ['memGB', 'cpu', 'idleOffMin', 'sharedDirs']) if (p[k] != null) patch[k] = p[k];
      saveOsSettings(osk, patch);
      return withIds(loadS());
    }
    throw new Error(`알 수 없는 메서드: ${m}`);
  }

  return {
    osk, vmName, DEVICE_ID, VNC_PORT, snapPrefix, isLinux,
    status, start, stop, pull, remove, exec, frame, input, openApp, openUrl, guestPath, deviceRow, handle, startStream,
    requestHandoff, resume, pause, pendingHandoff, provision, connectDir, axTree, axTap, ensureAx,
    snapshots, snapshot, restore, snapshotDelete, settle,
    loadSettings: loadS, provisionedVer, markProvisioned,
    _idleState: () => ({ lastUse }), _idleTest: (ageMs) => { lastUse = Date.now() - ageMs; return idleTick(); },
  };
}

// ── 라우터 ─────────────────────────────────────────────────────────────────────
const VMS = { macos: createVm('macos'), linux: createVm('linux') };
function osOf(id) {
  const s = String(id || '');
  if (s === 'desktop:linux') return 'linux';
  if (s === 'desktop:macos') return 'macos';
  if (s === 'desktop:main' || s === 'desktop') return legacyOsKind();   // 레거시 pane 은 옛 osKind 로
  return null;
}
function vmForOs(osk) { return VMS[osk === 'linux' ? 'linux' : 'macos']; }
function pickVm(p) {
  const byOs = (p && (p.os === 'macos' || p.os === 'linux')) ? p.os : null;
  const byId = osOf(p && (p.id || p.deviceId));
  return vmForOs(byOs || byId || legacyOsKind());
}
function guestUrl(u) { return String(u).replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i, '$1192.168.64.1'); }

async function handle(method, p = {}) { return pickVm(p).handle(String(method), p || {}); }
/** 두 OS 의 기기 행을 모두 돌려준다(각각 독립 pane). 지원 안 되는 환경은 null 을 걸러낸다. */
async function deviceRow() {
  if (process.platform !== 'darwin') return [];
  const rows = await Promise.all([VMS.macos.deviceRow().catch(() => null), VMS.linux.deviceRow().catch(() => null)]);
  return rows.filter(Boolean);
}
/** emulator-stream 이 부른다 — 기기 id 로 그 OS 의 화면 스트림을 연다. */
function startStream(id, cbs) { return vmForOs(osOf(id) || legacyOsKind()).startStream(cbs); }

//  레거시/테스트 호환 — 기본 OS(옛 osKind)의 VM 으로 위임한다.
const dflt = () => vmForOs(legacyOsKind());
module.exports = {
  handle, deviceRow, startStream, DesktopStreamSession, VMS, osOf,
  // 라우터 위임(기본 OS)
  status: (...a) => dflt().status(...a), start: (...a) => dflt().start(...a), stop: (...a) => dflt().stop(...a),
  pull: (...a) => dflt().pull(...a), remove: (...a) => dflt().remove(...a), exec: (...a) => dflt().exec(...a),
  frame: (...a) => dflt().frame(...a), input: (...a) => dflt().input(...a), openApp: (...a) => dflt().openApp(...a), openUrl: (...a) => dflt().openUrl(...a),
  requestHandoff: (...a) => dflt().requestHandoff(...a), resume: (...a) => dflt().resume(...a), pause: (...a) => dflt().pause(...a), pendingHandoff: (...a) => dflt().pendingHandoff(...a),
  provision: (...a) => dflt().provision(...a), connectDir: (...a) => dflt().connectDir(...a), axTree: (...a) => dflt().axTree(...a), axTap: (...a) => dflt().axTap(...a), ensureAx: (...a) => dflt().ensureAx(...a),
  snapshots: (...a) => dflt().snapshots(...a), snapshot: (...a) => dflt().snapshot(...a), restore: (...a) => dflt().restore(...a), snapshotDelete: (...a) => dflt().snapshotDelete(...a),
  settle: (...a) => dflt().settle(...a),
  _idleState: () => dflt()._idleState(), _idleTest: (ageMs) => dflt()._idleTest(ageMs),
  // 공유·상수·헬퍼
  guestUrl, guestPath: (p) => dflt().guestPath(p), snapName: (label) => mkSnapName(VM_NAME + "--snap-", label),
  DEVICE_ID: 'desktop:main', VM_NAME, VM_LINUX, IMAGE, PROVISION_VER, PROVISION_SCRIPT, SETTLE_SCRIPT, SNAP_PREFIX: VM_NAME + '--snap-', IDLE_OFF_DEFAULT_MIN,
  axFind, strongVncPassword, carryIdentity, vtH264Bin,
  loadSettings, saveSettings, absDir, normalizeDirs, dirId, _resetTools, lumeBin,
  osKind: legacyOsKind, isLinux: () => legacyOsKind() === 'linux', vmName: () => vmNameFor(legacyOsKind()), snapPrefix: () => vmNameFor(legacyOsKind()) + '--snap-',
};
