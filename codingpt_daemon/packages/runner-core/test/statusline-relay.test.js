// ── win32 CI 스킵 가드 (windows-port · design.md 계약 6) — 게이트만, 테스트 로직 무수정 ──
//  사유: 유닉스 도메인 소켓 실청취(CPT_SOCK 경로 listen) — 계약 2 named pipe 재배선 전
//  해당 재배선/정리 후 이 가드를 제거해 win32 커버리지를 복구한다. (darwin/linux 는 무영향)
if (process.platform === 'win32') {
  require('node:test')('statusline-relay.test.js: win32 스킵 — 유닉스 도메인 소켓 실청취(CPT_SOCK 경로 listen)', { skip: true }, () => {});
  return;
}

// statusline-relay — claude statusLine 슬롯을 차지하면서 **사용자 스크립트를 체인**하는 중계기.
//
// 이 파일이 지키는 계약(어기면 사용자 터미널 화면이 망가진다):
//  ① stdout = 사용자 명령의 출력 **그대로**. 우리 문자열을 섞지 않는다.
//  ② 데몬이 죽어 있어도 ①은 나간다(보고 실패가 화면을 망가뜨리지 않는다).
//  ③ 사용자 설정이 없으면 아무것도 출력하지 않는다(= statusLine 미설정과 같은 화면).
//  ④ 우리 래퍼를 다시 부르지 않는다(무한 재귀 금지).
// 라이브 실증(2026-08-03, 격리 claude 2.1.220 + 사용자 실제 ~/.claude/statusline.sh):
//  터미널에 `◆ Opus 5 (1M context) ░░░ 0% 0/1.0M` 이 그대로 그려졌고 소켓은 보고 2건을 받았다.
//  shift+tab → 데몬 도착 394ms(claude 자체 300ms 디바운스 포함).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const runtime = require('../runtime');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-rl-')));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const RELAY = path.join(__dirname, '..', 'statusline-relay.js');
const relay = require('../statusline-relay');

const payloadFor = (cwd) => JSON.stringify({
  transcript_path: '/x/t.jsonl', cwd,
  model: { display_name: 'Opus 5 (1M context)' },
  context_window: { used_percentage: 31, context_window_size: 1000000 },
});

/**
 * 릴레이를 실제 프로세스로 돌린다(계약 검증은 프로세스 경계에서만 의미가 있다).
 *  ⚠ HOME 을 격리 디렉토리로 준다 — 안 하면 **이 머신의 실제 ~/.claude/settings.json** 을 읽어
 *   테스트가 개발자 개인 설정에 따라 초록/빨강이 갈린다(2026-07-28 codexHome 사고와 같은 계열).
 */
function run(dir, env) {
  return new Promise((res) => {
    const ch = execFile(process.execPath, [RELAY], { env: { ...process.env, HOME: dir, ...env } },
      (err, stdout, stderr) => res({ err, stdout, stderr }));
    ch.stdin.end(payloadFor(dir));
  });
}

// ── 설정 탐색 ────────────────────────────────────────────────────────────────
test('사용자 statusLine 명령을 찾는다 — 프로젝트가 홈보다 우선', () => {
  const proj = path.join(ROOT, 'proj', '.claude');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo HOME' } }));
  fs.writeFileSync(path.join(proj, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo PROJ' } }));
  // 홈 탐색은 os.homedir() 를 보므로 여기선 프로젝트 경로만 단언한다(홈은 아래 프로세스 테스트에서).
  assert.strictEqual(relay.userStatusLine(path.join(ROOT, 'proj')), 'echo PROJ');
});

test('★ 우리 래퍼가 설정에 들어 있으면 무시한다(무한 재귀 금지)', () => {
  const d = path.join(ROOT, 'loop', '.claude');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: '"/Users/x/.codingpt/bin/cpt-statusline"' } }));
  assert.notStrictEqual(relay.userStatusLine(path.join(ROOT, 'loop')), '"/Users/x/.codingpt/bin/cpt-statusline"');
});

test('type 이 command 가 아니면 그 항목은 건너뛴다', () => {
  const d = path.join(ROOT, 'nc', '.claude');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ statusLine: { type: 'static', value: 'echo NOPE' } }));
  // 이 머신의 홈 설정으로 폴백할 수 있으므로 "그 값이 아니다"만 단언한다(홈 유무에 의존하지 않게).
  assert.notStrictEqual(relay.userStatusLine(path.join(ROOT, 'nc')), 'echo NOPE');
});

// ── 프로세스 계약 ────────────────────────────────────────────────────────────
test('★ 데몬이 없어도 사용자 출력은 그대로 나간다(보고 실패 ≠ 화면 손상)', async () => {
  const dir = path.join(ROOT, 'p1');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'printf "USER-LINE"' } }));
  const r = await run(dir, { CPT_SOCK: path.join(ROOT, 'nope.sock') });
  assert.strictEqual(r.stdout, 'USER-LINE', '우리 문자열이 섞이지 않는다');
});

test('사용자 설정이 없으면 아무것도 출력하지 않는다(= statusLine 미설정과 같은 화면)', async () => {
  const dir = path.join(ROOT, 'p2');
  fs.mkdirSync(dir, { recursive: true });
  const r = await run(dir, { CPT_SOCK: path.join(ROOT, 'nope.sock') });
  assert.strictEqual(r.stdout, '');
});

test('★ 보고는 실제로 소켓에 도착한다(status.report 프레임)', async () => {
  // ⚠ 유닉스 소켓 경로는 macOS 104자 제한이 있다 — 긴 tmpdir 에 만들면 조용히 EADDRINUSE 로 실패한다
  //  (2026-08-03 실측으로 물린 함정). 짧은 경로를 쓴다.
  const sock = path.join(os.tmpdir(), 'cptrl-' + process.pid + '.sock');
  try { fs.unlinkSync(sock); } catch (_) { /* 없음 */ }
  const got = [];
  const srv = net.createServer((c) => {
    let b = '';
    c.on('data', (d) => { b += d; });
    c.on('end', () => got.push(b));
  });
  await new Promise((res) => srv.listen(sock, res));
  try {
    const dir = path.join(ROOT, 'p3');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'printf "OK"' } }));
    const r = await run(dir, { CPT_SOCK: sock });
    assert.strictEqual(r.stdout, 'OK');
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((z) => setTimeout(z, 25));
    assert.strictEqual(got.length, 1, '보고 1건');
    const frame = JSON.parse(got[0]);
    assert.strictEqual(frame.cmd, 'status.report');
    assert.strictEqual(frame.args.payload.transcript_path, '/x/t.jsonl');
  } finally {
    await new Promise((res) => srv.close(res));
    try { fs.unlinkSync(sock); } catch (_) { /* noop */ }
  }
});
