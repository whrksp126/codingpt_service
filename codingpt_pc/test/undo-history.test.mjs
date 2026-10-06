// 실행 취소 기록(undo-history.js) — 묶는 기준은 macOS 기본(NSTextView)과 같다:
//  이어서 친 글·지운 글은 한 단계, 커서 이동·붙여넣기·서식에서만 끊긴다(2026-10-07 실측).
import assert from "node:assert";
import { createHistory, classifyInput, undoKeyOf } from "../src/js/undo-history.js";

const ins = (data) => classifyInput({ inputType: "insertText", data });
const del = classifyInput({ inputType: "deleteContentBackward" });

{ // 이어서 친 글은 낱말·줄바꿈·쉼이 있어도 한 단계
  const h = createHistory("");
  let s = ""; let t = 0;
  for (const ch of "hello world") { s += ch; h.record(s, { ...ins(ch), now: (t += 50) }); }
  h.record(s + "\n", { ...classifyInput({ inputType: "insertParagraph" }), now: (t += 5000) });
  h.record(s + "\nx", { ...ins("x"), now: (t += 60000) });
  assert.strictEqual(h.undo(), "");
  assert.strictEqual(h.undo(), null, "처음 상태 밑으로는 안 내려간다");
  assert.strictEqual(h.redo(), "hello world\nx");
  assert.strictEqual(h.redo(), null);
}
{ // 치다가 지우고 다시 쳐도 한 단계(NSTextView: type, delete×3, type = 1)
  const h = createHistory("");
  h.record("abc", ins("c")); h.record("ab", del); h.record("a", del); h.record("az", ins("z"));
  assert.strictEqual(h.undo(), "");
}
{ // 커서를 옮기면(seal) 끊긴다
  const h = createHistory("");
  h.record("abc def", ins("f"));
  h.seal();
  h.record("abcXY def", ins("Y"));
  assert.strictEqual(h.undo(), "abc def");
  assert.strictEqual(h.undo(), "");
}
{ // 붙여넣기·서식은 늘 제 단계 · 되돌린 뒤 새로 쓰면 앞날(redo)은 버린다
  const h = createHistory("0");
  h.record("0a", ins("a"));
  h.record("0a PASTE", classifyInput({ inputType: "insertFromPaste" }));
  h.record("0a PASTEb", ins("b"));
  assert.strictEqual(h.undo(), "0a PASTE");
  assert.strictEqual(h.undo(), "0a");
  h.record("0ax", ins("x"));
  assert.strictEqual(h.redo(), null);
  assert.strictEqual(h.undo(), "0a");
  assert.strictEqual(h.undo(), "0");
}
// 조합 입력은 composition 표시 — 받는 쪽이 건너뛰고 조합이 끝날 때 한 번 적는다
for (const ty of ["insertCompositionText", "insertFromComposition", "deleteCompositionText"]) assert.strictEqual(classifyInput({ inputType: ty, data: "한" }).composition, true, ty);
assert.strictEqual(ins(" ").composition, undefined);
assert.deepStrictEqual(del, { kind: "type", boundary: false });
assert.deepStrictEqual(classifyInput({ inputType: "deleteByCut" }), { kind: "", boundary: true });
assert.strictEqual(undoKeyOf({ metaKey: true, key: "z" }), "undo");
assert.strictEqual(undoKeyOf({ metaKey: true, shiftKey: true, key: "Z" }), "redo");
assert.strictEqual(undoKeyOf({ ctrlKey: true, key: "y" }), "redo");
assert.strictEqual(undoKeyOf({ key: "z" }), "");
console.log("undo-history: ok");
