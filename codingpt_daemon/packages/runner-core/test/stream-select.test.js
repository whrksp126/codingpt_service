// 모바일 스트림 경로 통합 테스트 — openPtyStream(dial-back WS + node-pty attach) + terminal.select(스왑).
//   실행: node --test packages/runner-core/test/stream-select.test.js
//
// 검증하는 것(전용 세션 모델의 모바일 경로):
//  1. stream_open(params.win=tid) → 데몬이 전용 세션에 직접 attach, 출력이 WS 로 흐른다.
//  2. WS 입력(binary) → 셸 실행 → tmux 세션에 반영.
//  3. terminal.select(다른 tid) → "살아있는 스트림"의 attach 대상이 즉석 교체(swap)되고,
//     이후 입력은 새 터미널로 들어간다(WS 는 끊기지 않는다).
//  4. 스테일 win 으로 stream_open → 첫 터미널 폴백(에러/무한루프 없음).
//  5. E2EE 봉인 모드(CPT_E2EE_SCOPE=all): 같은 계약이 프레임 봉투 안에서 그대로 성립하고,
//     평문 프레임 인젝션은 폐기되며, 와이어에 평문 카나리가 0건임(§8.2 카나리 시험의 축소판).
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
const e2eeGate = require('../e2ee-gate');
const e2ee = require('../e2ee'); // 암호 코어(격리 stateDir 에 e2ee.json 을 만든다 — 실사용 홈 무접촉)
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

// 격리 stateDir 에 신원키 + 계정 MK(epoch 2)를 세팅. deviceId 12 = beginHost 의 자기 신원 검증 기준.
function armKeys() {
  e2ee.ensureIdentity({ deviceId: 12 });
  e2ee.setMasterKey(2, Buffer.alloc(32, 0xa7));
}

// ── 가짜 back 릴레이: /api/daemon/stream/<token> 업그레이드만 받는 WS 서버 ──
let httpServer, wss, port;
const streams = new Map(); // token -> ws(서버측)
const closeCodes = new Map(); // token -> 종료 코드(데몬이 닫은 이유)

function startRelay() {
  if (port) return Promise.resolve(); // 멱등 — 여러 테스트가 같은 릴레이를 공유
  return new Promise((resolve) => {
    httpServer = http.createServer();
    wss = new WebSocket.Server({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const m = /\/api\/daemon\/stream\/(.+)$/.exec(req.url || '');
      if (!m) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        streams.set(m[1], ws);
        // close 코드는 등록 시점에 잡아둔다 — 데몬이 open 직후 닫는 경로(E2EE 세션 부재)는
        //  테스트가 리스너를 붙이기 전에 이미 끝나 있다.
        ws.on('close', (code) => closeCodes.set(m[1], code));
        ws.emit('registered');
      });
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

  // keepalive 는 resize 재주장이나 셸 입력으로 흘러가면 안 된다. 특히 여러 기기가 각자 크기를
  // 주기적으로 재주장하면 window-size latest 가 왕복하며 가짜 scrollback 을 만든다.
  const beforeKeepalive = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '#{window_width}x#{window_height}']);
  ws.send(JSON.stringify({ type: 'keepalive' }));
  await sleep(100);
  const afterKeepalive = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '#{window_width}x#{window_height}']);
  assert.strictEqual(afterKeepalive, beforeKeepalive, 'keepalive 가 터미널 크기를 변경했다');

  // 2) 입력 → 터미널 A 에서 실행.
  ws.send(Buffer.from('echo IN-A\r'));
  await sleep(600);
  const capA = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '-S', '-30']);
  assert.ok(/IN-A/.test(capA), 'WS 입력이 터미널 A 에 안 들어갔다');

  // 같은 크기로 다시 포커스(claim)하면 스트림/PTY를 분리하지 않고 snapshot도 재주입하지 않는다.
  rx = '';
  await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: a.index, paneId: 'pS', client: 'cS', claim: true });
  await sleep(250);
  assert.ok(!rx.includes('\x1b[3J\x1b[H\x1b[2J'), '포커스 claim이 정본 스냅샷을 다시 주입했다');

  // 다른 기기 크기에서 돌아오면 tmux 정본 커서와 로컬 xterm 행 배치가 달라지므로 이때만
  // clear+snapshot으로 한 번 맞춘다. Android에서 명령줄이 화면 중간에 남는 회귀 방지.
  await tmux(['resize-window', '-t', `=${pty.termSession(NS, a.index)}:0`, '-x', '100', '-y', '30']);
  rx = '';
  await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: a.index, paneId: 'pS', client: 'cS', claim: true });
  await sleep(250);
  assert.ok(rx.includes('\x1b[3J\x1b[H\x1b[2J'), '크기 소유권 전환 뒤 로컬 화면 정본 동기화가 없다');
  const reclaimed = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '#{window_width}x#{window_height}']);
  assert.strictEqual(reclaimed.trim(), '80x24', 'claim이 이 뷰어 크기로 공유 pane을 되찾지 못했다');

  // 셸 clear가 내는 CSI 3 J는 각 xterm 화면뿐 아니라 공유 tmux 정본 history도 비운다.
  // 그렇지 않으면 지금은 지워져 보여도 모바일 재연결/bootstrap 뒤 과거 명령이 되살아난다.
  ws.send(Buffer.from("printf '\\033[3J'\r"));
  await sleep(350);
  const historyAfterClear = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '#{history_size}']);
  assert.strictEqual(historyAfterClear.trim(), '0', 'CSI 3 J 뒤에도 공유 tmux history가 남았다');

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

// ── E2EE 봉인 모드(D단계) ────────────────────────────────────────────────
// 검증하는 불변식:
//  · 협상은 스트림 **밖**(제어채널 e2ee.begin)에서 끝나고, 스트림 첫 프레임부터 봉인된다.
//  · kind=ctrl 프레임의 payload 는 기존 resize JSON **원문**. 모바일 tmux 클라이언트의 뷰 크기는
//    반영하지만 ignore-size라 공유 pane 정본 크기는 흔들지 않는다.
//  · kind=data 프레임 = stdin, 출력은 봉인된 바이너리로만 나간다(평문 카나리 0건).
//  · 봉인 모드에 도착한 평문 프레임(텍스트/바이너리)은 전부 폐기 = 셸 오염 0(함정 #1 의 거울상).
test('E2EE 봉인 모드: 와이어 계약 보존(ctrl=resize / data=stdin) + 평문 인젝션 폐기 + 카나리 0건', { skip: !hasTmux }, async () => {
  const prevScope = process.env.CPT_E2EE_SCOPE;
  process.env.CPT_E2EE_SCOPE = 'all'; // D단계 승격(기본 rpc 에서는 스트림 협상 자체가 거절된다)
  try {
    await startRelay();
    const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
    armKeys();
    assert.ok(e2eeGate.caps().includes('e2ee.keys.v1'), 'caps 에 e2ee.keys.v1 이 없다');
    assert.ok(e2eeGate.caps().includes('e2ee.stream.v1'), 'scope=all 인데 stream 능력 미선언');
    assert.strictEqual(e2eeGate.epoch(), 2);

    const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
    const routing = { cwd: WS_REL, paneId: 'pE', win: t.index };

    // ① 제어채널 선협상 — 스트림 WS 가 열리기 전에 세션키 확정(인스트림 핸드셰이크 금지 규율).
    const { offer, pending } = e2ee.createViewerOffer({ purpose: 'pty', epoch: 2, client: 'cE', routing, hostDeviceId: 12 });
    const answer = e2ee.beginHost({
      purpose: 'pty', suite: offer.suite, epoch: 2,
      pub: offer.pub, nonce: offer.nonce, client: 'cE', routing, hostDeviceId: 12,
    });
    const vsess = e2ee.acceptHostAnswer(pending, answer); // confirm/sid 대조 포함 — 어긋나면 throw
    const vs = e2ee.channel(vsess.sidB64, null, 'viewer'); // 뷰어가 connId 를 정한다(호스트는 학습)
    assert.strictEqual(vsess.sidB64, answer.sid);

    // ② 스트림 — params.sid 가 봉인 모드 스위치.
    pty.openPtyStream(cfgLike, {
      streamToken: 'tokE',
      params: { cwd: WS_REL, paneId: 'pE', client: 'cE', win: t.index, cols: 80, rows: 24, sid: answer.sid },
    });
    const ws = await waitStream('tokE');
    const rawFrames = [];
    const plain = [];
    const errs = [];
    ws.on('message', (d, isBinary) => {
      rawFrames.push({ buf: Buffer.from(d), isBinary });
      try { plain.push(vs.open(d).payload); } catch (e) { errs.push(e.message); }
    });

    const paneBefore = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '#{window_width}x#{window_height}']);
    // ctrl 프레임(=옛 텍스트 JSON) — attach client는 크기 경쟁에서 제외되지만,
    // 현재 입력 주체의 명시적 resize-window는 공유 pane을 실제 화면 크기로 맞춘다.
    ws.send(vs.sealCtrl({ type: 'resize', cols: 100, rows: 30 }), { binary: true });
    await sleep(1000); // attach + 첫 resize nudge(600ms) 안정화
    let clients = await tmux(['list-clients', '-t', `=${pty.termSession(NS, t.index)}`, '-F', '#{client_width}x#{client_height}']);
    assert.ok(/(^|\s)100x30(\s|$)/.test(clients.trim()), `뷰어 PTY가 실제 크기를 반영하지 않았다: ${clients.trim()}`);
    const paneAfter = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '#{window_width}x#{window_height}']);
    assert.strictEqual(paneAfter.trim(), '100x30', 'shared pane did not follow the mobile viewport');
    const activeFlags = await tmux(['list-clients', '-t', `=${pty.termSession(NS, t.index)}`, '-F', '#{client_flags}']);
    assert.match(activeFlags, /ignore-size/, '모바일 attach client가 자동 pane 크기 경쟁에 참여한다');

    // alternate-screen TUI에 진입하면 마지막 요청 크기를 실제 PTY에 적용한다.
    ws.send(vs.seal(Buffer.from('tput smcup\r')), { binary: true });
    await sleep(250);
    ws.send(vs.sealCtrl({ type: 'resize', cols: 100, rows: 30 }), { binary: true });
    await sleep(700);
    clients = await tmux(['list-clients', '-t', `=${pty.termSession(NS, t.index)}`, '-F', '#{client_width}x#{client_height}']);
    assert.ok(/(^|\s)100x30(\s|$)/.test(clients.trim()), `TUI ctrl(resize)가 반영되지 않았다: ${clients.trim()}`);
    ws.send(vs.seal(Buffer.from('tput rmcup\r')), { binary: true });
    await sleep(250);

    // data 프레임(=옛 바이너리) — stdin.
    const CANARY = `CPT_CANARY_${Math.random().toString(36).slice(2, 8)}`;
    ws.send(vs.seal(Buffer.from(`echo ${CANARY}\r`)), { binary: true });
    await sleep(800);

    const cap = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '-S', '-30']);
    assert.ok(cap.includes(CANARY), '봉인 data 프레임이 stdin 으로 들어가지 않았다');

    // 출력: 전부 바이너리 봉인 프레임 + 복호 성공 + 와이어에 평문 0건.
    assert.ok(rawFrames.length > 0, '봉인 모드에서 출력이 오지 않았다');
    assert.ok(rawFrames.every((f) => f.isBinary), '봉인 모드 출력에 텍스트 프레임이 섞였다');
    assert.deepStrictEqual(errs, [], `출력 프레임 복호 실패: ${errs.join(' / ')}`);
    const wire = Buffer.concat(rawFrames.map((f) => f.buf)).toString('latin1');
    assert.ok(!wire.includes(CANARY), '봉인 모드인데 와이어(서버가 보는 바이트)에 평문 카나리가 있다');
    assert.ok(Buffer.concat(plain).toString('utf8').includes(CANARY), '복호된 출력에 셸 에코가 없다');

    // ③ 평문 프레임 인젝션 — 텍스트/바이너리 모두 폐기돼야 한다(셸 오염 0, 크기 변조 0).
    ws.send(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    ws.send(Buffer.from('echo INJECTED_PLAINTEXT\r'));
    await sleep(800);
    const cap2 = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '-S', '-30']);
    assert.ok(!/INJECTED_PLAINTEXT/.test(cap2), '봉인 모드에서 평문 프레임이 셸에 주입됐다');
    const clients2 = await tmux(['list-clients', '-t', `=${pty.termSession(NS, t.index)}`, '-F', '#{client_width}x#{client_height}']);
    assert.ok(!/(^|\s)1x1(\s|$)/.test(clients2.trim()), '평문 resize 프레임이 크기를 바꿔버렸다');

    // ④ 리플레이(같은 프레임 재전송) — 카운터 역행이라 폐기(소켓은 유지).
    const dup = vs.seal(Buffer.from('echo REPLAY_ME\r'));
    ws.send(dup, { binary: true });
    await sleep(500);
    ws.send(dup, { binary: true }); // 같은 카운터 재사용
    await sleep(500);
    const cap3 = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '-S', '-40']);
    assert.strictEqual((cap3.match(/REPLAY_ME/g) || []).length >= 1, true, '정상 프레임이 처리되지 않았다');
    assert.strictEqual(ws.readyState, WebSocket.OPEN, '프레임 폐기가 소켓을 죽였다(백오프 오염 위험)');

    ws.close();
    await sleep(200);
    await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t.index });
  } finally {
    if (prevScope === undefined) delete process.env.CPT_E2EE_SCOPE; else process.env.CPT_E2EE_SCOPE = prevScope;
  }
});

// 세션 미등록(데몬 재기동으로 sid 전멸) — 평문으로 몰래 내려가지 않고 소켓을 닫아 재협상을 유도한다.
test('E2EE: sid 는 있는데 세션이 없으면 평문 폴백이 아니라 스트림 종료(재협상 유도)', { skip: !hasTmux }, async () => {
  const prevScope = process.env.CPT_E2EE_SCOPE;
  process.env.CPT_E2EE_SCOPE = 'all';
  try {
    await startRelay();
    const cfgLike = { serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' };
    armKeys();
    const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
    pty.openPtyStream(cfgLike, {
      streamToken: 'tokGhost',
      params: { cwd: WS_REL, paneId: 'pG', client: 'cG', win: t.index, cols: 80, rows: 24, sid: 'nonexistent-sid' },
    });
    await waitStream('tokGhost');
    let code = null;
    for (let i = 0; i < 60 && code == null; i++) { await sleep(50); code = closeCodes.get('tokGhost'); }
    assert.strictEqual(code, 4090, `세션 부재 시 4090 종료여야 함(실제 ${code})`);
    await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t.index });
  } finally {
    if (prevScope === undefined) delete process.env.CPT_E2EE_SCOPE; else process.env.CPT_E2EE_SCOPE = prevScope;
  }
});
