// 웨이브2 재배선 e2e(호스트 백엔드) — CPT_TERMHOST_SOCK 폴백으로 mac 에서 **win32 와 같은 경로**
//  (pty.js → term-backend → term-host 파이프)를 태운다. tmux 무접촉.
//
//  검증: createTerminal/listTerminals(호스트 meta 매핑) · resolveTid(has) · **term-backend.attach
//  스트림 직접**(출력 + resize + 입력 + capture) · terminal.close(멱등 kill) ·
//  injectPoolEnv(setEnv) → getEnv 회수(agent-watch/question-revive 의 CPT_WS 해석 경로).
//
// ⚠ 2026-09-06: attachPty 는 더 이상 이 백엔드로 스트림을 열지 않는다. v1/v2 경로가 삭제됐고
//  CPT3 는 tmux control mode 를 쓰기 때문이다(웨이브3 과제: TerminalHost 의 transport 를 여기
//  attach 핸들로 갈아끼우면 win32 도 CPT3 가 된다 — 그래서 이 파일은 그 **바탕이 되는 백엔드
//  계약**을 계속 지킨다). attachPty 쪽은 "호스트 백엔드는 아직 v3 미지원" 거절만 고정한다.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// env 는 require 전에 굳힌다 — term-backend/term-host paths 가 이 값을 읽는다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-rewire-'));
process.env.CPT_TERMHOST_SOCK = path.join(tmp, 'host.sock');
process.env.CODINGPT_STATE_DIR = path.join(tmp, '.codingpt');

const runtime = require('../runtime');
runtime.init({ root: tmp, stateDir: path.join(tmp, '.codingpt') });

const ptyLib = require('../pty');
const backend = require('../term-backend');
assert.strictEqual(backend.isHostBackend(), true, '호스트 백엔드 미활성 — 중단');

const WS_REL = 'wsH';
fs.mkdirSync(path.join(tmp, WS_REL), { recursive: true });
const { session: NS } = ptyLib.sessionForCwd(WS_REL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '조건') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await sleep(80);
  }
}

// attachPty io 어댑터 계약(pty.js 헤더)의 최소 구현 — 등록 전 메시지 버퍼 포함.
function fakeIo() {
  let cb = null;
  const q = [];
  let closed = false;
  const closeCbs = [];
  return {
    transport: 'test',
    out: '',
    get closed() { return closed; },
    send(chunk) { this.out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); },
    onMessage(fn) { cb = fn; for (const [k, p] of q.splice(0)) fn(k, p); },
    onClose(fn) { if (closed) { fn(); return; } closeCbs.push(fn); },
    close() { if (closed) return; closed = true; for (const f of closeCbs.splice(0)) { try { f(); } catch (_) { /* noop */ } } },
    push(kind, payload) { if (cb) cb(kind, payload); else q.push([kind, payload]); },
  };
}

after(async () => {
  try { await backend.killServer(); } catch (_) { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

let A = null;
let B = null;

test('terminal.new → 호스트 세션 생성 + 목록 매핑(agent 필드 포함)', async () => {
  A = await ptyLib.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  B = await ptyLib.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  assert.ok(A.index >= 1000000 && B.index >= 1000000);
  const r = await ptyLib.handleTerminalRpc('terminal.list', { cwd: WS_REL });
  const ids = r.windows.map((w) => w.index).sort();
  assert.deepStrictEqual(ids, [A.index, B.index].sort());
  for (const w of r.windows) {
    assert.ok('agent' in w && 'agentName' in w && 'agentState' in w, '와이어 agent 4필드(추가 전용) 유지');
  }
});

test('injectPoolEnv(setEnv) → getEnv 회수 — agent-watch/question-revive 의 CPT_WS 경로', async () => {
  const name = ptyLib.termSession(NS, A.index);
  // create env(-e 등가)로 이미 들어가 있고, injectPoolEnv 의 setEnv 도 멱등으로 겹친다.
  assert.strictEqual(await backend.getEnv(name, 'CPT_WS'), WS_REL);
  assert.strictEqual(await backend.getEnv(name, 'CPT_TID'), String(A.index));
  assert.strictEqual(await backend.getEnv(name, 'CPT_TSESSION'), name);
});

test('term-backend.attach — 스트림(출력/입력/resize) + capture (웨이브3 CPT3 transport 의 바탕)', async () => {
  let out = '';
  const name = ptyLib.termSession(NS, A.index);
  const h = await backend.attach(name, { cols: 80, rows: 24, onData: (d) => { out += String(d); } });
  await until(() => out.length > 0 ? true : null, 10000, 'attach 출력(리페인트/프롬프트)');

  h.resize(100, 28);
  await until(async () => (await backend.info(name)).cols === 100 ? true : null, 8000, 'resize 반영');

  await sleep(500); // 셸 rc 소화(스폰 직후 입력 씹힘 방지 — 주의점 2)
  h.write('echo IN-A-host\r');
  await until(async () => (await backend.capture(name)).includes('IN-A-host') ? true : null, 10000, 'A 입력 반영');

  // 다른 터미널은 오염되지 않는다(전용 세션 모델).
  const bScreen = await backend.capture(ptyLib.termSession(NS, B.index));
  assert.ok(!bScreen.includes('IN-A-host'), '입력이 다른 터미널로 샜다');
  h.close();
});

test('attachPty — 호스트 백엔드는 CPT3 미지원을 명시 거절한다(조용한 실패 금지)', async () => {
  const io = fakeIo();
  await ptyLib.attachPty({ cwd: WS_REL, paneId: 'pH', client: 'cH', win: A.index, cols: 80, rows: 24, terminalProtocol: 3 }, io);
  assert.match(io.out, /아직 v3 터미널을 지원하지 않습니다/);
  assert.strictEqual(io.closed, true, '거절 후 스트림을 닫지 않았다');
});

test('스테일 win → 첫 터미널 폴백(resolveTid/has) · 터미널 0개 = 정식 상태', async () => {
  // 스테일 win 은 resolveTid 가 첫 터미널로 접는다 — 그 뒤에야 백엔드 미지원 거절이 나온다
  //  (터미널이 있는데도 "없습니다" 라고 답하면 앱 리컨실러가 pane 을 지운다).
  const io = fakeIo();
  await ptyLib.attachPty({ cwd: WS_REL, paneId: 'pH2', client: 'cH2', win: 424242, cols: 80, rows: 24, terminalProtocol: 3 }, io);
  assert.match(io.out, /아직 v3 터미널을 지원하지 않습니다/);

  await ptyLib.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: A.index });
  await ptyLib.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: B.index });
  await ptyLib.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: B.index }); // 멱등
  assert.strictEqual((await ptyLib.listTerminals(NS)).length, 0);

  // 터미널 0개에서 attach — 생성하지 않고 안내 후 종료(유령 부활 금지).
  const io2 = fakeIo();
  await ptyLib.attachPty({ cwd: WS_REL, paneId: 'pH3', client: 'cH3', win: 1, cols: 80, rows: 24, terminalProtocol: 3 }, io2);
  assert.match(io2.out, /열린 터미널이 없습니다/);
  assert.strictEqual((await ptyLib.listTerminals(NS)).length, 0, 'attach 가 유령 터미널을 만들었다');
});
