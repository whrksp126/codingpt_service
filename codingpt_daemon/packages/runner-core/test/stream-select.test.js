// 모바일 스트림 경로 통합 테스트 — openPtyStream(dial-back WS + node-pty attach) + terminal.select(스왑).
//   실행: node --test packages/runner-core/test/stream-select.test.js
//
// 검증하는 것(전용 세션 모델의 모바일 경로):
//  1. stream_open(params.win=tid) → 데몬이 전용 세션에 직접 attach, 출력이 WS 로 흐른다.
//  2. WS 입력(binary) → 셸 실행 → tmux 세션에 반영.
//  3. terminal.select(다른 tid) → "살아있는 스트림"의 attach 대상이 즉석 교체(swap)되고,
//     이후 입력은 새 터미널로 들어간다(WS 는 끊기지 않는다).
//  4. 스테일 win 으로 stream_open → 첫 터미널 폴백(에러/무한루프 없음).
//
// 안전: CODINGPT_TMUX_SOCKET 격리 소켓 강제 — 실사용 -L codingpt 무접촉.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const WebSocket = require('ws');

const SOCK = `codingpt-sel-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-sel-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const WS_REL = 'wsS';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });
const { session: NS } = pty.sessionForCwd(WS_REL);

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}
const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 back 릴레이: /api/daemon/stream/<token> 업그레이드만 받는 WS 서버 ──
let httpServer, wss, port;
const streams = new Map(); // token -> ws(서버측)

function startRelay() {
  return new Promise((resolve) => {
    httpServer = http.createServer();
    wss = new WebSocket.Server({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const m = /\/api\/daemon\/stream\/(.+)$/.exec(req.url || '');
      if (!m) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => { streams.set(m[1], ws); ws.emit('registered'); });
    });
    httpServer.listen(0, '127.0.0.1', () => { port = httpServer.address().port; resolve(); });
  });
}
function waitStream(token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const ws = streams.get(token);
      if (ws) return resolve(ws);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('스트림 미접속'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

after(async () => {
  try { for (const ws of streams.values()) ws.close(); } catch (_) { /* noop */ }
  try { wss && wss.close(); } catch (_) { /* noop */ }
  try { httpServer && httpServer.close(); } catch (_) { /* noop */ }
  try { await tmux(['kill-server']); } catch (_) { /* 이미 없음 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

test('스트림 attach → 입력/출력 → select 스왑 → 스테일 win 폴백', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };

  const a = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const b = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });

  // 1) stream_open — 터미널 A 에 attach.
  pty.openPtyStream(cfgLike, { streamToken: 'tok1', params: { cwd: WS_REL, paneId: 'pS', client: 'cS', win: a.index, cols: 80, rows: 24 } });
  const ws = await waitStream('tok1');
  let rx = '';
  ws.on('message', (d) => { rx += d.toString(); });
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await sleep(700); // attach + 셸 프롬프트
  assert.ok(rx.length > 0, 'attach 출력이 WS 로 흐르지 않는다');

  // 2) 입력 → 터미널 A 에서 실행.
  ws.send(Buffer.from('echo IN-A\r'));
  await sleep(600);
  const capA = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '-S', '-30']);
  assert.ok(/IN-A/.test(capA), 'WS 입력이 터미널 A 에 안 들어갔다');

  // 3) select → 같은 스트림이 터미널 B 로 스왑(WS 유지).
  const sel = await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: b.index, paneId: 'pS', client: 'cS' });
  assert.strictEqual(sel.index, b.index);
  await sleep(700); // 새 attach 리페인트
  assert.strictEqual(ws.readyState, WebSocket.OPEN, 'select 스왑이 WS 를 끊었다');
  ws.send(Buffer.from('echo IN-B\r'));
  await sleep(600);
  const capB = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, b.index)}:0`, '-S', '-30']);
  assert.ok(/IN-B/.test(capB), 'select 스왑 후 입력이 터미널 B 로 가지 않는다');
  const capA2 = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '-S', '-30']);
  assert.ok(!/IN-B/.test(capA2), 'select 스왑 후에도 입력이 옛 터미널 A 로 샌다');

  // 4) 재접속이 스테일 win(닫힌/구버전 인덱스)을 들고 와도 폴백 attach(무한루프 없음).
  //    또한 select 를 기억(paneCurrent)해 그 pane 은 B 를 다시 본다.
  ws.close();
  await sleep(300);
  pty.openPtyStream(cfgLike, { streamToken: 'tok2', params: { cwd: WS_REL, paneId: 'pS', client: 'cS', win: 3, cols: 80, rows: 24 } });
  const ws2 = await waitStream('tok2');
  ws2.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await sleep(700);
  ws2.send(Buffer.from('echo IN-B2\r'));
  await sleep(600);
  const capB2 = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, b.index)}:0`, '-S', '-30']);
  assert.ok(/IN-B2/.test(capB2), '재접속(스테일 win)이 select 기억(B)으로 이어지지 않는다');
  ws2.close();
  await sleep(200);

  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: a.index });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: b.index });
});
