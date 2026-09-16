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
