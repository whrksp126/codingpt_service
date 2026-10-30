// issue-editor — Tasks 본문 편집기의 단일 정본(PC 웹뷰·폰 WebView 가 같은 번들을 쓴다).
//  2026-10-28 사용자 요청("노션 수준, 오픈소스를 제대로 파악해서 가져와 쓰라"): 직접 짠 contenteditable 을 걷고
//  Tiptap(ProseMirror) 을 쓴다. 노션식 편집기들(BlockNote·Novel)이 다 이 위에 서 있다 — React 를 끌고 오는 그것들 대신
//  엔진을 직접 쓰고 노션 문법(/ 메뉴·블록 손잡이·마크다운 단축 입력·선택 메뉴)만 얹는다.
//  **저장 형식은 마크다운** 그대로다(@tiptap/markdown) — 에이전트가 읽고 GitHub 이슈와 오가는 형식. 첨부 그림은 `![이름](att:ID)`.
//  빌드: editor/ 에서 `npm run build` → src/vendor/issue-editor/(PC, ESM) + 앱 리포의 issueEditorBundle.ts(폰, IIFE 문자열).
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { DragHandle } from "@tiptap/extension-drag-handle";
import { BubbleMenu } from "@tiptap/extension-bubble-menu";
import Suggestion from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import CSS from "./editor.css";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// 조합 경로·방향키로 새어 드는 제어문자와 맥 기능키 전용 문자(PUA, U+F700대 방향키 등).
//  macOS WKWebView 는 한글 입력 중 방향키를 insertText 로 흘린다 — 본문에 남으면 빈칸·□ 로 보인다(옛 편집기와 같은 처방).
const GHOST_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F-]/;
const GHOST_RE_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F-]/g;

const SVG = (inner, w = 15) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const IC = {
  bold: SVG('<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>'),
  italic: SVG('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
  strike: SVG('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>'),
  code: SVG('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  ul: SVG('<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  ol: SVG('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  todo: SVG('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="12" x2="21" y2="12"/><line x1="13" y1="18" x2="21" y2="18"/>'),
  quote: SVG('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
  pre: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-2 2 2 2"/><path d="m15 10 2 2-2 2"/>'),
  hr: SVG('<line x1="4" y1="12" x2="20" y2="12"/>'),
  link: SVG('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  image: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  text: SVG('<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
  grip: '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>',
};
const TX = (s) => `<b class="re-tx">${s}</b>`;
// "/" 메뉴 — [명령, 이름, 그림, 찾는 말].
const SLASH = [["text", "텍스트", IC.text, "text p 본문"], ["h1", "제목 1", TX("H1"), "h1 heading"], ["h2", "제목 2", TX("H2"), "h2 heading"], ["h3", "제목 3", TX("H3"), "h3 heading"],
  ["ul", "글머리 목록", IC.ul, "ul bullet list 목록"], ["ol", "번호 목록", IC.ol, "ol number list 목록"], ["todo", "체크 목록", IC.todo, "todo check task 할일"],
  ["quote", "인용", IC.quote, "quote 인용"], ["pre", "코드 블록", IC.pre, "code pre 코드"], ["hr", "구분선", IC.hr, "hr divider line 구분"], ["image", "이미지·파일 첨부", IC.image, "image file 첨부 사진 파일"]];

let cssOn = false;
function ensureCss() {
  if (cssOn || typeof document === "undefined") return;
  cssOn = true;
  const st = document.createElement("style");
  st.id = "cpt-issue-editor-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/** 첨부 그림 — 문서에는 `att:ID` 로 남고, 화면에는 받아 온 그림(또는 이름표)을 그린다. */
function attImage(o, urls) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const wrap = document.createElement("span");
        wrap.className = "re-imgw";
        wrap.contentEditable = "false";
        const paint = (n) => {
          const src = String(n.attrs.src || "");
          const id = src.startsWith("att:") ? src.slice(4) : "";
          wrap.dataset.att = id;
          const show = (url) => {
            if (url) { wrap.innerHTML = `<img src="${esc(url)}" alt="${esc(n.attrs.alt || "")}" data-att="${esc(id)}" draggable="false">`; return; }
            //  그림을 못 받는 곳(폰 — 파일은 PC 에 있다) · 아직 받는 중 → 이름표.
            wrap.innerHTML = `<span class="re-imgchip">${IC.image}<span>${esc(n.attrs.alt || "image")}</span></span>`;
          };
          if (!id) { show(src); return; }
          const known = urls.get(id);
          show(known || "");
          if (known === undefined && o.resolveImage) {
            urls.set(id, "");
            Promise.resolve(o.resolveImage(id)).then((u) => { if (u) { urls.set(id, u); if (wrap.dataset.att === id) show(u); } }).catch(() => {});
          }
        };
        paint(node);
        return {
          dom: wrap,
          update(n) { if (n.type.name !== "image") return false; paint(n); return true; },
        };
      };
    },
  }).configure({ inline: true, allowBase64: false });
}

/** 유령 문자 거르기 + 붙여넣기 + 링크 열기. */
function guards(o) {
  return Extension.create({
    name: "cptGuards",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin({
        key: new PluginKey("cptGuards"),
        props: {
          handleTextInput: (view, from, to, text) => GHOST_RE.test(text),
          handleDOMEvents: {
            beforeinput: (view, e) => { if (e.inputType === "insertText" && e.data && GHOST_RE.test(e.data)) { e.preventDefault(); return true; } return false; },
          },
          handlePaste: (view, e) => {
            const cd = e.clipboardData;
            const txt = cd ? cd.getData("text/plain") : "";
            const html = cd ? cd.getData("text/html") : "";
            const hasFiles = !!(cd && cd.files && cd.files.length);
            //  PC — 첨부(캡처·복사한 파일)는 받는 쪽(네이티브 클립보드)이 먼저 본다. 아니면 **마크다운 글**로 넣는다(남의 서식을 들이지 않는다).
            if (o.onPaste) {
              e.preventDefault();
              void (async () => {
                let handled = false;
                try { handled = !!(await o.onPaste()); } catch (_) { handled = false; }
                if (!handled && txt) pasteText(editor, txt);
              })();
              return true;
            }
            if (hasFiles && !txt) return true;
            if (txt && !html) { pasteText(editor, txt); return true; }
            return false;
          },
          handleClick: (view, pos, e) => {
            const a = e.target && e.target.closest ? e.target.closest("a") : null;
            if (a && (e.metaKey || e.ctrlKey) && o.onOpenLink) { e.preventDefault(); o.onOpenLink(a.getAttribute("href")); return true; }
            return false;
          },
        },
        //  그래도 본문에 들어온 유령 문자(조합 경로로 DOM 에 먼저 박힌 것)는 걷는다.
        appendTransaction: (trs, oldState, state) => {
          if (!trs.some((tr) => tr.docChanged)) return null;
          const hits = [];
          state.doc.descendants((n, pos) => {
            if (!n.isText || !GHOST_RE.test(n.text)) return;
            const re = new RegExp(GHOST_RE_G.source, "g"); let m;
            while ((m = re.exec(n.text))) hits.push(pos + m.index);
          });
          if (!hits.length) return null;
          const tr = state.tr;
          for (let i = hits.length - 1; i >= 0; i--) tr.delete(hits[i], hits[i] + 1);
          return tr.setMeta("addToHistory", false);
        },
      })];
    },
  });
}

function pasteText(editor, txt) {
  const s = String(txt).replace(GHOST_RE_G, "");
  //  한 줄 글은 그대로(마크다운으로 읽으면 `1. ` 같은 말이 목록이 된다), 여러 줄이면 마크다운으로 읽어 블록을 살린다.
  if (!/\n/.test(s)) { editor.chain().focus().insertContent({ type: "text", text: s }).run(); return; }
  editor.chain().focus().insertContent(s, { contentType: "markdown" }).run();
}

/** "/" 블록 메뉴(노션식). 줄 맨 앞이나 빈칸 뒤에서 / 를 치면 뜬다. ↑↓ Enter · Esc · 이어 치면 거른다. */
function slashMenu(o, run, host) {
  const t = o.t;
  return Extension.create({
    name: "cptSlash",
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("cptSlash"),
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => {
          const k = String(query || "").trim().toLowerCase();
          return SLASH.filter(([id, label, , kw]) => !k || id.startsWith(k) || t(label).toLowerCase().includes(k) || label.includes(k) || kw.includes(k)).slice(0, 12);
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          run(props[0]);
        },
        render: () => {
          let menu = null; let st = null; let idx = 0;
          const paint = () => {
            if (!menu || !st) return;
            if (!st.items.length) { menu.hidden = true; return; }
            idx = Math.min(idx, st.items.length - 1);
            menu.innerHTML = st.items.map(([id, label, ic], i) => `<button type="button" class="re-slash-i${i === idx ? " on" : ""}" data-i="${i}"><span class="re-slash-ic">${ic}</span>${esc(t(label))}</button>`).join("");
            const r = st.clientRect && st.clientRect();
            if (!r) return;
            menu.hidden = false;
            //  편집기 영역 안에서만 자리를 잡는다 — 바깥(모달 아래·키보드 뒤)으로 나가면 잘리고 영역이 밀린다.
            const hr = host.getBoundingClientRect();
            const vv = window.visualViewport;
            const areaTop = Math.max(hr.top, vv ? vv.offsetTop : 0);
            const areaBot = Math.min(hr.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
            const roomBelow = areaBot - r.bottom - 8;
            const roomAbove = r.top - areaTop - 8;
            menu.style.maxHeight = "";
            const full = menu.offsetHeight;
            const below = full <= roomBelow || roomBelow >= roomAbove;
            const h = Math.max(72, Math.min(full, below ? roomBelow : roomAbove));
            menu.style.maxHeight = `${h}px`;
            menu.style.top = `${(below ? r.bottom + 4 : r.top - h - 4) - hr.top}px`;
            menu.style.left = `${Math.max(4, Math.min(r.left - hr.left, hr.width - menu.offsetWidth - 4))}px`;
            //  ★ scrollIntoView 금지 — 바깥 스크롤 칸까지 같이 밀어 편집기 영역이 위로 올라갔다(2026-10-30 신고). 메뉴 안만 움직인다.
            const on = menu.querySelector(".on");
            if (on) {
              if (on.offsetTop < menu.scrollTop) menu.scrollTop = on.offsetTop;
              else if (on.offsetTop + on.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = on.offsetTop + on.offsetHeight - menu.clientHeight;
            }
          };
          return {
            onStart: (props) => {
              st = props; idx = 0;
              menu = document.createElement("div");
              menu.className = "re-slash";
              menu.addEventListener("mousedown", (e) => e.preventDefault());
              menu.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("[data-i]"); if (b && st) st.command(st.items[Number(b.dataset.i)]); });
              host.appendChild(menu);
              paint();
            },
            onUpdate: (props) => { st = props; paint(); },
            onKeyDown: ({ event: e }) => {
              if (!st || !st.items.length || e.isComposing) return false;
              const n = st.items.length;
              if (e.key === "ArrowDown") { idx = (idx + 1) % n; paint(); return true; }
              if (e.key === "ArrowUp") { idx = (idx + n - 1) % n; paint(); return true; }
              if (e.key === "Enter" || e.key === "Tab") { st.command(st.items[idx]); return true; }
              if (e.key === "Escape") { menu.hidden = true; return true; }
              return false;
            },
            onExit: () => { if (menu) menu.remove(); menu = null; st = null; },
          };
        },
      })];
    },
  });
}

/**
 * 편집기를 만든다.
 *  o = { value, t(문구), mobile(폰: 손잡이 없음), resolveImage(attId) → Promise<url>, onPaste() → Promise<bool>,
 *        onAttach(), onOpenLink(href), onChange(md), onState(state), onFocus(), onBlur() }
 *  → { el, getMarkdown(), setMarkdown(md), insertImage({id,name}, url), removeImage(id), imageIds(), focus(), blur(), exec(cmd, arg), state(), destroy() }
 *  el 에는 글이 바뀔 때 `input` 이벤트가 난다(옛 rich-editor 와 같은 약속).
 */
export function createIssueEditor(o = {}) {
  ensureCss();
  const t = o.t || ((s) => s);
  const mobile = !!o.mobile;
  const urls = new Map();   // attId → 그림 url("" = 받는 중·못 받음)
  const el = document.createElement("div");
  el.className = "re" + (mobile ? " re-mobile" : "");
  //  2026-10-30 사용자 결정: 노션처럼 / 메뉴·선택 메뉴로 쓰므로 위쪽 도구 줄은 없다(PC·폰).
  el.innerHTML = `<div class="re-scroll"><div class="re-host"></div></div>` +
    `<div class="re-link" hidden><input class="re-link-in" placeholder="https://" autocapitalize="off" autocorrect="off" spellcheck="false"><button type="button" class="re-link-ok">${esc(t("링크 넣기"))}</button></div>`;
  const hostEl = el.querySelector(".re-host");
  const linkRow = el.querySelector(".re-link");
  const linkIn = el.querySelector(".re-link-in");

  // ── 선택 메뉴(노션식) — 글을 고르면 굵게·기울임·취소선·코드·링크. 폰은 OS 선택 메뉴를 가리지 않게 글 아래에 뜬다.
  const bubble = document.createElement("div");
  bubble.className = "re-bubble";
  bubble.innerHTML = [["bold", "굵게", IC.bold], ["italic", "기울임", IC.italic], ["strike", "취소선", IC.strike], ["code", "코드", IC.code], ["link", "링크", IC.link]]
    .map((x) => `<button type="button" class="re-b" data-cmd="${x[0]}" title="${esc(t(x[1]))}">${x[2]}</button>`).join("");
  bubble.addEventListener("mousedown", (e) => e.preventDefault());
  // ── 블록 손잡이(⋮⋮) — 줄·목록 항목·그림을 잡고 끌어 옮긴다. PC 만.
  const grip = document.createElement("div");
  grip.className = "re-grip";
  grip.innerHTML = IC.grip;
  grip.title = t("끌어서 옮기기");

  let editor = null;
  const run = (cmd, arg) => {
    if (!editor) return;
    const c = editor.chain().focus();
    switch (cmd) {
      case "text": c.setParagraph().run(); break;
      case "h1": case "h2": case "h3": c.toggleHeading({ level: Number(cmd[1]) }).run(); break;
      case "bold": c.toggleBold().run(); break;
      case "italic": c.toggleItalic().run(); break;
      case "strike": c.toggleStrike().run(); break;
      case "code": c.toggleCode().run(); break;
      case "ul": c.toggleBulletList().run(); break;
      case "ol": c.toggleOrderedList().run(); break;
      case "todo": c.toggleTaskList().run(); break;
      case "quote": c.toggleBlockquote().run(); break;
      case "pre": c.toggleCodeBlock().run(); break;
      case "hr": c.setHorizontalRule().run(); break;
      case "undo": c.undo().run(); break;
      case "redo": c.redo().run(); break;
      case "indent": if (!c.sinkListItem("taskItem").run()) editor.chain().focus().sinkListItem("listItem").run(); break;
      case "outdent": if (!c.liftListItem("taskItem").run()) editor.chain().focus().liftListItem("listItem").run(); break;
      case "link":
        if (arg != null) { const href = String(arg).trim(); if (href) editor.chain().focus().extendMarkRange("link").setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : "https://" + href }).run(); else editor.chain().focus().extendMarkRange("link").unsetLink().run(); }
        else if (editor.isActive("link")) editor.chain().focus().extendMarkRange("link").unsetLink().run();
        else openLink();
        break;
      case "image": if (o.onAttach) o.onAttach(); break;
      default: break;
    }
  };
  function openLink() {
    linkRow.hidden = false;
    linkIn.value = "";
    linkIn.focus();
  }
  const doneLink = (keep) => {
    const v = linkIn.value.trim();
    linkRow.hidden = true;
    if (keep && v) run("link", v); else editor.commands.focus();
  };
  linkIn.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); doneLink(true); } else if (e.key === "Escape") { e.preventDefault(); doneLink(false); }
  });
  el.querySelector(".re-link-ok").addEventListener("mousedown", (e) => e.preventDefault());
  el.querySelector(".re-link-ok").addEventListener("click", () => doneLink(true));
  linkIn.addEventListener("blur", () => setTimeout(() => { if (!linkRow.hidden && document.activeElement !== linkIn) linkRow.hidden = true; }, 150));

  const state = () => {
    if (!editor) return {};
    const a = (n, at) => editor.isActive(n, at);
    return {
      bold: a("bold"), italic: a("italic"), strike: a("strike"), code: a("code"), link: a("link"),
      h1: a("heading", { level: 1 }), h2: a("heading", { level: 2 }), h3: a("heading", { level: 3 }),
      ul: a("bulletList"), ol: a("orderedList"), todo: a("taskList"), quote: a("blockquote"), pre: a("codeBlock"),
      list: a("listItem") || a("taskItem"),
      canUndo: editor.can().undo(), canRedo: editor.can().redo(), focused: editor.isFocused,
    };
  };
  let stTimer = 0;
  const pushState = () => {
      clearTimeout(stTimer);
    stTimer = setTimeout(() => {
      const s = state();
      if (o.onState) o.onState(s);
      bubble.querySelectorAll("[data-cmd]").forEach((b) => b.classList.toggle("on", !!s[b.dataset.cmd]));
    }, 30);
  };

  const exts = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer", target: null } },
      underline: false,
      dropcursor: { color: "var(--re-drop, currentColor)", width: 2 },
    }),
    TaskList, TaskItem.configure({ nested: true }),
    attImage(o, urls),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    guards(o),
    slashMenu({ t }, (cmd) => run(cmd), el),
  ];
  if (!mobile) {
    exts.push(DragHandle.configure({ render: () => grip, computePositionConfig: { placement: "left-start", strategy: "absolute" } }));
  }
  exts.push(BubbleMenu.configure({
    element: bubble,
    ...(mobile ? { options: { placement: "bottom" } } : {}),
    shouldShow: ({ editor: ed, state: s, from, to }) => from !== to && ed.isEditable && !ed.isActive("codeBlock") && !ed.isActive("image") && !s.selection.node,
  }));
  editor = new Editor({
    element: hostEl,
    extensions: exts,
    content: String(o.value || ""),
    contentType: "markdown",
    editorProps: { attributes: { class: "re-doc", spellcheck: "false", autocapitalize: mobile ? "sentences" : "off" } },
    onUpdate: () => {
      el.dispatchEvent(new Event("input", { bubbles: false }));
      if (o.onChange) o.onChange(editor.getMarkdown().replace(/\s+$/, ""));
      pushState();
    },
    onSelectionUpdate: pushState,
    onFocus: () => { pushState(); if (o.onFocus) o.onFocus(); },
    onBlur: () => { pushState(); if (o.onBlur) o.onBlur(); },
  });
  el.appendChild(bubble);

  el.querySelectorAll(".re-bubble [data-cmd]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => run(b.dataset.cmd));
  });
  //  본문 아래 빈 곳을 눌러도 글 끝으로 들어간다(노션).
  el.querySelector(".re-scroll").addEventListener("mousedown", (e) => {
    if (e.target === hostEl || e.target.classList.contains("re-scroll")) { e.preventDefault(); editor.commands.focus("end"); }
  });

  const imageIds = () => {
    const out = [];
    editor.state.doc.descendants((n) => { if (n.type.name === "image" && String(n.attrs.src || "").startsWith("att:")) out.push(String(n.attrs.src).slice(4)); });
    return out;
  };
  return {
    el,
    editor,
    getMarkdown: () => editor.getMarkdown().replace(/\s+$/, ""),
    /** 본문을 통째로 바꾼다(다른 기기가 고친 글을 따라갈 때 — 커서가 이 칸에 없을 때만 부른다). */
    setMarkdown(md) { editor.commands.setContent(String(md || ""), { contentType: "markdown", emitUpdate: false }); },
    insertImage(att, url) {
      if (url) urls.set(att.id, url);
      editor.chain().focus().insertContent([{ type: "image", attrs: { src: `att:${att.id}`, alt: String(att.name || "").replace(/[[\]]/g, "") } }, { type: "hardBreak" }]).run();
    },
    removeImage(id) {
      const tr = editor.state.tr; const hits = [];
      editor.state.doc.descendants((n, pos) => { if (n.type.name === "image" && n.attrs.src === `att:${id}`) hits.push(pos); });
      if (!hits.length) return;
      for (let i = hits.length - 1; i >= 0; i--) tr.delete(hits[i], hits[i] + 1);
      editor.view.dispatch(tr);
    },
    imageIds,
    focus: (where) => editor.commands.focus(where || null),
    blur: () => editor.commands.blur(),
    exec: run,
    state,
    destroy: () => editor.destroy(),
  };
}

if (typeof window !== "undefined") window.CptIssueEditor = { createIssueEditor };
