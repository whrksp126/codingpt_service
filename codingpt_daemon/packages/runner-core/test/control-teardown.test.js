// 제어 WS 유실 시 전송로 무효화 회귀 테스트 — node --test
//
// 배경(회귀 방지 대상):
//  cpt-server 의 sendUiCommand 는 controlWs 가 살아있다고 보고 요청을 보낸 뒤 ui_result 를 기다린다.
//  control.js 가 close/error 에서 setControlWs(null) 을 호출하지 않으면, controlWs 는 CLOSED 상태의
//  스테일 소켓으로 남는다. 그러면
//    ① 대기 중이던 왕복이 BACK_OFFLINE 으로 즉시 실패하지 못하고 UI_TIMEOUT(최대 60s)까지 매달리고,
//    ② 그 사이 들어온 새 요청도 readyState 검사(=1)만 통과하지 못한 채 각자 타임아웃을 기다린다.
//  훅을 블로킹하는 경로(원격 승인)에서는 이 지연이 곧 claude 정지 시간이므로, "끊긴 즉시 실패"가
//  구조적으로 보장돼야 한다.
//
// 여기서는 control.js 전체(실 WS 접속)를 띄우지 않고, 그 계약의 핵심 두 가지를 단언한다:
//  A. setControlWs(null) 이 대기 중 왕복 전부를 BACK_OFFLINE 으로 즉시 reject 한다.
//  B. control.js 의 close/error 핸들러가 실제로 setControlWs(null) 을 호출하도록 배선돼 있다(소스 계약).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-teardown-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const cptServer = require('../cpt-server');

// controlWs 대역 — readyState 1(OPEN)만 흉내내고 send 는 삼킨다(back 없이 pending 을 만들기 위함).
function fakeOpenWs() {
  return { readyState: 1, sent: [], send(s) { this.sent.push(s); } };
}

test('setControlWs(null) — 대기 중 ui 왕복이 즉시 BACK_OFFLINE 으로 실패', async () => {
  const ws = fakeOpenWs();
  cptServer.setControlWs(ws);

  // 응답이 오지 않는 왕복 2건을 띄운다(fake ws 가 send 를 삼키므로 영원히 pending).
  const p1 = cptServer._sendUiCommand('ui.noop', {}, { timeoutMs: 30000 });
  const p2 = cptServer._sendUiCommand('ui.noop2', {}, { timeoutMs: 30000 });
  assert.strictEqual(ws.sent.length, 2, 'OPEN 상태에서는 전송돼야 한다');

  // 연결 유실 — control.js close/error 가 하는 일.
  const t0 = Date.now();
  cptServer.setControlWs(null);

  for (const p of [p1, p2]) {
    await assert.rejects(p, (e) => {
      assert.strictEqual(e.code, 'BACK_OFFLINE', `BACK_OFFLINE 이어야 함 (실제: ${e.code})`);
      return true;
    });
  }
  // 타임아웃을 기다린 게 아니라 즉시 풀렸는지 — 30s 타임아웃 대비 충분히 빨라야 한다.
  assert.ok(Date.now() - t0 < 1000, '타임아웃 대기 없이 즉시 reject 돼야 한다');
});

test('setControlWs(null) 이후 새 요청도 BACK_OFFLINE', async () => {
  cptServer.setControlWs(null);
  await assert.rejects(
    cptServer._sendUiCommand('ui.noop', {}, { timeoutMs: 30000 }),
    (e) => e.code === 'BACK_OFFLINE',
  );
});

test('control.js 배선 — close/error 핸들러가 setControlWs(null) 을 호출한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');

  // ws.on('close', ...) / ws.on('error', ...) 블록을 각각 잘라 그 안에서 호출 여부를 본다.
  const blockOf = (event) => {
    const i = src.indexOf(`ws.on('${event}'`);
    assert.ok(i > 0, `ws.on('${event}') 핸들러가 있어야 한다`);
    // 다음 핸들러 등록 또는 파일 끝까지를 이 블록으로 본다(대략적이지만 회귀 감지에 충분).
    const rest = src.slice(i + 10);
    const nextIdx = rest.search(/ws\.on\('/);
    return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  };

  for (const event of ['close', 'error']) {
    assert.match(
      blockOf(event),
      /cptServer\.setControlWs\(null\)/,
      `ws.on('${event}') 에서 cptServer.setControlWs(null) 을 호출해야 한다 — 빼면 승인 왕복이 UI_TIMEOUT 까지 매달린다`,
    );
  }
});
