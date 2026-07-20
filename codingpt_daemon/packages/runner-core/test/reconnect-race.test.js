// 터미널 아키텍처(전용 세션 모델) 회귀 테스트 — node 내장 러너(node --test), 외부 프레임워크 없음.
//   실행: node --test packages/runner-core/test/reconnect-race.test.js
//
// 배경(2026-07 다섯 번 넘게 재발한 버그): 구 아키텍처(공유 풀 window + 기기별 뷰 세션 link-window +
//   리퍼)는 "can't find window/session" 레이스를 구조적으로 품고 있었다 — 앱 업데이트(90s+ idle)마다
//   리퍼가 뷰 세션을 지워 재attach 가 터졌고, 재시도/지연/하드캡은 전부 증상 패치였다.
// 신 아키텍처: 터미널 = 전용 세션 "<ns>--t-<tid>"(durable, 리퍼 절대 불가침). attach 대상이 곧
//   실체라 중간 상태가 없다. 이 테스트는 (1) 구 실패 모드가 tmux 수준에서 실재함을 문서화하고,
//   (2) 신 모델에서는 리퍼가 아무리 공격적이어도(grace 0) 터미널이 절대 죽지 않음을,
//   (3) 앱 업데이트/강제종료 시나리오에서 내용까지 보존됨을, (4) 레거시 풀 마이그레이션이 실행 중인
//   셸을 무손실 승격함을 증명한다.
//
// 안전: 반드시 CODINGPT_TMUX_SOCKET 로 "격리 소켓"을 강제한 뒤 pty.js 를 require 한다 —
//   사용자 실사용 `-L codingpt` 세션은 절대 건드리지 않는다. teardown 에서 이 소켓 서버만 kill.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// ── 격리 소켓 강제(require 전에!) ──
const SOCK = `codingpt-recon-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-recon-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '테스트가 격리 소켓을 못 잡았다(실사용 소켓 오염 위험) — 중단');

// 워크스페이스 = ROOT/ws1 (홈 jail 안 상대경로 'ws1' → ns 'cpt-ws1')
const WS_REL = 'ws1';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });
const { session: NS, abs: ABS } = pty.sessionForCwd(WS_REL);

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

after(async () => {
  // 격리 소켓 서버만 종료 — 실사용 소켓 무접촉.
  try { await tmux(['kill-server']); } catch (_) { /* 이미 없음 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// (문서화) 구 실패 모드가 tmux 수준에서 실재함 — 사라진 세션에 link/attach 하면 그 에러가 난다.
//  신 모델은 "사라진 세션 = 사용자가 닫음" 이라는 결정적 의미만 남긴다(레이스로는 절대 못 사라짐).
test('구 증상 재현: 없는 세션 대상 link-window 는 can\'t find 로 터진다', { skip: !hasTmux }, async () => {
  const t = await pty.createTerminal(NS, ABS); // 서버/첫 터미널 기동
  await assert.rejects(
    () => tmux(['link-window', '-s', `=${t.session}:0`, '-t', `=${NS}--p-ghost:0`]),
    /can't find session|can't find window/i,
  );
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t.index });
});

// (핵심 불변식 1) 터미널 세션은 리퍼가 grace 0(최악)으로 아무리 돌아도 절대 죽지 않는다.
//  구 모델 재발 시나리오 = "앱 업데이트로 90s+ idle → startup reap 이 뷰 세션 킬" — grace 0 리퍼는
//  그 시나리오의 상위집합(모든 idle 시간에 대해 최악)이다.
test('리퍼 불가침: reapStaleViews(0) 연사에도 터미널 세션 생존 + ID 불변', { skip: !hasTmux }, async () => {
  const a = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const b = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  let rejected = 0;
  for (let round = 0; round < 60; round++) {
    // 재접속(resolveTid)과 동시에 리퍼가 무작위 시점(0~25ms)에 grace 0 으로 발화.
    const killer = (async () => { await sleep(Math.floor(Math.random() * 25)); await pty.reapStaleViews(0); })();
    const r = await Promise.allSettled([pty.resolveTid(NS, a.index)]);
    await killer;
    if (r[0].status === 'rejected') rejected += 1;
    else assert.strictEqual(r[0].value, a.index, '폴백 없이 요청한 그 터미널이어야 함(ID 안정)');
  }
  assert.strictEqual(rejected, 0, `resolveTid ${rejected}/60 reject — 신 모델에서 있을 수 없는 일`);
  // 두 터미널 모두 생존.
  const list = await pty.listTerminals(NS);
  const ids = list.map((t) => t.index);
  assert.ok(ids.includes(a.index) && ids.includes(b.index), '리퍼가 터미널을 건드렸다');
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: a.index });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: b.index });
});

// (핵심 불변식 2) 앱 업데이트/강제종료 시나리오 — 클라이언트 전무 + 공격적 리퍼 후에도
//  터미널 목록과 "실행 중이던 내용"이 그대로 복원된다.
test('업데이트 시나리오: 무클라이언트+리퍼 이후 목록/내용 보존(재attach 대상 그대로)', { skip: !hasTmux }, async () => {
  const t1 = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const t2 = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const MARK = `mark-${Date.now()}`;
  await tmux(['send-keys', '-t', `=${pty.termSession(NS, t1.index)}:0`, '-l', '--', `echo ${MARK}`]);
  await tmux(['send-keys', '-t', `=${pty.termSession(NS, t1.index)}:0`, 'Enter']);
  await sleep(400);
  // "앱이 죽어 있던 시간" 동안 리퍼가 여러 번 돈다(grace 0 = 90s idle 판정의 최악 상위집합).
  for (let i = 0; i < 5; i++) await pty.reapStaleViews(0);
  // "재기동": 목록 재조회 → 두 터미널 그대로, 내용도 그대로.
  const list = await pty.listTerminals(NS);
  const ids = list.map((x) => x.index);
  assert.ok(ids.includes(t1.index) && ids.includes(t2.index), '업데이트 후 터미널이 사라졌다');
  const cap = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, t1.index)}:0`, '-S', '-50']);
  assert.ok(cap.includes(MARK), '터미널 내용(실행 이력)이 보존되지 않았다');
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t1.index });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t2.index });
});

// (핵심 불변식 3) 닫기 = 완전 소멸(멱등) — 목록/세션에서 사라지고, 스테일 tid 는 첫 터미널로 폴백만
//  (부활 금지), 터미널이 하나도 없으면 새로 생성.
test('close=완전 소멸(멱등) + 스테일 tid 폴백/무터미널 생성', { skip: !hasTmux }, async () => {
  const t1 = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const t2 = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t2.index });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t2.index }); // 멱등
  await assert.rejects(() => tmux(['has-session', '-t', '=' + pty.termSession(NS, t2.index)]));
  const ids = (await pty.listTerminals(NS)).map((x) => x.index);
  assert.ok(!ids.includes(t2.index) && ids.includes(t1.index));
  // 스테일 tid → 살아있는 첫 터미널로 폴백(t2 부활 금지).
  const resolved = await pty.resolveTid(NS, t2.index);
  assert.strictEqual(resolved, t1.index);
  assert.ok(!(await pty.listTerminals(NS)).map((x) => x.index).includes(t2.index), '닫은 터미널이 부활했다');
  // 전부 닫으면 resolve 는 null — 재접속/select 가 유령을 "생성"하지 않는다(0개 = 정식 상태).
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t1.index });
  assert.strictEqual(await pty.resolveTid(NS, undefined), null);
  assert.strictEqual((await pty.listTerminals(NS)).length, 0, 'resolve 가 유령 터미널을 만들었다');
  const sel = await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: t1.index, paneId: 'pz', client: 'cz' });
  assert.deepStrictEqual(sel, { ok: true });
  assert.strictEqual((await pty.listTerminals(NS)).length, 0, 'select 가 유령 터미널을 만들었다');
});

// (마이그레이션) 레거시 풀(cpt-<ws> window 들) → 전용 세션 무손실 승격: 실행 중 셸 보존(내용 검증),
//  원래 순서 보존, 풀 세션 소멸, 승격된 터미널은 리퍼 불가침.
test('레거시 풀 마이그레이션: 셸 무손실 승격 + 순서 보존 + 풀 소멸', { skip: !hasTmux }, async () => {
  const WS2 = 'ws2';
  fs.mkdirSync(path.join(ROOT, WS2), { recursive: true });
  const { session: NS2, abs: ABS2 } = pty.sessionForCwd(WS2);
  // 구 아키텍처 그대로 풀 구성: 세션 + window 3개, 두 번째에 마커.
  await tmux(['new-session', '-d', '-s', NS2, '-c', ABS2]);
  await tmux(['new-window', '-d', '-t', `=${NS2}:1`, '-c', ABS2]);
  await tmux(['new-window', '-d', '-t', `=${NS2}:2`, '-c', ABS2]);
  const MARK = `legacy-${Date.now()}`;
  await tmux(['send-keys', '-t', `=${NS2}:1`, '-l', '--', `echo ${MARK}`]);
  await tmux(['send-keys', '-t', `=${NS2}:1`, 'Enter']);
  await sleep(400);
  // 구 모델의 resize-window manual 잔재도 재현(마이그레이션이 latest 로 복귀시켜야 함).
  await tmux(['resize-window', '-t', `=${NS2}:1`, '-x', '80', '-y', '24']);

  await pty.migrateLegacyPool(NS2, ABS2);

  // 풀 세션은 소멸(모든 window 가 전용 세션으로 이주).
  await assert.rejects(() => tmux(['has-session', '-t', '=' + NS2]), /can't find session/i);
  const list = await pty.listTerminals(NS2);
  assert.strictEqual(list.length, 3, `풀 window 3개가 전부 승격돼야 함(실제 ${list.length})`);
  // 순서 보존: tid 오름차순(생성순) = 원래 index 순 — 마커는 두 번째 터미널에 있어야 한다.
  const cap = await tmux(['capture-pane', '-p', '-t', `=${list[1].session}:0`, '-S', '-50']);
  assert.ok(cap.includes(MARK), '마이그레이션이 셸 내용/순서를 보존하지 못했다');
  // manual 잔재 해제 확인 — window-size 가 세션 로컬 manual 로 남아있지 않아야 한다.
  const wsMode = (await tmux(['show-options', '-wv', '-t', `=${list[1].session}:0`, 'window-size']).catch(() => '')).trim();
  assert.notStrictEqual(wsMode, 'manual', '마이그레이션 후에도 window-size manual 잔재');
  // 승격된 터미널도 리퍼 불가침.
  await pty.reapStaleViews(0);
  assert.strictEqual((await pty.listTerminals(NS2)).length, 3);
  // 멱등: 재호출해도 변화 없음.
  await pty.migrateLegacyPool(NS2, ABS2);
  assert.strictEqual((await pty.listTerminals(NS2)).length, 3);
  for (const t of await pty.listTerminals(NS2)) await pty.handleTerminalRpc('terminal.close', { cwd: WS2, index: t.index });
});

// (레거시 청소 유지) 구 뷰 세션(--p-/--v-/--c-)은 여전히 리퍼가 정리한다 — 신 모델로 넘어온 뒤
//  소켓에 남은 구 잔재가 무한 누적되지 않게.
test('레거시 뷰 세션은 리퍼가 정리, 터미널 세션은 무접촉', { skip: !hasTmux }, async () => {
  const t = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const legacy = pty.paneSession(NS, 'pOld', 'cOld');
  await tmux(['new-session', '-d', '-s', legacy, '-c', ABS]);
  const reaped = await pty.reapStaleViews(0);
  assert.ok(reaped >= 1, '레거시 뷰 세션이 정리되지 않았다');
  await assert.rejects(() => tmux(['has-session', '-t', '=' + legacy]));
  await tmux(['has-session', '-t', '=' + pty.termSession(NS, t.index)]); // 터미널은 생존
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t.index });
});

// (RPC 계약) terminal.list 응답 스키마/정렬 — 앱·PC 리컨실러가 소비하는 형태 그대로.
test('terminal.list: {windows:[{index,name,command}]} 생성순 정렬 + select 폴백 계약', { skip: !hasTmux }, async () => {
  const a = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  await sleep(1100); // session_created 초 단위 — 생성순 정렬 검증 위해 초 경계 확보
  const b = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const r = await pty.handleTerminalRpc('terminal.list', { cwd: WS_REL });
  assert.ok(Array.isArray(r.windows) && r.windows.length === 2);
  assert.deepStrictEqual(r.windows.map((w) => w.index), [a.index, b.index], '생성순 정렬이 깨졌다');
  for (const w of r.windows) {
    assert.strictEqual(typeof w.index, 'number');
    assert.ok(w.index >= 1000000 && w.index <= 0x7fffffff, '31-bit 안정 ID 범위 위반(|0 경유 안전성)');
  }
  // select: 살아있는 tid 는 그대로, 스테일은 첫 터미널 폴백(ok+index 반환 계약).
  const s1 = await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: b.index, paneId: 'p1', client: 'c1' });
  assert.deepStrictEqual({ ok: s1.ok, index: s1.index }, { ok: true, index: b.index });
  const s2 = await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: 424242, paneId: 'p1', client: 'c1' });
  assert.strictEqual(s2.index, a.index);
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: a.index });
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: b.index });
});
