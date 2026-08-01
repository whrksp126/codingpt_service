// cpt 소켓 / 제어 WS 배선 회귀 테스트 — node --test
//
// 이 파일이 지키는 것은 "기능 로직"이 아니라 **배선 불변식**이다. 전부 과거 사고 유형이거나
// 되돌리기 쉬운 한 줄짜리 규율이라, 소스 계약으로 못 박아 둔다.
//
//  A. 장기 블로킹 가능성 — cpt 소켓에 유휴 타임아웃(conn.setTimeout)을 걸면 원격 승인 대기가
//     사용자가 폰에서 답하기 전에 끊겨 매번 TUI 로 폴백한다(기능1이 조용히 죽는다).
//  B. 위험 커맨드 비공개 — approval.request/respond·chat.input 이 CAPABILITIES 에 올라가면
//     터미널 안의 AI 가 자기 승인을 스스로 통과시키거나 프롬프트를 자기주입할 수 있다.
//  C. defer 폴백 — 어떤 실패 경로에서도 allow 를 만들지 않는다(킬스위치 포함).
//  D. caps 정직성 — 데몬은 **처리 코드가 실제로 있는** 능력만 선언한다(선언만 하고 프레임을 버리면
//     서버/기기가 기능을 켜고 사용자에겐 조용히 유실된다).
//  E. rpc 위임 — back 이 보내는 approval.*/chat.* 이 데몬 안에서 실제 모듈로 흘러야 하고,
//     모듈이 없을 때 데몬이 죽지 않고(uncaught) 명확한 실패로 회신해야 한다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-wire-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: path.join(ROOT, '.claude') });

const cptServer = require('../cpt-server');
const control = require('../control');

const SRC_SERVER = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
const SRC_CONTROL = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');

// ── 소켓 왕복 헬퍼(one-shot, 실 소켓) ──
let srv = null;
function ensureServer() {
  if (srv) return srv;
  srv = cptServer.start({});
  return srv;
}
function call(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(cptServer.sockPath());
    let buf = '';
    const timer = setTimeout(() => { try { conn.destroy(); } catch (_) { /* noop */ } reject(new Error('소켓 응답 시간 초과')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 'w', cmd, args, ctx: { cwd: ROOT, ws: 'proj' } }) + '\n'));
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

test('A. cpt 소켓에 유휴 타임아웃이 없다 (승인 대기가 끊기지 않는다)', () => {
  assert.doesNotMatch(SRC_SERVER, /conn\.setTimeout\(/,
    'conn.setTimeout 을 넣으면 원격 승인 대기가 그 시점에 끊겨 매번 TUI 로 폴백한다');
  // 요청자 소멸을 감지할 수 있어야 한다 — dispatch 가 conn 을 받아 넘긴다.
  assert.match(SRC_SERVER, /dispatch\(req,\s*conn\)/, 'dispatch 에 conn 을 넘겨야 훅 사망(소켓 close)을 감지할 수 있다');
});

test('B. 위험 커맨드는 CAPABILITIES 에 노출되지 않는다', async () => {
  ensureServer();
  const res = await call('capabilities');
  const cmds = res.result.commands;
  for (const c of ['approval.list', 'chat.sessions', 'chat.open', 'chat.since', 'chat.close']) {
    assert.ok(cmds.includes(c), `조회 커맨드 ${c} 는 공개돼야 한다`);
  }
  for (const c of ['approval.request', 'approval.respond', 'chat.input']) {
    assert.ok(!cmds.includes(c), `${c} 가 공개되면 터미널의 AI 가 사람 결정/입력을 대신할 수 있다`);
  }
});

test('C. 킬스위치(CPT_APPROVAL=0) → 즉시 defer (allow 아님)', async () => {
  ensureServer();
  const prev = process.env.CPT_APPROVAL;
  process.env.CPT_APPROVAL = '0';
  try {
    const res = await call('approval.request', { toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.decision, 'defer');
    assert.strictEqual(res.result.reason, 'killswitch');
    assert.ok(!res.result.hookOutput, '킬스위치에서 훅 출력이 생기면 사용자 승인을 우리가 대신 결정하는 것이다');
  } finally {
    if (prev == null) delete process.env.CPT_APPROVAL; else process.env.CPT_APPROVAL = prev;
  }
});

test('C-2. 서버가 approval.v1 을 선언하지 않으면 카드를 만들지 않고 defer', async () => {
  ensureServer();
  // 이 프로세스엔 제어 WS 가 없다 = serverCaps [] = 구 back 과 동일한 조합.
  assert.strictEqual(control.hasServerCap('approval.v1'), false);
  const res = await call('approval.request', { toolName: 'Bash', toolInput: { command: 'ls' } });
  assert.strictEqual(res.result.decision, 'defer');
  assert.ok(!res.result.hookOutput);
});

test('D. daemonCaps() 는 구현 모듈이 있는 능력만 선언한다', () => {
  const caps = control.daemonCaps();
  assert.ok(caps.includes('caps.v1') && caps.includes('hooks.v2'), '기본 능력은 항상 포함');
  const check = (cap, mod, fn) => {
    let ok = false;
    try { const m = require(mod); ok = !!m && typeof m[fn] === 'function'; } catch (_) { ok = false; }
    assert.strictEqual(caps.includes(cap), ok, `${cap} 선언은 ${mod}.${fn} 존재와 정확히 일치해야 한다`);
  };
  check('approval.v1', '../approvals', 'request');
  check('transcript.v1', '../transcript', 'handle');
});

test('E. control.js rpc 디스패치가 approval.*/chat.* 을 모듈로 위임한다 (소스 계약)', () => {
  const i = SRC_CONTROL.indexOf("msg.type === 'rpc'");
  assert.ok(i > 0, 'rpc 디스패치 블록이 있어야 한다');
  // (2026-07-25 기능2 E2EE) 디스패치 체인은 봉투 RPC(method:'sealed')와 **같은 한 벌**을 타도록
  //  dispatchRpc() 로 추출됐다. 그래서 위임 계약은 그 함수 본문에서 확인한다(핸들러는 그리로 넘긴다).
  assert.match(SRC_CONTROL.slice(i, i + 3000), /dispatchRpc\(ws, msg\.method, msg\.params, ok, fail\)/,
    'rpc 프레임은 단일 디스패처(dispatchRpc)로 넘겨야 한다(평문/봉투 분기 이중화 금지)');
  const j = SRC_CONTROL.indexOf('function dispatchRpc');
  assert.ok(j > 0, 'rpc 디스패처 함수가 있어야 한다');
  // 창 크기는 디스패처 본문 전체를 덮을 만큼(주석이 길다 — 각 위임에 사고 이력이 붙어 있다).
  //  ★ 2026-08-01 chat.mode 위임이 늘며 3000 을 넘겨 이 핀이 **계약이 살아 있는데도** 깨졌다.
  const block = SRC_CONTROL.slice(j, j + 6000);
  assert.match(block, /approval\.'\)\).*callLazy\('\.\/approvals'|startsWith\('approval\.'\)\)\s*\{\s*callLazy\('\.\/approvals'/s,
    "back 의 approval.* rpc 가 approvals 로 위임돼야 블록된 훅이 풀린다");
  assert.match(block, /startsWith\('chat\.'\)\)\s*\{\s*callLazy\('\.\/transcript'/,
    'chat.* rpc 는 transcript 로 위임돼야 한다');
  // 모듈 부재를 예외로 흘리면 데몬이 죽는다(uncaught) — callLazy 가 fail 로 접는지.
  assert.match(SRC_CONTROL, /function callLazy[\s\S]*?fail\(new Error/, 'callLazy 가 모듈 부재를 fail 로 회신해야 한다');
  // 대기 중 승인은 연결 유실로 지우지 않는다(정본=데몬) + 재접속 시 재광고.
  assert.match(SRC_CONTROL, /approvals\.resync\(\)/, '재접속 후 pending 재광고(resync)가 있어야 한다');
  assert.match(SRC_CONTROL, /hasServerCap\('approval\.v1'\)/, '재광고는 caps 게이팅 뒤에 있어야 한다(구 서버에 던지지 않는다)');
});

test('E-2. 제어 WS close 는 transcript push 만 해제하고 tail(watcher)은 남긴다', () => {
  const i = SRC_CONTROL.indexOf("ws.on('close'");
  const block = SRC_CONTROL.slice(i, i + 1500);
  assert.match(block, /transcript'\)[\s\S]*?detachAll\(\)/, 'close 에서 transcript.detachAll() 을 불러야 한다');
  assert.doesNotMatch(block, /transcript[\s\S]{0,120}closeAll\(\)/,
    'close 에서 tail 을 통째로 닫으면 재접속마다 스냅샷 재전송이 폭주한다');
});

test('F. chat.* 는 좌표(cwd/tid)를 ctx 에서 채워 transcript 로 통째 위임한다', async () => {
  ensureServer();
  const res = await call('chat.bogus');
  assert.strictEqual(res.ok, false);
  assert.match(String(res.error), /chat/, '알 수 없는 chat 메서드는 transcript 가 거절해야 한다(패스스루 증명)');
  const src = SRC_SERVER.slice(SRC_SERVER.indexOf("cmd.startsWith('chat.')"));
  assert.match(src.slice(0, 800), /cwd: resolved\.cwdRel, tid: resolved\.windowIndex, \.\.\.args/,
    'ctx 좌표를 채우고 명시 인자로 덮어써야 한다');
});

test('G. 훅 배선이 transcript 바인딩을 검증된 경로로만 넘긴다 (ToS 경계)', () => {
  const i = SRC_SERVER.indexOf("cmd === 'hook.event'");
  const block = SRC_SERVER.slice(i, i + 3000);
  assert.match(block, /transcript\.safeTranscriptPath/,
    'transcriptPath 는 jail 검증기(transcript.safeTranscriptPath)를 통과한 값만 넘겨야 한다 — 아니면 ~/.claude 크레덴셜 경로를 읽히게 만들 수 있다');
  assert.match(block, /noteHook\(/, '훅이 세션↔터미널 바인딩을 등록해야 한다(P0 결정론적 경로)');
});

// 소켓 서버를 닫는다 — 남겨두면 열린 핸들 때문에 `node --test` 프로세스가 끝나지 않는다.
test('cleanup — 격리 소켓 정리', async () => {
  if (srv) await new Promise((r) => srv.close(r));
  try { fs.unlinkSync(cptServer.sockPath()); } catch (_) { /* 이미 없음 */ }
});
