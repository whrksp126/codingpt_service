// rich-editor.js — 이슈 본문 편집기(2026-10-07 사용자 요청: "텍스트 에디터 수준의 편집 도구").
//  보이는 대로 쓰는 편집기(contenteditable) + 도구 줄. **저장 형식은 마크다운**이다 — 에이전트가 그대로 읽고,
//  GitHub 이슈 본문과도 같은 형식이라 외부 서비스와 오갈 때 변환이 없다.
//  이미지는 본문 안에 그대로 그린다: 마크다운 `![이름](att:ID)` ↔ <img data-att="ID">.
//  md → html(mdToHtml) 과 html → md(domToMd) 는 순수 함수라 node 테스트가 직접 돌린다(DOM 은 최소 인터페이스만 쓴다).
import { createHistory, classifyInput, undoKeyOf, isMoveKey } from "./undo-history.js";
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 한 줄 안의 마크다운 → html. 이미지 · 링크 · 코드 · 굵게 · 취소선 · 기울임. */
export function inlineToHtml(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(att:([a-z0-9]+)\)/g, (m, alt, id) => `<img data-att="${id}" alt="${alt}">`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => `<img alt="${alt}" src="${src}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, href) => `<a href="${href}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/~~([^~]+)~~/g, "<s>$1</s>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
}

/** 마크다운 → 편집기 html. 지원: 제목 1~3 · 목록(점/번호/체크) · 인용 · 코드 블록 · 구분선 · 줄. */
export function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const take = (re) => { const items = []; while (i < lines.length && re.test(lines[i])) { items.push(lines[i]); i++; } return items; };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre>${esc(buf.join("\n"))}</pre>`);
    } else if (/^#{1,3}\s+/.test(ln)) {
      const m = /^(#{1,3})\s+(.*)$/.exec(ln); out.push(`<h${m[1].length}>${inlineToHtml(m[2])}</h${m[1].length}>`); i++;
    } else if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(ln)) {
      out.push(`<ul class="re-todo">${take(/^\s*[-*]\s+\[[ xX]\]\s+/).map((x) => { const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(x); return `<li><input type="checkbox"${m[1] === " " ? "" : " checked"}>${inlineToHtml(m[2])}</li>`; }).join("")}</ul>`);
    } else if (/^\s*[-*]\s+/.test(ln)) {
      out.push(`<ul>${take(/^\s*[-*]\s+(?!\[[ xX]\]\s)/).map((x) => `<li>${inlineToHtml(x.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`);
    } else if (/^\s*\d+[.)]\s+/.test(ln)) {
      out.push(`<ol>${take(/^\s*\d+[.)]\s+/).map((x) => `<li>${inlineToHtml(x.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`);
    } else if (/^>\s?/.test(ln)) {
      out.push(`<blockquote>${take(/^>\s?/).map((x) => `<div>${inlineToHtml(x.replace(/^>\s?/, "")) || "<br>"}</div>`).join("")}</blockquote>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(ln)) { out.push("<hr>"); i++; }
    else { out.push(`<div>${inlineToHtml(ln) || "<br>"}</div>`); i++; }
  }
  return out.join("");
}

const kids = (n) => Array.from(n.childNodes || []);
const tagOf = (n) => (n.nodeType === 1 ? String(n.tagName || "").toUpperCase() : "");
function inlineMd(n) {
  if (n.nodeType === 3) return String(n.nodeValue || "").replace(/ /g, " ");
  const tag = tagOf(n);
  if (!tag) return "";
  if (tag === "BR") return "\n";
  if (tag === "IMG") { const id = n.getAttribute("data-att"); return `![${(n.getAttribute("alt") || "").replace(/[\[\]]/g, "")}](${id ? "att:" + id : n.getAttribute("src") || ""})`; }
  if (tag === "INPUT") return "";
  const inner = kids(n).map(inlineMd).join("");
  if (!inner.trim() && tag !== "A") return inner;
  const wrap = (m) => { const lead = /^\s*/.exec(inner)[0]; const trail = /\s*$/.exec(inner)[0]; return lead + m + inner.trim() + m + trail; };
  if (tag === "B" || tag === "STRONG") return wrap("**");
  if (tag === "I" || tag === "EM") return wrap("*");
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") return wrap("~~");
  if (tag === "CODE") return "`" + inner + "`";
  if (tag === "A") return `[${inner}](${n.getAttribute("href") || ""})`;
  return inner;
}
const BLOCKS = new Set(["DIV", "P", "H1", "H2", "H3", "UL", "OL", "BLOCKQUOTE", "PRE", "HR"]);
/** 편집기 DOM → 마크다운. 블록(제목·목록·인용·코드) 앞뒤는 빈 줄 하나, 보통 줄은 줄바꿈 그대로. */
export function domToMd(root) {
  const parts = [];   // { text, block }
  const push = (text, block) => parts.push({ text, block: !!block });
  let run = "";
  const flush = () => { if (run !== "") { for (const l of run.split("\n")) push(l, false); run = ""; } };
  for (const n of kids(root)) {
    const tag = tagOf(n);
    if (!BLOCKS.has(tag)) { run += inlineMd(n); continue; }
    flush();
    if (tag === "HR") push("---", true);
    else if (tag === "PRE") push("```\n" + String(n.textContent || "").replace(/\n$/, "") + "\n```", true);
    else if (/^H[1-3]$/.test(tag)) push("#".repeat(Number(tag[1])) + " " + inlineMd(n).replace(/\n/g, " ").trim(), true);
    else if (tag === "UL" || tag === "OL") {
      const items = kids(n).filter((li) => tagOf(li) === "LI");
      push(items.map((li, idx) => {
        const box = kids(li).find((c) => tagOf(c) === "INPUT");
        const head = tag === "OL" ? `${idx + 1}. ` : box ? `- [${box.checked ? "x" : " "}] ` : "- ";
        return head + kids(li).map((c) => (BLOCKS.has(tagOf(c)) ? domToMd(c) : inlineMd(c))).join("").replace(/\n+/g, " ").trim();
      }).join("\n"), true);
    } else if (tag === "BLOCKQUOTE") push(domToMd(n).split("\n").map((l) => "> " + l).join("\n"), true);
    else {
      // DIV / P — 안에 블록이 들어 있으면(붙여넣기 잔재) 풀어서, 아니면 한 줄.
      if (kids(n).some((c) => BLOCKS.has(tagOf(c)))) push(domToMd(n), true);
      else { const t = inlineMd(n); push(t === "\n" ? "" : t.replace(/\n$/, ""), false); }
    }
  }
  flush();
  let out = "";
  parts.forEach((p, i) => {
    if (i > 0) out += (p.block || parts[i - 1].block) && !(out.endsWith("\n\n")) ? (out.endsWith("\n") ? "\n" : "\n\n") : "\n";
    out += p.text;
  });
  return out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

const SVG = (inner) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const TOOLS = [
  ["h1", "제목 1", `<b class="re-tx">H1</b>`], ["h2", "제목 2", `<b class="re-tx">H2</b>`], ["h3", "제목 3", `<b class="re-tx">H3</b>`], null,
  ["bold", "굵게", SVG('<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>')],
  ["italic", "기울임", SVG('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>')],
  ["strike", "취소선", SVG('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>')],
  ["code", "코드", SVG('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>')], null,
  ["ul", "글머리 목록", SVG('<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>')],
  ["ol", "번호 목록", SVG('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>')],
  ["todo", "체크 목록", SVG('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="12" x2="21" y2="12"/><line x1="13" y1="18" x2="21" y2="18"/>')], null,
  ["quote", "인용", SVG('<path d="M3 21c3 0 7-1 7-8V5H3v7h4"/><path d="M14 21c3 0 7-1 7-8V5h-7v7h4"/>')],
  ["pre", "코드 블록", SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-2 2 2 2"/><path d="m15 10 2 2-2 2"/>')],
  ["hr", "구분선", SVG('<line x1="4" y1="12" x2="20" y2="12"/>')],
  ["link", "링크", SVG('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>')],
  ["image", "이미지·파일 첨부", SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>')],
];

/**
 * 편집기를 만든다. o = { value, placeholder, t(문구), resolveImage(attId) → Promise<url>, onPaste() → Promise<bool>(첨부로 처리했으면 true), onAttach() }
 *  → { el, getMarkdown(), insertImage({id, name}, url), removeImage(id), imageIds(), focus() }
 */
export function createRichEditor(o) {
  const t = o.t || ((s) => s);
  const el = document.createElement("div");
  el.className = "re";
  el.innerHTML = `<div class="re-bar">${TOOLS.map((x) => (x ? `<button type="button" class="re-b" data-cmd="${x[0]}" title="${esc(t(x[1]))}">${x[2]}</button>` : `<span class="re-sep"></span>`)).join("")}</div>` +
    `<div class="re-link" hidden><input class="tk-input re-link-in" placeholder="https://"><button type="button" class="tv-btn re-link-ok">${esc(t("링크 넣기"))}</button></div>` +
    `<div class="re-doc" contenteditable="true" spellcheck="false"></div>`;
  const doc = el.querySelector(".re-doc");
  const linkRow = el.querySelector(".re-link");
  //  빈 글도 첫 줄을 갖고 시작한다 — 줄이 없으면 커서 자리·첫 입력의 블록 모양이 웹뷰 마음대로가 된다.
  doc.innerHTML = mdToHtml(o.value || "") || "<div><br></div>";
  const loadImgs = () => doc.querySelectorAll("img[data-att]").forEach((img) => {
    if (img.dataset.loaded || !o.resolveImage) return;
    img.dataset.loaded = "1";
    void o.resolveImage(img.getAttribute("data-att")).then((u) => { if (u) img.src = u; }).catch(() => {});
  });
  loadImgs();
  //  빈 글 안내문은 두지 않는다(2026-10-07 사용자 확정 — 빈 화면도 글이 있을 때와 같은 배치로 둔다).
  //  ⚠ 편집기 뿌리에 `empty` 같은 흔한 이름을 붙이지 말 것 — 공용 빈 상태 규칙(.empty: 가운데 정렬·큰 여백)이 걸려 배치가 무너졌다.
  const syncEmpty = () => {};
  // ── 실행 취소 ── 웹뷰 기본은 쉬지 않고 친 글 전체를 한 번에 되돌린다 → 기록을 직접 쥔다(undo-history.js).
  //  상태 = 본문 HTML + 커서 자리(뿌리에서 내려가는 자식 번호 길). 같은 HTML 을 되살리므로 길이 그대로 맞는다.
  const pathOf = (node) => { const p = []; let n = node; while (n && n !== doc) { const par = n.parentNode; if (!par) return null; p.unshift(Array.prototype.indexOf.call(par.childNodes, n)); n = par; } return n === doc ? p : null; };
  const nodeAt = (p) => { let n = doc; for (const i of p) { n = n.childNodes[i]; if (!n) return null; } return n; };
  const snap = () => {
    doc.querySelectorAll('input[type="checkbox"]').forEach((c) => c.toggleAttribute("checked", c.checked));   // 체크 여부는 속성이 아니라 HTML 에 안 실린다
    const sel = window.getSelection();
    let caret = null;
    if (sel && sel.rangeCount && doc.contains(sel.anchorNode) && doc.contains(sel.focusNode)) {
      const a = pathOf(sel.anchorNode); const f = pathOf(sel.focusNode);
      if (a && f) caret = { a, ao: sel.anchorOffset, f, fo: sel.focusOffset };
    }
    return { html: doc.innerHTML, caret };
  };
  const restore = (st) => {
    doc.innerHTML = st.html;
    doc.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const a = st.caret && nodeAt(st.caret.a); const f = st.caret && nodeAt(st.caret.f);
    const len = (n) => (n.nodeType === 3 ? n.nodeValue.length : n.childNodes.length);
    try {
      if (a && f) sel.setBaseAndExtent(a, Math.min(st.caret.ao, len(a)), f, Math.min(st.caret.fo, len(f)));
      else { const r = document.createRange(); r.selectNodeContents(doc); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    } catch (_) { /* 자리를 못 찾으면 커서는 웹뷰가 둔 곳 */ }
  };
  const history = createHistory(snap());
  let composing = false;
  doc.addEventListener("compositionstart", () => { composing = true; });
  doc.addEventListener("compositionend", () => { composing = false; });
  doc.addEventListener("input", (e) => { history.record(snap(), classifyInput(e)); });
  doc.addEventListener("mousedown", () => history.seal());
  const stepHistory = (dir) => { if (composing) return; const st = dir === "redo" ? history.redo() : history.undo(); if (st) restore(st); };
  const exec = (cmd, val) => { doc.focus(); history.seal(); try { document.execCommand(cmd, false, val); } catch (_) { /* 이 웹뷰가 모르는 명령 */ } syncEmpty(); };
  const blockOf = () => { let n = window.getSelection()?.anchorNode || null; while (n && n !== doc) { if (n.nodeType === 1 && /^(H[1-3]|BLOCKQUOTE|PRE|LI)$/.test(n.tagName)) return n; n = n.parentNode; } return null; };
  let savedRange = null;
  function run(cmd) {
    if (cmd === "bold") return exec("bold");
    if (cmd === "italic") return exec("italic");
    if (cmd === "strike") return exec("strikeThrough");
    if (cmd === "ul") return exec("insertUnorderedList");
    if (cmd === "ol") return exec("insertOrderedList");
    if (cmd === "hr") return exec("insertHorizontalRule");
    if (cmd === "h1" || cmd === "h2" || cmd === "h3" || cmd === "quote" || cmd === "pre") {
      const tag = cmd === "quote" ? "BLOCKQUOTE" : cmd.toUpperCase();
      const cur = blockOf();
      return exec("formatBlock", cur && cur.tagName === tag ? "div" : tag);   // 같은 것을 다시 누르면 보통 줄로
    }
    if (cmd === "code") {
      const sel = window.getSelection();
      const text = sel ? String(sel) : "";
      return exec("insertHTML", `<code>${esc(text || t("코드"))}</code>&nbsp;`);
    }
    if (cmd === "todo") return exec("insertHTML", `<ul class="re-todo"><li><input type="checkbox">${esc(String(window.getSelection() || "")) || "&nbsp;"}</li></ul>`);
    if (cmd === "link") {
      const sel = window.getSelection();
      savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const text = sel ? String(sel).trim() : "";
      if (/^https?:\/\/\S+$/.test(text)) return exec("createLink", text);
      linkRow.hidden = false;
      const inp = linkRow.querySelector("input"); inp.value = ""; inp.focus();
      return undefined;
    }
    if (cmd === "image") return o.onAttach && o.onAttach();
    return undefined;
  }
  function applyLink() {
    const url = linkRow.querySelector("input").value.trim();
    linkRow.hidden = true;
    if (!url) return;
    doc.focus();
    const sel = window.getSelection();
    if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
    if (sel && String(sel)) exec("createLink", url); else exec("insertHTML", `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
  }
  el.querySelector(".re-bar").addEventListener("mousedown", (e) => { if (e.target.closest(".re-b")) e.preventDefault(); });   // 선택을 잃지 않게
  el.querySelector(".re-bar").addEventListener("click", (e) => { const b = e.target.closest(".re-b"); if (b) run(b.dataset.cmd); });
  linkRow.querySelector(".re-link-ok").addEventListener("click", applyLink);
  linkRow.querySelector("input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); applyLink(); } else if (e.key === "Escape") { e.stopPropagation(); linkRow.hidden = true; doc.focus(); } });
  doc.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    //  실행 취소/다시 실행 — 앱 메뉴에 Undo/Redo 가 없어(터미널·IDE 가 ⌘Z 를 직접 받게 하려고 뺐다) 웹뷰가 대신 해 주지 않는다.
    const hk = undoKeyOf(e);
    if (hk) { e.preventDefault(); e.stopPropagation(); stepHistory(hk); return; }
    if (isMoveKey(e)) history.seal();
    if (mod && !e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); run("bold"); }
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "i") { e.preventDefault(); run("italic"); }
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); run("link"); }
    else if (e.key === "Tab") { e.preventDefault(); exec(e.shiftKey ? "outdent" : "indent"); }
  });
  //  붙여넣기 — 첨부(캡처·복사한 파일)면 받는 쪽이 처리하고, 아니면 **글자만** 넣는다(남의 서식·스타일을 들이지 않는다).
  doc.addEventListener("paste", (e) => {
    const txt = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    e.preventDefault();
    void (async () => {
      let handled = false;
      try { handled = o.onPaste ? !!(await o.onPaste()) : false; } catch (_) { handled = false; }
      if (!handled && txt) exec("insertText", txt);
    })();
  });
  doc.addEventListener("click", (e) => { const a = e.target.closest?.("a"); if (a && (e.metaKey || e.ctrlKey) && o.onOpenLink) { e.preventDefault(); o.onOpenLink(a.getAttribute("href")); } });
  return {
    el,
    getMarkdown: () => domToMd(doc),
    insertImage(att, url) {
      doc.focus();
      exec("insertHTML", `<div><img data-att="${esc(att.id)}" data-loaded="1" alt="${esc(att.name || "")}"${url ? ` src="${esc(url)}"` : ""}></div><div><br></div>`);
      if (!url) { const img = doc.querySelector(`img[data-att="${att.id}"]`); if (img) { delete img.dataset.loaded; loadImgs(); } }
    },
    removeImage(id) { const imgs = doc.querySelectorAll(`img[data-att="${id}"]`); if (!imgs.length) return; imgs.forEach((n) => n.remove()); history.record(snap()); },
    imageIds: () => Array.from(doc.querySelectorAll("img[data-att]")).map((n) => n.getAttribute("data-att")),
    focus: () => doc.focus(),
  };
}
