// 실행 취소 기록(undo-history.js) — 낱말·쉼·종류마다 한 단계. 웹뷰 기본처럼 "친 글 전체" 가 한 번에 사라지면 안 된다.
import assert from "node:assert";
import { createHistory, classifyInput, undoKeyOf, GROUP_MS } from "../src/js/undo-history.js";

const type = (h, text, t0) => { let s = h._s || ""; let t = t0; for (const ch of text) { s += ch; h.record(s, { ...classifyInput({ inputType: "insertText", data: ch }), now: t }); t += 50; } h._s = s; return t; };

{ // 낱말 단위 — "hello world foo" 뒤 ⌘Z 는 마지막 낱말만 지운다
  const h = createHistory("");
  type(h, "hello world foo", 0);
  assert.strictEqual(h.undo(), "hello world ");
  assert.strictEqual(h.undo(), "hello ");
  assert.strictEqual(h.undo(), "");
  assert.strictEqual(h.undo(), null, "처음 상태 밑으로는 안 내려간다");
  assert.strictEqual(h.redo(), "hello ");
  assert.strictEqual(h.redo(), "hello world ");
  assert.strictEqual(h.redo(), "hello world foo");
  assert.strictEqual(h.redo(), null);
}
{ // 잠깐 쉬면 단계가 끊긴다
  const h = createHistory("");
  const t = type(h, "abc", 0);
  h._s = "abc"; type(h, "def", t + GROUP_MS + 10);
  assert.strictEqual(h.undo(), "abc");
}
{ // 커서를 옮기면(seal) 끊긴다 · 지우기는 입력과 안 묶인다
  const h = createHistory("");
  h.record("ab", { kind: "type", now: 0 });
  h.seal();
  h.record("abc", { kind: "type", now: 10 });
  h.record("ab", { kind: "del", now: 20 });
  h.record("a", { kind: "del", now: 30 });
  assert.strictEqual(h.undo(), "abc", "이어 지운 것은 한 단계");
  assert.strictEqual(h.undo(), "ab");
  assert.strictEqual(h.undo(), "");
}
{ // 되돌린 뒤 새로 쓰면 앞날(redo)은 버린다 · 종류 없는 편집(서식·붙여넣기)은 늘 제 단계
  const h = createHistory("0");
  h.record("1", { kind: "", now: 0 }); h.record("2", { kind: "", now: 1 });
  assert.strictEqual(h.size(), 3);
  h.undo();
  h.record("x", { kind: "type", now: 2 });
  assert.strictEqual(h.redo(), null);
  assert.strictEqual(h.undo(), "1");
}
assert.deepStrictEqual(classifyInput({ inputType: "insertParagraph" }), { kind: "type", boundary: true });
// 조합 입력은 composition 표시 — 받는 쪽이 건너뛰고 조합이 끝날 때 한 번 적는다(음절마다 "지우기" 단계가 끼지 않게)
for (const ty of ["insertCompositionText", "insertFromComposition", "deleteCompositionText"]) assert.strictEqual(classifyInput({ inputType: ty, data: "한" }).composition, true, ty);
assert.strictEqual(classifyInput({ inputType: "insertText", data: " " }).composition, undefined);
{ // 한글: 음절 확정마다 type 한 번, 띄어쓰기는 경계 → 낱말 단위
  const h = createHistory("");
  let t = 0;
  for (const s of ["안", "안녕"]) h.record(s, { kind: "type", boundary: false, now: (t += 80) });
  h.record("안녕 ", { kind: "type", boundary: true, now: (t += 80) });
  for (const s of ["안녕 하", "안녕 하세", "안녕 하세요"]) h.record(s, { kind: "type", boundary: false, now: (t += 80) });
  assert.strictEqual(h.undo(), "안녕 ");
  assert.strictEqual(h.undo(), "");
}
assert.deepStrictEqual(classifyInput({ inputType: "deleteContentBackward" }), { kind: "del", boundary: false });
assert.deepStrictEqual(classifyInput({ inputType: "insertFromPaste" }), { kind: "", boundary: true });
assert.strictEqual(undoKeyOf({ metaKey: true, key: "z" }), "undo");
assert.strictEqual(undoKeyOf({ metaKey: true, shiftKey: true, key: "Z" }), "redo");
assert.strictEqual(undoKeyOf({ ctrlKey: true, key: "y" }), "redo");
assert.strictEqual(undoKeyOf({ key: "z" }), "");
console.log("undo-history: ok");
