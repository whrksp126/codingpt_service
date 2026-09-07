// 로컬 워크스페이스의 "어느 PC 것인가"(hostDeviceId) 계약 — 소스 대조 + 순수 판정.
//  실행: node --test test/workspace-host.test.js
//
// 2026-09-07 실사고:
//   PC 에 등록해 쓰던 워크스페이스가 **폰 사이드바에서 통째로 사라졌다.** 메인 화면엔 보였다.
//   진범은 JWT 생성 경로(/api/workspaces)가 hostDeviceId 를 안 심은 것. 데몬 경로는 원래 심고 있었다.
//   귀속이 없으면 클라는 "내 기기 것" 으로 해석하는데, 폰에서 그 PC 는 '내 기기' 가 아니다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('JWT 생성 경로가 hostDeviceId 를 심는다 (이 사고의 진범)', () => {
  const c = read('controllers/workspaceController.js');
  assert.match(c, /resolveOwnedHostForUser/, '귀속 결정 헬퍼가 없다');
  assert.match(c, /createWorkspace\(req\.user\.id, \{[^}]*hostDeviceId \}\)/, 'createWorkspace 에 hostDeviceId 를 안 넘긴다');
});

test('요청이 지정한 PC 는 소유·역할을 검증한다 (남의 PC·폰·클라우드에 귀속 금지)', () => {
  const c = read('controllers/workspaceController.js');
  assert.match(c, /where: \{ id: rid, user_id: userId, revoked_at: null \}/);
  assert.match(c, /owned\.role !== 'controller' && owned\.runner_kind !== 'cloud'/);
});

test('지정이 없으면 계정의 PC 가 하나뿐일 때만 귀속한다 (여럿이면 추측 금지)', () => {
  const c = read('controllers/workspaceController.js');
  assert.match(c, /pcs\.length === 1 \? pcs\[0\]\.id : undefined/);
});

test('목록 조회가 귀속 빠진 로컬 워크스페이스를 자동 복구·저장한다', () => {
  const s = read('services/workspaceService.js');
  assert.match(s, /const soleHost = hosts\.length === 1 \? hosts\[0\]\.id : null;/);
  assert.match(s, /setWorkspaceHost\(userId, w\.id, hid\)\.catch\(\(\) => \{\}\)/, '복구를 저장하지 않으면 매 조회마다 같은 일을 한다');
  // 읽기 경로의 쓰기는 실패해도 목록을 막으면 안 된다 — await 하지 않는 것이 계약이다.
  assert.ok(!/await setWorkspaceHost\(userId, w\.id, hid\)/.test(s), '복구 저장을 await 하면 쓰기 실패가 목록을 죽인다');
  // 역할 판정에 필요한 컬럼을 실제로 읽어와야 한다(예전엔 이름만 읽었다).
  assert.match(s, /attributes: \['id', 'device_name', 'device_alias', 'role', 'runner_kind'\]/);
});

test('복구된 귀속이 응답에도 실린다 (클라가 다음 조회를 기다리지 않게)', () => {
  const s = read('services/workspaceService.js');
  assert.match(s, /\.\.\.\(hid != null \? \{ hostDeviceId: hid \} : \{\}\)/);
});

// enrichHosts 의 판정부만 떼어 확인 — PC 가 여럿이면 절대 추측하지 않는다.
test('PC 가 여럿이면 자동 복구하지 않는다 (유령 워크스페이스 방지)', () => {
  const pick = (hosts) => (hosts.length === 1 ? hosts[0].id : null);
  assert.strictEqual(pick([{ id: 393 }]), 393);
  assert.strictEqual(pick([{ id: 393 }, { id: 500 }]), null);
  assert.strictEqual(pick([]), null);
});

test('컨트롤러(폰)·클라우드 러너는 PC 후보가 아니다', () => {
  const rows = [
    { id: 393, role: 'host', runner_kind: 'local' },
    { id: 394, role: 'controller', runner_kind: 'local' },
    { id: 395, role: 'host', runner_kind: 'cloud' },
  ];
  const pcs = rows.filter((d) => d.role !== 'controller' && d.runner_kind !== 'cloud');
  assert.deepStrictEqual(pcs.map((d) => d.id), [393]);
});
