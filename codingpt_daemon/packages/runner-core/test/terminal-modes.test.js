// 스크롤 라우팅 회귀 매트릭스 — "이 화면의 스크롤을 어디로 보낼 것인가"를 서버가 정확히 답하는지.
//
// 왜 이 테스트가 필요한가: 클라이언트가 DECSET 을 엿보며 추측하던 시절엔
//  · tmux 가 `alternate-screen off` + `smcup@` 라 1049 를 아예 안 보낸다 → less/vim 을
//    "일반 셸"로 오판해 휠이 앱에 안 가고 history 오버레이가 떴다.
//  · term.modes 갱신이 한 프레임 늦어 mouse TUI(Codex/Claude)의 첫 휠을 놓쳤다.
// 이제 서버가 VT 실측 + tmux #{alternate_on} 을 합쳐 답한다. 그 계약을 프로그램별로 고정한다.
//
// 실제 codex/claude 바이너리는 쓰지 않는다(설치·인증·속도 의존). 그 둘이 켜는 모드
//  (1049 + 1000/1002/1006)를 printf 로 그대로 재현해 같은 판정 경로를 태운다.
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

const SOCK = `codingpt-modes-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-modes-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
const v2 = require('../terminal-stream-v2');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const WS_REL = 'wsM';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}
const has = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const hasTmux = has('tmux');
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

/** 기대 라우팅이 될 때까지 폴링 — 병렬 테스트 실행에서 셸/앱 기동이 늦어도 흔들리지 않게. */
async function waitRoute(ws, want, timeoutMs = 6000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await askModes(ws);
    if (routeOf(last) === want) return last;
    if (Date.now() - t0 > timeoutMs) return last;
    await sleep(150);
  }
}

/** 실제 와이어로 modes 를 물어보고 METADATA 프레임을 파싱한다(클라이언트와 같은 경로). */
function askModes(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error('modes 응답 없음')); }, timeoutMs);
    function onMsg(d) {
      const f = v2.decode(Buffer.isBuffer(d) ? d : Buffer.from(d));
      if (!f || f.opcode !== v2.OPCODE.METADATA) return;
      let body; try { body = JSON.parse(f.payload.toString('utf8')); } catch (_) { return; }
      if (!body || body.kind !== 'modes') return;
      clearTimeout(t); ws.off('message', onMsg); resolve(body);
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'modes' }));
  });
}

// 라우팅 판정은 클라이언트와 같은 우선순위로 검증한다: mouse > alternate > canonical history.
const routeOf = (m) => (m.mouseTracking ? 'wheel' : m.altScreen ? 'arrows' : 'history');

test('스크롤 라우팅 매트릭스 — 셸/풀스크린 앱/마우스 TUI', { skip: !hasTmux }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  pty.openPtyStream(cfgLike, {
    streamToken: 'md1',
    params: { cwd: WS_REL, paneId: 'pM', client: 'cM', win: t.index, cols: 80, rows: 24, terminalProtocol: 2 },
  });
  const ws = await waitStream('md1');
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await sleep(900);

  // 1) 일반 셸 — 과거로 올라가는 건 canonical history 다.
  let m = await waitRoute(ws, 'history');
  assert.strictEqual(routeOf(m), 'history', `일반 셸 라우팅이 틀렸다: ${JSON.stringify(m)}`);

  // 2) 풀스크린 앱(alternate screen, 마우스 없음) = less/vim 등가.
  //    tmux 는 이 전환을 클라이언트에 안 알리므로 #{alternate_on} 을 못 보면 여기서 'history' 가 나온다.
  ws.send(Buffer.from("printf '\\033[?1049h'\r"));
  m = await waitRoute(ws, 'arrows');
  assert.strictEqual(routeOf(m), 'arrows', `풀스크린 앱(less/vim)에서 방향키 라우팅이 아니다: ${JSON.stringify(m)}`);

  // 3) 마우스 추적 TUI(Codex/Claude 등가) — alternate 이면서 mouse on 이면 휠 리포트가 이긴다.
  ws.send(Buffer.from("printf '\\033[?1000h\\033[?1006h'\r"));
  m = await waitRoute(ws, 'wheel');
  assert.strictEqual(m.mouseTracking, true, `mouse tracking 미감지: ${JSON.stringify(m)}`);
  assert.strictEqual(routeOf(m), 'wheel', `마우스 TUI 에서 휠 라우팅이 아니다: ${JSON.stringify(m)}`);

  // 4) 앱 종료 → 다시 일반 셸.
  ws.send(Buffer.from("printf '\\033[?1000l\\033[?1006l\\033[?1049l'\r"));
  m = await waitRoute(ws, 'history');
  assert.strictEqual(routeOf(m), 'history', `앱 종료 뒤 일반 셸로 안 돌아왔다: ${JSON.stringify(m)}`);

  ws.close();
  await sleep(200);
});

test('실제 less 가 떠 있는 동안은 방향키 라우팅이다', { skip: !hasTmux || !has('less') }, async () => {
  await startRelay();
  const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  pty.openPtyStream(cfgLike, {
    streamToken: 'md2',
    params: { cwd: WS_REL, paneId: 'pL', client: 'cL', win: t.index, cols: 80, rows: 24, terminalProtocol: 2 },
  });
  const ws = await waitStream('md2');
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await sleep(900);

  ws.send(Buffer.from('seq 1 500 | less\r'));
  const inLess = await waitRoute(ws, 'arrows', 8000);
  assert.strictEqual(routeOf(inLess), 'arrows', `less 안에서 라우팅이 틀렸다: ${JSON.stringify(inLess)}`);

  ws.send(Buffer.from('q'));
  const after = await waitRoute(ws, 'history');
  assert.strictEqual(routeOf(after), 'history', `less 종료 뒤 셸로 안 돌아왔다: ${JSON.stringify(after)}`);

  ws.close();
  await sleep(200);
});
