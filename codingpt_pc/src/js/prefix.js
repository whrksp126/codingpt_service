// prefix.js — 접두키(⌃B 다음 글자). tmux·herdr 를 쓰던 손이 그대로 통하게 한다(2026-10-30, docs/herdr-comparison.md).
//
// 왜 ⌘ 조합과 따로 두나: ⌘ 조합은 외우기 어렵고 터미널 안 프로그램은 ⌃ 조합을 거의 다 쓴다. 키 하나만 예약하고
//  다음 한 글자를 앱이 받으면 프로그램과 부딪치지 않는다. 명령 자체는 commands.js 표의 것을 그대로 부른다(새 동작 없음).
//  · ⌃B 를 두 번 누르면 터미널로 ⌃B 가 그대로 간다(claude 의 백그라운드 전환 등).
//  · 글자는 e.code 로 읽는다 — 한글 입력 중에도 c 가 c 다(e.key 는 'ㅊ'·'Process').
//  · 입력칸(이슈 본문·검색창 등)에서는 ⌃B 를 건드리지 않는다. 터미널과 빈 화면에서만 쓴다.
import { runCommand } from "./command-run.js";

/** [키, 명령 id, 설명]. 키는 e.code 를 줄인 글자다. */
export const PREFIX_KEYS = [
  ["c", "ws.addTerminal", "새 터미널"],
  ["v", "pane.splitRight", "오른쪽으로 나누기"],
  ["-", "pane.splitDown", "아래로 나누기"],
  ["x", "pane.close", "pane 닫기"],
  ["h", "pane.focusLeft", "왼쪽 pane"],
  ["j", "pane.focusDown", "아래 pane"],
  ["k", "pane.focusUp", "위 pane"],
  ["l", "pane.focusRight", "오른쪽 pane"],
  ["g", "palette.open", "이동(에이전트·탭·파일)"],
  ["a", "notif.latestUnread", "기다리는 에이전트로"],
  ["n", "tasks.new", "새 작업"],
  ["t", "tasks.dashboard", "작업 현황"],
  ["i", "dispatch.open", "한 줄 지시"],
  ["e", "ws.addIde", "파일 트리"],
  ["o", "ws.addPreview", "프리뷰"],
  ["f", "find.open", "찾기"],
  ["b", "sidebar.toggle", "사이드바"],
  ["s", "app.settings", "설정"],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), `ws.select${n}`, `워크스페이스 ${n}`]),
];
const BY_KEY = new Map(PREFIX_KEYS.map(([k, id]) => [k, id]));
const ARROWS = { ArrowLeft: "pane.focusLeft", ArrowDown: "pane.focusDown", ArrowUp: "pane.focusUp", ArrowRight: "pane.focusRight" };
const ARM_MS = 4000;

/** e.code → 표의 글자. 표에 없는 키면 null. */
export function prefixKeyOf(e) {
  const c = String(e.code || "");
  if (e.shiftKey && c === "Slash") return "?";
  if (c.startsWith("Key")) return c.slice(3).toLowerCase();
  if (c.startsWith("Digit")) return c.slice(5);
  if (c === "Minus") return "-";
  return null;
}

let armed = false;
let timer = 0;
let hud = null;

function disarm() {
  armed = false;
  clearTimeout(timer);
  if (hud) { hud.remove(); hud = null; }
}
function arm(t) {
  armed = true;
  clearTimeout(timer);
  timer = setTimeout(disarm, ARM_MS);
  hud = document.createElement("div");
  hud.className = "pfx-hud";
  hud.textContent = t("⌃B  다음 키를 누르세요 · ? 전체 보기");
  document.body.appendChild(hud);
}

function inTextField(el) {
  if (!el || el === document.body) return false;
  if (el.closest && el.closest(".xterm")) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function openHelp(t) {
  const back = document.createElement("div");
  back.className = "cp-overlay";
  const rows = PREFIX_KEYS.filter(([k]) => !/^[2-8]$/.test(k)).map(([k, , d]) => `<div class="pfx-row"><kbd>${k === "1" ? "1–8" : k}</kbd><span>${t(k === "1" ? "워크스페이스로" : d)}</span></div>`).join("");
  back.innerHTML = `<div class="cp-card pfx-help" role="dialog" aria-modal="true" tabindex="-1">
    <div class="pfx-title">${t("접두키")} <kbd>⌃B</kbd></div>
    <div class="pfx-grid">${rows}<div class="pfx-row"><kbd>⌃B</kbd><span>${t("터미널로 ⌃B 보내기")}</span></div></div></div>`;
  const close = () => { back.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { e.preventDefault(); e.stopPropagation(); close(); };
  back.addEventListener("mousedown", close);
  document.body.appendChild(back);
  window.addEventListener("keydown", onKey, true);
}

/** sendCtrlB() = 포커스된 터미널에 ⌃B 를 보낸다. blocked() = 팔레트처럼 키를 스스로 처리하는 층이 떠 있다. */
export function initPrefix({ t, sendCtrlB, blocked }) {
  window.addEventListener("keydown", (e) => {
    const bare = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyB";
    if (!armed) {
      if (!bare || blocked() || inTextField(document.activeElement)) return;
      e.preventDefault(); e.stopPropagation();
      arm(t);
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    disarm();
    if (bare) { sendCtrlB(); return; }
    if (e.key === "Escape") return;
    const k = prefixKeyOf(e);
    if (k === "?") { openHelp(t); return; }
    const id = ARROWS[e.code] || (k && BY_KEY.get(k));
    if (id) runCommand(id);
  }, true);
}
