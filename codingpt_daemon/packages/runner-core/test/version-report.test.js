// 데몬이 보고하는 버전 — node --test (실제 CLI 를 spawn 해 확인)
//
// 지키는 불변식(2026-08-01):
//  A. 데몬은 PC 앱이 주입한 CPT_APP_VERSION 을 자기 버전으로 보고한다.
//     — 데몬은 PC 앱 사이드카로만 배포되므로 실질 버전 = PC 앱 버전인데, 자기 package.json 이
//       최초 커밋 이후 안 올라 **전 사용자가 영구 '0.1.0'** 을 보고했다(스큐 진단 불가).
//  B. 주입이 없으면(단독 실행·클라우드 러너) package.json 으로 폴백한다 — 기존 동작 보존.
//  C. 쓰레기 값은 무시한다(버전 자리에 임의 문자열이 실려 DB/화면에 새는 것 방지).
//  D. PC 앱이 실제로 주입하는 배선이 살아 있다(사이드카 spawn 에 env 가 붙어 있는가).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', '..', 'daemon', 'index.js');
const PKG_VERSION = require(path.join(__dirname, '..', '..', 'daemon', 'package.json')).version;

// 인자 없이 실행하면 배너에 버전을 찍고 종료한다(네트워크·설정 무접촉).
function bannerVersion(env) {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...process.env, ...env } });
  const m = /에이전트 v([^\s]+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

test('A. PC 앱이 주입한 버전을 보고한다', () => {
  assert.equal(bannerVersion({ CPT_APP_VERSION: '0.1.207' }), '0.1.207');
});

test('B. 주입이 없으면 package.json 으로 폴백한다', () => {
  assert.equal(bannerVersion({ CPT_APP_VERSION: '' }), PKG_VERSION);
});

test('C. 쓰레기 값은 무시한다', () => {
  assert.equal(bannerVersion({ CPT_APP_VERSION: 'dev-build' }), PKG_VERSION);
});

test('D. PC 앱 사이드카 spawn 이 실제로 버전을 주입한다', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'codingpt_pc', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(lib, /cmd\.env\("CPT_APP_VERSION",\s*app\.package_info\(\)\.version/,
    '주입이 빠지면 데몬은 조용히 package.json 버전(0.1.0)으로 되돌아간다');
});

test('E. 클라이언트도 자기 버전을 신고한다(ui_hello) — 서버가 조합을 관측할 유일한 단서', () => {
  const pc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'codingpt_pc', 'src', 'js', 'ui-channel.js'), 'utf8');
  assert.match(pc, /appVersion: appVer \|\| undefined/);
  assert.match(pc, /await ensureAppVer\(\);/, 'hello 는 onopen 동기 전송이라 소켓 열기 전에 확보해야 한다');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'codingpt_app', 'src', 'services', 'notificationService.ts'), 'utf8');
  assert.match(app, /appVersion: appVersionLabel\(\)/);
  const back = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'codingpt_back', 'services', 'daemonRelayService.js'), 'utf8');
  assert.match(back, /appVersion: typeof msg\.appVersion === 'string'/);
});
