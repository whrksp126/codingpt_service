// 파일 트리의 git 표시·여러 개 선택(tree-status.js).
import assert from "node:assert";
import { buildTreeStatus, statusOf, statusSig, clickSelect, topLevel } from "../src/js/tree-status.js";

const res = { repo: true, branch: "main", entries: [
  { path: "src/a.js", status: "M" }, { path: "src/gone.js", status: "D" }, { path: "src/sub/", status: "U" },
  { path: "docs/new.md", status: "A" }, { path: "docs/moved.md", status: "R" }, { path: "top.md", status: "M" }],
  ignored: ["node_modules/", "src/debug.log"] };
const st = buildTreeStatus(res);
const of = (rel, dir) => statusOf(st, rel, !!dir);
assert.deepStrictEqual(of("src/a.js"), { letter: "M", ignored: false });
assert.deepStrictEqual(of("src", true), { letter: "D", ignored: false }, "폴더 = 안의 가장 센 변경(삭제 > 수정)");
assert.deepStrictEqual(of("docs", true), { letter: "A", ignored: false }, "추가 > 이름 변경");
assert.deepStrictEqual(of("src/sub", true), { letter: "U", ignored: false });
assert.deepStrictEqual(of("src/sub/deep/x.js"), { letter: "U", ignored: false }, "폴더째 추적 안 함 → 안의 것도 U");
assert.deepStrictEqual(of("src/clean.js"), { letter: "", ignored: false });
assert.deepStrictEqual(of("node_modules", true), { letter: "", ignored: true });
assert.deepStrictEqual(of("node_modules/x/i.js"), { letter: "", ignored: true });
assert.deepStrictEqual(of("src/debug.log"), { letter: "", ignored: true });
assert.deepStrictEqual(statusOf(buildTreeStatus({ repo: false }), "a.js", false), { letter: "", ignored: false }, "저장소가 아니면 표시 없음");
assert.deepStrictEqual(statusOf(null, "a.js", false), { letter: "", ignored: false });
assert.strictEqual(statusSig(res), statusSig({ ...res, entries: res.entries.slice().reverse() }), "서명은 순서와 무관");
assert.notStrictEqual(statusSig(res), statusSig({ ...res, entries: res.entries.slice(1) }));
assert.strictEqual(statusOf(buildTreeStatus({ repo: true, entries: [{ path: "x/a", status: "M" }, { path: "x/b", status: "!" }] }), "x", true).letter, "!", "충돌이 가장 세다");

const rows = ["a", "b", "b/1", "b/2", "c", "d"];
let sel = clickSelect(rows, { paths: new Set(), anchor: null }, "b/1");
assert.deepStrictEqual([...sel.paths], ["b/1"]);
sel = clickSelect(rows, sel, "d", { shift: true });
assert.deepStrictEqual([...sel.paths], ["b/1", "b/2", "c", "d"], "⇧ = 기준부터 거기까지");
assert.strictEqual(sel.anchor, "b/1");
sel = clickSelect(rows, sel, "a", { meta: true });
assert.deepStrictEqual([...sel.paths].sort(), ["a", "b/1", "b/2", "c", "d"], "⌘ = 더하기");
sel = clickSelect(rows, sel, "c", { meta: true });
assert.ok(!sel.paths.has("c"), "⌘ 로 다시 누르면 뺀다");
sel = clickSelect(rows, { paths: new Set(["a"]), anchor: "a" }, "a", { meta: true });
assert.deepStrictEqual([...sel.paths], ["a"], "마지막 하나는 빼지 않는다");
sel = clickSelect(rows, sel, "c");
assert.deepStrictEqual([...sel.paths], ["c"], "그냥 누르면 그 하나");
assert.deepStrictEqual(topLevel(new Set(["b", "b/1", "c", "bb"])), ["b", "bb", "c"], "폴더와 그 안을 같이 고르면 폴더만");
console.log("tree-status: ok");
