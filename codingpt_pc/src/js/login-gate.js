// login-gate.js — 미로그인 시 전체화면 로그인 게이트로 앱 사용을 막는다.
//  로그인(=데몬 페어링, 웹 device-code 방식)이 되기 전에는 워크스페이스/설정에 접근 불가.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";

let el = null;
let session = null; // { code, secret, expiresAt, poll, busy }

export function mountLoginGate(container) {
  el = container;
  el.className = "login-gate hidden";
  el.setAttribute("data-tauri-drag-region", ""); // 게이트 상태에서도 창 이동 가능
  el.innerHTML = `
    <div class="lg-inner">
      <div class="lg-sub">로그인하고 시작하세요</div>
      <button id="gateLoginBtn" class="btn primary lg">로그인</button>
      <div id="gateLoginStatus" class="lg-status"></div>
    </div>`;
  el.querySelector("#gateLoginBtn").addEventListener("click", startGateLogin);
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
  const gate = needsLogin();
  el.classList.toggle("hidden", !gate);
  if (!gate) stopGateLogin(); // 로그인되면 폴링 정리
}

function setStatus(msg) {
  const s = el?.querySelector("#gateLoginStatus");
  if (s) s.textContent = msg || "";
}
function setBtn(txt, disabled) {
  const b = el?.querySelector("#gateLoginBtn");
  if (b) { b.textContent = txt; b.disabled = !!disabled; }
}

function startGateLogin() {
  stopGateLogin();
  setBtn("브라우저 여는 중…", true);
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
      setStatus("브라우저에서 로그인 후 ‘이 PC 연결하기’를 누르세요…");
      setBtn("브라우저에서 로그인 대기 중…", true);
      session.poll = setInterval(pollGateLogin, 2500);
    } catch (e) {
      setStatus("로그인 세션 생성 실패: " + e);
      setBtn("로그인", false);
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
    setStatus("코드가 만료됐어요. 다시 시도하세요.");
    setBtn("로그인", false);
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
      S.emit(); // → render() → updateLoginGate() 가 게이트를 숨김
    }
  } catch (_) {
    /* 계속 폴링 — 만료 시 위에서 종료 */
  } finally {
    if (session) session.busy = false;
  }
}
