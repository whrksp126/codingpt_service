// workspace-view.js — 활성 워크스페이스 헤더(폴더명) + 타일링 pane 그리드.
//  각 pane 은 자체 탭 헤더(cmux식)를 가진다. tiling 트리를 DOM 으로 조립하고 PaneView 를 재사용.
import { state, wsRuntime, activeWs, isLocal } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { PaneView, isTermTab, newTid } from "./pane.js";
import { handleOsc } from "./notifications.js";
import { buildTopControls } from "./sidebar.js";
import { api } from "./api.js";
import { icons } from "./icons.js";

let hostEl = null;
let mainTop = null;
let gridEl = null;
let panes = new Map();
let lastSig = "";
let lastWsId = null;
let paneRects = {};

export function mountWorkspaceView(container) {
  hostEl = container;
  hostEl.innerHTML = "";
  mainTop = document.createElement("div");
  mainTop.className = "main-top";
  mainTop.setAttribute("data-tauri-drag-region", "");
  gridEl = document.createElement("div");
  gridEl.className = "ws-grid";
  hostEl.append(mainTop, gridEl);
}

function structureSig(node) {
  if (!node) return "∅";
  if (T.isLeaf(node)) return `L:${node.id}:${node.kind}`;
  return `B:${node.dir}(${structureSig(node.first)},${structureSig(node.second)})`;
}

function paneCtx(ws) {
  return {
    localPath: ws?.localPath || "",
    isLocal: isLocal(ws),
    onFocus: (id) => S.focusPane(id),
    onNotify: (paneId, title, body) => handleOsc(state.activeWsId, paneId, title, body),
    onSurfacesChanged: () => {},
    onClosePane: (paneId) => S.closePane(state.activeWsId, paneId),
    onMoveTab: (srcId, index, dstId) => moveTab(srcId, index, dstId),
    onTabDragStart: (paneId, index, e) => beginTabDrag(paneId, index, e),
    paneDropZone: (x, y) => paneDropZone(x, y),
    onFileSplit: (filePath, srcPaneId, targetPaneId, zone) => openFileInPane(filePath, srcPaneId, targetPaneId, zone),
    claimPoolWin: () => claimPoolWin(ws),
    persist: () => S.emit(),
  };
}

// 풀의 미배치 터미널 입양 — 'new' 탭이 풀에 이미 있는 터미널을 놔두고 새로 만드는 것을 방지.
//  _claiming: 동시 다발 pane 들이 같은 window 를 이중 입양하지 않게 5초 예약.
const _claiming = new Set();
async function claimPoolWin(ws) {
  const rt = wsRuntime(state.activeWsId);
  if (!ws || !isLocal(ws) || !rt || !rt.layout) return null;
  try {
    const wins = (await api.listWindows(ws.localPath || "")) || [];
    const used = new Set();
    T.eachLeaf(rt.layout, (l) => { if (l.kind === "terminal") { for (const t of l.tabs) if (typeof t.win === "number") used.add(t.win); } });
    for (const w of wins) {
      if (!used.has(w.index) && !_claiming.has(w.index)) {
        _claiming.add(w.index);
        setTimeout(() => _claiming.delete(w.index), 5000);
        return { index: w.index, name: w.name || "" };
      }
    }
  } catch (_) { /* 오프라인 → 생성 폴백 */ }
  return null;
}

// ── VS Code 식 탭 드래그 — 포인터 캡처 + 전체화면 오버레이(iframe/xterm 위에서도 이벤트 유실 없음).
//   드래그 중 실시간 예측 위치(존 인디케이터) 표시, 놓는 즉시 적용(추가 클릭 불필요).
let ghostEl = null;
let zoneEl = null;
let insEl = null;
function beginTabDrag(srcId, index, e) {
  const rt = wsRuntime(state.activeWsId);
  const src = rt && T.findLeaf(rt.layout, srcId);
  if (!src) return;
  // 터미널 = 탭 단위 이동, IDE/프리뷰 = pane 통째 이동(index<0).
  const wholePane = src.kind !== "terminal" || index < 0;
  const tab = wholePane ? null : src.tabs[index];
  const tabIsTerm = tab ? isTermTab(tab) : false;
  const label = wholePane
    ? (src.kind === "ide" ? "IDE" : "프리뷰")
    : tabIsTerm
      ? tab?.title || (typeof tab?.win === "number" ? "터미널 " + tab.win : "터미널")
      : tab?.kind === "ide" ? "IDE" : "프리뷰";
  const ghostIcon = wholePane
    ? (src.kind === "ide" ? icons.code : icons.globe)
    : tabIsTerm ? icons.terminal : tab?.kind === "ide" ? icons.code : icons.globe;
  const pointerId = e.pointerId;
  const startX = e.clientX, startY = e.clientY;
  let dragging = false;
  let drop = null; // { paneId, zone }
  let overlay = null;
  let srcTabEl = null; // 드래그 중 흐리게 표시할 원본 탭
  // 탭바 끝단 자동 스크롤 — 일반 DnD 처럼 끝에 대면 가려진 탭이 나타나 원하는 위치에 놓을 수 있다.
  let lastEv = null;       // 마지막 포인터 좌표(정지 상태에서 스크롤 후 재판정용)
  let scrollEl = null;     // 스크롤 대상 .pane-tabs
  let scrollDir = 0;       // -1/0/1
  let scrollRaf = 0;

  const start = () => {
    dragging = true;
    document.body.classList.add("tab-dragging");
    // 잡힌 탭(원본)은 흐리게 — "이 자리는 비워질 것"을 표현(예상 위치 표시와 결과 일치감).
    const srcTabs = panes.get(srcId)?.el?.querySelectorAll(".pane-tabs .ptab");
    srcTabEl = srcTabs ? (wholePane ? srcTabs[0] : srcTabs[index]) : null;
    srcTabEl?.classList.add("drag-src");
    overlay = document.createElement("div");
    overlay.className = "drag-overlay";
    document.body.appendChild(overlay);
    try { overlay.setPointerCapture(pointerId); } catch (_) {}
    ghostEl = document.createElement("div");
    ghostEl.className = "tab-ghost";
    ghostEl.innerHTML = `<span class="tg-ic">${ghostIcon({ size: 13 })}</span>${escGhost(label)}`;
    document.body.appendChild(ghostEl);
    zoneEl = document.createElement("div");
    zoneEl.className = "drop-zone hidden";
    document.body.appendChild(zoneEl);
    insEl = document.createElement("div");
    insEl.className = "tab-insert hidden";
    document.body.appendChild(insEl);
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerup", onUp);
    overlay.addEventListener("lostpointercapture", onUp);
    // 자동 스크롤 틱 — 포인터가 정지해도 계속 스크롤돼야 하므로 move 이벤트가 아닌 rAF 루프.
    const tick = () => {
      if (scrollDir && scrollEl) {
        const before = scrollEl.scrollLeft;
        scrollEl.scrollLeft = before + scrollDir * 9;
        if (scrollEl.scrollLeft !== before && lastEv) update(lastEv); // 탭 rect 가 밀렸으니 인서트 라인 재판정
      }
      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  };
  const update = (ev) => {
    lastEv = { clientX: ev.clientX, clientY: ev.clientY };
    ghostEl.style.left = ev.clientX + 14 + "px";
    ghostEl.style.top = ev.clientY + 14 + "px";
    // 오버레이가 최상단이라 hit-test 방해 → 잠깐 통과시켜 아래 pane 탐지.
    overlay.style.pointerEvents = "none";
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    overlay.style.pointerEvents = "";
    const pane = el && el.closest && el.closest(".pane");
    scrollDir = 0; // 탭바 끝단에 있을 때만 아래에서 다시 세팅
    if (!pane) { zoneEl.classList.add("hidden"); insEl.classList.add("hidden"); drop = null; return; }
    const paneId = pane.dataset.paneId;
    const r = pane.getBoundingClientRect();
    const head = pane.querySelector(".pane-head");
    const headR = head ? head.getBoundingClientRect() : null;
    const headH = headR ? headR.height : 0;
    // 탭바 위 = 순서 재배치/편입. 삽입 위치 라인 표시.
    //  IDE/프리뷰 pane 통째 드래그도 터미널 pane 탭바에 놓으면 "탭"으로 편입(혼합 탭).
    const targetLeaf = T.findLeaf(rt.layout, paneId);
    const canTabbar = !wholePane || src.kind === "ide" || src.kind === "preview";
    if (canTabbar && headR && ev.clientY >= headR.top && ev.clientY <= headR.bottom && targetLeaf && targetLeaf.kind === "terminal") {
      const tabsRegion = pane.querySelector(".pane-tabs");
      // 끝단 자동 스크롤 판정 — 넘친 탭바에서만, 좌/우 36px 밴드.
      if (tabsRegion && tabsRegion.scrollWidth > tabsRegion.clientWidth + 1) {
        const tr2 = tabsRegion.getBoundingClientRect();
        scrollEl = tabsRegion;
        scrollDir = ev.clientX < tr2.left + 36 ? -1 : ev.clientX > tr2.right - 36 ? 1 : 0;
      }
      const tabEls = tabsRegion ? [...tabsRegion.querySelectorAll(".ptab")] : [];
      let ti = tabEls.length;
      for (let k = 0; k < tabEls.length; k++) {
        const tr = tabEls[k].getBoundingClientRect();
        if (ev.clientX < tr.left + tr.width / 2) { ti = k; break; }
      }
      drop = { paneId, zone: "tabbar", index: ti };
      zoneEl.classList.add("hidden");
      const lineX = ti < tabEls.length ? tabEls[ti].getBoundingClientRect().left : (tabEls.length ? tabEls[tabEls.length - 1].getBoundingClientRect().right : (tabsRegion ? tabsRegion.getBoundingClientRect().left : r.left));
      insEl.style.left = lineX - 1 + "px";
      insEl.style.top = headR.top + 4 + "px";
      insEl.style.height = headR.height - 8 + "px";
      insEl.classList.remove("hidden");
      return;
    }
    insEl.classList.add("hidden");
    let zone = "center";
    if (ev.clientY > r.top + headH) {
      const fx = (ev.clientX - r.left) / r.width;
      const fy = (ev.clientY - r.top) / r.height;
      const m = Math.min(fx, 1 - fx, fy, 1 - fy);
      if (m < 0.25) {
        if (m === fx) zone = "left";
        else if (m === 1 - fx) zone = "right";
        else if (m === fy) zone = "top";
        else zone = "bottom";
      }
    }
    drop = { paneId, zone };
    // 존 하이라이트 배치 — 표시는 "실제 드랍 결과" 기준으로 보정:
    //  · no-op 드랍(자기 pane 통째/단일 탭, 비터미널 pane 가운데로 탭 이동)은 숨김/제자리 표시
    //  · src pane 이 사라지는 드랍은 형제 확장 후(rectAfterRemoval)의 rect 로 그린다.
    const disp = displayDrop(rt.layout, src, wholePane, srcId, drop);
    if (!disp) { zoneEl.classList.add("hidden"); return; }
    const dr = disp.rect;
    let zx = dr.x, zy = dr.y, zw = dr.w, zh = dr.h;
    if (disp.zone === "left") zw = dr.w / 2;
    else if (disp.zone === "right") { zx = dr.x + dr.w / 2; zw = dr.w / 2; }
    else if (disp.zone === "top") zh = dr.h / 2;
    else if (disp.zone === "bottom") { zy = dr.y + dr.h / 2; zh = dr.h / 2; }
    zoneEl.style.left = zx + "px";
    zoneEl.style.top = zy + "px";
    zoneEl.style.width = zw + "px";
    zoneEl.style.height = zh + "px";
    zoneEl.classList.remove("hidden");
  };
  const finish = () => {
    window.removeEventListener("pointermove", preMove, true);
    window.removeEventListener("pointerup", preUp, true);
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    scrollDir = 0; scrollEl = null; lastEv = null;
    if (overlay) {
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerup", onUp);
      overlay.removeEventListener("lostpointercapture", onUp);
      overlay.remove();
    }
    ghostEl?.remove();
    zoneEl?.remove();
    insEl?.remove();
    ghostEl = zoneEl = insEl = overlay = null;
    srcTabEl?.classList.remove("drag-src");
    srcTabEl = null;
    document.body.classList.remove("tab-dragging");
    if (dragging) {
      // 드래그 직후 발생하는 click(→ switchTab) 억제.
      const sc = (ce) => { ce.stopPropagation(); ce.preventDefault(); window.removeEventListener("click", sc, true); };
      window.addEventListener("click", sc, true);
    }
    if (dragging && drop) {
      if (wholePane) {
        // IDE/프리뷰 pane 을 터미널 pane 탭바/가운데에 드롭 = 그 pane 의 탭으로 편입(혼합 탭).
        const rt2 = wsRuntime(state.activeWsId);
        const tl = rt2 && T.findLeaf(rt2.layout, drop.paneId);
        if (
          (src.kind === "ide" || src.kind === "preview") && drop.paneId !== srcId &&
          tl && tl.kind === "terminal" && (drop.zone === "tabbar" || drop.zone === "center")
        ) {
          joinPaneAsTab(srcId, drop.paneId, drop.zone === "tabbar" ? drop.index : undefined);
        } else if (drop.paneId !== srcId) {
          // 가운데 = 스왑, 가장자리 = 그 방향 분할 이동.
          movePane(srcId, drop.paneId, drop.zone === "center" || drop.zone === "tabbar" ? null : drop.zone);
        }
      } else if (drop.zone === "tabbar") {
        if (drop.paneId === srcId) reorderTab(srcId, index, drop.index);
        else moveTabToIndex(srcId, index, drop.paneId, drop.index);
      } else if (drop.zone === "center") {
        if (drop.paneId !== srcId) moveTab(srcId, index, drop.paneId);
      } else if (!(drop.paneId === srcId && src.tabs.length <= 1)) {
        moveTabToNewSplit(srcId, index, drop.paneId, drop.zone);
      }
    }
    drop = null;
  };
  const onMove = (ev) => { if (dragging) update(ev); };
  const onUp = () => finish();
  // 임계 초과 전엔 오버레이가 없으므로 window 로 추적.
  const preMove = (ev) => {
    if (dragging) return;
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    start();
    update(ev);
  };
  const preUp = () => finish();
  window.addEventListener("pointermove", preMove, true);
  window.addEventListener("pointerup", preUp, true);
}
function escGhost(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// 드랍 예상 존의 "표시" 보정 — finish() 의 실제 결과와 일치시킨다(적용 로직은 그대로).
//  반환 null = 하이라이트 숨김(아무 일도 안 일어나는 드랍). rect 는 화면좌표 {x,y,w,h}.
function displayDrop(layout, src, wholePane, srcId, drop) {
  const dstLeaf = T.findLeaf(layout, drop.paneId);
  if (!dstLeaf) return null;
  const self = drop.paneId === srcId;
  const singleTab = src.kind === "terminal" && src.tabs.length <= 1;
  const rectOf = (id) => {
    const p = panes.get(id);
    if (!p) return null;
    const q = p.el.getBoundingClientRect();
    return { x: q.left, y: q.top, w: q.width, h: q.height };
  };
  let zone = drop.zone;
  let removed = false; // 이 드랍으로 src pane 이 사라지는가
  if (self) {
    // 자기 자신: 통째/단일 탭은 어디에 놓아도 no-op → "제자리"(pane 전체) 표시.
    //  다중 탭 pane 의 가장자리는 실제 분할이므로 그대로.
    if (wholePane || singleTab) zone = "center";
  } else if (wholePane) {
    // IDE/프리뷰 pane 을 터미널 pane 가운데 = 탭 편입(src 제거), 그 외 가운데 = 스왑(유지),
    //  가장자리 = movePane(src 제거 후 분할).
    const join = (src.kind === "ide" || src.kind === "preview") && dstLeaf.kind === "terminal" && zone === "center";
    removed = join || zone !== "center";
  } else {
    // 터미널 pane 의 탭 드래그: 비터미널 pane 가운데는 이동 불가(no-op) → 숨김.
    if (zone === "center" && dstLeaf.kind !== "terminal") return null;
    removed = singleTab; // 마지막 탭 이동 = src pane 닫힘
  }
  const rect = removed ? T.rectAfterRemoval(layout, srcId, drop.paneId, rectOf) : rectOf(drop.paneId);
  if (!rect) return null;
  return { rect, zone };
}

// 탭을 새 분할 pane 으로 이동(방향). side: left/right/top/bottom.
//  공유 풀 모델: win(풀 인덱스)은 불변 — 새 pane 스트림이 열리며 링크 생성, src 뷰에서 unview.
//  IDE/프리뷰 혼합 탭은 그 kind 의 독립 pane 으로 승격(본문은 새 pane 에서 재생성).
async function moveTabToNewSplit(srcId, index, targetId, side) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return;
  const src = T.findLeaf(rt.layout, srcId);
  if (!src || src.kind !== "terminal" || index < 0 || index >= src.tabs.length) return;
  const tab = src.tabs[index];
  const isT = isTermTab(tab);
  const newId = T.newPaneId();
  const ws = activeWs();
  src.tabs.splice(index, 1);
  if (src.active >= src.tabs.length) src.active = Math.max(0, src.tabs.length - 1);
  const newLeaf = isT
    ? { id: newId, kind: "terminal", tabs: [tab], active: 0 }
    : tab.kind === "ide"
      ? { id: newId, kind: "ide", openPath: tab.openPath || null }
      // 표면 ID(tid)·다크·메타 승계 — 같은 "pv-"+tid 로 재생성돼 webview 가 유지된다.
      : { id: newId, kind: "preview", url: tab.url || null, tid: tab.tid, dark: tab.dark, metaTitle: tab.metaTitle, metaFav: tab.metaFav };
  const dir = side === "left" || side === "right" ? "h" : "v";
  const before = side === "left" || side === "top";
  const r = T.split(rt.layout, targetId, dir, newLeaf, before);
  rt.layout = r.tree;
  rt.focusId = newLeaf.id;
  if (isT && isLocal(ws) && typeof tab.win === "number") api.unviewWindow(ws.localPath || "", srcId, tab.win).catch(() => {});
  if (!isT) panes.get(srcId)?.disposeMixedTab?.(tab, true); // 이동 — webview 보존(새 pane 이 승계)
  if (!src.tabs.length) {
    // src 가 비면 닫기(형제 승격). 탭은 이미 새 leaf 로 옮겨져 풀 kill 대상이 없다.
    S.closePane(state.activeWsId, srcId);
    return;
  }
  S.emit();
  // 재조립은 기존 pane 의 헤더를 다시 그리지 않으므로, 옮겨간 탭이 소스에 남아 보이는 것 방지.
  panes.get(srcId)?.buildHead();
  panes.get(srcId)?.showActiveTab?.();
  const w = src.tabs[src.active]?.win;
  if (typeof w === "number" && isLocal(ws)) api.viewWindow(ws.localPath || "", srcId, w).catch(() => {});
}

// IDE/프리뷰 pane 통째를 터미널 pane 의 "탭"으로 편입(혼합 탭) — src pane 은 제거.
function joinPaneAsTab(srcId, dstId, insertIndex) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return;
  const src = T.findLeaf(rt.layout, srcId);
  const dst = T.findLeaf(rt.layout, dstId);
  if (!src || !dst || dst.kind !== "terminal" || (src.kind !== "ide" && src.kind !== "preview")) return;
  const tab = src.kind === "ide"
    ? { kind: "ide", openPath: src.openPath || null, tid: newTid() }
    // 표면 ID 승계(pane→탭): 기존 독립 pane 의 "pv-"+(tid||paneId) webview 를 그대로 쓴다.
    : { kind: "preview", url: src.url || null, tid: src.tid || src.id, dark: src.dark, metaTitle: src.metaTitle, metaFav: src.metaFav };
  const at = insertIndex == null ? dst.tabs.length : Math.max(0, Math.min(dst.tabs.length, insertIndex));
  dst.tabs.splice(at, 0, tab);
  dst.active = at;
  // src pane 제거 — 터미널 없는 pane 이라 풀 영향 없음(closePane 은 터미널 win 만 kill).
  //  프리뷰는 webview 를 닫지 않고 넘긴다(표면 승계 — dispose 가 _preservePreview 확인).
  const srcPane = panes.get(srcId);
  if (srcPane && src.kind === "preview") srcPane._preservePreview = true;
  S.closePane(state.activeWsId, srcId);
  const rt2 = wsRuntime(state.activeWsId);
  if (rt2) rt2.focusId = dstId;
  panes.get(dstId)?.buildHead();
  panes.get(dstId)?.showActiveTab?.();
  S.emit();
}

function renderMainTop(ws) {
  mainTop.innerHTML = "";
  if (state.sidebarCollapsed) {
    // 접힘 시 사이드바 상단 컨트롤(토글·알림)을 메인 상단바에 노출 — 워크스페이스 추가(+)는
    //  사이드바를 열어야 보인다(접힘 상태 축약).
    const ctl = document.createElement("span");
    ctl.className = "mt-ctl";
    ctl.append(buildTopControls(false));
    mainTop.appendChild(ctl);
    const div = document.createElement("span");
    div.className = "mt-div";
    mainTop.appendChild(div);
  }
  const name = document.createElement("span");
  name.className = "mt-name";
  name.textContent = ws?.name || "워크스페이스";
  mainTop.append(name);
  // 통합 추가 버튼(터미널/IDE/웹뷰) — pane 별 버튼 대신 여기 고정. 활성 pane 기준 자동 배치.
  if (ws) {
    const spacer = document.createElement("span");
    spacer.className = "mt-spacer";
    const adds = document.createElement("span");
    adds.className = "mt-adds";
    const mkBtn = (icon, title, kind) => {
      const b = document.createElement("button");
      b.className = "pane-ctrl";
      b.title = title;
      b.innerHTML = icon({ size: 16 });
      b.addEventListener("click", () => smartAdd(kind));
      return b;
    };
    adds.append(
      mkBtn(icons.terminal, "터미널 추가", "terminal"),
      mkBtn(icons.code, "IDE 추가", "ide"),
      mkBtn(icons.globe, "웹뷰 추가", "preview"),
    );
    mainTop.append(spacer, adds);
  }
}

// 통합 추가 — 활성 pane 의 크기·비율로 배치를 자동 결정(모바일과 동일 규칙).
//  · 절반이 최소 크기 이상인 축을 분할(둘 다 되면 긴 축): 가로=우측, 세로=아래.
//  · 둘 다 부족하고 활성 pane 이 터미널 pane 이면 같은 영역에 탭으로 추가(혼합 탭 — IDE/웹뷰 포함).
function smartAdd(kind) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt || !rt.layout) return;
  const focusId = rt.focusId || T.firstLeafId(rt.layout);
  if (!focusId) return;
  const focusLeaf = T.findLeaf(rt.layout, focusId);
  const r = panes.get(focusId)?.el?.getBoundingClientRect();
  const MIN_W = 360, MIN_H = 240;
  const canH = !!r && r.width / 2 >= MIN_W;
  const canV = !!r && r.height / 2 >= MIN_H;
  let dir = null;
  if (canH && canV) dir = r.width >= r.height ? "h" : "v";
  else if (canH) dir = "h";
  else if (canV) dir = "v";
  if (!dir && focusLeaf?.kind === "terminal") {
    if (kind === "terminal") {
      panes.get(focusId)?.addTab();
      S.focusPane(focusId);
      return;
    }
    const tab = kind === "ide"
      ? { kind: "ide", openPath: null, tid: newTid() }
      : { kind: "preview", url: "", tid: newTid() };
    focusLeaf.tabs.push(tab);
    focusLeaf.active = focusLeaf.tabs.length - 1;
    panes.get(focusId)?.buildHead();
    panes.get(focusId)?.showActiveTab?.();
    S.focusPane(focusId);
    S.emit();
    return;
  }
  const opts = kind === "preview" ? { url: "" } : kind === "terminal" ? { fresh: true } : undefined;
  S.splitPane(focusId, dir || (r && r.height > r.width ? "v" : "h"), kind, opts);
}

export function updateWorkspaceView() {
  const ws = activeWs();
  const rt = ws ? wsRuntime(ws.id) : null;
  if (!ws || !rt) {
    renderMainTop(null);
    if (gridEl) gridEl.innerHTML = '<div class="ws-empty">워크스페이스를 선택하거나 추가하세요</div>';
    disposeAll();
    return;
  }
  renderMainTop(ws);
  const ctx = paneCtx(ws);

  if (lastWsId !== ws.id) {
    disposeAll();
    lastWsId = ws.id;
    lastSig = "";
  }

  // reconcile
  const wanted = new Map();
  T.eachLeaf(rt.layout, (l) => wanted.set(l.id, l));
  for (const [id, p] of panes) {
    if (!wanted.has(id)) {
      p.dispose();
      panes.delete(id);
    }
  }
  const fresh = [];
  for (const [id, node] of wanted) {
    if (!panes.has(id)) {
      const pv = new PaneView(node, ctx);
      panes.set(id, pv);
      fresh.push(pv);
    } else {
      panes.get(id).node = node;
    }
  }

  const sig = structureSig(rt.layout);
  if (sig !== lastSig) {
    lastSig = sig;
    gridEl.innerHTML = "";
    gridEl.appendChild(buildNode(rt.layout, []));
    fresh.forEach((p) => p.mount());
    requestAnimationFrame(() => refitAll());
  }

  for (const [id, p] of panes) p.el.classList.toggle("focused", id === rt.focusId);
  measureRects();
}

function buildNode(node, path) {
  if (T.isLeaf(node)) {
    const pv = panes.get(node.id);
    const wrap = document.createElement("div");
    wrap.className = "pane-slot";
    if (pv) wrap.appendChild(pv.el);
    return wrap;
  }
  const box = document.createElement("div");
  box.className = "split split-" + node.dir;
  const firstWrap = document.createElement("div");
  firstWrap.className = "split-child";
  firstWrap.style.flexBasis = node.ratio * 100 + "%";
  firstWrap.appendChild(buildNode(node.first, [...path, "first"]));
  const divider = document.createElement("div");
  divider.className = "divider divider-" + node.dir;
  const secondWrap = document.createElement("div");
  secondWrap.className = "split-child";
  secondWrap.style.flexBasis = (1 - node.ratio) * 100 + "%";
  secondWrap.appendChild(buildNode(node.second, [...path, "second"]));
  attachDrag(divider, box, firstWrap, secondWrap, node.dir, path);
  box.append(firstWrap, divider, secondWrap);
  return box;
}

function attachDrag(divider, box, firstWrap, secondWrap, dir, path) {
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add(dir === "h" ? "resizing-col" : "resizing-row");
    divider.classList.add("dragging"); // 드래그 중 포인터가 벗어나도 굵은 하이라이트 유지
    const rect = box.getBoundingClientRect();
    let ratio =
      firstWrap.getBoundingClientRect()[dir === "h" ? "width" : "height"] / (dir === "h" ? rect.width : rect.height);
    let raf = 0;
    const move = (ev) => {
      let r = dir === "h" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      r = Math.max(0.1, Math.min(0.9, r));
      ratio = r;
      firstWrap.style.flexBasis = r * 100 + "%";
      secondWrap.style.flexBasis = (1 - r) * 100 + "%";
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; refitAll(); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-col", "resizing-row");
      divider.classList.remove("dragging");
      S.setRatio(path, ratio);
      refitAll();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// 탭을 다른 pane 으로 이동(드롭). src 가 비면 pane 닫기.
//  공유 풀 모델: 링크만 이동(win 불변) — dst 는 activateWin(view), src 는 unview.
async function moveTab(srcId, index, dstId) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return;
  const src = T.findLeaf(rt.layout, srcId);
  const dst = T.findLeaf(rt.layout, dstId);
  if (!src || !dst || src.kind !== "terminal" || dst.kind !== "terminal") return;
  if (index < 0 || index >= src.tabs.length) return;
  const tab = src.tabs[index];
  const isT = isTermTab(tab);
  const ws = activeWs();
  src.tabs.splice(index, 1);
  if (src.active >= src.tabs.length) src.active = Math.max(0, src.tabs.length - 1);
  // dst 에 이미 같은 탭이 있으면(중복 방지) 그 탭 활성화로 대체.
  const exist = isT
    ? dst.tabs.findIndex((t) => isTermTab(t) && t.win === tab.win)
    : dst.tabs.findIndex((t) => !isTermTab(t) && !!tab.tid && t.tid === tab.tid);
  if (exist >= 0) dst.active = exist;
  else { dst.tabs.push(tab); dst.active = dst.tabs.length - 1; }
  panes.get(dstId)?.buildHead();
  if (isT) panes.get(dstId)?.activateWin(tab.win);
  panes.get(dstId)?.showActiveTab?.();
  if (isT && isLocal(ws) && typeof tab.win === "number") api.unviewWindow(ws.localPath || "", srcId, tab.win).catch(() => {});
  if (!isT) panes.get(srcId)?.disposeMixedTab?.(tab, true); // 본문은 dst 에서 재생성 — 프리뷰 webview 는 보존·승계
  if (!src.tabs.length) {
    S.closePane(state.activeWsId, srcId);
    return; // closePane → emit → 재렌더
  }
  panes.get(srcId)?.buildHead();
  panes.get(srcId)?.showActiveTab?.();
  const w = src.tabs[src.active].win;
  if (typeof w === "number" && isLocal(ws)) api.viewWindow(ws.localPath || "", srcId, w).catch(() => {});
  S.emit();
}

// 같은 pane 내 탭 순서 재배치.
function reorderTab(paneId, from, insertIndex) {
  const rt = wsRuntime(state.activeWsId);
  const p = rt && T.findLeaf(rt.layout, paneId);
  if (!p || p.kind !== "terminal" || from < 0 || from >= p.tabs.length) return;
  let to = insertIndex > from ? insertIndex - 1 : insertIndex;
  to = Math.max(0, Math.min(p.tabs.length - 1, to));
  if (to === from) return;
  const active = p.tabs[p.active];
  const [t] = p.tabs.splice(from, 1);
  p.tabs.splice(to, 0, t);
  p.active = p.tabs.indexOf(active);
  panes.get(paneId)?.buildHead();
  S.emit();
}

// 다른 터미널 pane 의 특정 위치로 탭 이동.
//  공유 풀 모델: 링크만 이동(win 불변) — dst 는 activateWin(view), src 는 unview.
async function moveTabToIndex(srcId, index, dstId, insertIndex) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return;
  const src = T.findLeaf(rt.layout, srcId);
  const dst = T.findLeaf(rt.layout, dstId);
  if (!src || !dst || src.kind !== "terminal" || dst.kind !== "terminal") return;
  if (index < 0 || index >= src.tabs.length) return;
  const tab = src.tabs[index];
  const isT = isTermTab(tab);
  const ws = activeWs();
  src.tabs.splice(index, 1);
  if (src.active >= src.tabs.length) src.active = Math.max(0, src.tabs.length - 1);
  const exist = isT
    ? dst.tabs.findIndex((t) => isTermTab(t) && t.win === tab.win)
    : dst.tabs.findIndex((t) => !isTermTab(t) && !!tab.tid && t.tid === tab.tid);
  if (exist >= 0) dst.active = exist;
  else {
    const at = Math.max(0, Math.min(dst.tabs.length, insertIndex));
    dst.tabs.splice(at, 0, tab);
    dst.active = at;
  }
  panes.get(dstId)?.buildHead();
  if (isT) panes.get(dstId)?.activateWin(tab.win);
  panes.get(dstId)?.showActiveTab?.();
  if (isT && isLocal(ws) && typeof tab.win === "number") api.unviewWindow(ws.localPath || "", srcId, tab.win).catch(() => {});
  if (!isT) panes.get(srcId)?.disposeMixedTab?.(tab, true); // 이동 — 프리뷰 webview 보존
  if (!src.tabs.length) { S.closePane(state.activeWsId, srcId); return; }
  panes.get(srcId)?.buildHead();
  panes.get(srcId)?.showActiveTab?.();
  const w = src.tabs[src.active].win;
  if (typeof w === "number" && isLocal(ws)) api.viewWindow(ws.localPath || "", srcId, w).catch(() => {});
  S.emit();
}

// 좌표 아래 pane 의 드롭 존(center/edges) 계산 — IDE 파일탭 드래그아웃 등 공용.
export function paneDropZone(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const pane = el && el.closest && el.closest(".pane");
  if (!pane) return null;
  const r = pane.getBoundingClientRect();
  const head = pane.querySelector(".pane-head");
  const headH = head ? head.getBoundingClientRect().height : 0;
  let zone = "center";
  if (clientY > r.top + headH) {
    const fx = (clientX - r.left) / r.width, fy = (clientY - r.top) / r.height;
    const m = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (m < 0.25) {
      if (m === fx) zone = "left";
      else if (m === 1 - fx) zone = "right";
      else if (m === fy) zone = "top";
      else zone = "bottom";
    }
  }
  return { paneId: pane.dataset.paneId, zone, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, headH };
}

// IDE 파일탭을 pane 밖으로 드래그 → 그 파일을 새 IDE pane(방향분할) 혹은 대상 IDE pane 에 연다.
//  반환 true = 소스 IDE 에서 해당 파일 탭을 닫아도 됨(이동 성공).
function openFileInPane(filePath, srcPaneId, targetPaneId, zone) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return false;
  const targetLeaf = T.findLeaf(rt.layout, targetPaneId);
  if (zone === "center" && targetPaneId !== srcPaneId && targetLeaf && targetLeaf.kind === "ide") {
    const tp = panes.get(targetPaneId);
    if (tp?.ide) { tp.ide.openFile(filePath); S.focusPane(targetPaneId); return true; }
  }
  const side = zone === "center" ? "right" : zone;
  const leaf = { id: T.newPaneId(), kind: "ide", openPath: filePath };
  const dir = side === "left" || side === "right" ? "h" : "v";
  const before = side === "left" || side === "top";
  const r = T.split(rt.layout, targetPaneId, dir, leaf, before);
  rt.layout = r.tree;
  rt.focusId = leaf.id;
  S.emit();
  return true;
}

// IDE/프리뷰 pane 통째 이동(스왑 또는 방향 분할). leaf 객체 재사용 → 상태 보존.
function movePane(srcId, targetId, side) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt) return;
  const r = T.moveLeaf(rt.layout, srcId, targetId, side);
  if (!r.movedId) return;
  rt.layout = r.tree;
  rt.focusId = r.movedId;
  S.emit();
}

function refitAll() {
  for (const p of panes.values()) p.refit?.();
}
function measureRects() {
  paneRects = {};
  for (const [id, p] of panes) {
    const r = p.el.getBoundingClientRect();
    paneRects[id] = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
}
export function focusNeighbor(dir) {
  const rt = wsRuntime(state.activeWsId);
  if (!rt || !rt.focusId) return;
  const id = T.neighbor(paneRects, rt.focusId, dir);
  if (id) {
    S.focusPane(id);
    panes.get(id)?.focus();
  }
}
export function focusCurrentPane() {
  const rt = wsRuntime(state.activeWsId);
  panes.get(rt?.focusId)?.focus();
}
function disposeAll() {
  for (const p of panes.values()) p.dispose();
  panes.clear();
  lastSig = "";
}
