// login-gate.js — 첫 실행 온보딩 게이트(웰컴 → 브라우저 로그인 → PC 셋업).
//  미로그인(=데몬 미페어링) 동안 앱 사용을 막고, Cursor/Warp 식의 짧은 3단계로 안내한다.
//  · 텍스트 최소(사용자 확정 스펙), 브랜드 = 글리프 하나만(로고+워드마크 이중 사용 금지).
//  · 로그인 방식은 기존 그대로(브라우저 device-code) — 껍데기만 온보딩.
//  · 셋업(자동 실행 기본 켬 + 폴더 권한)은 이 게이트로 "방금 로그인한" 세션에만 1회 노출.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import {
  bindSoundSelect, openNotificationSettingsAndWatch, refreshNotificationPermission,
  sendTestNotification, soundOptionsHtml,
} from "./notification-prefs.js";

let el = null;
let session = null; // { code, secret, expiresAt, poll, busy }
let step = "welcome"; // 'welcome' | 'login' | 'setup'
let pendingSetup = false; // 이 게이트로 페어링 완료 → 셋업 1회 노출
let setupUpdate = null; // { version, progress } — 로그인 전 자동 업데이트 전용 표면
let forceInstallOnboarding = false; // 재설치 실행에서는 WebKit이 되살린 옛 완료 키도 무시
// (2026-07-28 2차 개정: 자동 실행 토글은 게이트에서 제거 — 기본 켬, 끄기는 설정 > 일반의 토글)

// ── 셋업/권한의 스코프 (2026-07-28 사용자 실사고로 개정) ─────────────────────
// 실사고: 회원탈퇴 → 같은 이메일로 재가입(서버는 하드 삭제라 **새 user id**) → 이 PC 에서 온보딩이
//  안 떴다. 원인 = `cpt.setupDone` 이 머신 1회 플래그였다. 새 계정은 새 사용자다 → **계정별 1회**.
// 반면 macOS 권한(TCC 폴더 접근·알림)은 **앱(머신) 단위**다. 그래도 새 계정 온보딩에서는 알림음
// 선택·테스트를 반드시 보여준다. 권한이 이미 있으면 [계속]으로 통과하고 OS 팝업만 생략한다.
const setupKey = () => (state.me && state.me.id != null ? `cpt.setupDone.${state.me.id}` : null);
const setupProgressKey = () => (state.me && state.me.id != null ? `cpt.setupProgress.${state.me.id}` : null);
// 권한 허용 기록 — 프로브 성공 시에만 기록한다(모든 프롬프트는 우리 버튼에서 나가므로 이 기록이
//  곧 "허용됨"의 로컬 정본이다. 사용자가 시스템 설정에서 뒤로 껐다면 다음 실제 접근이 실패하며
//  settings 의 허용 버튼이 여전히 있다 — 온보딩은 유도 장치이지 판정 정본이 아니다).
export function markPermGranted(name) { try { localStorage.setItem(`cpt.perm.${name}`, "1"); } catch (_) {} }
//  설정 화면도 같은 기록을 읽는다(2026-07-28: 이미 허용된 권한을 계속 [허용] 버튼으로 그리면
//  사용자는 "아직 허용이 안 됐나" 로 읽는다 → 기록이 있으면 '허용됨' 표기) — 그래서 export 다.
export const permGranted = (name) => { try { return localStorage.getItem(`cpt.perm.${name}`) === "1"; } catch (_) { return false; } };
const FOLDER_PERMS = [
  { id: "downloads", label: "다운로드 폴더 접근" },
  { id: "desktop", label: "데스크탑 폴더 접근" },
  { id: "documents", label: "문서 폴더 접근" },
];
const requiredPerms = () => [
  { id: "notification", label: "알림 설정" },
  ...FOLDER_PERMS.map((f) => ({ ...f, folder: true })),
];

// 권한은 화면당 하나만 요청한다. 실제 승인 확인 전에는 다음 단계가 없다.
const PERM_COPY = {
  notification: { title: "알림 설정", benefit: "에이전트 작업이 끝나거나 도움이 필요할 때 알려드려요." },
  downloads: { title: "다운로드 폴더 접근을 허용해 주세요", benefit: "프로젝트 폴더를 열고 파일을 다루는 데 필요해요" },
  desktop: { title: "데스크탑 폴더 접근을 허용해 주세요", benefit: "프로젝트 폴더를 열고 파일을 다루는 데 필요해요" },
  documents: { title: "문서 폴더 접근을 허용해 주세요", benefit: "프로젝트 폴더를 열고 파일을 다루는 데 필요해요" },
};
let permQueue = []; // 셋업 진입 시점의 "없는 권한" 스냅샷(슬라이드 순서)
let permIdx = 0;
let folderPermissionWatch = null;

export function mountLoginGate(container) {
  el = container;
  el.className = "login-gate hidden";
  el.setAttribute("data-tauri-drag-region", ""); // 게이트 상태에서도 창 이동 가능
  renderStep();
}

export function resetOnboardingForInstall() {
  forceInstallOnboarding = true;
  const prefixes = ["cpt.setupDone.", "cpt.setupProgress.", "cpt.perm.", "cpt.agentsOnboarded."];
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
  }
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
  // 설정·업데이트는 계정 인증과 무관한 로컬 기능이다. 로그인 전에도 트레이 메뉴나 ⌘, 로
  // 설정을 열 수 있고, 닫으면 다시 온보딩 게이트로 돌아온다.
  const utilitySettingsOpen = state.view === "settings";
  // 로그인 완료 직후엔 셋업 단계를 이어서 보여준다(이 게이트로 로그인한 경우 1회).
  const show = (setupUpdate || need || (pendingSetup && step === "setup")) && !utilitySettingsOpen;
  el.classList.toggle("hidden", !show);
  if (!show) stopGateLogin();
  if (need && step === "setup") { step = "welcome"; renderStep(); } // 재로그인 필요 상태로 회귀
}

export function showSetupUpdate(version) {
  setupUpdate = { version: String(version || ""), progress: null };
  renderStep();
  updateLoginGate();
}

export function updateSetupProgress(payload) {
  if (!setupUpdate) return;
  const pct = payload?.total ? Math.min(100, Math.round((payload.chunk / payload.total) * 100)) : null;
  setupUpdate.progress = Number.isFinite(pct) ? pct : null;
  renderStep();
}

export function hideSetupUpdate() {
  if (!setupUpdate) return;
  setupUpdate = null;
  renderStep();
  updateLoginGate();
}

// 앱을 ⌘Q로 완전히 종료해도 미완료 셋업을 다시 연다. 예전에는 pendingSetup이 프로세스
// 메모리에만 있어 재실행 시 페어링된 사용자는 곧바로 워크스페이스로 빠졌다.
export function restorePendingSetup() {
  if (!state.daemon?.paired || !state.authChecked || !state.me) return false;
  const doneKey = setupKey();
  let done = false;
  try { done = !!doneKey && localStorage.getItem(doneKey) === "1"; } catch (_) {}
  if (done && !forceInstallOnboarding) {
    pendingSetup = false;
    return false;
  }
  pendingSetup = true;
  step = "setup";
  permQueue = requiredPerms();
  let saved = 0;
  try { saved = Number.parseInt(localStorage.getItem(setupProgressKey()) || "0", 10); } catch (_) {}
  permIdx = Number.isFinite(saved) ? Math.max(0, Math.min(saved, permQueue.length - 1)) : 0;
  renderStep();
  updateLoginGate();
  return true;
}

// ── 렌더 ──────────────────────────────────────────────────────────────
function renderStep() {
  if (!el) return;
  if (folderPermissionWatch) {
    clearInterval(folderPermissionWatch);
    folderPermissionWatch = null;
  }
  if (setupUpdate) {
    const progress = setupUpdate.progress == null ? "다운로드를 시작하는 중…" : `${setupUpdate.progress}%`;
    el.innerHTML = `
      <div class="lg-inner">
        <div class="lg-head sm">최신 버전을 준비하고 있어요</div>
        <div class="lg-status">CodingPT ${setupUpdate.version}${setupUpdate.version ? " · " : ""}${progress}</div>
      </div>`;
    return;
  }
  if (step === "welcome") {
    el.innerHTML = `
      <div class="lg-inner">
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
  // setup — ★ 2026-07-28 2차 개정(사용자 확정): **권한 위저드(슬라이드)**.
  //  · 화면당 권한 하나 — 제목 + 이득 1줄. 장식 아이콘/브랜드 로고는 사용하지 않는다.
  //    행 목록 + 행별 작은 버튼은 "아무도 누르고 싶지 않은" 구성이었다(사용자 실사 피드백).
  //  · 자동 실행 토글은 게이트에서 제거 — 기본 켬(페어링 시 적용), 끄기는 설정 > 일반에서.
  //  · [허용] 성공 → 승인 상태를 굳히고 [다음]을 활성화한다. 자동으로 넘기지 않아 사용자가 확인한다.
  //  · [이전]은 언제나 가능, [다음]은 현재 권한이 실제 승인된 경우에만 가능하다.
  //  · 거부됨 → 그때만 [시스템 설정 열기] + '나중에 설정에서 허용' 탈출로가 열린다. 처음부터
  //    건너뛰기를 주지 않는 것은 "필수 승인" 확정 — 단 거부로 막힌 사용자를 영구히 가두지 않는다.
  if (permIdx >= permQueue.length) { finishSetup(); return; }
  const p = permQueue[permIdx];
  const c = PERM_COPY[p.id] || { title: `${p.label}을 허용해 주세요`, benefit: "" };
  const dots = permQueue.map((_, i) => `<span class="lg-dot${i === permIdx ? " on" : i < permIdx ? " done" : ""}"></span>`).join("");
  el.innerHTML = `
    <div class="lg-wizard">
      <main class="lg-wizard-body">
        ${permQueue.length > 1 ? `<div class="lg-dots">${dots}</div>` : ""}
        <div class="lg-head">${c.title}</div>
        <div class="lg-perm-benefit">${c.benefit}</div>
        ${p.id === "notification" ? `
          <div id="lgNotifWarning" class="notif-warning notif-onb-status">
            <span class="notif-warning-copy"><b id="lgNotifStatusTitle">macOS에서 CodingPT 알림을 켜주세요.</b><small id="lgNotifStatusBody">시스템 설정에서 알림을 켜면 아래 설정을 사용할 수 있어요.</small></span>
            <button id="lgOpenNotifSettings" class="sett-btn">시스템 설정 열기</button>
          </div>
          <div id="lgNotifControls" class="notif-onb-controls is-disabled">
            <label><span>알림음</span><select id="lgNotifSound" class="sett-select" disabled>${soundOptionsHtml()}</select></label>
            <button id="lgNotifTest" class="sett-btn" disabled>테스트 알림 보내기</button>
          </div>` : `
          <button id="lgOpenFolderSettings" class="sett-btn lg-open-perm-settings">시스템 설정에서 직접 변경</button>`}
        <div id="lgPermAlt" class="lg-perm-alt"></div>
      </main>
      <footer class="lg-wizard-foot">
        <span class="lg-step-count">${permIdx + 1} / ${permQueue.length}</span>
        <div class="lg-wizard-actions">
          <button id="lgPermBack" class="btn secondary"${permIdx === 0 ? " disabled" : ""}>이전</button>
          <button id="lgAllow" class="btn secondary" data-perm="${p.id}"${p.id === "notification" ? " disabled" : ""}>${p.id === "notification" ? "알림 상태 확인 중…" : "권한 확인"}</button>
          <button id="lgPermNext" class="btn primary" disabled>${permIdx === permQueue.length - 1 ? "완료" : "다음"}</button>
        </div>
      </footer>
    </div>`;
  const btn = el.querySelector("#lgAllow");
  const backBtn = el.querySelector("#lgPermBack");
  const nextBtn = el.querySelector("#lgPermNext");
  const alt = el.querySelector("#lgPermAlt");
  let grantedNow = false;
  const paintGranted = (granted) => {
    grantedNow = !!granted;
    nextBtn.disabled = !grantedNow;
    if (grantedNow) {
      btn.textContent = "허용됨 ✓";
      btn.disabled = true;
      alt.textContent = "이 권한은 허용되어 있어요.";
    }
  };
  backBtn?.addEventListener("click", () => {
    if (permIdx <= 0) return;
    permIdx -= 1;
    const progressKey = setupProgressKey();
    if (progressKey) { try { localStorage.setItem(progressKey, String(permIdx)); } catch (_) {} }
    renderStep();
  });
  nextBtn?.addEventListener("click", () => {
    if (!grantedNow) return;
    permIdx += 1;
    const progressKey = setupProgressKey();
    if (progressKey) { try { localStorage.setItem(progressKey, String(permIdx)); } catch (_) {} }
    renderStep();
  });
  el.querySelector("#lgOpenFolderSettings")?.addEventListener("click", async (ev) => {
    const open = ev.currentTarget;
    open.disabled = true;
    open.textContent = "시스템 설정 여는 중…";
    await api.openFilesPrivacy().catch(() => {});
    open.textContent = "시스템 설정에서 직접 변경";
    open.disabled = false;
  });
  if (p.id === "notification") {
    bindSoundSelect(el.querySelector("#lgNotifSound"));
    const test = el.querySelector("#lgNotifTest");
    const openSettings = el.querySelector("#lgOpenNotifSettings");
    const warning = el.querySelector("#lgNotifWarning");
    const controls = el.querySelector("#lgNotifControls");
    const soundSelect = el.querySelector("#lgNotifSound");
    const statusTitle = el.querySelector("#lgNotifStatusTitle");
    const statusBody = el.querySelector("#lgNotifStatusBody");
    const paintNotifPermission = (value) => {
      const granted = value === "granted";
      if (granted) markPermGranted("notification");
      btn.textContent = granted ? "허용됨 ✓" : "권한 확인";
      btn.disabled = !granted;
      paintGranted(granted);
      soundSelect.disabled = !granted;
      test.disabled = !granted;
      controls.classList.toggle("is-disabled", !granted);
      warning.classList.toggle("is-on", granted);
      statusTitle.textContent = granted ? "CodingPT 알림이 켜져 있어요." : "macOS에서 CodingPT 알림을 켜주세요.";
      statusBody.textContent = granted
        ? "아래에서 알림음을 선택하고 테스트할 수 있어요."
        : "시스템 설정에서 알림을 켜면 아래 설정을 사용할 수 있어요.";
    };
    const bindOpenSettings = (open) => open?.addEventListener("click", async () => {
      open.disabled = true;
      open.textContent = "여는 중…";
      try {
        await openNotificationSettingsAndWatch(paintNotifPermission);
        open.textContent = "시스템 설정 열림";
      } catch (_) {
        open.textContent = "다시 시도";
      } finally {
        open.disabled = false;
      }
    });
    bindOpenSettings(openSettings);
    refreshNotificationPermission().then(paintNotifPermission);
    soundSelect?.addEventListener("change", () => {
      test.textContent = "테스트 알림 보내기";
    });
    test?.addEventListener("click", async () => {
      test.disabled = true;
      test.textContent = "보내는 중…";
      const ok = await sendTestNotification().catch(() => false);
      if (ok) markPermGranted("notification");
      test.textContent = ok ? "다시 테스트" : "전송 실패 · 다시 시도";
      test.disabled = false;
      if (!ok) {
        paintNotifPermission("denied");
      }
    });
  }
  const completePermission = (id) => {
    markPermGranted(id);
    paintGranted(true);
  };
  btn.addEventListener("click", async () => {
    if (p.folder && btn.dataset.denied === "1") {
      btn.disabled = true;
      btn.textContent = "시스템 설정 여는 중…";
      await api.openFilesPrivacy().catch(() => {});
      btn.textContent = "설정에서 권한을 켜주세요";
      btn.disabled = false;
      let checking = false;
      folderPermissionWatch = setInterval(async () => {
        if (checking) return;
        checking = true;
        const granted = await api.probeFolder(p.id).catch(() => false);
        checking = false;
        if (!granted) return;
        clearInterval(folderPermissionWatch);
        folderPermissionWatch = null;
        completePermission(p.id);
      }, 750);
      return;
    }
    btn.disabled = true;
    btn.textContent = "확인 중…";
    const ok = p.folder
      ? await api.probeFolder(p.id).catch(() => false)
      : await api.notifPermission().catch(() => false);
    if (ok) {
      completePermission(p.id);
      return;
    }
    // macOS는 한 번 거부한 보호 폴더 팝업을 다시 띄우지 않는다. 이후 CTA는 재요청이 아니라
    // 파일 및 폴더 설정을 열고, 사용자가 토글을 켜는 순간까지 실제 접근을 폴링한다.
    btn.dataset.denied = "1";
    btn.textContent = "다시 확인";
    btn.disabled = false;
    alt.textContent = "시스템 설정에서 권한을 변경한 뒤 다시 확인해 주세요.";
  });
}

// 셋업 종료 — 계정별 완료 기록 + 게이트 닫기 + 다음 스텝(에이전트 온보딩, 계정별 1회 자체 판정).
//  부팅 시에만 돌던 온보딩을 게이트 종료 시점에도 걸어 준다(재가입/계정 전환은 부팅 없이 온다 — 실사고).
function finishSetup() {
  const k = setupKey();
  if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} }
  const progressKey = setupProgressKey();
  if (progressKey) { try { localStorage.removeItem(progressKey); } catch (_) {} }
  pendingSetup = false;
  updateLoginGate();
  const forceAgents = forceInstallOnboarding;
  forceInstallOnboarding = false;
  import("./agents-view.js").then((m) => m.maybeShowOnboarding(forceAgents).catch(() => {})).catch(() => {});
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
      // 셋업은 계정별 1회다. 새 계정은 네 권한을 모두 실제 프로브해 승인 상태를 확인한다.
      // 이미 승인된 OS 권한은 프롬프트 없이 즉시 성공하므로 중복 질문은 생기지 않는다.
      let done = false;
      const k = setupKey();
      try { done = !!k && localStorage.getItem(k) === "1"; } catch (_) {}
      if (done && !forceInstallOnboarding) {
        pendingSetup = false;
        step = "welcome";
        S.emit(); // → render() → updateLoginGate() → 게이트 닫힘(바로 워크스페이스로)
        // 에이전트 온보딩은 계정별로 따로 판정한다(부팅 없이 온 재가입/계정 전환 경로 — 실사고).
        import("./agents-view.js").then((m) => m.maybeShowOnboarding().catch(() => {})).catch(() => {});
        return;
      }
      // 셋업(권한 위저드)으로 — 자동 실행은 **묻지 않고 기본 켬**(2차 개정: 토글 제거, 끄기는 설정).
      pendingSetup = true;
      step = "setup";
      permQueue = requiredPerms();
      permIdx = 0;
      const progressKey = setupProgressKey();
      if (progressKey) { try { localStorage.setItem(progressKey, "0"); } catch (_) {} }
      api.autostartEnable().catch(() => { /* 설정 > 일반에서 다시 켤 수 있다 */ });
      renderStep();
      S.emit(); // → render() → updateLoginGate() (pendingSetup 이라 게이트 유지)
    }
  } catch (_) {
    /* 계속 폴링 — 만료 시 위에서 종료 */
  } finally {
    if (session) session.busy = false;
  }
}
