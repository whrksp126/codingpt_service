// agents.test.js — 에이전트 감지·배선·shim 조건부 래핑의 회귀 방지.
//
// 이 라운드가 고친 실제 사고: `ensureShims` 가 설치 여부와 무관하게 `codex` 래퍼를 만들어,
//  codex 를 깔지도 않은 사용자에게 OS 의 `command not found` 대신
//  `cpt-shim: codex 실행 파일을 찾을 수 없습니다` 가 떴다("CodingPT 가 codex 를 망가뜨렸다"로 읽힘).
//
// 탐색 경로는 `_internals.setSearchOverride` 로 고정한다 — 안 하면 "codex 없으면 래퍼 없음"을
//  codex 가 깔린 개발 머신에서는 검증할 수 없고, CI/로컬이 서로 다른 답을 낸다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-agents-'));
const STATE = path.join(ROOT, '.codingpt');
const FAKEBIN = path.join(ROOT, 'fakebin');
fs.mkdirSync(FAKEBIN, { recursive: true });
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1'; // 전역 cpt 심링크로 사용자 환경을 건드리지 않는다

runtime.init({ root: ROOT, stateDir: STATE });
const agents = require('../agents');
const shim = require('../shim');
const config = require('../config');

const BIN = () => path.join(STATE, 'bin');
const wrapperExists = (name) => fs.existsSync(path.join(BIN(), name));

function plant(name) {
  const p = path.join(FAKEBIN, name);
  fs.writeFileSync(p, '#!/bin/sh\necho "9.9.9"\n', { mode: 0o755 });
  return p;
}
function unplant(name) {
  try { fs.unlinkSync(path.join(FAKEBIN, name)); } catch (_) { /* 이미 없음 */ }
}
function reset(prefs) {
  // 배선 설정 정본은 <stateDir>/agents.json(머신 영속) — 테스트마다 지우고 원하는 상태로 다시 깐다.
  //  daemon.json 에도 같은 값을 심어 "구 저장소 → 신 저장소 1회 이관" 경로가 늘 실행되게 한다.
  try { fs.unlinkSync(path.join(STATE, 'agents.json')); } catch (_) { /* 없음 */ }
  config.save({ serverUrl: 'http://x', deviceId: 1, deviceToken: 't', ...(prefs ? { agents: prefs } : {}) });
  agents._internals.setSearchOverride([FAKEBIN]);
}

test('설치된 것만 감싼다 — 미설치 에이전트의 래퍼는 만들지 않는다', async () => {
  plant('claude');
  unplant('codex');
  reset();
  await shim.ensureShimsAsync();
  assert.ok(wrapperExists('claude'), 'claude 는 설치돼 있으니 래퍼가 있어야 한다');
  assert.ok(!wrapperExists('codex'),
    'codex 미설치인데 래퍼를 만들면 OS 의 command not found 가 우리 에러로 바뀐다(이 라운드가 고친 사고)');
});

test('나중에 설치하면 다음 배선에서 래퍼가 생긴다 — 재시작 불필요', async () => {
  plant('codex');
  reset();
  await shim.ensureShimsAsync();
  assert.ok(wrapperExists('codex'), '감지되면 래퍼가 생겨야 한다');
  const body = fs.readFileSync(path.join(BIN(), 'codex'), 'utf8');
  // notify 프로그램은 **절대경로**여야 한다(2026-07-29) — 맨 이름 "cpt" 는 PATH 조회라 전역
  //  심링크(이제 옵션)에 배선이 묶이고, 워킹트리의 동명 실행파일이 가로챌 수 있다.
  assert.match(body, /notify=\["[^"]*[\\/]bin[\\/]cpt","codex-notify"\]/, 'codex 배선은 절대경로 notify 주입이다');
  assert.doesNotMatch(body, /notify=\["cpt"/, '맨 이름 "cpt" 로 되돌리면 심링크 없는 환경에서 codex 알림이 죽는다');
  assert.doesNotMatch(body, /REAL=""/, '해석된 절대경로가 박혀야 한다(빈 REAL = 감지 실패 흔적)');
});

test('배선을 끄면 래퍼를 삭제한다 — 켠 척/끈 척이 없다', async () => {
  plant('claude'); plant('codex');
  reset({ claude: false });
  await shim.ensureShimsAsync();
  assert.ok(!wrapperExists('claude'), '배선 OFF 면 래퍼가 남아 있으면 안 된다(끈 척 금지)');
  assert.ok(wrapperExists('codex'), '다른 에이전트는 영향 없어야 한다');
  reset({ claude: true });
  await shim.ensureShimsAsync();
  assert.ok(wrapperExists('claude'), '다시 켜면 복원돼야 한다');
});

test("배선 기본값은 '아직 안 물어봄 = 켜짐' 이고, false 와 구분된다", () => {
  reset();                       // agents 키 없음 = 아직 안 물어봄
  assert.strictEqual(agents.isWired('claude'), true, '기본값(권장)은 켜짐이어야 한다');
  assert.strictEqual(agents.wireDecided('claude'), false, '결정한 적 없음으로 읽혀야 한다(온보딩 대상)');
  reset({ claude: false });      // 사용자가 명시적으로 끔
  assert.strictEqual(agents.isWired('claude'), false);
  assert.strictEqual(agents.wireDecided('claude'), true,
    "'안 물어봄' 과 '끔' 을 뭉개면 아니라고 답한 사용자가 켜진 채로 쓰게 된다");
});

test('실행 전용(launch) 등급은 켤 수 없다 — 켠 척 금지', () => {
  reset();
  assert.strictEqual(agents.isWired('gemini'), false, 'launch 등급은 항상 false 여야 한다');
  assert.throws(() => agents.setWired('gemini', true), /배선을 지원하지 않/,
    '배선 못 하는 에이전트를 켜지게 하면 UI 가 거짓을 표시한다');
});

test('우리 래퍼 디렉토리는 감지에서 제외된다 — 자기 자신을 근거로 삼지 않는다', async () => {
  plant('claude');
  reset();
  await shim.ensureShimsAsync();               // bin/claude 래퍼 생성
  agents._internals.setSearchOverride([BIN()]); // 우리 bin 만 PATH 에 둔다
  const items = await agents.list({ refresh: true, version: false });
  const c = items.find((a) => a.id === 'claude');
  assert.strictEqual(c.installed, false,
    '우리 래퍼를 보고 "설치됨" 이라 답하면 감지가 순환한다(래퍼→래퍼)');
});

test('zdot 내용은 감지 결과와 무관하다 — .zlogin mtime = 유휴 터미널 respawn 트리거', async () => {
  const zlogin = path.join(STATE, 'shim', 'zdot', '.zlogin');
  plant('claude'); plant('codex');
  reset();
  await shim.ensureShimsAsync();
  const withBoth = fs.readFileSync(zlogin, 'utf8');
  const mt1 = fs.statSync(zlogin).mtimeMs;

  // 둘 다 제거한다 — **claude 와 codex 모두** 감지 상태가 뒤집혀야 한다. 하나만 바꾸면
  //  "다른 하나의 감지 결과를 zdot 에 심는" 회귀를 이 비교가 놓친다(실제로 놓치는 것을 확인했다).
  unplant('claude');
  unplant('codex');
  reset();
  await shim.ensureShimsAsync();
  const withNone = fs.readFileSync(zlogin, 'utf8');
  assert.strictEqual(withNone, withBoth,
    'zdot 이 감지 결과에 따라 바뀌면 에이전트를 설치/삭제할 때마다 사용자의 유휴 터미널이 전부 respawn 된다');
  assert.strictEqual(fs.statSync(zlogin).mtimeMs, mt1, 'mtime 도 보존돼야 한다(writeIfChanged 계약)');
});

test('셸 함수는 래퍼가 없으면 원래 명령으로 통과한다(정적 폴백)', () => {
  const zlogin = fs.readFileSync(path.join(STATE, 'shim', 'zdot', '.zlogin'), 'utf8');
  assert.match(zlogin, /_cpt_passthru/, '폴백 헬퍼가 있어야 한다');
  assert.match(zlogin, /codex\(\)\s*\{\s*if \[ -x/, 'codex 함수는 래퍼 존재를 런타임에 확인해야 한다');
  // 폴백이 우리 bin 을 PATH 에서 빼고 조회하지 않으면 함수→래퍼→함수 무한 재귀가 된다.
  assert.match(zlogin, /grep -vx/, '폴백은 우리 bin 을 제외한 PATH 에서 찾아야 한다(재귀 방지)');
});

test('배선 못 하는 에이전트도 카탈로그에는 있고, 등급이 정직하다', async () => {
  reset();
  const items = await agents.list({ refresh: true, version: false });
  const byId = new Map(items.map((a) => [a.id, a]));
  assert.strictEqual(byId.get('claude').tier, 'full', 'claude = 상태·원격승인·알림');
  assert.strictEqual(byId.get('codex').tier, 'partial', 'codex = 알림만(원격 승인 없음)');
  assert.strictEqual(byId.get('gemini').tier, 'launch', 'gemini = 실행만');
  for (const a of items) {
    assert.ok(a.docs && /^https:\/\//.test(a.docs), `${a.id}: 공식 문서 링크가 있어야 한다(명령은 낡을 수 있다)`);
    for (const m of a.install || []) {
      assert.ok(m.cmd && m.label, `${a.id}: 설치 방법에는 라벨과 명령이 다 있어야 한다`);
    }
  }
});

test('agents.wire/launch 는 cpt CAPABILITIES 에 없다 — AI 자기해제·자기증식 금지', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
  const block = /const CAPABILITIES = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'CAPABILITIES 배열을 찾아야 한다');
  // 주석에는 이유가 적혀 있으므로 주석을 걷어낸 뒤 검사한다(자기 설명 주석에 걸리는 사고 방지).
  const listed = block[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(listed, /'agents\.list'/, '읽기 전용 목록은 공개해도 안전하다');
  assert.doesNotMatch(listed, /'agents\.wire'/,
    'wire 를 열면 터미널 안의 AI 가 자기 승인 훅을 스스로 끌 수 있다');
  assert.doesNotMatch(listed, /'agents\.rescan'/, 'rescan 은 shim 을 재생성한다');
  assert.doesNotMatch(listed, /'agents\.launch'/, 'launch 는 AI 자기증식 경로다');
});

// ★ 2026-07-27 사용자 제보 회귀 — 배선 설정이 daemon.json 에 있어서 로그아웃/계정 전환
//  (clearCredentials/remove = 클린 슬레이트)에 같이 지워졌다: 계정을 바꿀 때마다 선택이 날아가고
//  온보딩이 다시 떴다. 정본을 <stateDir>/agents.json(머신 영속)으로 분리 — 아래 3면을 고정한다.
test('배선 선택은 계정 전환(clearCredentials)에도 유지된다', () => {
  reset();
  agents.setWired('claude', false);
  agents.markOnboarded();
  config.clearCredentials();                 // 로그아웃/계정 전환 경로
  assert.strictEqual(agents.isWired('claude'), false, '계정을 바꿔도 사용자의 끔 선택은 남아야 한다');
  assert.ok(agents.onboardedAt(), '온보딩 완료 표시도 남아야 한다(계정마다 다시 묻지 않는다)');
});

test('배선 선택은 unpair(config.remove)에도 유지된다', () => {
  reset();
  agents.setWired('codex', false);
  config.remove();                           // unpair — daemon.json 자체 삭제
  assert.strictEqual(agents.isWired('codex'), false);
  assert.strictEqual(agents.wireDecided('codex'), true, '명시 결정 여부도 함께 유지된다');
});

test('구 저장소(daemon.json)의 설정은 최초 1회 이관된다', () => {
  try { fs.unlinkSync(path.join(STATE, 'agents.json')); } catch (_) { /* 없음 */ }
  config.save({ serverUrl: 'http://x', deviceId: 1, deviceToken: 't', agents: { claude: false }, agentsOnboardedAt: '2026-07-01T00:00:00.000Z' });
  assert.strictEqual(agents.isWired('claude'), false, '구 daemon.json 의 선택이 읽혀야 한다');
  assert.ok(fs.existsSync(path.join(STATE, 'agents.json')), '읽는 순간 신 저장소로 이관된다');
  config.remove();                           // 구 저장소가 사라져도
  assert.strictEqual(agents.isWired('claude'), false, '이관본으로 계속 동작한다');
  assert.strictEqual(agents.onboardedAt(), '2026-07-01T00:00:00.000Z');
});

test('cleanup', () => {
  agents._internals.setSearchOverride(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});
