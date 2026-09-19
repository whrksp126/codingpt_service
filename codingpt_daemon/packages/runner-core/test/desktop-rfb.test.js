// desktop-rfb(VNC 최소 클라이언트) 회귀 — 가짜 RFB 서버를 프로세스 안에 세워 핸드셰이크·프레임·입력을 검증한다.
//  실제 Lume VNC 서버 없이도 돌아야 한다(CI). 실기 검증은 desktop.js 로 별도.
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { RfbClient, vncEncrypt, keysymOf } = require('../desktop-rfb');
const desktop = require('../desktop');

/** RFB 3.8 서버 흉내: 인증 None(또는 VNC), 4x3 화면, 갱신 요청마다 파란 raw 사각형 하나. 받은 클라 메시지를 기록한다. */
function fakeServer({ auth = 'none', password = 'pw' } = {}) {
  const got = [];
  const server = net.createServer((sock) => {
    let stage = 'version';
    let buf = Buffer.alloc(0);
    sock.write('RFB 003.008\n');
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'version') {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          sock.write(Buffer.from(auth === 'vnc' ? [1, 2] : [1, 1]));
          stage = 'sec';
        } else if (stage === 'sec') {
          if (buf.length < 1) return;
          const pick = buf[0]; buf = buf.subarray(1);
          if (pick === 2) { sock.write(Buffer.alloc(16, 7)); stage = 'challenge'; }
          else { sock.write(Buffer.from([0, 0, 0, 0])); stage = 'init'; }
        } else if (stage === 'challenge') {
          if (buf.length < 16) return;
          const resp = buf.subarray(0, 16); buf = buf.subarray(16);
          const want = vncEncrypt(Buffer.alloc(16, 7), password);
          if (!resp.equals(want)) { sock.write(Buffer.from([0, 0, 0, 1])); const r = Buffer.from('bad password'); const m = Buffer.alloc(4); m.writeUInt32BE(r.length); sock.write(Buffer.concat([m, r])); sock.end(); return; }
          sock.write(Buffer.from([0, 0, 0, 0])); stage = 'init';
        } else if (stage === 'init') {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const name = Buffer.from('fake-mac');
          const si = Buffer.alloc(24 + name.length);
          si.writeUInt16BE(4, 0); si.writeUInt16BE(3, 2); si[4] = 32; si[5] = 24; si[7] = 1;
          si.writeUInt32BE(name.length, 20); name.copy(si, 24);
          sock.write(si); stage = 'msg';
        } else if (stage === 'msg') {
          if (buf.length < 1) return;
          const t = buf[0];
          const need = { 0: 20, 2: 4, 3: 10, 4: 8, 5: 6, 6: 8 }[t];
          if (need == null) { sock.destroy(); return; }
          if (buf.length < need) return;
          let len = need;
          if (t === 2) { len = 4 + buf.readUInt16BE(2) * 4; if (buf.length < len) return; }
          if (t === 6) { len = 8 + buf.readUInt32BE(4); if (buf.length < len) return; }
          const msg = buf.subarray(0, len); buf = buf.subarray(len);
          got.push(msg);
          if (t === 3) {
            // FramebufferUpdate: 1 rect (1,1)-(2x1) raw, 파랑 [B,G,R,X] = ff 00 00 00
            const head = Buffer.alloc(4 + 12);
            head[0] = 0; head.writeUInt16BE(1, 2);
            head.writeUInt16BE(1, 4); head.writeUInt16BE(1, 6); head.writeUInt16BE(2, 8); head.writeUInt16BE(1, 10); head.writeInt32BE(0, 12);
            sock.write(Buffer.concat([head, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0])]));
          }
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, got })));
}

test('RFB 핸드셰이크(None) → ServerInit 크기, 갱신 요청 → 프레임버퍼에 raw 사각형이 찍힌다', async () => {
  const { server, port, got } = await fakeServer();
  const c = new RfbClient({ port });
  await c.connect();
  assert.strictEqual(c.width, 4); assert.strictEqual(c.height, 3); assert.strictEqual(c.name, 'fake-mac');
  const updated = await c.requestUpdate(false, 2000);
  assert.strictEqual(updated, true);
  // (1,1) 과 (2,1) 이 파랑(B=255), 나머지 0
  const px = (x, y) => c.fb.readUInt32LE((y * 4 + x) * 4);
  assert.strictEqual(px(1, 1) & 0xff, 255); assert.strictEqual(px(2, 1) & 0xff, 255); assert.strictEqual(px(0, 0), 0);
  // BMP 머리: 'BM', 32bpp, top-down(음수 높이)
  //  24bpp·bottom-up(sips 가 받는 형태). 4px 행 = 12B → 4바이트 정렬 12B. (1,1) 파랑은 bottom-up 이라 위에서 두 번째 행.
  const bmp = c.toBmp();
  assert.strictEqual(bmp.buf.subarray(0, 2).toString(), 'BM');
  assert.strictEqual(bmp.buf.readUInt16LE(28), 24); assert.strictEqual(bmp.buf.readInt32LE(22), 3);
  assert.strictEqual(bmp.buf.length, 54 + 12 * 3);
  const rowOf = (y) => 54 + (3 - 1 - y) * 12;
  assert.strictEqual(bmp.buf[rowOf(1) + 1 * 3], 255);   // B 채널
  assert.strictEqual(bmp.buf[rowOf(0) + 1 * 3], 0);
  // 클라가 보낸 것: SetPixelFormat(0) · SetEncodings(2) · FramebufferUpdateRequest(3)
  assert.deepStrictEqual(got.slice(0, 3).map((m) => m[0]), [0, 2, 3]);
  c.close(); server.close();
});

test('VNC 인증 — 비트 반전 DES 응답이 맞으면 통과, 틀리면 서버 사유가 오류로 온다', async () => {
  const ok = await fakeServer({ auth: 'vnc', password: 'lume' });
  const c = new RfbClient({ port: ok.port, password: 'lume' });
  await c.connect();
  assert.strictEqual(c.ready, true);
  c.close(); ok.server.close();
  const bad = await fakeServer({ auth: 'vnc', password: 'lume' });
  const c2 = new RfbClient({ port: bad.port, password: 'wrong' });
  await assert.rejects(c2.connect(), /bad password/);
  bad.server.close();
});

test('포인터·키·조합 — 와이어 인코딩과 keysym 표', async () => {
  const { server, port, got } = await fakeServer();
  const c = new RfbClient({ port });
  await c.connect();
  got.length = 0;
  c.pointer(3, 2, 1);
  await c.chord('cmd+shift+a');
  await new Promise((r) => setTimeout(r, 50));
  const ptr = got.find((m) => m[0] === 5);
  assert.ok(ptr); assert.strictEqual(ptr[1], 1); assert.strictEqual(ptr.readUInt16BE(2), 3); assert.strictEqual(ptr.readUInt16BE(4), 2);
  const keys = got.filter((m) => m[0] === 4).map((m) => [m[1], m.readUInt32BE(4)]);
  // cmd↓ shift↓ a↓ a↑ shift↑ cmd↑ — cmd 는 _VZVNCServer 실측대로 Alt_L(0xffe9)
  assert.deepStrictEqual(keys, [[1, 0xffe9], [1, 0xffe1], [1, 0x61], [0, 0x61], [0, 0xffe1], [0, 0xffe9]]);
  assert.strictEqual(keysymOf('enter'), 0xff0d); assert.strictEqual(keysymOf('Z'), 0x5a); assert.strictEqual(keysymOf('nosuch'), null);
  c.close(); server.close();
});

test('호스트 ↔ 게스트 변환 — localhost 는 NAT 게이트웨이로, 경로는 연결된 폴더 아래만', () => {
  assert.strictEqual(desktop.guestUrl('http://localhost:5173/a?b=1'), 'http://192.168.64.1:5173/a?b=1');
  assert.strictEqual(desktop.guestUrl('https://127.0.0.1/x'), 'https://192.168.64.1/x');
  assert.strictEqual(desktop.guestUrl('http://localhost.example.com/'), 'http://localhost.example.com/');
  assert.strictEqual(desktop.guestUrl('https://github.com/'), 'https://github.com/');
});

// 꺼진 VM 의 프레임/입력은 **즉시** 실패해야 한다 — 예전엔 VNC 접속을 30초 되풀이했고 PC 앱이 그걸 메인 스레드에서
//  기다려 무지개 커서가 돌았다(2026-09-17). 가짜 lume 이 stopped 를 답하게 하고 시간을 잰다.
test('꺼진 에이전트 PC 의 frame/input 은 바로 실패한다', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lume-'));
  const fake = path.join(dir, 'lume');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'[{"name":"cpt-agent-desktop","status":"stopped"}]\'\n', { mode: 0o755 });
  const prev = process.env.CPT_LUME;
  process.env.CPT_LUME = fake;
  desktop._resetTools();
  try {
    const t0 = Date.now();
    await assert.rejects(desktop.frame({ maxWidth: 100 }), /꺼져 있어요/);
    await assert.rejects(desktop.input({ type: 'tap', x: 0.5, y: 0.5 }), /꺼져 있어요/);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms — 되풀이 접속이 살아났다`);
  } finally {
    if (prev === undefined) delete process.env.CPT_LUME; else process.env.CPT_LUME = prev;
    desktop._resetTools();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 공유 폴더는 PC 앱(워크스페이스 id, 홈-상대)과 cpt(절대 경로)가 다른 모양으로 보낸다 — 저장은 절대 경로 한 모양,
//  돌려줄 땐 id 도 같이(sharedIds). 안 맞추면 체크박스가 안 켜지고 disconnect 가 같은 폴더를 못 찾는다(2026-09-17).
test('공유 폴더 경로는 절대 경로로 맞추고 id 도 돌려준다', () => {
  const os = require('os'), path = require('path');
  const home = os.homedir();
  assert.strictEqual(desktop.absDir('other/project/x'), path.join(home, 'other/project/x'));
  assert.strictEqual(desktop.absDir(path.join(home, 'other/project/x')), path.join(home, 'other/project/x'));
  assert.deepStrictEqual(desktop.normalizeDirs(['other/project/x', path.join(home, 'other/project/x'), '']), [path.join(home, 'other/project/x')]);
  assert.strictEqual(desktop.dirId(path.join(home, 'other/project/x')), 'other/project/x');
  assert.strictEqual(desktop.dirId('/opt/elsewhere'), '/opt/elsewhere');
});

// 첫 부팅 프로비저닝(2026-09-19) — 실측으로 굳은 계약 셋: ① `sysadminctl -autologin set` 은 이 이미지에서 error:22 →
//  /etc/kcpassword 를 직접 쓴다(11바이트 키 XOR·12 배수 0 패딩) ② ssh 에 tty 가 없어 sudo 가 stdin 으로 비밀번호를 받는다
//  → sudo 뒤에 파이프로 파일을 먹이면 0바이트(실사고) — 파일 쓰기는 `sudo sh -c` 안에서 ③ 성공 표식이 있어야 provisioned.
test('프로비저닝 스크립트 계약(kcpassword·sudo sh -c·성공 표식)', () => {
  const sc = desktop.PROVISION_SCRIPT;
  assert.ok(!/sysadminctl -autologin set/.test(sc), 'sysadminctl -autologin set 은 error:22 — 쓰지 않는다');
  assert.ok(/sudo sh -c 'echo "[A-Za-z0-9+/=]+" \| base64 -d > \/etc\/kcpassword/.test(sc), 'kcpassword 는 sudo sh -c 안에서 쓴다');
  assert.ok(!/\| sudo tee/.test(sc), 'sudo 뒤 파이프 금지(stdin 은 비밀번호가 차지)');
  assert.ok(/autoLoginUser -string lume/.test(sc) && /CPT_PROVISION_OK/.test(sc));
  //  kcpassword("lume") 실측 값 — 이 바이트로 자동 로그인이 실제로 됐다(2026-09-19, macOS 26.4 게스트).
  const m = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > \/etc\/kcpassword/.exec(sc);
  assert.strictEqual(m[1], 'Efw/RtKz3b9f5RJ9');
  assert.strictEqual(Buffer.from(m[1], 'base64').length, 12);
});

//  ByHost(하드웨어 UUID) 에 묶인 설정은 VM 식별자가 바뀌면 사라진다(복원된 VM 이 20분 뒤 잠금 화면으로 떨어진 실사고,
//  2026-09-20) → 켤 때마다 다시 건다. 성공 표식은 **실제 상태를 읽어서** 낸다(썼다고 믿지 않는다).
test('켤 때마다 다시 거는 설정(settle) — 화면보호기 0·잠금 해제, 상태 확인 뒤 표식', () => {
  const fs = require('fs'), path = require('path');
  const sc = desktop.SETTLE_SCRIPT;
  assert.ok(/defaults -currentHost write com\.apple\.screensaver idleTime -int 0/.test(sc));
  assert.ok(/sysadminctl -screenLock off -password/.test(sc));
  assert.ok(/screenLock is off.*idleTime.*= 0.*CPT_SETTLE_OK/s.test(sc), '표식은 상태 확인 뒤에만');
  assert.ok(!/\bsudo\b/.test(sc), '사용자 도메인 설정만 — sudo 불필요');
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8');
  assert.ok(/await connectRfb\(\{ waitMs: 30000 \}\);\s*\n[^\n]*\n\s*void settle\(\);/.test(src), 'start() 는 화면이 붙은 뒤 settle 을 뒤에서 돈다');
});

// 폴더 연결은 에이전트가 필요할 때 스스로(사용자 결정 2026-09-19: 자동 연결 없음·경로 제한 없음). 꺼져 있을 때는
//  설정만 바꾸고 재시작하지 않는다; 없는 폴더는 거절; 같은 상태면 changed:false.
test('desktop.connect/disconnect 는 설정을 절대 경로로 바꾸고 게스트 경로를 돌려준다', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lume-'));
  const fake = path.join(dir, 'lume');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'[{"name":"cpt-agent-desktop","status":"stopped"}]\'\n', { mode: 0o755 });
  const prevLume = process.env.CPT_LUME; process.env.CPT_LUME = fake; desktop._resetTools();
  const prevHome = process.env.CPT_HOME;
  const before = desktop.loadSettings();
  try {
    const r = await desktop.handle('desktop.connect', { dir });
    assert.deepStrictEqual([r.changed, r.restarted, r.host, r.guest], [true, false, dir, `/Volumes/My Shared Files/${path.basename(dir)}`]);
    assert.ok(desktop.loadSettings().sharedDirs.includes(dir));
    const again = await desktop.handle('desktop.connect', { dir });
    assert.strictEqual(again.changed, false);
    await assert.rejects(desktop.handle('desktop.connect', { dir: path.join(dir, 'nope') }), /폴더가 없어요/);
    const off = await desktop.handle('desktop.disconnect', { dir });
    assert.deepStrictEqual([off.changed, off.guest], [true, null]);
    assert.ok(!desktop.loadSettings().sharedDirs.includes(dir));
  } finally {
    desktop.saveSettings(before);
    if (prevLume === undefined) delete process.env.CPT_LUME; else process.env.CPT_LUME = prevLume;
    desktop._resetTools(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 접근성 트리(2026-09-19) — JXA 는 runner-core 에 파일로 동봉되고 해시 이름으로 게스트에 한 번 들어간다. axFind 는
//  정확 일치 > 포함, 조작 가능한 role 우선, 같은 점수면 작은 요소(글자 하나를 감싼 큰 Group 보다 버튼 자체).
test('AX 트리 스크립트 동봉 + axFind 우선순위', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop-ax.jxa.js'), 'utf8');
  assert.ok(/bindFunction\('AXUIElementCopyAttributeValue', \['int', \['void\*', 'id', 'void\*\*'\]\]\)/.test(src), 'void*/void** 바인딩(기본 바인딩은 -25201·Ref 타입 충돌)');
  assert.ok(/CFCopyDescription/.test(src), '좌표는 AXValue 설명 문자열에서');
  const tree = { app: 'X', nodes: [
    { i: 0, role: 'Group', title: 'Save', x: 0, y: 0, w: 1, h: 1 },
    { i: 1, role: 'Button', title: 'Save', x: 0.1, y: 0.1, w: 0.1, h: 0.05 },
    { i: 2, role: 'Button', title: 'Save As…', x: 0.3, y: 0.1, w: 0.1, h: 0.05 },
    { i: 3, role: 'Button', title: 'Save', x: 0.5, y: 0.1, w: 0.1, h: 0.05, disabled: true },
    { i: 4, role: 'StaticText', value: 'Autosave on', x: 0.7, y: 0.1, w: 0.1, h: 0.05 },
  ] };
  assert.strictEqual(desktop.axFind(tree, 'save').i, 1, '정확 일치 + 조작 가능 + 작은 요소');
  assert.strictEqual(desktop.axFind(tree, 'save as').i, 2, '포함 일치');
  assert.strictEqual(desktop.axFind(tree, 'autosave').i, 4, 'value 도 본다');
  assert.strictEqual(desktop.axFind(tree, 'save', { role: 'Group' }).i, 0, 'role 지정');
  assert.strictEqual(desktop.axFind(tree, 'nothing'), null);
});

// 스냅샷(2026-09-19) — 이름 규칙(접두사·시각·라벨 정리)과 VNC 비밀번호 강도(DES 는 앞 8자만: 대소문자+숫자, '-' 로 시작 금지).
test('스냅샷 이름 규칙 + VNC 비밀번호는 영숫자 12자', () => {
  const n = desktop.snapName('Before Test!! 한글');
  assert.ok(n.startsWith(desktop.SNAP_PREFIX), n);
  assert.match(n.slice(desktop.SNAP_PREFIX.length), /^\d{8}-\d{6}-before-test-한글$/);
  assert.match(desktop.snapName(''), new RegExp('^' + desktop.SNAP_PREFIX.replace(/[-]/g, '\\-') + '\\d{8}-\\d{6}$'));
  for (let i = 0; i < 50; i++) { const p = desktop.strongVncPassword(); assert.match(p, /^[A-Za-z][A-Za-z0-9]{11}$/, p); }
});

// 유휴 자동 끄기(2026-09-19) — 폴링(status/snapshots/settings.get)은 사용으로 치지 않고, 나머지 RPC·프레임·입력·exec·영상은 친다.
test('유휴 판정: 폴링은 사용이 아니다, 조작은 사용이다', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lume-'));
  fs.writeFileSync(path.join(dir, 'lume'), '#!/bin/sh\necho \'[{"name":"cpt-agent-desktop","status":"stopped"}]\'\n', { mode: 0o755 });
  const prev = process.env.CPT_LUME; process.env.CPT_LUME = path.join(dir, 'lume'); desktop._resetTools();
  try {
    const before = desktop._idleState().lastUse;
    await new Promise((r) => setTimeout(r, 15));
    await desktop.handle('desktop.status', {});
    assert.strictEqual(desktop._idleState().lastUse, before, 'status 폴링은 lastUse 를 안 건드린다');
    await desktop.handle('desktop.settings.get', {});
    assert.strictEqual(desktop._idleState().lastUse, before);
    await desktop.handle('desktop.pause', {});
    assert.ok(desktop._idleState().lastUse > before, '조작 RPC 는 사용이다');
    assert.strictEqual(desktop.loadSettings().idleOffMin === undefined, false, '기본 idleOffMin 이 있다');
    assert.strictEqual(desktop.IDLE_OFF_DEFAULT_MIN, 60);
  } finally {
    await desktop.handle('desktop.resume', {}).catch(() => {});
    if (prev === undefined) delete process.env.CPT_LUME; else process.env.CPT_LUME = prev; desktop._resetTools(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-09-20 폰 실기에서 잡은 셋: ① 입력은 한 줄로(글자마다 오는 RPC 가 겹치면 키가 빠짐) ② clone 뒤 머신 식별자 되살리기
//  ③ AX 뿌리는 AXWindows+AXMenuBar(26.4 의 AXChildren[0] 은 AXApplication 대리) · 앞 앱은 menuBarOwningApplication.
test('desktop.input 은 직렬(순서 보존) · carryIdentity · AX 뿌리 규칙', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lume-'));
  fs.writeFileSync(path.join(dir, 'lume'), '#!/bin/sh\necho \'[{"name":"cpt-agent-desktop","status":"stopped"}]\'\n', { mode: 0o755 });
  const prev = process.env.CPT_LUME; process.env.CPT_LUME = path.join(dir, 'lume'); desktop._resetTools();
  try {
    //  꺼진 VM 이라 전부 거절되지만, 거절 순서가 보낸 순서와 같아야 한다(큐).
    const order = [];
    await Promise.all(['a', 'b', 'c'].map((t) => desktop.input({ type: 'text', text: t }).catch(() => order.push(t))));
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  } finally { if (prev === undefined) delete process.env.CPT_LUME; else process.env.CPT_LUME = prev; desktop._resetTools(); fs.rmSync(dir, { recursive: true, force: true }); }
  //  carryIdentity — 가짜 ~/.lume 두 VM
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-home-'));
  const realHome = os.homedir; os.homedir = () => home;
  try {
    fs.mkdirSync(path.join(home, '.lume', 'a'), { recursive: true }); fs.mkdirSync(path.join(home, '.lume', 'b'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lume', 'a', 'config.json'), JSON.stringify({ machineIdentifier: 'ID-A', macAddress: 'aa:aa', cpuCount: 8 }));
    fs.writeFileSync(path.join(home, '.lume', 'b', 'config.json'), JSON.stringify({ machineIdentifier: 'ID-B', macAddress: 'bb:bb', cpuCount: 4 }));
    assert.strictEqual(desktop.carryIdentity('a', 'b'), true);
    const b = JSON.parse(fs.readFileSync(path.join(home, '.lume', 'b', 'config.json'), 'utf8'));
    assert.deepStrictEqual([b.machineIdentifier, b.macAddress, b.cpuCount], ['ID-A', 'aa:aa', 4], '식별자·MAC 만 옮기고 자원은 그대로');
  } finally { os.homedir = realHome; fs.rmSync(home, { recursive: true, force: true }); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop-ax.jxa.js'), 'utf8');
  assert.ok(/attr\(appEl, 'AXWindows'\)/.test(src) && /attr\(appEl, 'AXMenuBar'\)/.test(src), 'AX 뿌리는 AXWindows+AXMenuBar');
  assert.ok(/depth > 0 && role === 'AXApplication'\) return/.test(src), 'Application 대리 요소는 안 탄다(Setup Assistant 무한 재귀)');
  assert.ok(/menuBarOwningApplication/.test(src), '앞 앱 = 메뉴 바를 쥔 앱');
});

//  VideoToolbox 는 SPS 에 VUI 를 안 쓴다 → 하드웨어 디코더가 프레임을 4~6장 쥐고 내놓아 정지 화면 변화가 폰에 4~5초
//  뒤에 보였다(2026-09-20 실측). config 패킷의 SPS 에 bitstream_restriction(재정렬 0) 을 덧붙인다.
test('H.264 SPS 에 VUI bitstream_restriction 을 붙인다(실측 SPS 바이트 · 멱등 · 모르는 건 안 만짐)', () => {
  const fs = require('fs'), path = require('path');
  const { patchConfigPacket, addBitstreamRestriction, unescapeRbsp, escapeRbsp } = require('../h264-sps');
  const cfg = Buffer.from('0000000127420028ab402d039fce800000000128ce3c80', 'hex');      // vt-h264 실측(1440×900 Baseline 4.0)
  const out = patchConfigPacket(cfg);
  assert.strictEqual(out.toString('hex'), '0000000127420028ab402d039fcf00f08846a00000000128ce3c80');   // ffmpeg trace_headers 로 확인한 값
  assert.ok(patchConfigPacket(out).equals(out), '이미 VUI 가 있으면 그대로');
  assert.ok(addBitstreamRestriction(Buffer.from([0x28, 0xce, 0x3c, 0x80])).equals(Buffer.from([0x28, 0xce, 0x3c, 0x80])), 'PPS 는 안 만진다');
  assert.ok(addBitstreamRestriction(Buffer.from([0x27, 0x42])).length === 2, '짧은/깨진 SPS 는 원본');
  const e = escapeRbsp(Buffer.from([0, 0, 1, 0, 0, 0, 0, 0, 3]));
  assert.deepStrictEqual([...e], [0, 0, 3, 1, 0, 0, 3, 0, 0, 3, 0, 3]);
  assert.deepStrictEqual([...unescapeRbsp(e)], [0, 0, 1, 0, 0, 0, 0, 0, 3]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop.js'), 'utf8');
  assert.ok(/patchConfigPacket\(data\)/.test(src), 'DesktopStreamSession 이 config 패킷마다 적용');
});
