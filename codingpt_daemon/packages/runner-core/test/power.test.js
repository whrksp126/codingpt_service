'use strict';
// F4 PC 깨어 있기(power.js) — automation-design §6 · §9.1.
//  exec/execSync/spawn/kill 전부 주입 스텁 — 실제 caffeinate·pmset·sudo·osascript·launchctl 호출 0 건.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-power-')));
const STATE = path.join(ROOT, '.codingpt');
fs.mkdirSync(STATE, { recursive: true });
delete process.env.CPT_POWER;
const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude'), platform: 'darwin' });

const power = require('../power');
const I = power._internals;

// ── 스텁 ─────────────────────────────────────────────────────────────────────
let clock = 1790000000000;
let reasons = [];
let battery = false;
let sudoOk = true;
let osaReply = () => ({ ok: true, code: 0, out: '', err: '' });
let syncReply = {};
const calls = { exec: [], sync: [], spawn: [], kill: [], frames: [], back: [], notify: [] };
const children = [];
function fakeChild() {
  const listeners = {};
  const c = {
    pid: 7000 + children.length, exitCode: null, killed: false,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return c; },
    kill(sig) { c.killed = true; c.exitCode = 0; calls.kill.push({ pid: c.pid, sig, via: 'child' }); for (const fn of listeners.exit || []) fn(0); return true; },
  };
  children.push(c);
  return c;
}
function wire(extra = {}) {
  power.configure({
    platform: 'darwin',
    now: () => clock,
    modules: [{ activeReasons: () => reasons }],
    tasks: { addChangeListener: () => () => {} },
    agentState: { subscribe: () => () => {} },
    installExitHooks: false,
    username: () => 'devuser',
    hostName: () => 'MacBook',
    deviceId: () => 12,
    log: () => {},
    notify: (x) => calls.notify.push(x),
    sendControl: (f) => calls.frames.push(f),
    backFetch: async (m, p, b) => { calls.back.push({ m, p, b }); return {}; },
    exec: async (bin, args, opts) => {
      calls.exec.push({ bin, args, opts });
      if (bin === '/usr/bin/pmset' && args[0] === '-g') return { ok: true, code: 0, out: battery ? "Now drawing from 'Battery Power'\n -InternalBattery-0 80%" : "Now drawing from 'AC Power'\n", err: '' };
      if (bin === '/usr/bin/sudo') return sudoOk ? { ok: true, code: 0, out: '', err: '' } : { ok: false, code: 1, out: '', err: 'sudo: a password is required' };
      if (bin === '/usr/bin/osascript') return osaReply(args);
      return { ok: false, code: 127, out: '', err: 'unexpected' };
    },
    execSync: (bin, args) => {
      calls.sync.push({ bin, args });
      const k = `${bin} ${args.join(' ')}`;
      for (const [re, v] of Object.entries(syncReply)) if (new RegExp(re).test(k)) return v;
      if (bin === '/bin/launchctl') return { status: 0, stdout: 'Aqua\n' };
      if (bin === '/usr/bin/pmset') return { status: 0, stdout: ' SleepDisabled\t\t0\n' };
      return { status: 0, stdout: '' };
    },
    spawn: (bin, args) => { calls.spawn.push({ bin, args }); return fakeChild(); },
    kill: (pid, sig) => { calls.kill.push({ pid, sig }); },
    timings: { idleMs: 120000, busyThrottleMs: 80, tickMs: 3600000, evalDebounceMs: 5 },
    ...extra,
  });
}
function reset() {
  power._internals._reset();
  try { fs.rmSync(I.stateFile(), { force: true }); } catch (_) { /* noop */ }
  for (const k of Object.keys(calls)) calls[k].length = 0;
  reasons = []; battery = false; sudoOk = true; syncReply = {};
  osaReply = () => ({ ok: true, code: 0, out: '', err: '' });
  wire();
}
beforeEach(reset);
after(async () => {
  await I._drain();
  power._internals._reset();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = () => I.evaluate();
const sudoCalls = () => calls.exec.filter((c) => c.bin === '/usr/bin/sudo').map((c) => c.args.join(' '));

// ══════════════════════════════════════════════════════════════════════════
test('활성 전이 즉시 → caffeinate -i -s -w <pid>(keepAwake 일 때만) · runner_busy · 120s 히스테리시스 뒤 비활성 → kill', async () => {
  await power.handleLocal('power.set', { keepAwake: true });
  assert.strictEqual(calls.spawn.length, 0, '유휴면 띄우지 않는다');
  reasons = ['task:t_aaaaaaaaaa'];
  let st = await ev();
  assert.strictEqual(st.active, true);
  assert.deepStrictEqual(st.reasons, ['task:t_aaaaaaaaaa']);
  assert.deepStrictEqual(calls.spawn, [{ bin: '/usr/bin/caffeinate', args: ['-i', '-s', '-w', String(process.pid)] }]);
  assert.deepStrictEqual(st.layers, { caffeinate: true, disableSleep: false });
  assert.deepStrictEqual(calls.frames.at(-1), { type: 'runner_busy', busy: true, awake: true, at: clock });
  assert.strictEqual(JSON.parse(fs.readFileSync(I.stateFile(), 'utf8')).caffeinatePid, children[0].pid);
  assert.strictEqual(fs.statSync(I.stateFile()).mode & 0o777, 0o600);
  await ev();
  assert.strictEqual(calls.spawn.length, 1, '살아 있으면 유지');
  reasons = [];
  await ev(); // 유휴 관찰 시작
  clock += 119000;
  st = await ev();
  assert.strictEqual(st.active, true, '119s — 아직 활성');
  assert.strictEqual(children[0].killed, false);
  clock += 1000;
  st = await ev();
  assert.strictEqual(st.active, false, '120s 연속 유휴 → 비활성');
  assert.strictEqual(children[0].killed, true);
  assert.deepStrictEqual(st.layers, { caffeinate: false, disableSleep: false });
  assert.strictEqual(JSON.parse(fs.readFileSync(I.stateFile(), 'utf8')).caffeinatePid, null);
  // 유휴 중 다시 활동이 생기면 idle 카운트가 리셋된다
  reasons = ['automation:a_x'];
  await ev();
  reasons = [];
  clock += 60000; await ev();
  reasons = ['dispatch:p_x']; clock += 1000; await ev();
  reasons = []; clock += 100000;
  assert.strictEqual((await ev()).active, true, '리셋된 유휴 창');
  assert.ok(sudoCalls().length === 0, 'lidClosed 꺼짐 — sudo 호출 없음');
});

test('runner_busy 10s 스로틀(테스트 80ms) — 창 안의 변화는 마지막 값 1건으로 뒤따라 보낸다 · helloFields', async () => {
  await power.handleLocal('power.set', { keepAwake: false });
  reasons = ['task:t_1'];
  await ev();
  assert.strictEqual(calls.frames.length, 1, '초기값(false/false)은 hello 가 실었다 — 첫 변화만 보낸다');
  assert.deepStrictEqual(power.helloFields(), { busy: true, awake: false });
  await power.handleLocal('power.set', { keepAwake: true }); // awake 변화 — 창 안
  assert.strictEqual(calls.frames.length, 1, '스로틀 창 안에서는 즉시 보내지 않는다');
  await sleep(150);
  assert.strictEqual(calls.frames.length, 2);
  assert.deepStrictEqual({ busy: calls.frames[1].busy, awake: calls.frames[1].awake }, { busy: true, awake: true });
  await ev();
  await sleep(120);
  assert.strictEqual(calls.frames.length, 2, '무변화는 보내지 않는다');
});

test('덮개 닫힘(층 B) — 미설정이면 lidBlocked:setup · AC 에서만 sudo -n pmset -a disablesleep 1 · 배터리면 battery · 비활성에 0 · sudo 실패 POWER_SUDO_MISSING', async () => {
  let r = await power.handleLocal('power.set', { lidClosed: true });
  assert.strictEqual(r.status.lidBlocked, 'setup');
  reasons = ['task:t_1'];
  await ev();
  assert.deepStrictEqual(sudoCalls(), [], '설정 전엔 sudo 를 부르지 않는다');
  // 설정 완료 상태로
  I.load().setupAt = clock; I.save();
  let st = await ev();
  assert.deepStrictEqual(sudoCalls(), ['-n /usr/bin/pmset -a disablesleep 1']);
  assert.strictEqual(st.layers.disableSleep, true);
  assert.strictEqual(st.power, 'ac');
  assert.strictEqual(st.setup, 'done');
  assert.strictEqual(JSON.parse(fs.readFileSync(I.stateFile(), 'utf8')).weSetDisableSleep, true);
  await sleep(120); // runner_busy 스로틀 창(테스트 80ms) 뒤 뒤따라 보낸다
  assert.deepStrictEqual(calls.frames.at(-1).awake, true);
  // 배터리로 바뀌면(캐시 만료 뒤) 끈다
  battery = true;
  clock += 31000;
  st = await ev();
  assert.strictEqual(st.lidBlocked, 'battery');
  assert.strictEqual(st.layers.disableSleep, false);
  assert.deepStrictEqual(sudoCalls().at(-1), '-n /usr/bin/pmset -a disablesleep 0');
  // AC 복귀 + 비활성 전이
  battery = false; clock += 31000; await ev();
  assert.strictEqual(sudoCalls().at(-1), '-n /usr/bin/pmset -a disablesleep 1');
  reasons = []; await ev(); clock += 120000; st = await ev();
  assert.strictEqual(st.active, false);
  assert.strictEqual(sudoCalls().at(-1), '-n /usr/bin/pmset -a disablesleep 0');
  assert.strictEqual(st.layers.disableSleep, false);
  // sudo 규칙이 사라짐
  sudoOk = false; reasons = ['task:t_2'];
  st = await ev();
  assert.strictEqual(st.lastError, 'POWER_SUDO_MISSING');
  assert.strictEqual(st.lidBlocked, 'sudo');
  assert.strictEqual(st.layers.disableSleep, false);
  assert.deepStrictEqual(Object.keys(st).sort(), [...power.STATUS_FIELDS].sort());
});

test('기동 복구 — 우리 caffeinate(이름 확인)만 kill · 우리가 켠 SleepDisabled 만 0 · 남이 켠 1 은 건드리지 않고 FOREIGN_DISABLESLEEP', async () => {
  fs.writeFileSync(I.stateFile(), JSON.stringify({ v: 1, keepAwake: true, lidClosed: true, setupAt: 1, weSetDisableSleep: true, caffeinatePid: 4242 }));
  power._internals._reset(); wire();
  syncReply = { '^/bin/ps ': { status: 0, stdout: '/usr/bin/caffeinate\n' }, '^/usr/bin/pmset -g$': { status: 0, stdout: ' SleepDisabled\t\t1\n' } };
  I.recoverOnStart();
  assert.deepStrictEqual(calls.kill, [{ pid: 4242, sig: 'SIGTERM' }]);
  assert.ok(calls.sync.some((c) => c.bin === '/usr/bin/sudo' && c.args.join(' ') === '-n /usr/bin/pmset -a disablesleep 0'));
  let saved = JSON.parse(fs.readFileSync(I.stateFile(), 'utf8'));
  assert.strictEqual(saved.weSetDisableSleep, false);
  assert.strictEqual(saved.caffeinatePid, null);
  // pid 재사용(다른 프로세스) — 죽이지 않는다 · 남이 켠 SleepDisabled
  fs.writeFileSync(I.stateFile(), JSON.stringify({ v: 1, lidClosed: true, setupAt: 1, weSetDisableSleep: false, caffeinatePid: 4343 }));
  power._internals._reset(); wire(); calls.kill.length = 0; calls.sync.length = 0;
  syncReply = { '^/bin/ps ': { status: 0, stdout: 'node\n' }, '^/usr/bin/pmset -g$': { status: 0, stdout: ' SleepDisabled\t\t1\n' } };
  I.recoverOnStart();
  assert.deepStrictEqual(calls.kill, []);
  assert.ok(!calls.sync.some((c) => c.bin === '/usr/bin/sudo'));
  reasons = ['task:t_1'];
  const st = await ev();
  assert.strictEqual(st.lastError, 'FOREIGN_DISABLESLEEP');
  assert.deepStrictEqual(sudoCalls(), [], '사용자가 켠 설정을 우리 것으로 삼지 않는다');
  saved = JSON.parse(fs.readFileSync(I.stateFile(), 'utf8'));
  assert.strictEqual(saved.weSetDisableSleep, false);
});

test('종료 훅(cleanupSync) — caffeinate kill + 우리가 켠 경우에만 동기 sudo 0 · start() 는 복구·구독만(실바이너리 0)', async () => {
  await power.handleLocal('power.set', { keepAwake: true, lidClosed: true });
  I.load().setupAt = clock; I.save();
  reasons = ['task:t_1'];
  await ev();
  assert.strictEqual(I.load().weSetDisableSleep, true);
  calls.sync.length = 0;
  power.cleanupSync();
  assert.ok(calls.kill.some((k) => k.pid === children.at(-1).pid && k.sig === 'SIGTERM'));
  assert.deepStrictEqual(calls.sync.map((c) => `${c.bin} ${c.args.join(' ')}`), ['/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0']);
  assert.strictEqual(JSON.parse(fs.readFileSync(I.stateFile(), 'utf8')).weSetDisableSleep, false);
  calls.sync.length = 0;
  power.cleanupSync();
  assert.deepStrictEqual(calls.sync, [], '켜지 않았으면 sudo 를 부르지 않는다');
  // start/stop
  power._internals._reset(); wire(); for (const k of Object.keys(calls)) calls[k].length = 0;
  power.start();
  await I._drain();
  power.stop();
  const bins = new Set([...calls.exec, ...calls.sync, ...calls.spawn].map((c) => c.bin));
  for (const b of bins) assert.ok(['/usr/bin/pmset', '/bin/ps', '/usr/bin/sudo', '/usr/bin/caffeinate'].includes(b), b);
});

test('1회 설정 — 계정 이름·GUI 검사, osascript(관리자 권한) 로 visudo -c + install 0440, 임시 파일 0600 내용, 검증 sudo -n, 취소·실패·해제', async () => {
  let seenTmp = null;
  osaReply = (args) => {
    const script = args[1];
    const m = /visudo -c -f (\S+) && \/usr\/bin\/install -o root -g wheel -m 0440 \1 \/etc\/sudoers\.d\/codingpt-pmset/.exec(script);
    if (m) {
      seenTmp = { path: m[1], body: fs.readFileSync(m[1], 'utf8'), mode: fs.statSync(m[1]).mode & 0o777 };
    }
    assert.match(script, /^do shell script ".*" with administrator privileges with prompt "CodingPT: 덮개를 닫아도 작업을 계속하도록 설정합니다"$/);
    return { ok: true, code: 0, out: '', err: '' };
  };
  const pending = power.handleLocal('power.setup', {});
  assert.strictEqual(power.status().setup, 'pending');
  assert.deepStrictEqual(await pending, { accepted: true });
  await I._drain();
  assert.ok(seenTmp, '설치 스크립트');
  assert.strictEqual(seenTmp.mode, 0o600);
  assert.strictEqual(seenTmp.body, '# CodingPT keep-awake (lid closed). Removable via CodingPT settings.\ndevuser ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n');
  assert.ok(!fs.existsSync(seenTmp.path), '임시 파일 삭제');
  assert.deepStrictEqual(sudoCalls(), ['-n /usr/bin/pmset -a disablesleep 0'], '검증 = sudo -n 통과');
  assert.strictEqual(power.status().setup, 'done');
  assert.ok(I.load().setupAt);
  // 취소
  osaReply = () => ({ ok: false, code: 1, out: '', err: '0:5: execution error: User canceled. (-128)' });
  await power.handleLocal('power.setup', {});
  await I._drain();
  assert.strictEqual(power.status().setup, 'failed');
  assert.strictEqual(power.status().setupError, 'POWER_SETUP_CANCELLED');
  // 실패(설치는 됐지만 sudo -n 불통)
  osaReply = () => ({ ok: true, code: 0, out: '', err: '' });
  sudoOk = false;
  await power.handleLocal('power.setup', {});
  await I._drain();
  assert.strictEqual(power.status().setupError, 'POWER_SETUP_FAILED');
  sudoOk = true;
  // 해제
  let removeScript = null;
  osaReply = (args) => { removeScript = args[1]; return { ok: true, code: 0, out: '', err: '' }; };
  await power.handleLocal('power.setup', { remove: true });
  await I._drain();
  assert.match(removeScript, /do shell script "\/bin\/rm -f \/etc\/sudoers\.d\/codingpt-pmset"/);
  assert.strictEqual(power.status().setup, 'none');
  assert.strictEqual(I.load().setupAt, null);
  // 전제 실패
  wire({ username: () => 'Bad User' });
  await assert.rejects(() => power.handleLocal('power.setup', {}), (e) => e.code === 'POWER_SETUP_FAILED');
  wire();
  syncReply = { '^/bin/launchctl': { status: 0, stdout: 'Background\n' } };
  await assert.rejects(() => power.handleLocal('power.setup', {}), (e) => e.code === 'POWER_NO_GUI');
});

test('power.event — 로컬 전용(릴레이 경로 BAD_PARAMS) · willSleep 활성이면 pc_sleeping(best effort) · 유휴면 없음 · 파라미터/플랫폼/킬스위치', async () => {
  await assert.rejects(() => power.handle('power.event', { kind: 'willSleep' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => power.handle('power.event', { kind: 'willSleep' }, { via: 'relay' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => power.handle('power.event', { kind: 'willSleep' }, { via: 'cli' }), (e) => e.code === 'BAD_PARAMS');
  assert.deepStrictEqual(await power.handle('power.event', { kind: 'didWake' }, { via: 'local' }), { ok: true }, 'cpt-server 소켓 meta');
  assert.deepStrictEqual(power.busyState(), power.helloFields());
  await assert.rejects(() => power.handleLocal('power.event', { kind: 'nap' }), (e) => e.code === 'BAD_PARAMS');
  assert.deepStrictEqual(await power.handleLocal('power.event', { kind: 'willSleep' }), { ok: true });
  assert.strictEqual(calls.back.length, 0, '유휴면 알림 없음');
  reasons = ['task:t_1', 'task:t_2', 'automation:a_1'];
  await power.handleLocal('power.event', { kind: 'willSleep' });
  await sleep(5);
  assert.strictEqual(calls.back.length, 1);
  assert.deepStrictEqual(calls.back[0].b, {
    source: 'system', kind: 'pc_sleeping', title: 'PC 가 잠자기에 들어가요', subtitle: 'MacBook · 작업 2개 진행 중',
    deeplink: 'codingpt://tasks?host=12', pushGate: 'ignore-pc-active', push: { data: { hostDeviceId: 12 } },
  });
  assert.deepStrictEqual(await power.handleLocal('power.event', { kind: 'didWake' }), { ok: true });
  await assert.rejects(() => power.handleLocal('power.set', { keepAwake: 'yes' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => power.handleLocal('power.nope', {}), (e) => e.code === 'BAD_PARAMS');
  const st = await power.handleLocal('power.status', {});
  assert.deepStrictEqual(Object.keys(st).sort(), [...power.STATUS_FIELDS].sort());
  assert.strictEqual(st.supported, true);
  assert.strictEqual(typeof power.handle, 'function');
  process.env.CPT_POWER = '0';
  try { assert.strictEqual(power.handle, undefined); } finally { delete process.env.CPT_POWER; }
  wire({ platform: 'linux' });
  assert.strictEqual(power.handle, undefined, 'darwin 외 = power.v1 미광고');
  await assert.rejects(() => power.handleLocal('power.status', {}), (e) => e.code === 'POWER_UNSUPPORTED');
  wire({ platform: 'darwin' });
});
