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

test('D. Android 는 네트워크를 치지 않고 env 를 쓴다', async () => {
  reset({ APP_LATEST_ANDROID: '0.2.5' });
  const calls = stubFetch('9.9.9');
  const r = await appRelease.latestFor('android');
  assert.equal(r.version, '0.2.5');
  assert.equal(calls(), 0, 'Play 는 공식 조회 경로가 없다 — 호출 자체를 하면 안 된다');
  assert.match(r.url, /play\.google\.com/);
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
