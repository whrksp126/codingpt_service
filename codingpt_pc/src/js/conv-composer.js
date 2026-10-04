// conv-composer.js — 채팅 v2 탭의 입력칸(컴포저).
//
// 채팅 v1 의 컴포저(chat-view.js ChatView 의 메서드들)와 **같은 동작**을 따로 옮겨 온 것이다.
//  v1 파일은 테스트 7개가 소스 문자열을 핀으로 잡고 있어 메서드를 빼내 공유할 수 없다 → 복제한다.
//  규칙이 갈리지 않게 **판정은 전부 chat-model.js 의 순수 함수**를 쓴다(slashQuery·filterCommands·
//  filterFiles·relToRoot·composerHasText). 여기 있는 것은 DOM 과 WebKit 우회뿐이다.
//
// v1 과 다른 점
//  · 첨부는 입력칸 **아래 칩 줄**이다(v1 의 인라인 원자 칩이 아니다). 본문에 경로를 섞지 않고
//    conv.send 의 attachments 로 따로 보낸다(§4.1) — 데몬이 본문 끝에 `[첨부] <경로>` 로 붙인다.
//    그래서 WebKit 원자 칩 우회(캐럿 점프·칩 삭제 단위)가 필요 없다.
//    칩은 "그 PC 의 경로"가 준비돼야 보낼 수 있다(홈 밖 파일 복사·다른 PC 로 업로드 — 뷰의 stage).
//  · 전송 버튼이 셋 중 하나다: 글자가 있으면 전송, 없고 작업 중이면 중단, 둘 다 아니면 비활성.
//  · Esc 는 채팅을 "나가는" 키가 아니라(나갈 TUI 가 없다) 작업 중단이다.
//  · 초안 저장은 모아서 한다 — 저장은 레이아웃 영속(화면 전체 재렌더)을 부르므로 글자마다 하지 않는다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { escapeHtml } from "./chat-md.js";
import {
  CHAT, slashQuery, filterCommands, commandBadges, filterFiles, flattenFiles, relToRoot, composerHasText,
} from "./chat-model.js";
import { ATTACH_MAX, attachInfo } from "./conv-model.js";
import { IS_WINDOWS, shellQuote, basename } from "./path-utils.js";
import * as i18n from './i18n/index.js';

// 조합 경로·방향키로 새어 드는 제어문자와 맥 기능키 전용 문자(PUA). 본문에 남으면 □ 로 보인다.
const GHOST_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F-]/;
const GHOST_RE_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F-]/g;
const DRAFT_SAVE_MS = 500;
// 음성 입력이 듣는 언어 = 앱 언어(앱의 i18n.speechLocale 과 같은 표).
const SPEECH_LOCALES = { ko: "ko-KR", en: "en-US", ja: "ja-JP", "zh-CN": "zh-CN", es: "es-ES", de: "de-DE", fr: "fr-FR" };
const STT_STOP_WAIT_MS = 3500;   // 멈춘 뒤 마지막 결과를 기다리는 상한(엔진이 답이 없어도 버튼은 풀린다)

/**
 * 컴포저 도구줄 버튼에서 연 메뉴를 **그 버튼 바로 위**에 놓는다(2026-10-05 사용자 확정: Claude 앱처럼 누른 자리 근처).
 *  예전에는 컴포저 상자 전체의 위에 떴다 — 입력이 여러 줄이면 버튼에서 한참 떨어진 곳에 나타났다.
 *  host = 메뉴의 offsetParent(.chat-composer). 아래 끝을 버튼 위에 고정하므로 내용이 늦게 차도 버튼에서 멀어지지 않는다.
 */
export function anchorMenu(menu, anchor, host) {
  if (!menu || !anchor || !host || !anchor.isConnected) return;
  const h = host.getBoundingClientRect(), a = anchor.getBoundingClientRect();
  if (!a.width && !a.height) return;
  menu.style.bottom = Math.round(h.bottom - a.top + 6) + "px";
  menu.style.right = "auto";
  const w = menu.offsetWidth;
  // 버튼의 왼쪽 끝에 맞추고, 그러면 오른쪽으로 넘칠 때는 버튼의 오른쪽 끝에 맞춘다.
  let left = a.left - h.left;
  if (left + w > h.width - 8) left = a.right - h.left - w;
  menu.style.left = Math.round(Math.max(8, Math.min(left, h.width - 8 - w))) + "px";
  // 창 위로 넘치지 않게(스크롤되는 메뉴만 — 나머지는 내용이 짧다).
  if (menu.classList.contains("conv-pick-menu")) menu.style.maxHeight = `min(60vh, 420px, ${Math.max(120, Math.round(a.top - 14))}px)`;
}

export class ConvComposer {
  /**
   * @param {object} o
   *  onSend(text)        전송(글자가 있을 때만 온다)
   *  onStop()            중단
   *  busy()              지금 작업 중인가(전송 버튼 모양의 근거)
   *  placeholder()       빈 입력칸 문구
   *  getDraft()/setDraft(s)
   *  cwd()               워크스페이스 루트(파일 피커 기준)
   *  fs()                파일 목록 제공자(IDE 트리와 같은 것)
   *  commands()          Promise<[{name,desc}]> — 슬래시 팔레트 목록
   *  ctlLeft             컨트롤 행 왼쪽에 끼울 요소(모드 알약)
   *  stage(a)            Promise<{path}> — 첨부를 그 PC 의 경로로 만든다(복사·업로드). 실패는 throw
   *  thumb(a)            Promise<base64|null> — 이미지 칩 썸네일
   *  preview(a)          칩을 눌렀다(라이트박스·열기)
   *  attachError(a, e)   첨부를 못 했다(칩은 이미 뺐다) — 뷰가 이유를 말한다
   */
  constructor(o) {
    this.o = o || {};
    this._composing = false;
    this._btnMode = "";
    this._cmds = null;
    this._disposed = false;
    this._stt = null;         // 듣는 중인 음성 입력 { id, range, span, ready, stopping, unlisten, queue }
    this._atts = [];          // 첨부 칩 [{ id, src, origin, name, ext, image, mediaType, path, b64, state }]
    this._attSeq = 0;
  }

  mount(parent) {
    const el = document.createElement("div");
    el.className = "chat-composer";
    el.innerHTML = `
      <div class="chat-box">
        <div class="chat-input chat-ce" contenteditable="true" role="textbox" aria-multiline="true" data-ph=""></div>
        <div class="conv-att hidden"></div>
        <div class="chat-ctl">
          <button class="chat-plus" type="button" title="${i18n.t('파일 넣기')}">${icons.plus({ size: 18 })}</button>
          <span class="conv-ctl-left"></span>
          <span class="chat-ctl-gap"></span>
          <span class="conv-ctl-right"></span>
          ${IS_WINDOWS ? "" : `<button class="conv-mic" type="button" title="${i18n.t('음성으로 입력')}" aria-label="${i18n.t('음성으로 입력')}">${icons.mic({ size: 17 })}</button>`}
          <button class="chat-send" type="button" disabled></button>
        </div>
      </div>`;
    parent.appendChild(el);
    this.el = el;
    this.inputEl = el.querySelector(".chat-input");
    this.sendEl = el.querySelector(".chat-send");
    this.plusEl = el.querySelector(".chat-plus");
    this.attEl = el.querySelector(".conv-att");
    this.attEl.addEventListener("click", (e) => {
      const chip = e.target.closest?.(".chat-chip");
      if (!chip) return;
      const a = this._atts.find((x) => x.id === chip.dataset.id);
      if (!a) return;
      if (e.target.closest?.(".chat-chip-x")) { this.removeAttachment(a.id); this.focus(); return; }
      this.o.preview?.(a);
    });
    if (this.o.ctlLeft) el.querySelector(".conv-ctl-left").appendChild(this.o.ctlLeft);
    if (this.o.ctlRight) el.querySelector(".conv-ctl-right").appendChild(this.o.ctlRight);

    this.inputEl.textContent = String(this.o.getDraft?.() || "");
    // 첨부 칩 복원 — pane 을 옮기면 이 뷰가 새로 만들어진다. 글 초안은 탭에 저장돼 살아남았지만 칩은 메모리뿐이라
    //  사라졌다(2026-10-03 신고). 올려 둔 것(path 있음)만 탭에 저장했다가 되살린다. 썸네일은 다시 읽는다.
    try {
      for (const s of (this.o.getAtts?.() || [])) {
        if (!s || !s.path) continue;
        const a = { id: "a" + (++this._attSeq), src: s.src || s.path, origin: s.origin || "local", name: s.name || "", ext: s.ext || "",
          image: !!s.image, mediaType: s.mediaType || "", path: s.path, b64: null, state: "ready" };
        this._atts.push(a);
        if (a.image) void this._thumb(a);
      }
      if (this._atts.length) this._renderAtts();
    } catch (_) { /* 복원 실패는 칩만 비는 것 */ }

    this.sendEl.addEventListener("click", () => {
      if (this._btnMode === "stop") this.o.onStop?.();
      else this._send();
    });
    this.plusEl.addEventListener("click", (e) => { e.stopPropagation(); this._togglePlusMenu(); });
    // 마이크 = 음성 입력 토글. 누르면 듣기 시작(버튼이 켜지고 소리 크기만큼 테두리가 움직인다), 다시 누르면 멈춘다.
    //  버튼이 포커스를 가져가지 않게 한다(mousedown) — 글자는 캐럿 자리에 들어가야 한다.
    this.micEl = el.querySelector(".conv-mic");
    if (this.micEl) {
      this.micEl.addEventListener("mousedown", (e) => e.preventDefault());
      this.micEl.addEventListener("click", (e) => { e.stopPropagation(); void this._toggleMic(); });
    }

    // ── IME 조합 ──
    //  한글은 조합 중 Enter 가 "확정"이다. 그 Enter 로 전송하면 마지막 글자가 빠진 채 나가거나
    //  확정된 글자가 다음 메시지로 넘어간다. 판정을 셋 다 본다:
    //   · isComposing  — 표준
    //   · keyCode 229  — WebKit 은 조합을 끝내는 Enter 를 compositionend **뒤에** isComposing=false 로
    //                    보내는데, 그 keydown 의 keyCode 가 229 다
    //   · 우리 플래그  — 위 둘이 모두 빠지는 웹뷰 버전에 대한 안전망
    this.inputEl.addEventListener("compositionstart", () => { this._composing = true; });
    this.inputEl.addEventListener("compositionend", () => { this._composing = false; });

    this.inputEl.addEventListener("keydown", (e) => this._onKeydown(e));
    // macOS 한글 IME + WKWebView 에서 방향키가 기능키 전용 문자를 글자로 흘린다(v1 에서 2회 신고) —
    //  넣기 전에 막고(beforeinput), 그래도 샌 것은 넣은 뒤에 걷는다(input). win32(Chromium)에는 없는 버그.
    if (!IS_WINDOWS) {
      this.inputEl.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertText" && e.data && GHOST_RE.test(e.data)) e.preventDefault();
      });
    }
    this.inputEl.addEventListener("input", () => {
      if (!IS_WINDOWS) this._sanitize();
      // 다 지워도 contenteditable 은 <br> 하나를 남긴다 → `:empty` 가 아니라서 빈 입력칸 문구가 안 돌아온다.
      if (this.inputEl.firstChild && !this.inputEl.textContent && !this.text().trim()
        && !this.inputEl.querySelector("img")) this.inputEl.innerHTML = "";
      this._syncSlash();
      this.sync();
      this._queueDraft();
    });
    this.inputEl.addEventListener("blur", () => this._flushDraft());
    // 붙여넣기 — 파일 참조(Finder ⌘C) > 이미지 데이터(스크린샷) > 글자. 파일 복사는 text/plain 에
    //  파일명이 실려 올 수 있어 경로 확인이 항상 먼저다(경로는 네이티브 pasteboard 에서만 나온다).
    //  서식 HTML 은 받지 않는다 — 직렬화가 오염된다.
    this.inputEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const txt = e.clipboardData?.getData("text/plain") || "";
      void this._pasteRouted(txt);
    });
    this.sync();
    return el;
  }

  _onKeydown(e) {
    const composing = e.isComposing || e.keyCode === 229 || this._composing;
    // ⌘U / Ctrl+U = 파일 또는 사진 추가(Claude 앱과 같은 조합)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "u" || e.key === "U") && !composing) {
      e.preventDefault(); e.stopPropagation();
      void this._addFromDialog();
      return;
    }
    // 슬래시 팔레트가 떠 있으면 ↑↓/Enter/Tab 은 목록 조작이다. Enter 는 **채워넣기**지 전송이 아니다.
    if (this.cmdsEl && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        this._moveCmd(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const row = (this._cmdRows || [])[this._cmdIdx];
        if (row) {
          e.preventDefault(); e.stopPropagation();
          this._pickCmd(row.name);
          return;
        }
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._closeCmds(); return; }
    }
    if (e.key === "Enter") {
      if (composing) return;                 // 조합 확정 — IME 의 것
      if (e.shiftKey || e.altKey) return;    // 줄바꿈(기본 동작)
      e.preventDefault();
      e.stopPropagation();
      this._send();
      return;
    }
    // 빈 입력칸의 ⌫ = 마지막 칩 빼기(메신저 관례). 글자가 있으면 글자를 지운다.
    if (e.key === "Backspace" && !composing && this._atts.length && !this.text()) {
      e.preventDefault();
      this.removeAttachment(this._atts[this._atts.length - 1].id);
      return;
    }
    if (e.key === "Escape" && !composing) {
      if (this._stt) { e.preventDefault(); e.stopPropagation(); this._sttStop(); return; }   // 듣는 중의 Esc = 그만 듣기(작업 중단이 아니다)
      if (this.pickEl) { e.preventDefault(); e.stopPropagation(); this._closePicker(); return; }
      if (this.o.busy?.()) { e.preventDefault(); e.stopPropagation(); this.o.onStop?.(); }
      return;
    }
    // 방향키는 우리가 직접 캐럿을 옮긴다(Selection.modify — ⇧ 선택·⌥ 단어·⌘ 줄 끝 보존).
    //  기본 경로를 아예 타지 않으므로 유령 문자가 생길 자리가 없다. 조합 중에는 IME 의 것.
    if (!IS_WINDOWS && typeof e.key === "string" && e.key.startsWith("Arrow") && !composing && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection();
      if (!sel) return;
      const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? "backward" : "forward";
      const gran = e.key === "ArrowUp" || e.key === "ArrowDown" ? "line"
        : e.metaKey ? "lineboundary" : e.altKey ? "word" : "character";
      try { sel.modify(e.shiftKey ? "extend" : "move", dir, gran); } catch (_) { /* noop */ }
    }
  }

  // ── 직렬화 ──
  //  글자 노드는 그대로, BR·블록 경계는 개행. NBSP 는 공백으로(contenteditable 이 줄 끝 공백을 NBSP 로 바꾼다).
  text() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) { out.push(c.data); continue; }
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        if (c.tagName === "BR") { out.push("\n"); continue; }
        if ((c.tagName === "DIV" || c.tagName === "P") && out.length && !String(out[out.length - 1]).endsWith("\n")) out.push("\n");
        walk(c);
      }
    };
    if (this.inputEl) walk(this.inputEl);
    return out.join("").replace(/ /g, " ");
  }

  clear() {
    if (this.inputEl) this.inputEl.innerHTML = "";
    this._closeCmds();
    this.sync();
  }

  setText(t) {
    if (!this.inputEl) return;
    this.inputEl.textContent = String(t || "");
    this._caretToEnd();
    this.sync();
    this._queueDraft();
  }

  /** 커서 자리에 글자를 넣는다. execCommand 는 WebKit 에서 **실행취소 스택을 지키는 유일한 삽입**이다. */
  insertText(t) {
    if (!this.inputEl || !t) return;
    try { this.inputEl.focus(); document.execCommand("insertText", false, String(t)); } catch (_) { /* noop */ }
    this.sync();
    this._queueDraft();
  }

  /** 파일 경로들을 인용해 넣는다(OS 드롭·붙여넣기 공용). */
  insertPaths(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    this.insertText(list.map((p) => shellQuote(p)).join(" ") + " ");
  }

  focus() {
    try { this.inputEl?.focus(); } catch (_) { /* noop */ }
  }

  hasPopover() { return !!(this.cmdsEl || this.pickEl || this.plusMenuEl); }

  closePopovers() {
    this._closeCmds();
    this._closePicker();
    this._closePlusMenu();
  }

  /** 전송 버튼·문구를 지금 상태에 맞춘다. 작업 상태가 바뀌면 뷰가 부른다. */
  sync() {
    if (!this.sendEl || !this.inputEl) return;
    const staging = this._atts.some((a) => a.state !== "ready");
    const has = !staging && (composerHasText(this.text()) || this._atts.length > 0);
    const busy = !!this.o.busy?.();
    const mode = has ? (busy ? "queue" : "send") : busy ? "stop" : "idle";
    this.sendEl.disabled = mode === "idle";
    // 첨부를 그 PC 로 옮기는 중에는 보낼 수 없다 — 이유를 버튼이 말한다(눌러도 아무 일 없는 버튼은 만들지 않는다).
    if (staging && mode === "idle") this.sendEl.title = i18n.t('첨부를 준비하는 중…');
    // ★ 글리프는 **바뀔 때만** 다시 쓴다. 누르는 도중(mousedown~mouseup)에 자식이 갈리면 WebKit 이
    //  click 을 아예 보내지 않는다(pane.js 모드 토글에서 겪은 사고).
    if (this._btnMode !== mode) {
      this._btnMode = mode;
      const stop = mode === "stop";
      this.sendEl.classList.toggle("stop", stop);
      this.sendEl.innerHTML = stop ? icons.stop({ size: 13 }) : icons.arrowUp({ size: 17 });
      this.sendEl.title = stop ? i18n.t('중단 (Esc)')
        : mode === "queue" ? i18n.t('대기열에 넣기 (Enter)') : i18n.t('보내기 (Enter)');
    }
    const ph = this._stt ? i18n.t('듣는 중…') : String(this.o.placeholder?.() || i18n.t('메시지 보내기'));
    if (this.inputEl.dataset.ph !== ph) this.inputEl.dataset.ph = ph;   // :empty::before 가 그린다
  }

  // ── 음성 입력(마이크) ──
  //  엔진 = 번들 cpt-stt(이 PC 의 음성 인식). 듣는 동안의 글은 **지금까지 들은 전체 문장**이 매번 통째로 온다 →
  //  캐럿 자리에 둔 한 칸(span)을 갈아 끼운다. 끝나면 그 칸을 보통 글자로 푼다(직렬화·초안은 원래도 글자만 본다).
  async _toggleMic() {
    if (this._stt) { this._sttStop(); return; }
    this.closePopovers();
    // 입력칸에 캐럿이 있었으면 그 자리에, 아니면(다른 곳을 보다가 눌렀다) 글 끝에 넣는다.
    const had = document.activeElement === this.inputEl;
    if (!had) this._caretToEnd();
    this.focus();
    const sel = window.getSelection();
    let range = had && sel && sel.rangeCount && this.inputEl.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    if (!range) { range = document.createRange(); range.selectNodeContents(this.inputEl); range.collapse(false); }
    const st = { id: 0, range, span: null, ready: false, stopping: false, unlisten: null, queue: [] };
    this._stt = st;
    this._sttPaint();
    try {
      st.unlisten = await api.onStt((p) => { if (!st.id) st.queue.push(p); else this._onStt(st, p); });
      const id = await api.sttStart(SPEECH_LOCALES[i18n.getLang()] || "en-US");
      if (this._stt !== st) { api.sttCancel().catch(() => {}); return; }   // 그 사이 껐다(전송·닫힘)
      st.id = id;
      for (const p of st.queue.splice(0)) this._onStt(st, p);
    } catch (_) {
      // 음성 엔진이 없는 빌드 — macOS 시스템 받아쓰기(🎤 키와 같은 것)로 떨어진다. 그쪽은 듣는 중 표시를 시스템이 한다.
      this._sttEnd(st);
      this.focus();
      api.startDictation().catch(() => {});
    }
  }

  _onStt(st, p) {
    if (this._stt !== st || !p || p.id !== st.id) return;
    if (p.t === "ready") { st.ready = true; this._sttPaint(); return; }
    if (p.t === "level") { this.micEl?.style.setProperty("--lv", String(Math.max(0, Math.min(1, Number(p.v) || 0)))); return; }
    if (p.t === "text") { this._sttText(st, String(p.text || "")); return; }
    if (p.t === "error") {
      this._sttEnd(st);
      this.o.notice?.(p.code === "mic_denied" ? i18n.t('마이크 권한이 필요합니다.')
        : p.code === "speech_denied" ? i18n.t('음성 인식 권한이 필요합니다.') : i18n.t('음성 인식을 시작할 수 없습니다.'));
      return;
    }
    if (p.t === "end" || p.t === "exit") {
      // 듣기 시작도 못 하고 끝났다(엔진이 죽었다 등) — 버튼이 말없이 꺼지면 "눌러도 아무 일 없는 버튼"이 된다.
      const silent = p.t === "exit" && !st.ready && !st.stopping;
      this._sttEnd(st);
      if (silent) this.o.notice?.(i18n.t('음성 인식을 시작할 수 없습니다.'));
    }
  }

  _sttText(st, text) {
    if (!this.inputEl) return;
    if (!st.span || !st.span.isConnected) {
      if (!text) return;
      const span = document.createElement("span");
      span.className = "conv-stt";
      let r = st.range;
      if (!r || !this.inputEl.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(this.inputEl); r.collapse(false); }
      // 앞 글자에 붙어 한 단어가 되지 않게 — 바로 앞이 공백·줄머리가 아니면 한 칸 띄운다.
      const before = document.createRange();
      before.selectNodeContents(this.inputEl);
      before.setEnd(r.startContainer, r.startOffset);
      st.lead = /[^\s]$/.test(before.toString()) ? " " : "";
      r.collapse(true);
      r.insertNode(span);
      st.span = span;
    }
    st.span.textContent = (st.lead || "") + text;
    this._caretAfter(st.span);
    this.sync();
    this._queueDraft();
  }

  _caretAfter(node) {
    try {
      const r = document.createRange();
      r.setStartAfter(node);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) { /* noop */ }
  }

  /** 그만 듣는다 — 엔진이 남은 소리를 마저 인식해 최종 문장을 보낸 뒤 끝난다. 답이 없으면 지금 글로 끝낸다. */
  _sttStop() {
    const st = this._stt;
    if (!st || st.stopping) return;
    st.stopping = true;
    this._sttPaint();
    api.sttStop().catch(() => {});
    st.timer = setTimeout(() => { if (this._stt === st) { api.sttCancel().catch(() => {}); this._sttEnd(st); } }, STT_STOP_WAIT_MS);
  }

  /** 듣기를 정리한다 — 듣던 칸을 보통 글자로 풀고 버튼을 되돌린다. */
  _sttEnd(st) {
    if (!st) return;
    clearTimeout(st.timer);
    try { st.unlisten?.(); } catch (_) { /* noop */ }
    if (st.span && st.span.isConnected) {
      const tn = document.createTextNode(st.span.textContent || "");
      st.span.replaceWith(tn);
      if (document.activeElement === this.inputEl) this._caretAfter(tn);
    }
    if (this._stt !== st) return;
    this._stt = null;
    this._sttPaint();
    this.sync();
    this._queueDraft();
  }

  _sttPaint() {
    const st = this._stt;
    if (this.micEl) {
      this.micEl.classList.toggle("on", !!st);
      this.micEl.classList.toggle("ready", !!(st && st.ready && !st.stopping));
      this.micEl.classList.toggle("stopping", !!(st && st.stopping));
      if (!st) this.micEl.style.removeProperty("--lv");
      const title = st ? i18n.t('음성 입력 종료') : i18n.t('음성으로 입력');
      this.micEl.title = title;
      this.micEl.setAttribute("aria-label", title);
      this.micEl.setAttribute("aria-pressed", st ? "true" : "false");
    }
    this.el?.classList.toggle("listening", !!st);
    this.sync();
  }

  _send() {
    // 듣는 중에 보내면 지금까지 들은 글로 보낸다(마지막 결과를 기다리지 않는다 — 기다리면 Enter 가 먹통처럼 보인다).
    if (this._stt) { const st = this._stt; api.sttCancel().catch(() => {}); this._sttEnd(st); }
    const raw = this.text();
    if (this._atts.some((a) => a.state !== "ready")) return;
    const atts = this._atts.map((a) => ({ path: a.path, name: a.name, ext: a.ext, image: a.image, ...(a.mediaType ? { mediaType: a.mediaType } : {}), ...(a.b64 ? { thumb: `data:${a.mediaType || "image/png"};base64,${a.b64}` } : {}) }));
    if (!composerHasText(raw) && !atts.length) return;
    this._atts = [];
    this._renderAtts();
    this.clear();
    this._flushDraft();
    this.o.onSend?.(composerHasText(raw) ? raw.replace(/\s+$/, "") : "", atts);
  }

  // ── 첨부 칩(§4.1·§4.5) ──
  /**
   * 파일을 칩으로 더한다. items = [{ path, origin:'local'|'workspace' }]
   *  local = 이 PC 의 파일(OS 드롭·붙여넣기), workspace = `+` 로 고른 그 워크스페이스(그 PC)의 파일.
   */
  addFiles(items) {
    let added = 0;
    for (const it of items || []) {
      const src = it && String(it.path || "");
      if (!src) continue;
      if (this._atts.length >= ATTACH_MAX) { this.o.attachError?.({ name: basename(src) || src }, "LIMIT"); break; }
      if (this._atts.some((a) => a.src === src)) continue;
      const info = attachInfo(src);
      const a = { id: "a" + (++this._attSeq), src, origin: it.origin === "workspace" ? "workspace" : "local",
        name: info.name, ext: info.ext, image: info.image, mediaType: info.mediaType || "", path: "", b64: null, state: "staging" };
      this._atts.push(a);
      added += 1;
      void this._stage(a);
      if (a.image) void this._thumb(a);
    }
    if (added) { this._renderAtts(); this.sync(); }
  }

  removeAttachment(id) {
    const n = this._atts.length;
    this._atts = this._atts.filter((a) => a.id !== id);
    if (this._atts.length !== n) { this._renderAtts(); this.sync(); }
  }

  attachments() { return this._atts.slice(); }

  async _stage(a) {
    try {
      const r = this.o.stage ? await this.o.stage(a) : { path: a.src };
      if (!this._atts.includes(a)) return;
      a.path = (r && r.path) || a.src;
      a.state = "ready";
    } catch (e) {
      if (!this._atts.includes(a)) return;
      this._atts = this._atts.filter((x) => x !== a);
      this.o.attachError?.(a, e);
    }
    if (this._disposed) return;
    this._renderAtts();
    this.sync();
  }

  async _thumb(a) {
    let b64 = null;
    try { b64 = this.o.thumb ? await this.o.thumb(a) : null; } catch (_) { b64 = null; }
    if (!this._atts.includes(a) || this._disposed) return;
    if (b64) a.b64 = b64; else a.image = false;   // 못 읽으면 라벨 칩으로(8MB 초과 등)
    this._renderAtts();
  }

  _renderAtts() {
    if (!this.attEl) return;
    this.attEl.classList.toggle("hidden", !this._atts.length);
    if (!this._restoring) {
      try { this.o.setAtts?.(this._atts.filter((a) => a.state === "ready" && a.path).map((a) => ({ src: a.src, origin: a.origin, name: a.name, ext: a.ext, image: !!a.image, mediaType: a.mediaType, path: a.path }))); } catch (_) { /* noop */ }
    }
    this.attEl.innerHTML = this._atts.map((a) => {
      const ext = a.ext ? escapeHtml(String(a.ext).toUpperCase().slice(0, 4)) : "";
      const lead = a.b64 ? `<img class="chat-chip-thumb" src="data:${escapeHtml(a.mediaType || "image/png")};base64,${a.b64}" alt="">`
        : a.image ? `<span class="chat-chip-thumb conv-thumb-wait"></span>`
          : (ext ? `<span class="chat-chip-ext">${ext}</span>` : "");
      return `<span class="chat-chip${a.state !== "ready" ? " staging" : ""}" data-id="${a.id}" title="${escapeHtml(a.src)}">${lead}`
        + `<span class="chat-chip-label">${escapeHtml(a.name)}</span>`
        + `<button class="chat-chip-x" type="button" title="${i18n.t('빼기')}">${icons.x({ size: 10 })}</button></span>`;
    }).join("");
  }

  // ── 초안 ──
  _queueDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this._flushDraft(), DRAFT_SAVE_MS);
  }

  _flushDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = null;
    if (this._disposed) return;
    const v = this.text().slice(0, CHAT.DRAFT_MAX);
    if (v === this._savedDraft) return;
    this._savedDraft = v;
    this.o.setDraft?.(v);
  }

  async _pasteRouted(txt) {
    let paths = [];
    try { paths = await api.clipboardPaths(); } catch (_) { /* 이 빌드에 없으면 글자로 */ }
    if (Array.isArray(paths) && paths.length) { this.addFiles(paths.map((p) => ({ path: p, origin: "local" }))); return; }
    let img = null;
    try { img = await api.clipboardImagePng(); } catch (_) { /* noop */ }
    if (img) { this.addFiles([{ path: img, origin: "local" }]); return; }
    if (txt) this.insertText(txt);
  }

  _sanitize() {
    const sel = window.getSelection();
    const walker = document.createTreeWalker(this.inputEl, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      if (!GHOST_RE.test(t.data)) continue;
      const inNode = sel && sel.rangeCount && sel.getRangeAt(0).startContainer === t;
      const off = inNode ? sel.getRangeAt(0).startOffset : 0;
      const before = t.data.slice(0, off);
      t.data = t.data.replace(GHOST_RE_G, "");
      if (inNode) {
        try {
          const r = document.createRange();
          r.setStart(t, Math.min(before.replace(GHOST_RE_G, "").length, t.length));
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (_) { /* noop */ }
      }
    }
  }

  _caretToEnd() {
    const sel = window.getSelection();
    if (!sel || !this.inputEl) return;
    const r = document.createRange();
    r.selectNodeContents(this.inputEl);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ── `+` 메뉴 — 파일 또는 사진 추가(2026-10-02: Claude 앱 도구줄과 같은 모양, 항목은 일단 이것 하나) ──
  _togglePlusMenu() {
    if (this.plusMenuEl) { this._closePlusMenu(); return; }
    this._closePicker();
    this._closeCmds();
    const wrap = document.createElement("div");
    wrap.className = "chat-mode-menu conv-plus-menu";
    wrap.innerHTML = `<div class="chat-mode-row" data-a="file"><span class="chat-mode-row-icon">${icons.paperclip ? icons.paperclip({ size: 15 }) : icons.plus({ size: 15 })}</span>`
      + `<span class="chat-mode-row-body"><span class="chat-mode-row-label">${i18n.t('파일 또는 사진 추가')}</span></span>`
      + `<span class="chat-mode-row-kbd">${IS_WINDOWS ? "Ctrl U" : "⌘ U"}</span></div>`;
    wrap.addEventListener("click", (e) => {
      if (!e.target.closest?.("[data-a='file']")) return;
      this._closePlusMenu();
      void this._addFromDialog();
    });
    this.el.appendChild(wrap);
    anchorMenu(wrap, this.plusEl, this.el);
    this.plusMenuEl = wrap;
    this._plusCloser = (e) => { if (!wrap.contains(e.target) && !this.plusEl.contains(e.target)) this._closePlusMenu(); };
    setTimeout(() => { if (this.plusMenuEl === wrap) document.addEventListener("mousedown", this._plusCloser, true); }, 0);
  }

  _closePlusMenu() {
    if (this._plusCloser) document.removeEventListener("mousedown", this._plusCloser, true);
    this._plusCloser = null;
    this.plusMenuEl?.remove();
    this.plusMenuEl = null;
  }

  /** OS 파일 선택창 — 고른 파일은 첨부 칩이 된다(드롭·붙여넣기와 같은 길, origin local). */
  async _addFromDialog() {
    const d = window.__TAURI__ && window.__TAURI__.dialog;
    if (!d || !d.open) return;
    let r = null;
    try { r = await d.open({ multiple: true, directory: false }); } catch (_) { r = null; }
    const paths = Array.isArray(r) ? r : (r ? [r] : []);
    const list = paths.map((x) => (typeof x === "string" ? x : x && x.path)).filter(Boolean);
    if (list.length) this.addFiles(list.map((path) => ({ path, origin: "local" })));
    this.focus();
  }

  // ── `+` 파일 넣기 ──
  //  워크스페이스 파일을 골라 **상대 경로를 입력에 넣는다**(올리는 것이 아니다). 목록 출처는 IDE 트리와
  //  같은 제공자라 다른 PC 의 워크스페이스도 같은 화면으로 고른다.
  _togglePicker() {
    if (this.pickEl) { this._closePicker(); return; }
    this._closeCmds();
    const wrap = document.createElement("div");
    wrap.className = "chat-pick";
    wrap.innerHTML =
      `<input class="chat-pick-q" type="text" placeholder="${i18n.t('파일 이름')}" />` +
      `<div class="chat-pick-list"><div class="chat-pick-empty empty-desc">${i18n.t('불러오는 중…')}</div></div>`;
    this.el.appendChild(wrap);
    this.pickEl = wrap;
    this._pickFiles = null;
    const q = wrap.querySelector(".chat-pick-q");
    q.addEventListener("input", () => this._renderPicker(q.value));
    q.addEventListener("keydown", (e) => {
      e.stopPropagation();                       // 전역 단축키가 이 입력을 가로채지 않게
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") { e.preventDefault(); this._closePicker(); this.focus(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const first = wrap.querySelector(".chat-pick-row");
        if (first) this._pickFile(first.dataset.path);
      }
    });
    wrap.addEventListener("click", (e) => {
      const row = e.target.closest?.(".chat-pick-row");
      if (row) this._pickFile(row.dataset.path);
    });
    this._pickCloser = (e) => { if (!wrap.contains(e.target) && !this.plusEl.contains(e.target)) this._closePicker(); };
    setTimeout(() => { if (this.pickEl === wrap) document.addEventListener("mousedown", this._pickCloser, true); }, 0);
    q.focus();
    void this._loadPickFiles();
  }

  _closePicker() {
    if (this._pickCloser) document.removeEventListener("mousedown", this._pickCloser, true);
    this._pickCloser = null;
    this.pickEl?.remove();
    this.pickEl = null;
  }

  async _loadPickFiles() {
    const fs = this.o.fs?.();
    const root = this.o.cwd?.() || "";
    const wrap = this.pickEl;
    if (!fs) { this._pickFiles = []; this._renderPicker(""); return; }
    try {
      const tree = await fs.fsTree(root, 4);   // 깊이 4 = IDE 트리와 같은 값
      if (this.pickEl !== wrap) return;
      this._pickFiles = flattenFiles(tree);
      this._renderPicker(wrap.querySelector(".chat-pick-q")?.value || "");
    } catch (_) {
      if (this.pickEl !== wrap) return;
      this._pickFiles = [];
      // 실패를 조용히 빈 목록으로 만들지 않는다(원격 오프라인·권한 문제를 알아야 한다).
      wrap.querySelector(".chat-pick-list").innerHTML = `<div class="chat-pick-empty empty-desc">${i18n.t('목록을 불러오지 못했습니다')}</div>`;
    }
  }

  _renderPicker(query) {
    if (!this.pickEl) return;
    const list = this.pickEl.querySelector(".chat-pick-list");
    if (this._pickFiles == null) { list.innerHTML = `<div class="chat-pick-empty empty-desc">${i18n.t('불러오는 중…')}</div>`; return; }
    const root = this.o.cwd?.() || "";
    const hit = filterFiles(this._pickFiles, root, query, CHAT.PICK_LIMIT);
    if (!hit.length) { list.innerHTML = `<div class="chat-pick-empty empty-desc">${i18n.t('일치하는 파일 없음')}</div>`; return; }
    list.innerHTML = hit.map((p) => {
      const r = relToRoot(root, p);
      const i = Math.max(r.lastIndexOf("/"), r.lastIndexOf("\\"));
      return `<div class="chat-pick-row" data-path="${escapeHtml(p)}">` +
        `<span class="chat-pick-name">${escapeHtml(i < 0 ? r : r.slice(i + 1))}</span>` +
        (i < 0 ? "" : `<span class="chat-pick-dir">${escapeHtml(r.slice(0, i))}</span>`) +
        `</div>`;
    }).join("");
  }

  // 고른 파일은 칩이 된다 — 그 워크스페이스(그 PC)의 홈 기준 경로라 옮길 것이 없다(attachPlan 'keep').
  _pickFile(full) {
    if (!full) return;
    this._closePicker();
    this.addFiles([{ path: full, origin: "workspace" }]);
    this.focus();
  }

  // ── 슬래시 명령 팔레트 ──
  //  여는 조건 = 초안 전체가 `/토큰` 한 개(공백을 치면 인자 모드 → 닫힌다). 고르면 채워 넣기만 한다 —
  //  실행은 언제나 사용자가 전송을 눌러야 일어난다.
  _syncSlash() {
    const q = slashQuery(this.text());
    if (q == null) { this._closeCmds(); return; }
    if (!this.cmdsEl) this._openCmds();
    this._renderCmds(q);
    void this._loadCmds();
  }

  _openCmds() {
    this._closePicker();
    const wrap = document.createElement("div");
    wrap.className = "chat-cmds";
    wrap.innerHTML = `<div class="chat-cmds-list"><div class="chat-cmds-empty empty-desc">${i18n.t('불러오는 중…')}</div></div>`;
    this.el.appendChild(wrap);
    this.cmdsEl = wrap;
    this._cmdIdx = 0;
    // mousedown 으로 처리한다 — click 은 입력칸 blur 뒤라 캐럿이 날아간다.
    wrap.addEventListener("mousedown", (e) => {
      const row = e.target.closest?.(".chat-cmds-row");
      if (!row) return;
      e.preventDefault();
      this._pickCmd(row.dataset.name);
    });
  }

  _closeCmds() {
    this.cmdsEl?.remove();
    this.cmdsEl = null;
  }

  /** 대화가 바뀌면 목록도 다를 수 있다(프로젝트 명령) — 뷰가 부른다. */
  resetCommands() { this._cmds = null; }

  async _loadCmds() {
    if (this._cmds || this._cmdsLoading) return;
    this._cmdsLoading = true;
    try {
      const items = await this.o.commands?.();
      this._cmds = (Array.isArray(items) ? items : [])
        .filter((c) => c && c.name)
        .map((c) => ({ ...c, name: String(c.name).startsWith("/") ? String(c.name) : "/" + c.name }));
    } catch (_) {
      this._cmds = [];   // 실패해도 팔레트만 비는 것이고 직접 타이핑은 그대로 나간다
    } finally {
      this._cmdsLoading = false;
      if (this.cmdsEl) this._renderCmds(slashQuery(this.text()) || "");
    }
  }

  _renderCmds(q) {
    if (!this.cmdsEl) return;
    const list = this.cmdsEl.querySelector(".chat-cmds-list");
    if (!this._cmds) { list.innerHTML = `<div class="chat-cmds-empty empty-desc">${i18n.t('불러오는 중…')}</div>`; return; }
    const rows = filterCommands(this._cmds, q, CHAT.CMD_MAX);
    this._cmdRows = rows;
    if (this._cmdIdx >= rows.length) this._cmdIdx = 0;
    if (!rows.length) { list.innerHTML = `<div class="chat-cmds-empty empty-desc">${i18n.t('맞는 명령이 없습니다')}</div>`; return; }
    list.innerHTML = rows.map((c, i) =>
      `<div class="chat-cmds-row${i === this._cmdIdx ? " on" : ""}" data-name="${escapeHtml(c.name)}">` +
      `<span class="chat-cmds-name">${escapeHtml(c.name)}</span>` +
      `<span class="chat-cmds-desc">${escapeHtml(c.desc || "")}</span>` +
      commandBadges(c).map((b) => `<span class="chat-cmds-badge">${escapeHtml(b)}</span>`).join("") +
      `</div>`).join("");
    list.querySelector(".chat-cmds-row.on")?.scrollIntoView({ block: "nearest" });
  }

  _moveCmd(d) {
    const rows = this._cmdRows || [];
    if (!rows.length) return;
    this._cmdIdx = (this._cmdIdx + d + rows.length) % rows.length;
    this._renderCmds(slashQuery(this.text()) || "");
  }

  _pickCmd(name) {
    const n = String(name || "").trim();
    if (!n) return;
    this._closeCmds();
    this.inputEl.textContent = n + " ";   // 이름 + 공백 한 칸 — 인자를 이어 치거나 그대로 전송
    this._caretToEnd();
    this.sync();
    this._queueDraft();
    this.focus();
  }

  dispose() {
    this._flushDraft();
    this._disposed = true;
    clearTimeout(this._draftTimer);
    if (this._stt) { const st = this._stt; api.sttCancel().catch(() => {}); this._sttEnd(st); }   // 마이크를 연 채 사라지지 않는다
    this.closePopovers();   // document 캡처 리스너를 남기면 pane 이 사라진 뒤에도 산다
    this.el?.remove();
  }
}
