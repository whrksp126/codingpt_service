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
import {
  CHAT, isVisible, isResult, toolLabel, resultMark, resultClass, resultMeta,
  mergeMsgs, lastSeqOf, clampLines, fmtTime, optimisticKey, dropMatchedOptimistic, fmtBytes,
  relToRoot, filterFiles, insertPathAt, flattenFiles, shouldReopenNoSession,
  composerHasText, agentDisplayName,
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
      <div class="chat-composer">
        <button class="chat-jump hidden" type="button" title="맨 아래로">${icons.arrowDown({ size: 15 })}<span class="chat-jump-n"></span></button>
        <div class="chat-box">
          <textarea class="chat-input" rows="1" placeholder="메시지 보내기"></textarea>
          <div class="chat-ctl">
            <button class="chat-plus" type="button" title="파일 넣기">${icons.plus({ size: 18 })}</button>
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
    this.inputEl = el.querySelector(".chat-input");
    this.sendEl = el.querySelector(".chat-send");
    this.plusEl = el.querySelector(".chat-plus");

    this.inputEl.value = String(this.ctx.getDraft?.() || "");
    this._autoGrow();
    this._syncComposer();

    this.scrollEl.addEventListener("scroll", () => {
      if (this._atBottom()) { this._unread = 0; this._syncJump(); }
    });
    this.jumpEl.addEventListener("click", () => { this._scrollToBottom(); this._unread = 0; this._syncJump(); });
    this.sendEl.addEventListener("click", () => this._send());
    this.plusEl.addEventListener("click", (e) => { e.stopPropagation(); this._togglePicker(); });
    this.inputEl.addEventListener("input", () => {
      this._autoGrow();
      this._syncComposer();
      this.ctx.setDraft?.(this.inputEl.value.slice(0, CHAT.DRAFT_MAX));
    });
    // 컴포저 키맵(PC): Enter=전송 · Shift+Enter=개행 · ⌘Enter=전송(Claude 앱 습관) · Esc=TUI 복귀.
    //  ⌘ 단축키(⌘F/⌘D/⌘W…)는 그대로 통과시켜 앱 동작을 유지한다.
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) {
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
      this._renderApprovals();
      // 진입 즉시 컴포저 포커스(레이아웃 확정 후 한 프레임 뒤 — display 전환 직후 focus 는 무시된다)
      requestAnimationFrame(() => {
        if (!this._visible || this._disposed) return;
        this._autoGrow();      // 이제 레이아웃에 있으므로 여기서 처음 제대로 측정된다(위 ★ 항)
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
        const r = await api.chatOpen({
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

  async _catchUp() {
    if (!this._chatId || this._catching) return;
    this._catching = true;
    try {
      const r = await api.chatSince({ chatId: this._chatId, sinceSeq: this._lastSeq, epoch: this._epoch });
      if (this._disposed) return;
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
    const wasBottom = this._atBottom();
    const { list, added } = mergeMsgs(this._msgs, incoming);
    this._msgs = list;
    this._lastSeq = lastSeqOf(list, this._lastSeq);
    // 스냅샷이거나 과거 구간이 섞여 왔으면(순서 역행) 전체 재조립 — 부분 append 는 순서가 깨진다.
    const backfill = added.some((m) => m.seq < this._maxSeq);
    if (snapshot || backfill) this._rebuild();
    else this._appendAll(added);
    if (snapshot || wasBottom) { this._scrollToBottom(); this._unread = 0; }
    else if (added.length) this._unread += added.filter((m) => isVisible(m) && !isResult(m)).length;
    this._syncJump();
    this._syncWorking();
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
    const held = this._heldToolIds();
    for (const m of msgs) {
      if (m.seq > this._maxSeq) this._maxSeq = m.seq;
      // tool 결과는 앞선 tool_use 카드의 결과 슬롯으로 합친다(별도 카드 금지 — Claude 앱과 동일).
      //  hidden 결과(구버전 형태의 빈 자리표시)는 그리지 않는다.
      if (isResult(m)) {
        // 아직 도크가 들고 있는 질문의 결과는 넘긴다 — 질문 카드가 없어 고아 행이 생긴다.
        //  요청이 해소되면 held 가 비고 _rebuild 가 질문+결과를 함께 그린다.
        if (m.result && m.result.toolUseId && held.has(m.result.toolUseId)) continue;
        if (!m.hidden) this._fillResult(m);
        continue;
      }
      if (!isVisible(m)) continue;
      // ★ 답하기 전 질문은 **대화 내역에 넣지 않는다**(사용자 확정 2026-07-28). 컴포저 위 승인 카드가
      //  같은 선택지를 이미 그리고 있어서, 넣으면 같은 질문이 화면에 두 번 보인다. 답하면 요청이
      //  해소되고 held 에서 빠져 그때 대화에 자연스럽게 들어간다.
      if (m.kind === "question" && m.tool && m.tool.id && held.has(m.tool.id)) continue;
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
    // 시각은 행마다 노출하지 않고 툴팁으로만 — 말풍선마다 시간을 박으면 대화 리듬이 깨진다(Claude 앱 동일).
    if (m.ts) row.title = fmtTime(m.ts);
    const text = String(m.text || "");

    if (m.role === "user" && (m.kind === "text" || m.kind === "slash")) {
      row.className = "chat-msg chat-msg-user" + (m.kind === "slash" ? " slash" : "") + (m.optimistic ? " optimistic" : "");
      row.innerHTML = m.kind === "slash"
        ? `<span class="chat-slash">${escapeHtml(text)}</span>`
        : escapeHtml(text).replace(/\n/g, "<br>");
      if (m.attachments && m.attachments.length) row.appendChild(this._buildAttachments(m));
      return row;
    }
    if (m.role === "assistant" && m.kind === "text") {
      row.className = "chat-msg chat-msg-assistant";
      row.innerHTML = renderMarkdown(text);
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
      if (id) this._toolCards.set(id, { mark: head.querySelector(".chat-tool-mark"), res });
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

  _truncNote() {
    const n = document.createElement("div");
    n.className = "chat-trunc";
    n.textContent = "…내용이 잘렸습니다(원문은 터미널에서 확인)";
    return n;
  }

  _buildQuestion(q) {
    const wrap = document.createElement("div");
    wrap.className = "chat-q";
    const opts = (q.options || []).map((o) =>
      `<div class="chat-q-opt"><span class="chat-q-label">${escapeHtml(o.label)}</span>` +
      (o.description ? `<span class="chat-q-desc">${escapeHtml(o.description)}</span>` : "") + `</div>`).join("");
    wrap.innerHTML =
      (q.header ? `<div class="chat-q-head">${escapeHtml(q.header)}</div>` : "") +
      (q.question ? `<div class="chat-q-text">${escapeHtml(q.question)}</div>` : "") +
      opts +
      // 실제 응답은 승인 카드(기능1)로 한다 — 여기 버튼을 두면 두 경로가 경합한다.
      `<div class="chat-q-note">선택은 아래 승인 카드에서 응답합니다</div>`;
    return wrap;
  }

  _buildAttachments(m) {
    const wrap = document.createElement("div");
    wrap.className = "chat-attach";
    for (const a of m.attachments) {
      const b = document.createElement("button");
      b.className = "chat-attach-chip";
      b.type = "button";
      b.dataset.seq = String(m.seq);
      b.dataset.idx = String(a.idx);
      b.textContent = `이미지 ${fmtBytes(a.bytes)}`;
      wrap.appendChild(b);
    }
    return wrap;
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
      card.res.innerHTML = body;
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
      if (href) api.openExternal(href).catch(() => {});
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
    const think = e.target.closest?.(".chat-thinking");
    if (think) {
      const full = think.dataset.full || "";
      const collapsed = think.dataset.collapsed === "1";
      think.dataset.collapsed = collapsed ? "0" : "1";
      const body = think.querySelector(".chat-think-body");
      if (body) body.textContent = collapsed ? full : full.slice(0, CHAT.THINKING_CHARS) + (full.length > CHAT.THINKING_CHARS ? "…" : "");
      return;
    }
    const chip = e.target.closest?.(".chat-attach-chip");
    if (chip && !chip.dataset.loaded) this._loadAttachment(chip);
  }

  async _loadAttachment(chip) {
    if (!this._chatId) return;
    chip.disabled = true;
    try {
      const a = await api.chatAttachment({ chatId: this._chatId, seq: chip.dataset.seq, idx: chip.dataset.idx });
      if (!a || a.missing || !a.base64) { chip.textContent = "이미지를 불러올 수 없습니다"; return; }
      const img = document.createElement("img");
      img.className = "chat-attach-img";
      img.src = `data:${a.mediaType || "image/png"};base64,${a.base64}`;
      chip.replaceWith(img);
    } catch (_) {
      chip.disabled = false;
      chip.textContent = "다시 시도";
    }
  }

  // ── 전송 ──
  async _send() {
    const raw = String(this.inputEl.value || "");
    if (!raw.trim()) return;
    const tid = this._tid != null ? this._tid : this.ctx.tid();
    if (tid == null) { this._setBanner("보낼 터미널이 없습니다.", "warn"); return; }
    this.inputEl.value = "";
    this.ctx.setDraft?.("");
    this._autoGrow();
    this._syncComposer();   // 초안이 비었으므로 전송 버튼을 즉시 비활성(눌러도 할 일이 없다)

    // 첫 메시지가 곧 대화를 만든다(훅이 바인딩을 쓴다) → 짧은 탐색 창을 열어 붙는 순간을 잡는다.
    //  창이 지나면 다시 느린 재확인으로 돌아간다(폴링 폭주 금지 — shouldReopenNoSession).
    if (this._noSession) this._probeUntil = Date.now() + CHAT.NO_SESSION_PROBE_MS;
    this._clearBlank();

    // 낙관 렌더 — 트랜스크립트에 같은 텍스트의 user 메시지가 오면 치운다(dedup 키=trim 앞 200자/60s).
    const seq = this._optSeq--;
    const opt = { seq, role: "user", kind: "text", text: raw, ts: Date.now(), hidden: false, optimistic: true };
    this._msgs = [...this._msgs, opt];
    const el = this._buildRow(opt);
    this._els.set(seq, el);
    this.scrollEl.appendChild(el);
    this._pending.push({ key: optimisticKey(raw), at: Date.now(), seq });
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
    const ta = this.inputEl;
    const r = relToRoot(this._cwd() || "", full);
    const { value, caret } = insertPathAt(ta.value, ta.selectionStart, ta.selectionEnd, r);
    ta.value = value;
    ta.setSelectionRange(caret, caret);
    this.ctx.setDraft?.(ta.value.slice(0, CHAT.DRAFT_MAX));
    this._autoGrow();
    this._syncComposer();   // 경로가 들어가 입력이 비지 않았으므로 전송 버튼을 활성화한다
    this._closePicker();
    ta.focus();
  }

  // 지금 승인 카드가 들고 있는 질문의 tool_use id 집합 — 대화 내역에서 감출 대상.
  //  (approvals.js 를 import 하면 순환이 된다 → 상태를 직접 읽는다. 규칙은 같다: cwd+win 엄격 일치.)
  _heldToolIds() {
    const cwd = this._cwd();
    const out = new Set();
    if (!cwd || this._tid == null) return out;
    for (const a of appState.approvals || []) {
      if ((a.cwd || "") !== cwd || a.win !== this._tid) continue;
      if (a.toolUseId) out.add(a.toolUseId);
    }
    return out;
  }

  // ── 승인 카드 슬롯(기능1) ──
  _renderApprovals() {
    if (!this.apprEl || !_approvalRenderer) return;
    const cwd = this._cwd();
    _approvalRenderer(this.apprEl, { cwd, win: this._tid, visible: this._visible });
    // 들고 있는 질문 집합이 바뀌었으면 대화 내역을 다시 그린다(감췄던 질문이 답과 함께 들어온다).
    const key = [...this._heldToolIds()].sort().join(",");
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
    const busy = !!st && (st.state === "working" || st.state === "needsInput");
    const on = busy && !this._heldToolIds().size && !this._pending.length;
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
  _autoGrow() {
    const t = this.inputEl;
    if (!t) return;
    if (t.offsetParent === null) return;
    t.style.height = "auto";
    t.style.height = Math.min(Math.max(t.scrollHeight, 22), 150) + "px";
  }

  // 컴포저 상태 동기화 — 전송 버튼 활성/모델 칩/플레이스홀더. 순수 판정은 chat-model 에 있다.
  //  ★ 전송 버튼을 "빈 입력에도 눌리는 것처럼" 두지 않는다: 눌러도 아무 일이 없는 버튼은 거짓 affordance 다
  //   (표시 정직성). 숨기지 않고 **disabled + 흐리게** 두는 이유는 위치 학습을 깨지 않기 위함이다.
  _syncComposer() {
    const has = !!composerHasText(this.inputEl?.value);
    if (this.sendEl) this.sendEl.disabled = !has;
    if (this.inputEl) {
      const name = agentDisplayName(this._agent);
      this.inputEl.placeholder = name ? name + "에게 요청" : "메시지 보내기";
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
    _live.delete(this);
    // ⚠ chat.close 를 부르지 않는다. 데몬의 tail 은 **파일 단위로 공유**되고 구독자 refcount 가 없어서,
    //  이 창을 닫으면 같은 대화를 보고 있는 다른 기기(폰)의 chatId 까지 무효화된다(그쪽은 CHAT_GONE →
    //  재오픈 사이클을 겪는다). 데몬이 5분 idle 로 스스로 축출하므로 놔두는 것이 정답이다.
    //  (모바일 useChatStream 도 같은 이유로 close 를 생략한다 — 양 클라이언트 정책이 일치해야 한다.)
    this.el?.remove();
  }
}
