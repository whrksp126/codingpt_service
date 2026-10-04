// conv-view.js — 채팅 v2 탭의 본문(탭 종류 `chat`). 계약 정본 = codingpt_daemon/docs/chat-v2-design.md.
//
// 채팅 v1(chat-view.js = 터미널 TUI 의 읽기 뷰)과 **다른 것**이다. 여기에는 터미널이 없다:
//  데몬이 에이전트를 구조화 프로토콜로 직접 구동하고, 우리는 그 이벤트 로그를 그린다.
//  그래서 코드에서는 conv 라고 부른다(터미널 탭의 `mode:'chat'` 과 헷갈리지 않게).
//
// 규율
//  · **push 는 힌트, pull 이 정본**(§3). seq 가 이어지지 않으면 프레임을 버리고 conv.since 를 부른다.
//  · 상태는 conv-model 의 순수 함수가 바꾸고, 이 파일은 그 결과를 그리기만 한다.
//  · 그리기는 프레임당 한 번(rAF). 행은 key 로 재사용하고 바뀐 행만 다시 만든다 —
//    끝난 행을 다시 그리지 않아야 글자가 오는 동안에도 선택이 풀리지 않는다(§10.5).
//  · 요청 카드는 승인 인박스(state.approvals)에 올리지 않는다(§7 "한 사실에 통로 하나").
//    카드 컴포넌트만 빌려 쓰고 응답은 conv.respond 로 보낸다.
//  · 이 모듈은 state.js 를 import 하지 않는다. 화면 밖의 일(탭 제목·터미널 열기)은 ctx 로 받는다.
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { escapeHtml } from "./chat-md.js";
import { CHAT, agentModeOf, agentDisplayName, statusChips, statusDetail } from "./chat-model.js";
import {
  CONV, createConv, applyOpen, applySince, applyBefore, applyPush, applyDelta, applyThreadHint,
  shouldPoll, addPending, markPending, removePending, newClientId, buildRows, openReqs, reqToCard,
  respondParams, isBusy, workingInfo, fmtDuration, parseConvError, convErrorText, isOfflineCode,
  terminalLaunch, fmtAgo, threadDot, needsAdopt, threadTitle, convModeLabel, convModeChoices,
  splitAttachLines, attachPlan, attachUploadName, attachmentsForWire, createByteCache, fileMissingText,
  usageStatus, agentChoices, modelChoices, modelLabel, searchExpand, tabPatchFor, modelSplit, effortLabel,
  opensInBrowserPane, homeRelOf,
} from "./conv-model.js";
import {
  buildUserRow, buildAssistantRow, paintStream, buildThinkingLive, paintThinkingLive, buildThinkingRow,
  buildToolRow, buildOrphanRow, buildGroupRow, buildDividerRow, buildTurnRow, buildNoticeRow,
  hydrateMedia, loadMedia, showLightbox, mimeOf, isImagePath,
} from "./conv-rows.js";
import { ConvComposer } from "./conv-composer.js";
import { basename, isAbs } from "./path-utils.js";
import * as i18n from './i18n/index.js';

// 이 PC 의 홈 절대경로(대화 속 절대경로 → IDE 의 홈-상대 경로 변환용). 한 번만 묻는다.
let _homeAbs = null;
function homeAbs() {
  if (!_homeAbs) _homeAbs = api.fsAbs("").then((h) => String(h || "")).catch(() => { _homeAbs = null; return ""; });
  return _homeAbs;
}

const MODE_KEY = "cpt.conv.mode.v1";   // 새 대화의 기본 모드(이 기기에서 마지막으로 고른 것)
const AGENT_KEY = "cpt.conv.agent.v1"; // 새 대화의 에이전트(고를 수 있을 때만 — agentChoices)

// conv.file 바이트 — 탭·행이 다시 그려져도 같은 파일을 다시 받지 않는다(모든 뷰가 공유, 48MB 상한).
//  키 = 호스트|대화|경로(권한이 대화 단위라 같은 경로라도 다른 대화면 따로 묻는다).
const _bytes = createByteCache(48 * 1024 * 1024);

// ── 살아 있는 뷰 ──
const _live = new Set();
let _findOwner = null;       // CSS 강조 이름은 전역 하나 — 마지막으로 검색한 뷰가 주인이다
let _cardRenderer = null;
let _channelUp = true;       // ui-channel WS — 모르면 붙어 있다고 본다(끊겼다고 먼저 말하지 않는다)
let _channelDownAt = 0;

/** approvals.js 가 카드 렌더러를 꽂는다(순환 import 회피 — chat-view 와 같은 방식). */
export function setConvCardRenderer(fn) { _cardRenderer = typeof fn === "function" ? fn : null; }

/** ui-channel 이 부른다: {type:'conv_event', threadId?, headSeq?, events?, delta?, thread?, control?, hostDeviceId?} */
export function applyConvEvent(frame) {
  if (!frame || typeof frame !== "object") return;
  for (const v of _live) { try { v._onPush(frame); } catch (_) { /* 한 뷰의 실패가 나머지를 막지 않게 */ } }
}

/** ui-channel 접속 상태. 다시 붙으면 끊긴 사이를 메운다(§10.1 "재접속: 즉시 conv.since"). */
export function setConvChannel(up) {
  const was = _channelUp;
  _channelUp = !!up;
  if (!_channelUp && was) _channelDownAt = Date.now();
  for (const v of _live) {
    try { v._syncConn(); if (_channelUp && !was) v.resync(); } catch (_) { /* noop */ }
  }
}

/** 이 스레드를 보여 주는 뷰(있으면). 알림·목록이 "이미 열려 있나"를 물을 때 쓴다. */
export function convViewFor(threadId) {
  for (const v of _live) if (threadId && v.m.threadId === threadId) return v;
  return null;
}

export class ConvView {
  /**
   * @param {HTMLElement} host `.pane-conv` 컨테이너(pane.js 가 소유·표시 전환)
   * @param {object} ctx
   *   cwd() · hostDeviceId() · isLocal() · hostOffline() · deviceName()
   *   tab()              이 뷰의 탭(또는 독립 pane 노드) — { threadId, title, draft }
   *   patchTab(p)        탭 필드 갱신 + 헤더 다시 그리기 + 영속
   *   refreshHead()      탭 헤더만 다시(조치 필요 점)
   *   openFile(rel) · fs()
   *   openTerminal({agent,args,cwd})  새 터미널 탭을 열어 그 에이전트를 실행(§6.1)
   *   focusThread(id)    같은 대화가 다른 탭에 이미 열려 있으면 그리로 가고 true
   *   rpc(method,params) (선택) 전송 계층 교체 — 하네스·테스트용
   */
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx || {};
    this.m = createConv(this.ctx.tab?.()?.threadId || null);
    this._rows = new Map();          // key → { el, sig, type }
    this._openGroups = new Set();
    this._openTools = new Set();
    this._dismissed = new Set();     // 접어 둔 요청 id
    this._visible = false;
    this._disposed = false;
    this._opened = false;            // 이 스레드를 conv.open 했는가
    this._follow = true;
    this._lastTop = 0;
    this._lastPushAt = 0;
    this._lastPullAt = 0;
    this._offline = false;           // 마지막 RPC 가 "PC 미연결"이었다
    this._caps = null;
    this._mode = null;
    try { this._newMode = localStorage.getItem(MODE_KEY) || "default"; } catch (_) { this._newMode = "default"; }
    try { this._newAgent = localStorage.getItem(AGENT_KEY) || ""; } catch (_) { this._newAgent = ""; }
    this._newEffort = "";            // 새 대화의 추론 강도("" = CLI 기본값)
    this._newModel = "";             // 새 대화의 모델(모델 목록이 있을 때만 — 없으면 에이전트 기본값)
    this._find = null;               // 대화 안 검색 상태 { q, hits:[Range], cur }
    this._usageOpen = false;
    _live.add(this);
  }

  // ── 전송 계층 ──
  async _rpc(method, params) {
    const host = this.ctx.hostDeviceId?.() ?? null;
    let r;
    try {
      r = this.ctx.rpc ? await this.ctx.rpc(method, params || {}, host) : await api.conv(method, params || {}, host);
    } catch (e) {
      const p = parseConvError(e);
      if (isOfflineCode(p.code)) this._setOffline(true);
      const err = new Error(p.message || p.code || "conv");
      err.code = p.code; err.status = p.status;
      throw err;
    }
    this._setOffline(false);
    // 성공은 데몬 결과가 최상위다(§4.0). 구 관례의 {success,data} 껍데기로 와도 받는다.
    if (r && r.success === false) {
      const err = new Error(r.message || "conv");
      err.code = (r.detail && r.detail.code) || "";
      throw err;
    }
    return r && r.success === true && r.data && typeof r.data === "object" ? r.data : (r || {});
  }

  // ── DOM ──
  mount() {
    if (this._mounted) return;
    this._mounted = true;
    const el = document.createElement("div");
    el.className = "chat conv";
    el.innerHTML = `
      <div class="conv-conn hidden"></div>
      <div class="chat-banner hidden"></div>
      <div class="chat-scroll conv-scroll"><div class="conv-rows"></div></div>
      <div class="chat-approvals conv-dock"></div>
      <div class="conv-dock-more hidden"></div>`;
    this.host.appendChild(el);
    this.el = el;
    this.connEl = el.querySelector(".conv-conn");
    this.bannerEl = el.querySelector(".chat-banner");
    this.scrollEl = el.querySelector(".conv-scroll");
    this.rowsEl = el.querySelector(".conv-rows");
    this.dockEl = el.querySelector(".conv-dock");
    this.dockMoreEl = el.querySelector(".conv-dock-more");
    // 도구줄(컴포저 아래) — Claude 앱과 같은 배치(2026-10-02): 왼쪽 [+] [더보기] [모드] · 오른쪽 [모델] [추론 강도] [사용량 링] [전송].
    //  헤더 줄(제목·모델·터미널·목록·새 대화)은 없앴다 — 그 기능은 [더보기] 메뉴로 갔다.
    const mkTool = (cls, html, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "conv-tool " + cls;
      b.innerHTML = html;
      if (title) b.title = title;
      return b;
    };
    //  ⋯ 는 입력창 안이 아니라 채팅 pane 우측 상단에 떠 있다(2026-10-02 사용자 확정) — 도구줄에는 자주 쓰는 것만 남긴다.
    this.moreBtn = mkTool("conv-t-more conv-more-fab", icons.dots({ size: 16 }), i18n.t('더 보기'));
    this.moreBtn.addEventListener("click", (e) => { e.stopPropagation(); this._toggleMoreMenu(); });
    this.listBtn = this.moreBtn;   // 대화 목록 팝오버의 바깥 클릭 판정이 쓰는 앵커
    this.modelBtn = mkTool("conv-t-model hidden", `<span class="conv-t-label"></span>`, i18n.t('모델'));
    this.modelBtn.addEventListener("click", (e) => { e.stopPropagation(); this._toggleModelMenu(); });
    this.effortBtn = mkTool("conv-t-effort hidden", `<span class="conv-t-label"></span>`, i18n.t('추론 강도'));
    this.effortBtn.addEventListener("click", (e) => { e.stopPropagation(); this._toggleEffortPop(); });
    this.ringBtn = mkTool("conv-t-ring hidden",
      `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle class="conv-ring-bg" cx="10" cy="10" r="7.5"/><circle class="conv-ring-fg" cx="10" cy="10" r="7.5" transform="rotate(-90 10 10)"/></svg>`,
      i18n.t('사용량'));
    this.ringBtn.addEventListener("click", (e) => { e.stopPropagation(); this._toggleUsagePop(); });
    const ctlRight = document.createElement("span");
    ctlRight.className = "conv-ctl-pills";
    ctlRight.append(this.modelBtn, this.effortBtn, this.ringBtn);

    // 모드 알약 — 모양은 v1 과 같다(.chat-mode). 여기서는 키 입력 대행이 아니라 conv.set 이다.
    this.modeEl = document.createElement("button");
    this.modeEl.className = "chat-mode";
    this.modeEl.type = "button";
    this.modeEl.title = i18n.t('에이전트 모드');
    this.modeEl.innerHTML = `<span class="chat-mode-label"></span><span class="chat-mode-caret">${icons.chevronDown({ size: 11 })}</span>`;
    this.modeEl.addEventListener("click", (e) => { e.stopPropagation(); this._toggleModeMenu(); });
    // 에이전트 알약 — 새 대화에서, 고를 수 있는 에이전트가 2개 이상일 때만(§4.5).
    this.agentEl = document.createElement("button");
    this.agentEl.className = "chat-mode conv-agent hidden";
    this.agentEl.type = "button";
    this.agentEl.title = i18n.t('에이전트');
    this.agentEl.innerHTML = `<span class="chat-mode-label"></span><span class="chat-mode-caret">${icons.chevronDown({ size: 11 })}</span>`;
    this.agentEl.addEventListener("click", (e) => { e.stopPropagation(); this._toggleAgentMenu(); });
    const ctlLeft = document.createElement("span");
    ctlLeft.className = "conv-ctl-pills";
    ctlLeft.append(this.agentEl, this.modeEl);

    this.composer = new ConvComposer({
      onSend: (text, atts) => this._send(text, atts),
      onStop: () => this._interrupt(),
      busy: () => isBusy(this.m),
      placeholder: () => {
        const name = agentDisplayName(this._agentId());
        return name ? name + i18n.t('에게 요청') : i18n.t('메시지 보내기');
      },
      getDraft: () => this.ctx.tab?.()?.draft || "",
      getAtts: () => this.ctx.tab?.()?.draftAtts || [],
      setAtts: (list) => this.ctx.patchTab?.({ draftAtts: list && list.length ? list : undefined }, { quiet: true }),
      setDraft: (s) => this.ctx.patchTab?.({ draft: s ? String(s).slice(0, CONV.DRAFT_MAX) : undefined }, { quiet: true }),
      cwd: () => this.ctx.cwd?.() || "",
      fs: () => this.ctx.fs?.(),
      commands: async () => {
        const r = await this._rpc("conv.commands", this.m.threadId ? { threadId: this.m.threadId } : { cwd: this.ctx.cwd?.() || "" });
        return r.items || [];
      },
      ctlLeft,
      ctlRight,
      stage: (a) => this._stageAttachment(a),
      thumb: (a) => this._attachThumb(a),
      preview: (a) => void this._previewAttachment(a),
      attachError: (a, e) => this._setBanner(e === "LIMIT" ? i18n.t('첨부는 한 번에 {n}개까지예요', { n: 12 })
        : i18n.t('첨부하지 못했어요 · {name}', { name: a.name || "" }), "warn", 5000),
    });
    this.composer.mount(el);
    el.appendChild(this.moreBtn);
    // 맨 아래로 — 컴포저의 자식이다(입력 줄 수가 바뀌어도 항상 바로 위에 뜬다. v1 과 같은 자리).
    this.jumpEl = document.createElement("button");
    this.jumpEl.className = "chat-jump hidden";
    this.jumpEl.type = "button";
    this.jumpEl.title = i18n.t('맨 아래로');
    this.jumpEl.innerHTML = icons.arrowDown({ size: 15 });
    this.jumpEl.addEventListener("click", () => { this._follow = true; this._toBottom(); this._syncJump(); });
    this.composer.el.appendChild(this.jumpEl);

    // ── 따라가기(§10.4) ──
    //  내용이 늘어서 생긴 변화는 scrollTop 을 줄이지 않는다. **위로 움직였을 때만** 사용자가 떠난 것이다.
    //  바닥에 닿으면 다시 따라간다.
    this.scrollEl.addEventListener("scroll", () => {
      const top = this.scrollEl.scrollTop;
      if (this._atBottom()) this._follow = true;
      else if (top < this._lastTop - 1) this._follow = false;
      this._lastTop = top;
      this._syncJump();
      if (top < CONV.HISTORY_EDGE_PX) void this._loadBefore();
    }, { passive: true });
    // 이미지가 늦게 실리거나 코드 블록이 자라면 높이만 변한다(스크롤 이벤트 없음) → 따라가는 중이면 붙인다.
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => { if (this._follow) this._toBottom(); else this._syncJump(); });
      this._ro.observe(this.rowsEl);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this._mediaObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this._mediaObs.unobserve(e.target);
          void loadMedia(e.target, (t) => this._fileBytes(t), (src, a) => this._lightbox(src, a));
        }
      }, { root: this.scrollEl, rootMargin: "300px 0px" });
    }

    // 본문을 누른 뒤의 Esc(중단)가 이 뷰에 닿게 한다 — 스크롤 영역은 원래 포커스를 못 받아서 키가 body 로 간다.
    this.scrollEl.tabIndex = -1;
    this.rowsEl.addEventListener("click", (e) => this._onBodyClick(e));
    this.connEl.addEventListener("click", (e) => {
      if (e.target.closest?.("[data-act='adopt']")) void this._adoptCurrent();
    });
    this.dockMoreEl.addEventListener("click", () => { this._dismissed.clear(); this._renderDock(); });
    // Esc = 작업 중단. 입력칸은 자기 Esc 를 스스로 처리한다(팝오버 먼저) — 여기는 본문을 누른 뒤의 Esc.
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (e.target.closest?.(".conv-title-input, .approval-card, .conv-pop, .chat-pick, .conv-find")) return;
      if (this._closePopovers()) { e.preventDefault(); return; }
      if (isBusy(this.m)) { e.preventDefault(); void this._interrupt(); }
    });
    this._onWinFocus = () => { if (this._visible) this.resync(); };
    this._onVis = () => { if (this._visible && document.visibilityState === "visible") this.resync(); };
    window.addEventListener("focus", this._onWinFocus);
    document.addEventListener("visibilitychange", this._onVis);
    this._render();
  }

  setVisible(on) {
    const was = this._visible;
    this._visible = !!on;
    if (this._visible === was) return;
    if (!this._visible) { this._stopTick(); this._closePopovers(); return; }
    this._startTick();
    if (this.m.threadId && !this._opened) void this._open();
    else if (this.m.threadId) this.resync();
    void this._loadCaps();
    this._render();
    requestAnimationFrame(() => {
      if (!this._visible || this._disposed) return;
      if (this._follow) this._toBottom();
      this.composer?.sync();
    });
  }

  focus() { this.composer?.focus(); }

  /** 탭 점 — 답을 기다리는 요청이 있다. */
  needsAttention() { return openReqs(this.m).length > 0; }

  /** OS 에서 끌어다 놓은 파일 — 입력칸 아래 첨부 칩으로(§4.5). 이 PC 의 파일이다(origin local). */
  addPaths(paths) {
    this.composer?.addFiles((paths || []).filter(Boolean).map((p) => ({ path: p, origin: "local" })));
    this.composer?.focus();
  }

  /** 화면에서 집어 온 것(디자인 모드 요소·화면 캡처) — 설명 글을 입력칸에 넣고 파일은 첨부 칩으로. */
  attachWithText(text, paths) {
    this.composer?.addFiles((paths || []).filter(Boolean).map((p) => ({ path: p, origin: "local" })));
    if (text) this.composer?.insertText(text);
    this.composer?.focus();
  }

  /** 이 탭을 다른 대화로 바꾼다(목록에서 고름·알림에서 옴). */
  openThread(threadId, title) {
    if (!threadId) return;
    if (threadId === this.m.threadId) { if (!this._opened && this._visible) void this._open(); return; }
    this._resetTo(threadId);
    this.ctx.patchTab?.({ threadId, title: title || "" });
    if (this._visible) void this._open();
  }

  /** 빈 대화로 — 지금 대화는 목록에 남는다. */
  newThread() {
    this._closePopovers();
    if (!this.m.threadId && !this.m.pending.size) { this.composer?.focus(); return; }
    this._resetTo(null);
    this.ctx.patchTab?.({ threadId: undefined, title: undefined });
    this._render();
    this.composer?.focus();
  }

  _dropRows() {
    for (const ent of this._rows.values()) ent.el.remove();
    this._rows.clear();
  }

  _resetTo(threadId) {
    this.m = createConv(threadId);
    this._opened = false;
    this._opening = null;
    this._creating = null;
    this._catching = false;
    this._loadingBefore = false;
    this._openGroups.clear(); this._openTools.clear(); this._dismissed.clear();
    for (const ent of this._rows.values()) ent.el.remove();
    this._rows.clear();
    this._follow = true;
    this._setBanner("");
    this.composer?.resetCommands();
    this._mode = null;
    if (this._find) this._runFind();
  }

  // ── 열기·따라잡기 ──
  async _open() {
    if (this._opening) return this._opening;
    const id = this.m.threadId;
    if (!id) return null;
    this._setBanner(i18n.t('대화를 불러오는 중…'), "info");
    this._opening = (async () => {
      try {
        // cwd — 우리 색인에 없는 대화(터미널에서 만든 것)를 처음 열 때 데몬이 세션 파일을 찾는 근거다(§4).
        const r = await this._rpc("conv.open", { threadId: id, limit: CONV.OPEN_LIMIT, cwd: this.ctx.cwd?.() || "" });
        if (this._disposed || this.m.threadId !== id) return;
        const { more } = applyOpen(this.m, r);
        this._opened = true;
        this._lastPullAt = Date.now();
        this._setBanner("");
        this._follow = true;
        this._syncThread();
        this._render();
        if (more) void this._catchUp();
      } catch (e) {
        if (this._disposed || this.m.threadId !== id) return;
        this._openFailedAt = Date.now();
        if (e.code === "THREAD_NOT_FOUND") this._setBanner(i18n.t('대화를 찾을 수 없어요.'), "warn");
        else if (isOfflineCode(e.code)) this._setBanner("");   // 연결 상태 줄이 말한다
        else this._setBanner(convErrorText(e.code), "warn");
      } finally {
        this._opening = null;
      }
    })();
    return this._opening;
  }

  /** 끊긴 사이를 메운다 — 재접속·창 복귀·틈 발견·폴백 폴링이 모두 이것을 부른다. */
  resync() {
    if (!this.m.threadId) return;
    if (!this._opened) { if (this._visible) void this._open(); return; }
    void this._catchUp();
  }

  async _catchUp() {
    if (this._catching || !this.m.threadId || !this._opened) { this._again = this._catching; return; }
    this._catching = true;
    const id = this.m.threadId;
    try {
      // 응답은 512KB 예산으로 잘릴 수 있다(more) → 다 받을 때까지 잇는다. 상한은 폭주 방지.
      for (let i = 0; i < 40; i++) {
        const r = await this._rpc("conv.since", { threadId: id, sinceSeq: this.m.headSeq });
        if (this._disposed || this.m.threadId !== id) return;
        const { more, reopen, reset } = applySince(this.m, r);
        if (reopen) { this._opened = false; if (this._visible) void this._open(); return; }
        if (reset) this._dropRows();   // 로그가 통째로 바뀌었다 — 옛 행(같은 key 의 다른 내용)을 재사용하지 않는다
        this._lastPullAt = Date.now();
        this._syncThread();
        this._render();
        if (!more) break;
      }
    } catch (e) {
      if (this._disposed || this.m.threadId !== id) return;
      // 구독이 사라졌으면 다시 여는 것이 항상 옳은 복구다(conv.open 은 멱등).
      if (e.code === "THREAD_NOT_FOUND") { this._opened = false; if (this._visible) void this._open(); }
    } finally {
      this._catching = false;
      if (this._again) { this._again = false; void this._catchUp(); }
    }
  }

  async _loadBefore() {
    if (this._loadingBefore || !this._opened || this.m.noMoreBefore || !this.m.floorSeq || this.m.floorSeq <= 1) return;
    this._loadingBefore = true;
    const id = this.m.threadId;
    this._syncTopHint();
    try {
      const r = await this._rpc("conv.before", { threadId: id, beforeSeq: this.m.floorSeq, limit: CONV.BEFORE_LIMIT });
      if (this._disposed || this.m.threadId !== id) return;
      // 위에 끼워 넣어도 보던 자리가 움직이지 않게 — 늘어난 높이만큼 내린다.
      const h0 = this.scrollEl.scrollHeight;
      const t0 = this.scrollEl.scrollTop;
      applyBefore(this.m, r);
      this._renderNow();
      this.scrollEl.scrollTop = t0 + (this.scrollEl.scrollHeight - h0);
      this._lastTop = this.scrollEl.scrollTop;
    } catch (_) {
      /* 다음 스크롤에 다시 시도한다 */
    } finally {
      this._loadingBefore = false;
      this._syncTopHint();
    }
  }

  // ── push ──
  _onPush(frame) {
    if (this._disposed) return;
    // 멀티 PC — back 이 프레임이 온 PC 를 붙인다. 내 탭의 호스트가 아니면 남의 것이다.
    const mine = this.ctx.hostDeviceId?.();
    if (frame.hostDeviceId != null && mine != null && Number(frame.hostDeviceId) !== Number(mine)) return;
    const ctl = frame.control;
    const tid = frame.threadId || (ctl && ctl.threadId) || (frame.thread && frame.thread.id) || null;
    if (this.listEl && frame.thread) this._noteListThread(frame.thread);
    if (!tid || tid !== this.m.threadId) return;
    this._lastPushAt = Date.now();
    if (ctl) {
      if (ctl.kind === "deleted") {
        // 다른 기기에서 대화를 지웠다 — 없는 대화를 붙들고 있지 않는다.
        this._resetTo(null);
        this.ctx.patchTab?.({ threadId: undefined, title: undefined });
        this._setBanner(i18n.t('이 대화는 삭제됐어요.'), "info");
        this._render();
      } else if (ctl.kind === "gone") {
        this._opened = false;
        if (this._visible) void this._open();
      }
      return;
    }
    if (!this._opened) return;   // 아직 스냅샷이 없다 — 열면 그 안에 다 들어 있다
    if (frame.thread) {
      const h = applyThreadHint(this.m, frame.thread);
      this._syncThread();
      // 가져온 과거(터미널에서 이어 간 부분)는 push 되지 않는다(§4.3) — 힌트의 headSeq 가 앞서 있으면 당겨 온다.
      //  힌트는 이벤트 프레임과 앞뒤로 섞여 온다 → 잠깐 기다렸다가 그래도 뒤처져 있을 때만 부른다.
      if (h.behind) {
        clearTimeout(this._behindTimer);
        this._behindTimer = setTimeout(() => {
          if (this._disposed || !this._opened) return;
          if (((this.m.thread && this.m.thread.headSeq) || 0) > this.m.headSeq) void this._catchUp();
        }, 600);
      }
    }
    if (Array.isArray(frame.events) && frame.events.length) {
      const r = applyPush(this.m, frame);
      if (r.resync) { void this._catchUp(); return; }
      if (r.applied) this._syncThread();
    }
    if (frame.delta) {
      const r = applyDelta(this.m, frame.delta);
      if (r.resync) { void this._catchUp(); return; }
    }
    this._render();
  }

  // ── 폴백 폴링 + 경과 시간 ──
  _startTick() {
    this._stopTick();
    this._tick = setInterval(() => this._onTick(), 1000);
  }
  _stopTick() { clearInterval(this._tick); this._tick = null; }
  _onTick() {
    if (!this._visible || this._disposed) return;
    this._syncWorking();
    this._syncConn();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (!this.m.threadId) return;
    // 보고 있는 대화의 알림은 읽은 것이다 — 창에 포커스가 있을 때만(다른 앱을 보는 중이면 남긴다).
    if (typeof document !== "undefined" && document.hasFocus && document.hasFocus()) this.ctx.markRead?.(this.m.threadId);
    if (!this._opened) {
      // 열기 실패 — 8초 간격으로만 다시(오프라인에서 폭주 금지).
      if (!this._opening && Date.now() - (this._openFailedAt || 0) > CHAT.OPEN_FAIL_RETRY_MS) void this._open();
      return;
    }
    if (shouldPoll({
      now: Date.now(), lastPushAt: this._lastPushAt, lastPullAt: this._lastPullAt,
      working: isBusy(this.m), visible: true,
    })) void this._catchUp();
  }

  // ── 보내기(§10.2) ──
  _send(text, atts) {
    const clientId = newClientId();
    addPending(this.m, { clientId, text, now: Date.now(), attachments: atts });
    this._follow = true;
    this._renderNow();
    this._toBottom();
    void this._dispatch(clientId);
  }

  async _dispatch(clientId) {
    const p = this.m.pending.get(clientId);
    if (!p) return;
    // 호스트가 꺼져 있으면 보내지 않는다 — 버블은 실패로 두고 연결 상태 줄이 이유를 말한다.
    if (this.ctx.hostOffline?.()) {
      markPending(this.m, clientId, "offline", "DAEMON_OFFLINE");
      this._render();
      return;
    }
    const timer = setTimeout(() => {
      if (markPending(this.m, clientId, "timeout", "TIMEOUT")) this._render();
    }, CONV.SEND_FAIL_MS);
    const atts = attachmentsForWire(p.attachments);
    try {
      // 첫 메시지가 대화를 만든다. 만드는 중에 또 보낸 글은 그 대화가 생길 때까지 기다린다(둘을 만들지 않게).
      if (!this.m.threadId && this._creating) await this._creating.catch(() => {});
      let r;
      if (!this.m.threadId) {
        const mode = this._newMode && this._newMode !== "default" ? this._newMode : undefined;
        // 에이전트·모델은 고를 수 있을 때만 싣는다(고르는 줄이 숨어 있으면 데몬 기본값).
        const agent = agentChoices(this._caps).some((a) => a.id === this._newAgent) ? this._newAgent : undefined;
        const model = this._newModel && this._modelChoices().length ? this._newModel : undefined;
        const effort = this._newEffort || undefined;
        this._creating = this._rpc("conv.create", {
          cwd: this.ctx.cwd?.() || "", text: p.text, clientId, ...(atts ? { attachments: atts } : {}),
          ...(mode ? { mode } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        });
        try { r = await this._creating; } finally { this._creating = null; }
        const th = r.thread || {};
        if (th.id && !this.m.threadId) {
          this.m.threadId = th.id;
          this.m.thread = { ...th };
          this._opened = true;               // 새 대화다 — 받아 올 과거가 없다(seq 1 부터 push 로 온다)
          this.m.noMoreBefore = true;
          this.ctx.patchTab?.({ threadId: th.id, title: th.title || "" });
          this._syncThread();
          void this._catchUp();              // 만드는 사이 지나간 이벤트
        }
      } else {
        r = await this._rpc("conv.send", { threadId: this.m.threadId, clientId, text: p.text, ...(atts ? { attachments: atts } : {}) });
      }
      if (r && r.ok === false) {
        // 데몬이 받았지만 에이전트에 전달하지 않았다(정상 응답 — 예외가 아니다).
        if (r.code === "TERMINAL_ONLY_COMMAND") {
          // 보내기 실패가 아니라 여기서는 못 쓰는 명령이다 — 버블을 실패로 두지 않는다.
          //  데몬이 남긴 메시지와 안내 줄이 곧 도착해 이 버블을 대신한다.
          markPending(this.m, clientId, "ack_sent");
          void this._catchUp();
        } else markPending(this.m, clientId, "error", r.code || "");
      } else markPending(this.m, clientId, r && r.status === "queued" ? "ack_queued" : "ack_sent");
    } catch (e) {
      markPending(this.m, clientId, isOfflineCode(e.code) ? "offline" : "error", e.code || "");
      if (e.code === "THREAD_BUSY_IN_TERMINAL") {
        this.m.thread = { ...(this.m.thread || {}), owner: "terminal" };
        void this._catchUp();
      }
    } finally {
      clearTimeout(timer);
      if (!this._disposed) this._render();
    }
  }

  /** 다시 시도 — **같은 clientId**. 데몬이 이미 받았다면 같은 결과를 돌려준다(중복 전송이 되지 않는다). */
  _retry(clientId, fromMsg) {
    if (fromMsg) {
      // 서버가 '실패'로 기록한 내 메시지 — 그 행은 접고 같은 id 의 버블로 다시 보낸다.
      this.m.hidden.add(fromMsg.key);
      // 서버 본문에는 데몬이 붙인 `[첨부]` 줄이 있다 — 떼어서 첨부로 다시 보낸다(두 번 붙지 않게).
      const sp = splitAttachLines(fromMsg.text, fromMsg.attachments);
      addPending(this.m, { clientId, text: sp.body, now: Date.now(), attachments: sp.files });
    } else if (!markPending(this.m, clientId, "retry")) return;
    this._render();
    void this._dispatch(clientId);
  }

  async _interrupt() {
    if (!this.m.threadId || this._stopping) return;
    this._stopping = true;
    try {
      const r = await this._rpc("conv.interrupt", { threadId: this.m.threadId });
      // 에이전트가 중단 요청에 답하지 않았다/거절했다 — 오류가 아니라 응답으로 온다({ok:false, code}).
      if (r && r.ok === false) this._setBanner(convErrorText(r.code || "CONTROL_FAILED"), "warn", 4000);
      void this._catchUp();
    } catch (e) {
      if (!isOfflineCode(e.code)) this._setBanner(i18n.t('중단하지 못했어요 · 잠시 후 다시 시도해 주세요'), "warn", 4000);
    } finally {
      this._stopping = false;
    }
  }

  // ── 그리기 ──
  _render() {
    if (this._raf || this._disposed || !this._mounted) return;
    const run = () => { this._raf = 0; this._renderNow(); };
    this._raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  _renderNow() {
    if (this._disposed || !this._mounted) return;
    if (this._raf) { (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(this._raf); this._raf = 0; }
    const rows = buildRows(this.m, { openGroups: this._openGroups, openTools: this._openTools });
    const want = new Set(rows.map((r) => r.key));
    for (const [key, ent] of this._rows) {
      if (!want.has(key)) { ent.el.remove(); this._rows.delete(key); }
    }
    let prev = this._topHint && this._topHint.isConnected ? this._topHint : null;
    for (const r of rows) {
      let ent = this._rows.get(r.key);
      const stream = r.type === "live" || r.type === "assistant";
      if (ent && r.type === "live" && r.kind === "thinking" && ent.type === "live" && !ent.stream) {
        paintThinkingLive(ent.el, r.text);
      } else if (ent && stream && ent.stream) {
        // 글자가 자라는 행(그리고 그것이 완성본이 되는 순간) — 같은 요소에서 이어 그린다.
        if (r.type === "live" || ent.sig !== r.sig) this._paintStreamRow(ent.el, r);
      } else if (!ent || ent.sig !== r.sig || ent.type !== r.type) {
        const el = this._buildRow(r);
        if (!el) { if (ent) { ent.el.remove(); this._rows.delete(r.key); } continue; }
        if (ent) ent.el.replaceWith(el);
        ent = { el, stream: stream && r.kind !== "thinking" };
        this._rows.set(r.key, ent);
      }
      ent.sig = r.sig; ent.type = r.type;
      const ref = prev ? prev.nextSibling : this.rowsEl.firstChild;
      if (ent.el !== ref) this.rowsEl.insertBefore(ent.el, ref);
      prev = ent.el;
    }
    this._syncBlank(rows.length === 0);
    this._syncWorking();
    this._renderDock();
    this._syncHead();
    this._syncConn();
    this._syncUsage();
    this.composer?.sync();
    if (this._follow) this._toBottom();
    this._syncJump();
    if (this._find && this._find.q) this._queueFind();
    const att = this.needsAttention();
    if (att !== this._att) { this._att = att; this.ctx.refreshHead?.(); }
  }

  _paintStreamRow(el, r) {
    if (r.type === "live") paintStream(el, r.text, { final: false });
    else paintStream(el, r.msg.text, { final: true, truncated: !!r.msg.truncated, hydrate: (b) => this._hydrate(b) });
  }

  _hydrate(root) {
    hydrateMedia(root, { observer: this._mediaObs });
    if (!this._mediaObs) for (const el of root.querySelectorAll?.(".chat-media") || []) void loadMedia(el, (t) => this._fileBytes(t), (src, a) => this._lightbox(src, a));
  }

  // ── 파일 바이트(§4.5) ──
  //  이 PC 의 대화면 절대경로를 로컬에서 바로 읽는다(왕복 0). 그 밖(다른 PC·상대 경로·로컬 읽기 실패)은
  //  conv.file — 권한은 데몬이 정한다(그 대화에 등장한 경로만).
  async _fileBytes(path) {
    const target = String(path || "");
    if (!target) return { missing: true, reason: "not_found" };
    const tid = this.m.threadId || "";
    const key = `${this.ctx.hostDeviceId?.() ?? ""}|${tid}|${target}`;
    return _bytes.get(key, async () => {
      if (this.ctx.isLocal?.() && (target.startsWith("~") || isAbs(target))) {
        try {
          const b64 = await api.filePreviewB64(target);
          if (b64) return { mediaType: mimeOf(target), base64: b64, name: basename(target) };
        } catch (_) { /* 데몬 경로로 */ }
      }
      if (!tid) return { missing: true, reason: "not_found" };
      return this._rpc("conv.file", { threadId: tid, path: target });
    });
  }

  _lightbox(src, a) {
    showLightbox(src, { ...a, canOpen: !!this.ctx.isLocal?.() && !!a.path && (a.path.startsWith("~") || isAbs(a.path)) });
  }

  /** 보낸 말풍선의 이미지 칩 — 썸네일을 채운다(없으면 그대로 라벨 칩). */
  _hydrateChips(row) {
    for (const chip of row.querySelectorAll?.('.chat-chip.msg[data-image="1"]') || []) {
      if (chip.querySelector("img")) continue;
      const path = chip.dataset.path || "";
      void this._fileBytes(path).then((r) => {
        const wait = chip.querySelector(".conv-thumb-wait");
        if (!r || r.missing || !r.base64) { wait?.remove(); return; }
        const img = document.createElement("img");
        img.className = "chat-chip-thumb";
        img.alt = "";
        img.src = `data:${r.mediaType || mimeOf(path)};base64,${r.base64}`;
        if (wait) wait.replaceWith(img); else chip.prepend(img);
      }).catch(() => chip.querySelector(".conv-thumb-wait")?.remove());
    }
  }

  // ── 첨부 준비(컴포저가 부른다) ──
  /** 칩 → 그 PC 의 경로. keep=그대로 · copy=이 PC 홈 밖 → ~/.codingpt/attachments · upload=다른 PC 로 올림. */
  async _stageAttachment(a) {
    // VM 워크스페이스 — 에이전트가 VM 안에서 돌아 이 PC 의 경로를 못 읽는다 → 파일을 VM 안으로 올리고 그쪽 경로를 넘긴다.
    const vmRoot = this.ctx.vmRoot?.();
    if (vmRoot && a.origin !== "workspace") {
      const b = await api.filePreviewB64(a.src);
      if (!b) throw new Error("empty");
      const up = await this.ctx.fs().fsWriteBytes(`${vmRoot}/.cpt-attachments/${attachUploadName(a.name, Date.now()).split("/").pop()}`, b);
      if (!up || !up.absPath) throw new Error("no absPath");
      return { path: up.absPath };
    }
    const plan = attachPlan({ path: a.src, origin: a.origin }, !!this.ctx.isLocal?.());
    if (plan === "keep") return { path: a.src };
    const b64 = await api.filePreviewB64(a.src);   // 8MB 상한(넘으면 throw — 칩을 빼고 알린다)
    if (!b64) throw new Error("empty");
    const rel = attachUploadName(a.name, Date.now());
    if (plan === "copy") return { path: await api.fsWriteB64(rel, b64) };
    const fs = this.ctx.fs?.();
    if (!fs || typeof fs.fsWriteBytes !== "function") throw new Error("no remote fs");
    const r = await fs.fsWriteBytes(rel, b64);
    const abs = r && (r.absPath || (r.data && r.data.absPath));
    if (!abs) throw new Error("no absPath");
    return { path: abs };
  }

  async _attachThumb(a) {
    if (a.origin === "workspace") {
      const fs = this.ctx.fs?.();
      const r = fs && typeof fs.fsReadBytes === "function" ? await fs.fsReadBytes(a.src) : null;
      return (r && r.base64) || null;
    }
    return (await api.filePreviewB64(a.src)) || null;
  }

  async _previewAttachment(a) {
    let b64 = a.b64;
    if (!b64 && a.image) { try { b64 = await this._attachThumb(a); } catch (_) { b64 = null; } }
    if (b64) { this._lightbox(`data:${a.mediaType || mimeOf(a.src)};base64,${b64}`, { name: a.name, path: a.origin === "local" ? a.src : "" }); return; }
    if (a.origin === "local" && this.ctx.isLocal?.()) void this._openInIde(a.src);
    else if (a.origin === "local") api.openPath(a.src).catch(() => this._setBanner(i18n.t('파일을 열 수 없어요.'), "warn", 4000));   // 이 PC 의 파일인데 대화는 다른 PC — 그 PC 의 IDE 로는 못 연다
    else this.ctx.openFile?.(a.src);
  }

  _buildRow(r) {
    switch (r.type) {
      case "user": {
        const sp = r.msg.kind === "slash" ? { body: r.msg.text, files: [] } : splitAttachLines(r.msg.text, r.msg.attachments);
        const el = buildUserRow({ key: r.key, text: sp.body, status: r.status, slash: r.msg.kind === "slash", clientId: r.msg.clientId, files: sp.files });
        this._hydrateChips(el);
        return el;
      }
      case "pending":
        return buildUserRow({ key: r.key, text: r.text, status: r.status, code: r.code, clientId: r.clientId, files: r.attachments || [] });
      case "assistant": {
        const el = buildAssistantRow(r.key);
        if (r.sub) el.classList.add("conv-sub");
        this._paintStreamRow(el, r);
        return el;
      }
      case "live": {
        if (r.kind === "thinking") { const el = buildThinkingLive(r.key); paintThinkingLive(el, r.text); return el; }
        const el = buildAssistantRow(r.key);
        this._paintStreamRow(el, r);
        return el;
      }
      case "thinking": return buildThinkingRow(r.msg);
      case "tool": return buildToolRow(r, this._openTools.has(r.key));
      case "orphan": return buildOrphanRow(r);
      case "group": return buildGroupRow(r);
      case "turn": return buildTurnRow(r);
      case "notice": return buildNoticeRow(r);
      default: return buildDividerRow(r.msg);
    }
  }

  _syncBlank(empty) {
    const show = empty && !this._opening && !(this.m.threadId && !this._opened);
    let el = this.rowsEl.querySelector(":scope > .chat-blank");
    if (!show) { el?.remove(); return; }
    if (el) return;
    el = document.createElement("div");
    el.className = "chat-blank empty";
    const agent = (this.m.thread && this.m.thread.agent) || "claude";
    el.innerHTML = `<span class="chat-blank-ic">${agentMarkHtml(agent, { size: 30 }) || icons.chat({ size: 30 })}</span>`
      + `<div class="chat-blank-title empty-title">${i18n.t('무엇이든 요청하세요')}</div>`;
    this.rowsEl.appendChild(el);
  }

  _syncTopHint() {
    if (this._loadingBefore) {
      if (!this._topHint) {
        this._topHint = document.createElement("div");
        this._topHint.className = "chat-headhint";
        this._topHint.textContent = i18n.t('불러오는 중…');
      }
      this.rowsEl.insertBefore(this._topHint, this.rowsEl.firstChild);
    } else this._topHint?.remove();
  }

  // 작업 중 한 줄 — 지금 도는 도구 + 경과 시간. 요청 카드가 떠 있으면 그 카드가 이미 말하고 있다.
  _syncWorking() {
    if (!this.rowsEl) return;
    const w = workingInfo(this.m);
    const on = w.on && !w.waiting && !openReqs(this.m).length;
    let el = this.rowsEl.querySelector(":scope > .chat-working");
    if (!on) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-working";
      el.innerHTML = `<span class="chat-working-dot"></span><span class="conv-working-title"></span><span class="conv-working-time"></span>`;
    }
    if (el !== this.rowsEl.lastElementChild) this.rowsEl.appendChild(el);   // 항상 맨 아래
    const title = w.title || i18n.t('작업 중…');
    const tEl = el.querySelector(".conv-working-title");
    if (tEl.textContent !== title) tEl.textContent = title;
    const ms = w.since != null ? Date.now() - w.since : -1;
    const time = ms >= 1000 ? fmtDuration(ms) : "";
    const cEl = el.querySelector(".conv-working-time");
    if (cEl.textContent !== time) cEl.textContent = time;
  }

  // ── 요청 도크(§10.8) — 가장 오래된 것 하나 + "n개 더" ──
  _renderDock() {
    if (!this.dockEl) return;
    const all = openReqs(this.m);
    const shown = all.filter((q) => !this._dismissed.has(q.id));
    const first = this._visible && _cardRenderer ? shown[0] : null;
    const rows = [];
    // 에이전트가 질문(AskUserQuestion)을 물어 답을 기다리는 동안엔 입력창을 숨긴다 — 답은 카드(선택지·'기타' 직접 입력)로 받는다.
    //  카드를 접으면(first 없음) 입력창이 돌아온다.
    this.el.classList.toggle("conv-asking", !!(first && first.kind === "question"));
    if (first) {
      const card = reqToCard(first);
      const req = first;
      card._respond = (body) => this._respond(req, body);
      card._dismiss = () => { this._dismissed.add(req.id); this._renderDock(); };
      rows.push(card);
    }
    if (_cardRenderer) _cardRenderer(this.dockEl, rows);
    const more = shown.length - (first ? 1 : 0);
    const folded = all.length - shown.length;
    const parts = [];
    if (more > 0) parts.push(i18n.t('{n}개 더 기다리는 중', { n: more }));
    if (folded > 0) parts.push(i18n.t('답을 기다리는 요청 {n}개', { n: folded }) + ' · ' + i18n.t('기다리는 요청 보기'));
    this.dockMoreEl.textContent = parts.join(" · ");
    this.dockMoreEl.classList.toggle("hidden", !parts.length);
    this.dockMoreEl.classList.toggle("link", folded > 0);
  }

  async _respond(req, body) {
    try {
      await this._rpc("conv.respond", { threadId: this.m.threadId, ...respondParams(req, body, this.ctx.deviceName?.()) });
    } catch (e) {
      // 다른 기기가 먼저 답했다 — 실패가 아니라 끝난 일이다.
      if (e.code !== "REQ_NOT_PENDING") throw new Error(convErrorText(e.code));
    }
    // 서버의 req 이벤트가 오기 전에 카드를 걷는다(다시 누를 수 없게). 곧 같은 id 의 이벤트가 덮는다.
    const q = this.m.reqs.get(req.id);
    if (q && q.status === "pending") {
      q.status = body.decision === "deny" ? "denied" : body.decision === "answer" ? "answered" : "allowed";
      q._local = true;
    }
    this._render();
    void this._catchUp();
  }

  // ── 본문 클릭(위임) ──
  _onBodyClick(e) {
    const t = e.target;
    const act = t.closest?.("[data-act]");
    if (act) {
      const row = act.closest("[data-key]");
      const key = row ? row.dataset.key : "";
      const a = act.dataset.act;
      if (a === "copy") { this._copy(row, act); return; }
      if (a === "retry" || a === "discard") {
        const cid = row.dataset.clientId || "";
        const ent = this.m.msgs.get(key);
        if (a === "retry") this._retry(cid, ent ? ent.msg : null);
        else { if (ent) this.m.hidden.add(key); else removePending(this.m, cid); this._render(); }
        return;
      }
      if (a === "full") { void this._loadFull(key); return; }
    }
    const grp = t.closest?.(".chat-tool-group");
    if (grp) { this._openGroups.add(grp.dataset.key); this._render(); return; }
    const mchip = t.closest?.(".chat-chip.msg");
    if (mchip) { void this._openPath(mchip.dataset.path || "", mchip.dataset.name || ""); return; }
    const dmore = t.closest?.(".chat-diff-more");
    if (dmore) {
      const rest = dmore.parentElement?.querySelector(".chat-diff-rest");
      if (rest) { rest.classList.remove("hidden"); dmore.remove(); }
      return;
    }
    const copy = t.closest?.(".chat-code-copy");
    if (copy) {
      const txt = copy.closest(".chat-code")?.querySelector(".chat-code-pre")?.textContent || "";
      if (txt) this._flashCopied(copy, txt);
      return;
    }
    const link = t.closest?.(".chat-a");
    if (link) {
      e.preventDefault();
      this._openLink(link.dataset.href || "", e);
      return;
    }
    const file = t.closest?.(".chat-file");
    if (file) { void this._openPath(file.dataset.target || "", file.dataset.name || ""); return; }
    // 못 불러온 미디어 자리 — 누르면 원본을 연다(너무 큰 파일 등).
    const media = t.closest?.('.chat-media[data-openable="1"]');
    if (media) { void this._openPath(media.dataset.target || "", media.dataset.name || "", { noPreview: true }); return; }
    const more = t.closest?.(".chat-out-more");
    if (more) {
      const pre = more.previousElementSibling;
      if (pre && pre.dataset.full != null) { pre.textContent = pre.dataset.full; more.remove(); }
      return;
    }
    const open = t.closest?.(".chat-tool-open");
    if (open) { if (open.dataset.path) this.ctx.openFile?.(open.dataset.path); return; }
    const thead = t.closest?.(".chat-tool-head");
    if (thead) {
      const trow = thead.closest(".chat-tool");
      if (trow && trow.dataset.fold === "1") {
        const k = trow.dataset.key;
        if (trow.classList.toggle("open")) this._openTools.add(k); else this._openTools.delete(k);
      }
      return;
    }
    const think = t.closest?.(".chat-thinking");
    if (think && think.dataset.full != null) {
      const full = think.dataset.full || "";
      const collapsed = think.dataset.collapsed === "1";
      think.dataset.collapsed = collapsed ? "0" : "1";
      const body = think.querySelector(".chat-think-body");
      if (body) body.textContent = collapsed ? full : full.slice(0, CHAT.THINKING_CHARS) + (full.length > CHAT.THINKING_CHARS ? "…" : "");
    }
  }

  _flashCopied(btn, text) {
    try { navigator.clipboard?.writeText(text).catch(() => {}); } catch (_) { /* noop */ }
    btn.classList.add("done");
    btn.innerHTML = icons.check({ size: 13 });
    setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = icons.copy({ size: 13 }); }, 1200);
  }

  async _copy(row, btn) {
    if (!row) return;
    let text = row._copyText || "";
    const ent = this.m.msgs.get(row.dataset.key);
    // 잘린 본문은 전문을 받아 복사한다 — 화면에 보이는 앞부분만 복사되면 조용히 틀린 것이 된다.
    if (ent && ent.msg.truncated && this.m.threadId) {
      try { const r = await this._rpc("conv.detail", { threadId: this.m.threadId, key: ent.msg.key }); if (r.text) text = r.text; } catch (_) { /* 보이는 만큼이라도 */ }
    }
    if (text) this._flashCopied(btn, text);
  }

  async _loadFull(key) {
    const ent = this.m.msgs.get(key);
    if (!ent || !this.m.threadId) return;
    const btn = this._rows.get(key)?.el.querySelector(':scope > .chat-trunc [data-act="full"]');
    if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = i18n.t('불러오는 중…'); }
    try {
      const r = await this._rpc("conv.detail", { threadId: this.m.threadId, key });
      if (!r.text || this._disposed) { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = i18n.t('전체 보기'); } return; }
      ent.msg = { ...ent.msg, text: r.text, truncated: false };
      const row = this._rows.get(key);
      if (row) { row.el.querySelector(":scope > .chat-trunc")?.remove(); row.sig = ""; }
      this._render();
    } catch (e) {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = i18n.t('전체 보기'); }
      this._setBanner(convErrorText(e.code), "warn", 4000);
    }
  }

  /**
   * 대화 속 링크를 연다 — http(s) 는 **이 워크스페이스의 브라우저 pane** 으로(외부 브라우저로 내보내지 않는다,
   *  2026-10-05 사용자 확정). ⌘/Ctrl+클릭과 http 가 아닌 것(mailto 등)만 시스템에 맡긴다.
   */
  _openLink(href, e) {
    if (!href) return;
    const ext = () => api.openExternal(href).catch(() => {});
    if ((e && (e.metaKey || e.ctrlKey)) || !opensInBrowserPane(href) || !this.ctx.openUrl) { ext(); return; }
    try { if (!this.ctx.openUrl(href)) ext(); } catch (_) { ext(); }
  }

  /** 대화 속 경로를 IDE(파일 뷰어 포함)로 연다. 앱 안에서 못 여는 것(홈 밖)만 시스템 기본 앱으로. */
  async _openInIde(path) {
    const local = !!this.ctx.isLocal?.();
    let home = "";
    if (local && !this.ctx.vmRoot?.()) { try { home = await homeAbs(); } catch (_) { home = ""; } }
    const rel = this.ctx.vmRoot?.() ? path : homeRelOf(path, { home, cwd: this.ctx.cwd?.() || "" });
    if (rel) { this.ctx.openFile?.(rel); return; }
    if (local) api.openPath(path).catch(() => this._setBanner(i18n.t('파일을 열 수 없어요.'), "warn", 4000));
    else this._setBanner(i18n.t('파일을 열 수 없어요.'), "warn", 4000);
  }

  /**
   * 대화 속 파일을 연다. 이미지는 앱 안 라이트박스로(이 PC 든 다른 PC 든 — 바이트는 _fileBytes), 그 밖은
   *  IDE 로(코드는 에디터, PDF·마크다운 등은 파일 뷰어) — 시스템 기본 앱으로 내보내지 않는다.
   */
  async _openPath(path, name, o) {
    if (!path) return;
    const local = !!this.ctx.isLocal?.();
    const abs = path.startsWith("~") || isAbs(path);
    if (isImagePath(path) && !(o && o.noPreview)) {
      try {
        const r = await this._fileBytes(path);
        if (r && !r.missing && r.base64) {
          this._lightbox(`data:${r.mediaType || mimeOf(path)};base64,${r.base64}`, { name: name || basename(path) || path, path });
          return;
        }
        if (!local) { this._setBanner(fileMissingText(r), "warn", 4000); return; }
      } catch (_) { /* 아래 폴백 */ }
    }
    await this._openInIde(path);
  }

  // ── 헤더 ──
  _syncThread() {
    const th = this.m.thread;
    if (!th) return;
    // 탭 라벨 = 지금 대화의 제목. 대화가 바뀌었거나 제목이 새로 왔으면 맞춘다(옛 제목이 남지 않게 — conv-model.tabPatchFor).
    const patch = tabPatchFor(this.ctx.tab?.() || {}, this.m.threadId, th);
    if (patch) this.ctx.patchTab?.(patch);
    if (th.mode && !this._modeBusy) this._mode = th.mode;
  }

  _syncHead() {
    const label = convModeLabel(this.m.threadId ? (this._mode || "default") : this._newMode);
    const lEl = this.modeEl.querySelector(".chat-mode-label");
    if (lEl.textContent !== label) lEl.textContent = label;
    this.modeEl.classList.toggle("busy", !!this._modeBusy);
    // 에이전트 — 새 대화에서만, 고를 것이 있을 때만.
    const agents = this.m.threadId ? [] : agentChoices(this._caps);
    this.agentEl.classList.toggle("hidden", !agents.length);
    if (agents.length) {
      const cur = agents.find((a) => a.id === this._agentId()) || agents[0];
      const aEl = this.agentEl.querySelector(".chat-mode-label");
      const name = agentDisplayName(cur.id) || cur.label;
      if (aEl.textContent !== name) aEl.textContent = name;
    }
    // 모델 — 데몬이 목록을 줄 때만(없으면 숨긴다 — 추측한 별칭을 내밀지 않는다).
    const models = this._modelChoices();
    this.modelBtn.classList.toggle("hidden", !models.length);
    if (models.length) {
      const on = models.find((m) => m.on);
      const mEl = this.modelBtn.querySelector(".conv-t-label");
      const txt = on ? on.label : i18n.t('기본 모델');
      if (mEl.textContent !== txt) mEl.textContent = txt;
      this.modelBtn.classList.toggle("busy", !!this._modelBusy);
    }
    // 추론 강도 — 그 에이전트의 CLI 가 단계를 알려 줄 때만.
    const efforts = this._effortList();
    this.effortBtn.classList.toggle("hidden", !efforts.length);
    if (efforts.length) {
      const cur = this._effortNow();
      const txt = cur ? effortLabel(cur) : i18n.t('기본값');
      const eEl = this.effortBtn.querySelector(".conv-t-label");
      if (eEl.textContent !== txt) eEl.textContent = txt;
      this.effortBtn.classList.toggle("busy", !!this._modelBusy);
    }
  }

  /** 이 탭의 에이전트 — 대화가 있으면 그 대화의 것, 없으면 새 대화에 쓸 것. */
  _agentId() {
    if (this.m.thread && this.m.thread.agent) return this.m.thread.agent;
    const agents = agentChoices(this._caps);
    return (agents.find((a) => a.id === this._newAgent) || agents[0] || { id: "claude" }).id;
  }

  // ── 사용량 링(도구줄 오른쪽) — 컨텍스트 점유율을 링으로, 눌러서 상세(플랜 한도 포함) ──
  _usageState() {
    const raw = this.m.threadId ? usageStatus(this.m.thread) : null;
    // 원시 모델 ID(`claude-haiku-4-5-…`) 대신 caps 라벨(Haiku) — 모델 버튼과 같은 이름(conv-model.modelLabel).
    return raw && raw.model ? { ...raw, model: modelLabel(raw.model, this._caps, this._agentId()) } : raw;
  }

  _syncUsage() {
    if (!this.ringBtn) return;
    const st = this._usageState();
    const pct = st && st.contextPct != null ? st.contextPct : null;
    const key = JSON.stringify(st);
    if (key === this._usageKey) return;
    this._usageKey = key;
    this.ringBtn.classList.toggle("hidden", !st || (pct == null && !st.limits));
    const fg = this.ringBtn.querySelector(".conv-ring-fg");
    const C = 2 * Math.PI * 7.5;
    if (fg) { fg.style.strokeDasharray = String(C); fg.style.strokeDashoffset = String(C * (1 - (pct || 0) / 100)); }
    this.ringBtn.classList.toggle("warn", pct != null && pct >= 90);
    this.ringBtn.title = pct != null ? i18n.t('컨텍스트 {n}%', { n: pct }) : i18n.t('사용량');
    if (this.usagePopEl) this._paintUsagePop();
  }

  _paintUsagePop() {
    const st = this._usageState();
    const rows = statusDetail(st, Date.now());
    this.usagePopEl.innerHTML = `<div class="chat-mode-head">${i18n.t('사용량')}</div>`
      + (rows.length ? rows.map((r) =>
        `<div class="chat-status-row"><span class="chat-status-k">${escapeHtml(r.label)}</span>`
        + `<span class="chat-status-v">${escapeHtml(r.value)}</span>`
        + (r.sub ? `<span class="chat-status-s">${escapeHtml(r.sub)}</span>` : "") + "</div>").join("")
        : `<div class="chat-pick-empty empty-desc">${i18n.t('아직 표시할 사용량이 없어요')}</div>`);
  }

  _toggleUsagePop() {
    if (this.usagePopEl) { this._closeUsagePop(); return; }
    this._closePopovers();
    const wrap = document.createElement("div");
    wrap.className = "chat-mode-menu conv-pick-menu right conv-usage-pop";
    this.composer.el.appendChild(wrap);
    this.usagePopEl = wrap;
    this._paintUsagePop();
    this._usageCloser = (e) => { if (!wrap.contains(e.target) && !this.ringBtn.contains(e.target)) this._closeUsagePop(); };
    setTimeout(() => { if (this.usagePopEl === wrap) document.addEventListener("mousedown", this._usageCloser, true); }, 0);
  }

  _closeUsagePop() {
    if (this._usageCloser) document.removeEventListener("mousedown", this._usageCloser, true);
    this._usageCloser = null;
    this.usagePopEl?.remove();
    this.usagePopEl = null;
  }

  // ── 모드 ──
  async _loadCaps() {
    if (this._caps || this._capsLoading) return;
    this._capsLoading = true;
    try { this._caps = await this._rpc("conv.caps", {}); } catch (_) { this._caps = null; }
    finally { this._capsLoading = false; }
    if (!this._disposed && this._mounted) { this._syncHead(); this._syncUsage(); this.composer?.sync(); }   // 사용량 줄의 모델 이름도 caps 라벨로
  }

  // ── 에이전트·모델 고르기(§4.5) — 모드 목록과 같은 모양의 작은 메뉴 ──
  _openPick(anchor, rows, onPick, align) {
    this._closePick();
    this._closeUsagePop();
    this._closeEffortPop();
    this.composer?.closePopovers();
    this._closeModeMenu();
    const wrap = document.createElement("div");
    wrap.className = "chat-mode-menu conv-pick-menu" + (align === "right" ? " right" : align === "top" ? " top" : "");
    let n = 0;
    const keyed = [];
    wrap.innerHTML = rows.map((r) => {
      if (r.head) return `<div class="chat-mode-head">${escapeHtml(r.head)}</div>`;
      if (r.sep) return `<div class="chat-mode-sep"></div>`;
      const k = r.kbd === false ? "" : String(++n);
      if (k) keyed.push(r);
      return `<div class="chat-mode-row${r.on ? " on" : ""}" data-id="${escapeHtml(r.id)}">`
        + (r.icon ? `<span class="chat-mode-row-icon">${r.icon}</span>` : "")
        + `<span class="chat-mode-row-body"><span class="chat-mode-row-label">${escapeHtml(r.label)}`
        + (r.badge ? `<span class="chat-mode-badge">${escapeHtml(r.badge)}</span>` : "") + `</span>`
        + (r.desc ? `<span class="chat-mode-row-desc">${escapeHtml(r.desc)}</span>` : "") + `</span>`
        + (r.chev ? `<span class="chat-mode-row-kbd">${icons.chevronRight({ size: 13 })}</span>`
          : (r.on ? `<span class="chat-mode-row-mark">${icons.check({ size: 13 })}</span>` : (k ? `<span class="chat-mode-row-kbd">${k}</span>` : ""))) + `</div>`;
    }).join("");
    wrap.addEventListener("click", (e) => {
      const row = e.target.closest?.(".chat-mode-row");
      if (!row) return;
      this._closePick();
      onPick(row.dataset.id);
    });
    // top = 우측 상단 ⋯ 에서 아래로 펼친다 → pane 루트 기준. 그 밖(도구줄 메뉴)은 컴포저 기준(위로 펼침).
    (align === "top" ? this.el : this.composer.el).appendChild(wrap);
    this._pickEl = wrap;
    this._pickCloser = (e) => { if (!wrap.contains(e.target) && !anchor.contains(e.target)) this._closePick(); };
    // 숫자 키 = 그 번호의 항목(Claude 앱 메뉴와 같다). 입력칸에 글자가 들어가지 않게 캡처에서 먹는다.
    this._pickKeys = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._closePick(); this.focus(); return; }
      const i = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
      if (i < 0 || !keyed[i]) return;
      e.preventDefault(); e.stopPropagation();
      const r = keyed[i];
      this._closePick();
      onPick(r.id);
    };
    setTimeout(() => {
      if (this._pickEl !== wrap) return;
      document.addEventListener("mousedown", this._pickCloser, true);
      document.addEventListener("keydown", this._pickKeys, true);
    }, 0);
  }

  _closePick() {
    if (this._pickCloser) document.removeEventListener("mousedown", this._pickCloser, true);
    if (this._pickKeys) document.removeEventListener("keydown", this._pickKeys, true);
    this._pickCloser = null;
    this._pickKeys = null;
    this._pickEl?.remove();
    this._pickEl = null;
  }

  _toggleAgentMenu() {
    if (this._pickEl && this._pickFor === "agent") { this._closePick(); return; }
    const cur = this._agentId();
    const rows = agentChoices(this._caps).map((a) => ({ id: a.id, label: agentDisplayName(a.id) || a.label, on: a.id === cur }));
    if (!rows.length) return;
    this._openPick(this.agentEl, rows, (id) => {
      this._newAgent = id;
      try { localStorage.setItem(AGENT_KEY, id); } catch (_) { /* noop */ }
      this.composer?.resetCommands();
      this._render();
    });
    this._pickFor = "agent";
  }

  _modelChoices() {
    const cur = this.m.threadId ? ((this.m.thread && (this.m.thread.model || (this.m.thread.usage && this.m.thread.usage.model))) || "") : this._newModel;
    return modelChoices(this._caps, this._agentId(), cur);
  }

  _toggleModelMenu() {
    if (this._pickEl && this._pickFor === "model") { this._closePick(); return; }
    const choices = this._modelChoices();
    if (!choices.length) return;
    const { top, more } = modelSplit(choices, this._caps, this._agentId());
    const rows = top.map((m) => ({ id: m.id, label: m.label, on: m.on, badge: m.badge }));
    // 이전 버전은 "더 많은 모델" 로(Claude 앱과 같다) — 눌러 목록을 바꿔 그린다.
    if (more.length) { rows.push({ sep: true }); rows.push({ id: "more", label: i18n.t('더 많은 모델'), chev: true, kbd: false }); }
    const pick = (id) => {
      if (id === "more") {
        const rows2 = [{ id: "back", label: i18n.t('뒤로'), icon: icons.chevronLeft({ size: 14 }), kbd: false }, { sep: true },
          ...more.map((m) => ({ id: m.id, label: m.label, on: m.on, kbd: false }))];
        this._openPick(this.modelBtn, rows2, (id2) => { if (id2 === "back") this._toggleModelMenu(); else void this._pickModel(id2); }, "right");
        this._pickFor = "model";
        return;
      }
      void this._pickModel(id);
    };
    this._openPick(this.modelBtn, rows, pick, "right");
    this._pickFor = "model";
  }

  // ── 추론 강도 — 슬라이더 팝업(노력: 더 빠르게 ↔ 더 스마트하게) ──
  _effortList() {
    const ag = (this._caps && this._caps.agents || []).find((a) => a.id === this._agentId());
    return ag && Array.isArray(ag.efforts) ? ag.efforts : [];
  }

  _toggleEffortPop() {
    if (this.effortPopEl) { this._closeEffortPop(); return; }
    const list = this._effortList();
    if (!list.length) return;
    this._closePopovers();
    const ag = (this._caps && this._caps.agents || []).find((a) => a.id === this._agentId()) || {};
    const cur = this._effortNow() || ag.defaultEffort || "";
    const idx = Math.max(0, list.indexOf(cur));
    const wrap = document.createElement("div");
    wrap.className = "chat-mode-menu conv-pick-menu right conv-eff-pop";
    wrap.innerHTML = `<div class="conv-eff-head"><span class="conv-eff-k">${i18n.t('노력')}</span><span class="conv-eff-v"></span></div>`
      + `<div class="conv-eff-ends"><span>${i18n.t('더 빠르게')}</span><span>${i18n.t('더 스마트하게')}</span></div>`
      + `<input class="conv-eff-range" type="range" min="0" max="${list.length - 1}" step="1" value="${idx}" />`
      + `<button class="conv-eff-reset" type="button">${ag.defaultEffort ? i18n.t('기본값 ({name})', { name: effortLabel(ag.defaultEffort) }) : i18n.t('기본값')}</button>`;
    this.composer.el.appendChild(wrap);
    this.effortPopEl = wrap;
    const range = wrap.querySelector(".conv-eff-range");
    const val = wrap.querySelector(".conv-eff-v");
    const paint = () => { val.textContent = effortLabel(list[Number(range.value)]); };
    paint();
    range.addEventListener("input", paint);
    range.addEventListener("change", () => void this._pickEffort(list[Number(range.value)]));
    wrap.querySelector(".conv-eff-reset").addEventListener("click", () => { this._closeEffortPop(); void this._pickEffort(""); });
    this._effortCloser = (e) => { if (!wrap.contains(e.target) && !this.effortBtn.contains(e.target)) this._closeEffortPop(); };
    setTimeout(() => { if (this.effortPopEl === wrap) document.addEventListener("mousedown", this._effortCloser, true); }, 0);
  }

  _closeEffortPop() {
    if (this._effortCloser) document.removeEventListener("mousedown", this._effortCloser, true);
    this._effortCloser = null;
    this.effortPopEl?.remove();
    this.effortPopEl = null;
  }

  // ── 더 보기 — 헤더에 있던 기능(새 대화·대화 목록·터미널에서 이어가기)의 새 집 ──
  _toggleMoreMenu() {
    if (this._pickEl && this._pickFor === "more") { this._closePick(); return; }
    const rows = [
      { id: "new", label: i18n.t('새 대화'), icon: icons.edit({ size: 15 }), kbd: false },
      { id: "list", label: i18n.t('대화 목록'), icon: icons.history({ size: 15 }), kbd: false },
    ];
    // 터미널로 넘기기는 이 PC 의 대화만 — 다른 PC 에 터미널을 만드는 길이 PC 앱에는 없다.
    if (this.m.threadId && this.ctx.isLocal?.() && this.ctx.openTerminal) {
      rows.push({ id: "term", label: i18n.t('터미널에서 이어가기'), icon: icons.terminal({ size: 15 }), kbd: false });
    }
    this._openPick(this.moreBtn, rows, (id) => {
      if (id === "new") this.newThread();
      else if (id === "list") this._toggleList();
      else if (id === "term") void this._toTerminal();
    }, "top");
    this._pickFor = "more";
  }

  _effortNow() { return this.m.threadId ? ((this.m.thread && this.m.thread.effort) || "") : this._newEffort; }

  async _pickEffort(level) {
    if (this._modelBusy) return;
    if (!this.m.threadId) { this._newEffort = level; this._syncHead(); return; }
    const prev = (this.m.thread && this.m.thread.effort) || "";
    if (prev === level) return;
    this._modelBusy = true;
    this.m.thread = { ...(this.m.thread || {}), effort: level };
    this._syncHead();
    try {
      const r = await this._rpc("conv.set", { threadId: this.m.threadId, effort: level });
      if (r.thread) applyThreadHint(this.m, r.thread);
      void this._catchUp();
    } catch (e) {
      this.m.thread = { ...(this.m.thread || {}), effort: prev };
      this._setBanner(e.code === "CONTROL_TIMEOUT" || e.code === "CONTROL_FAILED" ? convErrorText(e.code)
        : i18n.t('추론 강도를 바꾸지 못했어요 — 잠시 후 다시 시도해 주세요.'), "warn", 4000);
    } finally {
      this._modelBusy = false;
      this._syncHead();
    }
  }

  async _pickModel(id) {
    if (!id || this._modelBusy) return;
    if (!this.m.threadId) { this._newModel = id; this._syncHead(); return; }
    const prev = this.m.thread ? this.m.thread.model : null;
    if (prev === id) return;
    this._modelBusy = true;
    this.m.thread = { ...(this.m.thread || {}), model: id };
    this._syncHead();
    try {
      const r = await this._rpc("conv.set", { threadId: this.m.threadId, model: id });
      if (r.thread) applyThreadHint(this.m, r.thread);
      void this._catchUp();   // "다음 시작부터 적용" 안내(MODEL_NEXT_START)가 로그로 온다
    } catch (e) {
      this.m.thread = { ...(this.m.thread || {}), model: prev };
      this._setBanner(e.code === "CONTROL_TIMEOUT" || e.code === "CONTROL_FAILED" ? convErrorText(e.code)
        : i18n.t('모델을 바꾸지 못했어요 — 잠시 후 다시 시도해 주세요.'), "warn", 4000);
    } finally {
      this._modelBusy = false;
      this._syncHead();
    }
  }

  // ── 대화 안 검색(⌘F, §4.5 — 클라 전용) ──
  //  불러온 행 안에서만 찾는다. 접힌 묶음·도구 결과 속 일치는 펼쳐서 보이게 한 뒤 화면 글자에서 찾는다
  //  (보이지 않는 글을 "찾았다"고 세지 않는다). 강조는 CSS Custom Highlight — DOM 을 건드리지 않아
  //  스트리밍 중에도 행 재사용·선택이 깨지지 않는다. 더 앞은 "이전 내역 더 불러오기"로 넓힌다.
  openSearch() {
    if (!this._mounted) return;
    if (this.findEl) { this.findInput.focus(); this.findInput.select(); return; }
    const bar = document.createElement("div");
    bar.className = "pane-search conv-find";
    bar.innerHTML = `
      <span class="pane-search-ic">${icons.search({ size: 13 })}</span>
      <input class="pane-search-input" type="text" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off" placeholder="${i18n.t('대화에서 찾기')}" />
      <span class="pane-search-count">0/0</span>
      <button class="pane-search-btn" type="button" data-a="prev" title="${i18n.t('이전 (⇧Enter)')}">${icons.chevronUp({ size: 14 })}</button>
      <button class="pane-search-btn" type="button" data-a="next" title="${i18n.t('다음 (Enter)')}">${icons.chevronDown({ size: 14 })}</button>
      <button class="pane-search-btn" type="button" data-a="close" title="${i18n.t('닫기 (Esc)')}">${icons.x({ size: 14 })}</button>
      <button class="conv-link conv-find-more hidden" type="button" data-a="more">${i18n.t('이전 내역 더 불러오기')}</button>`;
    this.host.appendChild(bar);
    this.findEl = bar;
    this.findInput = bar.querySelector(".pane-search-input");
    this.findCount = bar.querySelector(".pane-search-count");
    this.findMore = bar.querySelector(".conv-find-more");
    this._find = { q: "", hits: [], cur: -1 };
    this.findInput.addEventListener("input", () => { this._find.cur = -1; this._runFind(); this._stepFind(0); });
    this.findInput.addEventListener("keydown", (e) => {
      e.stopPropagation();   // 전역 단축키·뷰의 Esc(중단)가 이 입력을 가로채지 않게
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); this._stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeSearch(); }
    });
    bar.addEventListener("click", (e) => {
      const a = e.target.closest?.("[data-a]")?.dataset.a;
      if (a === "prev") { this._stepFind(-1); this.findInput.focus(); }
      else if (a === "next") { this._stepFind(1); this.findInput.focus(); }
      else if (a === "close") this.closeSearch();
      else if (a === "more") void this._findMoreBefore();
    });
    this._syncFindMore();
    setTimeout(() => { this.findInput?.focus(); this.findInput?.select(); }, 0);
  }

  closeSearch() {
    if (!this.findEl) return;
    clearTimeout(this._findTimer);
    this.findEl.remove();
    this.findEl = null; this.findInput = null; this.findCount = null; this.findMore = null;
    this._find = null;
    this._paintFind();
    this.composer?.focus();
  }

  async _findMoreBefore() {
    if (!this.findMore || this._loadingBefore) return;
    this.findMore.disabled = true;
    await this._loadBefore();
    if (this.findMore) this.findMore.disabled = false;
    this._runFind();
    this._syncFindMore();
  }

  _syncFindMore() {
    if (!this.findMore) return;
    const more = this._opened && !this.m.noMoreBefore && this.m.floorSeq > 1;
    this.findMore.classList.toggle("hidden", !more);
  }

  _queueFind() {
    clearTimeout(this._findTimer);
    this._findTimer = setTimeout(() => { if (this._find) { this._runFind(); this._syncFindMore(); } }, 150);
  }

  /** 지금 검색어로 일치 범위를 다시 모은다(현재 위치는 가능한 한 유지). */
  _runFind() {
    if (!this._find || !this.findInput) return;
    const q = this.findInput.value;
    this._find.q = q;
    if (!q.trim()) { this._find.hits = []; this._find.cur = -1; this._paintFind(); return; }
    // 접힌 묶음·도구 결과에 있는 일치는 펼친다 — 화면에 없는 글은 찾을 수 없다.
    const ex = searchExpand(buildRows(this.m, { openGroups: this._openGroups, openTools: this._openTools }), q);
    let grew = false;
    for (const g of ex.groups) if (!this._openGroups.has(g)) { this._openGroups.add(g); grew = true; }
    for (const k of ex.tools) if (!this._openTools.has(k)) { this._openTools.add(k); grew = true; this._rows.get(k)?.el.classList.add("open"); }
    if (grew) { const f = this._find; this._find = null; this._renderNow(); this._find = f; }
    // 접힌 '생각' 은 전문을 펼친다(일치가 잘린 뒤쪽에 있을 수 있다).
    const needle = q.toLowerCase();
    for (const th of this.rowsEl.querySelectorAll('.chat-thinking[data-collapsed="1"]')) {
      if (String(th.dataset.full || "").toLowerCase().includes(needle)) {
        th.dataset.collapsed = "0";
        const b = th.querySelector(".chat-think-body");
        if (b) b.textContent = th.dataset.full || "";
      }
    }
    const prevKey = this._find.hits[this._find.cur] ? this._find.hits[this._find.cur].key : null;
    const prevIdx = this._find.hits[this._find.cur] ? this._find.hits[this._find.cur].n : 0;
    const hits = [];
    const vis = new Map();
    const shown = (el) => {
      if (!el) return false;
      if (vis.has(el)) return vis.get(el);
      const v = el.getClientRects().length > 0;
      vis.set(el, v);
      return v;
    };
    const walker = document.createTreeWalker(this.rowsEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest("button, .conv-acts, .conv-caret, .chat-working")) return NodeFilter.FILTER_REJECT;
        return shown(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const perRow = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.data.toLowerCase();
      let i = text.indexOf(needle);
      if (i < 0) continue;
      const rowEl = n.parentElement.closest("[data-key]");
      const key = rowEl ? rowEl.dataset.key : "";
      while (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        const c = perRow.get(key) || 0;
        perRow.set(key, c + 1);
        hits.push({ range: r, key, n: c });
        i = text.indexOf(needle, i + needle.length);
      }
    }
    this._find.hits = hits;
    // 같은 행의 같은 번째 일치가 남아 있으면 그 자리를 유지한다(새 글이 와도 커서가 튀지 않게).
    let cur = prevKey != null ? hits.findIndex((h) => h.key === prevKey && h.n === prevIdx) : -1;
    if (cur < 0 && this._find.cur >= 0 && hits.length) cur = Math.min(this._find.cur, hits.length - 1);
    this._find.cur = cur;
    this._paintFind();
  }

  _stepFind(d) {
    const f = this._find;
    if (!f || !f.hits.length) { this._paintFind(); return; }
    if (f.cur < 0) {
      // 처음 이동 — 아래에서부터(가장 최근 대화가 아래다). 앞으로 가기면 맨 아래, 뒤로면 그 위.
      f.cur = f.hits.length - 1;
    } else if (d) f.cur = (f.cur + d + f.hits.length) % f.hits.length;
    this._paintFind();
    const r = f.hits[f.cur] && f.hits[f.cur].range;
    if (!r) return;
    const box = r.getBoundingClientRect();
    const sb = this.scrollEl.getBoundingClientRect();
    if (box.top < sb.top + 40 || box.bottom > sb.bottom - 40) {
      this._follow = false;
      this.scrollEl.scrollTop += (box.top - sb.top) - sb.height / 2;
      this._lastTop = this.scrollEl.scrollTop;
      this._syncJump();
    }
  }

  _paintFind() {
    const f = this._find;
    if (this.findCount) this.findCount.textContent = f && f.hits.length ? `${f.cur >= 0 ? f.cur + 1 : 0}/${f.hits.length}` : "0/0";
    const H = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined" ? CSS.highlights : null;
    if (!H) return;   // 강조를 못 그리는 웹뷰 — 이동·건수는 그대로 된다
    if (!f || !f.hits.length) {
      if (_findOwner === this || !_findOwner) { H.delete("conv-find"); H.delete("conv-find-cur"); _findOwner = null; }
      return;
    }
    _findOwner = this;
    H.set("conv-find", new Highlight(...f.hits.map((h) => h.range)));
    const cur = f.hits[f.cur];
    if (cur) H.set("conv-find-cur", new Highlight(cur.range)); else H.delete("conv-find-cur");
  }

  // 데몬이 알려 준 것만(모르면 카탈로그 그대로). 지금 모드는 목록에 없어도 남긴다(conv-model.convModeChoices).
  _modeChoices() {
    const cur = this.m.threadId ? (this._mode || "default") : this._newMode;
    return convModeChoices(cur, this._caps && this._caps.modes);
  }

  _toggleModeMenu() {
    if (this._pickEl && this._pickFor === "mode") { this._closePick(); return; }
    // 설명 한 줄은 v1 카탈로그의 것을 빌린다(같은 모드의 같은 설명 — 이름만 채팅에 맞게 다르다).
    const rows = [{ head: i18n.t('모드') }, ...this._modeChoices().map((m) => {
      const cat = agentModeOf(m.id);
      return { id: m.id, label: m.label, on: m.on, desc: cat && cat.desc ? i18n.t(cat.desc) : "" };
    })];
    this._openPick(this.modeEl, rows, (id) => void this._pickMode(id));
    this._pickFor = "mode";
  }

  _closeModeMenu() {
    if (this._modeCloser) document.removeEventListener("mousedown", this._modeCloser, true);
    this._modeCloser = null;
    this.modeMenuEl?.remove();
    this.modeMenuEl = null;
  }

  async _pickMode(id) {
    this._closeModeMenu();
    if (!id || this._modeBusy) return;
    if (!this.m.threadId) {
      // 아직 대화가 없다 — 첫 메시지(conv.create)에 실려 간다.
      this._newMode = id;
      try { localStorage.setItem(MODE_KEY, id); } catch (_) { /* noop */ }
      this._syncHead();
      return;
    }
    if (this._mode === id) return;
    const prev = this._mode;
    // 누른 즉시 알약을 바꾼다. 실패하면 되돌리고 이유를 말한다(바뀌지 않았는데 바뀐 것처럼 보이면 안 된다).
    this._modeBusy = true;
    this._mode = id;
    this._syncHead();
    try {
      const r = await this._rpc("conv.set", { threadId: this.m.threadId, mode: id });
      if (r.thread) applyThreadHint(this.m, r.thread);
      this._mode = (r.thread && r.thread.mode) || id;
      try { localStorage.setItem(MODE_KEY, this._mode); } catch (_) { /* noop */ }
    } catch (e) {
      this._mode = prev;
      // 에이전트가 답하지 않았는지(CONTROL_TIMEOUT) 거절했는지(CONTROL_FAILED)는 다른 일이다 — code 로 말한다.
      this._setBanner(e.code === "CONTROL_TIMEOUT" || e.code === "CONTROL_FAILED" ? convErrorText(e.code)
        : i18n.t('모드를 바꾸지 못했어요 — 잠시 후 다시 시도해 주세요.'), "warn", 4000);
    } finally {
      this._modeBusy = false;
      this._syncHead();
    }
  }

  // ── 터미널과 주고받기(§6) ──
  async _toTerminal() {
    if (!this.m.threadId || this._handing) return;
    if (isBusy(this.m)) { this._setBanner(i18n.t('작업이 끝난 뒤에 할 수 있어요.'), "info", 4000); return; }
    this._handing = true;
    try {
      const r = await this._rpc("conv.toTerminal", { threadId: this.m.threadId });
      // owner 는 데몬이 정한다('none' → 터미널에 훅이 걸리면 'terminal'). 여기서 짐작해 적지 않는다.
      this.ctx.openTerminal?.(terminalLaunch(r, this.m.thread && this.m.thread.agent));
      void this._catchUp();
      this._render();
    } catch (e) {
      this._setBanner(e.code === "THREAD_BUSY" ? i18n.t('작업이 끝난 뒤에 할 수 있어요.') : convErrorText(e.code), "warn", 4000);
    } finally {
      this._handing = false;
    }
  }

  async _adoptCurrent() {
    const th = this.m.thread;
    if (!th || this._adopting) return;
    this._adopting = true;
    this._syncConn();
    try {
      const r = await this._rpc("conv.adopt", { cwd: th.cwd || this.ctx.cwd?.() || "", tid: th.ownerTid });
      if (r.thread) applyThreadHint(this.m, r.thread);
      this._opened = false;
      await this._open();
    } catch (e) {
      this._setBanner(adoptErrorText(e.code), "warn", 5000);
    } finally {
      this._adopting = false;
      this._syncConn();
    }
  }

  // ── 연결 상태 줄 ──
  _setOffline(on) {
    if (this._offline === !!on) return;
    this._offline = !!on;
    this._syncConn();
  }

  _syncConn() {
    if (!this.connEl) return;
    let html = "";
    let tone = "";
    if (this.ctx.hostOffline?.() || this._offline) {
      html = escapeHtml(i18n.t('PC가 꺼져 있거나 연결이 끊겼어요. 켜지면 이어서 받아 와요.')); tone = "warn";
    } else if (!_channelUp && Date.now() - _channelDownAt > 2000) {
      html = escapeHtml(i18n.t('다시 연결하는 중…')); tone = "info";
    } else if (this.m.thread && needsAdopt(this.m.thread)) {
      html = `<span>${escapeHtml(i18n.t('터미널에서 사용 중'))}</span>`
        + `<button class="conv-link" type="button" data-act="adopt"${this._adopting ? " disabled" : ""}>${i18n.t('채팅으로 가져오기')}</button>`;
      tone = "info";
    }
    const key = tone + "|" + html;
    if (key === this._connKey) return;
    this._connKey = key;
    this.connEl.innerHTML = html;
    this.connEl.className = "conv-conn" + (html ? " " + tone : " hidden");
  }

  _setBanner(msg, tone, ttl) {
    if (!this.bannerEl) return;
    clearTimeout(this._bannerTimer);
    this.bannerEl.className = "chat-banner" + (msg ? " " + (tone || "info") : " hidden");
    this.bannerEl.textContent = msg || "";
    if (msg && ttl) this._bannerTimer = setTimeout(() => this._setBanner(""), ttl);
  }

  // ── 대화 목록(§10.6) ──
  _toggleList() {
    if (this.listEl) { this._closeList(); return; }
    this._closePopovers();
    const pop = document.createElement("div");
    pop.className = "conv-pop";
    pop.innerHTML = `<div class="conv-pop-head">${i18n.t('대화 목록')}</div><div class="conv-pop-list"><div class="chat-pick-empty empty-desc">${i18n.t('불러오는 중…')}</div></div>`;
    this.el.appendChild(pop);
    this.listEl = pop;
    this._threads = null;
    pop.addEventListener("click", (e) => void this._onListClick(e));
    this._listCloser = (e) => { if (!pop.contains(e.target) && !this.listBtn.contains(e.target)) this._closeList(); };
    setTimeout(() => { if (this.listEl === pop) document.addEventListener("mousedown", this._listCloser, true); }, 0);
    void this._loadList();
  }

  _closeList() {
    if (this._listCloser) document.removeEventListener("mousedown", this._listCloser, true);
    this._listCloser = null;
    this.listEl?.remove();
    this.listEl = null;
  }

  async _loadList() {
    const pop = this.listEl;
    try {
      const r = await this._rpc("conv.list", { cwd: this.ctx.cwd?.() || "", limit: 100, includeExternal: true });
      if (this.listEl !== pop) return;
      this._threads = Array.isArray(r.threads) ? r.threads.slice() : [];
      this._renderList();
    } catch (e) {
      if (this.listEl !== pop) return;
      pop.querySelector(".conv-pop-list").innerHTML = `<div class="chat-pick-empty empty-desc">${escapeHtml(isOfflineCode(e.code) ? i18n.t('PC 가 연결돼 있지 않습니다.') : i18n.t('목록을 불러오지 못했습니다'))}</div>`;
    }
  }

  _noteListThread(t) {
    if (!this._threads || !t || !t.id) return;
    const i = this._threads.findIndex((x) => x.id === t.id);
    if (i >= 0) this._threads[i] = { ...this._threads[i], ...t };
    else this._threads.unshift(t);
    this._threads.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    this._renderList();
  }

  _renderList() {
    if (!this.listEl || !this._threads) return;
    const list = this.listEl.querySelector(".conv-pop-list");
    if (!this._threads.length) { list.innerHTML = `<div class="chat-pick-empty empty-desc">${i18n.t('아직 대화가 없어요')}</div>`; return; }
    const now = Date.now();
    list.innerHTML = this._threads.map((t) => {
      const dot = threadDot(t);
      const cur = t.id === this.m.threadId;
      const confirm = this._confirmDel === t.id;
      const dotTitle = dot === "attention" ? i18n.t('조치 필요') : dot === "working" ? i18n.t('작업 중') : dot === "error" ? i18n.t('오류') : "";
      return `<div class="conv-li${cur ? " on" : ""}" data-id="${escapeHtml(t.id)}">` +
        `<div class="conv-li-top">` +
          (dot ? `<span class="conv-dot ${dot}" title="${escapeHtml(dotTitle)}"></span>` : "") +
          `<span class="conv-li-title">${escapeHtml(threadTitle(t))}</span>` +
          (t.external || needsAdopt(t) ? `<span class="conv-li-badge">${i18n.t('터미널')}</span>` : "") +
          `<span class="conv-li-time">${escapeHtml(fmtAgo(t.lastAt, now))}</span>` +
        `</div>` +
        (t.preview ? `<div class="conv-li-prev">${escapeHtml(String(t.preview))}</div>` : "") +
        (confirm
          ? `<div class="conv-li-acts"><span class="conv-note">${i18n.t('이 대화를 지울까요? 되돌릴 수 없어요.')}</span>` +
            `<button class="conv-link danger" type="button" data-act="del-yes">${i18n.t('삭제')}</button>` +
            `<button class="conv-link" type="button" data-act="del-no">${i18n.t('취소')}</button></div>`
          : `<div class="conv-li-acts">` +
            (needsAdopt(t) ? `<button class="conv-link" type="button" data-act="adopt">${i18n.t('채팅으로 가져오기')}</button>` : "") +
            (t.external ? "" : `<button class="conv-li-del" type="button" data-act="del" title="${i18n.t('삭제')}">${icons.trash({ size: 13 })}</button>`) +
            `</div>`) +
        `</div>`;
    }).join("");
  }

  async _onListClick(e) {
    const li = e.target.closest?.(".conv-li");
    if (!li) return;
    const id = li.dataset.id;
    const t = (this._threads || []).find((x) => x.id === id);
    if (!t) return;
    const act = e.target.closest?.("[data-act]")?.dataset.act;
    if (act === "del") { this._confirmDel = id; this._renderList(); return; }
    if (act === "del-no") { this._confirmDel = null; this._renderList(); return; }
    if (act === "del-yes") {
      this._confirmDel = null;
      try {
        await this._rpc("conv.remove", { threadId: id });
        this._threads = (this._threads || []).filter((x) => x.id !== id);
        this._renderList();
        if (id === this.m.threadId) this.newThread();
      } catch (err) {
        this._renderList();
        this._setBanner(convErrorText(err.code), "warn", 4000);
      }
      return;
    }
    if (act === "adopt") {
      li.classList.add("busy");
      try {
        const r = await this._rpc("conv.adopt", { cwd: t.cwd || this.ctx.cwd?.() || "", tid: t.ownerTid });
        this._pickThread((r.thread && r.thread.id) || id, (r.thread && r.thread.title) || t.title);
      } catch (err) {
        li.classList.remove("busy");
        this._setBanner(adoptErrorText(err.code), "warn", 5000);
      }
      return;
    }
    // 터미널이 쓰고 있는 대화는 그냥 열 수 없다(소유자는 항상 1명) — 먼저 가져와야 한다.
    if (needsAdopt(t)) return;
    this._pickThread(id, t.title);
  }

  _pickThread(id, title) {
    this._closeList();
    if (id === this.m.threadId) return;
    // 같은 대화가 다른 탭에 이미 열려 있으면 그 탭으로 간다(한 화면에 같은 대화 둘을 만들지 않는다).
    if (this.ctx.focusThread?.(id)) return;
    this.openThread(id, title || "");
  }

  _closePopovers() {
    const any = !!(this.listEl || this.modeMenuEl || this._pickEl || this.usagePopEl || this.effortPopEl || this.composer?.hasPopover());
    this._closeList();
    this._closeModeMenu();
    this._closePick();
    this._closeUsagePop();
    this._closeEffortPop();
    this.composer?.closePopovers();
    return any;
  }

  // ── 스크롤 ──
  _atBottom() {
    const s = this.scrollEl;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < CONV.AT_BOTTOM_PX;
  }
  _toBottom() {
    // 애니메이션 없음 — 글자가 오는 동안 부드러운 스크롤은 매번 튄다.
    if (!this.scrollEl) return;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this._lastTop = this.scrollEl.scrollTop;
  }
  _syncJump() {
    if (this.jumpEl) this.jumpEl.classList.toggle("hidden", this._follow || this._atBottom());
  }

  dispose() {
    this._disposed = true;
    this._stopTick();
    clearTimeout(this._bannerTimer);
    clearTimeout(this._behindTimer);
    clearTimeout(this._findTimer);
    if (this.findEl) { this.findEl.remove(); this.findEl = null; this._find = null; this._paintFind(); }
    if (this._raf) { (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(this._raf); this._raf = 0; }
    this._closePopovers();
    try { this._ro?.disconnect(); } catch (_) { /* noop */ }
    try { this._mediaObs?.disconnect(); } catch (_) { /* noop */ }
    if (this._onWinFocus) window.removeEventListener("focus", this._onWinFocus);
    if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
    this.composer?.dispose();
    _live.delete(this);
    // ⚠ conv.stop 을 부르지 않는다. 탭을 닫아도 대화는 남고(§10.7), 같은 대화를 다른 기기가 보고 있을 수 있다.
    //  프로세스는 데몬이 10분 유휴로 스스로 내린다(§5).
    this.el?.remove();
  }
}

/** conv.adopt 실패 안내 — 터미널 탭의 "채팅으로 이어가기"와 목록의 "가져오기"가 같은 말을 한다. */
export function adoptErrorText(code) {
  switch (String(code || "")) {
    case "THREAD_BUSY_IN_TERMINAL": return i18n.t('에이전트가 아직 작업 중이에요');
    case "THREAD_NOT_FOUND": return i18n.t('이 터미널에서 이어갈 대화를 찾지 못했어요');
    default: return convErrorText(code);
  }
}
