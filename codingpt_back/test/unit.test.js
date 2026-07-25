// 핵심 순수 로직 테스트 — node 내장 러너(node --test), DB/objectstore 무접촉.
//  실행: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeRemote } = require('../services/workspaceService');
const { cmpVersion } = require('../services/pcReleaseService');
const { _composeSubtitle } = require('../services/notificationService');
const { _normCaps } = require('../services/daemonRelayService');
const { SERVER_CAPS } = require('../config/caps');

test('normalizeRemote — ssh/https/포트/.git 흡수해 동일 키', () => {
  assert.strictEqual(normalizeRemote('git@github.com:Foo/Bar.git'), normalizeRemote('https://github.com/Foo/Bar'));
  assert.strictEqual(normalizeRemote('ssh://git@host.com:2222/a/b.git'), 'host.com/a/b');
  assert.notStrictEqual(normalizeRemote('https://github.com/foo/bar'), normalizeRemote('https://github.com/foo/other'));
});

test('cmpVersion — semver 대소/동등', () => {
  assert.strictEqual(cmpVersion('0.2.0', '0.1.9'), 1);
  assert.strictEqual(cmpVersion('1.0.0', '1.0.0'), 0);
  assert.strictEqual(cmpVersion('0.9.0', '0.10.0'), -1); // 문자열 비교가 아님
  assert.strictEqual(cmpVersion('v1.2', '1.2.0'), 0);    // v 접두사·자릿수 관용
});

// 기능3(훅 감지) 1단계 전제 = "back 무수정" — 데몬이 subtitle:null 로 보내고 서버가 조합한다.
//  이 계약이 깨지면 훅/폴백 알림의 부제가 3플랫폼에서 동시에 비어 보인다.
test('composeSubtitle — 훅/폴백 알림 3종 kind 를 서버가 조합', () => {
  assert.strictEqual(_composeSubtitle('done', 'codingpt'), '「codingpt」에서 완료');
  assert.strictEqual(_composeSubtitle('permission_request', 'codingpt'), '「codingpt」에서 승인 대기');
  assert.strictEqual(_composeSubtitle('error', 'codingpt'), '「codingpt」에서 오류');
  assert.strictEqual(_composeSubtitle('done', null), null);      // wsName 없으면 조합 안 함(클라 계약)
  // 미도입 kind(예: needs_input)는 거부가 아니라 "부제 없음" — 데몬이 먼저 나가도 알림이 죽지 않는다.
  assert.strictEqual(_composeSubtitle('needs_input', 'codingpt'), null);
});

// caps 협상 배관(§2-(d)) — 구버전(필드 부재)이 항상 [] 로 떨어져 게이팅이 기존 동작으로 폴백해야 한다.
test('normCaps — 구버전 무영향 + 자기신고 값 정규화', () => {
  assert.deepStrictEqual(_normCaps(undefined), []);   // 구 데몬/구 클라 = 필드 자체가 없음
  assert.deepStrictEqual(_normCaps(null), []);
  assert.deepStrictEqual(_normCaps('approval.v1'), []); // 배열 아님 = 무시(throw 금지)
  assert.deepStrictEqual(_normCaps([' approval.v1 ', 'approval.v1', 42, '', null]), ['approval.v1']); // trim·중복·비문자 제거
  assert.strictEqual(_normCaps(new Array(100).fill(0).map((_, i) => 'c' + i)).length, 32); // 개수 상한
  assert.strictEqual(_normCaps(['x'.repeat(200)])[0].length, 64);                          // 길이 상한
});

test('SERVER_CAPS — 아직 서버 코드가 없는 기능을 미리 선언하지 않는다', () => {
  // 선언 = "서버가 처리한다"는 약속. 기능3 2단계/기능1/기능5의 서버측 코드가 머지될 때 함께 켠다.
  for (const c of ['agentstate.v1', 'approval.v1', 'transcript.v1']) {
    assert.ok(!SERVER_CAPS.includes(c), `${c} 는 서버 처리 코드가 들어간 뒤에 선언해야 한다`);
  }
});
