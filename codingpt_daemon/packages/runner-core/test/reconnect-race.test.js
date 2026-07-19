// 터미널 재연결 무한루프 재현/회귀 테스트 — node 내장 러너(node --test), 외부 프레임워크 없음.
//   실행: node --test packages/runner-core/test/reconnect-race.test.js
//
// 배경(2026-07 반복 재발한 버그): PC 앱 강제종료→재접속 시 다른 데몬/리퍼가 뷰 세션(psess)을
//   재사용 직전에 지우면 ensureView 의 link/select 가 `can't find session` 으로 터지고, 그 에러가
//   호출측(앱)으로 튀어 무한 재연결 루프가 됐다. Fix = ensureView 가 뷰 세션 재생성 후 재시도(멱등)로
//   레이스를 흡수. 이 테스트는 그 레이스를 격리 소켓에서 실제로 일으켜 회귀를 못 나게 못박는다.
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

const SESSION = 'cpt-recon';
const PSESS = pty.paneSession(SESSION, 'pTest', 'cTest');
const ABS = ROOT;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}
const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();

before(async () => {
  if (!hasTmux) return;
  await pty.ensurePool(SESSION, ABS);           // 풀 세션 + window 0
  await pty.ensureView(PSESS, SESSION, 0, ABS); // 뷰 세션 최초 확립
});

after(async () => {
  // 격리 소켓 서버만 종료 — 실사용 소켓 무접촉.
  try { await tmux(['kill-server']); } catch (_) { /* 이미 없음 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// (문서화) 옛 실패 모드가 실재함을 증명 — has-session 통과 직후 psess 가 사라지면 link 가 던진다.
test('레이스: psess 가 사라지면 raw link-window 는 can\'t find session 으로 터진다(옛 증상)', { skip: !hasTmux }, async () => {
  await tmux(['kill-session', '-t', '=' + PSESS]).catch(() => {});
  await assert.rejects(
    () => tmux(['link-window', '-s', `=${SESSION}:0`, '-t', `=${PSESS}:0`]),
    /can't find session|can't find window/i,
    '옛 코드가 던지던 바로 그 에러가 재현되어야 함',
  );
});

// (핵심 회귀 가드) psess 가 통째로 사라진 상태에서 ensureView 는 던지지 않고 복구한다(재생성).
test('ensureView 는 psess 가 없으면 재생성해 복구한다(에러 전파 안 함)', { skip: !hasTmux }, async () => {
  await tmux(['kill-session', '-t', '=' + PSESS]).catch(() => {});
  const win = await pty.ensureView(PSESS, SESSION, 0, ABS); // 던지면 테스트 실패
  assert.strictEqual(typeof win, 'number');
  await tmux(['has-session', '-t', '=' + PSESS]); // 살아있어야(복구 완료)
});

// (현실 리퍼 모델) 실제 reapStaleViews 는 스테일 psess 를 "한 번" 지운다 — 재생성된 psess 는
//   활동이 신선(idle grace 90s)해 곧바로 또 죽이지 않는다. 그래서 현실 레이스 = "재접속과 거의
//   동시에 리퍼가 psess 를 1회 킬". 이 모델에서 ensureView 는 매번 복구(재생성)해야 한다.
//   주의: 지속적으로(수십 ms마다) 무한히 죽이는 리퍼는 비현실적이고, 그 경우 어떤 데몬측 재시도도
//   못 이긴다 → 그건 클라이언트 하드캡(무한루프 UI 차단)이 잡는다. 여기선 데몬의 현실 내성만 검증.
test('현실 리퍼(재접속당 1회 킬) 60라운드 — ensureView 항상 복구, reject 0건', { skip: !hasTmux }, async () => {
  let rejected = 0;
  for (let round = 0; round < 60; round++) {
    // 재접속(ensureView)과 거의 동시에 리퍼가 psess 를 한 번 지운다(0~25ms 사이 무작위 시점).
    const killAt = Math.floor(Math.random() * 25);
    const killer = (async () => {
      await new Promise((r) => setTimeout(r, killAt));
      await tmux(['kill-session', '-t', '=' + PSESS]).catch(() => {});
    })();
    const r = await Promise.allSettled([pty.ensureView(PSESS, SESSION, 0, ABS)]);
    await killer;
    if (r[0].status === 'rejected') rejected += 1;
    // 다음 라운드가 "psess 살아있음" 에서 시작하게 보정(현실: 클라이언트가 붙어 활동 갱신).
    await pty.ensureView(PSESS, SESSION, 0, ABS).catch(() => {});
  }
  assert.strictEqual(rejected, 0, `ensureView 가 ${rejected}/60 reject — 현실 리퍼 레이스도 못 견딤(무한루프 재발)`);
});
