// login-gate.js — 첫 실행 온보딩 게이트(웰컴 → 브라우저 로그인 → PC 셋업).
//  미로그인(=데몬 미페어링) 동안 앱 사용을 막고, Cursor/Warp 식의 짧은 3단계로 안내한다.
//  · 텍스트 최소(사용자 확정 스펙), 브랜드 = 글리프 하나만(로고+워드마크 이중 사용 금지).
//  · 로그인 방식은 기존 그대로(브라우저 device-code) — 껍데기만 온보딩.
//  · 셋업(자동 실행 기본 켬 + 폴더 권한)은 이 게이트로 "방금 로그인한" 세션에만 1회 노출.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";

let el = null;
let session = null; // { code, secret, expiresAt, poll, busy }
let step = "welcome"; // 'welcome' | 'login' | 'setup'
let pendingSetup = false; // 이 게이트로 페어링 완료 → 셋업 1회 노출
let autostartOn = true; // 셋업 토글 상태(기본 켬 — 진입 시 실제 적용)

export function mountLoginGate(container) {
  el = container;
  el.className = "login-gate hidden";
  el.setAttribute("data-tauri-drag-region", ""); // 게이트 상태에서도 창 이동 가능
  renderStep();
}

// 로그인 여부 판정.
//  · 데몬 미페어링 → 무조건 로그인 필요.
//  · 페어링됐지만 계정 확인(loadMe)까지 끝났는데 me 가 없으면(=서버에서 기기가 폐기됨) 로그인 필요.
//    (loadMe 시도 전(authChecked=false)엔 게이트를 띄우지 않아 정상 로그인 사용자의 깜빡임 방지)
function needsLogin() {
  if (!state.daemon?.paired) return true;
  if (state.authChecked && !state.me) return true;
  return false;
}

export function updateLoginGate() {
  if (!el) return;
  const need = needsLogin();
  // 로그인 완료 직후엔 셋업 단계를 이어서 보여준다(이 게이트로 로그인한 경우 1회).
  const show = need || (pendingSetup && step === "setup");
  el.classList.toggle("hidden", !show);
  if (!show) stopGateLogin();
  if (need && step === "setup") { step = "welcome"; renderStep(); } // 재로그인 필요 상태로 회귀
}

// ── 렌더 ──────────────────────────────────────────────────────────────
function renderStep() {
  if (!el) return;
  if (step === "welcome") {
    el.innerHTML = `
      <div class="lg-inner">
        <img class="lg-glyph" src="assets/logo.png" alt="" draggable="false" />
        <div class="lg-head">폰과 태블릿에서, 내 PC 그대로</div>
        <button id="lgStart" class="btn primary lg">시작하기</button>
      </div>`;
    // 시작하기 = 바로 브라우저 로그인(클릭 수 최소 — Cursor 식).
    el.querySelector("#lgStart").addEventListener("click", () => { step = "login"; renderStep(); startGateLogin(); });
    return;
  }
  if (step === "login") {
    // 뒤로 = 좌상단 화살표 · 스피너 = 주 버튼 안 · 재열기 = 아래 텍스트 버튼 · 코드/안내문 없음
    //  (웹이 로그인 즉시 자동 연결하므로 별도 설명 불필요 — 사용자 확정 스펙)
    el.innerHTML = `
      <button id="lgBack" class="lg-back" title="처음으로">←</button>
      <div class="lg-inner">
        <div class="lg-head sm">브라우저에서 로그인하세요</div>
        <button id="lgMain" class="btn primary lg lg-wait" disabled><span class="lg-btnspin" id="lgSpin"></span><span id="lgMainTxt">브라우저 여는 중…</span></button>
        <button id="lgRetry" class="lg-link">브라우저 다시 열기</button>
        <div id="gateLoginStatus" class="lg-status"></div>
      </div>`;
    el.querySelector("#lgRetry").addEventListener("click", startGateLogin);
    el.querySelector("#lgBack").addEventListener("click", () => { stopGateLogin(); step = "welcome"; renderStep(); });
    return;
  }
  // setup
  el.innerHTML = `
    <div class="lg-inner wide">
      <div class="lg-head">거의 다 됐어요</div>
      <div class="lg-card">
        <label class="lg-row">
          <span>로그인 시 자동 실행</span>
          <input type="checkbox" id="lgAuto" class="tgl" ${autostartOn ? "checked" : ""} />
        </label>
        <div class="lg-row">
          <span>알림 허용<span class="lg-hint">작업 완료를 바로 알려드려요</span></span>
          <button id="lgNotif" class="btn small">허용</button>
        </div>
        <div class="lg-row">
          <span>폴더 접근<span class="lg-hint">다운로드·데스크탑·문서 — 한 번 허용하면 계속 적용</span></span>
          <button id="lgFolders" class="btn small">허용</button>
        </div>
      </div>
      <button id="lgDone" class="btn primary lg">시작하기</button>
    </div>`;
  el.querySelector("#lgAuto").addEventListener("change", async (e) => {
    autostartOn = !!e.target.checked;
    try { await (autostartOn ? api.autostartEnable() : api.autostartDisable()); }
    catch (_) { e.target.checked = autostartOn = !autostartOn; }
  });
  // 알림 권한 — 진입 시 1회 자동 요청 + 버튼으로 재시도. granted 면 "허용됨" 고정.
  const notifBtn = el.querySelector("#lgNotif");
  const reqNotif = async () => {
    try {
      const ok = await api.notifPermission();
      if (ok) { notifBtn.textContent = "허용됨"; notifBtn.disabled = true; }
    } catch (_) { /* dev(비번들)에선 배너가 안 뜰 수 있음 — 릴리스에서 동작 */ }
  };
  notifBtn.addEventListener("click", reqNotif);
  reqNotif();
  // 폴더 접근 3종 일괄 프로브 — 각 폴더 최초 접근 시 macOS 팝업이 순서대로 뜬다(PC 앞에서 허용).
  const fBtn = el.querySelector("#lgFolders");
  fBtn.addEventListener("click", async () => {
    if (fBtn.dataset.denied) { api.openFilesPrivacy().catch(() => {}); return; }
    fBtn.disabled = true;
    fBtn.textContent = "확인 중…";
    try {
      let all = true;
      for (const f of ["downloads", "desktop", "documents"]) {
        const ok = await api.probeFolder(f).catch(() => false);
        if (!ok) all = false;
      }
      if (all) { fBtn.textContent = "허용됨"; return; } // disabled 유지
      fBtn.dataset.denied = "1";
      fBtn.textContent = "설정 열기";
      fBtn.disabled = false;
    } catch (_) { fBtn.textContent = "허용"; fBtn.disabled = false; }
  });
  el.querySelector("#lgDone").addEventListener("click", () => {
    pendingSetup = false;
    updateLoginGate();
  });
}

function setStatus(msg) {
  const s = el?.querySelector("#gateLoginStatus");
  if (s) s.textContent = msg || "";
}
// 대기 상태 표기 — 주 버튼 안 스피너 + 라벨 갱신.
function setWaiting() {
  const spin = el?.querySelector("#lgSpin");
  const txt = el?.querySelector("#lgMainTxt");
  if (spin) spin.classList.add("on");
  if (txt) txt.textContent = "로그인 대기 중…";
}

// ── 로그인(브라우저 device-code) — 기존 로직 유지 ─────────────────────
function startGateLogin() {
  stopGateLogin();
  setStatus("");
  (async () => {
    try {
      const res = await api.pairSession(null);
      const url = await api.desktopLoginUrl(res.code);
      await api.openExternal(url).catch(() => {});
      session = {
        code: res.code,
        secret: res.sessionSecret,
        expiresAt: res.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 600000,
        poll: null,
        busy: false,
      };
      setWaiting();
      session.poll = setInterval(pollGateLogin, 2500);
    } catch (e) {
      setStatus("연결 실패 — 다시 시도하세요");
      console.warn("[gate] 로그인 세션 생성 실패:", e);
    }
  })();
}

function stopGateLogin() {
  if (session && session.poll) clearInterval(session.poll);
  session = null;
}

async function pollGateLogin() {
  if (!session || session.busy) return;
  if (Date.now() > session.expiresAt) {
    stopGateLogin();
    setStatus("코드가 만료됐어요 — 다시 시도하세요");
    return;
  }
  session.busy = true;
  try {
    const res = await api.pairPoll(null, session.code, session.secret);
    if (res && res.paired) {
      stopGateLogin();
      state.daemon = await api.daemonStatus();
      state.paired = !!state.daemon?.paired;
      await S.loadMe();
      await S.loadWorkspaces();
      // 셋업 단계로 — 자동 실행 기본 켬을 실제 적용(끄면 토글로 해제).
      pendingSetup = true;
      step = "setup";
      autostartOn = true;
      api.autostartEnable().catch(() => { autostartOn = false; });
      renderStep();
      S.emit(); // → render() → updateLoginGate() (pendingSetup 이라 게이트 유지)
    }
  } catch (_) {
    /* 계속 폴링 — 만료 시 위에서 종료 */
  } finally {
    if (session) session.busy = false;
  }
}
