// 터미널 매니페스트(재부팅 복원) — 격리 소켓의 **실 tmux** 로 "서버 소멸 → 데몬 기동" 을 재현한다.
//  계약(terminal-manifest.js 머리 주석):
//   · 만든 터미널은 즉시 기록되고, 재부팅(kill-server 로 흉내) 뒤 데몬 기동 시 **같은 tid·워크스페이스 env·
//     시작 폴더·수동 이름** 으로 되살아난다.
//   · terminal.close 로 닫은 터미널은 되살아나지 않는다.
//   · 데몬 수명 중(살아 있는 걸 본 뒤) 서버가 사라지면 "전부 닫힘" 으로 보고 기록을 비운다.
//   · 서버가 살아 있으면(데몬만 재시작) 아무것도 만들지 않는다.
//  실행: node --test packages/runner-core/test/terminal-manifest.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOCK = `codingpt-manifest-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;
delete process.env.CPT_TERMHOST_SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-manifest-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });
const WS = path.join(ROOT, 'proj', 'alpha');
const SUB = path.join(WS, 'src');
fs.mkdirSync(SUB, { recursive: true });

const ptyLib = require('../pty');
const backend = require('../term-backend');
assert.strictEqual(ptyLib.TMUX_SOCKET, SOCK, '격리 소켓 미적용 — 중단');

const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();
const skip = !hasTmux || process.platform === 'win32';

// "데몬 새로 기동" = 모듈 상태(seenAlive) 초기화 → require 캐시를 비우고 다시 읽는다.
function freshManifest() {
  delete require.cache[require.resolve('../terminal-manifest')];
  return require('../terminal-manifest');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = async () => (await backend.list()).map((r) => r.name).sort();
const tmux = (args) => ptyLib.runTmux(args);

after(async () => {
  try { await backend.killServer(); } catch (_) { /* noop */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

test('재부팅 복원 — 만든 터미널이 같은 tid·env·시작폴더·이름으로 되살아난다', { skip }, async () => {
  const manifest = freshManifest();
  const { session: ns, abs } = ptyLib.sessionForCwd(path.relative(ROOT, WS));
  assert.strictEqual(abs, WS);
  const a = await ptyLib.createTerminal(ns, abs);
  const b = await ptyLib.createTerminal(ns, abs);
  // b 는 수동 이름 + 하위 폴더로 이동(사용자가 cd 한 상태를 흉내)
  await tmux(['rename-window', '-t', `=${b.session}:0`, '작업중']);
  await tmux(['send-keys', '-t', `=${b.session}:0`, `cd ${SUB}`, 'Enter']);
  // 셸이 실제로 이동할 때까지(pane_current_path) 기다린다 — 셸 기동 속도는 환경마다 다르다.
  const t0 = Date.now();
  for (;;) {
    const cur = String(await tmux(['display-message', '-p', '-t', `=${b.session}:0`, '#{pane_current_path}'])).trim();
    if (cur && fs.realpathSync(cur) === fs.realpathSync(SUB)) break;
    // 전체 스위트 병렬 실행 땐 tmux 서버 여러 개 + zsh 기동이 겹쳐 수 초 걸린다 — 넉넉히 기다린다.
    if (Date.now() - t0 > 30000) throw new Error('셸이 하위 폴더로 이동하지 않았다: ' + cur);
    await sleep(100);
  }
  await manifest.sync();
  const saved = manifest.load();
  assert.deepStrictEqual(saved.map((t) => t.session).sort(), [a.session, b.session].sort(), '두 터미널이 기록되지 않았다');
  const sb = saved.find((t) => t.session === b.session);
  assert.strictEqual(sb.cwd, WS, '워크스페이스 루트가 아니다');
  assert.strictEqual(fs.realpathSync(sb.path), fs.realpathSync(SUB), '마지막 폴더(pane_current_path)가 기록되지 않았다');
  assert.strictEqual(sb.name, '작업중'); assert.strictEqual(sb.manualName, true);

  // ── 재부팅 흉내: tmux 서버 소멸 + 데몬 새로 기동 ──
  await backend.killServer();
  assert.deepStrictEqual(await names().catch(() => []), []);
  const booted = freshManifest();
  const n = await booted.restoreIfNeeded();
  assert.strictEqual(n, 2, `되살린 개수 ${n} ≠ 2`);
  assert.deepStrictEqual(await names(), [a.session, b.session].sort(), '세션명(tid)이 그대로 되살아나지 않았다');
  // env(워크스페이스 좌표)·시작 폴더·수동 이름
  const env = String(await tmux(['show-environment', '-t', `=${b.session}`, 'CPT_TID'])).trim();
  assert.strictEqual(env, `CPT_TID=${b.index}`);
  const wsEnv = String(await tmux(['show-environment', '-t', `=${b.session}`, 'CPT_WS'])).trim();
  assert.strictEqual(wsEnv, `CPT_WS=${path.relative(ROOT, WS)}`);
  const row = String(await tmux(['list-windows', '-t', `=${b.session}`, '-F', '#{window_name}\t#{pane_current_path}'])).trim();
  const [wname, wpath] = row.split('\t');
  assert.strictEqual(wname, '작업중', '수동 이름이 복원되지 않았다');
  assert.strictEqual(fs.realpathSync(wpath), fs.realpathSync(SUB), '시작 폴더가 마지막 폴더가 아니다');
  // listTerminals(전 기기 목록의 원천)에도 같은 tid 로 나타난다 — 저장된 레이아웃이 그대로 맞물리는 근거.
  const list = await ptyLib.listTerminals(ns);
  assert.deepStrictEqual(list.map((t) => t.index).sort(), [a.index, b.index].sort());
  // 서버가 살아 있는 상태에서 다시 부르면 아무것도 안 만든다(데몬만 재시작한 경우).
  assert.strictEqual(await freshManifest().restoreIfNeeded(), 0);
});

test('닫은 터미널은 되살아나지 않는다 — terminal.close 는 즉시 잊는다', { skip }, async () => {
  const manifest = freshManifest();
  const { session: ns, abs } = ptyLib.sessionForCwd(path.relative(ROOT, WS));
  await manifest.sync();
  const before = await ptyLib.listTerminals(ns);
  assert.strictEqual(before.length, 2);
  const victim = before[0];
  await ptyLib.handleTerminalRpc('terminal.close', { cwd: path.relative(ROOT, WS), index: victim.index });
  assert.ok(!manifest.load().some((t) => t.session === victim.session), '닫은 터미널이 매니페스트에 남아 있다');
  await backend.killServer();
  const n = await freshManifest().restoreIfNeeded();
  assert.strictEqual(n, 1);
  const after_ = await ptyLib.listTerminals(ns);
  assert.deepStrictEqual(after_.map((t) => t.index), [before[1].index], '닫은 터미널이 부활했다');
});

test('데몬 수명 중 서버가 사라지면(마지막 셸 exit 등) 기록을 비운다 — 재부팅 뒤 부활 금지', { skip }, async () => {
  const manifest = freshManifest();
  await manifest.sync();                       // 살아 있는 걸 봤다
  assert.strictEqual(manifest.load().length, 1);
  await backend.killServer();                  // 사용자가 마지막 터미널을 닫음
  await manifest.sync();
  assert.deepStrictEqual(manifest.load(), [], '전부 닫혔는데 기록이 남았다');
  assert.strictEqual(await freshManifest().restoreIfNeeded(), 0, '닫은 터미널이 재부팅 복원으로 부활했다');
});

test('갓 만든 터미널은 sync 를 기다리지 않고 기록된다', { skip }, async () => {
  const manifest = freshManifest();
  const { session: ns, abs } = ptyLib.sessionForCwd(path.relative(ROOT, WS));
  const t = await ptyLib.createTerminal(ns, abs);
  assert.ok(manifest.load().some((x) => x.session === t.session && x.cwd === WS));
});
