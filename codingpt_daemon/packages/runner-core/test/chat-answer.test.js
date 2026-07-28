// chat.answer(TUI 질문 다이얼로그 원격 조작) 회귀 — driveQuestionDialog 를 io 주입으로 검증한다.
//
// 키 프로토콜의 정본은 **격리 tmux 의 진짜 claude 실측**(2026-07-28, 2질문 단일+multi 완주 성공)이고,
// 이 테스트는 그 실측으로 확정한 시퀀스가 코드에서 조용히 바뀌지 않게 고정한다:
//  · 단일선택: 숫자키 1개(자동 진행)  · multiSelect: 숫자 토글들 + Tab
//  · 자유입력: (선택지수+1) 숫자 → 텍스트 → Enter
//  · Review("Ready to submit your answers?") → '1'
// 가드: 다이얼로그 부재/질문 불일치에서 키를 **한 개도** 보내지 않아야 한다 — 새면 숫자가
//  셸/컴포저에 타이핑된다(이게 이 기능의 최대 리스크다).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ca-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const { _driveQuestionDialog: drive } = require('../cpt-server');

// 화면 시나리오 대본 + 키 레코더. screens 를 순서대로 소진하고 마지막 화면을 유지한다.
function fakeIo(screens) {
  const keys = [];
  let i = 0;
  return {
    keys,
    screen: async () => screens[Math.min(i++, screens.length - 1)],
    key: async (k, literal) => { keys.push((literal ? 'L:' : 'K:') + k); },
    sleep: async () => {},
  };
}

const DIALOG = '좋아하는 계절은 무엇인가요?\n1. 봄\n2. 여름\n3. 겨울\nEnter to select · Tab/Arrow keys to navigate';
const REVIEW = 'Review your answers\nReady to submit your answers?\n1. Submit answers\n2. Cancel';
const GONE = '⏺ User answered\n❯ ';

test('단일+multi 2질문: 숫자/Tab/Review-1 시퀀스가 실측 그대로다', async () => {
  const io = fakeIo([DIALOG, REVIEW, GONE]);
  const r = await drive(io, {
    expect: '좋아하는 계절',
    answers: [
      { optionIndexes: [3], optionCount: 3, multiSelect: false },
      { optionIndexes: [1, 2], optionCount: 2, multiSelect: true },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(io.keys, ['L:3', 'L:1', 'L:2', 'K:Tab', 'L:1']);
});

test('자유입력: (선택지수+1) → 텍스트 → Enter', async () => {
  const io = fakeIo([DIALOG, GONE]);
  await drive(io, { answers: [{ optionIndexes: [], optionCount: 3, text: '다람쥐' }] });
  assert.deepStrictEqual(io.keys, ['L:4', 'L:다람쥐', 'K:Enter']);
});

test('다이얼로그 부재 → QUESTION_NOT_ON_SCREEN, 키 0개', async () => {
  const io = fakeIo([GONE]);
  await assert.rejects(() => drive(io, { answers: [{ optionIndexes: [1], optionCount: 3 }] }),
    (e) => e.code === 'QUESTION_NOT_ON_SCREEN');
  assert.strictEqual(io.keys.length, 0, '가드가 걸리면 키가 한 개도 나가면 안 된다');
});

test('질문 불일치 → QUESTION_MISMATCH, 키 0개 (공백 차이는 무시)', async () => {
  const io = fakeIo([DIALOG]);
  await assert.rejects(() => drive(io, { expect: '전혀 다른 질문', answers: [{ optionIndexes: [1], optionCount: 3 }] }),
    (e) => e.code === 'QUESTION_MISMATCH');
  assert.strictEqual(io.keys.length, 0);
  // 캡처는 줄바꿈/공백으로 감싸 오므로 expect 대조는 공백 무시여야 한다.
  const io2 = fakeIo([DIALOG, GONE]);
  await drive(io2, { expect: '좋아하는  계절은\n무엇인가요', answers: [{ optionIndexes: [1], optionCount: 3 }] });
});

test('제출이 화면에서 확인되지 않으면 DRIVE_INCOMPLETE (성공 위장 금지)', async () => {
  const io = fakeIo([DIALOG]);   // 계속 다이얼로그 화면 그대로
  await assert.rejects(() => drive(io, { answers: [{ optionIndexes: [1], optionCount: 3 }] }),
    (e) => e.code === 'DRIVE_INCOMPLETE');
});

test('9 초과 번호/빈 선택은 조작 전에 거부한다', async () => {
  const io = fakeIo([DIALOG]);
  await assert.rejects(() => drive(io, { answers: [{ optionIndexes: [10], optionCount: 12 }] }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(() => drive(io, { answers: [{ optionIndexes: [], optionCount: 3, multiSelect: true }] }), (e) => e.code === 'BAD_REQUEST');
  assert.strictEqual(io.keys.length, 0);
});
