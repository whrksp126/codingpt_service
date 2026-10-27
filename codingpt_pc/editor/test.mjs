// issue-editor — 마크다운 왕복·첨부 자리·유령 문자. 번들(PC 가 실제로 싣는 파일)을 happy-dom 위에서 돌린다.
import path from "node:path";
import { createRequire } from "node:module";
const here = path.dirname(new URL(import.meta.url).pathname);
const req = createRequire(path.join(here, "package.json"));
const { Window } = req("happy-dom");
const w = new Window();
for (const k of ["window", "document", "Node", "HTMLElement", "getComputedStyle", "DOMParser", "Element", "MutationObserver", "Event", "KeyboardEvent", "requestAnimationFrame"]) globalThis[k] = k === "window" ? w : w[k];
const { createIssueEditor } = await import("file://" + path.join(here, "../src/vendor/issue-editor/issue-editor.js"));
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };
const DOC = ["# 로그인 리다이렉트", "", "재현: **홈**에서 *로그인* 후 ~~뒤로~~ `router.push` 가 두 번 돈다.", "둘째 줄", "", "- 크롬", "- 사파리", "",
  "- [ ] 원인 찾기", "- [x] 재현 영상", "", "1. 로그인", "2. 뒤로 가기", "", "> 기대: 원래 페이지", "> 실제: /home", "", "```", "if (a < b) go();", "```", "",
  "---", "", "![오류 화면](att:aaaaaa1)", "참고 [문서](https://a.io/x)"].join("\n");
const ed = createIssueEditor({ value: DOC });
document.body.appendChild(ed.el);
ok(ed.getMarkdown() === DOC, "왕복: 제목·굵게·기울임·취소선·코드·목록 3종·인용·코드 블록·구분선·이미지·링크", JSON.stringify(ed.getMarkdown()));
ok(JSON.stringify(ed.imageIds()) === '["aaaaaa1"]', "첨부 그림 자리(att:ID)를 찾는다");
for (const s of ["", "한 줄", "a\nb\n\nc", "- 하나\n  - 둘"]) { ed.setMarkdown(s); ok(ed.getMarkdown() === s, "왕복 " + JSON.stringify(s), JSON.stringify(ed.getMarkdown())); }
ed.setMarkdown("가나다");
ok(ed.getMarkdown() === "가나다", "유령 문자(PUA 방향키)는 걷는다", JSON.stringify(ed.getMarkdown()));
ed.setMarkdown("글");
ed.focus("end"); ed.insertImage({ id: "bbbbbb2", name: "[캡처]" }, "");
ok(/!\[캡처\]\(att:bbbbbb2\)/.test(ed.getMarkdown()), "그림 넣기 → 마크다운에 att 로 남는다(이름의 대괄호는 뺀다)", JSON.stringify(ed.getMarkdown()));
ed.removeImage("bbbbbb2");
ok(!/att:bbbbbb2/.test(ed.getMarkdown()), "그림 빼기");
ed.setMarkdown("항목"); ed.focus("end"); ed.exec("todo");
ok(ed.getMarkdown() === "- [ ] 항목", "명령: 체크 목록", JSON.stringify(ed.getMarkdown()));
ed.exec("todo"); ed.exec("h2");
ok(ed.getMarkdown() === "## 항목", "명령: 제목 2", JSON.stringify(ed.getMarkdown()));
let fired = 0; ed.el.addEventListener("input", () => fired++); ed.exec("h2");
ok(fired > 0, "바뀌면 el 에 input 이 난다");
console.log(`\nissue-editor: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
