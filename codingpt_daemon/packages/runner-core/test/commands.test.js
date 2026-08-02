// 슬래시 명령 카탈로그(commands.js) — 빌트인 실측표 + 디스크 발견의 합성 규칙 회귀.
//
// 실측 근거(2026-08-02, 격리 tmux): claude 2.1.220 `/` 목록 95개 · codex 0.146.0 46개.
//  두 CLI 모두 팝업이 **스크롤**이라 화면 미러가 불가능해 표로 심었다(commands.js 헤더).
// 이 테스트가 고정하는 것:
//  · 표가 비어 있지 않고, 채팅에서 곤란한 명령(/exit 류)이 'tui' 로 분류돼 있다(팔레트가 흐리게 그린다)
//  · 디스크에서 찾은 정의가 표를 **이긴다**(같은 이름이면 실제로 실행되는 쪽이 그쪽이다)
//  · 정렬 = 프로젝트 → 개인 → 빌트인 (사용자가 만든 것이 위로)
//  · 프론트매터 블록 스칼라(`description: >-`)를 이어 붙인다 — 실제 스킬 파일이 그 형태다
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cmd-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const cmds = require('../commands');

test('빌트인 표 — 두 CLI 다 실측 규모를 담고 있다', () => {
  const cl = cmds.listCommands({ agent: 'claude' }).items;
  const cx = cmds.listCommands({ agent: 'codex' }).items;
  assert.ok(cl.length > 60, `claude 빌트인이 너무 적다: ${cl.length}`);
  assert.ok(cx.length > 30, `codex 빌트인이 너무 적다: ${cx.length}`);
  for (const n of ['/clear', '/compact', '/model', '/context']) {
    assert.ok(cl.some((c) => c.name === n), `claude 표에 ${n} 가 없다`);
  }
  for (const n of ['/model', '/permissions', '/review', '/status']) {
    assert.ok(cx.some((c) => c.name === n), `codex 표에 ${n} 가 없다`);
  }
});

test('채팅에서 곤란한 명령은 tui 로 분류된다(팔레트가 고르지 못하게 한다)', () => {
  const cl = cmds.listCommands({ agent: 'claude' }).items;
  const byName = new Map(cl.map((c) => [c.name, c]));
  assert.strictEqual(byName.get('/exit').chat, 'tui', '세션 종료');
  assert.strictEqual(byName.get('/memory').chat, 'tui', '편집기가 열린다');
  assert.strictEqual(byName.get('/model').chat, 'dialog', '선택 화면이 뜬다');
  assert.strictEqual(byName.get('/compact').chat, 'ok');
  const cx = new Map(cmds.listCommands({ agent: 'codex' }).items.map((c) => [c.name, c]));
  assert.strictEqual(cx.get('/exit').chat, 'tui');
  assert.strictEqual(cx.get('/delete').chat, 'tui', '세션을 지우고 나간다');
  assert.strictEqual(cx.get('/permissions').chat, 'dialog');
});

test('디스크의 스킬/명령을 발견하고, 같은 이름이면 표를 이긴다', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ws-'));
  fs.mkdirSync(path.join(ws, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'skills', 'deploy.md'),
    '---\nname: deploy\ndescription: 홈서버에 배포한다\n---\n\n# deploy\n');
  // 프론트매터 블록 스칼라(실제 스킬 파일 형태) — 이걸 못 읽으면 설명이 ">-" 로 보인다(실사고).
  fs.writeFileSync(path.join(ws, '.claude', 'commands', 'notes.md'),
    '---\ndescription: >-\n  여러 줄로 쓴\n  설명이다\n---\n\n본문\n');
  // 빌트인과 같은 이름 — 프로젝트 정의가 실제로 실행되므로 그쪽 설명이 정본이다.
  fs.writeFileSync(path.join(ws, '.claude', 'commands', 'compact.md'),
    '---\nname: compact\ndescription: 프로젝트 전용 압축\n---\n');
  cmds._clearCache();

  const items = cmds.listCommands({ agent: 'claude', cwdAbs: ws }).items;
  const byName = new Map(items.map((c) => [c.name, c]));
  assert.strictEqual(byName.get('/deploy').desc, '홈서버에 배포한다');
  assert.strictEqual(byName.get('/deploy').source, 'project');
  assert.strictEqual(byName.get('/notes').desc, '여러 줄로 쓴 설명이다');
  assert.strictEqual(byName.get('/compact').desc, '프로젝트 전용 압축', '디스크가 표를 이긴다');
  assert.strictEqual(byName.get('/compact').source, 'project');

  // 정렬 — 프로젝트가 맨 앞(사용자가 만든 것이 위로 온다).
  assert.deepStrictEqual(items.slice(0, 3).map((c) => c.source), ['project', 'project', 'project']);
});

test('codex 는 디스크 발견이 없다(0.146.0 실측: 스킬·프롬프트가 슬래시로 노출되지 않는다)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ws2-'));
  fs.mkdirSync(path.join(ws, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'skills', 'nope.md'), '---\nname: nope\ndescription: x\n---\n');
  cmds._clearCache();
  const items = cmds.listCommands({ agent: 'codex', cwdAbs: ws }).items;
  assert.ok(!items.some((c) => c.name === '/nope'));
  assert.ok(items.every((c) => c.source === 'builtin'));
});

test('찾기 — 인자가 붙어 있어도 이름으로 판정한다', () => {
  cmds._clearCache();
  const hit = cmds.findCommand({ agent: 'claude', name: '/compact 인자 여러 개' });
  assert.strictEqual(hit && hit.name, '/compact');
  assert.strictEqual(cmds.findCommand({ agent: 'claude', name: '그냥 텍스트' }), null);
  assert.strictEqual(cmds.findCommand({ agent: 'claude', name: '/아무거나없음' }), null);
});
