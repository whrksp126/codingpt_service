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

// ── 셋업/권한의 스코프 (2026-07-28 사용자 실사고로 개정) ─────────────────────
// 실사고: 회원탈퇴 → 같은 이메일로 재가입(서버는 하드 삭제라 **새 user id**) → 이 PC 에서 온보딩이
//  안 떴다. 원인 = `cpt.setupDone` 이 머신 1회 플래그였다. 새 계정은 새 사용자다 → **계정별 1회**.
// 반면 macOS 권한(TCC 폴더 접근·알림)은 **앱(머신) 단위**다 — 계정을 바꿔도 이미 허용돼 있다.
//  그래서 셋업 화면은 "이 계정이 처음 + 아직 없는 권한만 하나씩" 을 그린다(사용자 확정: 권한 없는
//  것만 등장해 바로 허용 유도). 전부 허용돼 있으면 셋업 자체를 건너뛴다.
const setupKey = () => (state.me && state.me.id != null ? `cpt.setupDone.${state.me.id}` : null);
// 권한 허용 기록 — 프로브 성공 시에만 기록한다(모든 프롬프트는 우리 버튼에서 나가므로 이 기록이
//  곧 "허용됨"의 로컬 정본이다. 사용자가 시스템 설정에서 뒤로 껐다면 다음 실제 접근이 실패하며
//  settings 의 허용 버튼이 여전히 있다 — 온보딩은 유도 장치이지 판정 정본이 아니다).
export function markPermGranted(name) { try { localStorage.setItem(`cpt.perm.${name}`, "1"); } catch (_) {} }
const permGranted = (name) => { try { return localStorage.getItem(`cpt.perm.${name}`) === "1"; } catch (_) { return false; } };
const FOLDER_PERMS = [
  { id: "downloads", label: "다운로드 폴더 접근" },
  { id: "desktop", label: "데스크탑 폴더 접근" },
  { id: "documents", label: "문서 폴더 접근" },
];
function missingPerms() {
  const out = [];
  if (!permGranted("notif")) out.push({ id: "notif", label: "알림 허용", hint: "작업 완료를 바로 알려드려요" });
  for (const f of FOLDER_PERMS) if (!permGranted(f.id)) out.push({ ...f, folder: true });
  return out;
}

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
  // setup — ★ 2026-07-28 개정(사용자 확정): 권한은 **없는 것만 하나씩** 행으로 등장해 그 자리에서
  //  허용을 유도한다(설정 화면의 fpa 행과 동일 구성). 각 행의 [허용]이 그 폴더를 실제 프로브해
  //  macOS 팝업을 띄우고, 성공하면 "허용됨"으로 굳는다(+ 로컬 기록 → 다음 계정에선 그 행이 안 나온다).
  const perms = missingPerms();
  el.innerHTML = `
    <div class="lg-inner wide">
      <div class="lg-head">거의 다 됐어요</div>
      <div class="lg-card">
        <label class="lg-row">
          <span>로그인 시 자동 실행</span>
          <input type="checkbox" id="lgAuto" class="tgl" ${autostartOn ? "checked" : ""} />
        </label>
        ${perms.map((p) => `
        <div class="lg-row">
          <span>${p.label}${p.hint ? `<span class="lg-hint">${p.hint}</span>` : ""}</span>
          <button class="btn small lg-perm" data-perm="${p.id}"${p.folder ? ' data-folder="1"' : ""}>허용</button>
        </div>`).join("")}
        ${perms.some((p) => p.folder) ? `<div class="lg-hint" style="padding:4px 2px 0">한 번 허용하면 모든 워크스페이스에 적용돼요</div>` : ""}
      </div>
      <button id="lgDone" class="btn primary lg">시작하기</button>
    </div>`;
  el.querySelector("#lgAuto").addEventListener("change", async (e) => {
    autostartOn = !!e.target.checked;
    try { await (autostartOn ? api.autostartEnable() : api.autostartDisable()); }
    catch (_) { e.target.checked = autostartOn = !autostartOn; }
  });
  el.querySelectorAll(".lg-perm").forEach((btn) => btn.addEventListener("click", async () => {
    const id = btn.dataset.perm;
    if (btn.dataset.denied) { api.openFilesPrivacy().catch(() => {}); return; }
    btn.disabled = true;
    btn.textContent = "확인 중…";
    try {
      const ok = btn.dataset.folder
        ? await api.probeFolder(id).catch(() => false)
        : await api.notifPermission().catch(() => false);
      if (ok) { markPermGranted(id); btn.textContent = "허용됨"; return; } // disabled 유지
      // 거부됨 — 시스템 설정으로 안내(폴더는 파일 및 폴더, 알림은 알림 설정이지만 진입점은 같다).
      btn.dataset.denied = "1";
      btn.textContent = "설정 열기";
      btn.disabled = false;
    } catch (_) { btn.textContent = "허용"; btn.disabled = false; }
  }));
  el.querySelector("#lgDone").addEventListener("click", () => {
    const k = setupKey();
    if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} } // 이 계정+이 PC 셋업 완료
    pendingSetup = false;
    updateLoginGate();
    // 다음 스텝: 에이전트 온보딩(계정별 1회 — agents-view 가 자체 판정). 부팅 시에만 돌던 것을
    //  게이트 종료 시점에도 걸어 준다(재가입/계정 전환은 부팅 없이 일어난다 — 실사고).
    import("./agents-view.js").then((m) => m.maybeShowOnboarding().catch(() => {})).catch(() => {});
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
      // ★ 2026-07-28 개정: 셋업은 **계정별 1회**다(구 `cpt.setupDone` 머신 플래그는 회원탈퇴 →
      //  같은 이메일 재가입(새 user id)에서 온보딩을 삼켰다 — 실사고). 단 이 계정이 처음이어도
      //  요청할 권한이 하나도 없으면(전부 허용됨) 셋업 화면 자체를 건너뛴다(빈 화면 금지).
      let done = false;
      const k = setupKey();
      try { done = !!k && localStorage.getItem(k) === "1"; } catch (_) {}
      if (done || !missingPerms().length) {
        if (!done && k) { try { localStorage.setItem(k, "1"); } catch (_) {} }
        pendingSetup = false;
        step = "welcome";
        S.emit(); // → render() → updateLoginGate() → 게이트 닫힘(바로 워크스페이스로)
        // 에이전트 온보딩은 계정별로 따로 판정한다(부팅 없이 온 재가입/계정 전환 경로 — 실사고).
        import("./agents-view.js").then((m) => m.maybeShowOnboarding().catch(() => {})).catch(() => {});
        return;
      }
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
