// chat-md.js — 채팅 assistant 본문용 **미니 마크다운 → HTML**.
//
// 왜 자체 구현인가: PC 프론트는 번들러가 없고 벤더는 로컬 파일 방식(src/index.html script 태그)이다.
//  marked+sanitizer 를 넣으면 ①벤더 2개 추가 ②sanitize 화이트리스트를 우리가 또 관리 ③모바일은
//  react-native-markdown-display 라서 어차피 렌더러가 2벌 → 이득이 없다. 그래서 "우리가 실제로 쓰는
//  문법만" 지원하는 최소 파서를 둔다(설계서 §3.1 선택 B).
//
// 보안 규율(중요): 입력은 **claude 가 만든 텍스트**다. 그러므로
//  · 모든 텍스트는 먼저 escape 한다 → 원문 HTML 은 절대 실행되지 않는다(태그 통과 없음).
//  · 링크 스킴은 http/https/mailto 만 허용(javascript:·data: 차단). 클릭은 chat-view 가 가로채
//    api.openExternal 로 외부 브라우저에 넘긴다(앱 내 내비게이션 금지).
//
// 지원: 코드펜스(```lang) · 인라인코드 · 볼드 · 이탤릭 · 취소선 · 링크/자동링크 · 헤딩 · 목록(중첩) ·
//       인용 · 수평선 · 단락 · **표(GFM — 2026-07-30 추가**: 파이프 원문이 그대로 보여 TUI 의 ASCII
//       표보다 못생겼다는 사용자 지적. 채팅은 TUI 보다 보기 좋아야 한다**)**.
//       **이미지/파일 참조(2026-08-02 추가)**: `![라벨](경로|URL)` → 실제 미디어, `[라벨](경로)` → 파일 칩.
//       미지원: 각주, HTML 통과.
import { icons } from "./icons.js";
import { mediaRefOf } from "./chat-model.js";

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// 인라인 코드 보호용 센티널(PUA). 본문에 이 문자가 실제로 있으면 복원 슬롯을 위조할 수 있으므로
//  renderInline 이 입력에서 먼저 제거한다(SENT_RE). 위조 자체는 XSS 가 아니지만(복원값은 이미
//  escape 된 우리 배열 내용) 다른 코드 조각으로 바뀌어 보이는 무결성 버그였다 — 스모크 테스트로 잡았다.
const S0 = "\uE000";
const S1 = "\uE001";
const SENT_RE = new RegExp("[" + S0 + S1 + "]", "g");

const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;
function safeUrl(raw) {
  const u = String(raw || "").trim();
  if (SAFE_URL_RE.test(u)) return u;
  // 스킴 없는 도메인은 https 로 승격(자동링크에서 흔함). 그 외(javascript: 등)는 링크로 만들지 않는다.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return "https://" + u;
  return null;
}

// ── 인라인 ──
export function renderInline(src) {
  // 센티널 위조 방지 — 본문에 U+E000/E001 이 실제로 들어 있으면 인라인코드 복원 슬롯이 오작동한다
  //  (실측 재현: ` 0 ` 이 다른 코드 조각으로 치환됐다). 입력에서 먼저 제거한다.
  let t = escapeHtml(String(src == null ? "" : src).replace(SENT_RE, ""));
  // ① 인라인 코드를 먼저 뜯어내 보관 — 코드 안의 **·[]() 가 해석되지 않게.
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => {
    codes.push(c);
    return S0 + (codes.length - 1) + S1;
  });
  // ② 이미지 `![라벨](타깃)` — 마크다운의 "그려라" 문법이다(사용자 확정 2026-08-02: 의도 판별은
  //  문법이 해준다). 여기서는 **자리만** 만든다: 실제 바이트 로드는 chat-view 가 화면에 보일 때
  //  수행한다(대화 전체를 여는 순간 이미지 수십 장을 받지 않도록). 라벨/경로는 캡션으로 남는다.
  t = t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, target) => {
    const ref = mediaRefOf(target);
    if (!ref) return m;
    return `<span class="chat-media" data-target="${escapeHtml(ref.target)}" data-kind="${ref.kind}"`
      + ` data-via="${ref.via}" data-alt="${escapeHtml(alt || "")}" data-name="${escapeHtml(ref.name)}"></span>`;
  });
  // ③ 링크 [텍스트](url) — http/https 는 외부 링크, **파일 경로면 칩**(누르면 열림, 자동 로드 안 함).
  t = t.replace(/\[([^\]\n]+)\]\(((?!https?:|mailto:)[^)\s]+)\)/g, (m, label, target) => {
    const ref = mediaRefOf(target);
    if (!ref || ref.via !== "path") return m;
    const glyph = ref.kind === "video" ? icons.play({ size: 12 }) : ref.kind === "image" ? icons.image({ size: 12 }) : icons.file({ size: 12 });
    return `<span class="chat-file" data-target="${escapeHtml(ref.target)}" data-kind="${ref.kind}"`
      + ` data-name="${escapeHtml(ref.name)}">${glyph}${escapeHtml(label)}</span>`;
  });
  // ④ 링크 [텍스트](url)
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url);
    // 허용 스킴이 아니면(javascript:/data: 등) 링크를 만들지 않고 **원문 그대로** 남긴다.
    //  라벨만 남기면 "( … )" 잔여물이 생겨 사용자가 무엇을 본 건지 알 수 없다.
    if (!u) return m;
    return `<a class="chat-a" href="#" data-href="${escapeHtml(u)}">${label}</a>`;
  });
  // ⑤ 자동링크(맨 URL) — 이미 만든 <a> 안의 href 는 건드리지 않도록 앞에 " 나 = 가 없을 때만.
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"')]+)/g, (m, pre, url) => {
    const u = safeUrl(url);
    if (!u) return m;
    return `${pre}<a class="chat-a" href="#" data-href="${escapeHtml(u)}">${url}</a>`;
  });
  // ⑥ 강조 — 볼드 먼저(** 가 * 에 먹히지 않게), 그다음 이탤릭/취소선.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  // ⑤ 인라인 코드 복원
  t = t.replace(new RegExp(S0 + "(\\d+)" + S1, "g"), (_m, i) => `<code class="chat-ic">${codes[Number(i)] ?? ""}</code>`);
  return t;
}

// ── 코드블록 ──
// 복사 버튼은 이벤트 위임(chat-view 의 .chat-code-copy 핸들러)이 <pre> textContent 를 읽는다 —
//  여기서 리스너를 달지 않아야 innerHTML 재조립에도 새지 않는다.
function codeBlockHtml(lang, code) {
  const label = String(lang || "").trim().slice(0, 20);
  return (
    `<div class="chat-code">` +
    `<div class="chat-code-bar">` +
    `<span class="chat-code-lang">${escapeHtml(label || "text")}</span>` +
    `<button class="chat-code-copy" type="button" title="코드 복사">${icons.copy({ size: 13 })}</button>` +
    `</div>` +
    `<pre class="chat-code-pre"><code>${escapeHtml(code)}</code></pre>` +
    `</div>`
  );
}

const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;
// 수평선 — 같은 기호 3개 이상만(문자클래스 안의 \1 은 역참조가 아니라 8진 이스케이프라 쓰지 않는다).
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
// 표(GFM) — `| a | b |` 행 + 바로 다음 줄이 구분행(`|---|:--:|`)일 때만 표다(파이프가 든 일반
//  문장을 표로 오인하지 않게 구분행을 필수로 요구한다 — GFM 규격과 동일).
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;

function splitTableRow(line) {
  let t = String(line).trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|");
}

export function renderMarkdown(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];        // 진행 중 단락 줄들
  let quote = [];       // 진행 중 인용 줄들
  const listStack = []; // [{ tag:'ul'|'ol', indent:number }]

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p class="chat-p">${para.map(renderInline).join("<br>")}</p>`);
    para = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote class="chat-quote">${quote.map(renderInline).join("<br>")}</blockquote>`);
    quote = [];
  };
  const closeLists = (toIndent) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= toIndent) {
      out.push(`</${listStack.pop().tag}>`);
    }
  };
  const flushAll = () => { flushPara(); flushQuote(); closeLists(0); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 코드펜스 — 닫는 펜스까지 원문 그대로 수집(내부는 어떤 문법도 해석하지 않는다).
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const mark = fence[1];
      const lang = fence[2];
      const body = [];
      i++;
      for (; i < lines.length; i++) {
        const l = lines[i];
        const close = FENCE_RE.exec(l);
        if (close && close[1] === mark && !close[2]) break;
        body.push(l);
      }
      out.push(codeBlockHtml(lang, body.join("\n")));
      continue;
    }

    if (!line.trim()) { flushPara(); flushQuote(); closeLists(0); continue; }

    if (HR_RE.test(line)) { flushAll(); out.push('<hr class="chat-hr">'); continue; }

    // 표(GFM) — 헤더행 + 구분행이 연속일 때. 셀 안 인라인 문법(코드/볼드/링크)은 그대로 렌더된다.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushAll();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const s = c.trim();
        if (/^:-+:$/.test(s)) return "center";
        if (/^-+:$/.test(s)) return "right";
        return "";
      });
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && TABLE_ROW_RE.test(lines[i + 1]) && !TABLE_SEP_RE.test(lines[i + 1])) {
        i += 1;
        rows.push(splitTableRow(lines[i]));
      }
      const cells = (arr, tag) => arr.map((c, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${renderInline(c.trim())}</${tag}>`).join("");
      out.push(
        `<div class="chat-tablewrap"><table class="chat-table">` +
        `<thead><tr>${cells(header, "th")}</tr></thead>` +
        (rows.length ? `<tbody>${rows.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody>` : "") +
        `</table></div>`,
      );
      continue;
    }

    const head = HEAD_RE.exec(line);
    if (head) {
      flushAll();
      const lv = head[1].length <= 2 ? 1 : 2;
      out.push(`<div class="chat-h${lv}">${renderInline(head[2])}</div>`);
      continue;
    }

    const q = QUOTE_RE.exec(line);
    if (q) { flushPara(); closeLists(0); quote.push(q[1]); continue; }
    flushQuote();

    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const indent = (ul ? ul[1] : ol[1]).replace(/\t/g, "  ").length;
      const tag = ul ? "ul" : "ol";
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        listStack.push({ tag, indent });
        out.push(`<${tag} class="chat-list">`);
      } else {
        closeLists(indent + 1);
        const cur = listStack[listStack.length - 1];
        if (!cur) { listStack.push({ tag, indent }); out.push(`<${tag} class="chat-list">`); }
        else if (cur.tag !== tag) { out.push(`</${cur.tag}>`); listStack.pop(); listStack.push({ tag, indent }); out.push(`<${tag} class="chat-list">`); }
      }
      out.push(`<li>${renderInline(ul ? ul[2] : ol[3])}</li>`);
      continue;
    }
    closeLists(0);
    para.push(line);
  }
  flushAll();
  return out.join("");
}
