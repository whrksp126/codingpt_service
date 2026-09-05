// TerminalHost(v3 정본) 회귀 — 실제 tmux 에 control mode 로 붙어 검증한다.
//  설계 계약(docs/terminal-v3-design.md): 소유자 1명만 크기 결정 · 원시 바이트 통과(alt-screen/mouse) ·
//  VT == tmux 화면 · clear 로 과거 0 · seq 이어받기 · 퇴화 크기 거부.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const SOCK = `codingpt-v3-test-${process.pid}-${Date.now()}`;
const has = (bin) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const hasTmux = has('tmux');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONF = path.join(__dirname, '..', '..', '..', 'tmux.conf');

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}
const { TerminalHostRegistry } = require('../terminal-host');
const deps = { tmux: 'tmux', socket: SOCK, env: { ...process.env, LANG: 'en_US.UTF-8' }, runTmux };
const registry = new TerminalHostRegistry(deps);

after(async () => {
  registry.closeAll();
  try { await runTmux(['kill-server']); } catch (_) { /* noop */ }
});

async function newSession(name, cols = 80, rows = 24) {
  await runTmux(['-f', CONF, 'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), "PS1='P> ' bash --norc -i"]);
  await sleep(300);
}
const winSize = async (name) => String(await runTmux(['display-message', '-p', '-t', `=${name}:0`, '#{window_width}x#{window_height}'])).trim();
const collect = (host) => { const frames = []; host.subscribe((f) => frames.push(f)); return frames; };
const outText = (frames) => Buffer.concat(frames.filter((f) => f.type === 'output').map((f) => f.buf)).toString('utf8');
async function until(fn, ms = 4000) { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await sleep(60); } }

test('소유자만 크기를 정한다 — 비소유자 resize 는 window 를 못 바꾼다', { skip: !hasTmux }, async () => {
  await newSession('v3-own');
  const host = await registry.get('v3-own', { cols: 100, rows: 30 });
  await host.ready;
  assert.strictEqual(await winSize('v3-own'), '100x30', '컨트롤 클라이언트 단독이면 window 가 요청 크기여야 한다');
  await host.claim({ deviceId: 'pc', name: 'MacBook' });
  assert.strictEqual(await host.resize(48, 21, 'phone'), false, '비소유자 resize 가 받아들여졌다');
  assert.strictEqual(await winSize('v3-own'), '100x30', '비소유자 resize 가 window 를 바꿨다');
  assert.strictEqual(await host.resize(179, 45, 'pc'), true);
  assert.ok(await until(async () => (await winSize('v3-own')) === '179x45'), '소유자 resize 가 window 에 반영되지 않았다');
  // 소유권 이전 → 폰이 크기를 잡는다.
  await host.claim({ deviceId: 'phone', name: 'Galaxy' });
  assert.strictEqual(await host.resize(48, 21, 'phone'), true);
  assert.ok(await until(async () => (await winSize('v3-own')) === '48x21'));
  // 퇴화 크기는 소유자여도 거부.
  assert.strictEqual(await host.resize(2, 1, 'phone'), false);
  assert.strictEqual(await winSize('v3-own'), '48x21');
  // 소유자는 재시작에도 남는다(window 옵션).
  const saved = JSON.parse(String(await runTmux(['show-options', '-wv', '-t', '=v3-own:0', '@cpt_owner'])).trim());
  assert.strictEqual(saved.deviceId, 'phone');
  host.close();
});

test('구 v2 클라가 window-size 를 manual 로 박아도 소유자 크기가 이긴다', { skip: !hasTmux }, async () => {
  await newSession('v3-manual');
  const host = await registry.get('v3-manual', { cols: 100, rows: 30 });
  await host.ready;
  await host.claim({ deviceId: 'pc', name: 'PC' });
  // v2 경로(pty.js 의 resize-window)가 하는 짓 그대로 — 이 한 번으로 window-size 가 manual 로 굳는다.
  //  이 상태에서 refresh-client -C 는 영구히 무시되므로, 소유자 resize 는 resize-window 로 주장해야 한다.
  await runTmux(['resize-window', '-t', '=v3-manual:0', '-x', '90', '-y', '24']);
  assert.strictEqual(String(await runTmux(['display-message', '-p', '-t', '=v3-manual:0', '#{window-size}'])).trim(), 'manual');
  assert.strictEqual(await host.resize(129, 40, 'pc'), true);
  assert.ok(await until(async () => (await winSize('v3-manual')) === '129x40'),
    `manual 로 굳은 window 를 소유자가 되찾지 못했다: ${await winSize('v3-manual')}`);
  host.close();
});

test('원시 바이트가 그대로 온다 — alt-screen·마우스 모드가 뷰어에 도달하고 VT 도 안다', { skip: !hasTmux }, async () => {
  await newSession('v3-raw');
  const host = await registry.get('v3-raw', { cols: 80, rows: 24 });
  await host.ready;
  const frames = collect(host);
  const script = path.join(os.tmpdir(), `cpt-v3-alt-${process.pid}.sh`);
  fs.writeFileSync(script, "printf '\\033[?1049h\\033[?1000h\\033[?1006hALT'; sleep 0.6; printf '\\033[?1006l\\033[?1000l\\033[?1049l'\n");
  await host.input(`bash ${script}\r`);
  assert.ok(await until(() => outText(frames).includes('\x1b[?1049h')), 'alt-screen 진입 시퀀스가 뷰어에 안 왔다');
  await until(() => outText(frames).includes('\x1b[?1006h'));
  await host.screen.flush();
  assert.strictEqual(host.modes().altScreen, true, 'VT 가 alt-screen 을 모른다');
  assert.strictEqual(host.modes().mouseTracking, true, 'VT 가 mouse tracking 을 모른다');
  assert.ok(await until(() => outText(frames).includes('\x1b[?1049l')), 'alt-screen 탈출이 안 왔다');
  await sleep(200); await host.screen.flush();
  assert.strictEqual(host.modes().altScreen, false);
  // 한글 다중바이트도 깨지지 않는다.
  await host.input('echo 가나다 hello\r');
  assert.ok(await until(() => outText(frames).includes('가나다 hello')), '한글 출력이 깨졌다');
  host.close();
});

test('VT 화면 == tmux 화면 — 리사이즈를 반복해도 같다', { skip: !hasTmux }, async () => {
  await newSession('v3-eq');
  const host = await registry.get('v3-eq', { cols: 80, rows: 24 });
  await host.ready;
  await host.claim({ deviceId: 'a', name: 'A' });
  await host.input('seq 1 120\r');
  await until(() => host.screen.captureText().includes('120'));
  for (const [c, r] of [[60, 20], [120, 40], [48, 21], [80, 24]]) {
    await host.resize(c, r, 'a');
    await sleep(350);
  }
  await sleep(300); await host.screen.flush();
  const tmuxScreen = String(await runTmux(['capture-pane', '-p', '-t', '=v3-eq:0'])).replace(/\s+$/, '');
  const vtScreen = host.screen.captureText().replace(/\s+$/, '');
  assert.strictEqual(vtScreen, tmuxScreen, 'VT 와 tmux 화면이 다르다');
  host.close();
});

test('clear 는 과거를 정말 비우고, 과거 페이지는 offset 연속이다', { skip: !hasTmux }, async () => {
  await newSession('v3-hist');
  const host = await registry.get('v3-hist', { cols: 80, rows: 24 });
  await host.ready;
  await host.input('seq 1 200 | sed "s/^/L /"\r');
  await until(async () => (await host.historyPage({ limit: 1 })).total > 150);
  const whole = await host.historyPage({ limit: 500 });
  const tail = await host.historyPage({ limit: 60 });
  const head = await host.historyPage({ before: tail.start, limit: 60 });
  assert.strictEqual(head.end, tail.start);
  assert.deepStrictEqual([...head.rows, ...tail.rows].map((r) => r.offset), Array.from({ length: 120 }, (_, i) => whole.total - 120 + i));
  assert.ok(tail.rows.every((r) => typeof r.ansi === 'string'));
  await host.input('clear\r');
  assert.ok(await until(async () => (await host.historyPage({ limit: 1 })).total === 0), 'clear 뒤에도 과거가 남았다');
  host.close();
});

test('재접속 이어받기 — 링버퍼 안이면 seq 부터, 밖이면 스냅샷', { skip: !hasTmux }, async () => {
  await newSession('v3-seq');
  const host = await registry.get('v3-seq', { cols: 80, rows: 24 });
  await host.ready;
  const frames = collect(host);
  await host.input('echo one\r');
  await until(() => frames.some((f) => f.type === 'output'));
  const mid = host.seq;
  await host.input('echo two\r');
  await until(() => outText(frames).includes('two'));
  const replay = host.replaySince(mid);
  assert.ok(Array.isArray(replay) && replay.length > 0 && replay[0].seq === mid + 1, '이어받기 seq 가 어긋난다');
  assert.ok(Buffer.concat(replay.map((r) => r.buf)).toString().includes('two'));
  assert.deepStrictEqual(host.replaySince(host.seq), [], '최신이면 빈 배열');
  assert.strictEqual(host.replaySince(-5), null, '링버퍼 밖(seq 0 이전)은 스냅샷 요구');
  // ★ 데몬이 재시작하면 새 host 의 seq 는 0 부터다. 그때 옛 뷰어가 큰 lastSeq 로 hello 하면
  //   "너는 최신"으로 오판해 아무것도 안 보내고, 화면이 **영원히 멈춘다**(2026-09-06 실기 사고).
  assert.strictEqual(host.replaySince(host.seq + 500), null, '정본보다 앞선 seq 는 스냅샷 요구');
  // 세대(epoch)가 다르면 seq 가 우연히 맞아도 이어붙이면 안 된다 — 다른 화면의 조각이다.
  assert.ok(host.epoch && typeof host.epoch === 'string', 'host 에 세대 식별자가 없다');
  assert.strictEqual(host.replaySince(host.seq - 1, 'other-epoch'), null, '다른 세대는 스냅샷 요구');
  assert.ok(Array.isArray(host.replaySince(host.seq - 1, host.epoch)), '같은 세대는 이어받기');
  const snap = await host.snapshot();
  assert.strictEqual(snap.cols, 80); assert.strictEqual(snap.rows, 24);
  assert.ok(snap.ansi.includes('two') || snap.ansi.includes('P>'), '스냅샷에 화면이 없다');
  host.close();
});

test('세션이 죽으면 exit 프레임이 오고 레지스트리에서 빠진다', { skip: !hasTmux }, async () => {
  await newSession('v3-exit');
  const host = await registry.get('v3-exit', { cols: 80, rows: 24 });
  await host.ready;
  const frames = collect(host);
  await host.input('exit\r');
  assert.ok(await until(() => frames.some((f) => f.type === 'exit'), 6000), 'exit 프레임이 안 왔다');
  assert.strictEqual(registry.has('v3-exit'), false);
});
