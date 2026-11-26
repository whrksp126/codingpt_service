// conv-rows.js — 채팅 v2 의 행 DOM 빌더. 모양은 채팅 v1(chat-view.js)과 **같은 클래스**를 써서 같게 유지한다.
//
// v1 의 행 빌더는 ChatView 의 메서드라 가져다 쓸 수 없다(그 파일은 테스트가 소스 문자열을 핀으로 잡는다).
//  표시 규칙(라벨·결과 표식·diff 행·접힘 줄수)은 chat-model.js 의 순수 함수가 정본이고, 여기서는
//  그것을 DOM 으로 옮기기만 한다. 상태(무엇을 그릴지)는 conv-model.buildRows 가 정한다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { renderMarkdown, escapeHtml } from "./chat-md.js";
import {
  CHAT, toolLabel, resultMark, resultClass, resultMeta, patchLines, clampLines, toolRunLabel,
} from "./chat-model.js";
import { splitStreamBlocks, patchStreamTail, turnSummaryText, convErrorText, noticeText, fileMissingText, CONV, fmtDuration } from "./conv-model.js";
import { ttsAvailable } from "./tts.js";
import { basename } from "./path-utils.js";
import * as i18n from './i18n/index.js';

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tiff"]);
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
function extOf(p) {
  const name = basename(String(p || "").split(/[?#]/)[0]) || "";
  return (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
}
export function mimeOf(p) { return MIME[extOf(p)] || "application/octet-stream"; }
export function isImagePath(p) { return IMG_EXT.has(extOf(p)); }

// ── 사용자 말풍선 ──
//  전송 원문은 경로 그대로, 표현은 칩(v1 규칙). 인용 절대경로('/…/x.ext')만 칩으로 바꾼다.
const PATH_RE = /'((?:\/|[A-Za-z]:[\\/])[^'\n]{1,300}?\.[A-Za-z0-9]{1,8})'/g;
export function userTextHtml(text) {
  const t = String(text || "");
  const parts = [];
  let last = 0;
  let m;
  PATH_RE.lastIndex = 0;
  const plain = (s) => escapeHtml(s).replace(/\n/g, "<br>");
  while ((m = PATH_RE.exec(t))) {
    const path = m[1];
    const name = basename(path) || path;
    const ext = name.includes(".") ? name.split(".").pop() : "";
    if (m.index > last) parts.push(plain(t.slice(last, m.index)));
    parts.push(`<span class="chat-chip msg" data-kind="path" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">` +
      (ext ? `<span class="chat-chip-ext">${escapeHtml(ext.toUpperCase().slice(0, 4))}</span>` : "") +
      `<span class="chat-chip-label">${escapeHtml(name)}</span></span>`);
    last = m.index + m[0].length;
  }
  if (last < t.length) parts.push(plain(t.slice(last)));
  return parts.join("");
}

/** 행 아래 동작 줄(복사 등) — 마우스를 올렸을 때만 보인다. */
function actsHtml(extra) {
  return `<div class="conv-acts">` +
    `<button class="conv-act" type="button" data-act="copy" title="${i18n.t('복사')}">${icons.copy({ size: 13 })}</button>` +
    (extra || "") + `</div>`;
}

/** 첨부 칩 하나(말풍선 안). 이미지면 썸네일 자리 — 바이트는 뷰가 채운다(thumb 가 있으면 바로). */
export function attachChipHtml(f, thumb) {
  const ext = f.ext ? String(f.ext).toUpperCase().slice(0, 4) : "";
  const lead = thumb ? `<img class="chat-chip-thumb" src="${escapeHtml(thumb)}" alt="">`
    : f.image ? `<span class="chat-chip-thumb conv-thumb-wait"></span>`
      : (ext ? `<span class="chat-chip-ext">${escapeHtml(ext)}</span>` : "");
  return `<span class="chat-chip msg" data-kind="att" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}"`
    + `${f.image ? ' data-image="1"' : ""} title="${escapeHtml(f.path)}">${lead}`
    + `<span class="chat-chip-label">${escapeHtml(f.name)}</span></span>`;
}

/** 서버가 기록한 내 메시지 또는 낙관 버블. status: sending|queued|sent|failed|blocked
 *  blocked = 터미널 전용 명령이라 에이전트에 전달되지 않았다. 실패 표시도 다시 시도도 없다 — 바로 아래 안내 줄이 말한다.
 *  files = 첨부 칩(본문의 `[첨부] <경로>` 줄을 뗀 것 — §4.5). 각 { path, name, ext, image, thumb? } */
export function buildUserRow({ key, text, status, code, slash, clientId, files }) {
  const wrap = document.createElement("div");
  wrap.className = "conv-user" + (status === "failed" ? " failed" : "") + (status === "queued" ? " queued" : "")
    + (status === "sending" ? " sending" : "");
  wrap.dataset.key = key;
  if (clientId) wrap.dataset.clientId = clientId;
  const bubble = document.createElement("div");
  bubble.className = "chat-msg chat-msg-user" + (slash ? " slash" : "");
  const body = String(text || "");
  bubble.innerHTML = slash ? `<span class="chat-slash">${escapeHtml(body)}</span>` : userTextHtml(body);
  const list = Array.isArray(files) ? files : [];
  if (list.length) {
    const strip = document.createElement("div");
    strip.className = "conv-att-row";
    strip.innerHTML = list.map((f) => attachChipHtml(f, f.thumb || "")).join("");
    if (!body.trim()) bubble.classList.add("att-only");
    bubble.appendChild(strip);
  }
  wrap.appendChild(bubble);
  const foot = document.createElement("div");
  foot.className = "conv-user-foot";
  if (status === "failed") {
    foot.innerHTML =
      `<span class="conv-fail">${escapeHtml(i18n.t('전송 실패'))}${code ? " · " + escapeHtml(convErrorText(code)) : ""}</span>` +
      `<button class="btn small" type="button" data-act="retry">${i18n.t('다시 시도')}</button>` +
      `<button class="btn small ghost" type="button" data-act="discard">${i18n.t('삭제')}</button>`;
  } else if (status === "queued") {
    foot.innerHTML = `<span class="conv-note">${i18n.t('대기 중')}</span>` + actsHtml();
  } else if (status === "sending") {
    foot.innerHTML = `<span class="conv-note">${i18n.t('보내는 중…')}</span>`;
  } else {
    foot.innerHTML = actsHtml();
  }
  wrap.appendChild(foot);
  wrap._copyText = body;
  return wrap;
}

// ── 어시스턴트 본문(스트리밍 포함) ──
//  블록마다 자기 요소(.conv-blk)를 갖는다. 확정된 블록은 한 번 그리면 다시 건드리지 않으므로
//  글자가 오는 동안에도 선택이 풀리지 않는다. 다시 그리는 것은 꼬리 하나뿐이다.
export function buildAssistantRow(key) {
  const row = document.createElement("div");
  row.className = "chat-msg chat-msg-assistant conv-assistant";
  row.dataset.key = key;
  row._stream = { blocks: [], tailEl: null, tailSrc: null, caret: null };
  return row;
}

function renderBlock(src) {
  const d = document.createElement("div");
  d.className = "conv-blk";
  d.innerHTML = renderMarkdown(src);
  return d;
}

/**
 * 본문을 행에 반영한다.
 * @param {HTMLElement} row  buildAssistantRow 가 만든 행
 * @param {string} text      지금까지의 본문
 * @param {{final:boolean, hydrate?:(el:HTMLElement)=>void, truncated?:boolean}} o
 *   final   = 완성본(꼬리 없음 · 미디어 hydrate · 동작 줄)
 *   hydrate = 확정 블록의 미디어 자리를 채우는 함수(꼬리에는 돌리지 않는다 — 주소가 아직 자라는 중이다)
 */
export function paintStream(row, text, o) {
  const st = row._stream;
  const final = !!(o && o.final);
  const sp = splitStreamBlocks(text);
  const blocks = final && sp.tail ? [...sp.blocks, sp.tail] : sp.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const have = st.blocks[i];
    if (have && have.src === blocks[i]) {
      if (final && !have.hydrated) { have.hydrated = true; o.hydrate?.(have.el); }
      continue;
    }
    let el;
    // 방금까지 꼬리였던 것이 그대로 확정됐으면 그 요소를 승격한다(다시 그리면 그 순간 선택이 풀린다).
    if (!have && st.tailEl && st.tailSrc === blocks[i] && !st.tailOpen) {
      el = st.tailEl;
      el.classList.remove("conv-tail");
      st.tailEl = null; st.tailSrc = null;
    } else {
      el = renderBlock(blocks[i]);
      if (have) have.el.replaceWith(el);
      else if (st.tailEl) row.insertBefore(el, st.tailEl);
      else row.insertBefore(el, st.caret || row.querySelector(":scope > .conv-acts, :scope > .chat-trunc"));
    }
    st.blocks[i] = { src: blocks[i], el, hydrated: final };
    if (final) o.hydrate?.(el);
  }
  while (st.blocks.length > blocks.length) st.blocks.pop().el.remove();

  if (final) {
    st.tailEl?.remove(); st.tailEl = null; st.tailSrc = null; st.tailOpen = false;
    st.caret?.remove(); st.caret = null;
    row.classList.remove("conv-live");
    if (o.truncated && !row.querySelector(":scope > .chat-trunc")) {
      const n = document.createElement("div");
      n.className = "chat-trunc";
      n.innerHTML = `${escapeHtml(i18n.t('내용이 길어 일부만 표시됩니다'))} <button class="conv-link" type="button" data-act="full">${i18n.t('전체 보기')}</button>`;
      row.appendChild(n);
    }
    if (!row.querySelector(":scope > .conv-acts")) row.insertAdjacentHTML("beforeend", actsHtml());
    row._copyText = String(text || "");
    return;
  }

  row.classList.add("conv-live");
  const src = patchStreamTail(sp.tail, sp);
  if (!st.tailEl) {
    st.tailEl = document.createElement("div");
    st.tailEl.className = "conv-blk conv-tail";
    row.insertBefore(st.tailEl, st.caret);
    st.tailSrc = null;
  }
  if (src !== st.tailSrc) {
    // 열린 코드 펜스는 본문 글자만 갈아 끼운다 — 긴 코드가 오는 동안 블록 전체를 매 프레임 다시 만들지 않는다.
    const code = sp.open && st.tailOpen === sp.open.mark + sp.open.lang ? st.tailEl.querySelector(".chat-code-pre > code") : null;
    if (code) code.textContent = src.split("\n").slice(1).join("\n");
    else st.tailEl.innerHTML = renderMarkdown(src);
    st.tailSrc = src;
    st.tailOpen = sp.open ? sp.open.mark + sp.open.lang : false;
  }
  if (!st.caret) {
    st.caret = document.createElement("span");
    st.caret.className = "conv-caret";
    row.appendChild(st.caret);
  }
}

/** 진행 중인 '생각'. 본문이 비어 올 수 있다(서명만) — 그때는 표시만. */
export function buildThinkingLive(key) {
  const row = document.createElement("div");
  row.className = "chat-thinking conv-think-live";
  row.dataset.key = key;
  row.innerHTML = `<span class="conv-think-label">${i18n.t('생각 중')}</span><span class="chat-think-body"></span>`;
  return row;
}
export function paintThinkingLive(row, text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const body = row.querySelector(".chat-think-body");
  if (body) body.textContent = t.length > CONV.THINKING_CHARS ? "…" + t.slice(-CONV.THINKING_CHARS) : t;
}

/** 끝난 생각 — "N초 동안 생각함". 본문(대개 비어 온다)이 있으면 눌러 펼친다. */
export function buildThinkingRow(m, dur) {
  const text = String(m.text || "");
  const row = document.createElement("div");
  row.className = "conv-think" + (text.trim() ? " has" : "");
  row.dataset.key = m.key;
  const label = dur && dur >= 1000 ? i18n.t("{t} 동안 생각함", { t: fmtDuration(dur) }) : i18n.t("생각함");
  row.innerHTML = `<div class="conv-line conv-think-head"${text.trim() ? ' role="button" tabindex="0"' : ""}>`
    + `<span class="conv-line-verb">${escapeHtml(label)}</span>${text.trim() ? '<span class="conv-line-caret">›</span>' : ""}</div>`
    + (text.trim() ? `<div class="conv-think-body">${escapeHtml(text)}</div>` : "");
  return row;
}

// ── 도구 행 ──
function patchHtml(patch) {
  const { lines, more } = patchLines(patch, CHAT.PATCH_CLAMP_LINES * 4);
  const rowHtml = (l) => (
    `<div class="chat-diff-row ${l.type}">` +
    `<span class="chat-diff-no">${l.no == null ? "" : l.no}</span>` +
    `<span class="chat-diff-sign">${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>` +
    `<span class="chat-diff-txt">${escapeHtml(l.text)}</span></div>`
  );
  const head = lines.slice(0, CHAT.PATCH_CLAMP_LINES).map(rowHtml).join("");
  const rest = lines.slice(CHAT.PATCH_CLAMP_LINES);
  return `<div class="chat-diff">${head}`
    + (rest.length ? `<div class="chat-diff-rest hidden">${rest.map(rowHtml).join("")}</div>`
      + `<button class="chat-diff-more" type="button">${i18n.t("{n}줄 더 보기", { n: rest.length })}</button>` : "")
    + (more ? `<div class="chat-diff-cut">${i18n.t('…이후 생략')}</div>` : "")
    + `</div>`;
}

function resultBodyHtml(res, wrap) {
  if (res.patch) return patchHtml(res.patch);
  const preview = String(res.preview || "");
  const meta = resultMeta(res);
  if (!preview) return meta ? `<div class="chat-tool-meta">${escapeHtml(meta)}</div>` : "";
  const { head, rest } = clampLines(preview, CHAT.OUTPUT_CLAMP_LINES);
  return (
    `<pre class="chat-out${wrap ? " wrap" : ""}" data-full="${escapeHtml(preview)}">${escapeHtml(head)}</pre>` +
    (rest ? `<button class="chat-out-more" type="button">${i18n.t("{n}줄 더 보기", { n: rest })}</button>` : "") +
    (meta ? `<div class="chat-tool-meta">${escapeHtml(meta)}</div>` : "")
  );
}

// ── 에이전트가 일하는 흐름(Claude 앱 문법 — 앱 ConvActivity.tsx 와 같은 규칙·같은 문구) ──
//  끝난 도구는 박스 없이 본문 흐름 속 한 줄: "실행됨 cd …›" / 이어진 것은 "명령어 2개 실행됨 ›".
//  누르면 도구 시트(목록 → 상세: 명령어·출력 + 복사). 질문(AskUserQuestion)만 예전 박스를 쓴다.
export function toolKind(m) {
  const n = String((m && m.tool && m.tool.name) || "");
  if (n === "Bash" || n === "shell" || n === "BashOutput" || n === "local_shell" || n === "local-command") return "bash";
  if (n === "Read" || n === "NotebookRead") return "read";
  if (n === "Edit" || n === "Write" || n === "MultiEdit" || n === "NotebookEdit" || n === "apply_patch") return "edit";
  if (n === "Grep" || n === "Glob" || n === "Search" || n === "ToolSearch") return "search";
  if (n === "WebFetch" || n === "WebSearch") return "web";
  if (n === "Task" || n === "Agent") return "agent";
  return "other";
}
/** 도구 한 줄의 대상(명령·경로) — 데몬 title("$ cmd" / "읽기 x.ts")에서 동사를 걷어 낸다. */
export function toolTarget(m) {
  const t = String((m && m.tool && (m.tool.title || m.tool.name)) || (m && m.text) || "").trim();
  if (t.startsWith("$ ")) return t.slice(2);
  const path = m && m.tool && m.tool.path;
  if (path) return path;
  return t.replace(/^(읽기|수정|쓰기|검색|편집)\s+/, "");
}
export const VERB_DONE = { bash: "실행됨", read: "읽음", edit: "수정함", search: "검색함", web: "확인함", agent: "맡김", other: "사용함" };
export const VERB_RUN = { bash: "실행 중", read: "읽는 중", edit: "수정 중", search: "검색 중", web: "확인 중", agent: "맡기는 중", other: "사용 중" };
/** 묶음 요약 — 같은 종류면 그 말로("명령어 2개 실행됨"), 섞이면 "도구 5개 사용함". */
export function groupLabel(tools) {
  const kinds = new Set(tools.map((r) => toolKind(r.msg)));
  const n = tools.length;
  if (kinds.size === 1) {
    switch ([...kinds][0]) {
      case "bash": return i18n.t("명령어 {n}개 실행됨", { n });
      case "read": return i18n.t("파일 {n}개 읽음", { n });
      case "edit": return i18n.t("파일 {n}개 수정함", { n });
      case "search": return i18n.t("{n}번 검색함", { n });
      case "web": return i18n.t("웹 {n}번 확인함", { n });
      case "agent": return i18n.t("에이전트 {n}개에 맡김", { n });
      default: break;
    }
  }
  return i18n.t("도구 {n}개 사용함", { n });
}
/** 작업 중 표식 — 네 갈래 별(무채색, CSS 로 돌며 숨 쉰다). */
export function sparkHtml(size) {
  const z = size || 12;
  return `<span class="conv-spark" style="width:${z}px;height:${z}px"><svg viewBox="0 0 24 24" width="${z}" height="${z}">`
    + `<path d="M12 1.5 C12.9 7.6 16.4 11.1 22.5 12 C16.4 12.9 12.9 16.4 12 22.5 C11.1 16.4 7.6 12.9 1.5 12 C7.6 11.1 11.1 7.6 12 1.5 Z" fill="currentColor"/></svg></span>`;
}
const resOf = (r) => (r && r.result && r.result.result) || null;

/** 도구 호출 + (있으면) 결과. 질문이 아니면 한 줄(누르면 도구 시트). */
export function buildToolRow(r, open) {
  if (!r.question) return buildActivityLine(r);
  return buildToolBox(r, open);
}

export function buildActivityLine(r) {
  const m = r.msg;
  const res = resOf(r);
  const kind = toolKind(m);
  const running = !res;
  const failed = !!res && res.ok === false;
  const target = toolTarget(m);
  const verb = i18n.t(running ? VERB_RUN[kind] : VERB_DONE[kind]);
  const row = document.createElement("div");
  row.className = "conv-line" + (failed ? " failed" : "") + (running ? " running" : "") + (r.sub ? " conv-sub" : "");
  row.dataset.key = r.key;
  row.dataset.act = "tools";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.title = `${verb} ${target}`;
  row.innerHTML = (running ? sparkHtml(11) : failed ? `<span class="conv-line-x">✕</span>` : "")
    + `<span class="conv-line-verb">${escapeHtml(verb)}</span>`
    + `<span class="conv-line-target${kind === "bash" ? " mono" : ""}">${escapeHtml(target)}</span>`
    + `<span class="conv-line-caret">›</span>`;
  row._tools = [r];
  return row;
}

function buildToolBox(r, open) {
  const m = r.msg;
  const res = resOf(r);
  const row = document.createElement("div");
  row.className = "chat-tool" + (r.sub ? " conv-sub" : "");
  row.dataset.key = r.key;
  if (!r.question) row.dataset.fold = "1";
  const path = m.tool && m.tool.path ? m.tool.path : "";
  const head = document.createElement("div");
  head.className = "chat-tool-head";
  head.innerHTML =
    `<span class="chat-tool-mark ${resultClass(res)}">${resultMark(res)}</span>` +
    `<span class="chat-tool-label">${escapeHtml(toolLabel(m))}</span>` +
    (path ? `<button class="chat-tool-open" type="button" data-path="${escapeHtml(path)}" title="${i18n.t('IDE 로 열기')}">${i18n.t('열기')}</button>` : "");
  row.appendChild(head);
  if (m.tool && m.tool.argsPreview) {
    const pre = document.createElement("div");
    pre.className = "chat-tool-args";
    pre.textContent = m.tool.argsPreview;
    row.appendChild(pre);
  }
  if (r.question && m.question) {
    const q = document.createElement("div");
    q.className = "chat-q";
    q.innerHTML =
      (m.question.header ? `<div class="chat-q-head">${escapeHtml(m.question.header)}</div>` : "") +
      (m.question.question ? `<div class="chat-q-text">${escapeHtml(m.question.question)}</div>` : "");
    row.appendChild(q);
  }
  const box = document.createElement("div");
  box.className = "chat-tool-result" + (res ? "" : " hidden");
  if (res) {
    box.innerHTML = r.question
      ? `<div class="chat-q-res">${escapeHtml(String(res.preview || "").trim() || i18n.t("응답됨"))}</div>`
      : resultBodyHtml(res, !!(m.tool && m.tool.name === "local-command"));
    if (res.patch) row.dataset.diff = "1";
    if (row.dataset.fold === "1") row.classList.add("done");
  }
  if (open) row.classList.add("open");
  row.appendChild(box);
  return row;
}

// ── 도구 시트(목록 → 상세) — 앱 ToolSheet 와 같은 구성. 패널 안 오버레이, 뷰가 열고 닫는다. ──
function toolInputText(m) {
  if (toolKind(m) === "bash") return toolTarget(m);
  const parts = [m.tool && m.tool.path, m.tool && m.tool.argsPreview].filter(Boolean);
  return parts.length ? parts.join("\n") : toolTarget(m);
}
function sheetSection(title, text, inner) {
  return `<div class="conv-sheet-sec"><div class="conv-sheet-sec-head"><span>${escapeHtml(title)}</span>`
    + (text ? `<button class="conv-act" type="button" data-sheet="copy" data-text="${escapeHtml(text)}" title="${i18n.t("복사")}">${icons.copy({ size: 13 })}</button>` : "")
    + `</div>${inner}</div>`;
}
/** 시트 내용을 그린다. sel=null 이면 목록. */
export function paintToolSheet(el, tools, sel) {
  const single = tools.length === 1;
  const cur = sel != null ? tools[sel] : null;
  const stateText = (r) => !resOf(r) ? i18n.t("실행 중") : resOf(r).ok === false ? i18n.t("실패") : i18n.t("완료");
  let head = `<div class="conv-sheet-head">`
    + (cur && !single ? `<button class="conv-sheet-btn" type="button" data-sheet="back" title="${i18n.t("뒤로")}">‹</button>` : `<span class="conv-sheet-btn"></span>`)
    + `<div class="conv-sheet-title"><div>${escapeHtml(cur ? String((cur.msg.tool && cur.msg.tool.name) || i18n.t("도구")) : groupLabel(tools))}</div>`
    + (cur ? `<div class="conv-sheet-sub">${escapeHtml(stateText(cur))}</div>` : "") + `</div>`
    + `<button class="conv-sheet-btn" type="button" data-sheet="close" title="${i18n.t("닫기")}">✕</button></div>`;
  let body;
  if (cur) {
    const m = cur.msg;
    const res = resOf(cur);
    const input = toolInputText(m);
    const path = m.tool && m.tool.path;
    body = sheetSection(toolKind(m) === "bash" ? i18n.t("명령어") : i18n.t("입력"), input, `<pre class="conv-sheet-code">${escapeHtml(input)}</pre>`);
    if (res && res.patch) body += sheetSection(i18n.t("변경"), "", patchHtml(res.patch));
    const out = String((res && res.preview) || "").replace(/\n+$/, "");
    if (out) body += sheetSection(i18n.t("출력"), out, `<pre class="conv-sheet-code">${escapeHtml(out)}</pre>`);
    else if (!(res && res.patch)) body += `<div class="conv-sheet-note">${escapeHtml(res ? i18n.t("출력 없음") : i18n.t("아직 실행 중이에요"))}</div>`;
    if (res && res.truncated) body += `<div class="conv-sheet-note">${i18n.t("출력이 길어 앞부분만 보여요")}</div>`;
    if (path) body += `<button class="btn small ghost conv-sheet-open" type="button" data-sheet="open" data-path="${escapeHtml(path)}">${i18n.t("IDE 로 열기")}</button>`;
  } else {
    body = `<div class="conv-sheet-list">` + tools.map((r, i) => {
      const k = toolKind(r.msg);
      const failed = !!resOf(r) && resOf(r).ok === false;
      return `<button class="conv-sheet-item${failed ? " failed" : ""}" type="button" data-sheet="pick" data-i="${i}">`
        + `<span class="conv-line-verb">${escapeHtml(i18n.t(resOf(r) ? VERB_DONE[k] : VERB_RUN[k]))}</span>`
        + `<span class="conv-line-target${k === "bash" ? " mono" : ""}">${escapeHtml(toolTarget(r.msg))}</span><span class="conv-line-caret">›</span></button>`;
    }).join("") + `</div>`;
  }
  el.innerHTML = `<div class="conv-sheet-card" role="dialog">${head}<div class="conv-sheet-body">${body}</div></div>`;
}

/** 짝 없는 결과(도구 호출이 받아 둔 내역 밖에 있다). */
export function buildOrphanRow(r) {
  const m = r.msg;
  const res = m.result || {};
  const body = resultBodyHtml(res, !!(m.tool && m.tool.name === "local-command"));
  if (!body) return null;
  const row = document.createElement("div");
  row.className = "chat-tool orphan";
  row.dataset.key = r.key;
  row.innerHTML =
    `<div class="chat-tool-head"><span class="chat-tool-mark ${resultClass(res)}">${resultMark(res)}</span>` +
    `<span class="chat-tool-label">${escapeHtml(m.tool ? toolLabel(m) : i18n.t("도구 결과"))}</span></div>` +
    `<div class="chat-tool-result">${body}</div>`;
  return row;
}

export function buildGroupRow(r) {
  const tools = r.items.filter((x) => x.type === "tool");
  const label = groupLabel(tools) + (r.bad ? i18n.t(" · 실패 {n}", { n: r.bad }) : "");
  const row = document.createElement("div");
  row.className = "conv-line conv-line-group" + (r.bad ? " failed" : "");
  row.dataset.key = r.key;
  row.dataset.act = "tools";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.innerHTML = (r.bad ? `<span class="conv-line-x">✕</span>` : "")
    + `<span class="conv-line-verb">${escapeHtml(label)}</span><span class="conv-line-caret">›</span>`;
  row._tools = tools;
  return row;
}

/** 다른 세션(서브에이전트·동료 에이전트)의 보고 — 내 말풍선이 아니라 접힌 카드. 머리를 누르면 펼친다. */
export function buildReportRow(m) {
  const meta = m.meta || {};
  const who = meta.name || (meta.subagent ? i18n.t('서브에이전트') : i18n.t('다른 에이전트'));
  const title = meta.subagent ? i18n.t('{who}의 작업 보고', { who }) : i18n.t('{who}의 메시지', { who });
  const text = String(m.text || '');
  const preview = text.replace(/[#*`>|]/g, '').replace(/\s+/g, ' ').trim();
  const row = document.createElement("div");
  row.className = "conv-report";
  row.dataset.key = m.key;
  row.innerHTML = `<div class="conv-report-head" role="button" tabindex="0">`
    + `<span class="conv-report-ic">${icons.bot({ size: 14 })}</span>`
    + `<span class="conv-report-title">${escapeHtml(title)}</span><span class="conv-report-caret">›</span></div>`
    + `<div class="conv-report-preview">${escapeHtml(preview.slice(0, 280))}</div>`
    + `<div class="conv-report-body conv-blk">${renderMarkdown(text)}</div>`;
  return row;
}

export function buildDividerRow(m) {
  const row = document.createElement("div");
  const known = m.kind === "compact" || m.kind === "divider" || m.kind === "interrupt";
  row.className = "chat-divider" + (known ? "" : " dim");
  row.dataset.key = m.key;
  const text = m.kind === "interrupt" ? i18n.t("사용자가 중단했습니다") : String(m.text || m.kind || "?");
  row.innerHTML = `<span>${escapeHtml(text)}</span>`;
  return row;
}

/** 턴 끝 줄 — [복사] [읽어 주기] · 걸린 시간(앱 TurnActions 와 같다). 말풍선·색 없음. */
export function buildTurnRow(r) {
  const row = document.createElement("div");
  row.className = "conv-turn";
  row.dataset.key = r.key;
  const text = String(r.text || "");
  const sum = turnSummaryText(r);
  row.innerHTML = (text
    ? `<button class="conv-act" type="button" data-act="copy" title="${i18n.t("복사")}">${icons.copy({ size: 14 })}</button>`
      + (ttsAvailable() ? `<button class="conv-act" type="button" data-act="speak" title="${i18n.t("읽어 주기")}">${icons.speaker({ size: 14 })}</button>` : "")
    : "") + (sum ? `<span class="conv-turn-sum">${escapeHtml(sum)}</span>` : "");
  row._copyText = text;
  return row;
}

/** 안내 — 오류·경고만 색을 쓴다(상태 신호). 본문은 데몬 문구가 아니라 code 로 고른 우리 문구가 우선. */
export function buildNoticeRow(r) {
  const row = document.createElement("div");
  row.className = "conv-notice " + (r.level === "error" ? "error" : r.level === "warn" ? "warn" : "info");
  row.dataset.key = r.key;
  row.textContent = noticeText(r.code, r.text) || convErrorText(r.code);
  //  원격 제어 주소(claude.ai/code 세션) — 눌러서 바로 연다.
  const m = r.code === "REMOTE_CONTROL" ? /https:\/\/claude\.ai\/\S+/.exec(String(r.text || "")) : null;
  if (m) {
    const a = document.createElement("a");
    a.href = m[0]; a.textContent = m[0];
    a.addEventListener("click", (e) => { e.preventDefault(); api.openExternal(m[0]).catch(() => {}); });
    row.textContent = String(r.text).slice(0, m.index);
    row.appendChild(a);
  }
  return row;
}

// ── 미디어(`![라벨](경로)`) ──
//  확정된 블록에만 채운다. URL 이면 그대로 쓰고, 경로면 뷰가 준 bytes(target) 로 받는다
//  (이 PC 면 로컬 읽기, 다른 PC 면 conv.file — §4.5). 로드는 화면에 들어올 때(observer).
export function hydrateMedia(root, { observer }) {
  const nodes = root.querySelectorAll?.(".chat-media");
  if (!nodes || !nodes.length) return;
  for (const el of nodes) {
    if (el.dataset.state) continue;
    el.dataset.state = "idle";
    const cap = document.createElement("span");
    cap.className = "chat-media-cap";
    const alt = el.dataset.alt || "";
    cap.innerHTML = (alt ? `<span class="chat-media-alt">${escapeHtml(alt)}</span>` : "")
      + `<span class="chat-media-path" title="${escapeHtml(el.dataset.target || "")}">${escapeHtml(el.dataset.name || "")}</span>`;
    el.appendChild(cap);
    if (observer) observer.observe(el);
  }
}

/**
 * @param {HTMLElement} el  .chat-media 자리
 * @param {(target:string)=>Promise<{mediaType?:string, base64?:string, missing?:boolean, reason?:string}|null>} bytes
 * @param {(src:string, a:{name:string,path:string})=>void} [onOpen]  이미지 클릭(라이트박스)
 */
export async function loadMedia(el, bytes, onOpen) {
  if (!el || el.dataset.state !== "idle") return;
  el.dataset.state = "loading";
  const target = el.dataset.target || "";
  const fail = (why) => {
    el.dataset.state = "done";
    el.dataset.openable = "1";
    const n = document.createElement("span");
    n.className = "chat-media-fail";
    n.textContent = why;
    el.insertBefore(n, el.firstChild);
  };
  try {
    let src = target;
    if (el.dataset.via !== "url") {
      const r = bytes ? await bytes(target) : null;
      if (!r || r.missing || !r.base64) { fail(fileMissingText(r)); return; }
      src = `data:${r.mediaType || mimeOf(target)};base64,${r.base64}`;
    }
    let node;
    if (el.dataset.kind === "video") {
      node = document.createElement("video");
      node.controls = true;
      node.preload = "metadata";
    } else {
      node = document.createElement("img");
      node.loading = "lazy";
      node.alt = el.dataset.alt || "";
      const a = { name: el.dataset.name || "", path: el.dataset.via === "url" ? "" : target };
      node.addEventListener("click", () => (onOpen ? onOpen(src, a) : showLightbox(src, a)));
    }
    node.className = "chat-media-el";
    node.src = src;
    el.insertBefore(node, el.firstChild);
    el.dataset.state = "done";
  } catch (_) { fail(i18n.t('불러오지 못했어요')); }
}

export function showLightbox(src, a) {
  document.querySelector(".chat-lightbox")?.remove();
  const ov = document.createElement("div");
  ov.className = "chat-lightbox";
  ov.innerHTML =
    `<div class="chat-lb-bar"><span class="chat-lb-name" title="${escapeHtml(a.path || a.name)}">${escapeHtml(a.name)}</span>` +
    // 원본 열기 = 이 PC 의 파일만(다른 PC 의 경로를 이 PC 에서 열 수 없다).
    (a.path && a.canOpen !== false ? `<button class="chat-lb-open" type="button">${i18n.t('원본 열기')}</button>` : "") +
    `<button class="chat-lb-close" type="button" title="${i18n.t('닫기')}">${icons.x({ size: 16 })}</button></div>` +
    `<img class="chat-lb-img" alt="">`;
  ov.querySelector(".chat-lb-img").src = src;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  function close() { ov.remove(); document.removeEventListener("keydown", onKey, true); }
  ov.addEventListener("click", (e) => {
    if (e.target.closest?.(".chat-lb-open")) { api.openPath(a.path).catch(() => {}); return; }
    if (e.target.closest?.(".chat-lb-close") || e.target === ov) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
}
