// 과거(스크롤백)의 정본이 tmux 인지 — 그리고 `clear` 가 그 과거를 실제로 비우는지.
//
// 배경(2026-09-04, 사용자 신고): PC·안드로이드·아이패드가 같은 워크스페이스를 봤는데 위로
//  스크롤한 "과거"가 기기마다 달랐고, PC 는 프롬프트가 한 줄에 여러 개 붙은 뭉개진 줄이 보였다.
//  진범 2개:
//   ① tmux 는 리사이즈마다 pane 을 커서 위치에 다시 그린다(ED 없이 `\e[K`+`\r\n`). 그 스트림을
//      먹는 VT(데몬 canonical Screen · PC xterm)는 그 재도장 잔재를 과거로 쌓는다.
//      → 과거는 VT 스크롤백이 아니라 tmux 격자에서 읽어야 한다.
//   ② `clear` 는 E3 로 tmux history 를 0 으로 만드는데, tmux 가 곧이어 ED2 를 scroll-on-clear=on
//      규칙으로 처리해 방금 지운 화면을 history 로 도로 밀어 넣었다(tmux.conf 에서 off 로 고정).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOCK = `codingpt-hist-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hist-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
const backend = require('../term-backend');
const { CanonicalTerminalRegistry } = require('../canonical-terminal');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const has = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const hasTmux = has('tmux');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimRight = (s) => String(s).replace(/\s+$/, '');

const registries = [];
after(async () => {
  for (const r of registries) { try { r.closeAll(); } catch (_) { /* noop */ } }
  try { await backend.killServer(); } catch (_) { /* 이미 없음 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

const historySize = async (name) => Number(String(
  await pty.runTmux(['display-message', '-p', '-t', `=${name}:0`, '#{history_size}']),
).trim()) || 0;

/** 출력이 넉넉히 쌓인 세션 + 그 세션에 붙은 canonical 모델. */
async function makeSession(name, lines) {
  await backend.create({ name, cwd: ROOT, cols: 80, rows: 24 });
  await sleep(600);
  await backend.sendKeys(name, { data: 'PS1="P> "\r' });
  await sleep(400);
  await backend.sendKeys(name, { data: `for i in $(seq 1 ${lines}); do echo "LINE $i"; done\r` });
  await sleep(1800);
  const reg = new CanonicalTerminalRegistry(backend, { idleMs: 60000 });
  registries.push(reg);
  const model = reg.get(name, { cols: 80, rows: 24 });
  const off = model.subscribe(() => {});
  await model.ready;
  await sleep(400);
  return { model, off };
}

test('과거는 tmux 격자에서 온다 — 리사이즈를 반복해도 찌꺼기가 안 낀다', { skip: !hasTmux }, async () => {
  const NAME = 'hist-resize';
  const { model, off } = await makeSession(NAME, 200);

  // 기기 전환 시뮬레이션(window-size latest): 폰 ↔ PC ↔ 태블릿 크기를 오간다.
  for (const [c, r] of [[68, 21], [179, 45], [68, 24], [179, 45], [68, 21], [100, 30], [80, 24]]) {
    await model.resize(c, r);
    await sleep(250);
  }
  await sleep(400);

  const page = await model.historyPage({ limit: 500 });
  assert.strictEqual(page.source, 'backend', `정본이 tmux 가 아니다: source=${page.source}`);

  const total = await historySize(NAME);
  assert.strictEqual(page.total, total, `과거 줄 수가 tmux 와 다르다(VT 잔재 누적): ${page.total} vs ${total}`);

  // 내용도 tmux 원본과 같아야 한다 — 마지막 페이지 구간을 그대로 대조한다.
  const truth = String(await backend.captureHistory(NAME, { lines: 10000 }))
    .replace(/\n$/, '').split('\n').map(trimRight);
  const got = page.rows.map((r) => trimRight(r.text));
  assert.deepStrictEqual(got, truth.slice(truth.length - got.length), '과거 내용이 tmux 원본과 다르다');

  // 실제 출력이 살아 있어야 의미 있는 검증이다(빈 과거로 통과하지 않게).
  assert.ok(page.total > 100, `과거가 너무 짧다(${page.total}) — 시나리오가 성립 안 함`);
  assert.ok(got.some((l) => /^LINE 1\d\d$/.test(l)), '기대한 출력이 과거에 없다');
  off();
});

test('offset 페이징이 연속이다 — 두 페이지를 이어붙이면 통짜와 같다', { skip: !hasTmux }, async () => {
  const NAME = 'hist-page';
  const { model, off } = await makeSession(NAME, 200);

  const whole = await model.historyPage({ limit: 500 });
  assert.ok(whole.total > 120, `과거가 너무 짧다(${whole.total})`);
  const tail = await model.historyPage({ limit: 60 });
  const head = await model.historyPage({ before: tail.start, limit: 60 });

  assert.strictEqual(tail.end, whole.total, 'before 생략 = 맨 끝이어야 한다');
  assert.strictEqual(head.end, tail.start, '페이지 경계가 안 맞는다');
  assert.strictEqual(head.rows.length, head.end - head.start, '요청 구간과 행 수가 다르다');
  assert.deepStrictEqual(
    [...head.rows, ...tail.rows].map((r) => r.offset),
    Array.from({ length: 120 }, (_, i) => whole.total - 120 + i),
    'offset 이 연속이 아니다',
  );
  assert.deepStrictEqual(
    [...head.rows, ...tail.rows].map((r) => trimRight(r.text)),
    whole.rows.slice(whole.rows.length - 120).map((r) => trimRight(r.text)),
    '나눠 받은 내용이 통짜와 다르다',
  );
  assert.ok(tail.rows.every((r) => typeof r.ansi === 'string'), 'ansi 필드 누락 — 색이 사라진다');
  off();
});

test('clear 하면 과거가 정말 비워진다(scroll-on-clear off 계약)', { skip: !hasTmux }, async () => {
  const NAME = 'hist-clear';
  const { model, off } = await makeSession(NAME, 200);

  const before = await model.historyPage({ limit: 1 });
  assert.ok(before.total > 100, `clear 전 과거가 없다(${before.total}) — 검증 불가`);

  await backend.sendKeys(NAME, { data: 'clear\r' });
  await sleep(900);

  const after = await model.historyPage({ limit: 500 });
  assert.strictEqual(after.total, 0, `clear 후에도 과거가 남았다(${after.total}줄) — scroll-on-clear 가 on 이다`);
  assert.deepStrictEqual(after.rows, [], 'clear 후 행이 남았다');
  off();
});

test('퇴화 resize(2x1)는 공유 window 를 접지 못한다', { skip: !hasTmux }, async () => {
  // 2026-09-05 안드로이드 실기: 앱이 과거 오버레이를 띄우면 라이브 격자가 display:none 이 되고,
  //  그 상태의 fit 이 FitAddon 최소값 2x1 을 낸다. window-size latest 라 그 값이 공유 window 를
  //  통째로 접어 PC·폰 모두 무너졌다(실측 win=2x1). 서버가 마지막 방어선이다.
  const http = require('http');
  const WebSocket = require('ws');
  const NAME = 'hist-degen';
  const WS_REL = 'wsD';
  fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });

  const streams = new Map();
  const httpServer = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const m = /\/api\/daemon\/stream\/(.+)$/.exec(req.url || '');
    if (!m) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => streams.set(m[1], ws));
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;

  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  pty.openPtyStream({ serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'test' }, {
    streamToken: 'dg1',
    params: { cwd: WS_REL, paneId: 'pD', client: 'cD', win: t.index, cols: 80, rows: 24, terminalProtocol: 2 },
  });
  const t0 = Date.now();
  let ws;
  while (!(ws = streams.get('dg1'))) {
    if (Date.now() - t0 > 8000) throw new Error('스트림 미접속');
    await sleep(50);
  }
  const session = `cpt-${WS_REL}--t-${t.index}`;
  const winSize = async () => String(
    await pty.runTmux(['display-message', '-p', '-t', `=${session}:0`, '#{window_width}x#{window_height}']),
  ).trim();

  ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await sleep(900);
  const good = await winSize();

  ws.send(JSON.stringify({ type: 'resize', cols: 2, rows: 1 }));
  await sleep(900);
  assert.strictEqual(await winSize(), good, `퇴화 resize 가 공유 window 를 접었다 (였던 크기 ${good})`);

  // 정상 크기는 계속 먹혀야 한다(과잉 차단 아님).
  ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 28 }));
  await sleep(900);
  assert.strictEqual(await winSize(), '90x28', '정상 resize 까지 막혔다');

  try { ws.close(); } catch (_) { /* noop */ }
  try { for (const s of streams.values()) s.close(); wss.close(); httpServer.close(); } catch (_) { /* noop */ }
  await sleep(200);
});

test('과거 한 줄의 색이 다음 줄로 번지지 않는다', { skip: !hasTmux }, async () => {
  // 2026-09-05 안드로이드 실기: 파워라인 프롬프트 줄이 `\e[44m`(파란 배경)을 **켠 채로 끝난다**
  //  (tmux 는 배경이 줄 끝까지 이어지면 리셋을 안 붙인다). 뷰어가 페이지를 `\r\n` 으로 이어 붙이자
  //  그 배경이 이후 모든 줄로 번져 화면이 통째로 파래졌다. 행은 offset 임의 접근 단위 = 자족적이어야.
  const NAME = 'hist-bleed';
  const { model, off } = await makeSession(NAME, 5);
  // 배경을 켠 채 끝나는 줄 + 평범한 줄들 → 스크롤아웃시켜 history 로 보낸다.
  await backend.sendKeys(NAME, { data: "printf '\\033[44mBLUE-LINE\\n'\r" });
  await sleep(600);
  await backend.sendKeys(NAME, { data: 'seq 1 80 | sed "s/^/PLAIN /"\r' });
  await sleep(1500);

  const page = await model.historyPage({ limit: 500 });
  // ⚠ 명령을 친 **에코 줄**도 'BLUE-LINE' 을 포함한다(거기 \033 은 그냥 글자다). 실제로 속성을
  //   켠 채 끝나는 줄 = ansi 에 진짜 ESC 시퀀스가 들어 있는 쪽이다.
  const bleeder = page.rows.find((r) => r.text.includes('BLUE-LINE') && r.ansi.includes('\x1b[44m'));
  assert.ok(bleeder, '배경을 켠 줄이 과거에 없다 — 시나리오 미성립');
  assert.ok(/\x1b\[0m$/.test(bleeder.ansi), `속성을 켠 채 끝나는 줄이 닫히지 않았다: ${JSON.stringify(bleeder.ansi)}`);

  // 실제 VT 에 뷰어와 같은 방식으로 써 넣고, 뒷줄의 배경이 기본값인지 확인한다.
  const { Screen } = require('../../term-host/lib/screen');
  const view = new Screen(80, 24);
  view.write('\x1b[H' + page.rows.map((r) => r.ansi).join('\r\n'));
  await view.flush();
  const buf = view.term.buffer.active;
  let checked = 0;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line || !line.translateToString(true).startsWith('PLAIN ')) continue;
    const cell = line.getCell(0);
    assert.strictEqual(cell.isBgDefault(), true, `${y}행(PLAIN)에 앞줄의 배경이 번졌다`);
    checked++;
  }
  assert.ok(checked > 10, `검사한 PLAIN 줄이 너무 적다(${checked})`);
  view.dispose();
  off();
});
