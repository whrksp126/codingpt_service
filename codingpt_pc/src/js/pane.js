// pane.js — pane 하나 = 자체 탭 헤더(cmux식) + 본문(터미널/프리뷰).
//  · 터미널 pane: 탭 배열(각 탭=tmux window), 활성 탭 window 를 grouped view 가 표시. 탭 전환=select-window.
//  · 헤더: [탭들][+] ......... [우측분할][하단분할][닫기]. 탭은 드래그해 다른 pane 으로 이동 가능.
//  · 프리뷰 pane: URL 바 + iframe.
//  로컬=Rust pty, 클라우드=백엔드 relay WS. OSC 9/777/99+벨 → 알림 콜백.
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { IdeView } from "./ide.js";
import { makeRemoteFs } from "./remote-fs.js";
import lan from "./lan.js";
import { termFontPx, onScaleChange } from "./display-scale.js";
import { termTheme, monoFontStack, cmThemeName, onAppearanceChange, termMinContrast } from "./theme.js";
import { toggleChiiDevtools, dtPageSlot, dtActive, dtOnPageLoaded, dtDispose, dtAttachHost } from "./devtools.js";
import { recordVisit, queryHistory, googleSuggest } from "./preview-history.js";
import { ChatView } from "./chat-view.js";
import { CHAT } from "./chat-model.js";
import { resolveAgentPresence, resolveToggleVisible, resolveAgentBrand } from "./agent-signal.js";
import { paneApprovalCount } from "./approvals.js";
// ⚠ state.js 를 직접 import 하지 않는다 — state.js 가 이미 pane.js 를 import 하므로 순환이 된다.
//  에이전트 상태 조회는 ctx.agentStateOf(워크스페이스 뷰가 주입)로 받는다.

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const SearchAddon = window.SearchAddon?.SearchAddon;

// (구) 프리뷰 프리즈/모달 숨김은 punch-through 전환으로 폐지 — 웹뷰가 앱 UI 아래층이라
//  DOM 모달·메뉴가 자연히 위에 그려지고, 오버레이 중 이벤트만 preview_shield 로 차단한다.

const registry = new Map();
export function getPane(paneId) {
  return registry.get(paneId) || null;
}
// 현재 살아있는 terminal-kind pane 목록 — OS 파일 드롭 좌표가 pane 을 못 짚을 때 폴백용.
export function terminalPanes() {
  const out = [];
  for (const [, p] of registry) if (p.node?.kind === "terminal") out.push(p);
  return out;
}
// 프리뷰 표면 id("pv-…")를 소유한 pane/탭 역매핑 — 사용자가 프리뷰 native webview 내부를 클릭했을 때
//  그 pane/탭을 포커스하기 위한 순수 조회(상태 의존 없음 — 포커스 적용은 호출측이 S 로 수행).
//  반환: { pane, tabIndex } (독립 프리뷰 pane 은 tabIndex=-1, 혼합 프리뷰 탭은 그 탭 index) | null.
export function paneForPreviewId(pvId) {
  if (!pvId) return null;
  for (const [, p] of registry) {
    if (p.node.kind === "preview" && p._pvId === pvId) return { pane: p, tabIndex: -1 };
    if (p.node.kind === "terminal" && p._mixed) {
      for (const [tid, m] of p._mixed) {
        if (m.preview && m.preview.id === pvId) {
          const idx = (p.node.tabs || []).findIndex((t) => t.tid === tid && t.kind === "preview");
          return { pane: p, tabIndex: idx };
        }
      }
    }
  }
  return null;
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
// 모양(테마/글꼴/터미널 스킴) 변경 → 열려있는 모든 터미널(xterm 팔레트·폰트)과 에디터(CM 테마) 즉시 반영.
//  웹폰트(@font-face)는 사용 시점까지 lazy-load — 로드 완료를 기다렸다 적용해야 폴백 글꼴로 굳지 않는다.
onAppearanceChange(() => {
  const theme = termTheme();
  const mono = monoFontStack();
  const cmName = cmThemeName();
  const apply = () => {
    for (const [, p] of registry) {
      try {
        if (p.term) {
          p.term.options.theme = theme;
          p.term.options.fontFamily = mono;
          p.term.options.minimumContrastRatio = termMinContrast();
          if (p.termEl) p.termEl.style.background = theme.background || "";
          p._fitNow();
        }
        p.ide?.setTheme(cmName);
        p._mixed?.forEach((m) => m.ide?.setTheme(cmName));
      } catch (_) {}
    }
  };
  try {
    if (document.fonts?.load) document.fonts.load("13px " + mono).then(apply).catch(apply);
    else apply();
  } catch (_) { apply(); }
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
// ★ 에이전트 상태 글리프(`✳ `/`⠹ `/`✦ ` 등)는 **라벨에서 걷어낸다**(사용자 확정 2026-07-27):
//  같은 정보를 탭 좌측 브랜드 로고가 이미 (그리고 더 정확하게) 나타내므로 글자로 또 붙으면 중복이고
//  긴 제목의 앞자리를 먹는다. 우리가 넣은 것이 아니라 claude 가 pane_title 에 직접 쓰는 접두사다.
//  ⚠ 판정(agent-signal.agentTitleStatus)은 **원본 title** 을 계속 본다 — 여기서 지우는 것은 표시뿐이다.
//  ⚠ "글리프+공백" 이 **여러 번** 반복될 수 있다(실측: `✳ ✳ Claude Code`) → 그룹 자체를 반복시킨다.
export const AGENT_TITLE_GLYPH_RE = /^(?:[\s]*(?:[✳✦✧◇◆✋⏲⏳]|[\u2800-\u28ff])+)+[\s]*/;
export function stripAgentGlyph(name) {
  const s = String(name == null ? "" : name);
  const out = s.replace(AGENT_TITLE_GLYPH_RE, "");
  return out.trim() || s.trim();   // 글리프만 있는 제목이면 원본을 남긴다(빈 라벨 금지)
}
export function termTabLabel(t) {
  return stripAgentGlyph(t.title) || "터미널";
}

// ── 원격 워크스페이스 프리뷰 — 로컬 포트 포워더 우선, back HTTP 프록시 폴백 ──
//  1순위(포워딩): 사이드카 데몬이 이 기기의 127.0.0.1:<port> 리스너 → back WS → 대상 PC 로
//    raw TCP 파이프. 성공하면 원본 localhost URL 을 그대로 로드 — 주소창/영속 표기와 실주소가
//    일치해 치환/_proxyDisplay 역매핑이 아예 불필요하다.
//  폴백(프록시): 기존 back HTTP 프록시 URL 치환(모바일 PaneView 와 동일 모델 — 표시는 localhost,
//    로드만 프록시). 이 PC 의 같은 포트를 자기 dev 서버가 점유(EADDRINUSE)했을 때 등.
const LOCAL_PREVIEW_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::(\d{2,5}))?([/?#].*)?$/i;
const _proxyDisplay = new Map(); // 절대 프록시 base → "http://localhost:<port>" (주소창 역매핑)

// (hostDeviceId, port)별 포워더 성공 캐시 — 매 내비게이션마다 backApi/invoke 왕복을 반복하지 않되,
//  토큰 TTL(서버 1시간)보다 훨씬 짧은 10분 주기로 재발급+forward_start 재호출해 만료를 선제 갱신.
const FORWARD_REFRESH_MS = 10 * 60 * 1000;
const _forwards = new Map(); // `${hostDeviceId}:${port}` → { at, promise, port, hostDeviceId }
function ensureLocalForward(port, hostDeviceId) {
  const key = hostDeviceId + ":" + port;
  const hit = _forwards.get(key);
  if (hit && Date.now() - hit.at < FORWARD_REFRESH_MS) return hit.promise;
  const promise = (async () => {
    const r = await api.backApi("POST", "/api/daemon/forward/start", { port, hostDeviceId });
    if (!r?.token) throw new Error("포워딩 토큰 발급 실패");
    // LAN 직결(기능4) — 같은 Wi-Fi 면 직결 좌표를 함께 넘긴다. 데몬이 **연결마다** 직결을 먼저 쓰고,
    //  실패하면 버퍼를 승계해 그 연결만 릴레이(token)로 넘긴다 → 사용자 무자각.
    //  grant 취득 실패/미지원은 null 이라 여기서 아무 일도 일어나지 않는다(기존 동작 그대로).
    let upstream = null;
    try { upstream = await lan.upstreamFor(hostDeviceId, port); } catch (_) { upstream = null; }
    const fr = await api.forwardStart(port, r.token, upstream);
    void lan.refreshStatus(hostDeviceId); // 배지(직결) 갱신 — 실패는 조용히 무시
    if (fr?.ok !== true) {
      if (fr?.error === "EADDRINUSE") console.warn(`[preview] 이 PC 의 포트 ${port} 가 사용 중이라 프록시 모드로 엽니다`);
      return false;
    }
    return true;
  })();
  _forwards.set(key, { at: Date.now(), promise, port, hostDeviceId });
  // 실패(false/throw)는 캐시하지 않는다 — 다음 내비게이션이 재시도(포트가 비면 포워딩으로 복귀).
  promise.then((ok) => { if (!ok) _forwards.delete(key); }, () => _forwards.delete(key));
  return promise;
}
// 내비게이션 없이 열어둔 프리뷰도 토큰 TTL 을 넘기지 않게 주기 점검 — 10분 경과분만 재발급된다
//  (리스너 자체는 데몬이 유지하므로 재발급 실패 엔트리는 캐시에서 빠져 다음 사용 때 재시도).
setInterval(() => {
  for (const f of [..._forwards.values()]) ensureLocalForward(f.port, f.hostDeviceId).catch(() => {});
}, 60 * 1000);

async function remotePreviewUrl(url, ctx) {
  if (!url || !ctx || ctx.isLocal || ctx.hostDeviceId == null) return url;
  const m = LOCAL_PREVIEW_RE.exec(String(url).trim());
  if (!m) return url; // 외부 URL 은 프록시 불필요
  const port = m[1] ? parseInt(m[1], 10) : 80;
  // 1) 로컬 포워더 — 성공이면 원본 localhost URL 그대로 반환(치환 불필요).
  try {
    if (await ensureLocalForward(port, ctx.hostDeviceId)) return url;
  } catch (_) { /* 토큰 발급/데몬 invoke 실패(사이드카 미기동 등) — 아래 프록시 폴백 */ }
  // 2) 폴백: back HTTP 프록시(기존 경로 유지). 결정론 토큰이라 재시작해도 동일 URL —
  //    매 내비게이션마다 start 를 다시 쳐서 TTL 을 연장한다.
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

// 빈 프리뷰(검색 전) 상태 — dev 열기 + 내려받기(이어하기). 웹뷰 생성 전에만 보인다.
function fillPreviewEmpty(host) {
  host.innerHTML = "";
  const box = document.createElement("div");
  box.className = "preview-empty";
  const msg = document.createElement("div");
  msg.className = "preview-empty-msg";
  msg.textContent = "URL 또는 데브서버 포트를 입력하세요";
  const row = document.createElement("div");
  row.className = "preview-empty-row";
  const mkb = (label, handler) => {
    const b = document.createElement("button");
    b.className = "preview-empty-btn";
    b.textContent = label;
    b.addEventListener("click", handler);
    return b;
  };
  row.append(
    mkb("dev 열기", async () => {
      try {
        const [uic, wv] = await Promise.all([import("./ui-channel.js"), import("./workspace-view.js")]);
        const r = await uic.openDevPortPC();
        if (!r.ok) wv.wvToast(r.error || "dev 포트 없음");
      } catch (_) { /* noop */ }
    }),
    mkb("내려받기 (이어하기)", async () => {
      try { const wv = await import("./workspace-view.js"); await wv.pickSnapshotAndApply(); } catch (_) { /* noop */ }
    }),
  );
  box.append(msg, row);
  host.append(box);
}

function makePreviewBar({ getId, getHost, getCtx, initialUrl, initialDark, onNavigate, onMeta, onDarkChange }) {
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
  // macOS 자동수정/자동대문자 제안 풍선이 추천 드롭다운 위에 겹치는 것 방지.
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocomplete", "off");
  input.value = initialUrl || "";
  // 테마·개발자도구·올리기·외부열기 → ⋯ 메뉴 하나로 통합.
  const more = mk(icons.dots, "더보기");
  bar.append(back, fwd, reload, input, more);

  const st = { url: initialUrl || "", dark: !!initialDark, disposed: false, meta: { title: "", favicon: "" } };
  const setNavState = (b, f) => { back.disabled = !b; fwd.disabled = !f; };
  setNavState(false, false);
  back.addEventListener("click", () => api.previewControl(getId(), "back").catch(() => {}));
  fwd.addEventListener("click", () => api.previewControl(getId(), "forward").catch(() => {}));
  reload.addEventListener("click", () => { if (st.url) api.previewControl(getId(), "reload").catch(() => {}); });

  // 메뉴 액션들 —
  const doTheme = () => {
    if (!st.url) return;
    st.dark = !st.dark;
    api.previewControl(getId(), st.dark ? "theme_on" : "theme_off").catch(() => {});
    onDarkChange?.(st.dark);
  };
  const doTools = (alt) => {
    if (!st.url) return;
    if (!alt && getHost) { toggleChiiDevtools(getId(), getHost()).catch(() => {}); return; }
    api.previewControl(getId(), "devtools").catch(() => {});
    if (bar.getBoundingClientRect().width < 840) {
      setTimeout(() => api.previewControl(getId(), "devtools_fit").catch(() => {}), 900);
      setTimeout(() => api.previewControl(getId(), "devtools_fit").catch(() => {}), 2200);
    }
  };
  const doExt = () => { if (st.url) api.openExternal(st.rawUrl || st.url).catch(() => {}); };
  const doSave = async () => { try { const wv = await import("./workspace-view.js"); await wv.saveSnapshotAndToast(); } catch (_) { /* noop */ } };

  // ⋯ 메뉴 — 평범한 DOM(punch-through 로 프리뷰 위에 뜬다). 행 = 왼쪽 아이콘 + 텍스트,
  //  다크 모드/개발자 도구는 설정 모달과 동일한 토글(.tgl) — 토글 행은 메뉴를 닫지 않는다.
  const openMoreMenu = () => {
    document.querySelectorAll(".pv-menu").forEach((el) => el.remove());
    const menu = document.createElement("div");
    menu.className = "pv-menu";
    const close = () => { menu.remove(); document.removeEventListener("mousedown", closer, true); };
    const row = (iconFn, label, opt) => {
      const b = document.createElement("button");
      b.className = "pv-menu-item";
      b.innerHTML = `<span class="pvm-ic">${iconFn({ size: 15 })}</span><span class="pvm-label">${label}</span>`;
      let tgl = null;
      if (opt.toggle) {
        tgl = document.createElement("input");
        tgl.type = "checkbox";
        tgl.className = "tgl";
        tgl.checked = !!opt.toggle.get();
        tgl.tabIndex = -1;
        b.appendChild(tgl);
      }
      b.addEventListener("click", () => {
        if (opt.toggle) {
          opt.toggle.set();
          // 상태 반영은 마이크로태스크 뒤(데브툴 토글이 비동기 경계를 가질 수 있음).
          Promise.resolve().then(() => { if (tgl) tgl.checked = !!opt.toggle.get(); });
        } else {
          close();
          opt.onClick();
        }
      });
      menu.appendChild(b);
    };
    row(icons.moon, "다크모드", { toggle: { get: () => st.dark, set: doTheme } });
    row(icons.tools, "개발자 도구", { toggle: { get: () => dtActive(getId()), set: () => doTools(false) } });
    // Design Mode — 1회성 요소 선택(토글 아님): 선택 → 소스 위치+크롭샷을 터미널에 [디자인] 줄로 첨부.
    row(icons.crosshair, "요소 선택", {
      onClick: () => {
        const ctx = getCtx?.();
        import("./design-pick.js")
          .then((d) => d.startDesignPick({ pvId: getId(), localPath: ctx?.localPath || "" }))
          .catch(() => {});
      },
    });
    row(icons.handoffOut, "스냅샷 등록", { onClick: doSave });
    row(icons.external, "외부 열기", { onClick: doExt });
    const r = more.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.right = Math.max(6, window.innerWidth - r.right) + "px";
    document.body.append(menu);
    const closer = (e) => { if (!menu.contains(e.target) && e.target !== more) close(); };
    setTimeout(() => document.addEventListener("mousedown", closer, true), 0);
  };

  more.addEventListener("click", () => {
    if (!st.url) return;
    openMoreMenu();
  });
  // ── 방문 기록 + 검색어 추천 드롭다운(크롬식) — DOM 이라 punch-through 로 프리뷰 위에 뜬다.
  //  포커스=최근 방문, 타이핑=기록 매칭 + Google Suggest. ↑↓/Enter/Esc/클릭.
  let sugEl = null, sugItems = [], sugSel = -1, sugSeq = 0, sugTimer = 0;
  const closeSug = () => { sugEl?.remove(); sugEl = null; sugItems = []; sugSel = -1; sugSeq++; };
  const navTo = (u) => {
    if (!u) return;
    closeSug();
    st.url = u;
    input.value = u;
    input.blur();
    onNavigate(u);
  };
  const markSel = () => { if (sugEl) [...sugEl.children].forEach((c, j) => c.classList.toggle("sel", j === sugSel)); };
  const renderSug = () => {
    if (!sugItems.length) { closeSug(); return; }
    if (!sugEl) {
      sugEl = document.createElement("div");
      sugEl.className = "pv-suggest";
      document.body.append(sugEl);
    }
    const r = input.getBoundingClientRect();
    sugEl.style.left = r.left + "px";
    sugEl.style.top = (r.bottom + 4) + "px";
    sugEl.style.width = Math.min(Math.max(r.width, 280), window.innerWidth - r.left - 8) + "px";
    sugEl.innerHTML = "";
    sugItems.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "pvs-row" + (i === sugSel ? " sel" : "");
      if (it.kind === "h") {
        row.innerHTML =
          (it.f ? `<img class="pvs-fav" src="${escapeHtml(it.f)}" onerror="this.style.visibility='hidden'">` : `<span class="pvs-ic">${icons.globe({ size: 13 })}</span>`) +
          `<span class="pvs-title">${escapeHtml(it.t || displayPreviewUrl(it.u))}</span><span class="pvs-url">${escapeHtml(displayPreviewUrl(it.u))}</span>`;
      } else {
        row.innerHTML = `<span class="pvs-ic">${icons.search({ size: 13 })}</span><span class="pvs-title">${escapeHtml(it.q)}</span><span class="pvs-url">Google 검색</span>`;
      }
      row.addEventListener("mousedown", (e) => { e.preventDefault(); navTo(it.kind === "h" ? it.u : smartUrl(it.q)); });
      row.addEventListener("mousemove", () => { if (sugSel !== i) { sugSel = i; markSel(); } });
      sugEl.append(row);
    });
  };
  const refreshSug = async () => {
    const seq = ++sugSeq;
    const q = input.value.trim();
    const typed = !!q && q !== st.url && q !== (st.rawUrl || "");
    const [hist, sugg] = await Promise.all([
      queryHistory(getCtx?.(), typed ? q : "", 5),
      typed ? googleSuggest(q, 5) : Promise.resolve([]),
    ]);
    if (seq !== sugSeq || document.activeElement !== input) return;
    sugItems = [
      ...hist.map((e) => ({ kind: "h", u: e.u, t: e.t, f: e.f })),
      ...sugg.map((t) => ({ kind: "s", q: t })),
    ];
    sugSel = -1;
    renderSug();
  };
  const queueSug = () => { clearTimeout(sugTimer); sugTimer = setTimeout(refreshSug, 180); };
  input.addEventListener("focus", queueSug);
  input.addEventListener("input", queueSug);
  input.addEventListener("blur", () => setTimeout(closeSug, 120));
  input.addEventListener("keydown", (e) => {
    if (sugEl && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = sugItems.length;
      sugSel = e.key === "ArrowDown" ? (sugSel + 1) % n : (sugSel - 1 + n) % n;
      markSel();
      return;
    }
    if (e.key === "Escape" && sugEl) { e.preventDefault(); closeSug(); return; }
    if (e.key !== "Enter") return;
    if (sugEl && sugSel >= 0 && sugItems[sugSel]) {
      const it = sugItems[sugSel];
      navTo(it.kind === "h" ? it.u : smartUrl(it.q));
      return;
    }
    const u = smartUrl(input.value);
    if (!u) return;
    closeSug();
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
      // 방문 기록 적재 — url 확정 시 1회, 제목이 늦게 오면 제목 확보 시 한 번 더(같은 url 병합).
      if (info.url && (st._recUrl !== info.url || (!st._recTitled && title))) {
        st._recUrl = info.url;
        st._recTitled = !!title;
        recordVisit(getCtx?.(), { url: info.url, title, favicon: fav });
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
      getCtx: () => this.ctx,
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
    fillPreviewEmpty(this.host);
    parent.append(this.bar.el, this.host);
    dtAttachHost(this.id, this.host); // 승계된 데브툴 세션이 있으면 새 host 에 재부착
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
        // punch-through: 웹뷰는 앱 UI "아래" 라 DOM 모달/메뉴가 자연히 위에 그려진다 — 숨김 불필요.
        //  (오버레이 중 이벤트 차단은 main.js 의 preview_shield 가 담당) 드래그 중만 숨김 유지.
        // URL 로드됐으면 빈 상태 placeholder 만 제거 — innerHTML="" 전체 소거는 재부착된
        //  데브툴 UI(wrap/slot)까지 날려 웹뷰가 죽은 슬롯(0×0)을 따라가 영영 숨는다(실측).
        if (this.effUrl) h.querySelector(".preview-empty")?.remove();
        // punch-through: 드래그 중에도 숨기지 않는다 — DOM(고스트/드롭존)이 위층이라 가릴 게 없고,
        //  숨기면 배치 조정 중 웹이 사라져 보인다(실측). 이벤트는 shield 가 차단.
        const visible = this._visible && r.width > 2 && r.height > 2;
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
    dtDispose(this.id, keepWebview, this.host);
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
        //  터미널 탭은 **에이전트를 특정할 수 있을 때만** 그 로고로 바꾼다(모르면 터미널 글리프 유지 —
        //  모양은 사실 주장이므로 추측 금지. 판정 = agent-signal.resolveAgentBrand, 앱과 동치).
        const iconHtml = isT ? (this._tabAgentMark(t) || icons.terminal({ size: 13 }))
          : t.kind === "ide" ? icons.code({ size: 13 })
          : previewTabIconHtml(t.metaFav);
        const label = isT
          ? termTabLabel(t)
          : t.kind === "ide" ? "IDE" : (t.metaTitle || "프리뷰");
        // chat 모드 탭은 라벨 뒤에 작은 말풍선 글리프만 덧붙인다 — 탭 자체가 "다른 종류"로 보이면
        //  드래그/닫기 의미(터미널 탭=완전 삭제)를 오해하게 된다(부록 B).
        // ★ 탭 우측의 채팅 글리프는 **폐기**했다(사용자 확정 2026-07-27): 좌측 로고 + pane 안의 토글로
        //  이미 모드가 드러나고, 탭마다 작은 글리프가 하나 더 붙으면 라벨 폭만 먹는다.
        const modeGlyph = "";
        // 대기 점 — 승인/질문 카드는 그 탭을 열었을 때만 뜨므로(전역 스택 폐기), 이 점이 "어느 터미널이
        //  나를 기다리는지" 를 말하는 유일한 화면 신호다. 활성 탭에는 안 찍는다(카드가 이미 보인다).
        const waiting = isT && typeof t.win === "number" && i !== this.node.active
          && paneApprovalCount(this.ctx.localPath || "", t.win) > 0;
        tab.innerHTML = `<span class="ptab-ic">${iconHtml}</span><span class="ptab-title">${escapeHtml(label)}</span>${modeGlyph}`
          + (waiting ? `<span class="ptab-wait" title="응답을 기다리는 중"></span>` : "");
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
    // 터미널 스킴 배경을 pane 여백까지 — 프리셋 배경이 앱 배경과 다를 때 띠가 지지 않게.
    try { this.termEl.style.background = termTheme().background || ""; } catch (_) {}
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
      fontFamily: monoFontStack(), // 코드·터미널 글꼴 설정(theme.js) — 변경은 onAppearanceChange 가 반영
      scrollback: 10000,
      convertEol: false,
      theme: termTheme(),
      // 최소 대비 자동 보정 — 프롬프트(p10k 등)가 팔레트 밖 256색 배경을 써도 글자가 항상 읽히게.
      minimumContrastRatio: termMinContrast(),
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
    this._buildChat();
    this._buildApprDock();
    this._buildModeToggle();
  }

  // ── TUI ↔ Chat 토글(이 pane 본문 안, 우측 상단) ──────────────────────────────
  // 사용자 확정(2026-07-27): 토글은 **터미널 pane 본문 안 우측 상단**(탭바 아래, 터미널 내용 위)이다.
  //  "메인 영역"을 앱 헤더로 읽어 `.main-top` 으로 옮겼던 것은 오독이었다 → 되돌린다.
  //
  // ★ 과거 사고 2건을 이 구조가 막는다(둘 다 라이브 실증 — docs/구현설계-2026-07-25/15).
  //  ① 배치: 구버전 주석은 `.pane-body` 기준이라 적혀 있었지만 `.pane-body` 에 `position` 이 없어 실제
  //     오프셋 부모는 `.pane` 이었고, `top:6px` 이 30px 짜리 `.pane-head`(탭바) 안으로 들어가 탭을 덮었다.
  //     → `styles.css` 의 `.pane-body { position: relative }` 가 이 계약의 절반이다(지우면 재발).
  //  ② 클릭 영구 사문화: 매 렌더마다 버튼의 innerHTML 을 다시 써서 자식 SVG 를 교체했고, pane 내부
  //     mousedown(capture)이 `focusPane()`→`emit()` 을 발화하므로 mousedown 타깃이 mouseup 전에 소멸 →
  //     WebKit 이 `click` 을 아예 디스패치하지 않았다(중앙 3회 무반응 / 모서리 1회 성공으로 실증).
  //     → 이 노드는 **한 번만 만들고 절대 remove 하지 않는다**(숨김은 `.hidden` 클래스), 글리프는
  //       `_modeGlyph !== want` 일 때만 다시 쓴다. `focusPane` 의 "무변화면 emit 생략" 가드도 유지.
  _buildModeToggle() {
    const b = document.createElement("button");
    b.className = "pane-mode-toggle hidden";
    b.type = "button";
    this._modeGlyph = "";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMode();
    });
    this._modeBtn = b;
    this.body.appendChild(b);
  }

  // 노출/모드 상태를 버튼에 반영. 판정은 `modeToggleState()`(정본 = agent-signal.js)가 전담한다.
  _syncModeToggle() {
    const b = this._modeBtn;
    if (!b) return;
    const st = this.modeToggleState();
    b.classList.toggle("hidden", !st.on);
    if (!st.on) return;
    // ★ 채팅 모드를 **색으로** 표시하지 않는다(사용자 확정 2026-07-27). 액센트 배경은 "선택된 필터"처럼
    //  읽혀 상태와 행동이 헷갈렸다 → 상태 표현은 글리프 교체 하나로만 한다(같은 이유로 `.active` 도 제거).
    b.title = st.chat ? "터미널(TUI) 보기" : "채팅으로 보기";
    // ★ 글리프는 **실제로 바뀔 때만** 다시 쓴다(매번 쓰면 클릭이 죽는다 — ② 항).
    //  크기 16 = 워크스페이스 헤더 추가 버튼과 같은 값(앱은 자기 헤더 기준 19).
    const want = st.chat ? "term" : "chat";
    if (this._modeGlyph !== want) {
      this._modeGlyph = want;
      b.innerHTML = st.chat ? icons.terminal({ size: 16 }) : icons.chat({ size: 16 });
    }
  }

  // ── Chat 모드 본문(터미널 탭의 하위 모드 — 새 pane kind 가 아니다) ──
  //  호스트만 미리 만들고 ChatView 는 첫 진입 때 lazy 생성한다(에이전트를 안 쓰는 pane 에 비용 0).
  //  ★ 터미널 레이어는 언마운트하지 않는다 — display:none 으로 가리기만(혼합 탭과 동일 경로).
  //    언마운트하면 스트림이 끊기고 재연결 카운터가 소진돼 복귀 시 수 초 공백 + 고아 터미널이 생긴다.
  _buildChat() {
    this.chatHost = document.createElement("div");
    this.chatHost.className = "pane-chat";
    this.chatHost.style.display = "none";
    this.body.appendChild(this.chatHost);
  }

  // TUI 모드의 질문 도크 — Chat 모드의 `.chat-approvals`(컴포저 위)와 **같은 카드를 같은 자리**에.
  //  ★ 절대배치 오버레이여야 한다: 흐름에 넣으면 터미널 높이가 바뀌어 fit → tmux resize 가 나간다.
  //  ★ 채우는 쪽은 approvals.js 다. import 하지 않고 DOM(.pane-appr-dock)으로 찾게 해 순환을 피한다.
  _buildApprDock() {
    this.apprDock = document.createElement("div");
    this.apprDock.className = "pane-appr-dock";
    this.body.appendChild(this.apprDock);
  }

  // 이 pane 이 지금 어느 터미널을 보여주는지 도크에 적어 둔다(빈 값 = 대상 없음 → 아무것도 안 그린다).
  _syncApprDock() {
    const d = this.apprDock;
    if (!d) return;
    const tab = this.node.tabs[this.node.active];
    const chat = isTermTab(tab) && tab && tab.mode === "chat";
    // Chat 모드에서는 ChatView 의 컴포저 위 슬롯이 그린다 — 여기서 또 그리면 같은 카드가 두 개 뜬다.
    const on = isTermTab(tab) && tab && typeof tab.win === "number" && !chat;
    d.dataset.cwd = on ? (this.ctx.localPath || "") : "";
    d.dataset.win = on ? String(tab.win) : "";
    if (!on) d.innerHTML = "";
  }

  // 활성 탭이 "에이전트가 붙은 터미널 탭"인가 — 판정 사다리 정본 = agent-signal.js(앱 agentPresence.ts 미러).
  //  ① push(agent_state) → 셸 확정만 항상-숨김 → ② 데몬 정규화 신호(목록 agent) → ③ tab.cmd 이름 →
  //  ③' 제목 글리프 → ④ 신호 없으면 **켠다**. push 가 비는 모든 순간(15분 스테일·WS 재접속 폐기·호스트
  //  오프라인·데몬 재기동·agentstate.v1 미선언)에 토글이 사라지던 것이 사용자 신고 증상이었고, ④ 가
  //  기본 ON 이라 ①→② 하강 전이에서 OFF 가 나올 수 없다(근거는 resolveAgentPresence 주석 ★ 항).
  // 탭 좌측 로고 — 붙어 있는 에이전트를 특정할 수 있을 때만 HTML, 모르면 null(호출측이 터미널 글리프).
  //  판정 입력은 _agentOn 과 **같은 재료**를 쓴다(신호 출처가 갈라지면 아이콘과 토글이 서로 다른 사실을
  //  주장한다 — 이 라운드 직전에 겪은 "표시와 클릭이 다른 대상" 사고와 같은 계열).
  _tabAgentMark(tab) {
    if (!tab || !isTermTab(tab) || typeof tab.win !== "number") return null;
    const cwd = this.ctx.localPath || "";
    const brand = resolveAgentBrand({
      push: this.ctx.agentStateOf?.(cwd, tab.win) || null,
      tab: { cmd: tab.cmd, title: tab.title, agent: tab.agent, agentName: tab.agentName, agentState: tab.agentState, mode: tab.mode },
    });
    return agentMarkHtml(brand, { size: 13 });
  }

  _agentOn(tab) {
    if (!tab || !isTermTab(tab) || typeof tab.win !== "number") return false;
    const cwd = this.ctx.localPath || "";
    return resolveAgentPresence({
      push: this.ctx.agentStateOf?.(cwd, tab.win) || null,
      tab: {
        cmd: tab.cmd,
        // 판정 입력은 앱과 **같은 재료**여야 한다(교차 테스트가 이걸 고정한다) → window name 하나만.
        //  pane_title 원본을 폴백으로 두는 코드가 있었지만 도달 불가였다(자동 개명 포맷은 셸=폴더명 /
        //  그 외=pane_title|pane_current_command 로 항상 비지 않고, 수동 rename 은 사용자 이름이 얼어붙는다)
        //  → 이름이 얼어붙은 터미널의 글리프 소실은 사다리 ④(기본 ON)가 흡수한다.
        title: tab.title,
        agent: tab.agent,          // 데몬 정규화 플래그(additive — 구 데몬/Rust 목록엔 없다 = 모름)
        agentState: tab.agentState,
        mode: tab.mode,
      },
    }).on;
  }
  // 지금 이 pane 이 Chat 모드를 그리고 있는가(리사이즈/크기주장 억제 판정의 단일 기준).
  //  ⚠ 판정은 **표시 조건(showActiveTab 의 chat)과 정확히 같아야 한다.** 여기에 _agentOn 을 AND 로 걸면
  //  claude 가 종료된 뒤에도 화면은 Chat 인데 억제 가드만 풀려, 창/분할 리사이즈 시 display:none 인 xterm 의
  //  스테일 cols/rows 로 ptyResize 를 보내고(_fitNow) 크기 주장(_claimSize)까지 되살아난다 —
  //  다른 기기가 쓰는 tmux 창 크기를 뺏는 과거 사고(12R·17R) 계열의 재발 경로다.
  _chatActive() {
    const tab = this.node.tabs?.[this.node.active];
    return !!(tab && isTermTab(tab) && tab.mode === "chat");
  }

  // TUI ↔ Chat 토글의 **노출/모드 판정**(그리기는 `_syncModeToggle` — 같은 pane 안이지만 분리해 둔다:
  //  판정은 앱과 동치 검증되는 순수 규칙, 그리기는 DOM 수명 규율이라 성격이 다르다).
  //  이 판정 경로(resolveToggleVisible/resolveAgentPresence)는 `test/agent-toggle.mjs` 가 앱과
  //  69,300 조합 동치로 고정한다 — 인라인 규칙으로 되돌리면 그 즉시 터진다.
  modeToggleState() {
    if (this.node.kind !== "terminal") return { on: false, chat: false };
    const tab = this.node.tabs?.[this.node.active];
    const chat = !!(tab && isTermTab(tab) && tab.mode === "chat");
    // 혼합 탭(IDE/프리뷰)이 활성이면 숨김 · win 미확정('new')이면 숨김(chat 스냅샷 키가 없다) ·
    //  이미 chat 모드면 에이전트가 사라져도 계속 표시(대화 기록을 읽고 TUI 로 돌아갈 길).
    //  ★ 이 세 규칙은 앱 `agentPresence.resolveToggleVisible` 과 **같은 함수**여야 한다(미러 = agent-signal.js).
    const on = resolveToggleVisible({
      isTerm: !!tab && isTermTab(tab),
      win: tab && isTermTab(tab) ? tab.win : null,
      chatMode: chat,
      agentOn: this._agentOn(tab),
    });
    return { on, chat };
  }

  // main-top 토글 클릭 → 이 pane 의 활성 터미널 탭 모드 전환.
  toggleMode() {
    const t = this.node.tabs?.[this.node.active];
    if (!t || !isTermTab(t)) return;
    this.setMode(t, t.mode === "chat" ? "tui" : "chat");
  }

  // 모드 전환 — tab 객체에 얹으므로 영속(pc-ui.json layout)·탭 이동(객체 참조 이동) 모두 자동 승계.
  //  기기 간 전파는 하지 않는다(세션 매니페스트 동기화는 폐지 상태 — 모드는 기기 로컬 규율).
  setMode(tab, mode) {
    if (!tab || !isTermTab(tab)) return;
    const next = mode === "chat" ? "chat" : "tui";
    if ((tab.mode || "tui") === next) return;
    tab.mode = next;
    if (next === "tui") delete tab.mode; // 기본값은 저장하지 않는다(하위호환 = 미지정도 tui)
    this._syncModeToggle();
    this.buildHead();
    this.showActiveTab();
    // TUI 복귀 시 fit 은 showActiveTab 이 이미 1회 수행한다(여기서 또 부르면 리사이즈가 2회 나간다 —
    //  하네스에서 실측). 포커스만 터미널로 돌린다.
    if (next === "tui") this.focus();
    this.ctx.persist?.();
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
      getCtx: () => this.ctx,
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
    fillPreviewEmpty(host);
    this.previewHost = host;
    this.previewUrl = this.node.url || "";
    // webview 로드용 실효 URL(원격이면 프록시로 치환) — 복원된 URL 도 즉시 매핑.
    this._pvEffUrl = this.previewUrl;
    if (this.previewUrl) this._applyPvEff(this.previewUrl, false);
    this.body.append(this.previewBar.el, host);
    dtAttachHost(this._pvId, host); // 승계된 데브툴 세션이 있으면 새 host 에 재부착
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
    this._loadRenderer();
    this._setupInput();
    this._fitNow();
    // 폰트 lazy-load 대응 — xterm 은 open() 시점 폰트로 글자폭을 캐시한다. 웹폰트가 그 뒤에
    //  로드되면 셀 폭이 변하는데(실측 7.559→7.724) 재측정 없이는 낡은 폭으로 잡은 cols 가
    //  유지돼 마지막 열이 잘린다. fontFamily 재할당이 강제 재측정 트리거다(모바일과 동일 수법).
    try {
      document.fonts?.ready?.then(() => {
        if (this._disposed || !this.term) return;
        const fam = this.term.options.fontFamily;
        this.term.options.fontFamily = "monospace";
        this.term.options.fontFamily = fam;
        this._fitNow();
        this.term.refresh(0, this.term.rows - 1);
      });
    } catch (_) {}
    // 스트림은 "터미널" 탭 기준 — 활성 탭이 IDE/프리뷰(혼합 탭)여도 백그라운드 터미널은 유지.
    //  터미널 탭이 하나도 없으면 채널 없이 혼합 탭 본문만 표시.
    const active = this.node.tabs[this.node.active];
    const termTab = (isTermTab(active) && active) || this.node.tabs.find((t) => isTermTab(t));
    if (termTab) {
      const win = await this._ensureWin(termTab);
      if (typeof win === "number") this._openChannel(win); // 확보 실패(탭 회수)면 빈 상태 유지
    }
    this.showActiveTab();
    // Chat 모드 중 창/분할 리사이즈로는 tmux window 를 건드리지 않는다(검증 게이트 4: 전후 동일).
    //  복귀 시 setMode 가 1회 fit 하므로 크기는 그때 맞는다.
    this.ro = new ResizeObserver(() => {
      if (!this._chatActive()) this._fitNow();
      this._mixed.forEach((m) => m.ide?.refresh());
    });
    this.ro.observe(this.el);
  }

  // GPU 렌더러(webgl→canvas→dom 폴백) — 마지막 열 잘림의 근본 수정(2026-07-27 픽셀 실측).
  //  DOM 렌더러는 WebKit 텍스트 레이아웃(letter-spacing 서브픽셀 라운딩)에 의존해 행 끝으로
  //  갈수록 글리프가 오른쪽으로 밀리고, 마지막 열 글리프가 클립 밖으로 나가 아예 안 그려진다
  //  (버퍼엔 │ 가 있는데 세로선 픽셀 0 — 가로 ─ 는 셀을 가득 채워 선이 이어져 보여 오진 유발).
  //  webgl/canvas 는 셀을 디바이스 픽셀 격자에 직접 그려 드리프트 자체가 없다. 모바일
  //  TerminalWebView 가 같은 구성으로 무증상임을 확인하고 이식했다.
  _loadRenderer() {
    const useCanvas = () => {
      try {
        const c = new window.CanvasAddon.CanvasAddon();
        this.term.loadAddon(c);
        return true;
      } catch (_) { return false; }
    };
    try {
      const gl = new window.WebglAddon.WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch (_) {} useCanvas(); });
      this.term.loadAddon(gl);
    } catch (_) { useCanvas(); }
  }

  async _ensureWin(tab) {
    if (this.ctx.isLocal && isTermTab(tab) && (tab.win === "new" || tab.win == null)) {
      try {
        // 풀의 미배치 터미널 먼저 입양(첫 진입 시 남발 방지) → 없으면 풀에 새 터미널 생성(전 기기 공유).
        //  '+'로 만든 탭(fresh)은 입양 없이 반드시 새로 생성(사용자가 새 터미널을 명시 요청).
        const r = (!tab.fresh && (await this.ctx.claimPoolWin?.())) || (await api.newWindow(this.ctx.localPath || "", this.id));
        tab.win = r.index;
        if (r.name) tab.title = r.name;
      } catch (e) {
        // 확보 실패 = 탭 회수. 과거의 win=0 폴백은 어떤 목록에도 없는 유령 win 이라
        //  리컨실러 탭 제거의 씨앗이었다(실제 저장본 [0] 흔적). 'new' 로 남기는 것도
        //  pending 가드가 리컨실을 정지시키므로 금물 — 깨끗이 걷어내고 로그만 남긴다.
        api.debugLog(`ensureWin: 터미널 확보 실패 pane=${this.id} — 탭 회수 (${e})`);
        const i = this.node.tabs.indexOf(tab);
        if (i >= 0) {
          this.node.tabs.splice(i, 1);
          this.node.active = Math.max(0, Math.min(this.node.tabs.length - 1, this.node.active));
          this.buildHead();
          this.showActiveTab();
        }
        delete tab.fresh;
        this.ctx.onSurfacesChanged?.();
        this.ctx.persist?.();
        return null;
      }
      delete tab.fresh;
      this.ctx.onSurfacesChanged?.();
    }
    // "터미널 추가 ▾ → Claude" — tid 를 아는 **유일한 지점**이 여기다(탭 추가·분할 두 경로가 모두
    //  이 함수를 지난다). 명령 타이핑 자체는 데몬(agents.launch)이 한다: 새 셸이 사용자 rc 를 다
    //  읽기 전에 키를 보내면 씹히는데, 그 준비 판정을 클라마다 구현하면 한쪽만 고쳐지는 결함이 된다.
    //  ⚠ 반드시 지운다 — 영속(pc-ui.json)에 남으면 앱을 켤 때마다 에이전트가 저절로 실행된다.
    if (tab && tab.launchAgent) {
      const agentId = tab.launchAgent;
      delete tab.launchAgent;
      if (tab.win != null && tab.win !== "new") {
        api.agentsLocal("agents.launch", { cwd: this.ctx.localPath || "", index: tab.win, id: agentId })
          .catch((e) => api.debugLog(`agents.launch 실패 pane=${this.id} agent=${agentId} — ${e}`));
      }
    }
    return tab.win;
  }

  // 크기 주장(스로틀) — 사용자가 이 pane 을 실제로 만질 때(클릭/포커스/타이핑), 표시 창이 다른
  //  기기 크기로 잡혀 있으면 Rust 가 클라이언트 nudge 로 회수한다(이미 내 크기면 no-op).
  //  모바일은 키보드 노출 등 실 리사이즈가 자연 클레임을 만들지만 PC 는 이 훅이 유일한 계기다.
  _claimSize() {
    if (!this.ctx.isLocal || this.node.kind !== "terminal") return;
    // Chat 모드는 터미널을 "보고 있지 않다" = 크기 주장 자격이 없다. 여기서 주장하면 다른 기기가
    //  실제로 쓰고 있는 창 크기를 놀고 있는 화면이 뺏는다(PaneView.tsx:540 주석과 같은 사고).
    if (this._chatActive()) return;
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
    //  반드시 시간 제한(2s) — 닫을 채널이 없던 경우 exit 이 안 와서 표식이 남으면, 이후의 "진짜"
    //  종료 이벤트를 삼켜 pane 이 죽은 채 침묵(입력 무반응·복구 루프 미작동)하는 사고가 났다.
    this._expectExit = true;
    clearTimeout(this._expectExitTimer);
    this._expectExitTimer = setTimeout(() => { this._expectExit = false; }, 2000);
    try { await api.ptyClose(this.id); } catch (_) {}
    this._openChannel(win);
  }

  // ── 탭 조작 ──
  // launchAgent: 'claude' | 'codex' | … — 새 터미널이 준비되면 그 명령을 타이핑해 실행한다(§_ensureWin).
  async addTab(launchAgent) {
    if (this.node.kind !== "terminal" || !this.ctx.isLocal) return;
    const tab = { win: "new", title: "", fresh: true, ...(launchAgent ? { launchAgent } : {}) };
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
      // IDE/프리뷰 탭 = 이 기기 뷰만 닫힘. 프리뷰면 다른 기기도 같이 닫도록 신호(원격 적용 중이면 재전파 안 함).
      this.disposeMixedTab(tab);
      if (tab.kind === "preview") this.ctx.onSurfaceClosed?.("preview");
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
    // Chat 모드 = 터미널 탭이지만 본문은 채팅. 터미널 레이어는 살아 있는 채로 가려진다.
    const chat = !empty && isT && !!tab && tab.mode === "chat";
    if (chat) this._ensureChat();
    if (this.emptyEl) this.emptyEl.style.display = empty ? "flex" : "none";
    this.termEl.style.display = !empty && isT && !chat ? "" : "none";
    if (this.chatHost) this.chatHost.style.display = chat ? "flex" : "none";
    this.chat?.setVisible(chat);
    if (chat) {
      this.chat?.retarget();                       // 활성 터미널 탭이 바뀌었으면 그 대화로 재타깃
      this.chat?.setAgentGone(!this._agentOn(tab)); // 종료돼도 자동 전환하지 않고 배너만(§6-4)
    }
    for (const [tid, m] of this._mixed) {
      const on = !isT && tab && tab.tid === tid;
      m.host.style.display = on ? "flex" : "none";
      if (on && m.ide) m.ide.refresh();
      m.preview?.setVisible(!!on);
    }
    // ★ Chat 모드에서는 fit 을 부르지 않는다 — fit → ptyResize → tmux window 리사이즈가 되고,
    //   그게 "프롬프트 무한누적"(17R) 계열 사고의 진범이었다. 복귀 시 setMode 가 1회만 맞춘다.
    if (isT && !chat) this._fitNow();
    this._syncModeToggle();
    this._syncApprDock();
  }

  // 첫 chat 진입 시에만 ChatView 생성(lazy). ctx 는 전부 라이브 getter — 재클레임으로 host 가 바뀌거나
  //  활성 탭이 바뀌어도 생성 시점 스냅샷에 고착되지 않게(paneCtx 의 isLocal/hostDeviceId 와 같은 규율).
  _ensureChat() {
    if (this.chat || !this.chatHost) return this.chat;
    this.chat = new ChatView(this.chatHost, {
      cwd: () => this.ctx.localPath || "",
      // 로컬(이 PC)이든 원격(다른 PC)이든 **항상** 명시한다. 미지정이면 back 이 "활성 러너"로
      //  라우팅하는데, 여러 PC 가 붙어 있으면 다른 PC 의 트랜스크립트를 읽어오는 오배달이 된다
      //  (승인 resolve 가 runnerId 를 필수로 두는 이유와 같다).
      hostDeviceId: () => this.ctx.hostDeviceId ?? null,
      tid: () => {
        const t = this.node.tabs?.[this.node.active];
        return t && isTermTab(t) && typeof t.win === "number" ? t.win : null;
      },
      getDraft: () => {
        const t = this.node.tabs?.[this.node.active];
        return (t && t.chatDraft) || "";
      },
      setDraft: (s) => {
        const t = this.node.tabs?.[this.node.active];
        if (!t || !isTermTab(t)) return;
        if (s) t.chatDraft = String(s).slice(0, CHAT.DRAFT_MAX);
        else delete t.chatDraft;
        this.ctx.persist?.();
      },
      exitChat: () => {
        const t = this.node.tabs?.[this.node.active];
        if (t) this.setMode(t, "tui");
      },
      // 이 터미널에서 도는 CLI — 데몬이 어느 대화 로그를 읽을지 정하는 근거다. **탭 로고와 같은
      //  사다리**(resolveAgentBrand)를 쓴다: 두 곳이 갈라지면 '탭엔 codex 로고인데 채팅은 claude 대화'
      //  가 된다(2026-07-28 실사고). 모르면 null → 데몬 기본값(claude).
      agent: () => {
        const t = this.node.tabs?.[this.node.active];
        if (!t || !isTermTab(t) || typeof t.win !== "number") return null;
        return resolveAgentBrand({
          push: this.ctx.agentStateOf?.(this.ctx.localPath || "", t.win) || null,
          tab: { cmd: t.cmd, title: t.title, agent: t.agent, agentName: t.agentName, agentState: t.agentState, mode: t.mode },
        });
      },
      // 서버 경로(chat.input)가 막혔을 때의 폴백 — 이 pane 은 이미 그 터미널에 붙어 있으므로
      //  같은 규칙(bracketed paste + 지연 Enter)으로 로컬 채널로 보낸다. 같은 claude 세션이다.
      sendFallback: (text) => {
        if (!this.term) return false;
        this.insertText(text);
        setTimeout(() => { try { this._write("\r"); } catch (_) {} }, CHAT.SEND_ENTER_DELAY_MS);
        return true;
      },
      openFile: (rel) => this.ctx.onOpenIde?.(rel),
      // 컴포저 `+` 파일 목록의 출처 — IDE 트리와 **같은 제공자**(로컬 api / 원격 makeRemoteFs).
      //  라이브 getter 인 이유는 `_ideFs()` 와 동일: 재클레임으로 host 가 바뀌면 그때의 값이어야 한다.
      fs: () => this._ideFs() || api,
    });
    this.chat.mount();
    return this.chat;
  }
  // 리컨실러가 매 틱 호출하는 자가치유 워치독 — 빈 pane 에 터미널이 편입됐거나, 어떤 경로로든
  //  채널이 죽은 채 방치돼 있으면(_attachedWin 낙관 상태가 스테일해도 Rust 에 실제 생존을 물어
  //  진실 기준) 활성 터미널 탭으로 재attach 한다. 빈 상태 자리표시 토글도 갱신.
  async ensureAttached() {
    if (this.node.kind !== "terminal" || !this.mounted) return;
    this.showActiveTab();
    if (!this.ctx.isLocal) return;
    if (typeof this._attachedWin === "number") {
      const alive = await api.ptyAlive(this.id).catch(() => true);
      if (alive) return;
      this._attachedWin = null; // 죽었는데 낙관 상태만 남음(이벤트 유실 등) — 아래서 재attach
    }
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

  // xterm 만 실측 재맞춤(PTY 로 resize 를 보내지 않는다) — 채널을 열기 **전에** 크기를 확정하는 용도.
  //  ★ 왜 필요한가(2026-07-27 실측): `addTab` 은 `showActiveTab()` 직후 `_reattach` → `_openChannel` 로
  //   가는데, 그 시점 `this.term.cols/rows` 는 **이전(또는 빈 상태 자리표시) 치수**다. 그 값으로
  //   `pty_open` 을 부르면 tmux window 가 그 크기로 만들어지고 — 라이브 실측에서 **42x15** 였다 —
  //   그 안에서 뜬 TUI(claude 환영 박스)가 좁은 폭으로 그려진다. tmux 는 히스토리를 리플로우하지
  //   않으므로 나중에 창을 넓혀도 **그 화면은 영구히 어긋난 채 남는다**(사용자 신고: "우측이 잘린다").
  //  `_fitNow` 대신 이것을 쓰는 이유: 아직 채널이 없어 resize 를 보낼 대상이 없다.
  _fitLocalOnly() {
    if (!this.term || !this.termEl) return;
    // 숨겨진 동안 측정하면 0 이 나와 오히려 망친다(컴포저 붕괴와 같은 계열의 함정).
    if (this.termEl.offsetParent === null || !this.termEl.clientWidth) return;
    try { this.fit.fit(); } catch (_) { /* noop */ }
    this._correctFit();
  }

  // ── 채널(로컬 pty / 클라우드 WS) ──
  async _openChannel(win) {
    this._fitLocalOnly();          // 스테일 치수로 창을 만들지 않는다(§_fitLocalOnly)
    // 첫 측정은 폰트 로드·레이아웃 확정 전일 수 있다. ResizeObserver 는 **컨테이너 크기가 바뀔 때만**
    //  울리므로 "크기는 그대로인데 측정이 나중에 정확해지는" 경우를 아무도 바로잡지 않는다
    //  → 채널을 연 뒤 두 번 더 검산한다(같은 값이면 _resize 가 no-op 수준이라 비용 0).
    for (const delay of [250, 1200]) {
      setTimeout(() => { if (this.term && this._attachedWin === win) this._fitNow(); }, delay);
    }
    const { cols, rows } = this.term;
    if (this.ctx.isLocal) {
      this._attachedWin = typeof win === "number" ? win : null;
      this._sentCols = cols || 80;   // ptyOpen 이 이미 이 크기를 전달했다 → 직후 no-op 을 걸러내게
      this._sentRows = rows || 24;
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
      // 터미널엔 텍스트 실행취소 개념이 없다 — ⌘Z/⌘⇧Z/⌘Y 는 xterm 숨은 textarea 에 네이티브 undo 를
      //  걸어 그 델타가 셸로 새어 입력라인을 오염시킨다(IDE undo 가 터미널로 새는 것처럼 보임). 삼킨다.
      if (e.metaKey && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
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
    // 붙여넣기 — 우리가 직접 1회만 전송하고 두 중복 경로를 모두 차단한다.
    //  (버그: xterm 자체 paste 핸들러 onData→_write 와, textarea 에 붙은 텍스트의 input 델타→_write 가
    //   동시에 발화해 붙여넣기가 2번 들어갔다. preventDefault 로 네이티브 삽입(→input) 차단 +
    //   stopImmediatePropagation 으로 xterm paste 핸들러 차단 → 여기서 한 번만 보낸다.)
    const onPaste = (e) => {
      if (e.target !== ta) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
      if (!text) return;
      let t = text.replace(/\r?\n/g, "\r");                         // xterm 규칙: 개행 → CR
      if (this.term?.modes?.bracketedPasteMode) t = "\x1b[200~" + t + "\x1b[201~"; // 앱이 bracketed paste 지원 시 감쌈
      this._write(t);
      resetBuf();                                                   // textarea 미변경 → 미러(_sentBuf) 동기 유지
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
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("compositionstart", onComp, true);
    document.addEventListener("compositionupdate", onComp, true);
    document.addEventListener("compositionend", onCompEnd, true);
    this._inputDispose = () => {
      ta.removeEventListener("blur", onBlur);
      ta.removeEventListener("focus", onFocus);
      this.termEl?.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("compositionstart", onComp, true);
      document.removeEventListener("compositionupdate", onComp, true);
      document.removeEventListener("compositionend", onCompEnd, true);
    };
  }
  // 프로그램적 텍스트 삽입(OS 파일 드롭 등) — 붙여넣기(onPaste)와 동일 규칙:
  //  개행→CR, bracketed paste 지원 시 감쌈, textarea 미변경이므로 미러(_sentBuf) 리셋으로 동기 유지.
  insertText(text) {
    if (this.node.kind !== "terminal" || !text) return;
    let t = String(text).replace(/\r?\n/g, "\r");
    if (this.term?.modes?.bracketedPasteMode) t = "\x1b[200~" + t + "\x1b[201~";
    this._write(t);
    this._sentBuf = "";
    try { const ta = this.term?.textarea; if (ta) ta.value = ""; } catch (_) {}
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
    this._correctFit();
    const { cols, rows } = this.term;
    if (!cols || !rows) return;
    // ★ 값이 안 바뀌었으면 보내지 않는다. 라이브 로그로 드러난 것: `_fitNow` 가 **7초마다**(리컨실
    //  틱) 같은 결과로 재실행되며 매번 `ptyResize` 를 보냈다. tmux 는 `window-size latest` 라 그
    //  resize 가 곧 **창 크기 재클레임**이다 → 폰이 같은 터미널을 보고 있으면 PC 가 7초마다 폰의
    //  크기를 뺏는다(12R 에서 "포그라운드+입력포커스만 주장"으로 좁혀 놓은 규율을 무의미하게 만든다).
    //  no-op 를 걸러내면 사용자가 실제로 창을 바꿀 때만 주장한다.
    if (this._sentCols === cols && this._sentRows === rows) return;
    this._sentCols = cols;
    this._sentRows = rows;
    this._resize(cols, rows);
  }

  // fit() 결과의 실측 검산 — FitAddon 은 "부모 computed 폭"(border-box 라 padding 포함) 에서
  //  스크롤바만 빼서 cols 를 정하는데, 그 내용을 실제로 보여주는 영역은 `.xterm-viewport` 의
  //  clientWidth(스크롤바 제외)다. 두 값이 다르므로 마지막 열이 스크롤바 아래로 잘린다
  //  ★ 내부 API(`_core._renderService.dimensions`)는 벤더 업그레이드로 사라질 수 있으므로 전부 방어적으로
  //   읽고, 하나라도 비면 **보정을 건너뛴다**(조용히 죽지 않게 = 기존 동작 유지).
  //  ★ 루프 상한 2회. 보정 resize 는 셀 폭을 소수점 셋째 자리에서 다시 계산하므로(canvas.width/cols)
  //   한 번 더 검산할 여지만 주고, 변화가 없으면 즉시 끝낸다(무한 루프 구조적 불가).
  _correctFit() {
    const t = this.term;
    if (!t || !this.termEl) return;
    // ★ 비교 대상 = **필요한 내용 폭(cols×cellW) vs `.xterm-screen` 의 폭**.
    //  여기까지 오는 데 네 번 틀렸다. 틀린 대리 지표들:
    //   ① FitAddon 제안값 ② `.xterm-viewport.clientWidth` ③ 거기서 스크롤바 폭 추정치를 뺀 값
    //   ④ `.xterm-screen` 의 **rect 를 `.pane-term` 의 rect 와 비교** ← 이게 특히 나빴다:
    //      `.xterm-screen` 이 **바로 그 클립 경계**이므로 pane 과 비교하면 항상 "여유 있음"이 나온다.
    //  실기기 픽셀 분석으로 확정한 실제 모습(2026-07-27):
    //    셀1 시작 744.0 · 가로 테두리는 **1188.0 에서 끊김** · `.xterm-screen` 폭 445
    //    필요한 폭 58×7.724 = 448.0 → **초과 3.0px** → 58번째 셀이 절반만 보인다.
    //    `─` 는 왼쪽 절반이 보여 살아남고, `│` 는 세로 획이 셀 **가운데**(≈1188.2)라 통째로 사라진다
    //    → "박스 우측 테두리만 없다"로 보였다. 버퍼에는 `│` 가 온전히 있었다(capture-pane 확인).
    for (let pass = 0; pass < 3; pass++) {
      let cols = t.cols, rows = t.rows;
      try {
        const cell = t._core?._renderService?.dimensions?.css?.cell;
        const screen = this.termEl.querySelector(".xterm-screen");
        if (!cell || !screen || !cell.width || !cell.height) return; // 벤더 구조 변경 → 보정 없음
        const sw = screen.getBoundingClientRect().width;
        const sh = screen.getBoundingClientRect().height;
        if (!sw || !sh) return;                                       // 레이아웃 미확정 → 다음 기회
        // 0.5px 여유(rect 는 소수, 셀 폭은 canvas.width/cols 로 흔들린다).
        const overX = t.cols * cell.width - (sw + 0.5);
        const overY = t.rows * cell.height - (sh + 0.5);
        if (overX > 0) cols = Math.max(2, t.cols - Math.ceil(overX / cell.width));
        if (overY > 0) rows = Math.max(1, t.rows - Math.ceil(overY / cell.height));
        if (pass === 0) {
          const winW = document.documentElement.clientWidth;
          const paneR = (this.el || this.termEl).getBoundingClientRect().right;
          const line = `fit pane=${this.id} ${t.cols}x${t.rows} cell=${cell.width.toFixed(3)}`
            + ` need=${(t.cols * cell.width).toFixed(1)} screenW=${sw.toFixed(1)}`
            + ` over=${overX.toFixed(1)},${overY.toFixed(1)} paneR=${paneR.toFixed(0)} winW=${winW}`
            + ` → ${cols}x${rows}`;
          if (line !== this._lastFitLog) { this._lastFitLog = line; api.debugLog(line); }
        }
      } catch (_) { return; }
      if (cols === t.cols && rows === t.rows) return;   // 더 줄일 것 없음
      try { t.resize(cols, rows); } catch (_) { return; }
    }
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
        // punch-through: 웹뷰는 앱 UI "아래" — DOM 모달/메뉴가 자연히 위. 드래그 중만 숨김 유지.
        // placeholder 만 제거(innerHTML="" 는 데브툴 UI 까지 소거 — 위 PreviewSurface 와 동일 규칙).
        if (this._pvEffUrl) host.querySelector(".preview-empty")?.remove();
        // punch-through: 드래그 중에도 숨기지 않는다(위 PreviewSurface 와 동일 규칙 — shield 가 이벤트 차단).
        const visible = r.width > 2 && r.height > 2;
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
      // Chat 모드에서 터미널 검색을 열면 "보이지도 않는 스크롤백"을 검색하게 된다(혼란).
      //  채팅 내 검색은 v1 범위 제외(§6-8) → 아무 것도 하지 않는다.
      if (this._chatActive()) return;
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
    // 검색 위젯(top:8/right:14/z-index:40)과 모드 토글(top:6/right:12/z-index:36)은 좌표가 겹친다.
    //  z-index 를 40 위로 올리면 검색 입력을 가리므로, 검색이 열려 있는 동안 토글을 비활성 은닉한다.
    this.body.classList.add("search-open");
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
    this.body?.classList.remove("search-open");
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
    try { this.chat?.dispose(); } catch (_) {}
    this.chat = null;
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
      dtDispose(this._pvId, this._preservePreview, this.previewHost);
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
