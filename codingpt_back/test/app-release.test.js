// 모바일 릴리스 버전 정본 규칙 — node --test (네트워크 무접촉, fetch 스텁)
//
// 지키는 불변식(2026-08-01 실사고에서 도출):
//  A. 손으로 고치는 env 가 낡아도 스토어 실조회가 자동 보정한다 — prod 가 0.2.5 에 멈춰 있어
//     앱의 업데이트 확인이 영구히 "최신 버전입니다" 를 돌려주던 것이 원인.
//  B. 조회 실패는 예외가 아니라 env 폴백 — 이 API 는 앱 부팅 경로에서 불린다.
//  C. 안내 버전은 절대 역행하지 않는다(이미 새 버전을 받은 사용자를 구버전 취급하면 안 됨).
//  D. Android 는 공식 조회 경로가 없으므로 네트워크를 치지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');

const appRelease = require('../services/appReleaseService');

const realFetch = global.fetch;
function stubFetch(version) {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (version === null) throw new Error('network down');
    return { ok: true, json: async () => ({ results: version ? [{ version }] : [] }) };
  };
  return () => calls;
}
function reset(env) {
  appRelease._cache.clear();
  delete process.env.APP_LATEST_IOS; delete process.env.APP_LATEST_ANDROID;
  delete process.env.APP_MIN_IOS; delete process.env.APP_MIN_ANDROID;
  Object.assign(process.env, env || {});
}

test('A. 스토어 실조회가 낡은 env 를 자동 보정한다', async () => {
  reset({ APP_LATEST_IOS: '0.2.5' });
  stubFetch('0.2.9');
  const r = await appRelease.latestFor('ios');
  assert.equal(r.version, '0.2.9');
  assert.equal(r.source, 'store');
  assert.match(r.url, /apps\.apple\.com/);
});

test('B. 조회 실패는 env 로 폴백한다(throw 금지)', async () => {
  reset({ APP_LATEST_IOS: '0.2.5' });
  stubFetch(null);
  const r = await appRelease.latestFor('ios');
  assert.equal(r.version, '0.2.5');
  assert.equal(r.source, 'env');
});

test('B-2. env 도 없으면 기본값 — 그래도 응답한다', async () => {
  reset({});
  stubFetch(null);
  const r = await appRelease.latestFor('ios');
  assert.equal(r.version, '0.1.0');
  assert.equal(r.source, 'default');
});

test('C. 스토어 전파 지연으로 조회가 낮게 나와도 안내 버전은 역행하지 않는다', async () => {
  reset({ APP_LATEST_IOS: '0.3.0' });
  stubFetch('0.2.9');
  const r = await appRelease.latestFor('ios');
  assert.equal(r.version, '0.3.0');
  assert.equal(r.source, 'env');
});

test('D. Android 도 공개 페이지에서 읽되, 파싱이 깨지면 env 로 안전 폴백한다', async () => {
  // 파싱 실패(HTML 에 버전 슬롯 없음) → env 유지 = 기존 동작.
  reset({ APP_LATEST_ANDROID: '0.2.5' });
  global.fetch = async () => ({ ok: true, text: async () => '<html>구조가 바뀐 페이지</html>' });
  let r = await appRelease.latestFor('android');
  assert.equal(r.version, '0.2.5');
  assert.equal(r.source, 'env');
  assert.match(r.url, /play\.google\.com/);
  // 정상 파싱(실측 형태) → 자동 반영.
  reset({ APP_LATEST_ANDROID: '0.2.5' });
  global.fetch = async () => ({ ok: true, text: async () => 'x"141":[[["0.2.9"]],[[[35]]' });
  r = await appRelease.latestFor('android');
  assert.equal(r.version, '0.2.9');
  assert.equal(r.source, 'store');
});

test('D-2. 스토어 조회는 캐시버스터를 붙인다 — 없으면 CDN 이 낡은 값을 고정한다', async () => {
  // 2026-08-01 실측: plain URL 은 게시된 0.2.9 대신 0.2.5 를 계속 돌려줬다(재현됨).
  reset({});
  const seen = [];
  global.fetch = async (u) => { seen.push(String(u)); return { ok: true, json: async () => ({ results: [{ version: '0.2.9' }] }) }; };
  await appRelease.latestFor('ios');
  assert.match(seen[0], /_cb=/, 'iTunes 조회 URL 에 캐시버스터가 없다');
  reset({});
  seen.length = 0;
  global.fetch = async (u) => { seen.push(String(u)); return { ok: true, text: async () => '"141":[[["0.2.9"]]' }; };
  await appRelease.latestFor('android');
  assert.match(seen[0], /_cb=/, 'Play 조회 URL 에 캐시버스터가 없다');
});

test('E. 조회 결과는 캐시된다(요청마다 스토어를 치지 않는다)', async () => {
  reset({});
  const calls = stubFetch('0.2.9');
  await appRelease.latestFor('ios');
  await appRelease.latestFor('ios');
  assert.equal(calls(), 1);
});

test('F. 쓰레기 값은 버린다(스토어·env 양쪽)', async () => {
  reset({ APP_LATEST_IOS: 'latest' });
  stubFetch('not-a-version');
  const r = await appRelease.latestFor('ios');
  assert.equal(r.version, '0.1.0');
});

test('G. minVersion 은 설정했을 때만 실린다(평소엔 킬스위치 미작동)', async () => {
  reset({ APP_LATEST_IOS: '0.2.9' });
  stubFetch(null);
  assert.equal((await appRelease.latestFor('ios')).minVersion, undefined);
  reset({ APP_LATEST_IOS: '0.2.9', APP_MIN_IOS: '0.2.0' });
  stubFetch(null);
  assert.equal((await appRelease.latestFor('ios')).minVersion, '0.2.0');
});

test('cleanup', () => { global.fetch = realFetch; reset({}); });
