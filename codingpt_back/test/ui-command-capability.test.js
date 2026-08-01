// ui_command 실행 기기 선정 — 능력 기준(2026-08-01 적출한 조용한 실패의 수정)
//
// 실패 시나리오(수정 전): 서버는 "방금 만진 기기" 만 보고 executor 를 골랐고, 그 기기가 그 명령을
// 할 줄 아는지는 확인하지 않았다. 폰(구버전)을 잠깐 보고 PC 가 백그라운드면 폰이 executor 가 되어
// 새 명령이 폰으로 가고 "지원하지 않는 명령" 으로 조용히 실패한다. 사용자에겐 "폰을 켜두면 PC
// 기능이 안 되는" 비결정적 버그로 보인다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { _clientCanRun: clientCanRun, _normCmdNames: normCmdNames } = require('../services/daemonRelayService');

test('신고한 명령은 실행 가능으로 본다', () => {
  const meta = { uiCmds: ['ideOpen', 'previewOpen'] };
  assert.equal(clientCanRun(meta, 'ideOpen'), true);
  assert.equal(clientCanRun(meta, 'previewOpen'), true);
});

test('신고하지 않은 명령은 실행 불가 — 이게 조용한 실패를 막는 핵심이다', () => {
  assert.equal(clientCanRun({ uiCmds: ['ideOpen'] }, 'previewInspect'), false);
});

test("접두사 계열('browser.*')은 하위 명령 전체를 커버한다", () => {
  const meta = { uiCmds: ['browser.*'] };
  assert.equal(clientCanRun(meta, 'browser.click'), true);
  assert.equal(clientCanRun(meta, 'browser.screenshot'), true);
  assert.equal(clientCanRun(meta, 'ideOpen'), false);
});

test('미신고(구 클라이언트)는 "모름" 이지 "불가" 가 아니다 — 배제하면 기존 동작이 깨진다', () => {
  assert.equal(clientCanRun({}, 'ideOpen'), true);
  assert.equal(clientCanRun({ uiCmds: null }, 'ideOpen'), true);
  assert.equal(clientCanRun(undefined, 'ideOpen'), true);
});

test('빈 배열은 "아무것도 못 함" 이다(미신고와 구분)', () => {
  assert.equal(clientCanRun({ uiCmds: [] }, 'ideOpen'), false);
  assert.deepEqual(normCmdNames([]), [], '빈 배열은 빈 배열로 남는다(null 로 뭉개지 않는다)');
  assert.equal(normCmdNames(undefined), null, '미신고는 null(모름)');
});

test('정규화: 문자열만·중복 제거·상한', () => {
  assert.deepEqual(normCmdNames(['a', 'a', 1, null, ' b ']), ['a', 'b']);
  assert.equal(normCmdNames(Array.from({ length: 200 }, (_, i) => 'c' + i)).length, 64);
});

test('선정 로직이 능력을 실제로 적용한다(소스 계약)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/daemonRelayService.js'), 'utf8');
  // 후보를 능력으로 거르고, 아무도 못 하면 명확한 실패로 되돌린다.
  assert.match(src, /const capable = clients\.filter\(\(ws\) => clientCanRun\(ws\._cptMeta, msg\.cmd\)\)/);
  assert.match(src, /NO_CAPABLE_CLIENT/);
  // 명시 타겟이 못 하면 몰래 다른 기기로 넘기지 않는다(--on 의 의미 보존).
  assert.match(src, /TARGET_UNSUPPORTED/);
  // 브로드캐스트도 할 줄 아는 화면에만.
  assert.match(src, /msg\.mode === 'broadcast' \? capable : \[executor\]/);
});

test('클라이언트 양쪽이 실제로 목록을 신고한다', () => {
  const pc = fs.readFileSync(path.join(__dirname, '../../codingpt_pc/src/js/ui-channel.js'), 'utf8');
  // PC 는 핸들러 테이블에서 직접 뽑는다 — 손으로 적으면 반드시 어긋난다.
  assert.match(pc, /uiCmds: \[\.\.\.Object\.keys\(handlers\), "browser\.\*"\]/);
  const app = fs.readFileSync(path.join(__dirname, '../../../codingpt_app/src/services/notificationService.ts'), 'utf8');
  assert.match(app, /uiCmds: UI_COMMAND_NAMES/);
  const names = fs.readFileSync(path.join(__dirname, '../../../codingpt_app/src/workspace/uiCommandNames.ts'), 'utf8');
  // 앱 목록은 UiCommandBridge 의 switch 와 같은 집합이어야 한다(구현한 것만 신고).
  const bridge = fs.readFileSync(path.join(__dirname, '../../../codingpt_app/src/workspace/UiCommandBridge.tsx'), 'utf8');
  const declared = [...names.matchAll(/'([a-zA-Z.*]+)'/g)].map((m) => m[1]).filter((n) => !n.endsWith('.*'));
  const implemented = new Set([...bridge.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]));
  const missing = declared.filter((n) => !implemented.has(n));
  assert.deepEqual(missing, [], '신고했는데 구현이 없는 명령이 있으면 서버가 그 화면을 골라 실패한다');
});
