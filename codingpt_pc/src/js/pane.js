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
  //   onSplit(paneId,dir), onClosePane(paneId), onMoveTab(srcId,index,dstId), persist }
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

    const ctrls = document.createElement("div");
    ctrls.className = "pane-ctrls";
    if (this.node.kind === "terminal") {
      ctrls.append(headBtn(icons.terminal, "새 터미널", () => this.addTab()));
    }
    if (this.node.kind === "ide") {
      ctrls.append(headBtn(icons.sidebar, "탐색기 토글", () => this.ide?.toggleTree()));
    }
    ctrls.append(
      headBtn(icons.splitRight, "우측 분할 (⌘D)", () => this.ctx.onSplit?.(this.id, "h")),
      headBtn(icons.splitDown, "하단 분할 (⌘⇧D)", () => this.ctx.onSplit?.(this.id, "v")),
      headBtn(icons.code, "IDE 열기", () => this.ctx.onIde?.(this.id)),
      headBtn(icons.globe, "프리뷰 열기", () => this.ctx.onPreview?.(this.id))
    );
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
    this._setupImeGuard();
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
        const r = (!tab.fresh && (await this.ctx.claimPoolWin?.())) || (await api.newWindow(this.ctx.localPath || ""));
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
  // WKWebView(사파리 엔진)는 IME 조합 중 term.write 렌더(커서 이동 → xterm 이 숨은 textarea 를
  //  커서 위치로 옮김)가 조합을 강제 커밋시켜 한글이 자소 단위로 깨진다("실시간"→"ㅅ시가").
  //  → 조합 중엔 출력(직전 음절 에코 등)을 버퍼링하고, 조합이 끝난 뒤 플러시한다.
  _setupImeGuard() {
    const ta = this.term?.textarea;
    if (!ta) return;
    this._composing = false;
    this._imeBuf = null; // null = 조합 아님, [] = 조합 중 출력 홀드
    this._imeHeld = 0;
    ta.addEventListener("compositionstart", () => {
      this._composing = true;
      if (!this._imeBuf) this._imeBuf = [];
    });
    ta.addEventListener("compositionend", () => {
      this._composing = false;
      // xterm 자체 조합 확정(setTimeout 0) 이후에, 그리고 다음 음절 조합이 이미 시작되지 않았을 때만 플러시.
      setTimeout(() => { if (!this._composing) this._imeFlush(); }, 30);
    });
    ta.addEventListener("blur", () => { this._composing = false; this._imeFlush(); });
  }
  _imeFlush() {
    const buf = this._imeBuf;
    this._imeBuf = null;
    this._imeHeld = 0;
    if (buf && this.term) for (const b of buf) this.term.write(b);
  }
  _termOut(data) {
    if (this._imeBuf) {
      this._imeBuf.push(data);
      this._imeHeld += data.length || 0;
      if (this._imeHeld > 262144) this._imeFlush(); // 조합 중 폭주 출력 안전판(사실상 미발생)
      return;
    }
    this.term?.write(data);
  }
  _onData(b64) {
    this._termOut(b64ToBytes(b64));
  }
  _onExit() {
    this.term?.write("\r\n\x1b[90m[세션 종료]\x1b[0m\r\n");
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
