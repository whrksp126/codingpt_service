// ── win32 CI 스킵 가드 (windows-port · design.md 계약 6) — 게이트만, 테스트 로직 무수정 ──
//  사유: 유닉스 도메인 소켓 실청취(cpt.sock 지속 연결) — 계약 2 named pipe 재배선 전
//  해당 재배선/정리 후 이 가드를 제거해 win32 커버리지를 복구한다. (darwin/linux 는 무영향)
if (process.platform === 'win32') {
  require('node:test')('local-checkpoint.test.js: win32 스킵 — 유닉스 도메인 소켓 실청취(cpt.sock 지속 연결)', { skip: true }, () => {});
  return;
}

// 로컬 자동 체크포인트 + 로컬 UI 채널(cpt.sock 지속 연결) 회귀 테스트 — node --test
//
// 배경(F0): 같은 기기 안에서 서버를 왕복하던 두 경로를 끊는다.
//  (a) 자동 체크포인트: PC 앱 → back → 제어 WS → **같은 머신의 사이드카 데몬**. presigned URL·manifest 는
//      objectstore 자격증명을 가진 back 만 만들 수 있으므로(데몬 무접촉 원칙) 왕복을 없애는 형태는
//      "데몬이 back REST 를 직접 호출"이다: begin(좌표) → 로컬 번들·업로드 → commit.
//  (c) ui_command: 터미널의 cpt → 로컬 데몬 → back WSS → 같은 기기의 PC 앱. `ui.attach` 지속 연결로 직결.
//
// 여기서 고정하는 것:
//  A. sync.checkpoint 는 /begin 을 정확히 1회 부르고, **구 경로(/api/daemon/sync/checkpoint)는 0회**다.
//  B. begin 이 없는 back(404) 이면 소켓이 ok:false 로 실패한다 → PC 앱이 기존 back 경로로 폴백할 수 있다.
//  C. begin 응답이 불완전하면(좌표 누락) 실패한다 — 반쪽 상태로 백그라운드를 돌리지 않는다.
//  D. 성공 시 소켓은 즉시 accepted 로 돌아온다(대형 번들 분 단위 → 동기 대기 금지).
//  E. 같은 워크스페이스 중복 트리거는 busy(주기 30s 트리거가 겹쳐도 이중 실행 없음).
//  F. 업로드가 실패하면 commit 을 부르지 않는다(허위 manifest 등록 금지) + inflight 가 해제된다.
//  G. ui.attach 는 one-shot 규약의 예외 — 응답 후 소켓이 유지되고 양방향 프레임이 흐른다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ckpt-'));
const STATE = path.join(ROOT, '.codingpt');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

const cptServer = require('../cpt-server');

// ── 가짜 back(평문 HTTP — backFetch 는 global fetch 라 http 로 충분) ──
const hits = [];
let beginReply = null; // (body) => { status, json }
const back = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch (_) { json = null; }
    hits.push({ url: req.url, body: json, auth: req.headers.authorization });
    if (req.url === '/api/daemon/sync/checkpoint/begin') {
      const r = beginReply(json);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.json));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

let srv = null;
test('setup — 격리 stateDir + 가짜 back + cpt 소켓', async () => {
  await new Promise((r) => back.listen(0, '127.0.0.1', r));
  const port = back.address().port;
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(
    path.join(STATE, 'daemon.json'),
    JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, deviceToken: 'cptd_test', deviceName: 'T' }),
  );
  fs.mkdirSync(path.join(ROOT, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'proj', 'a.txt'), 'hello\n');
  srv = cptServer.start({});
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(fs.existsSync(cptServer.sockPath()));
});

// one-shot 소켓 왕복.
function call(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(cptServer.sockPath());
    let buf = '';
    const timer = setTimeout(() => { try { conn.destroy(); } catch (_) { /* noop */ } reject(new Error('소켓 응답 시간 초과')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args, ctx: { cwd: ROOT, ws: 'proj' } }) + '\n'));
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
const urls = () => hits.map((h) => h.url);

test('B. begin 미배포(404) → ok:false (PC 앱이 구 경로로 폴백할 수 있다)', async () => {
  hits.length = 0;
  beginReply = () => ({ status: 404, json: { message: 'Not Found' } });
  const r = await call('sync.checkpoint', { workspaceId: 'ws-1', reason: 'periodic' });
  assert.strictEqual(r.ok, false, '실패를 알려야 폴백이 가능하다(조용한 성공 금지)');
  assert.deepStrictEqual(urls(), ['/api/daemon/sync/checkpoint/begin']);
  assert.ok(!urls().includes('/api/daemon/sync/checkpoint/commit'));
});

test('C. begin 응답에 좌표가 없으면 실패(반쪽 상태로 백그라운드 진행 금지)', async () => {
  hits.length = 0;
  beginReply = () => ({ status: 200, json: { checkpointId: 'ck_1' } }); // putUrls 없음
  const r = await call('sync.checkpoint', { workspaceId: 'ws-1' });
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error), /좌표 발급 실패/);
  assert.deepStrictEqual(urls(), ['/api/daemon/sync/checkpoint/begin']);
});

test('A·D·F. 성공 = begin 1회 + 즉시 accepted, 구 경로 0회, 업로드 실패 시 commit 0회', async () => {
  hits.length = 0;
  // 업로드는 닿지 않는 주소로 → 번들까지 로컬로 돌고 업로드에서 실패한다(commit 이 불려선 안 된다).
  beginReply = (b) => ({
    status: 200,
    json: {
      checkpointId: 'ck_local_1',
      cwd: b && b.cwd ? b.cwd : 'proj',
      putUrls: { bundle: 'https://127.0.0.1:1/bundle', session: 'https://127.0.0.1:1/session' },
    },
  });
  const t0 = Date.now();
  const r = await call('sync.checkpoint', { workspaceId: 'ws-1', reason: 'handoff', cwd: 'proj' });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.accepted, true);
  assert.strictEqual(r.result.background, true);
  assert.strictEqual(r.result.local, true, '로컬 경로로 처리됐음을 표시(진단)');
  assert.strictEqual(r.result.checkpointId, 'ck_local_1');
  assert.ok(elapsed < 6000, '좌표 발급까지만 기다린다(번들/업로드를 동기로 기다리지 않는다)');

  // begin 요청 본문 계약
  const begin = hits.find((h) => h.url === '/api/daemon/sync/checkpoint/begin');
  assert.ok(begin, 'begin 이 호출돼야 한다');
  assert.strictEqual(begin.body.workspaceId, 'ws-1');
  assert.strictEqual(begin.body.reason, 'handoff');
  assert.strictEqual(begin.body.cwd, 'proj');
  assert.strictEqual(begin.auth, 'Bearer cptd_test', 'deviceToken 으로 데몬이 직접 호출');

  // 구 경로는 절대 쓰이지 않는다(= back→WS→같은 머신 데몬 왕복 제거의 증거)
  assert.ok(!urls().includes('/api/daemon/sync/checkpoint'), '구 왕복 경로 0회');

  // 백그라운드가 끝날 시간을 준다 — 업로드 실패이므로 commit 은 없어야 한다.
  await new Promise((res) => setTimeout(res, 3000));
  assert.ok(!urls().includes('/api/daemon/sync/checkpoint/commit'), '업로드 실패에 commit(허위 manifest) 금지');

  // inflight 해제 확인 — 다음 트리거가 다시 begin 을 부를 수 있어야 한다(영구 busy 고착 금지).
  hits.length = 0;
  const r2 = await call('sync.checkpoint', { workspaceId: 'ws-1', cwd: 'proj' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.result.accepted, true, 'inflight 가 해제돼 재시도가 된다');
  await new Promise((res) => setTimeout(res, 2500));
});

test('E. 같은 워크스페이스 중복 트리거는 busy(이중 실행 없음)', async () => {
  hits.length = 0;
  let hold;
  beginReply = () => ({
    status: 200,
    json: { checkpointId: 'ck_slow', cwd: 'proj', putUrls: { bundle: 'https://127.0.0.1:1/b' } },
  });
  // 첫 호출을 띄운 뒤(백그라운드 진행 중) 곧바로 두 번째.
  const first = await call('sync.checkpoint', { workspaceId: 'ws-dup', cwd: 'proj' });
  assert.strictEqual(first.result.accepted, true);
  const second = await call('sync.checkpoint', { workspaceId: 'ws-dup', cwd: 'proj' });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.result.busy, true, '진행 중이면 새 begin 을 만들지 않는다');
  assert.strictEqual(second.result.accepted, false);
  assert.strictEqual(hits.filter((h) => h.url.endsWith('/begin')).length, 1, 'begin 은 1회만');
  await new Promise((res) => setTimeout(res, 2500));
  hold = null; void hold;
});

test('workspaceId 없으면 즉시 실패', async () => {
  const r = await call('sync.checkpoint', {});
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error), /workspaceId/);
});

test('G. ui.attach — one-shot 예외(소켓 유지) + 양방향 프레임 왕복', async () => {
  cptServer.setControlWs(null); // back 없음 → 로컬 폴백 경로로 명령이 이 소켓으로 온다
  const conn = net.createConnection(cptServer.sockPath());
  const lines = [];
  let buf = '';
  conn.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (l.trim()) lines.push(JSON.parse(l));
    }
  });
  await new Promise((r) => conn.on('connect', r));
  conn.write(JSON.stringify({ id: 9, cmd: 'ui.attach', args: { clientKey: 'pc-t', deviceId: 42, kind: 'pc', foreground: true } }) + '\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].ok, true);
  assert.strictEqual(lines[0].result.attached, true);
  assert.ok(!conn.destroyed, 'ui.attach 는 응답 후에도 소켓을 닫지 않는다');

  // 데몬 → 앱 push (back 이 없으므로 로컬 폴백으로 이 소켓에 온다)
  const p = cptServer._sendUiCommand('ui.previewOpen', { url: 'http://x' }, { mode: 'broadcast', timeoutMs: 4000 });
  await new Promise((r) => setTimeout(r, 200));
  const push = lines.find((l) => l.t === 'ui_command');
  assert.ok(push, '지속 연결로 명령이 밀려와야 한다');
  assert.strictEqual(push.cmd, 'ui.previewOpen');
  assert.match(push.uiId, /^loc-\d+$/);

  // 앱 → 데몬 회신
  conn.write(JSON.stringify({ t: 'ui_result', uiId: push.uiId, ok: true, result: { paneId: 'p1' } }) + '\n');
  assert.deepStrictEqual(await p, { paneId: 'p1' });

  // 소켓 종료 → 클라이언트 등록 해제(유령 라우팅 방지)
  conn.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(cptServer._localUi.clients.size, 0);
});

test('cleanup', async () => {
  try { if (srv) srv.close(); } catch (_) { /* noop */ }
  await new Promise((r) => back.close(r));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});
