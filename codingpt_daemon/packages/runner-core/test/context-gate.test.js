// ── win32 CI 스킵 가드 (windows-port · design.md 계약 6) — 게이트만, 테스트 로직 무수정 ──
//  사유: 유닉스 도메인 소켓 실청취(cpt.sock) — 계약 2 named pipe 재배선 전
//  해당 재배선/정리 후 이 가드를 제거해 win32 커버리지를 복구한다. (darwin/linux 는 무영향)
if (process.platform === 'win32') {
  require('node:test')('context-gate.test.js: win32 스킵 — 유닉스 도메인 소켓 실청취(cpt.sock)', { skip: true }, () => {});
  return;
}

// CodingPT 컨텍스트 게이트 회귀 테스트 — node --test
//
// 지키는 불변식(2026-07-29 실사고에서 도출):
//  A. CWD 폴백만으로 온 요청(무관 폴더)은 조작 명령이 OUT_OF_CONTEXT 로 거부된다.
//     — 과거엔 홈 아래 아무 폴더나 워크스페이스로 승격돼 전역 스킬 스텁을 본 다른 도구의
//       에이전트(codex 등)가 사용자의 활성 기기 화면을 실제로 조작할 수 있었다.
//  B. CodingPT 컨텍스트(CPT_WS env / tmux -L codingpt 자기좌표)는 통과한다 — 훅·정상 사용 무영향.
//  C. "열려 있는 워크스페이스" 폴더(와 그 하위)에서의 CWD 폴백은 통과한다 — 옛 셸 수동 사용 보존.
//  D. 진단(ping/identify)은 컨텍스트 없이도 응답하고, identify.context 가 게이트 판정을 알려준다.
//  E. 예외 목록(CONTEXT_EXEMPT)에 조작 계열(terminal./ws./ui./browser./notify)이 끼어들지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-gate-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: path.join(ROOT, '.claude') });

const ptyLib = require('../pty');
const cptServer = require('../cpt-server');

// tmux 를 스텁한다 — 이 프로세스의 게이트가 보는 "열려 있는 워크스페이스" = myws 하나.
//  (실 tmux -L codingpt 서버를 건드리지 않기 위해서이기도 하다. 다른 runTmux 소비 경로는
//   이 테스트에서 호출되지 않는다.)
ptyLib.runTmux = async (args) => {
  if (args[0] === 'list-sessions') return 'cpt-myws--t-1000001\ncodingpt\n';
  throw new Error('이 테스트는 tmux 를 쓰지 않는다: ' + args.join(' '));
};

fs.mkdirSync(path.join(ROOT, 'myws', 'sub'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'unrelated'), { recursive: true });

const SRC_SERVER = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');

let srv = null;
function ensureServer() {
  if (srv) return srv;
  srv = cptServer.start({});
  return srv;
}
// one-shot 소켓 호출 — ctx 를 케이스별로 다르게 보낸다(게이트의 유일한 입력).
function call(cmd, args, ctx, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(cptServer.sockPath());
    let buf = '';
    const timer = setTimeout(() => { try { conn.destroy(); } catch (_) { /* noop */ } reject(new Error('소켓 응답 시간 초과')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 'g', cmd, args, ctx }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      try { conn.end(); } catch (_) { /* noop */ }
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

test('A. 무관 폴더의 CWD 폴백 → 조작 명령 거부(OUT_OF_CONTEXT)', async () => {
  ensureServer();
  const r = await call('status.list', {}, { cwd: path.join(ROOT, 'unrelated') });
  assert.strictEqual(r.ok, false, '무관 폴더에서 status.list 가 통과하면 게이트가 죽은 것');
  assert.strictEqual(r.code, 'OUT_OF_CONTEXT', `code=OUT_OF_CONTEXT 여야 함 (실제: ${r.code})`);
});

test('A-2. ctx 가 아예 없어도(cwd 조차) 조작 명령은 거부된다', async () => {
  ensureServer();
  const r = await call('status.list', {}, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OUT_OF_CONTEXT');
});

test('B. CPT_WS env(ctx.ws) 가 있으면 통과 — 빈 문자열이어도 env 존재 자체가 우리 터미널 증거', async () => {
  ensureServer();
  const r1 = await call('status.list', {}, { cwd: path.join(ROOT, 'unrelated'), ws: 'proj' });
  assert.strictEqual(r1.ok, true, `ctx.ws 가 있으면 통과해야 함 (에러: ${r1.error})`);
  const r2 = await call('status.list', {}, { cwd: path.join(ROOT, 'unrelated'), ws: '' });
  assert.strictEqual(r2.ok, true, 'ws: "" (홈 루트 워크스페이스)도 통과해야 함');
});

test('B-2. tmux -L codingpt 자기좌표(cpt-…)가 있으면 통과', async () => {
  ensureServer();
  const r = await call('status.list', {}, {
    cwd: path.join(ROOT, 'unrelated'),
    tmux: { session: 'cpt-foo--t-1000002', windowIndex: 1000002 },
  });
  assert.strictEqual(r.ok, true, `tmux 자기좌표가 있으면 통과해야 함 (에러: ${r.error})`);
});

test('C. 열려 있는 워크스페이스 폴더(하위 포함)의 CWD 폴백은 통과 — 옛 셸 수동 사용 보존', async () => {
  ensureServer();
  const r = await call('status.list', {}, { cwd: path.join(ROOT, 'myws', 'sub') });
  assert.strictEqual(r.ok, true, `열린 워크스페이스 하위 폴더는 통과해야 함 (에러: ${r.error})`);
});

test('D. 진단은 컨텍스트 없이 응답하고 identify.context 가 판정을 싣는다', async () => {
  ensureServer();
  const ping = await call('ping', {}, {});
  assert.strictEqual(ping.ok, true, 'ping 은 컨텍스트 없이도 응답해야 한다');
  const out1 = await call('identify', {}, { cwd: path.join(ROOT, 'unrelated') });
  assert.strictEqual(out1.ok, true, 'identify 는 게이트 예외여야 한다');
  assert.strictEqual(out1.result.context, false, '무관 폴더에서는 context:false 여야 한다');
  const in1 = await call('identify', {}, { cwd: path.join(ROOT, 'myws') });
  assert.strictEqual(in1.result.context, true, '열린 워크스페이스에서는 context:true 여야 한다');
});

test('F. 게이트 배선·예외 목록 소스 계약', () => {
  // 게이트가 dispatch 의 resolveCtx 직후에 실제로 불린다(빼먹으면 전 명령이 다시 열린다).
  assert.match(SRC_SERVER, /await assertCptContext\(cmd, req\.ctx, resolved\)/,
    'dispatch 가 assertCptContext 를 호출해야 한다');
  // 예외 목록에 조작 계열이 끼어들면 게이트가 무력화된다.
  const m = /const CONTEXT_EXEMPT = new Set\(\[([\s\S]*?)\]\)/.exec(SRC_SERVER);
  assert.ok(m, 'CONTEXT_EXEMPT 선언이 있어야 한다');
  assert.doesNotMatch(m[1], /terminal\.|ws\.|ui\.|browser\.|notify|chat\./,
    '조작/열람 계열은 CONTEXT_EXEMPT 에 넣을 수 없다');
});

// 소켓 서버를 닫는다 — 남겨두면 열린 핸들 때문에 `node --test` 프로세스가 끝나지 않는다.
test('cleanup — 격리 소켓 정리', async () => {
  if (srv) await new Promise((r) => srv.close(r));
  try { fs.unlinkSync(cptServer.sockPath()); } catch (_) { /* 이미 없음 */ }
});
