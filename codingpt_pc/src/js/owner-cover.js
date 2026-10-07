// owner-cover.js — 터미널이 **다른 기기 크기**로 보일 때의 표현 계층(가림막 + "이 기기에 맞추기").
//
// 한 터미널의 격자 크기는 한 기기(소유자)가 정한다(터미널 v3). 소유자가 아닌 기기에서는 화면이
//  제 크기가 아니라 읽기 어렵다 → 본문을 흐리게 덮고 정중앙에 아이콘 버튼 하나 + 한 줄 설명을 둔다.
//  누르면(가림막 아무 곳·버튼·Enter) 크기를 가져오고, "그대로 보기"(Esc)는 가림막만 걷고 모서리에
//  작은 아이콘 버튼을 남긴다. 프로토콜(claim/resize)은 pane.js 가 그대로 갖고 있다 — 여기는 표시뿐.
//
// 깜빡임 방지 계약(판정은 `ownerCoverPhase` 한 곳):
//  · 판정이 **확정된 터미널**에만 띄운다 — 탭을 바꾸면 새 터미널의 OWNER/SNAPSHOT 이 올 때까지 숨긴다
//    (직전 탭의 소유 상태가 새 탭에 잠깐 비치지 않게).
//  · 뷰어 상태가 SETTLE_MS 동안 이어져야 띄운다 — 재연결·탭 스왑 직후 한두 틱 뒤집히는 값은 안 보인다.
//  · 걷는 건 즉시(소유자가 됐는데 가림막이 남아 있으면 안 된다).
import { icons } from "./icons.js";
import * as i18n from "./i18n/index.js";

export const OWNER_COVER_SETTLE_MS = 350;

/**
 * 무엇을 보여 줄지 — 순수 판정. "hidden" | "cover" | "peek".
 *  viewer       : 이 기기가 크기 소유자가 아니다(소유자가 따로 있다)
 *  key          : 지금 보고 있는 터미널(탭)의 식별자
 *  confirmedKey : 소유 판정(OWNER/SNAPSHOT)을 마지막으로 받은 터미널
 *  visible      : 터미널 본문이 화면에 있다(채팅 모드·IDE 탭·빈 pane 이 아니다)
 *  peekKey      : 사용자가 "그대로 보기"를 고른 터미널
 */
export function ownerCoverPhase(s) {
  if (!s || !s.viewer || !s.visible) return "hidden";
  if (s.key == null || s.confirmedKey !== s.key) return "hidden";
  return s.peekKey === s.key ? "peek" : "cover";
}

export function ownerCoverText(name) {
  return name ? i18n.t("{name} 크기로 보는 중").replace("{name}", name) : i18n.t("다른 기기 크기로 보는 중");
}

/**
 * @param {{ onClaim: () => void, guardEl?: HTMLElement|null, settleMs?: number }} opts
 *  guardEl — 가림막이 떠 있는 동안 이 안으로 들어오는 포커스를 버튼으로 돌린다(터미널로 입력이 새지 않게).
 */
export function createOwnerCover(opts = {}) {
  const settleMs = typeof opts.settleMs === "number" ? opts.settleMs : OWNER_COVER_SETTLE_MS;
  const el = document.createElement("div");
  el.className = "pane-owner-pill";   // 옛 알약 자리 — 이름은 그대로 둔다(외부 참조 유지)
  el.hidden = true;
  const label = i18n.t("이 기기에 맞추기");
  // 아이콘 실선 굵기 = sw × size / 24 → 22px 1.5 ≈ 1.4px, 14px 2 ≈ 1.2px(이웃 16px 1.8 = 1.2px 와 같은 무게).
  el.innerHTML =
    `<div class="op-center">` +
      `<button type="button" class="op-btn" aria-label="${label}">${icons.fitScreen({ size: 22, sw: 1.5 })}</button>` +
      `<span class="op-label">${label}</span>` +
      `<span class="op-text"></span>` +
      `<button type="button" class="op-peek">${i18n.t("그대로 보기")}</button>` +
    `</div>` +
    `<button type="button" class="op-mini" aria-label="${label}">${icons.fitScreen({ size: 14, sw: 2 })}</button>`;
  const btn = el.querySelector(".op-btn");
  const text = el.querySelector(".op-text");
  const peekBtn = el.querySelector(".op-peek");
  const mini = el.querySelector(".op-mini");

  const st = { viewer: false, name: "", key: null, confirmedKey: null, visible: true, peekKey: null };
  let shown = "hidden";      // 지금 화면에 있는 모양
  let timer = null;          // 등장 지연
  let hideTimer = null;      // 퇴장 전이 뒤 display 제거

  const paint = (phase) => {
    if (phase === shown) { if (phase !== "hidden") text.textContent = ownerCoverText(st.name); return; }
    const hadFocus = el.contains(document.activeElement);
    shown = phase;
    clearTimeout(hideTimer); hideTimer = null;
    if (phase === "hidden") {
      el.classList.remove("on");
      hideTimer = setTimeout(() => { if (shown === "hidden") { el.hidden = true; el.classList.remove("cover", "peek"); } }, 160);
      return;
    }
    text.textContent = ownerCoverText(st.name);
    mini.title = `${ownerCoverText(st.name)} · ${label}`;
    el.classList.toggle("cover", phase === "cover");
    el.classList.toggle("peek", phase === "peek");
    el.hidden = false;
    // 한 프레임 뒤에 켜야 전이가 돈다(display 가 막 바뀐 프레임에는 시작값이 없다).
    requestAnimationFrame(() => { if (shown === phase) el.classList.add("on"); });
    if (phase === "cover") {
      // 이 pane 에서 타이핑하던 중이면 포커스를 버튼으로 옮긴다 — Enter 로 맞추고, 글자는 터미널로 안 샌다.
      const g = opts.guardEl;
      if (hadFocus || (g && g.contains(document.activeElement))) { try { btn.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
    }
  };

  const sync = () => {
    const phase = ownerCoverPhase(st);
    if (phase === "hidden") { clearTimeout(timer); timer = null; paint("hidden"); return; }
    if (shown !== "hidden") { clearTimeout(timer); timer = null; paint(phase); return; }   // cover ↔ peek 는 즉시
    if (timer) return;
    timer = setTimeout(() => { timer = null; paint(ownerCoverPhase(st)); }, settleMs);
  };

  const claim = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (shown === "hidden") return;
    try { opts.onClaim && opts.onClaim(); } catch (_) { /* noop */ }
  };
  // 가림막 아무 곳이나 누르면 맞춘다. peek 에서는 el 자체가 클릭을 안 받는다(CSS pointer-events).
  el.addEventListener("click", (e) => { if (shown === "cover") claim(e); });
  mini.addEventListener("click", claim);
  peekBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    st.peekKey = st.key; sync();
    try { opts.onPeek && opts.onPeek(); } catch (_) { /* noop */ }
  });
  // Enter/Space 는 포커스된 버튼의 기본 동작(click)이 처리한다. Esc = 그대로 보기.
  el.addEventListener("keydown", (e) => {
    if (shown !== "cover" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); peekBtn.click(); }
  });
  if (opts.guardEl) {
    opts.guardEl.addEventListener("focusin", () => {
      if (shown === "cover") { try { btn.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
    });
  }

  return {
    el,
    /** OWNER/SNAPSHOT 프레임 — 지금 보고 있는 터미널의 판정이 확정됐다. */
    setOwner({ viewer, name }) {
      st.viewer = !!viewer; st.name = name || ""; st.confirmedKey = st.key;
      if (!st.viewer) st.peekKey = null;   // 소유자가 됐다 → 다음에 다시 뷰어가 되면 가림막부터
      sync();
    },
    /** 보고 있는 터미널·본문 표시 여부. 터미널이 바뀌면 새 판정이 올 때까지 숨는다. */
    setContext({ key, visible }) {
      st.key = key == null ? null : key; st.visible = !!visible;
      sync();
    },
    phase: () => shown,
    dispose() { clearTimeout(timer); clearTimeout(hideTimer); el.remove(); },
  };
}
