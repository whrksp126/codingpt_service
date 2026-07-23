// os-drop.js — OS 파일 드래그앤드랍 → 터미널 pane 에 경로 삽입.
//  Tauri v2 드래그드롭은 Rust on_window_event 가 "cpt-drag" 로 포워딩한다(tauri://drag-* 는
//  창/웹뷰 타겟 한정 emit 이라 평범한 listen 이 못 받음). 좌표는 물리 px(웹뷰 좌상단 기준).
//  drag-over 중 좌표의 pane 이 "활성 탭=터미널" 이면 하이라이트, drop 시 그 pane 터미널에
//  `'<path>'` 공백 join + 뒤 공백 1개를 붙여넣기 경로(insertText)로 삽입. 그 외 드롭은 무시.
import { api } from "./api.js";
import { getPane, isTermTab } from "./pane.js";

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
// 물리 px → CSS px 환산 후 elementFromPoint 로 터미널 pane 탐색. 활성 탭이 터미널일 때만 대상
//  (혼합 탭 IDE/프리뷰 표시 중이면 보이지 않는 백그라운드 터미널에 꽂지 않는다).
function termPaneAt(px, py) {
  const s = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(px / s, py / s);
  const paneEl = el && el.closest ? el.closest(".pane") : null;
  if (!paneEl) return null;
  const pane = getPane(paneEl.dataset.paneId);
  if (!pane || pane.node.kind !== "terminal") return null;
  const at = pane.node.tabs?.[pane.node.active];
  if (!at || !isTermTab(at)) return null;
  return pane;
}
// 셸 안전 작은따옴표 감싸기 — 경로 내 ' 는 '\'' 로 이스케이프.
function shq(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

export function initOsDrop() {
  api.onOsDrag((ev) => {
    if (!ev || !ev.kind) return;
    if (ev.kind === "enter" || ev.kind === "over") {
      setDragging(true);
      const pane = termPaneAt(ev.x, ev.y);
      if ((pane ? pane.el : null) !== hlEl) {
        clearHl();
        if (pane) { hlEl = pane.el; hlEl.classList.add("os-drop"); }
      }
      return;
    }
    if (ev.kind === "drop") {
      const pane = termPaneAt(ev.x, ev.y);
      clearHl();
      setDragging(false);
      const paths = Array.isArray(ev.paths) ? ev.paths.filter(Boolean) : [];
      if (!pane || !paths.length) return; // 터미널 pane 밖 드롭 = 무시
      pane.insertText(paths.map(shq).join(" ") + " ");
      pane.ctx?.onFocus?.(pane.id);
      pane.focus();
      return;
    }
    clearHl(); // leave(+미래 변형) — 하이라이트/실드 해제
    setDragging(false);
  });
}
