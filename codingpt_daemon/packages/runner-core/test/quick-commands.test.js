// quick-commands — 저장한 명령의 저장소 계약.
//
// 이 파일이 고정하는 것:
//  · 전역(ws=null)과 프로젝트별(ws=경로)의 구분. 특히 **빈 문자열 ws 는 홈 루트 워크스페이스이지
//    전역이 아니다** — 뭉개면 루트에서 만든 명령이 모든 워크스페이스에 새어 나간다.
//  · 저장 값이 결국 터미널로 나가므로 제어문자(ESC/CR)를 반드시 털어낸다.
//  · 수정해도 목록에서 자리가 바뀌지 않는다(사용자가 놓은 자리에 있어야 한다).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-qc-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const QC = require('../quick-commands');

function reset() {
  try { fs.unlinkSync(QC._file()); } catch (_) { /* 없으면 그만 */ }
}

test('셸 명령을 저장하고 다시 읽는다', () => {
  reset();
  const r = QC.upsert({ label: '개발 서버', kind: 'shell', text: 'npm run dev', target: 'new' });
  assert.equal(r.ok, true);
  assert.match(r.item.id, /^qc_[a-f0-9]{12}$/);
  const all = QC.listAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].text, 'npm run dev');
  assert.equal(all[0].target, 'new');
  assert.equal(all[0].ws, null);
});

test('에이전트 프롬프트형은 agent 와 prompt 를 요구한다', () => {
  reset();
  assert.equal(QC.upsert({ kind: 'agent', prompt: '점검해줘' }).ok, false);   // agent 없음
  assert.equal(QC.upsert({ kind: 'agent', agent: 'claude', prompt: '  ' }).ok, false); // 내용 없음
  const r = QC.upsert({ kind: 'agent', agent: 'claude', prompt: '배포 전 점검해줘', target: 'current' });
  assert.equal(r.ok, true);
  assert.equal(r.item.agent, 'claude');
  assert.equal(r.item.target, 'current');
});

test('라벨을 비우면 내용 첫 줄로 채운다', () => {
  reset();
  const r = QC.upsert({ kind: 'shell', text: 'git status\ngit diff' });
  assert.equal(r.item.label, 'git status');
});

test('내용이 비면 저장하지 않는다', () => {
  reset();
  assert.equal(QC.upsert({ kind: 'shell', text: '   ' }).ok, false);
  assert.equal(QC.listAll().length, 0);
});

// ★ 이 두 개가 스코프 계약의 핵심이다.
test('전역은 어느 워크스페이스에서나 보인다', () => {
  reset();
  QC.upsert({ kind: 'shell', text: 'git status' });                    // ws 없음 = 전역
  assert.equal(QC.listFor('codingpt_app').length, 1);
  assert.equal(QC.listFor('other/repo').length, 1);
});

test('프로젝트별은 그 워크스페이스에서만 보인다', () => {
  reset();
  QC.upsert({ kind: 'shell', text: 'npm run android', ws: 'codingpt_app' });
  assert.equal(QC.listFor('codingpt_app').length, 1);
  assert.equal(QC.listFor('other/repo').length, 0);
});

test('빈 문자열 ws 는 홈 루트 워크스페이스이지 전역이 아니다', () => {
  reset();
  QC.upsert({ kind: 'shell', text: 'ls', ws: '' });
  assert.equal(QC.listFor('').length, 1, '루트에서는 보여야 한다');
  assert.equal(QC.listFor('codingpt_app').length, 0, '다른 워크스페이스로 새면 안 된다');
});

test('워크스페이스를 모르면 전역만 준다', () => {
  reset();
  QC.upsert({ kind: 'shell', text: 'git status' });
  QC.upsert({ kind: 'shell', text: 'npm run dev', ws: 'codingpt_app' });
  const list = QC.listFor(undefined);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'git status');
});

test('제어문자(ESC·CR)를 털어낸다 — 저장값은 터미널로 그대로 나간다', () => {
  reset();
  const r = QC.upsert({ kind: 'shell', text: 'echo hi\x1b[2J\x1brm -rf /\r' });
  assert.equal(r.item.text, 'echo hi[2Jrm -rf /');
  assert.ok(!r.item.text.includes('\x1b'));
  assert.ok(!r.item.text.includes('\r'));
});

test('탭과 개행은 살린다', () => {
  reset();
  const r = QC.upsert({ kind: 'shell', text: 'a\tb\nc' });
  assert.equal(r.item.text, 'a\tb\nc');
});

test('수정해도 목록 자리가 바뀌지 않는다', () => {
  reset();
  const a = QC.upsert({ kind: 'shell', text: 'first' }).item;
  QC.upsert({ kind: 'shell', text: 'second' });
  QC.upsert({ kind: 'shell', text: 'third' });
  QC.upsert({ id: a.id, kind: 'shell', text: 'first(고침)' });
  const all = QC.listAll();
  assert.equal(all.length, 3);
  assert.equal(all[0].id, a.id);
  assert.equal(all[0].text, 'first(고침)');
});

test('수정해도 createdAt 은 유지한다', () => {
  reset();
  const a = QC.upsert({ kind: 'shell', text: 'x' }).item;
  const after = QC.upsert({ id: a.id, kind: 'shell', text: 'y' }).item;
  assert.equal(after.createdAt, a.createdAt);
});

test('삭제는 멱등이다', () => {
  reset();
  const a = QC.upsert({ kind: 'shell', text: 'x' }).item;
  assert.deepEqual(QC.remove(a.id), { ok: true, removed: true });
  assert.deepEqual(QC.remove(a.id), { ok: true, removed: false });
  assert.deepEqual(QC.remove('qc_000000000000'), { ok: true, removed: false });
});

test('순서를 바꾸고, 빠뜨린 id 는 뒤에 남긴다', () => {
  reset();
  const a = QC.upsert({ kind: 'shell', text: 'a' }).item;
  const b = QC.upsert({ kind: 'shell', text: 'b' }).item;
  const c = QC.upsert({ kind: 'shell', text: 'c' }).item;
  const r = QC.reorder([c.id, a.id]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((x) => x.text), ['c', 'a', 'b']);
});

test('상한을 넘기면 거절한다', () => {
  reset();
  for (let i = 0; i < QC.MAX_ITEMS; i++) QC.upsert({ kind: 'shell', text: 'cmd' + i });
  const r = QC.upsert({ kind: 'shell', text: 'overflow' });
  assert.equal(r.ok, false);
  assert.match(r.error, /최대/);
  assert.equal(QC.listAll().length, QC.MAX_ITEMS);
});

test('길이 상한으로 자른다', () => {
  reset();
  const r = QC.upsert({ label: 'L'.repeat(200), kind: 'shell', text: 'x'.repeat(9000) });
  assert.equal(r.item.label.length, QC.MAX_LABEL);
  assert.equal(r.item.text.length, QC.MAX_SHELL_TEXT);
});

test('손상된 파일에서도 살아있는 항목은 살린다', () => {
  reset();
  fs.mkdirSync(path.dirname(QC._file()), { recursive: true });
  fs.writeFileSync(QC._file(), JSON.stringify({
    version: 1,
    items: [
      { id: 'qc_aaaaaaaaaaaa', kind: 'shell', text: 'good', label: 'good' },
      null,
      { id: 'qc_bbbbbbbbbbbb', kind: 'shell', text: '' },     // 내용 없음 → 버림
      'nonsense',
      { id: 'qc_cccccccccccc', kind: 'agent', agent: 'codex', prompt: 'ok', label: 'ok' },
    ],
  }));
  const all = QC.listAll();
  assert.deepEqual(all.map((x) => x.id), ['qc_aaaaaaaaaaaa', 'qc_cccccccccccc']);
});

test('파일이 없으면 빈 목록이다', () => {
  reset();
  assert.deepEqual(QC.listAll(), []);
  assert.deepEqual(QC.listFor('any'), []);
});

test('모르는 필드는 저장하지 않는다', () => {
  reset();
  const r = QC.upsert({ kind: 'shell', text: 'x', evil: 'payload', __proto__x: 1 });
  assert.equal(r.item.evil, undefined);
  assert.deepEqual(Object.keys(r.item).sort(),
    ['createdAt', 'id', 'kind', 'label', 'target', 'text', 'updatedAt', 'ws'].sort());
});
