'use strict';
// 에이전트 PC(Linux 게스트) OS별 조각 — desktop.js 가 osKind==='linux' 일 때 위임한다.
//  공유(VNC·프레임·입력·스냅샷·유휴·exec=lume ssh)는 desktop.js 그대로. 여기 있는 건 이미지 준비·초기설정·조작(AT-SPI).
//  실증: 2026-09-21(Ubuntu 24.04 arm64 cloudimg + cloud-init + XFCE, VNC 렌더·AT-SPI 트리 확인). [[agent_desktop_linux_guest]]
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const runtime = require('./runtime');
const { convert } = require('./qcow2-to-raw');

const CLOUD_URL = 'https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img';
const DISK_GB = 20;
const SSH_USER = 'lume';
const SSH_PASSWORD = 'lume';
const LUME_UID = 1000;   // cloud-init 이 만드는 첫 사용자(lume) uid
//  ssh 로 GUI 세션의 접근성/조작을 건드리려면 그래픽 세션 버스를 가리켜야 한다(안 그러면 트리가 빈다).
const GUI_ENV = `export DISPLAY=:0 XAUTHORITY=/home/${SSH_USER}/.Xauthority DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${LUME_UID}/bus GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0;`;

// SHA-512 crypt of "lume" (openssl passwd -6 -salt cptagent lume) — 재현 가능(고정 salt).
const LUME_PWHASH = '$6$cptagent$q2QMcfI34EmKrG75r0MCdA3AVTb8FIvWWQuRq0bti/nF6ApXXKi9/782mHKPQuIdNTEH5jA69yMTs8sk8xqNJ1';

/** cloud-init user-data — 자동 로그인 XFCE + 브라우저 + 접근성(AT-SPI) + 좌표 조작(xdotool) + SSH. 화면 꺼짐/잠금 없음. */
function userData() {
  return `#cloud-config
users:
  - name: ${SSH_USER}
    groups: [sudo, audio, video, plugdev]
    shell: /bin/bash
    sudo: ["ALL=(ALL) NOPASSWD:ALL"]
    lock_passwd: false
    passwd: ${LUME_PWHASH}
ssh_pwauth: true
chpasswd:
  expire: false
  users:
    - {name: ${SSH_USER}, password: ${SSH_PASSWORD}, type: text}
package_update: true
packages:
  - xfce4
  - xfce4-goodies
  - lightdm
  - firefox
  - openssh-server
  - at-spi2-core
  - python3-pyatspi
  - xdotool
  - x11-utils
  - dbus-x11
write_files:
  - path: /etc/lightdm/lightdm.conf.d/50-autologin.conf
    content: |
      [Seat:*]
      autologin-user=${SSH_USER}
      autologin-user-timeout=0
      user-session=xfce
  - path: /etc/environment
    append: true
    content: |
      GTK_MODULES=gail:atk-bridge
      QT_ACCESSIBILITY=1
      NO_AT_BRIDGE=0
  - path: /etc/xdg/autostart/cpt-noblank.desktop
    content: |
      [Desktop Entry]
      Type=Application
      Name=cpt-noblank
      Exec=sh -c "sleep 4; xset s off; xset -dpms; xset s noblank; xfconf-query -c xfce4-screensaver -p /saver/enabled -s false; pkill -f light-locker; gsettings set org.gnome.desktop.interface toolkit-accessibility true"
      X-GNOME-Autostart-enabled=true
runcmd:
  - [ systemctl, set-default, graphical.target ]
  - [ systemctl, enable, lightdm ]
  - [ apt-get, purge, -y, light-locker ]
  - [ sh, -c, "touch /var/lib/cloud/cpt-provision-ok" ]
power_state:
  mode: reboot
  condition: true
`;
}

function vmDir(vmName) { return path.join(os.homedir(), '.lume', vmName); }
function cacheDir() { const d = path.join(runtime.stateDir(), 'linux-cache'); fs.mkdirSync(d, { recursive: true }); return d; }

/** cloud-init NoCloud seed(FAT, 볼륨 라벨 CIDATA) 를 만든다 — hdiutil(맥 기본). ★라벨·FAT 아니면 cloud-init 이 무시한다. */
function buildSeed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-seed-'));
  fs.writeFileSync(path.join(dir, 'user-data'), userData());
  fs.writeFileSync(path.join(dir, 'meta-data'), 'instance-id: cpt-agent-linux\nlocal-hostname: cpt-agent\n');
  const dmg = path.join(runtime.stateDir(), 'linux-seed');   // hdiutil 이 .dmg 를 붙인다
  try { fs.unlinkSync(dmg + '.dmg'); } catch (_) { /* noop */ }
  cp.execFileSync('/usr/bin/hdiutil', ['create', '-megabytes', '2', '-fs', 'MS-DOS FAT12', '-volname', 'CIDATA', '-layout', 'NONE', '-o', dmg], { stdio: 'ignore' });
  const attach = cp.execFileSync('/usr/bin/hdiutil', ['attach', dmg + '.dmg'], { encoding: 'utf8' });
  const dev = attach.trim().split('\n').pop().trim().split(/\s+/)[0];
  const mnt = '/Volumes/CIDATA';
  try {
    cp.execFileSync('/bin/cp', [path.join(dir, 'user-data'), path.join(dir, 'meta-data'), mnt + '/'], { stdio: 'ignore' });
  } finally {
    try { cp.execFileSync('/usr/bin/hdiutil', ['detach', dev], { stdio: 'ignore' }); } catch (_) { /* noop */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
  return dmg + '.dmg';
}

/**
 * Linux 이미지 준비 — 클라우드 이미지 받아 raw 로 변환 → lume create → disk.img 교체 → seed 생성.
 *  이미 VM 이 있으면(디스크 존재) 아무것도 안 한다. onProgress({phase, pct}).
 */
async function ensureImage({ lumeBin, vmName, cpu, memGB, onProgress = () => {} }) {
  if (fs.existsSync(path.join(vmDir(vmName), 'disk.img'))) return { built: false };
  const cache = cacheDir();
  const qcow = path.join(cache, 'ubuntu-cloudimg-arm64.img');
  // 1) 다운로드(캐시)
  if (!fs.existsSync(qcow) || fs.statSync(qcow).size < 100 * 1024 * 1024) {
    onProgress({ phase: 'download', pct: 0 });
    await download(CLOUD_URL, qcow, (p) => onProgress({ phase: 'download', pct: p }));
  }
  // 2) qcow2 → raw
  onProgress({ phase: 'convert', pct: 0 });
  const raw = path.join(cache, 'ubuntu-cloudimg-arm64.raw');
  convert(qcow, raw, (p) => onProgress({ phase: 'convert', pct: p }));
  // 3) 20GB 로 확장(sparse — 파일 크기만 키운다)
  const truncTo = DISK_GB * 1024 * 1024 * 1024;
  const fd = fs.openSync(raw, 'r+'); try { fs.ftruncateSync(fd, truncTo); } finally { fs.closeSync(fd); }
  // 4) lume create(빈 디스크+nvram+config) → disk.img 를 raw 로 교체
  onProgress({ phase: 'create', pct: 0 });
  await run(lumeBin, ['create', vmName, '--os', 'linux', '--cpu', String(cpu), '--memory', `${memGB}GB`, '--disk-size', String(DISK_GB), '--display', '1440x900'], 120000);
  const disk = path.join(vmDir(vmName), 'disk.img');
  fs.copyFileSync(raw, disk);   // APFS 는 copyFileSync 가 clonefile 사용(빠름·sparse 유지)
  // 5) seed
  buildSeed();
  return { built: true };
}

/** 첫 부팅(프로비저닝) 인가 — cloud-init 이 아직 안 돈 상태. seed 를 mount 해 부팅해야 한다. */
function needsProvision(settings) { return (settings.provisioned || 0) < 1; }

/** lume run 추가 인자 — 첫 부팅엔 seed 를 mount 한다(cloud-init 이 읽음). Linux 는 --no-display. */
function launchArgs({ firstBoot }) {
  const a = ['--no-display'];
  if (firstBoot) a.push('--mount', seedFile());
  return a;
}
// seedPath 는 hdiutil 이 .dmg 를 붙이므로 실제 파일명으로 교정
function seedFile() { return path.join(runtime.stateDir(), 'linux-seed.dmg'); }

/** 자동 로그인 증거 — lume 이 :0(그래픽 세션) 에 로그인. */
const LOGIN_CHECK = `who 2>/dev/null | grep -q ':0' && echo LOGGED_IN || echo waiting`;

/** 켤 때마다 다시 거는 것 — 접근성 on(세션에서 켜야 GTK 앱이 트리 노출)·화면 꺼짐/잠금 해제. */
const SETTLE_CMD = `${GUI_ENV} `
  + `gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null; `
  + `xset s off 2>/dev/null; xset -dpms 2>/dev/null; xset s noblank 2>/dev/null; xset dpms force on 2>/dev/null; `
  + `xfconf-query -c xfce4-screensaver -p /saver/enabled -s false 2>/dev/null; `
  + `pkill -f light-locker 2>/dev/null; pkill -f xfce4-screensaver 2>/dev/null; `
  + `[ "$(gsettings get org.gnome.desktop.interface toolkit-accessibility)" = true ] && echo CPT_SETTLE_OK`;

/** AT-SPI 덤퍼를 게스트에 한 번 주입하고 실행하는 ssh 명령 — JXA 와 같은 JSON 을 낸다. screen = "WxH". */
function axCmd(target, screen) {
  const src = fs.readFileSync(path.join(__dirname, 'desktop-atspi.py'), 'utf8');
  const b64 = Buffer.from(src, 'utf8').toString('base64');
  const arg = target ? shq(String(target)) : '';
  return `mkdir -p ~/.cpt; printf %s '${b64}' | base64 -d > ~/.cpt/atspi.py; `
    + `${GUI_ENV} python3 ~/.cpt/atspi.py ${arg} --screen ${screen || '1440x900'} 2>&1`;
}

/** 앱 실행 — setsid 로 세션에서 띄운다. */
function openAppCmd(name) {
  return `${GUI_ENV} setsid ${shq(name)} >/dev/null 2>&1 &`;
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── 내부: 다운로드/프로세스 ──
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const req = require('https').get(url, { headers: { 'User-Agent': 'cpt-daemon' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        out.close(); require('https').get(res.headers.location, (r2) => pipe(r2)).on('error', reject); return;
      }
      if (res.statusCode !== 200) { out.close(); reject(new Error(`다운로드 실패 HTTP ${res.statusCode}`)); return; }
      pipe(res);
    });
    req.on('error', reject);
    function pipe(res) {
      const total = Number(res.headers['content-length'] || 0); let got = 0; let last = 0;
      res.on('data', (c) => { got += c.length; if (total && onProgress) { const p = got / total; if (p - last > 0.02) { last = p; onProgress(p); } } });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      res.on('error', reject);
    }
  });
}

function run(lumeBin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(lumeBin(), args, { timeout: timeoutMs, env: { ...process.env, LANG: 'en_US.UTF-8' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').slice(0, 300)));
      else resolve(String(stdout));
    });
    child.on('error', reject);
  });
}

module.exports = {
  CLOUD_URL, DISK_GB, ensureImage, buildSeed, seedFile, userData, needsProvision, launchArgs,
  LOGIN_CHECK, SETTLE_CMD, axCmd, openAppCmd, GUI_ENV, LUME_PWHASH,
};
