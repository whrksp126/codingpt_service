/**
 * tmux 키 표기 변환기 검증 — cpt-server/composer 실사용 표기 전수 커버.
 *  (Enter/Escape/Tab/BTab=S-Tab/방향키/C-u/C-c/BSpace(-N)/M-Enter/Home/End/PPage/NPage/DC/
 *   리터럴/-l 모드/bracketed paste 마커 통과/16진/수식어 조합)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { keyToBytes, keysToBytes } = require('../lib/keys');

test('제어키 — cpt 실사용(C-c·C-u·C-d)', () => {
  assert.strictEqual(keyToBytes('C-c'), '\x03');
  assert.strictEqual(keyToBytes('C-u'), '\x15');
  assert.strictEqual(keyToBytes('C-d'), '\x04');
  assert.strictEqual(keyToBytes('^C'), '\x03');       // tmux 캐럿 표기 동치
  assert.strictEqual(keyToBytes('C-Space'), '\x00');
  assert.strictEqual(keyToBytes('C-?'), '\x7f');
});

test('고정 이름 — Enter/Escape/Tab/Space/BSpace', () => {
  assert.strictEqual(keyToBytes('Enter'), '\r');
  assert.strictEqual(keyToBytes('Escape'), '\x1b');
  assert.strictEqual(keyToBytes('Tab'), '\t');
  assert.strictEqual(keyToBytes('Space'), ' ');
  assert.strictEqual(keyToBytes('BSpace'), '\x7f');
});

test('shift+tab — BTab 과 S-Tab 은 같은 \\x1b[Z', () => {
  assert.strictEqual(keyToBytes('BTab'), '\x1b[Z');
  assert.strictEqual(keyToBytes('S-Tab'), '\x1b[Z');
});

test('meta — M-Enter(컴포저 개행 버스트)·M-x', () => {
  assert.strictEqual(keyToBytes('M-Enter'), '\x1b\r');
  assert.strictEqual(keyToBytes('M-x'), '\x1bx');
});

test('방향키 — DECCKM 상태에 따라 CSI/SS3', () => {
  assert.strictEqual(keyToBytes('Up'), '\x1b[A');
  assert.strictEqual(keyToBytes('Down'), '\x1b[B');
  assert.strictEqual(keyToBytes('Right'), '\x1b[C');
  assert.strictEqual(keyToBytes('Left'), '\x1b[D');
  assert.strictEqual(keyToBytes('Up', { appCursor: true }), '\x1bOA');
  assert.strictEqual(keyToBytes('Left', { appCursor: true }), '\x1bOD');
});

test('수식어 붙은 방향키 — xterm CSI 1;m', () => {
  assert.strictEqual(keyToBytes('C-Up'), '\x1b[1;5A');
  assert.strictEqual(keyToBytes('S-Down'), '\x1b[1;2B');
  assert.strictEqual(keyToBytes('M-Right'), '\x1b[1;3C');
  assert.strictEqual(keyToBytes('C-M-Left'), '\x1b[1;7D');
});

test('tilde 계열 — Home/End/PPage/NPage/DC/IC', () => {
  assert.strictEqual(keyToBytes('Home'), '\x1b[1~');
  assert.strictEqual(keyToBytes('End'), '\x1b[4~');
  assert.strictEqual(keyToBytes('PPage'), '\x1b[5~');
  assert.strictEqual(keyToBytes('NPage'), '\x1b[6~');
  assert.strictEqual(keyToBytes('DC'), '\x1b[3~');
  assert.strictEqual(keyToBytes('IC'), '\x1b[2~');
  assert.strictEqual(keyToBytes('C-PPage'), '\x1b[5;5~');
});

test('F키', () => {
  assert.strictEqual(keyToBytes('F1'), '\x1bOP');
  assert.strictEqual(keyToBytes('F5'), '\x1b[15~');
  assert.strictEqual(keyToBytes('F12'), '\x1b[24~');
});

test('단일 문자·숫자(다이얼로그 숫자키)는 그대로', () => {
  assert.strictEqual(keyToBytes('1'), '1');
  assert.strictEqual(keyToBytes('a'), 'a');
  assert.strictEqual(keyToBytes('S-a'), 'A');
});

test('미인식 다중 문자 = 리터럴(tmux 동일 의미론)', () => {
  assert.strictEqual(keyToBytes('hello world'), 'hello world');
  assert.strictEqual(keyToBytes('대신 pwd 만 실행해'), '대신 pwd 만 실행해');
});

test('-l 리터럴 모드 — 무변환(bracketed paste 마커 포함)', () => {
  assert.strictEqual(keyToBytes('C-c', { literal: true }), 'C-c');
  const paste = '\x1b[200~여러 줄\n본문\x1b[201~';
  assert.strictEqual(keyToBytes(paste, { literal: true }), paste);
});

test('16진 표기(0x03)', () => {
  assert.strictEqual(keyToBytes('0x03'), '\x03');
  assert.strictEqual(keyToBytes('0x7f'), '\x7f');
});

test('-N 반복(count) — BSpace 잔여 지우기 시나리오', () => {
  assert.strictEqual(keysToBytes(['BSpace'], { count: 3 }), '\x7f\x7f\x7f');
  assert.strictEqual(keysToBytes(['Down', 'Down', 'Enter']), '\x1b[B\x1b[B\r');
});
