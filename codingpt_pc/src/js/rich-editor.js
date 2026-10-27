// rich-editor.js — 이슈 본문 편집기. 2026-10-28 부터 정본은 `editor/`(Tiptap 기반, PC·폰 공용 번들)다.
//  직접 짠 contenteditable(마크다운 왕복·단축 입력·블록 옮기기·/ 메뉴·유령 문자 처방, 640줄)은 걷었다 —
//  같은 일을 ProseMirror 가 한다. 여기는 옛 이름(createRichEditor)을 지키는 얇은 입구다.
//  번들 다시 만들기: `cd editor && npm i && npm run build`.
import { createIssueEditor } from "../vendor/issue-editor/issue-editor.js";

/** o = { value, t, resolveImage(attId), onPaste(), onAttach(), onOpenLink(href) } → { el, getMarkdown, setMarkdown, insertImage, removeImage, imageIds, focus } */
export function createRichEditor(o) {
  return createIssueEditor(o);
}
