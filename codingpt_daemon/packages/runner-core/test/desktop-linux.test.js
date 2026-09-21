'use strict';
// 에이전트 PC Linux 게스트 — 계약 검증(실 VM 없이). 실동작(부팅·cloud-init·AT-SPI)은 2026-09-21 수동 실증.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

test('qcow2 → raw 변환 — 헤더 파싱·압축/언압축/0 클러스터', () => {
  const { convert } = require('../qcow2-to-raw');
  //  작은 qcow2 v3 를 손으로 만든다: 클러스터 512B(bits 9), 가상크기 2클러스터. c0=언압축(0xAB…), c1=미할당(0).
  const CB = 9, CS = 1 << CB, L2E = CS / 8;
  const virt = CS * 2;
  const clusters = [];        // 호스트 클러스터 순서대로 쌓는다
  const header = Buffer.alloc(CS); clusters.push(header);
  const l1 = Buffer.alloc(CS); clusters.push(l1);
  const l2 = Buffer.alloc(CS); clusters.push(l2);
  const data0 = Buffer.alloc(CS, 0xAB); clusters.push(data0);
  const off = (i) => BigInt(i * CS);
  header.writeUInt32BE(0x514649fb, 0); header.writeUInt32BE(3, 4);
  header.writeBigUInt64BE(0n, 8);                 // backing offset 0
  header.writeUInt32BE(CB, 20);                   // cluster_bits
  header.writeBigUInt64BE(BigInt(virt), 24);      // virtual size
  header.writeUInt32BE(1, 36);                     // l1 size (1 entry covers L2E clusters)
  header.writeBigUInt64BE(off(1), 40);            // l1 offset
  l1.writeBigUInt64BE(off(2) | (1n << 63n), 0);   // → l2 (copied flag)
  l2.writeBigUInt64BE(off(3) | (1n << 63n), 0);   // guest c0 → data0 (uncompressed)
  l2.writeBigUInt64BE(0n, 8);                       // guest c1 → unallocated (zeros)
  const src = path.join(os.tmpdir(), `cpt-qcow-${process.pid}.img`);
  const dst = path.join(os.tmpdir(), `cpt-raw-${process.pid}.img`);
  fs.writeFileSync(src, Buffer.concat(clusters));
  try {
    const r = convert(src, dst, () => {});
    assert.strictEqual(r.virtualSize, virt);
    const out = fs.readFileSync(dst);
    assert.strictEqual(out.length, virt);
    assert.ok(out.subarray(0, CS).every((b) => b === 0xAB), 'c0 = 언압축 데이터');
    assert.ok(out.subarray(CS, CS * 2).every((b) => b === 0), 'c1 = 0');
  } finally { for (const f of [src, dst]) try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
});

test('qcow2 압축 클러스터(zlib) 해제', () => {
  const { convert } = require('../qcow2-to-raw');
  const CB = 12, CS = 1 << CB;   // 4KB 클러스터(압축 디스크립터 비트폭 테스트)
  const virt = CS;
  const payload = Buffer.alloc(CS); for (let i = 0; i < CS; i++) payload[i] = (i * 7) & 0xff;
  const comp = zlib.deflateRawSync(payload);
  // 레이아웃: [header][l1][l2][comp data]
  const header = Buffer.alloc(CS), l1 = Buffer.alloc(CS), l2 = Buffer.alloc(CS);
  const pre = CS * 3;
  header.writeUInt32BE(0x514649fb, 0); header.writeUInt32BE(3, 4); header.writeUInt32BE(CB, 20);
  header.writeBigUInt64BE(BigInt(virt), 24); header.writeUInt32BE(1, 36); header.writeBigUInt64BE(BigInt(CS), 40);
  l1.writeBigUInt64BE(BigInt(CS * 2) | (1n << 63n), 0);
  // 압축 디스크립터: bit62=1, [offset(하위 x비트)][nb_sectors]. x = 62 - (CB-8)
  const csectorBits = CB - 8, x = 62 - csectorBits;
  const hostOff = pre;
  const nbSectors = Math.ceil((comp.length + (hostOff & 511)) / 512) - 1;   // 저장값 = 실제-1
  const desc = (1n << 62n) | (BigInt(nbSectors) << BigInt(x)) | BigInt(hostOff);
  l2.writeBigUInt64BE(desc, 0);
  const buf = Buffer.concat([header, l1, l2, comp, Buffer.alloc(CS)]);
  const src = path.join(os.tmpdir(), `cpt-qc2-${process.pid}.img`);
  const dst = path.join(os.tmpdir(), `cpt-rw2-${process.pid}.img`);
  fs.writeFileSync(src, buf);
  try {
    convert(src, dst, () => {});
    const out = fs.readFileSync(dst);
    assert.ok(out.subarray(0, CS).equals(payload), '압축 클러스터가 원본으로 복원');
  } finally { for (const f of [src, dst]) try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
});

test('cloud-init user-data — 자동 로그인·데스크톱·접근성·조작 도구·SSH', () => {
  const lx = require('../desktop-linux');
  const ud = lx.userData();
  assert.ok(ud.startsWith('#cloud-config'), 'cloud-config 헤더');
  for (const pkg of ['xfce4', 'lightdm', 'firefox', 'at-spi2-core', 'python3-pyatspi', 'xdotool', 'openssh-server']) {
    assert.ok(ud.includes('- ' + pkg), '패키지 ' + pkg);
  }
  assert.ok(/autologin-user=lume/.test(ud), 'lightdm 자동 로그인');
  assert.ok(/ssh_pwauth: true/.test(ud) && /password: lume/.test(ud), 'SSH 비밀번호 로그인');
  assert.ok(/toolkit-accessibility true/.test(ud) && /GTK_MODULES=gail:atk-bridge/.test(ud), '접근성');
  assert.ok(/power_state:[\s\S]*reboot/.test(ud), '설치 후 재부팅');
  //  비밀번호 해시는 실제 'lume' 여야 한다(SHA-512 crypt).
  assert.strictEqual(lx.LUME_PWHASH, '$6$cptagent$q2QMcfI34EmKrG75r0MCdA3AVTb8FIvWWQuRq0bti/nF6ApXXKi9/782mHKPQuIdNTEH5jA69yMTs8sk8xqNJ1');
});

test('AT-SPI/settle/openApp 명령 — 그래픽 세션 버스 env(★함정)·플랫(중첩 따옴표 없음)', () => {
  const lx = require('../desktop-linux');
  const ax = lx.axCmd('Thunar', '1440x900');
  //  ssh 로 부를 때 세션 버스를 못 보면 트리가 빈다 — DISPLAY/DBUS/XAUTHORITY 필수(실측 2026-09-21).
  assert.ok(/DISPLAY=:0/.test(ax) && /DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus/.test(ax) && /XAUTHORITY=/.test(ax), 'GUI 세션 env');
  assert.ok(/base64 -d > ~\/\.cpt\/atspi\.py/.test(ax) && /python3 ~\/\.cpt\/atspi\.py 'Thunar' --screen 1440x900/.test(ax), '덤퍼 주입+실행');
  assert.ok(!/sh -lc '.*'.*'/.test(ax), '중첩 따옴표 없음(플랫)');
  assert.ok(/toolkit-accessibility true/.test(lx.SETTLE_CMD) && /CPT_SETTLE_OK/.test(lx.SETTLE_CMD) && /xset s off/.test(lx.SETTLE_CMD), 'settle: 접근성 on+화면 안꺼짐+표식');
  assert.ok(/setsid 'firefox'/.test(lx.openAppCmd('firefox')), 'openApp=setsid');
  assert.ok(/LOGGED_IN/.test(lx.LOGIN_CHECK) && /:0/.test(lx.LOGIN_CHECK), '로그인 확인=:0 세션');
});

test('desktop.js OS별 인스턴스 — macOS·Linux 를 독립 VM 으로 동시에(포트·이름·라우팅)', () => {
  const d = require('../desktop');
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8');
  //  두 OS 인스턴스가 따로 있다(둘 다 동시에 살아 있을 수 있다).
  assert.ok(d.VMS && d.VMS.macos && d.VMS.linux, 'VMS.macos / VMS.linux');
  assert.strictEqual(d.VMS.macos.vmName, 'cpt-agent-desktop');
  assert.strictEqual(d.VMS.linux.vmName, 'cpt-agent-linux');
  //  ★ VNC 포트가 OS별로 다르다 — 예전엔 5951 공유라 둘째가 "port in use" 로 못 켜졌다.
  assert.strictEqual(d.VMS.macos.VNC_PORT, 5951);
  assert.strictEqual(d.VMS.linux.VNC_PORT, 5952);
  //  기기 id 로 OS 를 가른다.
  assert.strictEqual(d.osOf('desktop:macos'), 'macos');
  assert.strictEqual(d.osOf('desktop:linux'), 'linux');
  assert.strictEqual(d.VMS.linux.DEVICE_ID, 'desktop:linux');
  //  Linux 분기(팩토리 안).
  assert.ok(/if \(isLinux\) \{ _axOk = true; return true; \}/.test(src), 'ensureAx Linux no-op');
  assert.ok(/LX\(\)\.axCmd\(target, screen\)/.test(src), 'axTree Linux=AT-SPI');
  assert.ok(/LX\(\)\.ensureImage/.test(src), 'start 가 Linux 이미지 빌드');
  assert.ok(/await waitLoggedIn\(780000\)/.test(src), 'Linux 는 cloud-init 설치+재부팅 대기');
  assert.ok(/isLinux \? LX\(\)\.SETTLE_CMD : SETTLE_SCRIPT/.test(src), 'settle OS별');
  //  ★ 다른 OS 의 VM 을 죽이지 않는다(동시 실행) — reapForeignVm 제거.
  assert.ok(!/reapForeignVm/.test(src), '다른 OS VM 회수(reapForeignVm) 없음 — 동시 실행');
  //  deviceRow 는 두 OS 를 모두 돌려준다(배열).
  assert.ok(/VMS\.macos\.deviceRow\(\)[\s\S]*VMS\.linux\.deviceRow\(\)/.test(src), 'deviceRow 가 두 OS 모두');
});
