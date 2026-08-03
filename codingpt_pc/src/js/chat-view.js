// chat-view.js — 터미널 탭의 Chat 모드 본문(Claude 앱 스타일 말풍선 대화 UI).
//
// 레이어 규율(재발 방지 정본):
//  · 이 뷰는 터미널을 **대체하지 않는다**. pane.js 가 `.pane-term` 을 `display:none` 으로 가리고
//    `.pane-chat` 을 보이게만 한다(혼합 탭 IDE/프리뷰와 완전히 동일한 경로). 터미널 xterm/스트림은
//    살아 있으므로 재연결 카운터가 소진되지 않고 복귀 시 즉시 화면이 있다.
//  · 여기서 절대 하지 않는 것: `_fitNow`/`ptyResize`/`ptyClaim`/`ptyClose`. Chat 모드는 터미널을
//    "보고 있지 않다" = 크기 주장 자격이 없다(놀고 있는 기기가 사용 중 기기 크기를 뺏던 버그).
//  · 컴포저는 pane 의 xterm textarea 가 아니므로 pane.js `_setupInput` 의 document 캡처 핸들러가
//    `e.target !== ta` 로 즉시 반환한다 → 채팅 타이핑/스크롤이 pty 로 새지 않는다(구조적 보장).
//
// 데이터: 데몬 트랜스크립트 리더(runner-core/transcript.js)의 back 프록시.
//  진입/재타깃 = POST /chat/open → 스냅샷. 라이브 = ui-channel WS `chat_event` push(applyChatEvent).
//  캐치업/유실보정 = GET /chat/since(sinceSeq 워터마크). push 가 안 오면 폴링이 대신 따라잡는다.
//  전송 = POST /chat/input(데몬이 그 tmux 세션에 bracketed paste + 지연 Enter). 실패 시 로컬 PTY 폴백.
import { api } from "./api.js";
import { state as appState, agentStateOf } from "./state.js";
import { icons, agentMarkHtml } from "./icons.js";
import { renderMarkdown, escapeHtml } from "./chat-md.js";
import { ansiToHtml } from "./ansi.js";
import { termTheme } from "./theme.js";
import {
  CHAT, isVisible, isResult, toolLabel, resultMark, resultClass, resultMeta,
  mergeMsgs, lastSeqOf, clampLines, optimisticKey, dropMatchedOptimistic, fmtBytes,
  relToRoot, filterFiles, flattenFiles, shouldReopenNoSession,
  composerHasText, agentDisplayName, agentModeView, agentModeChoices, agentModeIsOn,
  agentModeOf, agentModeLabel, patchLines, slashQuery, filterCommands, commandBadges,
  TOOL_GROUP_MIN, toolRunLabel,
} from "./chat-model.js";

// 살아있는 뷰 레지스트리 — WS push 를 chatId 로 배달하고, 승인 카드가 "이 화면이 이미 그 터미널을
//  보여주고 있는가"를 판정하는 데 쓴다(전역 카드 스택과 중복 표시 방지).
const _live = new Set();

// ui-channel 이 호출: {type:'chat_event', chatId, sessionId, epoch, headSeq, messages, control}
//  back(fanoutChatEvent)은 데몬 프레임을 해석 없이 중계하되 `epochChanged` 는 빠뜨리므로
//  epoch 리셋 판정은 control.kind==='epoch_reset' 과 epoch 문자열 비교 양쪽으로 한다.
export function applyChatEvent(frame) {
  if (!frame || !frame.chatId) return;
  for (const v of _live) {
    if (v._chatId === frame.chatId) { v._onPush(frame); continue; }
    // ★ 아직 대화가 없는(noSession) 뷰는 chatId 가 null 이라 위 조건으로 **절대** 매칭되지 않는다.
    //   훅이 알려준 sessionId(reason='not_started' 에 실려 온다)가 같으면 "이 터미널의 대화가 방금
    //   시작됐다"는 신호다 → 재오픈 트리거(②). 이 줄이 없으면 그 트리거는 도달 불가 죽은 코드가 된다.
    if (!v._chatId && v._noSession && frame.sessionId && v._sessionId === frame.sessionId) v._onPush(frame);
  }
}

// 셸 안전 작은따옴표 감싸기 — os-drop.shq 와 동일 규칙(순환 import 회피용 사본).
function shq(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }

// 승인 카드 슬롯 갱신 요청 — approvals.js 가 렌더 콜백을 주입한다(순환 import 회피).
let _approvalRenderer = null;
export function setChatApprovalRenderer(fn) { _approvalRenderer = typeof fn === "function" ? fn : null; }
export function refreshChatApprovals() { for (const v of _live) v._renderApprovals(); }

export class ChatView {
  // host: `.pane-chat` 컨테이너(pane.js 가 소유·display 토글). ctx: pane 이 주는 라이브 getter 묶음.
  constructor(host, ctx) {
    this.host = host;
    this.ctx = ctx;
    this._visible = false;
    this._disposed = false;
    this._msgs = [];
    this._els = new Map();      // seq → 메시지 DOM
    this._toolCards = new Map(); // tool_use id → { resultEl }
    this._maxSeq = 0;
    this._chatId = null;
    this._epoch = "";
    this._lastSeq = 0;
    this._tid = null;
    this._opening = null;
    this._openFailed = null;
    this._lastPushAt = 0;
    this._pending = [];         // 낙관적 user 버블 [{key, at, seq}]
    this._optSeq = -1;
    this._unread = 0;
    this._truncated = false;
    // noSession(대화가 아직 없다) — 오류가 아니라 **확정된 상태**. 값은 reason 문자열이거나 null.
    //  이 플래그가 서 있으면 `_tick` 의 기본 재오픈을 건너뛴다(4초마다 chat.open 폭주 방지).
    this._noSession = null;
    this._noSessionAt = 0;
    this._probeUntil = 0;   // 첫 메시지 전송 직후의 짧은 탐색 창(훅이 바인딩을 만드는 순간을 잡는다)
    // 드롭 첨부 [{path,name,ext,img,b64}] — 입력칸 안 **원자 칩**(contenteditable=false)으로 산다.
    //  TUI 반영은 전송 시 한 번(칩→인용 경로 직렬화, 데몬이 경로 조각 paste 로 [Image #N] 변환).
    this._attach = [];
    this._attCache = new Map(); // 트랜스크립트 첨부(chatId:seq:idx → Promise) — 메시지 칩 썸네일/미리보기 공용
    // 에이전트 권한 모드({id,label,symbol}) — chat.open 응답 + status_line push 로 갱신, 알약이 그린다.
    this._mode = null;
    this._modeBusy = false;   // 전환 요청 진행 중(중복 클릭·역주행 방지)
    _live.add(this);
  }

  _cwd() { return this.ctx.cwd() || ""; }

  // ── DOM ──
  mount() {
    if (this._mounted) return;
    this._mounted = true;
    const el = document.createElement("div");
    el.className = "chat";
    el.innerHTML = `
      <div class="chat-banner hidden"></div>
      <div class="chat-scroll"></div>
      <div class="chat-approvals"></div>
      <div class="chat-tuidlg hidden"></div>
      <div class="chat-statusline hidden"></div>
      <div class="chat-composer">
        <button class="chat-jump hidden" type="button" title="맨 아래로">${icons.arrowDown({ size: 15 })}<span class="chat-jump-n"></span></button>
        <div class="chat-box">
          <div class="chat-input chat-ce" contenteditable="true" role="textbox" aria-multiline="true" data-ph="메시지 보내기"></div>
          <div class="chat-ctl">
            <button class="chat-plus" type="button" title="파일 넣기">${icons.plus({ size: 18 })}</button>
            <button class="chat-mode hidden" type="button" title="에이전트 모드 (TUI 의 shift+tab)">
              <span class="chat-mode-label"></span><span class="chat-mode-caret">▾</span>
            </button>
            <span class="chat-ctl-gap"></span>
            <button class="chat-send" type="button" title="보내기 (Enter)" disabled>${icons.arrowUp({ size: 17 })}</button>
          </div>
        </div>
      </div>`;
    this.host.appendChild(el);
    this.el = el;
    this.scrollEl = el.querySelector(".chat-scroll");
    this.bannerEl = el.querySelector(".chat-banner");
    this.jumpEl = el.querySelector(".chat-jump");
    this.jumpNEl = el.querySelector(".chat-jump-n");
    this.apprEl = el.querySelector(".chat-approvals");
    this.statusEl = el.querySelector(".chat-statusline");
    this.dlgEl = el.querySelector(".chat-tuidlg");
    // 카드 조작 — 옵션 버튼 = 그 번호 키, ✕ = Esc(둘 다 데몬이 화면을 대조한 뒤에만 친다).
    this.dlgEl.addEventListener("click", (e) => {
      if (e.target.closest(".chat-tuidlg-x")) { void this._pickDialog(0, true); return; }
      const opt = e.target.closest(".chat-tuidlg-opt");
      if (opt) void this._pickDialog(parseInt(opt.dataset.n, 10), false);
    });
    this.inputEl = el.querySelector(".chat-input");
    this.sendEl = el.querySelector(".chat-send");
    this.plusEl = el.querySelector(".chat-plus");
    this.modeEl = el.querySelector(".chat-mode");
    this.modeEl.addEventListener("click", (e) => { e.stopPropagation(); this._toggleModeMenu(); });
    this._setMode(this._mode);

    this.inputEl.textContent = String(this.ctx.getDraft?.() || "");
    this._syncComposer();

    // 따라가기(follow) — 표준 LLM 앱 규칙(2026-07-30 사용자 확정): 맨 아래에 있으면 새 내용마다
    //  자동으로 따라 내려가고, 사용자가 위로 스크롤해 두면 멈춘다(다시 맨 아래로 오면 재개).
    //  스크롤 **이벤트**로만 갱신한다 — 내용이 붙어서 화면이 밀리는 건 사용자의 이탈이 아니다.
    this._follow = true;
    this.scrollEl.addEventListener("scroll", () => {
      this._follow = this._atBottom();
      if (this._follow) { this._unread = 0; this._syncJump(); }
    });
    this.jumpEl.addEventListener("click", () => { this._follow = true; this._scrollToBottom(); this._unread = 0; this._syncJump(); });
    this.sendEl.addEventListener("click", () => this._send());
    this.plusEl.addEventListener("click", (e) => { e.stopPropagation(); this._togglePicker(); });
    // 컴포저 = **로컬 contenteditable**(2026-07-30 사용자 확정: "입력은 네이티브처럼" — 라이브 미러의
    //  키 포워딩은 선택/⌘Z/Shift+방향키 같은 네이티브 편집을 원리적으로 못 살려 폐기했다).
    //  선택·실행취소·커서·IME 전부 브라우저 네이티브. 첨부 칩은 contenteditable=false 라
    //  커서 이동·백스페이스에 **한 덩어리**로 동작한다(TUI 의 [Image #N] 원자성과 동일한 감각).
    //  TUI 전달은 전송 시 한 번 — 데몬이 이미지 경로 조각을 따로 paste 해 [Image #N] 으로 변환한다.
    this.inputEl.addEventListener("keydown", (e) => {
      // 슬래시 팔레트가 떠 있으면 ↑↓/Enter/Tab 은 목록 조작이다(TUI 팝업과 같은 감각).
      //  Enter 는 **채워넣기**지 전송이 아니다 — 실행은 언제나 사용자가 한 번 더 눌러야 일어난다.
      if (this.cmdsEl && !e.isComposing) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault(); e.stopPropagation();
          this._moveCmd(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          const row = (this._cmdRows || [])[this._cmdIdx];
          if (row && row.chat !== "tui") {
            e.preventDefault(); e.stopPropagation();
            this._pickCmd(row.name);
            return;
          }
        }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._closeCmds(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing) {
        // Enter=전송 · ⌘Enter/Ctrl+Enter=전송(요구사항) · Shift+Enter=개행(기본 동작).
        e.preventDefault();
        e.stopPropagation();
        this._send();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.inputEl.blur(); // 네이티브/DOM 포커스 순서 사고 예방 — 항상 blur 선행 후 터미널 포커스
        this.ctx.exitChat?.();
        return;
      }
      // 방향키는 **우리가 직접** 캐럿을 움직인다(Selection.modify — Shift 선택/⌥단어/⌘줄 보존).
      //  한글 IME + WKWebView 가 방향키 기본 처리에서 기능키 전용 문자(PUA)를 텍스트로 흘리는
      //  버그(□ 삽입, 2회 신고)의 원천 차단: 기본 경로가 아예 실행되지 않는다. 조합 중엔 IME 소유.
      if (e.key.startsWith("Arrow") && !e.isComposing && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection();
        if (!sel) return;
        const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? "backward" : "forward";
        const gran = e.key === "ArrowUp" || e.key === "ArrowDown" ? "line"
          : e.metaKey ? "lineboundary" : e.altKey ? "word" : "character";
        try { sel.modify(e.shiftKey ? "extend" : "move", dir, gran); } catch (_) { /* noop */ }
        return;
      }
      // WebKit 은 contenteditable=false 인라인 요소 앞뒤에서 Backspace/Delete 를 자주 무시한다
      //  (실측: ✕ 는 되는데 키보드 삭제가 안 됨) — 캐럿에 인접한 칩을 직접 걷는다.
      //  칩 뒤에 우리가 넣는 공백은 칩과 **한 단위**다: 첫 키가 공백만 지우면 "무반응"으로 보인다(신고).
      if ((e.key === "Backspace" || e.key === "Delete") && !e.isComposing) {
        const unit = this._chipUnitAtCaret(e.key === "Backspace" ? -1 : 1);
        if (unit) {
          e.preventDefault();
          e.stopPropagation();
          this._removeChipUnit(unit);
        }
      }
    });
    // macOS 한글 IME + WKWebView 조합에서 방향키가 기능키 전용 문자(U+F700대 PUA)를 텍스트로
    //  흘리는 버그(실측: →/← 마다 □ 삽입) — 삽입 전 차단 + 삽입 후 소독의 이중 방어.
    this.inputEl.addEventListener("beforeinput", (e) => {
      const GHOST = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/;
      if (e.inputType === "insertText" && e.data && GHOST.test(e.data)) e.preventDefault();
    });
    this.inputEl.addEventListener("input", () => {
      this._ceSanitize();     // PUA 잔여 소독(조합 경로로 새는 케이스)
      this._reconcileChips(); // 백스페이스/선택 삭제로 칩이 지워졌으면 첨부 목록도 걷는다
      this._syncSlash();      // `/` 로 시작하면 명령 팔레트(공백을 치면 닫힌다)
      this._syncComposer();
      this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
    });
    // 붙여넣기 — 파일 참조(Finder ⌘C) > 이미지 데이터(스크린샷) > plain text 우선순위.
    //  파일/이미지는 네이티브 pasteboard 에서만 경로가 나온다(웹뷰 clipboardData 로는 불가) —
    //  Finder 복사는 text/plain 에 파일명이 실릴 수 있어 경로 확인이 항상 선행돼야 한다.
    //  plain text 만 execCommand insertText(undo 스택 유지) — 서식 HTML 은 직렬화를 오염시켜 배제.
    this.inputEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const txt = e.clipboardData?.getData("text/plain") || "";
      this._pasteRouted(txt);
    });
    // 칩 클릭 — ✕=제거(네이티브 undo 대상 아님·즉시), 몸통=미리보기(라이트박스/시스템 열기).
    this.inputEl.addEventListener("click", (e) => {
      const x = e.target.closest?.(".chat-chip-x");
      if (x) {
        x.closest(".chat-chip")?.remove();
        this._reconcileChips();
        this._syncComposer();
        this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
        return;
      }
      const chip = e.target.closest?.(".chat-chip");
      if (chip) {
        const a = this._attach.find((t) => t.path === chip.dataset.path);
        if (a) this._openPreview(a);
      }
    });
    // 본문 위임 클릭: 코드 복사 / 링크 외부 열기 / 결과 펼치기 / 파일 열기 / thinking 토글 / 첨부
    this.scrollEl.addEventListener("click", (e) => this._onBodyClick(e));
    this._renderApprovals();
  }

  setVisible(on) {
    const was = this._visible;
    this._visible = !!on;
    if (this._visible === was) return;
    if (this._visible) {
      this._retarget();          // 활성 터미널 탭 기준으로 열기(변경됐으면 재오픈)
      this._startPoll();
      // 같은 터미널로 돌아온 경우 _retarget 은 아무것도 하지 않는다(폭주 방지) → 여기서 한 번
      //  캐치업한다. TUI 에서 모드를 바꾸고 채팅으로 넘어오는 순간 알약이 **즉시** 맞아야 하기
      //  때문이다(사용자 요청 2026-08-02). since 응답이 현재 모드를 싣고 온다.
      //  ⚠ since 는 데몬 **캐시**(≤3초 전 화면)라 맥 터미널에서 직접 바꾼 직후엔 한 틱 늦을 수 있다
      //   → 모드만 따로 한 번 더, **지금 화면을 읽는** 경로(chat.mode 조회)로 확인한다.
      this._refreshMode();
      if (this._chatId) this._catchUp();
      this._renderApprovals();
      // 진입 즉시 컴포저 포커스(레이아웃 확정 후 한 프레임 뒤 — display 전환 직후 focus 는 무시된다)
      requestAnimationFrame(() => {
        if (!this._visible || this._disposed) return;
        try { this.inputEl?.focus(); } catch (_) {}
      });
    } else {
      this._stopPoll();
    }
  }

  // 활성 터미널 탭(tid)이 바뀌었을 때 pane 이 부른다. 보이지 않을 때는 아무것도 하지 않는다.
  retarget() { if (this._visible) this._retarget(); }

  _retarget() {
    const tid = this.ctx.tid();
    if (tid == null) { this._setBanner("터미널이 선택되지 않았습니다."); return; }
    // 같은 터미널이면 아무것도 하지 않는다 — 캐치업은 폴링(_tick)이 담당. 여기서 매번 since 를
    //  치면 리컨실러가 7s 주기로 showActiveTab 을 부를 때마다 왕복이 늘어난다.
    //  ★ noSession 도 "그 터미널의 확정 상태"다 → 같은 tid 면 다시 열지 않는다(폭주 방지의 일부).
    if (tid === this._tid && (this._chatId || this._noSession)) return;
    this._tid = tid;
    this._noSession = null;      // 터미널이 바뀌었다 = 재판정 대상(트리거 ③)
    this._probeUntil = 0;
    this._resetBuffer();
    this._open();
  }

  _resetBuffer() {
    this._msgs = [];
    this._els.clear();
    this._toolCards.clear();
    this._maxSeq = 0;
    this._lastSeq = 0;
    this._unread = 0;
    this._pending = [];
    this._truncated = false;
    if (this.scrollEl) this.scrollEl.innerHTML = "";
    this._syncJump();
  }

  // ── 스냅샷 열기 ──
  async _open() {
    if (this._opening) return this._opening;
    const tid = this._tid;
    const cwd = this._cwd();
    this._setBanner("대화를 불러오는 중…", "info");
    this._opening = (async () => {
      try {
        // ★ 이 터미널에서 도는 CLI 를 반드시 실어 보낸다. 빠지면 데몬이 claude 로 가정해서
        //  codex 터미널에 **같은 폴더의 claude 대화**가 뜬다(2026-07-28 실사고).
        const agent = this.ctx.agent?.() || null;
        const r = await this._openRpc({
          cwd, tid, limit: CHAT.SNAPSHOT_LIMIT,
          ...(agent ? { agent } : {}),
          ...(this.ctx.hostDeviceId() != null ? { hostDeviceId: this.ctx.hostDeviceId() } : {}),
        });
        if (this._disposed || this._tid !== tid) return;
        if (r && r.supported === false) { this._setBanner("이 에이전트의 대화 기록은 아직 지원하지 않습니다.", "warn"); return; }
        // ── 대화가 아직 없다(정상 상태) — 오류 배너 금지, 빈 상태 본문을 그린다 ──
        //  데몬은 "남의 대화를 보여주는 것보다 아무것도 안 보여주는 것이 낫다" 규칙으로 여기에 온다.
        if (r && r.noSession) {
          this._chatId = null;
          this._epoch = "";
          this._lastSeq = 0;
          this._sessionId = r.sessionId || null;
          this._agent = r.agent || this._agent || null;
          this._openFailed = null;
          this._noSession = String(r.reason || "none");
          this._noSessionAt = Date.now();
          this._resetBuffer();   // 이전 대화 잔상 제거(다른 터미널에서 넘어온 경우)
          this._setStatusLines([]); // statusline 잔상도 함께
          this._setMode(r.statusMode || null); // 모드 알약도 새 대상 기준(대화가 없어도 TUI 는 돌 수 있다)
          this._setDialog(r.statusDialog || null);
          this._setBanner("");   // ★ 오류·경고 프레이밍 금지(사용자 확정)
          this._renderBlank();
          return;
        }
        this._noSession = null;
        this._probeUntil = 0;
        this._agent = r.agent || this._agent || null;
        this._chatId = r.chatId || null;
        this._epoch = r.epoch || "";
        this._sessionId = r.sessionId || null;
        this._truncated = !!r.headTruncated;
        this._lastSeq = Number(r.headSeq) || 0;
        this._openFailed = null;
        this._setStatusLines(r.statusLines || []); // 새 대상의 statusline(없으면 이전 잔상 제거)
        this._setMode(r.statusMode || null);       // 모드 알약(claude 만 — 없으면 숨김)
        this._setDialog(r.statusDialog || null);   // TUI 선택 화면이 떠 있으면 카드로(토글 즉시 정확)
        this._ingest(r.messages || [], { snapshot: true });
        this._setBanner("");
      } catch (e) {
        if (this._disposed) return;
        const msg = String(e || "");
        this._openFailed = Date.now();
        // CHAT_NOT_FOUND = 그 터미널에서 claude 가 아직 대화를 만들지 않았다(정상 상태).
        //  ★ 사용자가 고른 대화(sessionId)를 명시했는데 이게 나오면 그 **파일이 사라진** 것이다
        //   (데몬 축출/삭제). 선택을 놓아주지 않으면 그 탭은 영구히 없는 대화를 요청하며 오류 배너에
        //   갇힌다(조용히 죽는 경로) → 선택 해제 + 빈 상태로 되돌린다. 다음 열기는 정상 판정을 탄다.
        if (/CHAT_NOT_FOUND|찾을 수 없습니다/.test(msg)) {
          this._setBanner("아직 이 터미널의 대화 기록이 없습니다. 첫 메시지를 보내면 생깁니다.", "info");
        }
        else if (/HTTP 409|데몬/.test(msg)) this._setBanner("PC 가 연결돼 있지 않습니다.", "warn");
        else if (/TRANSCRIPT_DISABLED/.test(msg)) this._setBanner("서버에서 대화 기록 기능이 꺼져 있습니다.", "warn");
        else this._setBanner("대화를 불러오지 못했습니다 — 잠시 후 자동으로 다시 시도합니다.", "warn");
      } finally {
        this._opening = null;
      }
    })();
    return this._opening;
  }

  // ── 라이브 push ──
  _onPush(frame) {
    this._lastPushAt = Date.now();
    const ctl = frame.control && frame.control.kind;
    // TUI statusline 미러(데몬 status-line.js) — chatId 정확 일치로만 도달한다(sessionId 미탑재).
    if (ctl === "status_line") { this._applyStatusFrame(frame.control); return; }
    // push 가 왔다 = 이 터미널에서 대화가 (다시) 살아 있다는 신호 → noSession 확정을 해제한다(트리거 ②).
    if (this._noSession) {
      this._noSession = null;
      this._probeUntil = 0;
      if (this._visible) this._open();
      return;
    }
    if (ctl === "gone") {
      // tail 이 사라졌다(파일 삭제·축출·idle). 다시 열면 같은 파일이면 같은 chatId 를 재사용한다.
      this._chatId = null;
      if (this._visible) this._open();
      return;
    }
    if (ctl === "epoch_reset" || (frame.epoch && this._epoch && frame.epoch !== this._epoch)) {
      // 파일 교체(clear/resume) 또는 compact 재작성 → 오프셋 무효. 버퍼를 비우고 스냅샷부터 다시.
      this._epoch = frame.epoch || this._epoch;
      this._resetBuffer();
      this._lastSeq = Number(frame.headSeq) || 0;
      this._ingest(frame.messages || [], { snapshot: true });
      return;
    }
    const msgs = frame.messages || [];
    if (!msgs.length) return;
    this._ingest(msgs, {});
    // ★ push 의 headSeq 로 워터마크를 밀지 않는다. push 팬아웃은 best-effort(버퍼·재전송 없음)라
    //   프레임 하나가 유실될 수 있는데, headSeq 를 믿고 워터마크를 당기면 그 구간이 영구 유실된다.
    //   워터마크는 "실제로 받은 메시지의 최대 seq"만(_ingest 가 계산) → 다음 chat.since 가 그 뒤부터
    //   다시 가져오므로 유실 구간이 메워진다(같은 seq 재수신은 멱등).
  }

  // ── 캐치업 폴링 ──
  //  push 가 도착하고 있으면 사실상 no-op(마지막 push 가 최근이면 건너뜀). 끊긴 사이/유실은 이게 메운다.
  _startPoll() {
    this._stopPoll();
    this._pollTimer = setInterval(() => this._tick(), CHAT.POLL_MS);
  }
  _stopPoll() { clearInterval(this._pollTimer); this._pollTimer = null; }
  _tick() {
    if (!this._visible || this._disposed) return;
    if (!this._chatId) {
      // ★ 대화가 없어도 **화면**은 갱신한다(2026-08-03 실사고): 상태줄·모드 알약·선택 화면 카드는
      //  전부 화면에서 오므로 대화 바인딩(짝짓기)이 실패한 터미널에서도 보여야 한다. codex 가
      //  `ambiguous` 일 때 /model 선택 화면이 채팅에 아예 안 뜨던 원인이 이 자리였다.
      this._pollScreen();
      // ★ noSession(성공 응답이지만 chatId 가 없다)은 **확정된 상태**다 → 매 틱 재오픈 금지.
      //   규칙은 chat-model.shouldReopenNoSession(순수·실행 검증). 여기서 안 막으면 4초마다
      //   chat.open 을 영원히 때리는 조용한 퇴행이 된다(화면은 정상, 데몬·릴레이만 두들긴다).
      if (this._noSession && !shouldReopenNoSession({
        reason: this._noSession, now: Date.now(), lastAt: this._noSessionAt, probeUntil: this._probeUntil,
      })) return;
      // 열기 실패 상태 — 8초 간격으로만 재시도(서버/데몬 오프라인에서 폭주 금지).
      if (!this._opening && (!this._openFailed || Date.now() - this._openFailed > CHAT.OPEN_FAIL_RETRY_MS)
        && this.ctx.tid() != null) {
        if (this._tid !== this.ctx.tid()) { this._tid = this.ctx.tid(); this._resetBuffer(); }
        this._noSessionAt = Date.now(); // 느린 재확인의 기준점을 갱신(다음 확인은 다시 30초 뒤)
        this._open();
      }
      return;
    }
    if (Date.now() - this._lastPushAt < 3500) return; // push 가 살아있다
    this._catchUp();
  }

  // 대화 바인딩이 없는 터미널의 화면 상태 폴링 — 감시자(push)는 chatId 로만 라우팅되기 때문에
  //  여기서는 우리가 직접 읽는다. 로컬 터미널이면 사이드카 직결(1~2ms).
  async _pollScreen() {
    const tid = this.ctx.tid?.();
    if (tid == null || this._screening) return;
    this._screening = true;
    try {
      const cwd = this._cwd(), agent = this._agent || undefined;
      const r = this.ctx.isLocal?.()
        ? await api.chatLocal("chat.screen", { cwd, tid, agent })
        : await api.chatScreen({ cwd, tid, agent, hostDeviceId: this.ctx.hostDeviceId?.() });
      if (this._disposed || !r) return;
      this._setStatusLines(r.lines || []);
      if (r.mode && !this._modeBusy) this._setMode(r.mode);
      if (!this._dlgBusy) this._setDialog(r.dialog || null);
    } catch (_) { /* 조용히 — 다음 틱에 다시 본다 */ }
    finally { this._screening = false; }
  }

  async _catchUp() {
    if (!this._chatId || this._catching) return;
    this._catching = true;
    try {
      const r = await this._sinceRpc({ chatId: this._chatId, sinceSeq: this._lastSeq, epoch: this._epoch });
      if (this._disposed) return;
      // 모드는 **캐치업이 정본**이다 — push 는 변경 순간 1회뿐이라 그때 소켓이 끊겨 있었으면(앱 백그라운드·
      //  재접속) 영영 놓치고, 그 뒤로 화면이 안 변하면 알약이 옛 모드로 굳는다(2026-08-02 사용자 신고).
      if (r && r.statusMode && !this._modeBusy) this._setMode(r.statusMode);
      // 캐치업이 다이얼로그의 **정본**이다(push 를 놓쳐도 유령 카드가 남지 않는다).
      if (r && "statusDialog" in r && !this._dlgBusy) this._setDialog(r.statusDialog || null);
      if (r && r.epochChanged) {
        this._epoch = r.epoch || this._epoch;
        this._resetBuffer();
        this._lastSeq = Number(r.headSeq) || 0;
        this._ingest(r.messages || [], { snapshot: true });
        return;
      }
      if (r && Array.isArray(r.messages) && r.messages.length) this._ingest(r.messages, {});
      if (r && Number(r.headSeq) > this._lastSeq) this._lastSeq = Number(r.headSeq);
      if (r && r.more) setTimeout(() => this._catchUp(), 60); // 프레임 예산에 걸린 나머지
    } catch (e) {
      // CHAT_GONE(구독 소멸)은 back 이 500 + 한글 메시지로만 내려오므로 코드로 구분할 수 없다.
      //  since 실패는 원인 불문 "구독 재수립"이 항상 옳은 복구다(chat.open 은 멱등).
      this._chatId = null;
      this._openFailed = Date.now();
      if (this._visible) this._open();
    } finally {
      this._catching = false;
    }
  }

  // ── 수신 반영 ──
  _ingest(incoming, { snapshot }) {
    const drop = dropMatchedOptimistic(this._pending, incoming);
    for (const seq of drop) {
      this._els.get(seq)?.remove();
      this._els.delete(seq);
      this._msgs = this._msgs.filter((m) => m.seq !== seq);
    }
    const { list, added } = mergeMsgs(this._msgs, incoming);
    this._msgs = list;
    this._lastSeq = lastSeqOf(list, this._lastSeq);
    // 스냅샷이거나 과거 구간이 섞여 왔으면(순서 역행) 전체 재조립 — 부분 append 는 순서가 깨진다.
    const backfill = added.some((m) => m.seq < this._maxSeq);
    if (snapshot || backfill) this._rebuild();
    else this._appendAll(added);
    // follow 는 스크롤 이벤트에서만 꺼진다 — 큰 블록이 붙어 순간적으로 '맨 아래'에서 벗어나도
    //  사용자가 위로 안 올렸으면 계속 따라간다(픽셀 근접 판정만 쓰면 여기서 조용히 끊긴다).
    if (snapshot || this._follow) { this._scrollToBottom(); this._unread = 0; }
    else if (added.length) this._unread += added.filter((m) => isVisible(m) && !isResult(m)).length;
    this._syncJump();
    // 새 메시지로 질문 카드 상태가 바뀌었을 수 있다(질문 도착 → 카드 세움 / 답 도착 → 카드 회수 +
    //  감췄던 질문을 답과 함께 대화에 넣기). _renderApprovals 가 키 대조로 필요할 때만 재조립한다.
    this._renderApprovals();
    this._syncWorking();
    this._regroupTools();   // 끝난 도구 행 묶기(TUI 미러) — 증분 append 뒤 경계 재계산
  }

  _rebuild() {
    if (!this.scrollEl) return;
    this.scrollEl.innerHTML = "";
    this._els.clear();
    this._toolCards.clear();
    this._maxSeq = 0;
    if (this._truncated) {
      const hint = document.createElement("div");
      hint.className = "chat-headhint";
      hint.textContent = "이전 대화는 생략되었습니다(최근 " + CHAT.SNAPSHOT_LIMIT + "줄만 표시)";
      this.scrollEl.appendChild(hint);
    }
    this._appendAll(this._msgs);
    // "표시할 게 없다"는 원본 메시지 수가 아니라 **실제로 그려진 행 수**로 판단한다
    //  (전부 hidden 인 진단 메시지만 온 경우가 흔하다).
    if (!this._els.size) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "아직 표시할 대화가 없습니다";
      this.scrollEl.appendChild(empty);
    }
  }

  _appendAll(msgs) {
    const answered = this._answeredToolIds();
    const carded = this._paneHasQuestionCard() || !!this._tuiQuestion();
    for (const m of msgs) {
      if (m.seq > this._maxSeq) this._maxSeq = m.seq;
      // tool 결과는 앞선 tool_use 카드의 결과 슬롯으로 합친다(별도 카드 금지 — Claude 앱과 동일).
      //  hidden 결과(구버전 형태의 빈 자리표시)는 그리지 않는다.
      if (isResult(m)) {
        if (!m.hidden) this._fillResult(m);
        continue;
      }
      if (!isVisible(m)) continue;
      // ★ **아직 답하지 않은** 질문은 대화 내역에 넣지 않는다(사용자 확정 2026-07-28).
      //  판정은 트랜스크립트만 본다: 이 tool_use 에 짝 tool_result 가 없으면 = 미응답.
      //  (예전엔 승인 요청의 toolUseId 와 대조했는데, claude 의 PermissionRequest 페이로드에
      //   tool_use_id 가 없으면 대조가 통째로 빗나가 질문이 대화와 도크에 **둘 다** 그려졌다.)
      //  단 이 pane 에 실제로 질문 카드가 떠 있을 때만 감춘다 — 카드가 없는데 감추면
      //  "TUI 엔 질문이 있는데 채팅엔 아무것도 없다"가 된다(그게 더 나쁘다).
      if (m.kind === "question" && carded && !(m.tool && m.tool.id && answered.has(m.tool.id))) continue;
      const el = this._buildRow(m);
      if (!el) continue;
      // 빈 상태 안내가 남아 있으면 첫 행을 넣을 때 치운다.
      this.scrollEl.querySelector(".chat-empty")?.remove();
      this._els.set(m.seq, el);
      this.scrollEl.appendChild(el);
    }
  }

  // ── 행 빌더 ──
  _buildRow(m) {
    const row = document.createElement("div");
    row.dataset.seq = String(m.seq);
    // ★ 행에 title 을 달지 않는다(사용자 요구 2026-08-02): 대화 어디에 마우스를 올려도 OS 툴팁으로
    //  시각이 따라다녀서 읽는 데 방해가 됐다. 시각은 어차피 화면에 안 쓰는 값이라(말풍선마다 시간을
    //  박지 않는 것이 원래 규칙) 툴팁까지 없애면 그냥 조용해진다.
    const text = String(m.text || "");

    if (m.role === "user" && (m.kind === "text" || m.kind === "slash")) {
      row.className = "chat-msg chat-msg-user" + (m.kind === "slash" ? " slash" : "") + (m.optimistic ? " optimistic" : "");
      row.innerHTML = m.kind === "slash"
        ? `<span class="chat-slash">${escapeHtml(text)}</span>`
        : this._userTextHtml(m, text);
      this._hydrateMsgChips(row, m); // 원격 첨부 썸네일 자동 로드(캐시)
      return row;
    }
    if (m.role === "assistant" && m.kind === "text") {
      row.className = "chat-msg chat-msg-assistant";
      row.innerHTML = renderMarkdown(text);
      this._hydrateMedia(row);   // ![라벨](경로) 자리 → 실제 이미지/영상(화면에 보일 때 로드)
      if (m.truncated) row.appendChild(this._truncNote());
      return row;
    }
    if (m.kind === "thinking") {
      // 기본 1줄(120자) 접힘 — 클릭하면 전체(설계서 §2.1 thinkingCollapse). 실측상 본문이 빈 경우가
      //  대부분이라 chat-model.isVisible 이 빈 thinking 은 애초에 걸러낸다.
      row.className = "chat-thinking";
      row.innerHTML = `<span class="chat-think-body">${escapeHtml(text.slice(0, CHAT.THINKING_CHARS))}${text.length > CHAT.THINKING_CHARS ? "…" : ""}</span>`;
      row.dataset.full = text;
      row.dataset.collapsed = "1";
      row.title = "눌러서 전체 보기";
      return row;
    }
    if (m.kind === "tool_use" || m.kind === "question") {
      row.className = "chat-tool";
      // 도구 행 접기(TUI 미러 — 2026-07-30 사용자 확정): TUI 는 끝난 도구를 한 줄("Ran 1 shell
      //  command")로 접는다. 채팅도 동일 — 진행 중엔 명령(argsPreview)을 보이고, 결과가 오면
      //  한 줄로 접는다(.done). 머리 클릭으로 펼침/접기. 질문 행은 접지 않는다(내용이 곧 본문).
      if (m.kind === "tool_use") row.dataset.fold = "1";
      if (m.tool && m.tool.name) row.dataset.toolName = m.tool.name;   // 묶음 요약 라벨의 근거
      const label = toolLabel(m);
      const path = m.tool && m.tool.path ? m.tool.path : "";
      const head = document.createElement("div");
      head.className = "chat-tool-head";
      head.innerHTML =
        `<span class="chat-tool-mark pending">…</span>` +
        `<span class="chat-tool-label">${escapeHtml(label)}</span>` +
        (path ? `<button class="chat-tool-open" type="button" data-path="${escapeHtml(path)}" title="IDE 로 열기">열기</button>` : "");
      row.appendChild(head);
      if (m.tool && m.tool.argsPreview) {
        const pre = document.createElement("div");
        pre.className = "chat-tool-args";
        pre.textContent = m.tool.argsPreview;
        row.appendChild(pre);
      }
      if (m.kind === "question" && m.question) row.appendChild(this._buildQuestion(m.question));
      const res = document.createElement("div");
      res.className = "chat-tool-result hidden";
      row.appendChild(res);
      const id = (m.tool && m.tool.id) || null;
      if (id) this._toolCards.set(id, { mark: head.querySelector(".chat-tool-mark"), res, row, q: m.kind === "question" });
      return row;
    }
    if (m.kind === "compact" || m.kind === "divider" || m.kind === "interrupt") {
      row.className = "chat-divider";
      row.innerHTML = `<span>${escapeHtml(m.kind === "interrupt" ? "사용자가 중단했습니다" : text)}</span>`;
      return row;
    }
    // 그 외(예상 밖 kind) — 조용히 삼키지 않고 dim 한 줄로 남긴다(진단 가능).
    row.className = "chat-divider dim";
    row.innerHTML = `<span>${escapeHtml(text || m.kind || "?")}</span>`;
    return row;
  }

  // ── 끝난 도구 행 묶기(TUI 미러) ────────────────────────────────────────────────
  // 렌더가 증분(append)이라 데이터 단계에서 묶지 않고 **후처리**로 접는다: 연속으로 끝난 도구 행이
  //  TOOL_GROUP_MIN 개 이상이면 그 앞에 요약 한 줄을 넣고 본체는 감춘다. 요약을 누르면 펼친다.
  //  진행 중(.done 아님)·펼쳐 둔(.open)·질문 행은 대상이 아니다 — 지금 무슨 일이 일어나는지는 항상 보인다.
  _regroupTools() {
    if (!this.scrollEl) return;
    // 멱등: 지난 요약을 걷고 다시 계산한다(증분 append 뒤에도 경계가 정확해진다).
    for (const g of [...this.scrollEl.querySelectorAll(".chat-tool-group")]) g.remove();
    for (const r of [...this.scrollEl.querySelectorAll(".grouped")]) r.classList.remove("grouped");
    const kids = [...this.scrollEl.children];
    let run = [];
    const flush = () => {
      const tools = run.filter((el) => el.classList.contains("chat-tool"));
      if (tools.length >= TOOL_GROUP_MIN) {
        const names = tools.map((el) => el.dataset.toolName || "");
        const bad = run.filter((el) => el.querySelector(".chat-tool-mark.err")).length;
        const sum = document.createElement("div");
        sum.className = "chat-tool-group";
        sum.innerHTML = `<span class="chat-tool-mark ${bad ? "err" : "ok"}">${bad ? "✕" : "✓"}</span>`
          + `<span class="chat-tool-group-label">도구 ${tools.length}개 실행 · ${escapeHtml(toolRunLabel(names))}${bad ? ` · 실패 ${bad}` : ""}</span>`
          + `<span class="chat-tool-group-caret">›</span>`;
        run[0].before(sum);
        for (const el of run) el.classList.add("grouped");
      }
      run = [];
    };
    for (const el of kids) {
      // ★ diff 가 붙은 편집 행은 묶지 않는다 — TUI 도 Update 는 diff 를 펼쳐 두고 나머지만 접는다.
      const isDoneTool = el.classList?.contains("chat-tool") && el.classList.contains("done")
        && !el.classList.contains("open") && el.dataset.fold === "1"
        && !el.querySelector(".chat-diff");
      if (isDoneTool) { run.push(el); continue; }
      // '생각 중' 줄은 묶음을 끊지 않는다 — 도구 사이에 섞여 들어와 run 을 토막내면 실제로는 연속인
      //  도구 열몇 개가 하나도 안 접힌다(실기기 실측). 함께 접히고, 펼치면 원래 순서 그대로.
      if (el.classList?.contains("chat-thinking") && run.length) { run.push(el); continue; }
      flush();
    }
    flush();
  }

  // 편집 diff — TUI 와 같은 모양(줄번호 + 초록/빨강). 길면 접고 "더 보기".
  _patchHtml(patch) {
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
        + `<button class="chat-diff-more" type="button">${rest.length}줄 더 보기</button>` : "")
      + (more ? `<div class="chat-diff-cut">…이후 생략(원문은 터미널)</div>` : "")
      + `</div>`;
  }

  _truncNote() {
    const n = document.createElement("div");
    n.className = "chat-trunc";
    n.textContent = "…내용이 잘렸습니다(원문은 터미널에서 확인)";
    return n;
  }

  _buildQuestion(q) {
    // 내역의 질문은 **간결하게**(2026-07-30 사용자 확정: TUI 보다 많은 정보를 보여주지 말 것) —
    //  TUI 내역도 질문 문구만 남긴다. 선택지 전체는 응답 카드가 이미 보여줬던 것이라 다시 안 그린다.
    //  안내 문구도 안 붙인다 — 여기 그려지는 질문은 이미 답한 질문이다(미응답은 도크가 그린다).
    const wrap = document.createElement("div");
    wrap.className = "chat-q";
    wrap.innerHTML =
      (q.header ? `<div class="chat-q-head">${escapeHtml(q.header)}</div>` : "") +
      (q.question ? `<div class="chat-q-text">${escapeHtml(q.question)}</div>` : "");
    return wrap;
  }

  // ── 드롭 첨부 = 입력칸 안 **원자 칩**(2026-07-30 사용자 확정 3차: 입력은 로컬 네이티브) ──
  //  os-drop 이 채팅 모드 pane 드롭을 여기로 넘긴다. 칩은 contenteditable=false 라 커서/백스페이스에
  //  한 덩어리로 동작한다(TUI [Image #N] 원자성과 같은 감각). TUI 반영은 **전송 시 한 번** —
  //  직렬화(칩→인용 경로) 후 데몬이 이미지 경로 조각을 따로 paste 해 제자리 [Image #N] 변환.
  addAttachments(paths) {
    const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tiff"]);
    for (const p of (paths || []).filter(Boolean)) {
      if (this._attach.length >= 8) break;
      if (this._attach.some((a) => a.path === p)) continue;
      const name = String(p).split("/").pop() || p;
      const ext = (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
      const a = { path: p, name, ext, img: IMG.has(ext), b64: null };
      this._attach.push(a);
      this._ceInsertChip(a);
      if (a.img) {
        api.filePreviewB64(p)
          .then((b64) => { a.b64 = b64; this._refreshChip(a); })
          .catch(() => { a.img = false; this._refreshChip(a); }); // 8MB 초과 등 — 라벨 칩으로 강등
      }
    }
    this._syncComposer();
    this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
    try { this.inputEl?.focus(); } catch (_) { /* noop */ }
  }

  // 붙여넣기 라우팅 — 네이티브 pasteboard 의 파일 참조가 최우선(칩), 다음 이미지 데이터(임시
  //  PNG 저장 후 칩), 마지막이 plain text. 비동기 왕복(로컬 invoke, ~ms)이지만 preventDefault
  //  이후 캐럿은 그대로라 삽입 위치가 유지된다.
  async _pasteRouted(txt) {
    let paths = [];
    try { paths = await api.clipboardPaths(); } catch (_) { /* noop */ }
    if (Array.isArray(paths) && paths.length) { this.addAttachments(paths); return; }
    let img = null;
    try { img = await api.clipboardImagePng(); } catch (_) { /* noop */ }
    if (img) { this.addAttachments([img]); return; }
    if (txt) { try { document.execCommand("insertText", false, txt); } catch (_) { /* noop */ } }
  }

  // ── contenteditable 컴포저 헬퍼 ──
  // 직렬화 — 텍스트 노드는 그대로, 칩은 인용 경로, BR/블록은 개행. NBSP 는 공백으로 정규화.
  _ceText() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) { out.push(c.data); continue; }
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        if (c.classList.contains("chat-chip")) { out.push(shq(c.dataset.path || "") + " "); continue; }
        if (c.tagName === "BR") { out.push("\n"); continue; }
        if ((c.tagName === "DIV" || c.tagName === "P") && out.length && !String(out[out.length - 1]).endsWith("\n")) out.push("\n");
        walk(c);
      }
    };
    if (this.inputEl) walk(this.inputEl);
    return out.join("").replace(/\u00a0/g, " ");
  }

  _ceClear() {
    if (this.inputEl) this.inputEl.innerHTML = "";
  }

  // 커서 위치에 텍스트 삽입 — execCommand 는 deprecated 지만 WebKit contenteditable 에서
  //  **네이티브 undo 스택을 유지하는 유일한 삽입 경로**라 의도적으로 쓴다.
  _ceInsertText(t) {
    if (!this.inputEl || !t) return;
    try { this.inputEl.focus(); document.execCommand("insertText", false, t); } catch (_) { /* noop */ }
    this._syncComposer();
    this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
  }

  _ceInsertChip(a) {
    if (!this.inputEl) return;
    const chip = document.createElement("span");
    chip.className = "chat-chip";
    chip.contentEditable = "false";
    chip.dataset.path = a.path;
    chip.title = a.path;
    chip.innerHTML = this._chipInnerHtml(a);
    const sel = window.getSelection();
    let range = sel && sel.rangeCount && this.inputEl.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(this.inputEl);
      range.collapse(false); // 커서가 입력칸 밖이면 끝에
    }
    range.deleteContents();
    range.insertNode(chip);
    const sp = document.createTextNode(" ");
    chip.after(sp);
    const r2 = document.createRange();
    r2.setStartAfter(sp);
    r2.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r2);
  }

  _chipInnerHtml(a) {
    // 이미지 = 썸네일 · 그 외 = 확장자 배지(사용자 요구: "[파일형식 파일명 닫기]") — 배지는 최대 4자.
    const lead = a.img && a.b64
      ? `<img class="chat-chip-thumb" src="data:${this._attachMime(a)};base64,${a.b64}" alt="">`
      : (a.ext ? `<span class="chat-chip-ext">${escapeHtml(String(a.ext).toUpperCase().slice(0, 4))}</span>` : "");
    return lead + `<span class="chat-chip-label">${escapeHtml(a.name)}</span>` +
      `<button class="chat-chip-x" type="button" title="빼기">✕</button>`;
  }

  _refreshChip(a) {
    const chip = this.inputEl?.querySelector(`.chat-chip[data-path="${CSS.escape(a.path)}"]`);
    if (chip) chip.innerHTML = this._chipInnerHtml(a);
  }

  // 칩이 편집(백스페이스·선택 삭제·undo)으로 사라지거나 되살아나면 첨부 목록을 DOM 기준으로 맞춘다.
  _reconcileChips() {
    if (!this.inputEl) return;
    const present = new Set(Array.from(this.inputEl.querySelectorAll(".chat-chip")).map((c) => c.dataset.path));
    this._attach = this._attach.filter((a) => present.has(a.path));
  }

  // 캐럿에 인접한 "칩 단위"(칩 + 우리가 넣은 뒤공백) — Backspace/Delete 원자 삭제의 근거.
  //  실측(크롬 하네스): 칩 삽입 직후 캐럿은 **요소 컨테이너 좌표**(chat-ce@N)로 서고 공백은
  //  독립 텍스트 노드다 — 텍스트 노드 내부 좌표만 보던 첫 구현이 놓친 케이스(신고 재현·확정).
  //  판정: 캐럿 앞(또는 뒤)을 [빈 텍스트]* [공백-only 텍스트]? [칩] 순으로 걷어 칩에 닿으면 단위.
  _chipUnitAtCaret(dir) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!this.inputEl.contains(r.startContainer)) return null;
    const isChip = (n) => n && n.nodeType === Node.ELEMENT_NODE && n.classList.contains("chat-chip");
    const isWs = (n) => n && n.nodeType === Node.TEXT_NODE && /^[ \u00a0]*$/.test(n.data);
    let node = r.startContainer;
    const off = r.startOffset;
    let spaceHop = null;
    if (node.nodeType === Node.TEXT_NODE) {
      if (dir < 0 && off > 0) {
        // 캐럿 앞 글자가 이 노드의 유일한 선행 내용(공백)이고 그 앞이 칩일 때만 단위로 흡수
        const before = node.data.slice(0, off);
        if (!(/^[ \u00a0]$/.test(before) && isChip(node.previousSibling))) return null;
        spaceHop = { node, from: 0, to: off };
        node = node.previousSibling;
      } else if (dir > 0 && off < node.length) {
        // 캐럿 뒤 잔여가 공백뿐이고 다음 형제가 칩일 때만 단위로 흡수
        if (!(/^[ \u00a0]+$/.test(node.data.slice(off)) && isChip(node.nextSibling))) return null;
        spaceHop = { node, from: off, to: node.length };
        node = node.nextSibling;
      } else {
        node = dir < 0 ? node.previousSibling : node.nextSibling;
      }
    } else {
      node = node.childNodes[dir < 0 ? off - 1 : off] || null;
    }
    // [빈/공백-only 텍스트 노드]를 걷어 칩까지 접근 — 그 공백들도 단위에 포함해 지운다.
    const wsCuts = [];
    while (node && node.nodeType === Node.TEXT_NODE) {
      if (!isWs(node)) return null; // 실제 글자가 있다 — 일반 편집에 맡긴다
      if (node.length) wsCuts.push({ node, from: 0, to: node.length });
      node = dir < 0 ? node.previousSibling : node.nextSibling;
    }
    if (!isChip(node)) return null;
    // 칩 뒤에 우리가 넣은 공백(반대편 인접)도 단위에 포함 — 남으면 유령 공백이 쌓인다.
    let tail = null;
    if (dir > 0) {
      const after = node.nextSibling;
      if (after && isWs(after) && after.length) tail = { node: after, from: 0, to: Math.min(1, after.length) };
    }
    return { chip: node, spaceHop, wsCuts, tail };
  }

  _removeChipUnit(unit) {
    // 캐럿 기준점 = 칩 앞 노드(삭제 후에도 살아남는 참조) — normalize 뒤 명시 배치해
    //  "캐럿이 칩 경계/줄 머리에 그려지는" 이상 렌더(신고 건)를 예방한다.
    const chip = unit.chip;
    const prev = chip.previousSibling;
    for (const cut of [unit.spaceHop, unit.tail, ...(unit.wsCuts || [])]) {
      if (!cut) continue;
      cut.node.deleteData(cut.from, cut.to - cut.from);
    }
    chip.remove();
    this.inputEl.normalize(); // 쪼개진 텍스트 노드 봉합 — 캐럿이 노드 경계에 끼지 않게
    try {
      const r2 = document.createRange();
      if (prev && prev.parentNode) {
        if (prev.nodeType === Node.TEXT_NODE) r2.setStart(prev, prev.length);
        else r2.setStartAfter(prev);
      } else {
        r2.setStart(this.inputEl, 0);
      }
      r2.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r2);
    } catch (_) { /* noop */ }
    this._reconcileChips();
    this._syncComposer();
    this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
  }

  // 유령문자 소독(제어문자 + PUA 전역) — IME/조합 경로로 새어 들어온 잔여를 걷는다(캐럿 보정 포함).
  //  방향키는 keydown 에서 원천 가로채므로(Selection.modify) 이건 최후 안전망이다.
  _ceSanitize() {
    const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/g;
    const sel = window.getSelection();
    const walker = document.createTreeWalker(this.inputEl, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      if (!BAD.test(t.data)) { BAD.lastIndex = 0; continue; }
      BAD.lastIndex = 0;
      const inNode = sel && sel.rangeCount && sel.getRangeAt(0).startContainer === t;
      const off = inNode ? sel.getRangeAt(0).startOffset : 0;
      const before = t.data.slice(0, off);
      t.data = t.data.replace(BAD, "");
      if (inNode) {
        const newOff = before.replace(BAD, "").length;
        try {
          const r = document.createRange();
          r.setStart(t, Math.min(newOff, t.length));
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (_) { /* noop */ }
      }
    }
  }

  // ── 대화가 참조한 미디어(`![라벨](경로)`) 하이드레이션 ──────────────────────────────
  // 규칙(사용자 확정 2026-08-02): 이미지 문법은 **실제로 그린다**. 경로는 캡션으로 항상 남긴다
  //  ("경로를 보여주려던 의도"였어도 잃는 정보가 0 — 그래서 오판 비용이 없다).
  //  로드는 **화면에 들어올 때**(IntersectionObserver) — 긴 대화를 열자마자 수십 장을 받지 않는다.
  //  바이트 출처: 이 PC 터미널이면 Tauri 로컬 읽기(즉시), 원격 PC 면 데몬 chat.file(권한 = 그 대화가
  //  내보낸 메시지에 적힌 경로만). URL 이면 그대로 <img src>.
  _hydrateMedia(row) {
    const nodes = row.querySelectorAll?.(".chat-media");
    if (!nodes || !nodes.length) return;
    if (!this._mediaObs) {
      this._mediaObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this._mediaObs.unobserve(e.target);
          this._loadMedia(e.target);
        }
      }, { root: this.scrollEl, rootMargin: "300px 0px" });
    }
    for (const el of nodes) {
      el.dataset.state = "idle";
      el.appendChild(this._mediaCaption(el));
      this._mediaObs.observe(el);
    }
  }

  _mediaCaption(el) {
    const cap = document.createElement("span");
    cap.className = "chat-media-cap";
    const alt = el.dataset.alt || "";
    cap.innerHTML = (alt ? `<span class="chat-media-alt">${escapeHtml(alt)}</span>` : "")
      + `<span class="chat-media-path" title="${escapeHtml(el.dataset.target || "")}">${escapeHtml(el.dataset.name || "")}</span>`;
    return cap;
  }

  async _loadMedia(el) {
    if (!el || el.dataset.state === "done" || el.dataset.state === "loading") return;
    el.dataset.state = "loading";
    const target = el.dataset.target || "";
    const kind = el.dataset.kind || "image";
    const put = (node) => { el.insertBefore(node, el.firstChild); el.dataset.state = "done"; };
    const fail = (why) => {
      el.dataset.state = "done";
      const n = document.createElement("span");
      n.className = "chat-media-fail";
      n.textContent = why;
      el.insertBefore(n, el.firstChild);
    };
    try {
      let src = null;
      if (el.dataset.via === "url") src = target;
      else {
        const r = await this._mediaBytes(target);
        if (!r || r.missing) {
          fail(r && r.reason === "too_large" ? "파일이 너무 커서 여기서는 못 보여줘요(눌러서 열기)"
            : r && r.reason === "not_found" ? "파일을 찾을 수 없어요"
              : r && r.reason === "unsupported" ? "미리보기를 지원하지 않는 형식이에요"
                : "불러오지 못했어요");
          el.dataset.openable = "1";
          return;
        }
        src = `data:${r.mediaType};base64,${r.base64}`;
      }
      if (kind === "video") {
        const v = document.createElement("video");
        v.className = "chat-media-el";
        v.controls = true;
        v.preload = "metadata";
        v.src = src;
        put(v);
      } else {
        const img = document.createElement("img");
        img.className = "chat-media-el";
        img.loading = "lazy";
        img.alt = el.dataset.alt || "";
        img.src = src;
        img.addEventListener("click", () => {
          this._showLightbox(src, { name: el.dataset.name || "", path: el.dataset.via === "url" ? null : target });
        });
        put(img);
      }
    } catch (_) { fail("불러오지 못했어요"); }
  }

  /** 미디어 바이트 — 로컬은 Tauri 직접 읽기(왕복 0), 원격은 데몬 chat.file(권한 검사 포함). */
  async _mediaBytes(target) {
    if (this.ctx.isLocal?.()) {
      const abs = /^[~/]/.test(target) ? target : null;
      try {
        const b64 = await api.filePreviewB64(abs || target);
        if (b64) return { mediaType: this._mediaMime(target), base64: b64 };
      } catch (e) {
        // 로컬 읽기 실패(경로 상대·권한·용량) — 데몬 경로로 폴백한다(권한 규칙은 그쪽이 정본).
      }
    }
    if (!this._chatId) return { missing: true, reason: "not_found" };
    return api.chatFile({ chatId: this._chatId, path: target });
  }

  _mediaMime(target) {
    const ext = String(target.split(/[?#]/)[0].split(".").pop() || "").toLowerCase();
    const MIME = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff",
      mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", pdf: "application/pdf",
    };
    return MIME[ext] || "application/octet-stream";
  }

  // 칩 클릭 = 미리보기(일반 LLM 앱 관례) — 이미지는 앱 내 라이트박스, 그 외/대용량은 시스템 기본 앱.
  async _openPreview(a) {
    if (!a) return;
    if (a.img) {
      let b64 = a.b64;
      if (!b64) { try { b64 = await api.filePreviewB64(a.path); } catch (_) { b64 = null; } }
      if (b64) { this._showLightbox(`data:${this._attachMime(a)};base64,${b64}`, a); return; }
    }
    try { await api.openPath(a.path); } catch (e) {
      this._setBanner("파일을 열 수 없습니다: " + String(e || "").slice(0, 80), "warn");
    }
  }

  _showLightbox(src, a) {
    document.querySelector(".chat-lightbox")?.remove();
    const ov = document.createElement("div");
    ov.className = "chat-lightbox";
    ov.innerHTML =
      `<div class="chat-lb-bar"><span class="chat-lb-name" title="${escapeHtml(a.path || a.name)}">${escapeHtml(a.name)}</span>` +
      (a.path ? `<button class="chat-lb-open" type="button">원본 열기</button>` : "") +
      `<button class="chat-lb-close" type="button" title="닫기">✕</button></div>` +
      `<img class="chat-lb-img" src="${src}" alt="">`;
    let close;
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
    ov.addEventListener("click", (e) => {
      if (e.target.closest?.(".chat-lb-open")) { api.openPath(a.path).catch(() => {}); return; }
      if (e.target.closest?.(".chat-lb-close") || e.target === ov) close();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(ov);
  }

  _attachMime(a) {
    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic", tiff: "image/tiff" };
    return MIME[a.ext] || "image/png";
  }

  // ── user 본문 인라인 칩(2026-07-30 사용자 확정: 보낸 메시지도 컴포저와 같은 표현) ──
  //  · 낙관 버블: 텍스트 속 인용 경로(shq) 자리 = 로컬 첨부 칩(즉시 썸네일)
  //  · 트랜스크립트: 데몬이 심은 위치 마커 [Image #N] 자리 = attachments[N-1] 칩(썸네일 자동 로드)
  _userTextHtml(m, text) {
    const parts = [];
    // 텍스트 런 안의 인용 절대경로('/…/x.ext')도 칩으로 — 전송 원문은 경로지만 채팅 표현은
    //  [확장자 배지·파일명] 칩(2026-07-30 사용자 확정: "전송은 경로 그대로, 표현은 칩").
    const PATH_RE = /'(\/[^'\n]{1,300}?\.[A-Za-z0-9]{1,8})'/g;
    const push = (t) => {
      if (!t) return;
      let last = 0;
      let pm;
      PATH_RE.lastIndex = 0;
      while ((pm = PATH_RE.exec(t))) {
        const path = pm[1];
        const name = path.split("/").pop() || path;
        const ext = name.includes(".") ? name.split(".").pop() : "";
        if (pm.index > last) parts.push(escapeHtml(t.slice(last, pm.index)).replace(/\n/g, "<br>"));
        parts.push(`<span class="chat-chip msg" data-kind="path" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">` +
          (ext ? `<span class="chat-chip-ext">${escapeHtml(ext.toUpperCase().slice(0, 4))}</span>` : "") +
          `<span class="chat-chip-label">${escapeHtml(name)}</span></span>`);
        last = pm.index + pm[0].length;
      }
      if (last < t.length) parts.push(escapeHtml(t.slice(last)).replace(/\n/g, "<br>"));
    };
    const atts = m.optAttach || [];
    if (atts.length) {
      let rest = text;
      while (rest) {
        let best = -1;
        let bestA = null;
        let bestTok = "";
        for (const a of atts) {
          const tok = shq(a.path);
          const at = rest.indexOf(tok);
          if (at >= 0 && (best < 0 || at < best)) { best = at; bestA = a; bestTok = tok; }
        }
        if (best < 0) { push(rest); break; }
        push(rest.slice(0, best));
        parts.push(this._msgChipHtml({
          kind: "local", label: bestA.name, path: bestA.path,
          thumb: bestA.img && bestA.b64 ? `data:${this._attachMime(bestA)};base64,${bestA.b64}` : "",
        }));
        rest = rest.slice(best + bestTok.length).replace(/^ /, "");
      }
      return parts.join("");
    }
    const n = (m.attachments || []).length;
    if (!n) { push(text); return parts.join(""); }
    // ⚠ 토큰 번호는 claude 의 **세션 전역** 카운터(예: #10)라 인덱스가 아니다 — 순서로 짝짓는다:
    //  텍스트의 k번째 [Image #N] 토큰 ↔ attachments[k]. 라벨은 원문 번호 그대로("Image #10").
    const re = /\[Image #(\d+)\]/g;
    let last = 0;
    let k = 0;
    let mt;
    while ((mt = re.exec(text)) && k < n) {
      push(text.slice(last, mt.index));
      parts.push(this._msgChipHtml({ kind: "remote", label: mt[0].slice(1, -1), idx: k, seq: m.seq }));
      last = mt.index + mt[0].length;
      k += 1;
    }
    push(text.slice(last));
    for (let i2 = k; i2 < n; i2++) { // 토큰 없는 첨부(레거시 라인 등) — 끝에 덧붙인다
      parts.push(" " + this._msgChipHtml({ kind: "remote", label: `Image #${i2 + 1}`, idx: i2, seq: m.seq }));
    }
    return parts.join("");
  }

  _msgChipHtml({ kind, label, thumb, path, idx, seq }) {
    return `<span class="chat-chip msg" data-kind="${kind}"` +
      (path ? ` data-path="${escapeHtml(path)}"` : "") +
      (idx != null ? ` data-idx="${idx}" data-mseq="${escapeHtml(String(seq))}"` : "") +
      ` title="${escapeHtml(path || label)}">` +
      (thumb ? `<img class="chat-chip-thumb" src="${thumb}" alt="">` : "") +
      `<span class="chat-chip-label">${escapeHtml(label)}</span></span>`;
  }

  // 원격 첨부 썸네일 자동 로드(사용자 확정) — 캐시로 1회만 받아 칩에 채운다. 실패 = 라벨 칩 유지.
  _hydrateMsgChips(row, m) {
    for (const chip of row.querySelectorAll('.chat-chip.msg[data-kind="remote"]')) {
      this._fetchAttachment(m.seq, Number(chip.dataset.idx))
        .then((att) => {
          if (!att || !att.base64 || !chip.isConnected || chip.querySelector(".chat-chip-thumb")) return;
          const img = document.createElement("img");
          img.className = "chat-chip-thumb";
          img.src = `data:${att.mediaType || "image/png"};base64,${att.base64}`;
          chip.prepend(img);
        })
        .catch(() => { /* 썸네일 없음 — 라벨 칩으로 남는다 */ });
    }
  }

  _fetchAttachment(seq, idx) {
    if (!this._chatId || !(idx >= 0)) return Promise.reject(new Error("첨부 없음"));
    const key = `${this._chatId}:${seq}:${idx}`;
    let pr = this._attCache.get(key);
    if (!pr) {
      pr = api.chatAttachment({
        chatId: this._chatId, seq, idx,
        ...(this.ctx.hostDeviceId() != null ? { hostDeviceId: this.ctx.hostDeviceId() } : {}),
      });
      this._attCache.set(key, pr);
      pr.catch(() => this._attCache.delete(key));
    }
    return pr;
  }

  // tool_result → 앞선 tool_use 카드 갱신. 짝을 못 찾으면(스냅샷 경계로 tool_use 가 잘림) 독립 카드.
  _fillResult(m) {
    const res = m.result || {};
    const card = res.toolUseId ? this._toolCards.get(res.toolUseId) : null;
    const body = this._resultBodyHtml(res);
    if (card) {
      card.mark.textContent = resultMark(res);
      card.mark.className = "chat-tool-mark " + resultClass(res);
      card.res.className = "chat-tool-result";
      // 질문 행의 결과는 박스/바이트 메타 없이 담백한 한 줄(TUI 의 "User declined …" 자리) —
      //  "사용자가 답하지 않고 넘어갔습니다" 를 박스+바이트 수로 감싸던 게 못생김의 진범(사용자 지적).
      card.res.innerHTML = card.q
        ? `<div class="chat-q-res">${escapeHtml(String(res.preview || "").trim() || "응답됨")}</div>`
        : body;
      // 결과 도착 = TUI 가 그 도구를 한 줄로 접는 순간(.done) — 사용자가 펼쳐 둔 행(.open)은 유지.
      // 편집 diff 는 접지 않는다 — TUI 도 Update 는 diff 를 펼쳐 둔다(이 대화의 핵심 정보).
      if (res.patch && card.row) card.row.dataset.diff = "1";
      if (card.row && card.row.dataset.fold === "1") card.row.classList.add("done");
      this._regroupTools();   // 방금 끝난 행이 묶음 경계를 바꿨을 수 있다
      return;
    }
    // 짝을 못 찾았고 보여줄 내용도 없으면 그리지 않는다(빈 카드 노이즈 방지).
    if (!body) return;
    const row = document.createElement("div");
    row.className = "chat-tool orphan";
    row.dataset.seq = String(m.seq);
    row.innerHTML =
      `<div class="chat-tool-head"><span class="chat-tool-mark ${resultClass(res)}">${resultMark(res)}</span>` +
      `<span class="chat-tool-label">도구 결과</span></div><div class="chat-tool-result">${body}</div>`;
    this._els.set(m.seq, row);
    this.scrollEl.appendChild(row);
  }

  _resultBodyHtml(res) {
    // 편집 결과는 **diff** 가 본문이다(TUI 와 같은 데이터). 상투 문구는 데몬이 이미 비웠다.
    if (res.patch) return this._patchHtml(res.patch);
    const preview = String(res.preview || "");
    const meta = resultMeta(res);
    if (!preview) return meta ? `<div class="chat-tool-meta">${escapeHtml(meta)}</div>` : "";
    const { head, rest } = clampLines(preview, CHAT.OUTPUT_CLAMP_LINES);
    return (
      `<pre class="chat-out" data-full="${escapeHtml(preview)}">${escapeHtml(head)}</pre>` +
      (rest ? `<button class="chat-out-more" type="button">${rest}줄 더 보기</button>` : "") +
      (meta ? `<div class="chat-tool-meta">${escapeHtml(meta)}</div>` : "")
    );
  }

  // ── 본문 위임 클릭 ──
  _onBodyClick(e) {
    // 보낸 말풍선의 인라인 첨부 칩 — 클릭=미리보기(컴포저 칩과 동일 규칙).
    const mchip = e.target.closest?.(".chat-chip.msg");
    if (mchip) {
      if (mchip.dataset.kind === "path") {
        const path = mchip.dataset.path || "";
        const name = path.split("/").pop() || path;
        const ext = (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
        const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tiff"]);
        this._openPreview({ path, name, ext, img: IMG.has(ext), b64: null });
        return;
      }
      if (mchip.dataset.kind === "local") {
        const rowEl = mchip.closest(".chat-msg");
        const seq = rowEl ? Number(rowEl.dataset.seq) : NaN;
        const msg = this._msgs.find((mm) => mm.seq === seq);
        const a = msg && msg.optAttach ? msg.optAttach.find((t) => t.path === mchip.dataset.path) : null;
        if (a) this._openPreview(a);
        return;
      }
      this._fetchAttachment(Number(mchip.dataset.mseq), Number(mchip.dataset.idx))
        .then((att) => {
          if (att && att.base64) this._showLightbox(`data:${att.mediaType || "image/png"};base64,${att.base64}`, { name: mchip.textContent || "이미지", path: "" });
          else this._setBanner("이미지를 불러올 수 없습니다.", "warn");
        })
        .catch(() => this._setBanner("이미지를 불러올 수 없습니다.", "warn"));
      return;
    }
    // 도구 묶음 요약 클릭 = 그 구간 펼치기(요약 제거 + 감춘 행 복구).
    const grp = e.target.closest?.(".chat-tool-group");
    if (grp) {
      let n = grp.nextElementSibling;
      while (n && n.classList?.contains("grouped")) { n.classList.remove("grouped"); n = n.nextElementSibling; }
      grp.remove();
      return;
    }
    // 편집 diff 더 보기 — 접힌 나머지 줄을 펼친다.
    const dmore = e.target.closest?.(".chat-diff-more");
    if (dmore) {
      const rest = dmore.parentElement?.querySelector(".chat-diff-rest");
      if (rest) { rest.classList.remove("hidden"); dmore.remove(); }
      return;
    }
    const copy = e.target.closest?.(".chat-code-copy");
    if (copy) {
      const pre = copy.closest(".chat-code")?.querySelector(".chat-code-pre");
      const txt = pre ? pre.textContent : "";
      if (txt) {
        navigator.clipboard?.writeText(txt).catch(() => {});
        copy.classList.add("done");
        copy.innerHTML = icons.check({ size: 13 });
        setTimeout(() => { copy.classList.remove("done"); copy.innerHTML = icons.copy({ size: 13 }); }, 1200);
      }
      return;
    }
    const link = e.target.closest?.(".chat-a");
    if (link) {
      e.preventDefault();
      const href = link.dataset.href;
      if (href) { api.openExternal(href).catch(() => {}); return; }
      // 파일 칩(`[라벨](경로)`) — 자동 로드는 안 하지만 누르면 연다: 이미지/영상은 앱 안에서 보고,
      //  그 외는 시스템 기본 앱(로컬)·IDE 로. 원격 PC 는 앱 안 미리보기만 가능하다.
      const chip = e.target.closest?.(".chat-file");
      if (chip) {
        const target = chip.dataset.target || "";
        const kind = chip.dataset.kind || "file";
        if (kind === "image" || kind === "video") {
          this._mediaBytes(target).then((r) => {
            if (r && !r.missing) this._showLightbox(`data:${r.mediaType};base64,${r.base64}`, { name: chip.dataset.name || "", path: target });
            else if (this.ctx.isLocal?.()) api.openPath(target).catch(() => {});
            else this._setBanner("이 파일은 미리 볼 수 없어요.", "warn");
          }).catch(() => { /* noop */ });
        } else if (this.ctx.isLocal?.()) {
          api.openPath(target).catch(() => this._setBanner("파일을 열 수 없어요.", "warn"));
        } else {
          this.ctx.openFile?.(target);
        }
      }
      return;
    }
    const more = e.target.closest?.(".chat-out-more");
    if (more) {
      const pre = more.previousElementSibling;
      if (pre && pre.dataset.full != null) { pre.textContent = pre.dataset.full; more.remove(); }
      return;
    }
    const open = e.target.closest?.(".chat-tool-open");
    if (open) {
      const p = open.dataset.path;
      if (p) this.ctx.openFile?.(p);
      return;
    }
    // 도구 행 머리 클릭 = 펼침/접기 토글(TUI 미러 — 접힌 한 줄이 기본, 상세는 눌러서).
    const thead = e.target.closest?.(".chat-tool-head");
    if (thead) {
      const trow = thead.closest(".chat-tool");
      if (trow && trow.dataset.fold === "1") { trow.classList.toggle("open"); return; }
    }
    const think = e.target.closest?.(".chat-thinking");
    if (think) {
      const full = think.dataset.full || "";
      const collapsed = think.dataset.collapsed === "1";
      think.dataset.collapsed = collapsed ? "0" : "1";
      const body = think.querySelector(".chat-think-body");
      if (body) body.textContent = collapsed ? full : full.slice(0, CHAT.THINKING_CHARS) + (full.length > CHAT.THINKING_CHARS ? "…" : "");
      return;
    }
  }

  // ── 전송 ──
  //  contenteditable 직렬화(칩→인용 경로) 텍스트를 데몬 chat.input 으로 — 데몬이 이미지 경로 조각을
  //  따로 bracketed paste 해 문장 중간이라도 [Image #N] 으로 변환한다(격리 실측). 실패 시 로컬 PTY 폴백.
  async _send() {
    const raw = this._ceText();
    this._reconcileChips();
    const att = this._attach.slice();
    if (!raw.trim()) return;
    const tid = this._tid != null ? this._tid : this.ctx.tid();
    if (tid == null) { this._setBanner("보낼 터미널이 없습니다.", "warn"); return; }
    // TUI 질문 다이얼로그가 떠 있는 동안의 chatInput 은 대화가 아니라 **다이얼로그에 타이핑**된다
    //  (숫자는 선택지를 고른다). 오조작을 막고 카드로 답하게 안내한다.
    if (this._tuiQuestion()) { this._setBanner("질문 다이얼로그가 떠 있어요 — 위 카드에서 답해주세요.", "warn"); return; }
    this._ceClear();
    this.ctx.setDraft?.("");
    this._attach = [];
    this._syncComposer();   // 초안이 비었으므로 전송 버튼을 즉시 비활성(눌러도 할 일이 없다)

    // 첫 메시지가 곧 대화를 만든다(훅이 바인딩을 쓴다) → 짧은 탐색 창을 열어 붙는 순간을 잡는다.
    //  창이 지나면 다시 느린 재확인으로 돌아간다(폴링 폭주 금지 — shouldReopenNoSession).
    if (this._noSession) this._probeUntil = Date.now() + CHAT.NO_SESSION_PROBE_MS;
    this._clearBlank();

    // 낙관 렌더 — 본문은 원문 그대로 두고, 첨부 경로 자리는 렌더러가 인라인 칩으로 그린다
    //  (컴포저와 같은 표현 — 2026-07-30 사용자 확정). 이미지 경로가 실리는 전송은 트랜스크립트에
    //  [Image #N] 으로 변환돼 남아 원문 예측이 불가 → any 매칭으로 걷는다.
    const seq = this._optSeq--;
    const opt = { seq, role: "user", kind: "text", text: raw.trim(), ts: Date.now(), hidden: false, optimistic: true, optAttach: att };
    this._msgs = [...this._msgs, opt];
    const el = this._buildRow(opt);
    this._els.set(seq, el);
    this.scrollEl.appendChild(el);
    const mayConvert = att.some((a) => a.img) || /'[^']+\.(png|jpe?g|gif|webp|bmp|heic|tiff)'/i.test(raw);
    this._pending.push({ key: optimisticKey(raw), at: Date.now(), seq, any: mayConvert });
    this._scrollToBottom();

    try {
      await api.chatInput({
        cwd: this._cwd(), tid, text: raw, submit: true, submitDelayMs: CHAT.SEND_ENTER_DELAY_MS,
        ...(this.ctx.hostDeviceId() != null ? { hostDeviceId: this.ctx.hostDeviceId() } : {}),
      });
    } catch (e) {
      // 데몬에 입력 주입기가 아직 배선되지 않았거나(NOT_IMPLEMENTED) 서버 경로가 막혔다 →
      //  이 pane 은 그 터미널에 이미 붙어 있으므로 로컬 PTY 로 같은 규칙(bracketed paste + 지연 Enter)
      //  으로 보낸다. 어느 경로든 "실행 중인 그 claude 세션"에 들어간다(별도 세션 금지).
      const ok = this.ctx.sendFallback?.(raw);
      if (!ok) {
        el.classList.add("failed");
        el.title = String(e || "전송 실패");
        this._setBanner("전송에 실패했습니다: " + String(e || "").slice(0, 120), "warn");
      }
    }
  }

  // ── 빈 상태(대화가 아직 없다) — 주류 에이전트 앱 형태 ────────────────────────────
  // 사용자 확정: ChatGPT/Claude/Gemini 앱처럼 **중앙 정렬 + 짧은 인사 한 줄**, 주인공은 컴포저다.
  //  · 오류·경고 프레이밍 금지(배너 없음). 설명문 최소 — 사용자는 텍스트를 읽지 않는다(이 프로젝트 규율).
  //  · 그렇다고 "아무 안내 없는 빈 화면"으로 두지도 않는다(왜 비었는지 몰라 불안해진다) → 글리프 + 한 줄.
  //  · `ambiguous`(어느 대화인지 단정 불가)일 때만 조용한 보조 액션 하나를 둔다.
  //    'not_started'/'none' 에는 두지 않는다: 고를 후보가 없거나, 이미 이 터미널의 대화가 확정돼 있다.
  _renderBlank() {
    if (!this.scrollEl) return;
    this._clearBlank();
    const wrap = document.createElement("div");
    wrap.className = "chat-blank";
    // 글리프는 붙어 있는 에이전트를 알면 그 로고(참고 앱들도 자기 로고를 쓴다), 모르면 말풍선.
    const mark = agentMarkHtml(this._agent, { size: 30 }) || icons.chat({ size: 30 });
    wrap.innerHTML =
      `<span class="chat-blank-ic">${mark}</span>` +
      `<div class="chat-blank-title">무엇이든 요청하세요</div>`;
    this.scrollEl.appendChild(wrap);
  }
  _clearBlank() { this.scrollEl?.querySelector(".chat-blank")?.remove(); }

  // ── `+` 파일 넣기(일반 에이전트 앱과 같은 컴포저 좌측 버튼) ──────────────────────
  // 무엇을 하는가: 워크스페이스 파일을 골라 **그 경로를 입력에 삽입**한다(업로드가 아니다).
  //  에이전트는 경로만 받으면 자기가 그 파일을 읽으므로, 내용을 서버로 올릴 이유가 없다 —
  //  경로 삽입이 프라이버시·용량·정확성 전부에서 우월하다(터미널 첨부 플로우와 같은 규율).
  // 목록 출처는 IDE 트리와 **같은 fs 제공자**(로컬 api / 원격은 makeRemoteFs) → 다른 PC 워크스페이스도
  //  같은 UI 로 고를 수 있고, 원격이면 LAN 직결·봉투 RPC 경로를 자동으로 탄다(remote-fs.js).
  _togglePicker() {
    if (this.pickEl) { this._closePicker(); return; }
    const wrap = document.createElement("div");
    wrap.className = "chat-pick";
    wrap.innerHTML =
      `<input class="chat-pick-q" type="text" placeholder="파일 이름" />` +
      `<div class="chat-pick-list"><div class="chat-pick-empty">불러오는 중…</div></div>`;
    this.el.querySelector(".chat-composer").appendChild(wrap);
    this.pickEl = wrap;
    this._pickFiles = null;
    const q = wrap.querySelector(".chat-pick-q");
    q.addEventListener("input", () => this._renderPicker(q.value));
    q.addEventListener("keydown", (e) => {
      e.stopPropagation();                       // ⌘F 등 전역 단축키가 이 입력을 가로채지 않게
      if (e.key === "Escape") { e.preventDefault(); this._closePicker(); this.inputEl?.focus(); return; }
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
    // 바깥 클릭으로 닫기 — 이 클릭 자체가 닫지 않도록 다음 틱에 등록(메뉴 관례, ide.js 와 동일).
    this._pickCloser = (e) => { if (!wrap.contains(e.target) && e.target !== this.plusEl) this._closePicker(); };
    setTimeout(() => document.addEventListener("mousedown", this._pickCloser, true), 0);
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
    const fs = this.ctx.fs?.();
    const root = this._cwd();
    if (!fs) { this._renderPicker(""); return; }
    try {
      // 깊이 4 = IDE 트리와 같은 값(더 깊이 파면 큰 리포에서 첫 응답이 눈에 띄게 늦다).
      const tree = await fs.fsTree(root, 4);
      if (!this.pickEl) return;
      this._pickFiles = flattenFiles(tree);
      this._renderPicker(this.pickEl.querySelector(".chat-pick-q")?.value || "");
    } catch (e) {
      if (!this.pickEl) return;
      this._pickFiles = [];
      // 실패를 조용히 빈 목록으로 만들지 않는다(원격 오프라인·권한 문제를 사용자가 알아야 한다).
      const list = this.pickEl.querySelector(".chat-pick-list");
      list.innerHTML = `<div class="chat-pick-empty">목록을 불러오지 못했습니다</div>`;
    }
  }

  _renderPicker(query) {
    if (!this.pickEl) return;
    const list = this.pickEl.querySelector(".chat-pick-list");
    if (this._pickFiles == null) { list.innerHTML = `<div class="chat-pick-empty">불러오는 중…</div>`; return; }
    const root = this._cwd() || "";
    const hit = filterFiles(this._pickFiles, root, query, CHAT.PICK_LIMIT);
    if (!hit.length) { list.innerHTML = `<div class="chat-pick-empty">일치하는 파일 없음</div>`; return; }
    list.innerHTML = hit.map((p) => {
      const r = relToRoot(root, p);
      const i = r.lastIndexOf("/");
      return `<div class="chat-pick-row" data-path="${escapeHtml(p)}">` +
        `<span class="chat-pick-name">${escapeHtml(i < 0 ? r : r.slice(i + 1))}</span>` +
        (i < 0 ? "" : `<span class="chat-pick-dir">${escapeHtml(r.slice(0, i))}</span>`) +
        `</div>`;
    }).join("");
  }

  // 고른 파일 = 워크스페이스 상대 경로를 커서 위치에 삽입(뒤에 공백 1칸 — 이어서 문장을 쓰게).
  _pickFile(full) {
    if (!full) return;
    const r = relToRoot(this._cwd() || "", full);
    this._closePicker();
    this._ceInsertText(r + " ");
  }

  // 짝 tool_result 가 도착한 tool_use id 집합 = "이미 답한 질문".
  //  트랜스크립트만으로 판정한다(승인 인박스와 대조하지 않는다) — TUI 가 질문을 계속 띄우는 근거와
  //  똑같은 근거를 쓴다: 응답이 없으면 결과 줄도 없다.
  _answeredToolIds() {
    const out = new Set();
    for (const m of this._msgs || []) {
      if (isResult(m) && m.result && m.result.toolUseId) out.add(m.result.toolUseId);
    }
    return out;
  }

  // 이 pane 에 지금 "선택형" 승인 카드가 떠 있는가(= 컴포저 위 도크가 같은 질문을 그리고 있다).
  //  (approvals.js 를 import 하면 순환이 된다 → 상태를 직접 읽는다. 규칙은 같다: cwd+win 엄격 일치.)
  _paneHasQuestionCard() {
    const cwd = this._cwd();
    if (!cwd || this._tid == null) return false;
    return (appState.approvals || []).some(
      (a) => (a.cwd || "") === cwd && a.win === this._tid &&
        (a.prompt?.kind === "choice" || !!a.prompt?.questions?.length)
    );
  }

  // TUI 로 폴백된(승인 카드가 회수된) 미응답 질문 — **마지막 표시 메시지**가 결과 없는 question 이고
  //  전체 질문 배열(questions, 데몬 0.1.148+)이 있을 때만. TUI 다이얼로그가 떠 있는 한 트랜스크립트는
  //  거기서 멈춰 있으므로 이 판정이 곧 "TUI 에 질문이 떠 있다"다(사용자 확정 2026-07-28: 채팅에도
  //  같은 질문 카드가 계속 떠 있어야 한다). 실제 화면 대조는 데몬 chat.answer 의 스크린 가드가 한다.
  _tuiQuestion() {
    if (this._paneHasQuestionCard()) return null;   // 승인 카드가 있으면 그 경로가 정본
    const answered = this._answeredToolIds();
    let last = null;
    for (const m of this._msgs || []) { if (isVisible(m) && !isResult(m)) last = m; }
    if (!last || last.kind !== "question") return null;
    if (last.tool && last.tool.id && answered.has(last.tool.id)) return null;
    const qs = last.questions;
    if (!Array.isArray(qs) || !qs.length || !qs.every((q) => Array.isArray(q.options) && q.options.length)) return null;
    return last;
  }

  // ── 승인 카드 슬롯(기능1) ──
  _renderApprovals() {
    if (!this.apprEl || !_approvalRenderer) return;
    const cwd = this._cwd();
    const tuiQ = this._tuiQuestion();
    _approvalRenderer(this.apprEl, {
      cwd, win: this._tid, visible: this._visible,
      // TUI 폴백 질문 — 승인 카드가 없을 때 approvals.js 가 같은 모양의 카드를 세우고,
      //  답은 chat.answer(다이얼로그 키 조작)로 보낸다. onAnswered = 낙관적 새로고침.
      tuiQuestion: tuiQ ? { msg: tuiQ, hostDeviceId: this.ctx.hostDeviceId?.(), onAnswered: () => this._tick() } : null,
    });
    // 질문 카드가 떴다/사라졌으면 대화 내역을 다시 그린다(감췄던 질문이 답과 함께 들어온다).
    const key = (this._paneHasQuestionCard() ? "a" : "-") + "|" + (tuiQ ? tuiQ.seq : "-");
    if (key !== this._heldKey) { this._heldKey = key; this._rebuild(); }
    this._syncWorking();
  }

  // ── 작업 중 표시 ──
  // 없으면 '아무 반응이 없다' 로 보인다(사용자 신고: 채팅에서 물었는데 조용해서 TUI 로 바꿔 보니
  //  실제로는 돌고 있었다). 판정은 데몬 push(agent_state)가 정본 — 트랜스크립트 모양만 보는 추정은
  //  codex 처럼 중간 설명을 계속 뱉는 에이전트에서 '마지막이 assistant 텍스트 = 안 바쁨' 으로 접힌다.
  //  승인 카드가 떠 있으면 표시하지 않는다 — 무엇을 기다리는지는 그 카드가 이미 말한다.
  _syncWorking() {
    if (!this.scrollEl) return;
    const st = agentStateOf(this._cwd(), this._tid);
    // ★ needsInput 은 busy 가 아니다(2026-07-30 실사고): 턴이 끝나고 60초 유휴가 지나면 훅
    //  Notification(idle_prompt)이 needsInput 을 세우는데 — 이건 "**사용자** 입력 대기"다.
    //  TUI 는 이때 그냥 유휴 컴포저인데 채팅만 "작업 중…"이 영영 남았다(사용자 신고).
    const busy = !!st && st.state === "working";
    const on = busy && !this._paneHasQuestionCard() && !this._tuiQuestion() && !this._pending.length;
    let el = this.scrollEl.querySelector(".chat-working");
    if (!on) { el?.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-working";
      el.innerHTML = `<span class="chat-working-dot"></span><span>작업 중…</span>`;
    }
    this.scrollEl.appendChild(el); // 항상 맨 아래로
  }

  // ── 보조 ──
  _atBottom() {
    const s = this.scrollEl;
    if (!s) return true;
    return s.scrollHeight - s.scrollTop - s.clientHeight < CHAT.AT_BOTTOM_PX;
  }
  _scrollToBottom() {
    // 애니메이션 금지 — 스트리밍 중 부드러운 스크롤은 매 델타마다 튀어 읽을 수 없게 된다.
    if (this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }
  _syncJump() {
    if (!this.jumpEl) return;
    const show = !this._atBottom();
    this.jumpEl.classList.toggle("hidden", !show);
    this.jumpNEl.textContent = show && this._unread ? String(Math.min(this._unread, 99)) : "";
  }
  // ★ 숨겨진 동안(display:none)에는 절대 높이를 쓰지 않는다. 그 상태의 `scrollHeight` 는 0 이므로
  //  `height:0px` 이 박혀 컴포저가 납작하게 깨진다 — 사용자가 "처음에 너무 작게 깨져 있다"고 신고한
  //  그 증상이고, 아무 글자나 입력하면 그때 재측정돼 정상으로 보이던 것도 같은 이유다.
  //  `offsetParent === null` 이 곧 "레이아웃에 없다" 이므로 그 프레임은 건너뛰고, 보이게 되는 순간
  //  `setVisible()` 이 rAF 안에서 다시 부른다.
  // 컴포저 상태 동기화 — 전송 버튼 활성/모델 칩/플레이스홀더. 순수 판정은 chat-model 에 있다.
  //  ★ 전송 버튼을 "빈 입력에도 눌리는 것처럼" 두지 않는다: 눌러도 아무 일이 없는 버튼은 거짓 affordance 다
  //   (표시 정직성). 숨기지 않고 **disabled + 흐리게** 두는 이유는 위치 학습을 깨지 않기 위함이다.
  // ── 슬래시 명령 팔레트 ────────────────────────────────────────────────────────
  // TUI 에서 `/` 를 치면 뜨는 그 목록을 채팅에서도 낸다(사용자 요청 2026-08-02).
  //  · 여는 조건 = **초안 전체가 `/토큰` 한 개**일 때(공백을 치면 인자 모드 → 닫힌다). TUI 와 같은 감각.
  //  · 고르면 **컴포저에 채워 넣는다**(사용자 확정) — 인자 있는 명령(`/objectstore 백업 위치`)을 위해서,
  //    그리고 실수로 실행되지 않게 하려고. 실행은 언제나 사용자가 전송을 눌러야 일어난다.
  //  · 목록의 'tui' 분류(편집기 열림·세션 종료 등)는 **고를 수 없게** 흐리게 둔다(죽은 실행 금지).
  //    직접 타이핑하면 그대로 나가므로 막는 게 아니라 권하지 않는 것이다.
  _slashQuery() { return slashQuery(this._ceText()); }

  _syncSlash() {
    const q = this._slashQuery();
    if (q == null) { this._closeCmds(); return; }
    if (!this.cmdsEl) this._openCmds();
    this._renderCmds(q);
    void this._loadCmds();
  }

  _openCmds() {
    const wrap = document.createElement("div");
    wrap.className = "chat-cmds";
    wrap.innerHTML = `<div class="chat-cmds-list"><div class="chat-cmds-empty">불러오는 중…</div></div>`;
    this.el.querySelector(".chat-composer").appendChild(wrap);
    this.cmdsEl = wrap;
    this._cmdIdx = 0;
    wrap.addEventListener("mousedown", (e) => {
      // mousedown 으로 처리한다 — click 은 컴포저 blur 뒤라 캐럿이 날아간다.
      const row = e.target.closest?.(".chat-cmds-row");
      if (!row || row.classList.contains("off")) return;
      e.preventDefault();
      this._pickCmd(row.dataset.name);
    });
  }

  _closeCmds() {
    this.cmdsEl?.remove();
    this.cmdsEl = null;
  }

  async _loadCmds() {
    if (this._cmds || this._cmdsLoading) return;
    this._cmdsLoading = true;
    try {
      const r = await this._cmdsRpc();
      this._cmds = Array.isArray(r && r.items) ? r.items : [];
    } catch (_) {
      this._cmds = [];   // 실패해도 팔레트만 비는 것이고, 직접 타이핑은 그대로 동작한다
    } finally {
      this._cmdsLoading = false;
      if (this.cmdsEl) this._renderCmds(this._slashQuery() || "");
    }
  }

  _cmdsRpc() {
    const cwd = this._cwd(), tid = this._tid, agent = this._agent || undefined;
    if (this.ctx.isLocal?.()) return api.chatLocal("chat.commands", { cwd, tid, agent });
    return api.chatCommands({ cwd, tid, agent, hostDeviceId: this.ctx.hostDeviceId?.() });
  }

  _cmdMatches(q) { return filterCommands(this._cmds || [], q, CHAT.CMD_MAX); }

  _renderCmds(q) {
    if (!this.cmdsEl) return;
    const list = this.cmdsEl.querySelector(".chat-cmds-list");
    if (!this._cmds) { list.innerHTML = `<div class="chat-cmds-empty">불러오는 중…</div>`; return; }
    const rows = this._cmdMatches(q);
    this._cmdRows = rows;
    if (this._cmdIdx >= rows.length) this._cmdIdx = 0;
    if (!rows.length) { list.innerHTML = `<div class="chat-cmds-empty">맞는 명령이 없습니다</div>`; return; }
    list.innerHTML = rows.map((c, i) => {
      const off = c.chat === "tui";
      return `<div class="chat-cmds-row${i === this._cmdIdx ? " on" : ""}${off ? " off" : ""}" data-name="${escapeHtml(c.name)}">` +
        `<span class="chat-cmds-name">${escapeHtml(c.name)}</span>` +
        `<span class="chat-cmds-desc">${escapeHtml(c.desc || "")}</span>` +
        commandBadges(c).map((b) => `<span class="chat-cmds-badge">${escapeHtml(b)}</span>`).join("") +
        `</div>`;
    }).join("");
    list.querySelector(".chat-cmds-row.on")?.scrollIntoView({ block: "nearest" });
  }

  _moveCmd(d) {
    const rows = this._cmdRows || [];
    if (!rows.length) return;
    let i = this._cmdIdx;
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (rows[i].chat !== "tui") break;      // 고를 수 없는 행은 건너뛴다
    }
    this._cmdIdx = i;
    this._renderCmds(this._slashQuery() || "");
  }

  _pickCmd(name) {
    const n = String(name || "").trim();
    if (!n) return;
    this._closeCmds();
    // 채워넣기 = 이름 + 공백 한 칸. 인자를 이어 치거나 그대로 전송한다.
    this.inputEl.textContent = n + " ";
    this._caretToEnd();
    this._syncComposer();
    this.ctx.setDraft?.(this._ceText().slice(0, CHAT.DRAFT_MAX));
    this.inputEl.focus();
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

  _syncComposer() {
    const has = !!composerHasText(this._ceText());
    if (this.sendEl) this.sendEl.disabled = !has;
    if (this.inputEl) {
      const name = agentDisplayName(this._agent);
      this.inputEl.dataset.ph = name ? name + "에게 요청" : "메시지 보내기"; // :empty::before 가 그린다
    }
  }
  // TUI statusline 미러 — 데몬이 화면에서 뽑은 원문 줄(ANSI 포함)을 컴포저 위에 그대로 그린다
  //  (2026-07-30 사용자 확정: 구조화 재구성이 아니라 **원문 미러**). 색은 터미널 팔레트와 동일.
  _setStatusLines(lines) {
    if (!this.statusEl) return;
    const arr = Array.isArray(lines) ? lines.filter((l) => typeof l === "string" && l.trim()) : [];
    if (!arr.length) { this.statusEl.classList.add("hidden"); this.statusEl.innerHTML = ""; return; }
    const pal = termTheme();
    this.statusEl.innerHTML = arr
      .map((l) => `<div class="chat-statusline-row">${ansiToHtml(l, pal)}</div>`)
      .join("");
    this.statusEl.classList.remove("hidden");
  }
  // statusline push(control) 반영 — 줄(미러)과 모드(알약)는 **독립 필드**다(커스텀 statusline 이
  //  있으면 모드가 실린 푸터는 미러 대상에서 빠지기 때문).
  //  ★ 전환 요청 중에는 모드를 무시한다: 데몬 폴링(3s)이 전환 **직전** 화면을 들고 있다가 도착하면
  //   방금 바꾼 값이 옛 모드로 한 번 되돌아 그려진다(앱도 같은 이유로 에코 가드를 둔다).
  _applyStatusFrame(control) {
    this._setStatusLines((control && control.lines) || []);
    if (!this._modeBusy && control && control.mode) this._setMode(control.mode);
    // dialog 는 **항상** 반영한다(null 이면 카드를 걷는다) — 없어진 화면의 유령 카드가 최악이다.
    if (control && "dialog" in control) this._setDialog(control.dialog);
  }

  // ── TUI 선택 화면 미러 카드 ────────────────────────────────────────────────────
  // `/model`·`/permissions` 처럼 선택 화면을 여는 명령을 채팅에서 보내면, TUI 에는 화면이 뜨는데
  //  채팅은 아무 반응이 없어 "먹통"으로 읽힌다(사용자 확정 2026-08-02: 카드로 미러하고 채팅에서 고른다).
  //  카드의 버튼 = 그 번호 키. 데몬이 **화면 제목을 대조한 뒤에만** 키를 친다(다른 질문 오답 방지).
  _setDialog(d) {
    const same = JSON.stringify(this._dialog || null) === JSON.stringify(d || null);
    this._dialog = d || null;
    if (same) return;
    this._renderDialog();
  }

  _renderDialog() {
    const d = this._dialog;
    if (!this.dlgEl) return;
    if (!d) { this.dlgEl.classList.add("hidden"); this.dlgEl.innerHTML = ""; return; }
    this.dlgEl.classList.remove("hidden");
    this.dlgEl.innerHTML =
      `<div class="chat-tuidlg-head">` +
        `<span class="chat-tuidlg-title">${escapeHtml(d.title || "")}</span>` +
        `<button class="chat-tuidlg-x" type="button" title="닫기(Esc)">✕</button>` +
      `</div>` +
      (d.desc ? `<div class="chat-tuidlg-desc">${escapeHtml(d.desc)}</div>` : "") +
      `<div class="chat-tuidlg-opts">` +
        (d.options || []).map((o) =>
          `<button class="chat-tuidlg-opt" type="button" data-n="${o.n}">` +
          `<span class="chat-tuidlg-n">${o.n}</span>` +
          `<span class="chat-tuidlg-label">${escapeHtml(o.label || "")}</span>` +
          (o.desc ? `<span class="chat-tuidlg-odesc">${escapeHtml(o.desc)}</span>` : "") +
          `</button>`).join("") +
      `</div>` +
      (d.footer ? `<div class="chat-tuidlg-foot">${escapeHtml(d.footer)}</div>` : "");
  }

  async _driveDialog(body) {
    const cwd = this._cwd(), tid = this._tid;
    if (this.ctx.isLocal?.()) return api.chatLocal("chat.dialog", { cwd, tid, ...body });
    return api.chatDialog({ cwd, tid, ...body, hostDeviceId: this.ctx.hostDeviceId?.() });
  }

  async _pickDialog(n, cancel) {
    const d = this._dialog;
    if (!d || this._dlgBusy) return;
    this._dlgBusy = true;
    this.dlgEl?.classList.add("busy");
    try {
      const r = await this._driveDialog(cancel ? { cancel: true, expect: d.title } : { pick: n, expect: d.title });
      if (this._disposed) return;
      this._setDialog((r && r.dialog) || null);   // 이어지는 확인 화면이 있으면 그게 곧 다음 카드가 된다
      this._setBanner("");
    } catch (e) {
      if (this._disposed) return;
      const msg = String(e || "");
      if (/DIALOG_MISMATCH/.test(msg)) this._setBanner("터미널 화면이 바뀌었어요 — 다시 확인해 주세요.", "warn");
      else if (/DIALOG_GONE/.test(msg)) { this._setDialog(null); }
      else this._setBanner("선택을 전달하지 못했어요 — TUI 를 확인해 주세요.", "warn");
    } finally {
      this._dlgBusy = false;
      this.dlgEl?.classList.remove("busy");
    }
  }

  // ── 에이전트 권한 모드 알약 + 목록 ─────────────────────────────────────────────
  // TUI 에서 shift+tab 으로만 바꿀 수 있는 모드를, 채팅에서도 **보이고 바꿀 수 있게** 한다
  //  (2026-08-01 사용자 요청). 표시 라벨은 TUI 원문 그대로 — 화면과 채팅이 같은 단어를 쓴다.
  //  전환은 데몬이 그 터미널에 shift+tab 을 눌러 주고 화면으로 검증한다(chat.mode).
  _setMode(mode) {
    const view = agentModeView(mode);
    // plan 은 codex 전용 부가 상태다 — 여기서 떨어뜨리면 목록의 계획 체크가 영영 꺼진 채로 남는다.
    this._mode = view ? { id: view.id, label: view.label, symbol: view.symbol, plan: !!(mode && mode.plan) } : null;
    if (!this.modeEl) return;
    if (!view) { this.modeEl.classList.add("hidden"); this._closeModeMenu(); return; }
    this.modeEl.classList.remove("hidden");
    this.modeEl.querySelector(".chat-mode-label").textContent = view.label;
    this.modeEl.dataset.mode = view.id;
    if (this.modeMenuEl) this._renderModeMenu();
  }

  // 모드 RPC 한 곳 — 이 PC 터미널이면 사이드카 데몬 직결(1~2ms), 원격 PC 면 back 릴레이(그 PC 의 데몬).
  //  같은 머신인데 클라우드를 왕복하던 것이 체감 지연의 큰 몫이었다(2026-08-02 실측).
  _modeRpc(mode) {
    const cwd = this._cwd(), tid = this._tid;
    if (this.ctx.isLocal?.()) return api.chatLocal("chat.mode", { cwd, tid, ...(mode ? { mode } : {}) });
    return api.chatMode({
      cwd, tid, ...(mode ? { mode } : {}),
      ...(this.ctx.hostDeviceId() != null ? { hostDeviceId: this.ctx.hostDeviceId() } : {}),
    });
  }
  // 스냅샷/캐치업도 같은 규칙 — 이 PC 터미널이면 사이드카 직결, 원격이면 back 릴레이.
  //  ★ 로컬 직결은 **오프라인에서도** 동작한다(같은 머신) — 서버가 죽어도 내 PC 채팅은 열린다.
  _openRpc(body) {
    if (this.ctx.isLocal?.()) return api.chatLocal("chat.open", body);
    return api.chatOpen(body);
  }
  _sinceRpc(q) {
    if (this.ctx.isLocal?.()) return api.chatLocal("chat.since", q);
    return api.chatSince(q);
  }

  // 모드만 즉시 재확인(조회 전용 — mode 를 안 보내면 데몬이 **지금 화면**을 읽어 현재 값을 준다).
  async _refreshMode() {
    const tid = this._tid;
    if (tid == null || this._modeBusy) return;
    try {
      const r = await this._modeRpc(null);
      if (!this._disposed && !this._modeBusy && r && r.mode) this._setMode(r.mode);
    } catch (_) { /* 폴링/캐치업이 안전망 */ }
  }

  _toggleModeMenu() {
    if (this.modeMenuEl) { this._closeModeMenu(); return; }
    if (!this._mode) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-mode-menu";
    this.el.querySelector(".chat-composer").appendChild(wrap);
    this.modeMenuEl = wrap;
    this._renderModeMenu();
    wrap.addEventListener("click", (e) => {
      const row = e.target.closest?.(".chat-mode-row");
      if (row && !row.classList.contains("busy")) this._pickMode(row.dataset.mode);
    });
    // 바깥 클릭으로 닫기 — 이 클릭 자체가 닫지 않도록 다음 틱에 등록(`+` 피커와 같은 관례).
    this._modeCloser = (e) => { if (!wrap.contains(e.target) && !this.modeEl.contains(e.target)) this._closeModeMenu(); };
    setTimeout(() => document.addEventListener("mousedown", this._modeCloser, true), 0);
  }

  _closeModeMenu() {
    if (this._modeCloser) document.removeEventListener("mousedown", this._modeCloser, true);
    this._modeCloser = null;
    this.modeMenuEl?.remove();
    this.modeMenuEl = null;
  }

  _renderModeMenu() {
    if (!this.modeMenuEl) return;
    const cur = this._mode || null;
    // 양쪽 다 shift+tab 이 바꾸는 것만 담는다 — claude 는 순환, codex 는 두 상태 전환.
    const hint = agentModeChoices(cur).some((m) => m.id.startsWith("codex"))
      ? "TUI 에서는 shift+tab 으로 전환합니다 · 권한은 /permissions"
      : "TUI 에서는 shift+tab 으로 순환합니다";
    this.modeMenuEl.innerHTML = agentModeChoices(cur).map((m) => {
      const on = agentModeIsOn(m, cur);
      const busy = this._modeBusy;
      // 모드 심볼(⏸/⏵⏵)은 그리지 않는다(사용자 확정 2026-08-02: 왼쪽 아이콘 제거) — 라벨이 정본.
      return `<div class="chat-mode-row${on ? " on" : ""}${busy ? " busy" : ""}" data-mode="${m.id}">` +
        `<span class="chat-mode-row-body"><span class="chat-mode-row-label">${escapeHtml(m.label)}</span>` +
        `<span class="chat-mode-row-desc">${escapeHtml(m.desc)}</span></span>` +
        `<span class="chat-mode-row-mark">${on ? "✓" : ""}</span></div>`;
    }).join("") + `<div class="chat-mode-hint">${escapeHtml(hint)}</div>`;
  }

  async _pickMode(id) {
    if (!id || this._modeBusy) return;
    if (this._mode && this._mode.id === id) { this._closeModeMenu(); return; }
    const tid = this._tid;
    if (tid == null) return;
    // ★ 낙관 적용(사용자 신고 2026-08-02 "선택하면 즉시 닫히고 적용돼야 하는데 느리다"):
    //  누른 즉시 **목록을 닫고 알약을 목표 모드로** 바꾼다. 실제 전환(데몬이 TUI 를 순환)은 뒤에서
    //  끝나고, 실패하면 아래 catch 가 옛 모드로 되돌리고 사유를 배너로 알린다(조용한 거짓 금지).
    const prev = this._mode;
    const next = { id, label: agentModeLabel({ id }) };
    this._modeBusy = true;
    this._setMode(next);
    this._closeModeMenu();
    this.modeEl?.classList.add("busy");    // 확정 전까지 흐리게(진행 중 표시)
    try {
      const r = await this._modeRpc(id);
      if (this._disposed) return;
      this._setMode((r && r.mode) || next);
      this._setBanner("");
    } catch (e) {
      if (!this._disposed) this._setMode(prev);   // 낙관 적용 취소 — 화면이 거짓말하지 않게
      if (this._disposed) return;
      const msg = String(e || "");
      // 실패를 조용히 삼키지 않는다 — 모드가 안 바뀐 채로 "바꿨다"고 보이는 것이 최악이다.
      if (/MODE_BLOCKED/.test(msg)) this._setBanner("지금은 승인/질문 다이얼로그가 떠 있어 모드를 바꿀 수 없어요.", "warn");
      else if (/MODE_UNREACHABLE/.test(msg)) this._setBanner("이 세션에서는 그 모드로 바꿀 수 없어요.", "warn");
      else if (/MODE_UNKNOWN/.test(msg)) this._setBanner("터미널 화면에서 모드를 읽지 못했어요 — TUI 를 확인해 주세요.", "warn");
      else this._setBanner("모드를 바꾸지 못했어요 — 잠시 후 다시 시도해 주세요.", "warn");
    } finally {
      this._modeBusy = false;
      this.modeEl?.classList.remove("busy");
      if (this.modeMenuEl) this._renderModeMenu();
    }
  }

  _setBanner(msg, tone) {
    if (!this.bannerEl) return;
    const on = !!msg;
    this.bannerEl.classList.toggle("hidden", !on);
    this.bannerEl.className = "chat-banner" + (on ? " " + (tone || "info") : " hidden");
    this.bannerEl.textContent = msg || "";
  }
  // 에이전트가 종료됐을 때 pane 이 부른다 — 모드는 유지하고 배너만(사용자 의사 없이 화면 전환 금지).
  setAgentGone(gone) {
    if (gone) this._setBanner("에이전트가 종료됐어요 · 토글로 터미널(TUI)로 돌아갈 수 있습니다", "warn");
    else if (/에이전트가 종료/.test(this.bannerEl?.textContent || "")) this._setBanner("");
  }

  dispose() {
    this._disposed = true;
    this._stopPoll();
    this._closePicker(); // document 캡처 리스너를 남기면 pane 이 사라진 뒤에도 계속 산다
    this._closeCmds();
    this._closeModeMenu();
    _live.delete(this);
    // ⚠ chat.close 를 부르지 않는다. 데몬의 tail 은 **파일 단위로 공유**되고 구독자 refcount 가 없어서,
    //  이 창을 닫으면 같은 대화를 보고 있는 다른 기기(폰)의 chatId 까지 무효화된다(그쪽은 CHAT_GONE →
    //  재오픈 사이클을 겪는다). 데몬이 5분 idle 로 스스로 축출하므로 놔두는 것이 정답이다.
    //  (모바일 useChatStream 도 같은 이유로 close 를 생략한다 — 양 클라이언트 정책이 일치해야 한다.)
    this.el?.remove();
  }
}
