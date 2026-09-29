// 원격 입력 순서 + 유령 스트림 회수 회귀 — CPT3 경로(terminalProtocol:3)로 고정한다.
//
// ★ 2026-09-04 실사고(v2): 컨트롤러 리스가 입력마다 `execFile(tmux …)` 를 스폰해 완료 순서가
//   뒤집혔다(동시 12건 실측 3,2,1,0,5,4,7,6,…) → 빠른 타이핑에서 키가 뒤집혔다. 리스는 v3 에서
//   통째로 사라졌고, 지금 순서를 보장하는 것은 tmux-control 의 `command()` 가 **동기 stdin write**
//   라는 사실 하나다(tmux 가 그 줄들을 순차 처리한다). 그 계약이 깨지면 이 테스트가 먼저 죽는다.
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

const SOCK = `codingpt-order-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;
// 무응답 스트림 회수 상한을 테스트용으로 낮춘다(운영 기본 90초를 그대로 기다릴 수 없다).
process.env.CPT_STREAM_IDLE_MS = '1200';
// 마지막 뷰어가 떠난 뒤 TerminalHost 가 control 클라이언트를 놓는 유예(운영 30초)도 낮춘다.
process.env.CPT_HOST_IDLE_MS = '800';

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-order-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const WS_REL = 'wsO';
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
      wss.handleUpgrade(req, socket, head, (ws) => { streams.set(m[1], ws); });
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

// 한 글자씩 별도 프레임으로 보내는 것이 핵심 — 한 버퍼로 합쳐 보내면 내부 순서가 보존되므로
//  회귀를 못 잡는다. 실제 모바일/컴포저도 키마다 프레임 하나를 보낸다.
test('키를 한 글자씩 연속으로 보내도 PTY 입력 순서가 보존된다', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });

  pty.openPtyStream(cfgLike, { streamToken: 'ord1', params: { cwd: WS_REL, paneId: 'pO', client: 'cO', win: t.index, cols: 80, rows: 24, terminalProtocol: 3 } });
  const ws = await waitStream('ord1');
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await sleep(900); // attach + 셸 프롬프트

  const MARK = '0123456789abcdefghijklmnopqrstuv';
  for (const ch of `echo ${MARK}`) ws.send(Buffer.from(ch));
  ws.send(Buffer.from('\r'));
  await sleep(900);

  const cap = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '-S', '-30']);
  // 명령줄 에코와 실행 결과 두 줄 모두에 원문 그대로 나와야 한다. 한 글자라도 뒤집히면 불일치.
  const hits = cap.split('\n').filter((line) => line.includes(MARK)).length;
  assert.ok(hits >= 2, `입력 순서가 깨졌다 — MARK 온전한 줄 ${hits}개\n${cap}`);

  ws.close();
  await sleep(200);
});

// ★ 2026-09-04 실측: 앱을 강제 종료해도 데몬 쪽 릴레이 소켓이 4분 넘게 살아 있었다. 그동안
//   canonical VT + backend attach 가 붙잡혀 터미널마다 하나씩 샜다(8월엔 13일 묵은 attach 잔존).
//   keepalive 를 보내던 클라이언트가 조용해지면 스트림을 죽은 것으로 보고 정리해야 한다.
test('keepalive 를 보내던 스트림이 조용해지면 정리된다', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  // 이 테스트가 만든 세션에 붙은 attach 만 센다 — 다른 테스트 모델이 유예 중일 수 있다.
  const NAME = pty.termSession(NS, t.index);
  const attaches = async () => (await tmux(['list-clients', '-F', '#{client_session}']))
    .split('\n').filter((l) => l.trim() === NAME).length;

  pty.openPtyStream(cfgLike, { streamToken: 'idle1', params: { cwd: WS_REL, paneId: 'pI', client: 'cI', win: t.index, cols: 80, rows: 24, terminalProtocol: 3 } });
  const ws = await waitStream('idle1');
  const closed = new Promise((resolve) => ws.on('close', () => resolve(true)));
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'keepalive' }));   // 이 클라이언트는 keepalive 를 보내는 종류다
  await sleep(800);
  assert.ok((await attaches()) > 0, 'attach 가 안 생겼다 — 테스트 전제 실패');

  // 이제 조용해진다(뷰어가 죽었지만 릴레이 소켓은 살아 있는 실제 상황).
  const reaped = await Promise.race([closed, sleep(6000).then(() => false)]);
  assert.strictEqual(reaped, true, '무응답 스트림이 정리되지 않았다');
  // 마지막 뷰어가 떠나면 TerminalHost 가 control 클라이언트를 놓는다 — 0 이 될 때까지 폴링한다.
  let after = -1;
  for (let i = 0; i < 60; i++) {
    after = await attaches();
    if (after === 0) break;
    await sleep(150);
  }
  assert.strictEqual(after, 0, `backend attach 가 회수되지 않았다(남은 attach=${after})`);
});

// (삭제) "keepalive 를 안 쓰는 뷰어는 안 끊긴다" — v3 뷰어는 앱·PC 모두 25초 keepalive 를 보낸다
//  (TerminalWebView `__keepalive` · pane.js). 구버전 뷰어용 4배 유예는 v2 경로와 함께 사라졌다.

// ★ 2026-09-04 실측: 폰을 강제 종료해도 백이 데몬에 스트림을 **다시 열어 준다**. 그 스트림은
//   접속 후 resize 조차 보내지 않는 유령이다. keepalive 기준만으로는 절대 안 걷히고,
//   canonical VT + tmux attach 가 터미널마다 영구히 붙잡힌다.
test('접속 후 한 마디도 없는 유령 스트림은 정리된다', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const NAME = pty.termSession(NS, t.index);
  const attaches = async () => (await tmux(['list-clients', '-F', '#{client_session}']))
    .split('\n').filter((l) => l.trim() === NAME).length;

  pty.openPtyStream(cfgLike, { streamToken: 'ghost1', params: { cwd: WS_REL, paneId: 'pG', client: 'cG', win: t.index, cols: 80, rows: 24, terminalProtocol: 3 } });
  const ws = await waitStream('ghost1');
  const closed = new Promise((resolve) => ws.on('close', () => resolve(true)));
  await sleep(800);
  assert.ok((await attaches()) > 0, 'attach 가 안 생겼다 — 테스트 전제 실패');
  // 아무것도 보내지 않는다(유령).
  const reaped = await Promise.race([closed, sleep(6000).then(() => false)]);
  assert.strictEqual(reaped, true, '유령 스트림이 정리되지 않았다');
  let after = -1;
  for (let i = 0; i < 60; i++) { after = await attaches(); if (after === 0) break; await sleep(150); }
  assert.strictEqual(after, 0, `유령의 backend attach 가 남았다(${after})`);
});

// resize 한 번 보내고 keepalive 없이 죽은 뷰어(접속 25초 안에 죽은 폰) — 넉넉한 상한 뒤엔 걷힌다.
test('keepalive 없이 조용해진 뷰어도 결국 정리된다', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const NAME = pty.termSession(NS, t.index);
  const attaches = async () => (await tmux(['list-clients', '-F', '#{client_session}']))
    .split('\n').filter((l) => l.trim() === NAME).length;

  pty.openPtyStream(cfgLike, { streamToken: 'noka1', params: { cwd: WS_REL, paneId: 'pN', client: 'cN', win: t.index, cols: 80, rows: 24, terminalProtocol: 3 } });
  const ws = await waitStream('noka1');
  const closed = new Promise((resolve) => ws.on('close', () => resolve(true)));
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));   // 이 한 마디가 전부다
  await sleep(800);
  assert.ok((await attaches()) > 0, 'attach 가 안 생겼다 — 테스트 전제 실패');
  // 상한은 keepalive 기준의 4배(테스트에선 1200*4=4.8초).
  const reaped = await Promise.race([closed, sleep(9000).then(() => false)]);
  assert.strictEqual(reaped, true, 'keepalive 없는 죽은 뷰어가 영구히 남았다');
  let after = -1;
  for (let i = 0; i < 60; i++) { after = await attaches(); if (after === 0) break; await sleep(150); }
  assert.strictEqual(after, 0, `backend attach 가 남았다(${after})`);
});
