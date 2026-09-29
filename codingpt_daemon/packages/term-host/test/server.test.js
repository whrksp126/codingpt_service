/**
 * term-host 프로토콜/생명주기 e2e — mac 유닉스 소켓 폴백에서 실제 pty 를 띄워 검증한다
 * (프로토콜 로직은 플랫폼 중립 — win32 에선 파이프 경로만 다르다).
 *
 *  · NDJSON 왕복(create/list/has/env/rename/capture/sendKeys/info/kill 멱등)
 *  · 다중 attach 미러(출력 브로드캐스트 + 입력 전원 허용)
 *  · latest-wins 리사이즈(마지막 요청이 이긴다)
 *  · 세션 생명주기(셸 종료 = 세션 소멸) + 저널/크래시 respawn 복원
 *  · 단일 인스턴스 락(EADDRINUSE) + 스테일 소켓 회수
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { TermHostServer } = require('../lib/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-termhost-test-'));
const SOCK = path.join(tmp, 'th.sock');
const JOURNAL = path.join(tmp, 'termhost', 'sessions.json');

let server;

before(async () => {
  server = new TermHostServer({ sockPath: SOCK, journalPath: JOURNAL, exitOnKill: false });
  const r = await server.start();
  assert.strictEqual(r.started, true);
});

after(() => {
  try { server.stop(); } catch (_) { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ── 테스트용 최소 클라이언트 ─────────────────────────────────────────────
let seq = 0;
function rpc(op, payload = {}, sockPath = SOCK) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = '';
    const to = setTimeout(() => { sock.destroy(); reject(new Error('rpc timeout: ' + op)); }, 8000);
    sock.on('error', (e) => { clearTimeout(to); reject(e); });
    sock.on('connect', () => sock.write(JSON.stringify({ id: ++seq, op, ...payload }) + '\n'));
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(to);
      sock.destroy();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
  });
}

// attach 스트림 클라이언트 — 프레임 수집.
function attachClient(name, { cols, rows } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = '';
    let ready = false;
    const c = {
      sock,
      out: '',            // 누적 출력(디코드)
      exit: null,
      frames: [],
      send(frame) { sock.write(JSON.stringify(frame) + '\n'); },
      close() { sock.destroy(); },
    };
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!ready) {
          ready = true;
          if (msg.ok === false) return reject(new Error(msg.error));
          resolve(c);
          continue;
        }
        c.frames.push(msg);
        if (msg.t === 'o') c.out += Buffer.from(msg.d, 'base64').toString('utf8');
        if (msg.t === 'x') c.exit = msg.code;
      }
    });
    sock.on('connect', () => sock.write(JSON.stringify({ id: ++seq, op: 'attach', name, cols, rows }) + '\n'));
  });
}

async function until(fn, ms = 6000, label = '조건') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

const CAT = '/bin/cat'; // 결정적 e2e 셸 대역 — pty 에코 + 라인 반향

test('ping — 프로토콜 왕복', async () => {
  const r = await rpc('ping');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pid, process.pid);
});

test('create/list/has — 세션명은 tmux 관례(cpt-<ws>--t-<tid>) 그대로', async () => {
  const name = 'cpt-proj--t-1000001';
  const r = await rpc('create', { name, shell: CAT, cwd: tmp, cols: 60, rows: 12, env: { CPT_WS: 'proj', CPT_TID: '1000001' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, name);
  assert.ok(r.panePid > 0);
  assert.strictEqual(r.cols, 60);

  const dup = await rpc('create', { name, shell: CAT });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.code, 'DUPLICATE_SESSION');

  const l = await rpc('list');
  assert.ok(l.sessions.some((s) => s.name === name));
  assert.strictEqual((await rpc('has', { name })).exists, true);
  assert.strictEqual((await rpc('has', { name: 'cpt-없는거--t-9' })).exists, false);
});

test('setEnv/getEnv — set-environment/show-environment 등가', async () => {
  const name = 'cpt-proj--t-1000001';
  await rpc('setEnv', { name, k: 'CPT_SOCK', v: '/tmp/x.sock' });
  assert.strictEqual((await rpc('getEnv', { name, k: 'CPT_SOCK' })).value, '/tmp/x.sock');
  assert.strictEqual((await rpc('getEnv', { name, k: 'CPT_WS' })).value, 'proj'); // create env 승계
  assert.strictEqual((await rpc('getEnv', { name, k: '없는키' })).value, null);
});

test('rename — 수동 이름 우선(automatic-rename off 등가), 빈 값으로 자동 복귀', async () => {
  const name = 'cpt-proj--t-1000001';
  await rpc('rename', { name, title: '내 터미널' });
  assert.strictEqual((await rpc('info', { name })).windowName, '내 터미널');
  await rpc('rename', { name, title: '' });
  const auto = (await rpc('info', { name })).windowName;
  assert.notStrictEqual(auto, '내 터미널'); // 자동 개명 복귀(cat = 비셸 → 프로세스명)
});

test('sendKeys(data)+capture — 실제 pty 에코 왕복(capture-pane -p 등가)', async () => {
  const name = 'cpt-proj--t-1000001';
  await rpc('sendKeys', { name, data: 'hello-world\r' });
  const text = await until(async () => {
    const t = (await rpc('capture', { name })).text;
    return t.includes('hello-world') ? t : null;
  }, 6000, 'cat 에코가 화면에 나타남');
  assert.ok(text.includes('hello-world'));
});

test('sendKeys(keys 표기)+escapes capture — C-u 등 변환 경로', async () => {
  const name = 'cpt-proj--t-1000001';
  // 리터럴 텍스트 → BSpace 2회 → Enter (tmux send-keys -l / 키 표기 혼용 실사용 패턴)
  await rpc('sendKeys', { name, keys: ['abcd'], literal: true });
  await rpc('sendKeys', { name, keys: ['BSpace'], count: 2 });
  await rpc('sendKeys', { name, keys: ['Enter'] });
  await until(async () => (await rpc('capture', { name })).text.split('\n').filter((l) => l.trim() === 'ab').length >= 2 ? true : null,
    6000, 'BSpace 2회 후 ab 만 제출됨');
  const esc = await rpc('capture', { name, escapes: true });
  assert.ok(esc.ok && typeof esc.text === 'string' && esc.text.includes('ab'));
});

test('info — command/cursor/모드(display-message 등가 묶음)', async () => {
  const name = 'cpt-proj--t-1000001';
  const r = await rpc('info', { name });
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.command === 'string');
  assert.ok(r.cursor && Number.isFinite(r.cursor.x) && Number.isFinite(r.cursor.y));
  assert.ok(r.modes && typeof r.modes.bracketedPaste === 'boolean');
});

test('다중 attach 미러 — 출력 브로드캐스트 + 입력 전원 허용 + 리페인트', async () => {
  const name = 'cpt-proj--t-1000001';
  const a = await attachClient(name, { cols: 80, rows: 24 });
  const b = await attachClient(name, { cols: 80, rows: 24 });
  // 리페인트: 새 attach 는 즉시 현재 화면을 받는다(기존 출력 hello-world 포함).
  await until(() => a.out.includes('hello-world') && b.out.includes('hello-world') ? true : null, 6000, 'attach 리페인트');
  // a 의 입력이 → 양쪽 모두의 출력으로(미러).
  a.send({ t: 'i', d: Buffer.from('mirror-check\r').toString('base64') });
  await until(() => a.out.includes('mirror-check') && b.out.includes('mirror-check') ? true : null, 6000, '미러 브로드캐스트');
  // b 의 입력도 허용(전원 입력).
  b.send({ t: 'k', keys: ['from-b'], literal: true });
  b.send({ t: 'k', keys: ['Enter'] });
  await until(() => a.out.includes('from-b') ? true : null, 6000, 'b 입력이 a 화면에');
  a.close(); b.close();
});

test('latest-wins 리사이즈 — 마지막 요청이 이긴다(window-size latest 등가)', async () => {
  const name = 'cpt-proj--t-1000001';
  const a = await attachClient(name, { cols: 100, rows: 30 }); // attach 크기 주장
  assert.strictEqual((await rpc('info', { name })).cols, 100);
  const b = await attachClient(name, { cols: 66, rows: 20 });  // 나중 attach 가 이긴다
  await until(async () => (await rpc('info', { name })).cols === 66 ? true : null, 4000, 'b attach 크기 반영');
  a.send({ t: 'r', cols: 120, rows: 40 });                     // 이후 a 의 r 프레임이 다시 이긴다
  await until(async () => (await rpc('info', { name })).cols === 120 ? true : null, 4000, 'a r 프레임 반영');
  const r = await rpc('resize', { name, cols: 90, rows: 28 }); // 단발 resize op 도 동일 규칙
  assert.strictEqual(r.cols, 90);
  a.close(); b.close();
});

test('세션 생명주기 — 셸 종료 = 세션 소멸(결정적 상태) + x 프레임', async () => {
  const name = 'cpt-proj--t-2000002';
  await rpc('create', { name, shell: CAT, cwd: tmp });
  const a = await attachClient(name);
  // ⚠ 자식 exec 완료 전의 \x03 은 tty 가 삼킨다(스폰 직후 시그널 레이스 — tmux new-session 직후
  //  send-keys 도 동일). 에코 왕복으로 pty 라인이 살아있음을 확정한 뒤 C-c 를 보낸다.
  await rpc('sendKeys', { name, data: 'warmup\r' });
  await until(async () => (await rpc('capture', { name })).text.includes('warmup') ? true : null, 6000, 'pty 준비(warmup 에코)');
  await rpc('sendKeys', { name, keys: ['C-c'] }); // cat 종료 → 세션 소멸
  await until(async () => (await rpc('has', { name })).exists === false ? true : null, 6000, '세션 소멸');
  await until(() => a.exit != null ? true : null, 4000, 'attach 에 x 프레임');
  const dead = await rpc('capture', { name });
  assert.strictEqual(dead.ok, false);
  assert.strictEqual(dead.code, 'NO_SESSION');
});

test('kill — 멱등(없어도 성공: kill-session 소비자 관례)', async () => {
  const name = 'cpt-proj--t-3000003';
  await rpc('create', { name, shell: CAT, cwd: tmp });
  assert.strictEqual((await rpc('kill', { name })).ok, true);
  assert.strictEqual((await rpc('has', { name })).exists, false);
  assert.strictEqual((await rpc('kill', { name })).ok, true); // 두 번째도 성공
});

test('respawn — 살아있는 세션 프로세스 교체(respawn-pane -k 등가)', async () => {
  const name = 'cpt-proj--t-4000004';
  await rpc('create', { name, shell: CAT, cwd: tmp });
  const pid1 = (await rpc('info', { name })).panePid;
  const r = await rpc('respawn', { name });
  assert.strictEqual(r.ok, true);
  assert.ok(r.panePid > 0 && r.panePid !== pid1, '새 프로세스로 교체');
  assert.strictEqual((await rpc('has', { name })).exists, true);
  await rpc('kill', { name });
});

test('저널 + 크래시 복원 — respawn 정책(자동 재기동 없음)', async () => {
  const name = 'cpt-proj--t-5000005';
  await rpc('create', { name, shell: CAT, cwd: tmp, env: { CPT_WS: 'proj5' } });
  await rpc('rename', { name, title: '복원 대상' });
  const journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
  assert.ok(journal.sessions.some((s) => s.name === name && s.env.CPT_WS === 'proj5'), '저널에 세션 메타 기록');

  // 크래시 시뮬레이션: 저널을 백업해 두고 호스트를 새로 띄운다(구 호스트 세션은 소멸).
  const saved = fs.readFileSync(JOURNAL, 'utf8');
  server.stop();
  fs.writeFileSync(JOURNAL, saved); // stop() 이 비운 저널을 크래시 당시 상태로 되돌림
  server = new TermHostServer({ sockPath: SOCK, journalPath: JOURNAL, exitOnKill: false });
  assert.strictEqual((await server.start()).started, true);

  // 재기동 직후: 살아있는 목록엔 없다(자동 재기동 금지) — respawn 으로만 복원.
  assert.strictEqual((await rpc('has', { name })).exists, false);
  const r = await rpc('respawn', { name });
  assert.strictEqual(r.ok, true, 'respawn 이 저널 고아를 복원: ' + JSON.stringify(r));
  assert.strictEqual((await rpc('has', { name })).exists, true);
  assert.strictEqual((await rpc('getEnv', { name, k: 'CPT_WS' })).value, 'proj5'); // env 복원
  assert.strictEqual((await rpc('info', { name })).windowName, '복원 대상');       // 수동 이름 복원
  await rpc('kill', { name });
});

test('단일 인스턴스 — 파이프 점유가 곧 락(EADDRINUSE = 이미 실행 중)', async () => {
  const second = new TermHostServer({ sockPath: SOCK, journalPath: JOURNAL, exitOnKill: false });
  const r = await second.start();
  assert.strictEqual(r.started, false);
  assert.strictEqual(r.reason, 'already-running');
});

test('스테일 소켓 회수 — 크래시 잔재 파일이 있어도 재기동', async () => {
  const sock2 = path.join(tmp, 'stale.sock');
  fs.writeFileSync(sock2, ''); // 죽은 호스트의 잔재(연결 불가 파일)
  const s2 = new TermHostServer({ sockPath: sock2, journalPath: path.join(tmp, 'j2', 'sessions.json'), exitOnKill: false });
  const r = await s2.start();
  assert.strictEqual(r.started, true);
  s2.stop();
});

test('killServer — 세션 전멸 + 서버 종료(유일한 정규 종료 경로)', async () => {
  const name = 'cpt-proj--t-6000006';
  await rpc('create', { name, shell: CAT, cwd: tmp });
  assert.strictEqual((await rpc('killServer')).ok, true);
  await until(() => new Promise((resolve) => {
    const probe = net.connect(SOCK);
    probe.once('connect', () => { probe.destroy(); resolve(null); });
    probe.once('error', () => resolve(true));
  }), 4000, '서버 소켓 닫힘');
  // 다음 테스트가 없으므로 재기동은 불필요 — after() 의 stop 은 멱등.
});
