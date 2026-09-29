'use strict';
// 공유 표면 목록(surfaces.js) — 어느 기기에서 열면 전부에, 어디서 닫으면 전부에서(사용자 결정 2026-09-20).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-surf-'));
const runtime = require('../runtime');
runtime.init({ ...runtime.get(), stateDir: path.join(tmpHome, 'state'), root: tmpHome });
const S = require('../surfaces');

test('add/list/update/remove — 멱등·워크스페이스별·와이어 필드만', async () => {
  let notified = 0; S.setNotify(() => { notified++; });
  fs.mkdirSync(path.join(tmpHome, 'proj'), { recursive: true });
  const cwd = 'proj';
  assert.deepStrictEqual(S.list({ cwd }).items, []);
  const a = S.add({ cwd, id: 'pv1', kind: 'preview', url: 'http://localhost:3000', junk: 1 });
  assert.strictEqual(a.item.id, 'pv1'); assert.strictEqual(a.item.url, 'http://localhost:3000');
  assert.ok(!('junk' in a.item) && !('ws' in a.item), '모르는 필드·내부 필드는 안 싣는다');
  assert.strictEqual(notified, 1);
  //  같은 내용으로 다시 add = 변화 없음(알림도 없음). 상대·절대·~/ 경로가 같은 키로 모인다.
  S.add({ cwd: path.join(tmpHome, 'proj'), id: 'pv1', kind: 'preview', url: 'http://localhost:3000' });
  assert.strictEqual(notified, 1);
  assert.strictEqual(S.wsKey('proj'), S.wsKey(path.join(tmpHome, 'proj') + '/'));
  S.add({ cwd, id: 'ide1', kind: 'ide', openPath: 'src/a.ts' });
  assert.deepStrictEqual(S.list({ cwd }).items.map((s) => s.id), ['pv1', 'ide1']);
  assert.deepStrictEqual(S.list({ cwd: 'other' }).items, [], '다른 워크스페이스에는 안 보인다');
  //  update — 없는 id 는 missing, 같은 값은 무변화
  assert.strictEqual(S.update({ cwd, id: 'nope', url: 'x' }).missing, true);
  const n0 = notified;
  S.update({ cwd, id: 'pv1', url: 'http://localhost:3000' });
  assert.strictEqual(notified, n0);
  S.update({ cwd, id: 'pv1', url: 'http://localhost:3001' });
  assert.strictEqual(S.list({ cwd }).items[0].url, 'http://localhost:3001');
  assert.strictEqual(notified, n0 + 1);
  //  remove — 멱등
  assert.strictEqual(S.remove({ cwd, id: 'pv1' }).ok, true);
  assert.strictEqual(S.remove({ cwd, id: 'pv1' }).missing, true);
  assert.deepStrictEqual(S.list({ cwd }).items.map((s) => s.id), ['ide1']);
  //  handle 라우팅 + 잘못된 입력
  assert.deepStrictEqual((await S.handle('surface.list', { cwd })).items.map((s) => s.id), ['ide1']);
  await assert.rejects(S.handle('surface.add', { cwd, id: 'x', kind: 'terminal' }), /kind/);
  await assert.rejects(S.handle('surface.add', { cwd, id: 'bad id!', kind: 'ide' }), /id/);
  await assert.rejects(S.handle('surface.nope', {}), /알 수 없는/);
  assert.strictEqual(S.forgetWs(cwd), 1);
  assert.deepStrictEqual(S.list({ cwd }).items, []);
});

test('에이전트 PC 는 OS별로 하나 — 같은 OS 는 흡수, macOS·Linux 는 공존', () => {
  const cwd = 'proj';
  const a = S.add({ cwd, id: 'emuA', kind: 'emulator', deviceId: 'desktop:macos' });
  assert.strictEqual(a.item.id, 'emuA');
  //  같은 OS 를 다른 id 로 → 있는 것을 돌려준다(흡수)
  const b = S.add({ cwd, id: 'emuB', kind: 'emulator', deviceId: 'desktop:macos' });
  assert.strictEqual(b.item.id, 'emuA'); assert.strictEqual(b.merged, true);
  //  ★ 다른 OS(Linux)는 별개 표면으로 공존한다(예전엔 desktop 하나로 흡수됐다)
  const l = S.add({ cwd, id: 'emuL', kind: 'emulator', deviceId: 'desktop:linux' });
  assert.strictEqual(l.item.id, 'emuL'); assert.ok(!l.merged);
  assert.strictEqual(S.list({ cwd }).items.filter((s) => (s.deviceId || '').startsWith('desktop:')).length, 2);
  //  일반 모바일 화면은 여럿 가능 — macOS·Linux·android = 3
  S.add({ cwd, id: 'emuC', kind: 'emulator', deviceId: 'android:emulator-5554' });
  assert.strictEqual(S.list({ cwd }).items.length, 3);
  S.forgetWs(cwd);
});

test('cpt-server·control 이 같은 함수를 타고 terminal.list 에 surfaces 를 싣는다(소스 계약)', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');
  assert.ok(/if \(cmd\.startsWith\('surface\.'\)\) return handleSurfaceRpc\(cmd, req\.args \|\| \{\}\);/.test(cs));
  assert.ok(/lib\.setNotify\(notifyPoolChanged\)/.test(cs), '변경은 pool.changed 로 전 기기에');
  assert.ok(/method\.startsWith\('surface\.'\)\) \{ cptServer\.handleSurfaceRpc/.test(ctl));
  assert.ok(/r\.surfaces = require\('\.\/surfaces'\)\.list/.test(cs) && /r\.surfaces = require\('\.\/surfaces'\)\.list/.test(ctl), '두 경로 모두 terminal.list 에 surfaces');
});
