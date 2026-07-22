// overlay.js — 투명 오버레이 창(별도 웹뷰)의 렌더러. "덤(dumb) 렌더러":
//  메인 창(overlay-host.js)이 만든 팝업 HTML 을 이벤트로 받아 그려주고, 클릭/닫힘을 되돌려줄 뿐.
//  실제 상태 변경은 전부 메인 창이 수행한다. 창 생명주기/지오메트리는 Rust(overlay_show/hide).
//
//  프로토콜:
//   host → overlay  'ovl:show'   { html, place, passthrough, autohideMs }
//   overlay → host  'ovl:action' { id }   (data-ovl 클릭. data-ovl-keep 이면 창 유지)
//   overlay → host  'ovl:dismiss'         (바깥 클릭/Esc)
//   overlay → host  'ovl:ready'           (페이지 로드 완료 — host 가 첫 show 전 대기)
import "./theme.js"; // localStorage 기반 data-theme/폰트를 이 창에도 동일 적용(메인과 공유)

const { event, core } = window.__TAURI__;
const invoke = core.invoke;
const backdrop = document.getElementById("ovl-backdrop");
const pop = document.getElementById("ovl-pop");

let dismissable = true;
let autohideTimer = 0;

function clear() {
  clearTimeout(autohideTimer);
  autohideTimer = 0;
  pop.innerHTML = "";
  backdrop.style.pointerEvents = "none";
}

async function hide(reason) {
  clear();
  try { await invoke("overlay_hide"); } catch (_) { /* noop */ }
  if (reason === "dismiss") { try { event.emit("ovl:dismiss", {}); } catch (_) {} }
}

// 팝업 배치 — 오버레이 창은 메인 콘텐츠 영역과 1:1로 겹쳐 있으므로 메인 클라이언트 좌표를 그대로 쓴다.
//  place.mode: 'point'(커서, align 'tl'|'tr') | 'anchor'(x,y 아래) | 'toast'(CSS 고정)
function placeEl(el, place) {
  if (!el || !place || place.mode === "toast") return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = place.x || 0, y = place.y || 0;
  if (place.align === "tr") x -= w; // 오른쪽 정렬(우측 끝을 x 에 맞춤)
  if (x + w > vw - 8) x = vw - w - 8;
  if (y + h > vh - 8) y = vh - h - 8;
  el.style.left = Math.max(8, x) + "px";
  el.style.top = Math.max(8, y) + "px";
}

event.listen("ovl:show", ({ payload }) => {
  const { html, place, passthrough, autohideMs } = payload || {};
  clear();
  dismissable = !passthrough;
  pop.innerHTML = html || "";
  const el = pop.firstElementChild;
  if (el) el.style.visibility = "hidden"; // 배치 전 깜빡임 방지
  backdrop.style.pointerEvents = dismissable ? "auto" : "none";
  // 창을 먼저 표시(투명이라 빈 상태는 안 보임) → 다음 프레임에 크기 측정·배치 후 노출.
  requestAnimationFrame(() => {
    invoke("overlay_show", { passthrough: !!passthrough }).catch(() => {});
    requestAnimationFrame(() => {
      if (el) { placeEl(el, place); el.style.visibility = "visible"; if (el.classList.contains("wv-toast")) el.classList.add("show"); }
    });
  });
  if (autohideMs) autohideTimer = setTimeout(() => hide("auto"), autohideMs);
});

backdrop.addEventListener("mousedown", () => { if (dismissable) hide("dismiss"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dismissable) hide("dismiss"); });

pop.addEventListener("click", (e) => {
  const t = e.target.closest("[data-ovl]");
  if (!t) return;
  try { event.emit("ovl:action", { id: t.dataset.ovl }); } catch (_) {}
  if (!t.hasAttribute("data-ovl-keep")) hide(); // 액션 실행은 host, 창은 바로 닫음
});

// 준비 완료 통지(host 가 첫 show 전에 이 신호를 기다린다).
try { event.emit("ovl:ready", {}); } catch (_) {}
