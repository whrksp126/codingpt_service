// attach-insert.js — "화면에서 집어 온 것"(프리뷰 요소 캡처 · 모바일 화면 캡처)을 **에이전트에게
//  건네는 한 가지 길**. 두 가지를 한 곳에 모은 이유는 하나다:
//
//  ★ 사용자가 지금 그 터미널을 **어떤 방식으로 보고 있느냐**에 따라 넣을 곳이 다르다.
//    · TUI 로 보고 있으면 → PTY 에 한 줄 텍스트(경로를 따옴표로 감싼 그 줄)
//    · 채팅으로 보고 있으면 → 채팅 컴포저에 **첨부 칩 + 설명 글**
//   예전엔 Design Mode 가 무조건 PTY 로만 넣었다. 채팅 모드로 보고 있으면 그 줄은 **화면에 보이지도
//   않는 TUI 컴포저**에 들어가 사라진 것처럼 보였다(2026-08-06 사용자 지적). 넣을 곳을 고르는
//   판단은 여기 한 곳에만 둔다 — 새 캡처 기능이 생길 때마다 같은 분기를 복제하지 않게.
import { state, ensureRuntime } from "./state.js";
import * as T from "./tiling.js";
import { getPane, isTermTab } from "./pane.js";
import { shellQuote } from "./path-utils.js";

/**
 * 삽입 대상 터미널 pane — 포커스 pane 이 터미널이면 그것, 아니면 레이아웃 첫 터미널 pane.
 *  (터미널 탭을 하나도 안 가진 pane 은 후보가 아니다 — 넣어 봐야 받을 PTY 가 없다.)
 */
export function findTermPane() {
  const rt = state.activeWsId ? ensureRuntime(state.activeWsId) : null;
  if (!rt) return null;
  const ok = (l) => l && l.kind === "terminal" && (l.tabs || []).some(isTermTab);
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (ok(focusLeaf)) hit = focusLeaf;
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit && ok(l)) hit = l; });
  return hit ? getPane(hit.id) : null;
}

/**
 * 첨부 한 건을 대상 터미널에 넣는다.
 * @param {{ text: string, path: string, line: string }} a
 *   · text = 채팅 컴포저에 쓸 설명(칩 앞에 들어간다)
 *   · line = TUI 에 넣을 완성된 한 줄(경로 인용 포함)
 *   · path = 첨부 파일 절대경로
 * @returns {'chat'|'tui'|null}  넣은 곳(대상이 없으면 null — 부르는 쪽이 안내한다)
 */
export function insertAttachment({ text, path, line }) {
  const pane = findTermPane();
  if (!pane) return null;
  //  ★ 활성 탭이 터미널이 아니면(모바일 화면·IDE·프리뷰 탭) 터미널 탭을 앞으로 끌어온다 —
  //   들어간 곳이 눈에 보여야 하고, "지금 보고 있는 방식" 판정도 그 탭 기준이어야 한다.
  const tab = ensureTermTab(pane);
  if (tab && tab.mode === "chat") {
    //  채팅 뷰는 첫 진입 때 lazy 생성이라, 아직 없으면 여기서 만든다(안 만들면 조용히 아무 일도 안 난다).
    const chat = pane._ensureChat ? pane._ensureChat() : pane.chat;
    if (chat && chat.attachWithText) {
      chat.retarget?.();                 // 활성 터미널 탭이 바뀌었으면 그 대화로
      chat.attachWithText(text, [path]);
      pane.ctx?.onFocus?.(pane.id);
      return "chat";
    }
  }
  pane.insertText(line);
  pane.ctx?.onFocus?.(pane.id);
  pane.focus();
  return "tui";
}

/** 이 pane 의 터미널 탭을 활성으로 — 이미 터미널이면 그대로. 터미널 탭이 없으면 null. */
function ensureTermTab(pane) {
  const n = pane.node;
  if (!n || n.kind !== "terminal") return null;
  const tabs = n.tabs || [];
  if (isTermTab(tabs[n.active])) return tabs[n.active];
  const i = tabs.findIndex(isTermTab);
  if (i < 0) return null;
  n.active = i;
  pane.buildHead?.();
  pane.showActiveTab?.();
  pane.ctx?.persist?.();
  return tabs[i];
}

/** 첨부 파일명 규칙 — `<prefix><yyyymmdd-hhmmss>-<rand4>.<ext>` (두 캡처 경로가 같은 규칙을 쓴다). */
export function attachName(prefix, ext) {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const ts = "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return prefix + ts + "-" + Math.random().toString(36).slice(2, 6) + "." + ext;
}

/** 화면 하단 토스트 — 순환 import 를 피하려고 지연 로드한다(design-pick 과 같은 규칙). */
export async function toast(msg) {
  try { const wv = await import("./workspace-view.js"); wv.wvToast(msg); } catch (_) { /* noop */ }
}

/** 셸 안전 작은따옴표 감싸기 — TUI 한 줄에 경로를 넣을 때 쓴다(공백·한글 경로 안전).
 *  대상 셸별 인용은 path-utils 위임(macOS=POSIX, win32=PowerShell — 계약 5). */
export function shq(p) {
  return shellQuote(p);
}
