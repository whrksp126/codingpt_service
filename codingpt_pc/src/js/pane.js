// pane.js — pane 하나 = 자체 탭 헤더(cmux식) + 본문(터미널/프리뷰).
//  · 터미널 pane: 탭 배열(각 탭=tmux window), 활성 탭 window 를 grouped view 가 표시. 탭 전환=select-window.
//  · 헤더: [탭들][+] ......... [우측분할][하단분할][닫기]. 탭은 드래그해 다른 pane 으로 이동 가능.
//  · 프리뷰 pane: URL 바 + iframe.
//  로컬=Rust pty, 클라우드=백엔드 relay WS. OSC 9/777/99+벨 → 알림 콜백.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { IdeView } from "./ide.js";
import { makeRemoteFs } from "./remote-fs.js";
import { termFontPx, onScaleChange } from "./display-scale.js";
import { toggleChiiDevtools, dtPageSlot, dtOnPageLoaded, dtDispose } from "./devtools.js";

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const SearchAddon = window.SearchAddon?.SearchAddon;

const registry = new Map();
export function getPane(paneId) {
  return registry.get(paneId) || null;
}
// 표시 배율 변경 → 열려있는 모든 pane 즉시 반영.
//  터미널: fontSize 교체 + fit 재실행(cols/rows 재계산 → _fitNow 가 기존 경로로 리사이즈 전송).
//  IDE: CSS 변수(--cpt-ide-font)는 display-scale.js 가 이미 바꿈 → CodeMirror refresh 만 필요.
onScaleChange(() => {
  const px = termFontPx();
  for (const [, p] of registry) {
    try {
      if (p.term) { p.term.options.fontSize = px; p._fitNow(); }
      p.ide?.refresh();
      p._mixed?.forEach((m) => m.ide?.refresh());
    } catch (_) {}
  }
});
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

// 혼합 탭 — 터미널 pane 의 탭은 터미널(tmux window) 외에 IDE/프리뷰일 수도 있다.
//  kind 미지정 = 터미널(하위호환 — 기존 영속 레이아웃의 탭은 전부 터미널).
export function isTermTab(t) {
  return !t || !t.kind || t.kind === "term";
}
let _tidSeq = 1;
export function newTid() {
  return "mx" + _tidSeq++ + "-" + Date.now().toString(36);
}

// 터미널 탭 라벨 = window name 그대로(cmux 와 동일).
//  자동 개명이 대기=폴더명 / 실행=앱 OSC 타이틀(claude 상태 등) or 명령을 이미 담으므로
//  `· 명령` 부제는 노이즈("… · 2.1.211")라 제거 — 수동 이름 창도 이름만 표시.
//  win 은 안정 터미널 ID(큰 숫자)라 라벨엔 안 쓴다 — 이름은 리컨실러가 곧 채운다.
export function termTabLabel(t) {
  return t.title || "터미널";
}

// ── 원격 워크스페이스 프리뷰 — 그 PC 의 localhost dev 서버를 back 프록시 URL 로 치환 ──
//  모바일 PaneView 와 동일 모델: 표시(주소창/영속)는 localhost 그대로, webview 로드만 프록시 URL.
//  결정론 토큰이라 재시작해도 동일 URL — 매 내비게이션마다 start 를 다시 쳐서 TTL 을 연장한다.
const LOCAL_PREVIEW_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::(\d{2,5}))?([/?#].*)?$/i;
const _proxyDisplay = new Map(); // 절대 프록시 base → "http://localhost:<port>" (주소창 역매핑)
async function remotePreviewUrl(url, ctx) {
  if (!url || !ctx || ctx.isLocal || ctx.hostDeviceId == null) return url;
  const m = LOCAL_PREVIEW_RE.exec(String(url).trim());
  if (!m) return url; // 외부 URL 은 프록시 불필요
  const port = m[1] ? parseInt(m[1], 10) : 80;
  const r = await api.backApi("POST", "/api/daemon/preview/start", { port, hostDeviceId: ctx.hostDeviceId });
  const base = (await api.backBase()) + String(r?.url || "").replace(/\/+$/, "");
  _proxyDisplay.set(base, `http://localhost:${port}`);
  return base + (m[2] || "/");
}
// webview 가 보고한 실제 URL(프록시)을 사용자 표시용 localhost URL 로 되돌린다.
function displayPreviewUrl(u) {
  for (const [base, local] of _proxyDisplay) {
    if (u && u.startsWith(base)) return local + (u.slice(base.length) || "/");
  }
  return u;
}

// ── 프리뷰 툴바(cmux식): ‹ › ↻ [주소창] ☀(테마) 🛠(개발자도구) ↗(외부) — 혼합 탭/독립 pane 공용 ──
const previewBars = new Map(); // previewId → 툴바 컨트롤러(Rust page-load 이벤트 라우팅)
api.onPreviewLoaded?.((p) => { previewBars.get(p?.pane)?.onLoaded(p?.url || ""); });

// 스마트 주소: URL/로컬/호스트:포트/도메인이면 이동, 아니면 웹 검색. (ui-channel 원격 명령도 재사용)
export function smartUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  const isUrl = /^https?:\/\//i.test(u);
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)([:/]|$)/i.test(u);
  const isHostPort = /^[\w-]+:\d+([/?#]|$)/.test(u);
  const isDomain = /^[\w-]+(\.[\w-]+)+([:/?#]|$)/.test(u);
  if (isUrl || isLocal || isHostPort || isDomain) return isUrl ? u : (isLocal || isHostPort ? "http://" + u : "https://" + u);
  return "https://www.google.com/search?q=" + encodeURIComponent(u);
}

function makePreviewBar({ getId, getHost, initialUrl, initialDark, onNavigate, onMeta, onDarkChange }) {
  const bar = document.createElement("div");
  bar.className = "preview-bar";
  const mk = (iconFn, title) => {
    const b = document.createElement("button");
    b.className = "pane-ctrl";
    b.title = title;
    b.innerHTML = iconFn({ size: 14 });
    return b;
  };
  const back = mk(icons.chevronLeft, "뒤로");
  const fwd = mk(icons.chevronRight, "앞으로");
  const reload = mk(icons.refresh, "새로고침");
  const input = document.createElement("input");
  input.className = "preview-url";
  input.placeholder = "URL 또는 검색어 (예: localhost:3000 · 날씨)";
  input.value = initialUrl || "";
  const theme = mk(icons.sun, "페이지 다크 모드");
  const tools = mk(icons.tools, "개발자 도구");
  const ext = mk(icons.external, "외부 브라우저에서 열기");
  bar.append(back, fwd, reload, input, theme, tools, ext);

  const st = { url: initialUrl || "", dark: !!initialDark, disposed: false, meta: { title: "", favicon: "" } };
  theme.classList.toggle("active", st.dark);
  const setNavState = (b, f) => { back.disabled = !b; fwd.disabled = !f; };
  setNavState(false, false);
  back.addEventListener("click", () => api.previewControl(getId(), "back").catch(() => {}));
  fwd.addEventListener("click", () => api.previewControl(getId(), "forward").catch(() => {}));
  reload.addEventListener("click", () => { if (st.url) api.previewControl(getId(), "reload").catch(() => {}); });
  theme.addEventListener("click", () => {
    if (!st.url) return;
    st.dark = !st.dark;
    theme.classList.toggle("active", st.dark);
    api.previewControl(getId(), st.dark ? "theme_on" : "theme_off").catch(() => {});
    onDarkChange?.(st.dark);
  });
  tools.title = "개발자 도구 (⌥클릭=네이티브 인스펙터)";
  tools.addEventListener("click", (e) => {
    if (!st.url) return;
    // 기본 = 모바일과 동일한 Chrome DevTools(chii). ⌥클릭 = 기존 네이티브 WebKit 인스펙터(고급).
    if (!e.altKey && getHost) {
      toggleChiiDevtools(getId(), getHost()).then((on) => tools.classList.toggle("active", !!on)).catch(() => {});
      return;
    }
    api.previewControl(getId(), "devtools").catch(() => {});
    // 좁은 pane(사이드 도킹 최소폭 = 인스펙터 500 + 페이지 320 미달)은 폭 조절이 잠기므로
    //  인스펙터 로드를 기다렸다 하단 도킹으로 자동 전환(이미 하단/미로드면 no-op).
    if (bar.getBoundingClientRect().width < 840) {
      setTimeout(() => api.previewControl(getId(), "devtools_fit").catch(() => {}), 900);
      setTimeout(() => api.previewControl(getId(), "devtools_fit").catch(() => {}), 2200);
    }
  });
  // 원격 프록시로 보는 중이면 외부 브라우저에는 실제(프록시) URL — localhost 는 이 기기가 아님.
  ext.addEventListener("click", () => { if (st.url) api.openExternal(st.rawUrl || st.url).catch(() => {}); });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const u = smartUrl(input.value);
    if (!u) return;
    st.url = u;
    input.value = u;
    onNavigate(u);
  });

  // 현재 페이지 정보(주소/제목/히스토리) → 주소창·버튼·탭 메타. 메타는 변한 것만 통지.
  const refreshInfo = async () => {
    if (st.disposed || !st.url) return;
    try {
      const info = await api.previewInfo(getId());
      if (st.disposed || !info) return;
      setNavState(!!info.can_back, !!info.can_fwd);
      if (info.url) {
        st.rawUrl = info.url;
        const disp = displayPreviewUrl(info.url);
        st.url = disp;
        if (document.activeElement !== input) input.value = disp;
      }
      let fav = "";
      try { fav = new URL(st.rawUrl || st.url).origin + "/favicon.ico"; } catch (_) {}
      const title = info.title || "";
      if (title !== st.meta.title || fav !== st.meta.favicon) {
        st.meta = { title, favicon: fav };
        onMeta?.({ title, favicon: fav, url: info.url || st.url });
      }
    } catch (_) { /* webview 미생성 등 */ }
  };
  const ctl = {
    el: bar,
    get url() { return st.url; },
    onLoaded(u) {
      if (st.disposed) return;
      if (u) {
        st.rawUrl = u;
        const disp = displayPreviewUrl(u);
        st.url = disp;
        if (document.activeElement !== input) input.value = disp;
      }
      if (st.dark) api.previewControl(getId(), "theme_on").catch(() => {}); // 내비게이션마다 재주입
      dtOnPageLoaded(getId()); // 크롬 데브툴 열려 있으면 chobitsu 재주입 + enable 리플레이
      setTimeout(refreshInfo, 250);
    },
    refreshInfo,
    dispose() { st.disposed = true; previewBars.delete(getId()); },
  };
  previewBars.set(getId(), ctl);
  return ctl;
}

// 혼합 탭용 프리뷰 표면 — 표준 프리뷰 pane(_buildFrame/_startPreviewSync)과 동일 동작을
//  탭 host 안에 캡슐화. webview id 는 탭 tid 기반(pane 당 여러 프리뷰 탭 공존 가능).
class PreviewSurface {
  constructor(parent, tid, tab, persist, onMeta, ctx) {
    this.id = "pv-" + tid;
    this.tab = tab;
    this.ctx = ctx || null;
    this.url = tab.url || "";
    // webview 에 실제로 로드할 URL — 원격 워크스페이스의 localhost 는 back 프록시로 치환(비동기).
    this.effUrl = this.url;
    this._applyEff(this.url);
    this.bar = makePreviewBar({
      getId: () => this.id,
      getHost: () => this.host,
      initialUrl: this.url,
      onNavigate: (u) => {
        this.tab.url = u;
        this.url = u;
        this._applyEff(u, true);
        persist?.();
      },
      onMeta: (m) => {
        this.tab.metaTitle = m.title || "";
        this.tab.metaFav = m.favicon || "";
        onMeta?.(m);
        persist?.(); // 탭 메타는 레이아웃과 함께 영속(복원 시 라벨 유지)
      },
      initialDark: !!tab.dark,
      onDarkChange: (v) => { this.tab.dark = v; persist?.(); },
    });
    this.host = document.createElement("div");
    this.host.className = "preview-host";
    this.host.innerHTML = `<div class="preview-empty">URL 또는 검색어를 입력하세요</div>`;
    parent.append(this.bar.el, this.host);
    this._visible = false;
    this._key = "";
    this._disposed = false;
    this._forceTick = 0;
    const tick = () => {
      if (this._disposed) return;
      const h = this.host;
      if (h && document.body.contains(h)) {
        // 인스펙터 attach 등 네이티브 쪽이 webview 프레임을 바꿔도(DOM rect 는 그대로라 key 불변)
        //  주기적으로 강제 재적용해 pane 영역에 다시 고정한다 → 인스펙터도 pane 안에 갇힌다.
        if (++this._forceTick >= 45) { this._forceTick = 0; this._key = ""; }
        // 크롬 데브툴 열림 = 프론트엔드가 알려준 "페이지 자리"(슬롯)에 webview 를 겹친다.
        const r = (dtPageSlot(this.id) || h).getBoundingClientRect();
        const modalOpen = !!document.querySelector(".settings-modal:not(.hidden)");
        const dragging = document.body.classList.contains("tab-dragging");
        const visible = this._visible && r.width > 2 && r.height > 2 && !modalOpen && !dragging;
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), visible, this.effUrl].join("|");
        if (key !== this._key) {
          this._key = key;
          if (this.effUrl) api.previewSync(this.id, this.effUrl, r.left, r.top, r.width, r.height, visible).catch(() => {});
        }
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    // SPA 제목 변경 등 대비 — 표시 중일 때 저빈도 정보 갱신.
    this._infoTimer = setInterval(() => { if (this._visible && this.url) this.bar.refreshInfo(); }, 4000);
  }
  // 원격이면 프록시 URL 확보 후 반영(로컬/외부 URL 은 그대로). navigate=true 면 즉시 이동까지.
  _applyEff(u, navigate) {
    remotePreviewUrl(u, this.ctx)
      .catch(() => u) // 대상 데몬 오프라인 등 — 원본 URL 로 폴백(에러 페이지로 상황 노출)
      .then((eff) => {
        if (this._disposed) return;
        this.effUrl = eff;
        this._key = "";
        if (navigate) api.previewNavigate(this.id, eff).catch(() => {});
      });
  }
  setVisible(v) { this._visible = v; }
  // keepWebview=true — 탭 이동(다른 pane 재생성 예정): 네이티브 webview 를 닫지 않고 넘긴다.
  //  같은 표면 ID("pv-"+tid)로 재생성되면 기존 webview 에 재부착 → 페이지·테마·인스펙터 유지.
  dispose(keepWebview) {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    clearInterval(this._infoTimer);
    this.bar.dispose();
    dtDispose(this.id, keepWebview);
    if (!keepWebview) api.previewClose(this.id).catch(() => {});
  }
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// 프리뷰 탭 아이콘 — 페이지 파비콘(로드 실패 시 지구본 폴백. cmux 처럼 탭이 열린 페이지를 표현).
function previewTabIconHtml(fav) {
  if (!fav) return icons.globe({ size: 13 });
  return `<img class="ptab-fav" src="${escapeHtml(fav)}" onerror="this.style.display='none';this.nextSibling.style.display=''"><span style="display:none">${icons.globe({ size: 13 })}</span>`;
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
    this._mixed = new Map(); // 혼합 탭(IDE/프리뷰) 본문 — tid → { host, ide?, preview? }

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
    // 탭이 넘치면 가로 스크롤(overflow-x) — 세로 휠도 가로 스크롤로 변환(마우스 사용자용).
    tabsEl.addEventListener("wheel", (e) => {
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 트랙패드 가로 제스처는 기본 동작
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY;
    }, { passive: false });
    if (this.node.kind === "terminal") {
      this.node.tabs.forEach((t, i) => {
        const tab = document.createElement("div");
        tab.className = "ptab" + (i === this.node.active ? " active" : "");
        tab.draggable = true;
        const isT = isTermTab(t);
        // 프리뷰 탭은 열린 페이지의 메타(파비콘+제목)로 표현(cmux 미러).
        const iconHtml = isT ? icons.terminal({ size: 13 })
          : t.kind === "ide" ? icons.code({ size: 13 })
          : previewTabIconHtml(t.metaFav);
        const label = isT
          ? termTabLabel(t)
          : t.kind === "ide" ? "IDE" : (t.metaTitle || "프리뷰");
        tab.innerHTML = `<span class="ptab-ic">${iconHtml}</span><span class="ptab-title">${escapeHtml(label)}</span>`;
        const x = document.createElement("span");
        x.className = "ptab-x";
        x.innerHTML = icons.x({ size: 11 });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(i);
        });
        tab.appendChild(x);
        tab.addEventListener("click", () => {
          this.switchTab(i);
          // 사용자가 탭을 직접 클릭 = 그 터미널을 봄 → 알림 읽음(프로그램적 전환은 안 읽음).
          const tt = this.node.tabs[i];
          if (isTermTab(tt) && typeof tt.win === "number") this.ctx.onTabActivated?.(tt.win);
        });
        // 포인터 기반 드래그(WKWebView 에서 HTML5 draggable 불안정 → 텍스트 드래그 방지).
        tab.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".ptab-x")) return;
          // 탭 헤더 클릭 시에도 pane 포커스 — pointerdown preventDefault 가 pane 의 focus용 mousedown(l.341)을
          //  억제해 탭을 눌러도 활성 pane 이 안 바뀌던 문제. 여기서 직접 포커스한다.
          this.ctx.onFocus?.(this.id);
          e.preventDefault(); // 텍스트 선택/네이티브 드래그 차단
          this.ctx.onTabDragStart?.(this.id, i, e);
        });
        tabsEl.appendChild(tab);
      });
    } else {
      const isIde = this.node.kind === "ide";
      const lbl = document.createElement("div");
      lbl.className = "ptab active static";
      const icHtml = isIde ? icons.code({ size: 13 }) : previewTabIconHtml(this.node.metaFav);
      const lblText = isIde ? "IDE" : (this.node.metaTitle || "프리뷰");
      lbl.innerHTML = `<span class="ptab-ic">${icHtml}</span><span class="ptab-title">${escapeHtml(lblText)}</span>`;
      const x = document.createElement("span");
      x.className = "ptab-x";
      x.innerHTML = icons.x({ size: 11 });
      x.addEventListener("click", (e) => { e.stopPropagation(); this.ctx.onClosePane?.(this.id); });
      lbl.appendChild(x);
      // IDE/프리뷰 탭도 잡아 pane 통째 이동(index<0).
      lbl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".ptab-x")) return;
        this.ctx.onFocus?.(this.id); // 탭 클릭 시 pane 포커스(mousedown 억제 보완)
        e.preventDefault();
        this.ctx.onTabDragStart?.(this.id, -1, e);
      });
      tabsEl.appendChild(lbl);
    }

    // 추가류 버튼(새 터미널/분할/IDE/프리뷰)은 상단 워크스페이스 헤더의 통합 추가 버튼으로 이동
    //  (활성 pane 기준 자동 배치) — pane 헤더에는 pane 전용 컨트롤만 남긴다. 단축키(⌘D 등)는 유지.
    const ctrls = document.createElement("div");
    ctrls.className = "pane-ctrls";
    // 탐색기 토글은 IDE 파일 탭 바 맨 우측으로 이동(ide.js) — 혼합 탭으로 들어가도 보이게.
    this.head.append(tabsEl, ctrls);
    // 활성 탭이 스크롤 밖이면 보이게(탭 전환/추가 직후) — 레이아웃 확정 후 한 프레임 뒤.
    const act = tabsEl.querySelector(".ptab.active");
    if (act) requestAnimationFrame(() => { try { act.scrollIntoView({ inline: "nearest", block: "nearest" }); } catch (_) {} });
  }

  // ── 터미널 본문 ──
  _buildTerminal() {
    this.termEl = document.createElement("div");
    this.termEl.className = "pane-term";
    this.body.appendChild(this.termEl);
    // 터미널 0개 상태의 자리 표시(자동 생성 금지 — 사용자가 명시적으로 추가).
    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "pane-term-empty";
    this.emptyEl.style.display = "none";
    const msg = document.createElement("div");
    msg.className = "pane-term-empty-msg";
    msg.textContent = "열린 터미널이 없습니다";
    const btn = document.createElement("button");
    btn.className = "pane-term-empty-btn";
    btn.innerHTML = `${icons.terminal({ size: 14 })}<span>새 터미널</span>`;
    btn.addEventListener("click", () => this.addTab());
    this.emptyEl.append(msg, btn);
    this.body.appendChild(this.emptyEl);
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: termFontPx(), // 기본 13px × 표시 배율(이 기기 로컬 설정)
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
    this._registerOsc(9, (data) => this.ctx.onNotify?.(this.id, this._streamWin(), "", data));
    this._registerOsc(777, (data) => {
      const parts = String(data).split(";");
      if (parts[0] === "notify") this.ctx.onNotify?.(this.id, this._streamWin(), parts[1] || "", parts.slice(2).join(";"));
    });
    this._registerOsc(99, (data) => this.ctx.onNotify?.(this.id, this._streamWin(), "", String(data).replace(/^.*?;/, "")));
    if (this.term.onBell) this.term.onBell(() => this.ctx.onNotify?.(this.id, this._streamWin(), "", "알림"));
  }
  // 이 pane 터미널 스트림의 현재 win(tid) — 실제 attach 중인 터미널이 정본, 없으면 탭에서 유추.
  _streamWin() {
    if (typeof this._attachedWin === "number") return this._attachedWin;
    const a = this.node.tabs?.[this.node.active];
    if (a && isTermTab(a) && typeof a.win === "number") return a.win;
    const t = this.node.tabs?.find((x) => isTermTab(x) && typeof x.win === "number");
    return t ? t.win : null;
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
      if (titles[i]) titles[i].textContent = isTermTab(t) ? termTabLabel(t) : titles[i].textContent;
    });
  }

  // 내장 IDE(파일트리 + CodeMirror).
  // 파일 전송 계층 — 이 호스트면 로컬 fsapi(기본), 다른 PC 워크스페이스면 back fs 릴레이(원격 IDE).
  _ideFs() {
    return this.ctx.isLocal ? null : makeRemoteFs(this.ctx.hostDeviceId);
  }

  _buildIde() {
    this.ide = new IdeView(this.ctx.localPath || "", this.body, {
      openPath: this.node.openPath || null,
      paneId: this.id,
      paneDropZone: this.ctx.paneDropZone,
      onFileSplit: this.ctx.onFileSplit,
      fs: this._ideFs(),
    });
  }

  // preview pane — 네이티브 임베디드 webview(iframe 아님 → X-Frame-Options 무관, 구글 등 다 뜸).
  //  툴바(DOM) + host(DOM placeholder) 위에 Rust 가 webview 를 얹어 위치/가시성 동기화.
  _buildFrame() {
    // 표면 ID — 탭↔독립 pane 전환에도 동일("pv-"+tid)해서 네이티브 webview 를 승계한다.
    this._pvId = "pv-" + (this.node.tid || this.id);
    this.previewBar = makePreviewBar({
      getId: () => this._pvId,
      getHost: () => this.previewHost,
      initialUrl: this.node.url || "",
      initialDark: !!this.node.dark,
      onDarkChange: (v) => { this.node.dark = v; this.ctx.persist?.(); },
      onNavigate: (u) => {
        this.node.url = u;
        this.previewUrl = u;
        this._applyPvEff(u, true);
        this.ctx.persist?.();
      },
      onMeta: (m) => {
        this.node.metaTitle = m.title || "";
        this.node.metaFav = m.favicon || "";
        this._refreshStaticTabMeta();
        this.ctx.persist?.();
      },
    });
    const host = document.createElement("div");
    host.className = "preview-host";
    host.innerHTML = `<div class="preview-empty">URL 또는 검색어를 입력하세요</div>`;
    this.previewHost = host;
    this.previewUrl = this.node.url || "";
    // webview 로드용 실효 URL(원격이면 프록시로 치환) — 복원된 URL 도 즉시 매핑.
    this._pvEffUrl = this.previewUrl;
    if (this.previewUrl) this._applyPvEff(this.previewUrl, false);
    this.body.append(this.previewBar.el, host);
  }

  // 독립 프리뷰 pane 의 실효 URL 반영(PreviewSurface._applyEff 와 동일 규칙).
  _applyPvEff(u, navigate) {
    remotePreviewUrl(u, this.ctx)
      .catch(() => u)
      .then((eff) => {
        if (this.node.kind !== "preview") return;
        this._pvEffUrl = eff;
        this._previewKey = ""; // 강제 재동기화(없으면 생성)
        if (navigate) api.previewNavigate(this._pvId, eff).catch(() => {});
      });
  }
  // 독립 프리뷰 pane 의 정적 탭 라벨을 페이지 메타(제목/파비콘)로 갱신.
  _refreshStaticTabMeta() {
    if (this.node.kind !== "preview") return;
    const t = this.head.querySelector(".ptab-title");
    if (t) t.textContent = this.node.metaTitle || "프리뷰";
    const ic = this.head.querySelector(".ptab-ic");
    if (ic) ic.innerHTML = previewTabIconHtml(this.node.metaFav);
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
    // 스트림은 "터미널" 탭 기준 — 활성 탭이 IDE/프리뷰(혼합 탭)여도 백그라운드 터미널은 유지.
    //  터미널 탭이 하나도 없으면 채널 없이 혼합 탭 본문만 표시.
    const active = this.node.tabs[this.node.active];
    const termTab = (isTermTab(active) && active) || this.node.tabs.find((t) => isTermTab(t));
    if (termTab) {
      const win = await this._ensureWin(termTab);
      this._openChannel(win);
    }
    this.showActiveTab();
    this.ro = new ResizeObserver(() => { this._fitNow(); this._mixed.forEach((m) => m.ide?.refresh()); });
    this.ro.observe(this.el);
  }

  async _ensureWin(tab) {
    if (this.ctx.isLocal && isTermTab(tab) && (tab.win === "new" || tab.win == null)) {
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

  // 크기 주장(스로틀) — 사용자가 이 pane 을 실제로 만질 때(클릭/포커스/타이핑), 표시 창이 다른
  //  기기 크기로 잡혀 있으면 Rust 가 클라이언트 nudge 로 회수한다(이미 내 크기면 no-op).
  //  모바일은 키보드 노출 등 실 리사이즈가 자연 클레임을 만들지만 PC 는 이 훅이 유일한 계기다.
  _claimSize() {
    if (!this.ctx.isLocal || this.node.kind !== "terminal") return;
    const n = Date.now();
    if (n - (this._lastClaim || 0) < 1200) return;
    this._lastClaim = n;
    api.ptyClaim(this.id).catch(() => {});
  }

  // 이 pane 의 attach 를 지정 터미널(tid)로 재수립 — 전용 세션 모델의 탭 전환/드롭 이동 공용.
  //  이미 그 터미널에 붙어 있으면 no-op. 로컬 tmux attach 라 전환은 즉시(전체 화면 재그리기).
  async _reattach(win) {
    if (typeof win !== "number" || !this.ctx.isLocal || this.node.kind !== "terminal") return;
    if (this._attachedWin === win) return;
    // 의도된 교체 — 구 attach 의 exit 이벤트가 "[세션 종료]" 안내/재연결 루프를 타지 않게 표식.
    this._expectExit = true;
    try { await api.ptyClose(this.id); } catch (_) {}
    this._openChannel(win);
  }

  // ── 탭 조작 ──
  async addTab() {
    if (this.node.kind !== "terminal" || !this.ctx.isLocal) return;
    const tab = { win: "new", title: "", fresh: true };
    this.node.tabs.push(tab);
    this.node.active = this.node.tabs.length - 1;
    this.buildHead();
    this.showActiveTab(); // 빈 상태 자리표시 → 터미널 본문 전환
    const win = await this._ensureWin(tab);
    // await 사이 탭이 다른 pane 으로 드래그돼 사라졌을 수 있음 → 아직 이 pane 소속일 때만 반영.
    if (!this.node.tabs.includes(tab)) return;
    this.buildHead(); // 자동 개명이 부여한 이름 반영
    this._reattach(win);
    this.ctx.persist?.();
    this.ctx.onSurfacesChanged?.();
    this.focus();
  }
  async switchTab(i) {
    if (i === this.node.active) {
      this.focus();
      return;
    }
    this.node.active = i;
    this.buildHead();
    const tab = this.node.tabs[i];
    if (isTermTab(tab)) {
      const win = await this._ensureWin(tab);
      if (this.node.tabs[this.node.active] === tab) this._reattach(win);
      // 읽음 처리 없음 — switchTab 은 프로그램적으로도 호출된다(알림 활성화/점프). 읽음은
      //  사용자가 탭/터미널을 직접 클릭할 때만(buildHead 탭 클릭·_setupInput mousedown).
    }
    this.showActiveTab();
    this.ctx.persist?.();
    this.focus();
  }
  closeTab(i) {
    const tab = this.node.tabs[i];
    if (isTermTab(tab)) {
      // 터미널 탭 = 완전 삭제(전 기기 공통) — 전용 세션 kill. 목록에서도, 실체도 사라진다.
      if (this.ctx.isLocal && typeof tab.win === "number") api.killWindow(this.ctx.localPath || "", tab.win).catch(() => {});
      if (this._attachedWin === tab.win) this._attachedWin = null; // 죽은 attach — 아래서 갈아탐
    } else {
      // IDE/프리뷰 탭 = 이 기기 뷰만 닫힘.
      this.disposeMixedTab(tab);
    }
    this.node.tabs.splice(i, 1);
    if (!this.node.tabs.length) {
      this.ctx.onClosePane?.(this.id);
      return;
    }
    if (this.node.active >= this.node.tabs.length) this.node.active = this.node.tabs.length - 1;
    this.buildHead();
    const at = this.node.tabs[this.node.active];
    if (isTermTab(at)) this._reattach(at.win);
    this.showActiveTab();
    this.ctx.onSurfacesChanged?.();
    this.ctx.persist?.();
  }

  // ── 혼합 탭(IDE/프리뷰) 본문 관리 ──
  _ensureMixed(tab) {
    if (!tab.tid) tab.tid = newTid();
    let m = this._mixed.get(tab.tid);
    if (m) return m;
    const host = document.createElement("div");
    host.className = "pane-mixed";
    this.body.appendChild(host);
    m = { host };
    if (tab.kind === "ide") {
      m.ide = new IdeView(this.ctx.localPath || "", host, {
        openPath: tab.openPath || null,
        paneId: this.id,
        paneDropZone: this.ctx.paneDropZone,
        onFileSplit: this.ctx.onFileSplit,
        fs: this._ideFs(),
      });
      m.ide.mount();
    } else {
      m.preview = new PreviewSurface(host, tab.tid, tab, () => this.ctx.persist?.(), () => this.buildHead(), this.ctx);
    }
    this._mixed.set(tab.tid, m);
    return m;
  }
  disposeMixedTab(tab, keepWebview) {
    const m = tab && tab.tid ? this._mixed.get(tab.tid) : null;
    if (!m) return;
    m.ide?.dispose();
    m.preview?.dispose(keepWebview);
    m.host.remove();
    this._mixed.delete(tab.tid);
  }
  // 활성 탭 kind 에 맞춰 본문 표시 전환(터미널 ↔ IDE/프리뷰). 터미널 스트림은 숨겨도 유지.
  showActiveTab() {
    if (this.node.kind !== "terminal" || !this.termEl) return;
    const tab = this.node.tabs[this.node.active];
    const isT = isTermTab(tab);
    if (!isT && tab) this._ensureMixed(tab);
    const empty = !this.node.tabs.length;
    if (this.emptyEl) this.emptyEl.style.display = empty ? "flex" : "none";
    this.termEl.style.display = !empty && isT ? "" : "none";
    for (const [tid, m] of this._mixed) {
      const on = !isT && tab && tab.tid === tid;
      m.host.style.display = on ? "flex" : "none";
      if (on && m.ide) m.ide.refresh();
      m.preview?.setVisible(!!on);
    }
    if (isT) this._fitNow();
  }
  // 리컨실러가 탭을 편입/정리한 뒤 호출 — 빈 pane 에 터미널이 들어왔는데 채널이 없으면 attach 하고,
  //  빈 상태 자리표시 토글도 갱신한다(리컨실러는 상태만 만지고 렌더/채널은 pane 이 책임).
  ensureAttached() {
    if (this.node.kind !== "terminal" || !this.mounted) return;
    this.showActiveTab();
    if (!this.ctx.isLocal || typeof this._attachedWin === "number") return;
    const active = this.node.tabs?.[this.node.active];
    const tab = (isTermTab(active) && active) || this.node.tabs?.find((t) => isTermTab(t));
    if (tab && typeof tab.win === "number") this._reattach(tab.win);
  }

  // 드롭으로 이동해 온 탭을 활성화(이 pane 스트림을 그 터미널로 재attach).
  async activateWin(win) {
    this._reattach(win);
    this.buildHead();
    this.focus();
  }

  // ── 채널(로컬 pty / 클라우드 WS) ──
  async _openChannel(win) {
    const { cols, rows } = this.term;
    if (this.ctx.isLocal) {
      this._attachedWin = typeof win === "number" ? win : null;
      api.ptyOpen(this.id, this.ctx.localPath || "", win ?? 0, cols || 80, rows || 24).then((resolved) => {
        // 요청 tid 가 스테일(닫힘/구버전 인덱스)이면 Rust 가 첫 터미널로 폴백해 실제 attach 한
        //  tid 를 돌려준다 — 탭을 실체에 맞게 보정(리컨실러가 목록은 따로 정리).
        if (typeof resolved !== "number") return;
        this._attachedWin = resolved;
        if (resolved !== win) {
          const t = this.node.tabs?.find((x) => isTermTab(x) && x.win === win);
          if (t) { t.win = resolved; this.buildHead(); this.ctx.persist?.(); this.ctx.onSurfacesChanged?.(); }
        }
      }).catch((e) => {
        this._attachedWin = null;
        this.term.write("\r\n\x1b[31m터미널 연결 실패: " + e + "\x1b[0m\r\n");
        this._scheduleReopen(2500); // 일시 오류(서버 재기동 중 등)에 고착되지 않게 자동 재시도
      });
    } else {
      try {
        const { token, wsBase } = await api.cloudTerminalStart(this.ctx.localPath || "", this.ctx.hostDeviceId ?? null, this.id);
        const ws = new WebSocket(`${wsBase}/api/daemon/terminal/${token}`);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        ws.onopen = () => { this._remoteTries = 0; this._resize(this.term.cols, this.term.rows); };
        ws.onmessage = (e) => {
          this._termOut(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
        };
        // 끊기면 자동 재연결 — 반드시 새 토큰 발급(만료 dterm 토큰 재시도 = 서버 502 스팸의 근원).
        ws.onclose = () => {
          if (this._reopenStop || !this.mounted) return;
          this.term.write("\r\n\x1b[90m[연결 끊김 — 재연결 중…]\x1b[0m\r\n");
          this._scheduleRemoteReopen();
        };
      } catch (e) {
        this.term.write("\r\n\x1b[31m원격 터미널 실패: " + e + "\x1b[0m\r\n");
        this._scheduleRemoteReopen();
      }
    }
  }

  // 원격(릴레이) 터미널 재연결 — 지수 백오프, _openChannel 이 새 토큰을 발급한다.
  _scheduleRemoteReopen() {
    if (this._reopenStop || !this.mounted) return;
    clearTimeout(this._remoteReopenTimer);
    this._remoteTries = (this._remoteTries || 0) + 1;
    const delay = Math.min(2000 * this._remoteTries, 15000);
    this._remoteReopenTimer = setTimeout(() => {
      if (this._reopenStop || !this.mounted) return;
      try { this.ws?.close(); } catch (_) { /* noop */ }
      this._openChannel();
    }, delay);
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
    // ⌘/⌥ 편집 조합 — textarea 기본동작(delta 의존)이 아니라 셸 표준 시퀀스를 직접 보낸다.
    //  탭 자동완성·히스토리(↑) 등으로 셸 라인과 textarea 미러가 어긋나 있어도 항상 동작.
    const EDIT_COMBO = {
      "meta:Backspace": "\x15",      // 라인 앞쪽 전체 삭제(^U)
      "alt:Backspace": "\x1b\x7f",   // 단어 삭제
      "meta:ArrowLeft": "\x01",      // 라인 처음(^A)
      "meta:ArrowRight": "\x05",     // 라인 끝(^E)
      "alt:ArrowLeft": "\x1bb",      // 단어 왼쪽
      "alt:ArrowRight": "\x1bf",     // 단어 오른쪽
      "alt:Enter": "\x1b\r",         // 멀티라인 개행(Claude Code 등 REPL)
    };
    const onKeydown = (e) => {
      if (e.target !== ta) return;
      this._claimSize(); // 타이핑 = 이 pane 크기 주장(스로틀·창이 내 크기면 no-op)
      if (e.isComposing || e.keyCode === 229) return; // 조합 중 키는 IME 소유(Enter=확정 포함)
      const mod = e.metaKey ? "meta" : e.altKey ? "alt" : null;
      if (mod && !(e.metaKey && e.altKey)) {
        const seq = EDIT_COMBO[mod + ":" + e.key];
        if (seq) {
          this._write(seq); resetBuf();
          e.preventDefault(); e.stopImmediatePropagation(); return;
        }
      }
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
      if (e.shiftKey && e.key === "Enter") {            // 멀티라인 개행(Claude Code 등 REPL)
        this._write("\x1b\r"); resetBuf();
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (e.shiftKey && e.key === "Tab") {              // 역탭(CSI Z) — Claude Code 모드 전환 등
        this._write("\x1b[Z"); resetBuf();
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
    // xterm 은 blur 시 textarea.value 를 비운다 — 미러(_sentBuf)도 함께 비워야
    //  복귀 후 첫 입력의 델타가 "옛 텍스트 길이만큼 백스페이스"를 쏘지 않는다.
    const onBlur = () => resetBuf();
    ta.addEventListener("blur", onBlur);
    const onFocus = () => this._claimSize();
    ta.addEventListener("focus", onFocus);
    const onMouseDown = () => {
      // 사용자가 실제로 터미널을 클릭 = 이 터미널을 봄 → 활성 탭 win 알림 읽음(프로그램적 포커스 제외).
      const at = this.node.tabs?.[this.node.active];
      if (at && isTermTab(at) && typeof at.win === "number") this.ctx.onTabActivated?.(at.win);
      this._claimSize(); // 클릭 = 크기 주장(모바일의 키보드 노출 리사이즈에 대응하는 PC 계기)
    };
    this.termEl?.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("compositionstart", onComp, true);
    document.addEventListener("compositionupdate", onComp, true);
    document.addEventListener("compositionend", onCompEnd, true);
    this._inputDispose = () => {
      ta.removeEventListener("blur", onBlur);
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
  // attach 가 끊겼다 — 정상 원인은 둘뿐: 이 터미널이 (다른 기기에서) 닫혔거나, 탭 전환(_reattach)의
  //  의도된 교체. 전자는 남은/새 터미널로 갈아타고, 목록이 비어 있으면 생길 때까지 대기만 한다
  //  (여기서 창을 만들면 기기 간 생성 레이스로 유령 터미널이 생긴다).
  _onExit() {
    if (this.node.kind !== "terminal" || !this.ctx.isLocal) return;
    if (this._expectExit) { this._expectExit = false; return; } // 탭 전환의 의도된 교체 — 무시
    this.term?.write("\r\n\x1b[90m[세션 종료 — 재연결 대기]\x1b[0m\r\n");
    this._attachedWin = null;
    this._reopenTries = 0;
    this._scheduleReopen(1500);
  }
  _scheduleReopen(delay) {
    clearTimeout(this._reopenTimer);
    this._reopenTimer = setTimeout(async () => {
      if (this._reopenStop || !this.mounted) return;
      if (typeof this._attachedWin === "number") return; // 이미 다른 경로(_reattach 등)로 복구됨
      // 재연결 대상은 "터미널" 탭 — 활성 탭이 IDE/프리뷰(혼합 탭)여도 백그라운드 터미널을 복구.
      const active = this.node.tabs?.[this.node.active];
      const tab = (isTermTab(active) && active) || this.node.tabs?.find((t) => isTermTab(t));
      if (!tab) return;
      let wins = [];
      try { wins = (await api.listWindows(this.ctx.localPath || "")) || []; } catch (_) { /* 서버 다운 */ }
      if (this._reopenStop) return;
      if (!wins.length) {
        this._reopenTries = (this._reopenTries || 0) + 1;
        this._scheduleReopen(Math.min(1500 * this._reopenTries, 10000));
        return;
      }
      // 닫힌 터미널(tid 부재)은 첫 터미널로 갈아탄다(리컨실러가 탭 목록은 따로 정리).
      if (typeof tab.win !== "number" || !wins.some((w) => w.index === tab.win)) {
        tab.win = wins[0].index;
        if (wins[0].name) tab.title = wins[0].name;
        this.buildHead();
        this.ctx.persist?.();
      }
      const { cols, rows } = this.term || {};
      api.ptyOpen(this.id, this.ctx.localPath || "", tab.win ?? 0, cols || 80, rows || 24)
        .then((resolved) => {
          this._attachedWin = typeof resolved === "number" ? resolved : tab.win;
          this.term?.write("\x1b[90m[재연결됨]\x1b[0m\r\n");
        })
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
    this._previewForceTick = 0;
    const tick = () => {
      if (this._disposed || this.node.kind !== "preview") return;
      const host = this.previewHost;
      if (host && document.body.contains(host)) {
        // 인스펙터 attach 등 네이티브 프레임 변경 복구용 주기 강제 재적용(위 PreviewSurface 와 동일).
        if (++this._previewForceTick >= 45) { this._previewForceTick = 0; this._previewKey = ""; }
        // 크롬 데브툴 열림 = 프론트엔드가 알려준 "페이지 자리"(슬롯)에 webview 를 겹친다.
        const r = (dtPageSlot(this._pvId) || host).getBoundingClientRect();
        const modalOpen = !!document.querySelector(".settings-modal:not(.hidden)");
        const dragging = document.body.classList.contains("tab-dragging");
        const visible = r.width > 2 && r.height > 2 && !modalOpen && !dragging;
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), visible, this._pvEffUrl].join("|");
        if (key !== this._previewKey) {
          this._previewKey = key;
          if (this._pvEffUrl) {
            api.previewSync(this._pvId, this._pvEffUrl, r.left, r.top, r.width, r.height, visible).catch(() => {});
          }
        }
      }
      this._previewRaf = requestAnimationFrame(tick);
    };
    this._previewRaf = requestAnimationFrame(tick);
    // SPA 제목 변경 등 대비 — 저빈도 정보 갱신(주소/제목/히스토리 버튼).
    this._previewInfoTimer = setInterval(() => { if (!this._disposed && this.previewUrl) this.previewBar?.refreshInfo(); }, 4000);
  }

  focus() {
    this.term?.focus();
  }

  // ── 활성 영역 검색(⌘F/Ctrl+F) — 터미널은 스크롤백, IDE 는 열린 파일 내부 ──
  openSearch() {
    if (this.node.kind === "ide") { this.ide?.openSearch(); return; }
    if (this.node.kind === "terminal") {
      // 혼합 탭: 활성 탭이 IDE/프리뷰면 그쪽으로 — IDE 는 파일 내 찾기(VS Code 동작).
      const at = this.node.tabs?.[this.node.active];
      if (at && at.kind === "ide") { this._mixed.get(at.tid)?.ide?.openSearch(); return; }
      if (at && at.kind === "preview") return; // 프리뷰는 페이지 검색 미지원
      this._openTermSearch();
      return;
    }
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
    clearTimeout(this._remoteReopenTimer);
    for (const [, m] of this._mixed) {
      try { m.ide?.dispose(); m.preview?.dispose(); } catch (_) {}
    }
    this._mixed.clear();
    try { this._inputDispose?.(); } catch (_) {}
    try { this._searchResDisposer?.dispose?.(); } catch (_) {}
    try {
      this.ro?.disconnect();
    } catch (_) {}
    this.ide?.dispose();
    if (this.node.kind === "preview") {
      this._disposed = true;
      if (this._previewRaf) cancelAnimationFrame(this._previewRaf);
      if (this._previewInfoTimer) clearInterval(this._previewInfoTimer);
      this.previewBar?.dispose();
      // 탭 편입(joinPaneAsTab/mergeAsTabs) 등 표면 승계 경로에선 webview 를 닫지 않는다.
      //  단, 이 pane 의 rAF 동기화가 멈추므로 webview 를 즉시 숨겨 "부유"(다른 pane 위 덮힘)를 막고,
      //  승계한 host 의 PreviewSurface 가 활성화될 때 올바른 위치/가시성으로 다시 동기화하게 한다.
      dtDispose(this._pvId, this._preservePreview);
      if (this._preservePreview) api.previewSync(this._pvId, this._pvEffUrl || this.previewUrl || "", 0, 0, 0, 0, false).catch(() => {});
      else api.previewClose(this._pvId).catch(() => {});
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
