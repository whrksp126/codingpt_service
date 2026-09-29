/**
 * 스크린 버퍼(capture-pane 등가) 검증 — SGR 포함/미포함·히스토리(-S)·랩 병합(-J)·커서·타이틀·모드.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Screen } = require('../lib/screen');

async function write(s, data) {
  s.write(data);
  await s.flush();
}

test('captureText — 보이는 화면 텍스트(capture-pane -p 등가)', async () => {
  const s = new Screen(40, 5);
  await write(s, 'hello\r\nworld');
  const out = s.captureText();
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'hello');
  assert.strictEqual(lines[1], 'world');
  assert.strictEqual(lines.length, 5); // 화면 rows 만큼
  s.dispose();
});

test('captureEscapes — SGR 시퀀스 보존(capture-pane -e 등가)', async () => {
  const s = new Screen(40, 5);
  await write(s, '\x1b[31mRED\x1b[0m plain \x1b[1;44mBOLD-BG\x1b[0m');
  const out = s.captureEscapes();
  assert.ok(out.includes('\x1b[31m'), '31(빨강) SGR 이 보존돼야 한다: ' + JSON.stringify(out));
  assert.ok(out.includes('RED'), '본문 보존');
  assert.ok(/\x1b\[[0-9;]*44/.test(out) || out.includes('44m'), '배경색 SGR 보존');
  assert.ok(!out.includes('\r\n'), '행 구분은 \\n 으로 정규화(소비자 split 규약)');
  s.dispose();
});

test('lines(-S -N) — 스크롤백 위 히스토리 포함', async () => {
  const s = new Screen(20, 3);
  // rows=3 화면 밖으로 밀려나게 6줄 출력.
  await write(s, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\r\n'));
  const visible = s.captureText();
  assert.ok(!visible.includes('l1'), 'l1 은 화면 밖(히스토리)');
  const withHist = s.captureText({ lines: 3 });
  assert.ok(withHist.includes('l1'), '-S -3 로 히스토리 포함: ' + JSON.stringify(withHist));
  const esc = s.captureEscapes({ lines: 3 });
  assert.ok(esc.includes('l1'), 'escapes 모드도 히스토리 포함');
  s.dispose();
});

test('join(-J) — 랩된 줄 병합', async () => {
  const s = new Screen(10, 5);
  await write(s, 'abcdefghijklmnopqrst'); // 10컬럼에서 2줄로 랩
  const plain = s.captureText().split('\n');
  assert.strictEqual(plain[0], 'abcdefghij');
  assert.strictEqual(plain[1], 'klmnopqrst');
  const joined = s.captureText({ join: true }).split('\n');
  assert.strictEqual(joined[0], 'abcdefghijklmnopqrst');
  s.dispose();
});

test('cursor — cursor_x/cursor_y 등가', async () => {
  const s = new Screen(40, 5);
  await write(s, 'ab\r\ncd');
  assert.deepStrictEqual(s.cursor(), { x: 2, y: 1 });
  s.dispose();
});

test('title — OSC 0/2 추적(pane_title 등가)', async () => {
  const s = new Screen(40, 5);
  assert.strictEqual(s.title, '');
  await write(s, '\x1b]2;내 작업\x07');
  assert.strictEqual(s.title, '내 작업');
  s.dispose();
});

test('모드 — DECCKM(방향키)·bracketed paste 감지', async () => {
  const s = new Screen(40, 5);
  assert.strictEqual(s.appCursor, false);
  assert.strictEqual(s.bracketedPaste, false);
  await write(s, '\x1b[?1h\x1b[?2004h');
  assert.strictEqual(s.appCursor, true);
  assert.strictEqual(s.bracketedPaste, true);
  s.dispose();
});

test('serializeRepaint — attach 전체 리페인트(리셋+내용+커서)', async () => {
  const s = new Screen(40, 5);
  await write(s, '\x1b[32mgreen\x1b[0m\r\nline2');
  const r = s.serializeRepaint();
  assert.ok(r.startsWith('\x1bc'), 'RIS 로 시작');
  assert.ok(r.includes('green') && r.includes('line2'), '화면 내용 포함');
  assert.ok(/\x1b\[2;6H$/.test(r), '커서 위치 복원으로 끝: ' + JSON.stringify(r.slice(-12)));
  s.dispose();
});

test('resize — 스크린 버퍼 크기 추종', async () => {
  const s = new Screen(80, 24);
  s.resize(120, 40);
  assert.strictEqual(s.cols, 120);
  assert.strictEqual(s.rows, 40);
  s.dispose();
});
