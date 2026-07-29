// os-drop.js — OS 파일 드래그앤드랍 → 터미널 pane 에 경로 삽입.
//  네이티브(preview.rs)가 앱 웹뷰 서브트리의 드롭 메서드를 스위즐해 파일 경로를 "cpt-drag"
//  {kind,x,y,paths} 로 쏜다(punch-through 로 wry 기본 파일드롭 경로가 무발화라 우회). 좌표는
//  물리 px(웹뷰 좌상단 기준). drag-over 중 좌표의 pane 이 터미널이면 하이라이트, drop 시 그 pane
//  터미널에 `'<path>'` 공백 join + 뒤 공백 1개를 경로(insertText)로 삽입. 그 외 드롭은 무시.
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
//  export — IDE 파일트리→터미널 드래그(ide.js)도 같은 히트테스트/삽입 규칙을 재사용한다.
export function termTargetAt(px, py) {
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
export function shq(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}

// 대상 터미널(pane, tabIndex)에 경로 텍스트를 삽입 — 필요하면 그 터미널 탭으로 먼저 전환. os-drop/ide 공용.
export function insertIntoTerminal(tgt, text) {
  if (!tgt || !text) return;
  const { pane, tabIndex } = tgt;
  const doInsert = () => { pane.insertText(text); pane.ctx?.onFocus?.(pane.id); pane.focus(); };
  if (tabIndex !== pane.node.active) Promise.resolve(pane.switchTab(tabIndex)).then(doInsert, doInsert);
  else doInsert();
}

export function initOsDrop() {
  api.onOsDrag((ev) => {
    if (!ev || !ev.kind) return;
    if (ev.kind === "enter" || ev.kind === "over") {
      setDragging(true);
      const tgt = termTargetAt(ev.x, ev.y);
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
          if (ti >= 0) tgt = { pane: p, tabIndex: ti };
        }
      }
      clearHl();
      setDragging(false);
      const paths = Array.isArray(ev.paths) ? ev.paths.filter(Boolean) : [];
      if (!tgt || !paths.length) return; // 터미널 대상 밖 드롭 = 무시
      const { pane, tabIndex } = tgt;
      // 채팅 모드 pane 에 떨어진 드롭은 **채팅 컴포저의 첨부**로(2026-07-30 사용자 확정) —
      //  썸네일 미리보기를 보여주고, 전송 시 경로+메시지를 TUI 컴포저로 한 번에 보낸다.
      //  (예전엔 채팅을 보고 있는데 PTY 로 꽂혀 TUI 에만 [Image #1] 이 생기고 채팅은 무반응이었다.)
      if (tabIndex === pane.node.active && pane._chatActive?.() && pane.chat) {
        pane.chat.addAttachments(paths);
        return;
      }
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
