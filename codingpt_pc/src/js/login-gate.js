// login-gate.js — 첫 실행 온보딩 게이트(웰컴 → 브라우저 로그인 → PC 셋업).
//  미로그인(=데몬 미페어링) 동안 앱 사용을 막고, Cursor/Warp 식의 짧은 3단계로 안내한다.
//  · 텍스트 최소(사용자 확정 스펙), 브랜드 = 글리프 하나만(로고+워드마크 이중 사용 금지).
//  · 로그인 방식은 기존 그대로(브라우저 device-code) — 껍데기만 온보딩.
//  · 셋업(자동 실행 기본 켬 + 폴더 권한)은 이 게이트로 "방금 로그인한" 세션에만 1회 노출.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";

let el = null;
let session = null; // { code, secret, expiresAt, poll, busy }
let step = "welcome"; // 'welcome' | 'login' | 'setup'
let pendingSetup = false; // 이 게이트로 페어링 완료 → 셋업 1회 노출
// (2026-07-28 2차 개정: 자동 실행 토글은 게이트에서 제거 — 기본 켬, 끄기는 설정 > 일반의 토글)

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
  if (!permGranted("notif")) out.push({ id: "notif", label: "알림 허용" });
  for (const f of FOLDER_PERMS) if (!permGranted(f.id)) out.push({ ...f, folder: true });
  return out;
}

// ── 권한 위저드 카피 — 화면당 하나에 집중하므로 "왜 필요한가" 를 크게 말할 자리가 생긴다 ────────
//  (사용자 확정 2026-07-28 2차: 목록+행별 버튼은 아무도 누르고 싶지 않은 구성이었다 → 슬라이드
//   하나에 권한 하나 + 하단 [허용] 단일 CTA. Raycast/Warp 류 데스크톱 온보딩과 같은 패턴.)
const PERM_COPY = {
  notif: { title: "알림을 허용해 주세요", benefit: "AI 작업이 끝나면 바로 알려드려요 — 화면을 계속 지켜볼 필요가 없어요" },
  downloads: { title: "다운로드 폴더 접근을 허용해 주세요", benefit: "이 폴더의 프로젝트를 열고 AI가 파일을 다룰 수 있어요" },
  desktop: { title: "데스크탑 폴더 접근을 허용해 주세요", benefit: "이 폴더의 프로젝트를 열고 AI가 파일을 다룰 수 있어요" },
  documents: { title: "문서 폴더 접근을 허용해 주세요", benefit: "이 폴더의 프로젝트를 열고 AI가 파일을 다룰 수 있어요" },
};
let permQueue = []; // 셋업 진입 시점의 "없는 권한" 스냅샷(슬라이드 순서)
let permIdx = 0;

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
  // setup — ★ 2026-07-28 2차 개정(사용자 확정): **권한 위저드(슬라이드)**.
  //  · 화면당 권한 하나 — 큰 아이콘 + 제목 + 이득 1줄 + 하단 [허용] 단일 CTA(필수 승인 프레이밍).
  //    행 목록 + 행별 작은 버튼은 "아무도 누르고 싶지 않은" 구성이었다(사용자 실사 피드백).
  //  · 자동 실행 토글은 게이트에서 제거 — 기본 켬(페어링 시 적용), 끄기는 설정 > 일반에서.
  //  · [허용] 성공 → ✓ 로 잠깐 굳었다가 자동으로 다음 슬라이드. 전부 끝나면 셋업 종료.
  //  · 거부됨 → 그때만 [시스템 설정 열기] + '나중에 설정에서 허용' 탈출로가 열린다. 처음부터
  //    건너뛰기를 주지 않는 것은 "필수 승인" 확정 — 단 거부로 막힌 사용자를 영구히 가두지 않는다.
  if (permIdx >= permQueue.length) { finishSetup(); return; }
  const p = permQueue[permIdx];
  const c = PERM_COPY[p.id] || { title: `${p.label}을 허용해 주세요`, benefit: "" };
  const dots = permQueue.map((_, i) => `<span class="lg-dot${i === permIdx ? " on" : i < permIdx ? " done" : ""}"></span>`).join("");
  el.innerHTML = `
    <div class="lg-inner wide lg-slide">
      ${permQueue.length > 1 ? `<div class="lg-dots">${dots}</div>` : ""}
      <div class="lg-perm-ic">${p.folder ? icons.folder({ size: 30 }) : icons.bell({ size: 30 })}</div>
      <div class="lg-head">${c.title}</div>
      <div class="lg-perm-benefit">${c.benefit}</div>
      <div class="lg-perm-hint">허용을 누르면 macOS 확인 창이 떠요 — 거기서도 [허용]을 눌러 주세요</div>
      <button id="lgAllow" class="btn primary lg" data-perm="${p.id}">허용</button>
      <div id="lgPermAlt" class="lg-perm-alt"></div>
    </div>`;
  const btn = el.querySelector("#lgAllow");
  const alt = el.querySelector("#lgPermAlt");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "확인 중…";
    const ok = p.folder
      ? await api.probeFolder(p.id).catch(() => false)
      : await api.notifPermission().catch(() => false);
    if (ok) {
      markPermGranted(p.id);
      btn.textContent = "허용됐어요 ✓";
      setTimeout(() => { permIdx += 1; renderStep(); }, 450); // ✓ 를 잠깐 보여주고 다음 슬라이드
      return;
    }
    // 거부/실패 — 재시도 유지 + 시스템 설정 경로 + 최소 탈출로(이때만 연다).
    btn.textContent = "허용";
    btn.disabled = false;
    alt.innerHTML = `
      <button class="lg-link" id="lgOpenPriv">시스템 설정 열기</button>
      <button class="lg-link" id="lgSkipPerm">나중에 설정에서 허용</button>`;
    alt.querySelector("#lgOpenPriv").addEventListener("click", () => { api.openFilesPrivacy().catch(() => {}); });
    alt.querySelector("#lgSkipPerm").addEventListener("click", () => { permIdx += 1; renderStep(); });
  });
}

// 셋업 종료 — 계정별 완료 기록 + 게이트 닫기 + 다음 스텝(에이전트 온보딩, 계정별 1회 자체 판정).
//  부팅 시에만 돌던 온보딩을 게이트 종료 시점에도 걸어 준다(재가입/계정 전환은 부팅 없이 온다 — 실사고).
function finishSetup() {
  const k = setupKey();
  if (k) { try { localStorage.setItem(k, "1"); } catch (_) {} }
  pendingSetup = false;
  updateLoginGate();
  import("./agents-view.js").then((m) => m.maybeShowOnboarding().catch(() => {})).catch(() => {});
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
      // 셋업(권한 위저드)으로 — 자동 실행은 **묻지 않고 기본 켬**(2차 개정: 토글 제거, 끄기는 설정).
      pendingSetup = true;
      step = "setup";
      permQueue = missingPerms(); // 이 시점 스냅샷이 슬라이드 순서다
      permIdx = 0;
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
