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
const log = (m) => { try { invoke("debug_log", { msg: "[overlay] " + m }); } catch (_) {} };
const backdrop = document.getElementById("ovl-backdrop");
const pop = document.getElementById("ovl-pop");

// 핑퐁 — host 가 살아있음을 확인(핸드셰이크). 리스너가 준비된 뒤 응답.
event.listen("ovl:ping", () => { try { event.emit("ovl:pong", {}); } catch (_) {} });

// ── 설정 모달 호스팅 ────────────────────────────────────────────────────────
//  설정은 상태 가득한 풀 모달이라 outerHTML 버스로는 안 되고, 이 오버레이 창에서 settings.js 를
//  독립 인스턴스로 구동한다(자기 상태·api 로 데이터 페치). 오버레이가 투명·프리뷰 위라, 설정 반투명
//  배경 뒤로 메인 창의 라이브 프리뷰가 그대로 비친다(프리즈 불필요).
let settingsOn = false;
let settingsMod = null, stateMod = null, settingsMounted = false;
async function ensureSettings() {
  if (settingsMounted) return;
  stateMod = await import("./state.js");
  settingsMod = await import("./settings.js");
  settingsMod.mountSettings(document.getElementById("ovl-settings"));
  // 비동기 데이터 로드(loadMe/loadDevices)나 테마 변경으로 상태가 바뀌면 재렌더.
  stateMod.subscribe(() => { try { settingsMod.updateSettings(); } catch (_) {} });
  // 닫힘 감지 — settings 가 S.setView('workspace') 하면 view 가 바뀐다 → 오버레이 숨김.
  stateMod.subscribe(() => {
    if (settingsOn && stateMod.state.view !== "settings") { settingsOn = false; closeSettings(); }
  });
  settingsMounted = true;
}
function focusModal() {
  // 창을 표시한 뒤 모달 카드에 DOM 포커스를 줘야 Esc/키보드가 바로 먹힌다(포커스 전엔 keydown 미수신).
  requestAnimationFrame(() => { const c = document.querySelector("#ovl-settings .sm-card"); if (c) c.focus(); });
  setTimeout(() => { const c = document.querySelector("#ovl-settings .sm-card"); if (c) c.focus(); }, 50);
}
async function openSettings() {
  try {
    await ensureSettings();
    settingsOn = true;
    stateMod.setView("settings");                         // 즉시 렌더(빈 상태여도 바로 뜨게)
    await invoke("overlay_show", { passthrough: false }); // 창 표시(빠른 등장)
    focusModal();
    log("settings opened");
    // 데이터는 표시 후 로드 → emit → 재렌더(등장 속도 우선).
    invoke("daemon_status").then((d) => { stateMod.state.daemon = d; stateMod.state.paired = !!(d && d.paired); stateMod.emit(); }).catch(() => {});
    if (stateMod.loadMe) stateMod.loadMe();
    if (stateMod.loadDevices) stateMod.loadDevices();
  } catch (e) {
    log("settings open ERR " + e);
    settingsOn = false;
    try { await invoke("overlay_hide"); } catch (_) {}
    event.emit("ovl:settings-failed", {}); // host 가 메인 모달로 폴백
  }
}
// 웜업 — 무거운 import(state→pane→vendor)를 미리 끝내둬 첫 설정 열기를 빠르게.
setTimeout(() => { ensureSettings().catch(() => {}); }, 800);
async function closeSettings() {
  try { await invoke("overlay_hide"); } catch (_) {}
  event.emit("ovl:settings-closed", {});
}
event.listen("ovl:settings-open", () => { openSettings(); });

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

event.listen("ovl:show", async ({ payload }) => {
  if (settingsOn) return; // 설정 열려있는 동안엔 팝업/토스트가 창을 가로채지 않게
  const { html, place, passthrough, autohideMs } = payload || {};
  log("show: len=" + (html ? html.length : 0) + " place=" + JSON.stringify(place) + " pass=" + !!passthrough);
  clear();
  dismissable = !passthrough;
  pop.innerHTML = html || "";
  const el = pop.firstElementChild;
  if (el) el.style.visibility = "hidden"; // 배치 전 깜빡임 방지
  backdrop.style.pointerEvents = dismissable ? "auto" : "none";
  // ⚠️ 창을 먼저 즉시 표시해야 한다 — 숨겨진 창에선 rAF/타이머가 멈춰서, rAF 안에서 show 를
  //  호출하면 영영 안 불린다(데드락). show 는 이벤트 콜백에서 직접 호출.
  try { await invoke("overlay_show", { passthrough: !!passthrough }); log("overlay_show ok"); }
  catch (e) { log("overlay_show ERR " + e); }
  // 이제 창이 보이므로 레이아웃 측정·배치 가능(다음 프레임).
  const paint = () => {
    if (!el) return;
    placeEl(el, place);
    el.style.visibility = "visible";
    if (el.classList.contains("wv-toast")) el.classList.add("show");
    log("placed " + el.style.left + "," + el.style.top + " " + el.offsetWidth + "x" + el.offsetHeight);
  };
  requestAnimationFrame(paint);
  setTimeout(paint, 60); // rAF 가 아직 안 돌 경우 대비(창 표시 직후 프레임)
  if (autohideMs) autohideTimer = setTimeout(() => hide("auto"), autohideMs);
});

backdrop.addEventListener("mousedown", () => { if (!settingsOn && dismissable) hide("dismiss"); });
document.addEventListener("keydown", (e) => { if (!settingsOn && e.key === "Escape" && dismissable) hide("dismiss"); });

pop.addEventListener("click", (e) => {
  const t = e.target.closest("[data-ovl]");
  if (!t) return;
  try { event.emit("ovl:action", { id: t.dataset.ovl }); } catch (_) {}
  if (!t.hasAttribute("data-ovl-keep")) hide(); // 액션 실행은 host, 창은 바로 닫음
});

// 로드 완료 로그(진단). host 는 ovl:ping 으로 준비를 확인한다.
log("page loaded");
