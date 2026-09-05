// E2EE 봉인 스트림 통합 테스트 — 봉투 **안**에서 CPT3 계약이 그대로 성립하는지.
//   실행: node --test packages/runner-core/test/stream-select.test.js
//
// 검증하는 것(CPT_E2EE_SCOPE=all):
//  1. 협상은 스트림 **밖**(제어채널)에서 끝나고, 스트림 첫 프레임부터 봉인된다.
//  2. 봉인 data 프레임 = stdin, ctrl 프레임 = 텍스트 JSON(resize 등) — v3 도 같은 봉투를 쓴다.
//  3. 출력은 전부 바이너리 봉인이고, 복호하면 CPT3 프레임이며, **와이어에 평문 카나리 0건**.
//  4. 평문 인젝션·리플레이는 폐기되고 소켓은 살아 있다.
//  5. sid 는 있는데 세션이 없으면 평문 폴백이 아니라 4090 종료(재협상 유도).
//
// ※ attach/입력/탭 스왑/스테일 win 같은 **평문 경로 계약**은 terminal-v3-stream.test.js 가 본다
//   (2026-09-06 v1/v2 삭제 때 이 파일에서 그쪽으로 옮겼다 — 중복 유지 금지).
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
const v3wire = require('../terminal-stream-v3');
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
      params: { cwd: WS_REL, paneId: 'pE', client: 'cE', win: t.index, cols: 80, rows: 24, sid: answer.sid, terminalProtocol: 3 },
    });
    const ws = await waitStream('tokE');
    const rawFrames = [];
    const plain = [];
    const errs = [];
    ws.on('message', (d, isBinary) => {
      rawFrames.push({ buf: Buffer.from(d), isBinary });
      try { plain.push(vs.open(d).payload); } catch (e) { errs.push(e.message); }
    });

    // ctrl 프레임(=텍스트 JSON) — 첫 뷰어의 resize 는 소유권 확정 + window 크기 결정이다(v3 §2).
    ws.send(vs.sealCtrl({ type: 'resize', cols: 100, rows: 30 }), { binary: true });
    await sleep(1000);
    const paneAfter = await tmux(['display-message', '-p', '-t', `=${pty.termSession(NS, t.index)}:0`, '#{window_width}x#{window_height}']);
    assert.strictEqual(paneAfter.trim(), '100x30', '봉인 ctrl(resize)이 소유자 격자로 반영되지 않았다');

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
    // 봉투를 벗기면 CPT3 프레임 — OUTPUT payload 를 이어 붙여야 셸 에코가 된다.
    const decoded = plain.map((b) => v3wire.decode(Buffer.isBuffer(b) ? b : Buffer.from(b))).filter(Boolean);
    assert.ok(decoded.length > 0, '복호된 프레임이 CPT3 가 아니다(봉투 안 계약이 깨졌다)');
    const outText = Buffer.concat(decoded.filter((f) => f.opcode === v3wire.OPCODE.OUTPUT).map((f) => f.payload)).toString('utf8');
    const snapText = decoded.filter((f) => f.opcode === v3wire.OPCODE.SNAPSHOT)
      .map((f) => { try { return JSON.parse(f.payload.toString('utf8')).ansi || ''; } catch (_) { return ''; } }).join('');
    assert.ok((outText + snapText).includes(CANARY), '복호된 CPT3 출력에 셸 에코가 없다');

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
      params: { cwd: WS_REL, paneId: 'pG', client: 'cG', win: t.index, cols: 80, rows: 24, sid: 'nonexistent-sid', terminalProtocol: 3 },
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
