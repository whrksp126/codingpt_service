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

test('갓 만든 터미널은 과거가 0 이다 — 시드가 가짜 과거를 만들지 않는다', { skip: !hasTmux }, async () => {
  // 회귀(2026-09-10): tmux 는 history 가 비어 있어도 `capture-pane -S -10000 -E -1` 에 **현재 화면
  //  0행**을 돌려준다. 그걸 과거로 믿고 시드하면 새 터미널이 "프롬프트 1줄 + 빈 줄"짜리 과거를
  //  갖게 되고, 위로 스크롤하는 순간 뷰어가 라이브 화면을 가린 채 과거 화면으로 넘어간다.
  await newSession('v3-fresh');
  assert.strictEqual(String(await runTmux(['display-message', '-p', '-t', '=v3-fresh:0', '#{history_size}'])).trim(), '0');
  const host = await registry.get('v3-fresh', { cols: 80, rows: 24 });
  await host.ready;
  await host.screen.flush();
  assert.strictEqual((await host.historyPage({ limit: 500 })).total, 0, '새 터미널에 가짜 과거가 생겼다');
  // 실제 과거가 생기면 정상적으로 쌓인다(시드 건너뛰기가 과거 기능을 죽이지 않았다).
  await host.input('seq 1 60\r');
  assert.ok(await until(async () => (await host.historyPage({ limit: 1 })).total > 30), '실제 과거가 안 쌓인다');
  host.close();
});

test('스냅샷 하나로 뷰어가 과거 전부를 복원한다 — 클라의 유일한 과거 경로', { skip: !hasTmux }, async () => {
  // ★ 계약(2026-09-10): PC·앱 뷰어는 과거를 따로 물어보지 않는다. `snapshot().ansi`(serializeRepaint)
  //  가 데몬 VT 의 **스크롤백까지 통째로** 담고 있어서, 뷰어 xterm 에 그대로 쓰면 위로 스크롤이
  //  일반 터미널처럼 동작한다. 이게 깨지면 세 기기 모두 과거가 사라진다 → 여기서 실제 xterm 에
  //  써 넣어 확인한다(문자열 grep 이 아니라 버퍼 상태로).
  const { Terminal } = require('@xterm/headless');
  await newSession('v3-snaphist');
  const host = await registry.get('v3-snaphist', { cols: 80, rows: 24 });
  await host.ready;
  await host.input('seq 1 200 | sed "s/^/L /"\r');
  await until(async () => (await host.historyPage({ limit: 1 })).total > 150);
  const snap = await host.snapshot();
  const hist = await host.historyPage({ limit: 1 });

  const viewer = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 10000, allowProposedApi: true });
  await new Promise((r) => viewer.write(snap.ansi, r));
  const b = viewer.buffer.active;
  assert.strictEqual(b.baseY, hist.total, `뷰어 과거 ${b.baseY}줄 ≠ 데몬 VT ${hist.total}줄`);
  // 가장 오래된 줄까지 실제로 읽힌다(= 위로 끝까지 스크롤하면 보인다).
  const all = [];
  for (let y = 0; y < b.baseY + viewer.rows; y++) all.push(b.getLine(y).translateToString(true).trim());
  assert.ok(all.includes('L 1'), '첫 줄(L 1)이 뷰어 스크롤백에 없다');
  assert.ok(all.includes('L 200'), '마지막 줄(L 200)이 뷰어 화면에 없다');
  // 사용자 동작 그대로 — 위로 스크롤하면 과거가 보이고, 내려오면 라이브 화면으로 돌아온다.
  viewer.scrollLines(-60);
  const seen = [];
  for (let y = 0; y < viewer.rows; y++) seen.push(b.getLine(b.viewportY + y).translateToString(true).trim());
  assert.ok(seen.some((l) => /^L \d+$/.test(l)), '위로 스크롤했는데 과거 줄이 안 보인다');
  assert.ok(!seen.includes('L 200'), '60줄 올라갔는데 아직 마지막 줄이 보인다(스크롤이 안 먹었다)');
  viewer.scrollToBottom();
  const back = [];
  for (let y = 0; y < viewer.rows; y++) back.push(b.getLine(b.viewportY + y).translateToString(true).trim());
  assert.ok(back.includes('L 200'), '맨 아래로 돌아왔는데 라이브 화면이 아니다');
  viewer.dispose();
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
