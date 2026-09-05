// v3 스트림 통합 — 릴레이 하네스로 실제 와이어(CPT3)를 태운다. 계약: docs/terminal-v3-design.md §3.
//  스냅샷 → 입력 echo(OUTPUT seq) → 소유자/비소유자 resize → claim → history → hello 이어받기.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const SOCK = `codingpt-v3s-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;
process.env.CPT_STREAM_IDLE_MS = '30000';

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-v3s-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });
const pty = require('../pty');
const v3 = require('../terminal-stream-v3');
const { hostRegistry } = require('../pty-v3');
assert.strictEqual(pty.TMUX_SOCKET, SOCK);

const has = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const hasTmux = has('tmux');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS_REL = 'ws3';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });

let httpServer, wss, port;
const streams = new Map();
function startRelay() {
  if (port) return Promise.resolve();
  return new Promise((resolve) => {
    httpServer = http.createServer();
    wss = new WebSocket.Server({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const m = /\/api\/daemon\/stream\/(.+)$/.exec(req.url || '');
      if (!m) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // ⚠ 리스너는 여기서 즉시 단다 — 데몬은 붙자마자 스냅샷을 보내므로 늦게 달면 첫 프레임을 놓친다.
        const v = { ws, frames: [], out: '' };
        ws.on('message', (d) => {
          const f = v3.decode(Buffer.isBuffer(d) ? d : Buffer.from(d));
          if (!f) return;
          v.frames.push(f);
          if (f.opcode === v3.OPCODE.OUTPUT) v.out += f.payload.toString('utf8');
        });
        streams.set(m[1], v);
      });
    });
    httpServer.listen(0, '127.0.0.1', () => { port = httpServer.address().port; resolve(); });
  });
}
after(async () => {
  try { for (const v of streams.values()) v.ws.close(); } catch (_) { /* noop */ }
  try { hostRegistry({}).closeAll(); } catch (_) { /* noop */ }
  try { wss && wss.close(); httpServer && httpServer.close(); } catch (_) { /* noop */ }
  try { await pty.runTmux(['kill-server']); } catch (_) { /* noop */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

/** 뷰어 하나 열기 — 프레임을 종류별로 모아 주는 헬퍼. */
async function openViewer(token, { client, win, cols = 80, rows = 24, deviceName }) {
  await startRelay();
  pty.openPtyStream({ serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' }, {
    streamToken: token,
    params: { cwd: WS_REL, paneId: 'p-' + client, client, win, cols, rows, terminalProtocol: 3, deviceName },
  });
  const t0 = Date.now();
  let v;
  while (!(v = streams.get(token))) { if (Date.now() - t0 > 8000) throw new Error('스트림 미접속'); await sleep(40); }
  const ws = v.ws;
  v.json = (op) => v.frames.filter((f) => f.opcode === op).map((f) => JSON.parse(f.payload.toString('utf8')));
  v.send = (o) => ws.send(JSON.stringify(o));
  v.until = async (fn, ms = 5000) => { const s = Date.now(); for (;;) { if (fn()) return true; if (Date.now() - s > ms) return false; await sleep(50); } };
  return v;
}

test('CPT3 왕복 — 스냅샷·입력·소유자 크기·claim·history·이어받기', { skip: !hasTmux }, async () => {
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const session = `cpt-${WS_REL}--t-${t.index}`;
  const winSize = async () => String(await pty.runTmux(['display-message', '-p', '-t', `=${session}:0`, '#{window_width}x#{window_height}'])).trim();

  // PC 가 먼저 붙는다 → 첫 resize 로 소유자가 된다.
  const pc = await openViewer('v3-pc', { client: 'pc-1', win: t.index, cols: 179, rows: 45, deviceName: 'MacBook' });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.SNAPSHOT).length > 0), 'PC 가 스냅샷을 못 받았다');
  pc.send({ type: 'resize', cols: 179, rows: 45 });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.OWNER).some((o) => o.self) || pc.json(v3.OPCODE.SNAPSHOT).some((s) => s.self)), 'PC 가 소유자가 되지 않았다');
  assert.ok(await pc.until(async () => true) && (await winSize()) === '179x45', `window 가 PC 크기가 아니다: ${await winSize()}`);

  // 폰이 붙는다 — 스냅샷은 PC 격자(179x45)로 오고, 폰의 resize 는 무시된다.
  const ph = await openViewer('v3-ph', { client: 'phone-1', win: t.index, cols: 48, rows: 21, deviceName: 'Galaxy' });
  assert.ok(await ph.until(() => ph.json(v3.OPCODE.SNAPSHOT).length > 0));
  const snap = ph.json(v3.OPCODE.SNAPSHOT)[0];
  assert.strictEqual(`${snap.cols}x${snap.rows}`, '179x45', '비소유자 스냅샷이 소유자 격자가 아니다');
  assert.strictEqual(snap.owner.deviceId, 'pc-1'); assert.strictEqual(snap.self, false);
  ph.send({ type: 'resize', cols: 48, rows: 21 });
  await sleep(500);
  assert.strictEqual(await winSize(), '179x45', '비소유자 resize 가 window 를 바꿨다');

  // 입력은 양쪽 다 되고, 출력은 양쪽에 같은 seq 로 간다.
  ph.send({ type: 'input', data: Buffer.from('echo FROM-PHONE\r').toString('base64') });
  assert.ok(await pc.until(() => pc.out.includes('FROM-PHONE')), 'PC 가 폰 입력의 출력을 못 봤다');
  assert.ok(await ph.until(() => ph.out.includes('FROM-PHONE')));
  const pcSeqs = pc.frames.filter((f) => f.opcode === v3.OPCODE.OUTPUT).map((f) => f.seq);
  const phSeqs = ph.frames.filter((f) => f.opcode === v3.OPCODE.OUTPUT).map((f) => f.seq);
  assert.ok(pcSeqs.length && phSeqs.some((s) => pcSeqs.includes(s)), 'OUTPUT seq 가 정본 공통이 아니다');

  // 폰이 가져간다 → 이제 폰 크기, PC 는 OWNER(self=false)+RESIZED 를 받는다.
  ph.send({ type: 'claim' });
  assert.ok(await ph.until(() => ph.json(v3.OPCODE.OWNER).some((o) => o.self)), '폰이 소유자가 되지 않았다');
  ph.send({ type: 'resize', cols: 48, rows: 21 });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.RESIZED).some((r) => r.cols === 48 && r.rows === 21) || pc.json(v3.OPCODE.SNAPSHOT).some((s) => s.cols === 48)), 'PC 가 새 격자를 통보받지 못했다');
  assert.ok(await pc.until(async () => true) && (await winSize()) === '48x21', `window 가 폰 크기가 아니다: ${await winSize()}`);
  assert.ok(pc.json(v3.OPCODE.OWNER).some((o) => o.owner && o.owner.deviceId === 'phone-1' && o.self === false));

  // 과거 페이지.
  ph.send({ type: 'input', data: Buffer.from('seq 1 100\r').toString('base64') });
  await ph.until(() => ph.out.includes('100'));
  ph.send({ type: 'history', limit: 30 });
  assert.ok(await ph.until(() => ph.json(v3.OPCODE.HISTORY_PAGE).length > 0), 'history 응답 없음');
  const page = ph.json(v3.OPCODE.HISTORY_PAGE)[0];
  assert.ok(page.total > 40 && page.rows.length === 30 && page.rows.every((r) => typeof r.ansi === 'string'));

  // 이어받기: PC 가 마지막 seq 로 hello → 스냅샷 없이 OUTPUT 이어서.
  const lastSeq = Math.max(...pc.frames.filter((f) => f.opcode === v3.OPCODE.OUTPUT).map((f) => f.seq));
  const snapsBefore = pc.json(v3.OPCODE.SNAPSHOT).length;
  ph.send({ type: 'input', data: Buffer.from('echo AFTER-GAP\r').toString('base64') });
  await pc.until(() => pc.out.includes('AFTER-GAP'));
  pc.send({ type: 'hello', lastSeq });
  await sleep(400);
  assert.strictEqual(pc.json(v3.OPCODE.SNAPSHOT).length, snapsBefore, '링버퍼 안인데 스냅샷을 다시 보냈다');
  const replayed = pc.frames.filter((f) => f.opcode === v3.OPCODE.OUTPUT && f.seq > lastSeq);
  assert.ok(replayed.length >= 2, '이어받기 OUTPUT 이 없다');
  pc.send({ type: 'hello', lastSeq: -1 });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.SNAPSHOT).length > snapsBefore), '링버퍼 밖인데 스냅샷을 안 보냈다');

  // ★ 데몬 재시작 후 옛 뷰어가 큰 seq 로 hello — 정본보다 앞서면 반드시 스냅샷이어야 한다.
  //   안 그러면 뷰어가 옛 화면에 멈춘 채 아무 갱신도 못 받는다(2026-09-06 실기 사고: PC 작업이
  //   폰/패드에 안 보임). 세대(epoch)가 다른 경우도 마찬가지.
  const s2 = pc.json(v3.OPCODE.SNAPSHOT).length;
  pc.send({ type: 'hello', lastSeq: 999999 });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.SNAPSHOT).length > s2), '앞선 seq 인데 스냅샷을 안 보냈다');
  const s3 = pc.json(v3.OPCODE.SNAPSHOT).length;
  const lastSnap = pc.json(v3.OPCODE.SNAPSHOT).slice(-1)[0];
  assert.ok(lastSnap.epoch, '스냅샷에 세대 식별자가 없다');
  pc.send({ type: 'hello', lastSeq: lastSnap.seq, epoch: 'stale-epoch' });
  assert.ok(await pc.until(() => pc.json(v3.OPCODE.SNAPSHOT).length > s3), '다른 세대인데 스냅샷을 안 보냈다');

  pc.ws.close(); ph.ws.close();
  await sleep(200);
});
