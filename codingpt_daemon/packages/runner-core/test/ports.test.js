// net.ports — 열린 포트 목록의 파싱·접기 계약.
//
// 픽스처는 **이 Mac 의 실제 `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` 출력**에서 잘라 온 것이다.
//
// ★ 이 파일이 붙잡는 진짜 위험(2026-08-04 실측):
//  사용자의 dev 서버(front 3400 · back 5300 · admin 3300)는 전부 **Docker** 가 띄운다.
//  Docker 프로세스의 cwd 는 워크스페이스가 아니라서, "그 폴더에서 돌던 것만" 필터에 **한 개도
//  안 걸린다**. 그래서 워크스페이스 스코프만 주면 이 사용자에게는 목록이 통째로 비어 보인다.
//  → `others`(스코프 밖) 를 함께 주고, 화면은 안쪽이 비면 바깥을 펼친다.
const { test } = require('node:test');
const assert = require('node:assert');

const { _parseListenSockets: parse, _foldByPort: fold } = require('../proxy');

// 실제 출력에서 잘라온 조각(포맷 그대로).
const LSOF = [
  'p49438', 'ccom.docker.backend', 'n127.0.0.1:3400', 'n127.0.0.1:5300', 'n127.0.0.1:3300',
  'p79738', 'cnode', 'n*:3500',
  'p40856', 'cnode', 'n[::]:8081',
  'p28051', 'cFigma', 'n127.0.0.1:3845',
  'p1', 'claunchd', 'n*:22',                  // 시스템 — 제외 대상
  'p2', 'cpostgres', 'n127.0.0.1:5432',       // DB — 제외 대상
  'p3', 'cnode', 'n127.0.0.1:54321',          // 에페메랄(>10000) — 제외 대상
  'p4', 'cControlCe', 'n*:7000',              // AirPlay 오탐 — 제외 대상
  'p5', 'cssh', 'n1.2.3.4:9999',              // 외부 바인딩 — 로컬 아님
  '',
].join('\n');

test('pid·command·port 를 한 번의 출력에서 함께 읽는다', () => {
  const rows = parse(LSOF);
  const hit = rows.find((r) => r.port === 3400);
  assert.deepEqual(hit, { pid: 49438, port: 3400, command: 'com.docker.backend' });
});

test('한 프로세스가 여러 포트를 잡으면 전부 잡되 command 를 잃지 않는다', () => {
  const rows = parse(LSOF).filter((r) => r.pid === 49438);
  assert.deepEqual(rows.map((r) => r.port).sort((a, b) => a - b), [3300, 3400, 5300]);
  assert.ok(rows.every((r) => r.command === 'com.docker.backend'));
});

test('command 는 다음 프로세스 블록으로 새지 않는다', () => {
  const rows = parse(LSOF);
  assert.equal(rows.find((r) => r.port === 3500).command, 'node');
  assert.equal(rows.find((r) => r.port === 3845).command, 'Figma');
});

test('시스템·DB·에페메랄·오탐 포트를 걸러낸다', () => {
  const ports = parse(LSOF).map((r) => r.port);
  for (const p of [22, 5432, 54321, 7000]) assert.ok(!ports.includes(p), `${p} 는 빠져야 한다`);
});

test('로컬 바인딩만 센다(외부 IP 바인딩 제외)', () => {
  assert.ok(!parse(LSOF).map((r) => r.port).includes(9999));
});

test('*:와 [::]: 도 로컬로 본다(흔한 dev 서버 바인딩)', () => {
  const ports = parse(LSOF).map((r) => r.port);
  assert.ok(ports.includes(3500), '*:3500');
  assert.ok(ports.includes(8081), '[::]:8081');
});

test('빈 출력이면 빈 목록이다(lsof 실패는 조용한 빈 목록)', () => {
  assert.deepEqual(parse(''), []);
});

test('같은 포트의 이중 바인딩(IPv4/IPv6)은 하나로 접는다', () => {
  const folded = fold([
    { pid: 10, port: 3000, command: 'node' },
    { pid: 10, port: 3000, command: 'node' },   // 같은 포트 두 소켓
    { pid: 11, port: 8080, command: 'python' },
  ]);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((f) => f.port), [3000, 8080]);
});

test('포트 오름차순으로 준다(화면이 다시 정렬하지 않게)', () => {
  const folded = fold([
    { pid: 1, port: 9000, command: 'a' },
    { pid: 2, port: 3000, command: 'b' },
    { pid: 3, port: 5000, command: 'c' },
  ]);
  assert.deepEqual(folded.map((f) => f.port), [3000, 5000, 9000]);
});

test('command 가 없어도 빈 문자열로 자리를 지킨다(화면이 undefined 를 그리지 않게)', () => {
  assert.equal(fold([{ pid: 1, port: 3000 }])[0].command, '');
});
