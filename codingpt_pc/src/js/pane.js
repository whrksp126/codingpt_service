// pane.js — pane 하나 = 자체 탭 헤더(cmux식) + 본문(터미널/프리뷰).
//  · 터미널 pane: 탭 배열(각 탭=tmux window), 활성 탭 window 를 grouped view 가 표시. 탭 전환=select-window.
//  · 헤더: [탭들][+] ......... [우측분할][하단분할][닫기]. 탭은 드래그해 다른 pane 으로 이동 가능.
//  · 프리뷰 pane: URL 바 + iframe.
//  로컬=Rust pty, 클라우드=백엔드 relay WS. OSC 9/777/99+벨 → 알림 콜백.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { IdeView } from "./ide.js";

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const SearchAddon = window.SearchAddon?.SearchAddon;

const registry = new Map();
export function getPane(paneId) {
  return registry.get(paneId) || null;
}
export function dispatchData(paneId, b64) {
  registry.get(paneId)?._onData(b64);
}
export function dispatchExit(paneId) {
  registry.get(paneId)?._onExit();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function headBtn(iconFn, title, onClick) {
  const b = document.createElement("button");
  b.className = "pane-ctrl";
  b.title = title;
  b.innerHTML = iconFn({ size: 15 });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const TERM_THEME = {
  background: "#0A0D14",
  foreground: "#E2E8F0",
  cursor: "#34D399",
  cursorAccent: "#0A0D14",
  selectionBackground: "#264F78",
  black: "#0A0D14",
  brightBlack: "#334155",
};

export class PaneView {
  // node: tiling leaf, ctx: { localPath, isLocal, onFocus, onNotify, onSurfacesChanged,
  //   onClosePane(paneId), onMoveTab(srcId,index,dstId), persist }
  constructor(node, ctx) {
    this.node = node;
    this.id = node.id;
    this.ctx = ctx;
    this.mounted = false;
    this.term = null;
    this.fit = null;
    this.ws = null;
    this.ro = null;
    this.el = document.createElement("div");
    this.el.className = "pane";
    this.el.dataset.paneId = this.id;
    this.el.addEventListener("mousedown", () => this.ctx.onFocus?.(this.id), true);
    registry.set(this.id, this);

    this.head = document.createElement("div");
    this.head.className = "pane-head";
    this.body = document.createElement("div");
    this.body.className = "pane-body";
    this.el.append(this.head, this.body);

    if (node.kind === "terminal") this._buildTerminal();
    else if (node.kind === "ide") this._buildIde();
    else this._buildFrame(node.kind);
    this.buildHead();
  }

  // ── 헤더(탭 + 컨트롤) ──
  buildHead() {
    this.head.innerHTML = "";
    const tabsEl = document.createElement("div");
    tabsEl.className = "pane-tabs";
    if (this.node.kind === "terminal") {
      this.node.tabs.forEach((t, i) => {
        const tab = document.createElement("div");
        tab.className = "ptab" + (i === this.node.active ? " active" : "");
        tab.draggable = true;
        const label = t.title || (typeof t.win === "number" ? "터미널 " + t.win : "터미널");
        tab.innerHTML = `<span class="ptab-ic">${icons.terminal({ size: 13 })}</span><span class="ptab-title">${escapeHtml(label)}</span>`;
        const x = document.createElement("span");
        x.className = "ptab-x";
        x.innerHTML = icons.x({ size: 11 });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(i);
        });
        tab.appendChild(x);
        tab.addEventListener("click", () => this.switchTab(i));
        // 포인터 기반 드래그(WKWebView 에서 HTML5 draggable 불안정 → 텍스트 드래그 방지).
        tab.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".ptab-x")) return;
          e.preventDefault(); // 텍스트 선택/네이티브 드래그 차단
          this.ctx.onTabDragStart?.(this.id, i, e);
        });
        tabsEl.appendChild(tab);
      });
    } else {
      const isIde = this.node.kind === "ide";
      const lbl = document.createElement("div");
      lbl.className = "ptab active static";
      lbl.innerHTML = `<span class="ptab-ic">${(isIde ? icons.code : icons.globe)({ size: 13 })}</span><span class="ptab-title">${isIde ? "IDE" : "프리뷰"}</span>`;
      const x = document.createElement("span");
      x.className = "ptab-x";
      x.innerHTML = icons.x({ size: 11 });
      x.addEventListener("click", (e) => { e.stopPropagation(); this.ctx.onClosePane?.(this.id); });
      lbl.appendChild(x);
      // IDE/프리뷰 탭도 잡아 pane 통째 이동(index<0).
      lbl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".ptab-x")) return;
        e.preventDefault();
        this.ctx.onTabDragStart?.(this.id, -1, e);
      });
      tabsEl.appendChild(lbl);
    }

    // 추가류 버튼(새 터미널/분할/IDE/프리뷰)은 상단 워크스페이스 헤더의 통합 추가 버튼으로 이동
    //  (활성 pane 기준 자동 배치) — pane 헤더에는 pane 전용 컨트롤만 남긴다. 단축키(⌘D 등)는 유지.
    const ctrls = document.createElement("div");
    ctrls.className = "pane-ctrls";
    if (this.node.kind === "ide") {
      ctrls.append(headBtn(icons.sidebar, "탐색기 토글", () => this.ide?.toggleTree()));
    }
    this.head.append(tabsEl, ctrls);
  }

  // ── 터미널 본문 ──
  _buildTerminal() {
    this.termEl = document.createElement("div");
    this.termEl.className = "pane-term";
    this.body.appendChild(this.termEl);
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "SF Mono", Consolas, monospace',
      scrollback: 10000,
      convertEol: false,
      theme: TERM_THEME,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    if (SearchAddon) {
      try {
        this.searchAddon = new SearchAddon();
        this.term.loadAddon(this.searchAddon);
      } catch (_) {}
    }
    this.term.onData((d) => this._write(d));
    // 탭 제목의 원천 = 풀 window 이름("터미널 N", 전 기기 공유) — xterm 타이틀 이벤트로 덮지 않는다.
    this._registerOsc(9, (data) => this.ctx.onNotify?.(this.id, "", data));
    this._registerOsc(777, (data) => {
      const parts = String(data).split(";");
      if (parts[0] === "notify") this.ctx.onNotify?.(this.id, parts[1] || "", parts.slice(2).join(";"));
    });
    this._registerOsc(99, (data) => this.ctx.onNotify?.(this.id, "", String(data).replace(/^.*?;/, "")));
    if (this.term.onBell) this.term.onBell(() => this.ctx.onNotify?.(this.id, "", "알림"));
  }
  _registerOsc(ident, cb) {
    try {
      this.term.parser.registerOscHandler(ident, (data) => {
        try {
          cb(data);
        } catch (_) {}
        return true;
      });
    } catch (_) {}
  }
  _refreshTabLabels() {
    const titles = this.head.querySelectorAll(".ptab .ptab-title");
    this.node.tabs.forEach((t, i) => {
      if (titles[i]) titles[i].textContent = t.title || (typeof t.win === "number" ? "터미널 " + t.win : "터미널");
    });
  }

  // 내장 IDE(파일트리 + CodeMirror).
  _buildIde() {
    this.ide = new IdeView(this.ctx.localPath || "", this.body, {
      openPath: this.node.openPath || null,
      paneId: this.id,
      paneDropZone: this.ctx.paneDropZone,
      onFileSplit: this.ctx.onFileSplit,
    });
  }

  // preview pane — 네이티브 임베디드 webview(iframe 아님 → X-Frame-Options 무관, 구글 등 다 뜸).
  //  주소창(DOM) + host(DOM placeholder) 위에 Rust 가 webview 를 얹어 위치/가시성 동기화.
  _buildFrame() {
    const bar = document.createElement("div");
    bar.className = "preview-bar";
    const input = document.createElement("input");
    input.className = "preview-url";
    input.placeholder = "URL 또는 검색어 (예: localhost:3000 · 날씨)";
    input.value = this.node.url || "";
    this.previewInput = input;
    const go = document.createElement("button");
    go.className = "btn small";
    go.textContent = "이동";
    bar.append(input, go);

    // 스마트 주소창: URL/호스트/포트면 이동, 아니면 웹 검색(네이티브 webview 라 결과도 pane 안에 표시).
    const load = (raw) => {
      let u = (raw || "").trim();
      if (!u) return;
      const isUrl = /^https?:\/\//i.test(u);
      const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)([:/]|$)/i.test(u);
      const isHostPort = /^[\w-]+:\d+([/?#]|$)/.test(u);
      const isDomain = /^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(u);
      if (isUrl || isLocal || isHostPort || isDomain) {
        if (!isUrl) u = isLocal || isHostPort ? "http://" + u : "https://" + u;
      } else {
        u = "https://www.google.com/search?q=" + encodeURIComponent(u);
      }
      this.node.url = u;
      this.previewUrl = u;
      input.value = u;
      api.previewNavigate(this.id, u).catch(() => {});
      this._previewKey = ""; // 강제 재동기화(없으면 생성)
      this.ctx.persist?.();
    };
    go.addEventListener("click", () => load(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") load(input.value); });

    const reload = document.createElement("button");
    reload.className = "pane-ctrl";
    reload.title = "새로고침";
    reload.innerHTML = icons.refresh({ size: 14 });
    reload.addEventListener("click", () => { if (this.previewUrl) { api.previewNavigate(this.id, this.previewUrl).catch(() => {}); } });
    const ext = document.createElement("button");
    ext.className = "pane-ctrl";
    ext.title = "외부 브라우저에서 열기";
    ext.innerHTML = icons.external({ size: 14 });
    ext.addEventListener("click", () => { if (this.previewUrl) api.openExternal(this.previewUrl).catch(() => {}); });
    bar.append(reload, ext);

    const host = document.createElement("div");
    host.className = "preview-host";
    host.innerHTML = `<div class="preview-empty">URL 또는 검색어를 입력하세요</div>`;
    this.previewHost = host;
    this.previewUrl = this.node.url || "";
    this.body.append(bar, host);
  }

  // ── 마운트 ──
  async mount() {
    if (this.mounted) return;
    this.mounted = true;
    if (this.node.kind === "ide") {
      this.ide.mount();
      this.ro = new ResizeObserver(() => this.ide.refresh());
      this.ro.observe(this.el);
      return;
    }
    if (this.node.kind === "preview") {
      this._startPreviewSync();
      return;
    }
    if (this.node.kind !== "terminal") return;
    this.term.open(this.termEl);
    this._setupInput();
    this._fitNow();
    const tab = this.node.tabs[this.node.active] || this.node.tabs[0];
    const win = await this._ensureWin(tab);
    this._openChannel(win);
    this.ro = new ResizeObserver(() => this._fitNow());
    this.ro.observe(this.el);
  }

  async _ensureWin(tab) {
    if (this.ctx.isLocal && (tab.win === "new" || tab.win == null)) {
      try {
        // 풀의 미배치 터미널 먼저 입양(첫 진입 시 남발 방지) → 없으면 풀에 새 터미널 생성(전 기기 공유).
        //  '+'로 만든 탭(fresh)은 입양 없이 반드시 새로 생성(사용자가 새 터미널을 명시 요청).
        const r = (!tab.fresh && (await this.ctx.claimPoolWin?.())) || (await api.newWindow(this.ctx.localPath || "", this.id));
        tab.win = r.index;
        if (r.name) tab.title = r.name;
      } catch (_) {
        tab.win = 0;
      }
      delete tab.fresh;
      this.ctx.onSurfacesChanged?.();
    }
    return tab.win;
  }

  // 이 pane 뷰에 풀 window 링크 + 선택(탭 전환/드롭 이동 공용).
  _view(win) {
    if (typeof win === "number") api.viewWindow(this.ctx.localPath || "", this.id, win).catch(() => {});
  }

  // ── 탭 조작 ──
  async addTab() {
    if (this.node.kind !== "terminal" || !this.ctx.isLocal) return;
    const tab = { win: "new", title: "", fresh: true };
    this.node.tabs.push(tab);
    this.node.active = this.node.tabs.length - 1;
    this.buildHead();
    const win = await this._ensureWin(tab);
    // await 사이 탭이 다른 pane 으로 드래그돼 사라졌을 수 있음 → 아직 이 pane 소속일 때만 반영.
    if (!this.node.tabs.includes(tab)) return;
    this.buildHead(); // 풀이 부여한 이름 반영
    this._view(win);
    this.ctx.persist?.();
    this.focus();
  }
  async switchTab(i) {
    if (i === this.node.active) {
      this.focus();
      return;
    }
    this.node.active = i;
    this.buildHead();
    const win = await this._ensureWin(this.node.tabs[i]);
    this._view(win);
    this.ctx.persist?.();
    this.focus();
  }
  closeTab(i) {
    const tab = this.node.tabs[i];
    // 풀에서 완전 삭제 — 모든 기기에서 사라진다(공유 내역).
    if (this.ctx.isLocal && typeof tab.win === "number") api.killWindow(this.ctx.localPath || "", tab.win).catch(() => {});
    this.node.tabs.splice(i, 1);
    if (!this.node.tabs.length) {
      this.ctx.onClosePane?.(this.id);
      return;
    }
    if (this.node.active >= this.node.tabs.length) this.node.active = this.node.tabs.length - 1;
    this.buildHead();
    this._view(this.node.tabs[this.node.active].win);
    this.ctx.onSurfacesChanged?.();
    this.ctx.persist?.();
  }
  // 드롭으로 이동해 온 탭을 활성화(뷰 링크 + select).
  async activateWin(win) {
    this._view(win);
    this.buildHead();
    this.focus();
  }

  // ── 채널(로컬 pty / 클라우드 WS) ──
  async _openChannel(win) {
    const { cols, rows } = this.term;
    if (this.ctx.isLocal) {
      api.ptyOpen(this.id, this.ctx.localPath || "", win ?? 0, cols || 80, rows || 24).catch((e) => {
        this.term.write("\r\n\x1b[31m터미널 연결 실패: " + e + "\x1b[0m\r\n");
        this._scheduleReopen(2500); // 일시 오류(서버 재기동 중 등)에 고착되지 않게 자동 재시도
      });
    } else {
      try {
        const { token, wsBase } = await api.cloudTerminalStart(this.ctx.localPath || "");
        const ws = new WebSocket(`${wsBase}/api/daemon/terminal/${token}`);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        ws.onopen = () => this._resize(this.term.cols, this.term.rows);
        ws.onmessage = (e) => {
          this._termOut(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
        };
        ws.onclose = () => this.term.write("\r\n\x1b[90m[연결 종료]\x1b[0m\r\n");
      } catch (e) {
        this.term.write("\r\n\x1b[31m클라우드 터미널 실패: " + e + "\x1b[0m\r\n");
      }
    }
  }
  _write(d) {
    if (this.ctx.isLocal) api.ptyWrite(this.id, d).catch(() => {});
    else if (this.ws && this.ws.readyState === 1) this.ws.send(new TextEncoder().encode(d));
  }
  _resize(cols, rows) {
    if (this.ctx.isLocal) api.ptyResize(this.id, cols, rows).catch(() => {});
    else if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
  // ── 입력 인터셉트 — WKWebView(사파리 엔진) 한글 IME 깨짐의 근본 해법 ──
  //  xterm 기본 키 처리는 macOS IME 조합 키에도 개입(preventDefault/keyup 의 textarea.value 클리어)해
  //  조합을 키마다 강제 커밋시킨다("실시간"→"ㅅ시가"). 모바일 TerminalWebView 에서 검증된 방식 이식:
  //  xterm 키보드를 전부 끄고(attachCustomKeyEventHandler=false + document 캡처 단계에서 input/
  //  composition 차단), textarea 'input' 의 증가분(delta)만 직접 전송한다 — 조합 중에도 백스페이스-
  //  치환으로 실시간 반영되고, 조합 자체는 맨 textarea 처럼 IME 가 온전히 소유한다.
  //  ⌘ 조합은 통과 — 앱 단축키(⌘F/⌘D/⌘1-8)와 복사/붙여넣기(xterm paste 핸들러)가 그대로 동작.
  _setupInput() {
    const ta = this.term?.textarea;
    if (!ta) return;
    this.term.attachCustomKeyEventHandler(() => false); // xterm 키 처리 비활성(전송은 아래가 전담)
    this._sentBuf = "";
    const SEQ = {
      Enter: "\r", Tab: "\t", Backspace: "\x7f", Escape: "\x1b", Delete: "\x1b[3~",
      ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
      Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
    };
    const resetBuf = () => { this._sentBuf = ""; try { ta.value = ""; } catch (_) {} };
    const onKeydown = (e) => {
      if (e.target !== ta) return;
      if (e.isComposing || e.keyCode === 229) return; // 조합 중 키는 IME 소유(Enter=확정 포함)
      if (e.metaKey) return;                          // ⌘ = 앱 단축키/브라우저 기본(복사·붙여넣기)
      if (e.ctrlKey && e.key && e.key.length === 1) {
        const c = e.key.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) {
          this._write(String.fromCharCode(c - 96)); resetBuf();
          e.preventDefault(); e.stopImmediatePropagation(); return;
        }
      }
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) { // 로컬 스크롤백
        this.term.scrollPages(e.key === "PageUp" ? -1 : 1);
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      const seq = SEQ[e.key];
      if (seq) {
        this._write(seq); resetBuf();
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      // 인쇄 가능한 글자는 기본 흐름(textarea 삽입 → input 델타)에 맡긴다.
    };
    const onInput = (e) => {
      if (e.target !== ta) return;
      e.stopImmediatePropagation(); // xterm 의 input 핸들러 차단(중복 전송 방지)
      const v = ta.value || "";
      if (v === this._sentBuf) return;
      let i = 0;
      const n = Math.min(v.length, this._sentBuf.length);
      while (i < n && v.charAt(i) === this._sentBuf.charAt(i)) i++;
      let out = "";
      for (let k = this._sentBuf.length; k > i; k--) out += "\x7f"; // 바뀐/지운 뒷부분 제거
      out += v.slice(i);                                            // 새 꼬리 전송
      if (out) this._write(out);
      this._sentBuf = v;
    };
    // xterm CompositionHelper 차단 — 조합 표시는 위 델타 에코가 터미널 안에서 직접 보여준다(모바일 동일).
    const onComp = (e) => { if (e.target === ta) e.stopImmediatePropagation(); };
    const onCompEnd = (e) => {
      if (e.target !== ta) return;
      e.stopImmediatePropagation();
      // 확정 직후 input(확정 텍스트 반영)이 처리된 다음 틱에 버퍼 리셋 — 다음 입력은 새로 시작.
      setTimeout(() => resetBuf(), 0);
    };
    // 포커스만 해도 이 pane 크기로 리사이즈 — view(select)가 클라이언트 크기로 resize-window 한다.
    const onFocus = () => {
      const t = this.node.tabs?.[this.node.active];
      if (t && typeof t.win === "number") this._view(t.win);
    };
    ta.addEventListener("focus", onFocus);
    // 내부 클릭 — 이미 포커스된 터미널은 focus 이벤트가 다시 안 떠서 위 경로가 안 타므로,
    //  클릭 자체로도 크기를 회수한다(다른 기기가 이 창을 자기 크기로 바꿨을 수 있음). 1.2s 스로틀.
    let lastClaim = 0;
    const onMouseDown = () => {
      const n = Date.now();
      if (n - lastClaim < 1200) return;
      lastClaim = n;
      onFocus();
    };
    this.termEl?.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("compositionstart", onComp, true);
    document.addEventListener("compositionupdate", onComp, true);
    document.addEventListener("compositionend", onCompEnd, true);
    this._inputDispose = () => {
      ta.removeEventListener("focus", onFocus);
      this.termEl?.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("compositionstart", onComp, true);
      document.removeEventListener("compositionupdate", onComp, true);
      document.removeEventListener("compositionend", onCompEnd, true);
    };
  }
  _termOut(data) {
    this.term?.write(data);
  }
  _onData(b64) {
    this._termOut(b64ToBytes(b64));
  }
  // attach 가 끊겼다(다른 기기가 이 터미널/마지막 터미널을 닫아 tmux 서버까지 죽었을 수 있음).
  //  모바일 웹뷰는 자동 재접속하는데 PC 는 여기서 끝이라 "새 터미널이 생겨도 못 넘어오는" 문제가
  //  있었다 → 풀에 window 가 다시 생기면 유효한 win 으로 자동 재연결한다.
  //  풀이 빈 동안은 대기만 — 여기서 창을 만들면 기기 간 생성 레이스로 유령 터미널이 생긴다.
  _onExit() {
    this.term?.write("\r\n\x1b[90m[세션 종료 — 재연결 대기]\x1b[0m\r\n");
    if (this.node.kind !== "terminal" || !this.ctx.isLocal) return;
    this._reopenTries = 0;
    this._scheduleReopen(1500);
  }
  _scheduleReopen(delay) {
    clearTimeout(this._reopenTimer);
    this._reopenTimer = setTimeout(async () => {
      if (this._reopenStop || !this.mounted) return;
      const tab = this.node.tabs?.[this.node.active];
      if (!tab) return;
      let wins = [];
      try { wins = (await api.listWindows(this.ctx.localPath || "")) || []; } catch (_) { /* 서버 다운 */ }
      if (this._reopenStop) return;
      if (!wins.length) {
        this._reopenTries = (this._reopenTries || 0) + 1;
        this._scheduleReopen(Math.min(1500 * this._reopenTries, 10000));
        return;
      }
      // 죽은 win 은 풀의 첫 터미널로 갈아탄다(리컨실러가 탭 목록은 따로 정리).
      if (typeof tab.win !== "number" || !wins.some((w) => w.index === tab.win)) {
        tab.win = wins[0].index;
        if (wins[0].name) tab.title = wins[0].name;
        this.buildHead();
        this.ctx.persist?.();
      }
      const { cols, rows } = this.term || {};
      api.ptyOpen(this.id, this.ctx.localPath || "", tab.win ?? 0, cols || 80, rows || 24)
        .then(() => this.term?.write("\x1b[90m[재연결됨]\x1b[0m\r\n"))
        .catch(() => this._scheduleReopen(3000));
    }, delay);
  }
  _fitNow() {
    if (!this.term) return;
    try {
      this.fit.fit();
    } catch (_) {}
    const { cols, rows } = this.term;
    if (cols && rows) this._resize(cols, rows);
  }

  // 프리뷰 webview 위치/가시성을 rAF 로 DOM host 에 맞춰 동기화(항상 최상단이라 위치 추적 필요).
  _startPreviewSync() {
    this._disposed = false;
    this._previewKey = "";
    const tick = () => {
      if (this._disposed || this.node.kind !== "preview") return;
      const host = this.previewHost;
      if (host && document.body.contains(host)) {
        const r = host.getBoundingClientRect();
        const modalOpen = !!document.querySelector(".settings-modal:not(.hidden)");
        const dragging = document.body.classList.contains("tab-dragging");
        const visible = r.width > 2 && r.height > 2 && !modalOpen && !dragging;
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), visible, this.previewUrl].join("|");
        if (key !== this._previewKey) {
          this._previewKey = key;
          if (this.previewUrl) {
            api.previewSync(this.id, this.previewUrl, r.left, r.top, r.width, r.height, visible).catch(() => {});
          }
        }
      }
      this._previewRaf = requestAnimationFrame(tick);
    };
    this._previewRaf = requestAnimationFrame(tick);
  }

  focus() {
    this.term?.focus();
  }

  // ── 활성 영역 검색(⌘F/Ctrl+F) — 터미널은 스크롤백, IDE 는 열린 파일 내부 ──
  openSearch() {
    if (this.node.kind === "ide") { this.ide?.openSearch(); return; }
    if (this.node.kind === "terminal") { this._openTermSearch(); return; }
  }

  _openTermSearch() {
    if (!this.searchAddon) return;
    if (this._searchBar) { this._searchInput.focus(); this._searchInput.select(); return; }
    const bar = document.createElement("div");
    bar.className = "pane-search";
    bar.innerHTML = `
      <span class="pane-search-ic">${icons.search({ size: 13 })}</span>
      <input class="pane-search-input" type="text" placeholder="터미널 검색" />
      <span class="pane-search-count">0/0</span>
      <button class="pane-search-btn" data-a="prev" title="이전 (⇧Enter)">${icons.chevronUp({ size: 14 })}</button>
      <button class="pane-search-btn" data-a="next" title="다음 (Enter)">${icons.chevronDown({ size: 14 })}</button>
      <button class="pane-search-btn" data-a="close" title="닫기 (Esc)">${icons.x({ size: 14 })}</button>`;
    this.body.appendChild(bar);
    this._searchBar = bar;
    const input = bar.querySelector(".pane-search-input");
    const count = bar.querySelector(".pane-search-count");
    this._searchInput = input;
    const deco = {
      matchBackground: "#4d3b12",
      activeMatchBackground: "#c78b1e",
      matchOverviewRuler: "#c78b1e",
      activeMatchColorOverviewRuler: "#c78b1e",
    };
    const opts = () => ({ decorations: deco, caseSensitive: false });
    if (!this._searchResDisposer && this.searchAddon.onDidChangeResults) {
      this._searchResDisposer = this.searchAddon.onDidChangeResults((r) => {
        if (!r || !r.resultCount) count.textContent = "0/0";
        else count.textContent = `${(r.resultIndex ?? -1) + 1}/${r.resultCount}`;
      });
    }
    const doFind = (back) => {
      const q = input.value;
      if (!q) { try { this.searchAddon.clearDecorations?.(); } catch (_) {} count.textContent = "0/0"; return; }
      try { back ? this.searchAddon.findPrevious(q, opts()) : this.searchAddon.findNext(q, opts()); } catch (_) {}
    };
    input.addEventListener("input", () => doFind(false));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doFind(e.shiftKey); }
      else if (e.key === "Escape") { e.preventDefault(); this._closeSearch(); }
    });
    bar.querySelector('[data-a="prev"]').addEventListener("click", () => { doFind(true); input.focus(); });
    bar.querySelector('[data-a="next"]').addEventListener("click", () => { doFind(false); input.focus(); });
    bar.querySelector('[data-a="close"]').addEventListener("click", () => this._closeSearch());
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  _closeSearch() {
    try { this.searchAddon?.clearDecorations?.(); } catch (_) {}
    this._searchBar?.remove();
    this._searchBar = null;
    this._searchInput = null;
    this.term?.focus();
  }
  refit() {
    if (this.term) this._fitNow();
    this.ide?.refresh();
  }
  dispose() {
    registry.delete(this.id);
    this._reopenStop = true;
    clearTimeout(this._reopenTimer);
    try { this._inputDispose?.(); } catch (_) {}
    try { this._searchResDisposer?.dispose?.(); } catch (_) {}
    try {
      this.ro?.disconnect();
    } catch (_) {}
    this.ide?.dispose();
    if (this.node.kind === "preview") {
      this._disposed = true;
      if (this._previewRaf) cancelAnimationFrame(this._previewRaf);
      api.previewClose(this.id).catch(() => {});
    }
    if (this.ctx.isLocal && this.node.kind === "terminal") api.ptyClose(this.id).catch(() => {});
    try {
      this.ws?.close();
    } catch (_) {}
    try {
      this.term?.dispose();
    } catch (_) {}
    this.el.remove();
  }
}
