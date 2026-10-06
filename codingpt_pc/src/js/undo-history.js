// 실행 취소 기록 — 입력칸·편집기가 함께 쓰는 한 벌.
//  웹뷰의 기본 실행 취소(execCommand("undo"))는 **쉬지 않고 친 글 전체를 한 덩어리**로 되돌린다 — 방금 친 낱말만
//  지우려다 본문이 통째로 사라졌다(2026-10-07 실사용). 그래서 기록을 직접 쥔다: 낱말(띄어쓰기·줄바꿈)·잠깐 쉼·
//  커서 이동·다른 종류의 편집마다 한 단계를 끊는다.
//  순수 로직(createHistory)은 DOM 을 모른다 — 상태는 부르는 쪽이 정한 값 그대로 보관만 한다.

/** 같은 종류 입력이 이 시간 안에 이어지면 한 단계로 묶는다. */
export const GROUP_MS = 1000;
const MAX_STEPS = 300;

/**
 * 기록 한 벌. initial = 처음 상태(여기까지 되돌아간다).
 *  record(state, { kind, boundary, now }) — 편집 뒤의 상태를 적는다. kind 가 직전과 같고 GROUP_MS 안이면 한 단계로 묶고,
 *    boundary(띄어쓰기·줄바꿈)면 그 입력까지 담고 단계를 닫는다.
 *  seal() — 지금 단계를 닫는다(커서를 옮겼을 때·도구 버튼 앞).
 *  undo()/redo() → 돌아갈 상태 또는 null.
 */
export function createHistory(initial) {
  let stack = [initial];
  let cur = 0;
  let open = false;   // 맨 위 단계가 아직 이어 쓰는 중인가
  let lastKind = "";
  let lastT = 0;
  return {
    record(state, o = {}) {
      const kind = o.kind || "";
      const now = o.now == null ? Date.now() : o.now;
      const merge = open && cur > 0 && cur === stack.length - 1 && !!kind && kind === lastKind && now - lastT < GROUP_MS;
      if (merge) stack[cur] = state;
      else {
        stack = stack.slice(0, cur + 1);
        stack.push(state);
        if (stack.length > MAX_STEPS) stack.shift();
        cur = stack.length - 1;
      }
      open = !!kind && !o.boundary;
      lastKind = kind;
      lastT = now;
    },
    seal() { open = false; },
    undo() { open = false; if (cur <= 0) return null; cur -= 1; return stack[cur]; },
    redo() { open = false; if (cur >= stack.length - 1) return null; cur += 1; return stack[cur]; },
    canUndo: () => cur > 0,
    canRedo: () => cur < stack.length - 1,
    size: () => stack.length,
  };
}

/** input 이벤트 → { kind, boundary }. 글자 입력끼리·지우기끼리만 묶이고, 나머지(붙여넣기·서식)는 늘 제 단계다. */
export function classifyInput(e) {
  const type = (e && e.inputType) || "";
  const data = (e && e.data) || "";
  if (type === "insertText" || type === "insertCompositionText" || type === "insertFromComposition") return { kind: "type", boundary: /\s$/.test(data) };
  if (type === "insertParagraph" || type === "insertLineBreak") return { kind: "type", boundary: true };
  if (type.startsWith("delete") && type !== "deleteByCut" && type !== "deleteByDrag") return { kind: "del", boundary: false };
  return { kind: "", boundary: true };
}

/** ⌘Z / ⇧⌘Z / ⌘Y 인가 — "undo" | "redo" | "". */
export function undoKeyOf(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return "";
  const k = String(e.key || "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return "";
}

const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
/** 커서를 옮기는 키인가 — 옮기면 단계를 닫는다. */
export const isMoveKey = (e) => MOVE_KEYS.has(e.key);

/**
 * root 안의 모든 글 입력칸(input·textarea)에 실행 취소를 건다(위임 — 나중에 그려지는 칸도 된다).
 *  앱 메뉴에 Undo/Redo 가 없어(터미널·IDE 가 ⌘Z 를 직접 받게 하려고 뺐다) 웹뷰가 대신 해 주지 않는다.
 *  되돌린 뒤에는 input 이벤트를 다시 쏜다 — 검색칸처럼 값을 듣는 쪽이 따라오게.
 */
export function attachInputUndo(root) {
  const hist = new WeakMap();
  const isField = (n) => !!n && (n.tagName === "TEXTAREA" || (n.tagName === "INPUT" && /^(text|search|url|email|tel|)$/.test(n.getAttribute("type") || "")));
  const snap = (n) => ({ v: n.value, s: n.selectionStart, e: n.selectionEnd });
  const histOf = (n) => { let h = hist.get(n); if (!h) { h = createHistory(snap(n)); hist.set(n, h); } return h; };
  let replaying = false;
  root.addEventListener("focusin", (e) => { if (isField(e.target)) histOf(e.target); });
  root.addEventListener("input", (e) => {
    const n = e.target;
    if (replaying || !isField(n)) return;
    histOf(n).record(snap(n), classifyInput(e));
  });
  root.addEventListener("mousedown", (e) => { if (isField(e.target)) histOf(e.target).seal(); });
  root.addEventListener("keydown", (e) => {
    const n = e.target;
    if (!isField(n)) return;
    const k = undoKeyOf(e);
    if (!k) { if (isMoveKey(e)) histOf(n).seal(); return; }
    e.preventDefault(); e.stopPropagation();
    if (e.isComposing) return;
    const st = k === "undo" ? histOf(n).undo() : histOf(n).redo();
    if (!st) return;
    n.value = st.v;
    try { n.setSelectionRange(st.s, st.e); } catch (_) { /* 선택을 못 잡는 칸 */ }
    replaying = true;
    try { n.dispatchEvent(new Event("input", { bubbles: true })); } finally { replaying = false; }
  });
  //  값을 코드로 바꾼 뒤(초기화·되돌리기) 그 칸의 기록을 새로 시작하게 한다.
  return { reset(n) { if (n) hist.delete(n); } };
}
