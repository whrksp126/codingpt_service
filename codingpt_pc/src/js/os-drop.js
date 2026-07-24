// os-drop.js — OS 파일 드래그앤드랍 → 터미널 pane 에 경로 삽입.
//  Tauri v2 드래그드롭은 Rust on_window_event 가 "cpt-drag" 로 포워딩한다(tauri://drag-* 는
//  창/웹뷰 타겟 한정 emit 이라 평범한 listen 이 못 받음). 좌표는 물리 px(웹뷰 좌상단 기준).
//  drag-over 중 좌표의 pane 이 "활성 탭=터미널" 이면 하이라이트, drop 시 그 pane 터미널에
//  `'<path>'` 공백 join + 뒤 공백 1개를 붙여넣기 경로(insertText)로 삽입. 그 외 드롭은 무시.
import { api } from "./api.js";
import { getPane, isTermTab, terminalPanes } from "./pane.js";

let hlEl = null; // 하이라이트 중인 pane 요소

function clearHl() {
  hlEl?.classList.remove("os-drop");
  hlEl = null;
}
// 드래그 진행 표식 — preview_shield 감시(main.js SEL)가 참조해 드래그 동안 프리뷰 이벤트를 차단
//  (안 하면 프리뷰 구멍 위 드래그가 hitTest 라우팅으로 프리뷰 웹뷰에 삼켜져 좌표 추적이 끊긴다).
function setDragging(on) {
  document.body.classList.toggle("os-dragging", !!on);
}
// 물리 px → CSS px 환산 후 elementFromPoint 로 터미널 pane 탐색. terminal-kind pane 이면 대상 —
//  활성 탭이 터미널이면 그 탭, 활성 탭이 프리뷰/IDE(혼합 탭)면 같은 pane 의 첫 터미널 탭으로 라우팅한다.
//  (프리뷰는 punch-through 네이티브 웹뷰라 활성 시 pane 을 덮어 OS 드롭이 프리뷰로 가로채졌었다 —
//   드롭은 항상 이 pane 의 터미널에 꽂고, 필요하면 그 터미널 탭으로 먼저 전환한다.)
//  반환: { pane, tabIndex } (삽입할 터미널 탭 인덱스) 또는 null.
function termTargetAt(px, py) {
  const s = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(px / s, py / s);
  const paneEl = el && el.closest ? el.closest(".pane") : null;
  if (!paneEl) return null;
  const pane = getPane(paneEl.dataset.paneId);
  if (!pane || pane.node.kind !== "terminal") return null;
  const tabs = pane.node.tabs || [];
  const active = tabs[pane.node.active];
  if (active && isTermTab(active)) return { pane, tabIndex: pane.node.active };
  // 활성 탭이 터미널이 아님(프리뷰 등) — 같은 pane 의 첫 터미널 탭으로.
  const ti = tabs.findIndex((t) => isTermTab(t));
  if (ti >= 0) return { pane, tabIndex: ti };
  return null;
}
// 셸 안전 작은따옴표 감싸기 — 경로 내 ' 는 '\'' 로 이스케이프.
function shq(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

export function initOsDrop() {
  // 진단 — Tauri 가 OS 드롭을 가로채면(dragDropEnabled=true) 아래 HTML5 이벤트는 웹뷰에 안 온다.
  //  만약 HTML5 dragover/drop 이 뜨면 = Tauri 가 안 가로챈 것(dragDropEnabled off/미등록) → 원인 확정.
  //  (HTML5 File 은 절대경로가 없어 삽입엔 못 쓴다 — 진단 표식만.)
  window.addEventListener("dragover", (e) => { e.preventDefault(); }, true);
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    try {
      const n = e.dataTransfer?.files?.length ?? -1;
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []).join(",") : "";
      api.debugLog?.(`[drop] HTML5 drop x=${e.clientX} y=${e.clientY} files=${n} types=${types}`);
    } catch (_) {}
  }, true);

  api.onOsDrag((ev) => {
    if (!ev || !ev.kind) return;
    if (ev.kind === "enter" || ev.kind === "over") {
      setDragging(true);
      const tgt = termTargetAt(ev.x, ev.y);
      if (ev.kind === "enter") {
        api.debugLog?.(`[drop] js ENTER x=${ev.x} y=${ev.y} dpr=${window.devicePixelRatio || 1} tgt=${tgt ? tgt.pane.id + "#" + tgt.tabIndex : "null"}`);
      }
      const el = tgt ? tgt.pane.el : null;
      if (el !== hlEl) {
        clearHl();
        if (el) { hlEl = el; hlEl.classList.add("os-drop"); }
      }
      return;
    }
    if (ev.kind === "drop") {
      let tgt = termTargetAt(ev.x, ev.y);
      // 폴백 — 좌표가 pane 을 못 짚었는데 터미널 pane 이 딱 하나면 거기로(단일 터미널 케이스 확실).
      if (!tgt) {
        const terms = terminalPanes();
        if (terms.length === 1) {
          const p = terms[0];
          const ti = (p.node.tabs || []).findIndex((t) => isTermTab(t));
          if (ti >= 0) { tgt = { pane: p, tabIndex: ti }; api.debugLog?.(`[drop] js DROP 폴백→단일터미널 ${p.id}#${ti}`); }
        }
      }
      clearHl();
      setDragging(false);
      const paths = Array.isArray(ev.paths) ? ev.paths.filter(Boolean) : [];
      // 진단 — 어디서 끊기는지 확정(네이티브 도달=DROP 로그, 여기 도달=js DROP, tgt/paths).
      const s = window.devicePixelRatio || 1;
      const hitEl = document.elementFromPoint(ev.x / s, ev.y / s);
      api.debugLog?.(
        `[drop] js DROP x=${ev.x} y=${ev.y} dpr=${s} paths=${paths.length} tgt=${tgt ? tgt.pane.id + "#" + tgt.tabIndex : "null"} ` +
          `el=${hitEl ? hitEl.tagName + "." + (typeof hitEl.className === "string" ? hitEl.className : "") : "none"} ` +
          `pane=${hitEl && hitEl.closest ? (hitEl.closest(".pane")?.dataset.paneId || "no-pane") : "na"}`
      );
      if (!tgt || !paths.length) return; // 터미널 대상 밖 드롭 = 무시
      const { pane, tabIndex } = tgt;
      const text = paths.map(shq).join(" ") + " ";
      const doInsert = () => {
        pane.insertText(text);
        pane.ctx?.onFocus?.(pane.id);
        pane.focus();
      };
      // 활성 탭이 그 터미널이 아니면(프리뷰 등) 먼저 전환 후 삽입 — 삽입 결과가 눈에 보이게.
      if (tabIndex !== pane.node.active) {
        Promise.resolve(pane.switchTab(tabIndex)).then(doInsert, doInsert);
      } else {
        doInsert();
      }
      return;
    }
    clearHl(); // leave(+미래 변형) — 하이라이트/실드 해제
    setDragging(false);
  });
}
