// CodingPT PC — 트레이 앱 프론트(연결/상태). Tauri IPC 로 Rust 데몬 매니저를 호출.
//  페어링 UX = 넷플릭스 방식: 이 PC가 QR 을 표시 → 로그인된 코딩PT 앱이 스캔·승인 → 자동 연결.
//  (수동 코드 입력/서버 변경은 "고급" 에 폴백으로 유지.)
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const statusCard = $("statusCard");
const statusTitle = $("statusTitle");
const statusDesc = $("statusDesc");
const pairView = $("pairView");
const connectedView = $("connectedView");
const qrBox = $("qrBox");
const qrExpired = $("qrExpired");
const qrRefreshBtn = $("qrRefreshBtn");
const codeText = $("codeText");
const codeInput = $("codeInput");
const serverInput = $("serverInput");
const pairBtn = $("pairBtn");
const pairError = $("pairError");
const toggleRunBtn = $("toggleRunBtn");
const unpairBtn = $("unpairBtn");
const autostartChk = $("autostartChk");

let current = null; // 최근 상태
let qr = null; // QR 세션 { code, secret, expiresAt, poll, expiryTimer, busy }

function setStatusClass(kind) {
  statusCard.classList.remove("online", "offline", "error", "hidden");
  statusCard.classList.add(kind);
}

function render(s) {
  current = s;
  if (!s.paired) {
    // 미연결 = 상태배지 없이 바로 QR 로 연결 유도.
    statusCard.classList.add("hidden");
    pairView.classList.remove("hidden");
    connectedView.classList.add("hidden");
    ensureQrSession(); // 미연결이면 QR 세션 시작(중복 방지)
    return;
  }
  // 연결됨 → 서버 기억(unpair 후 QR 세션이 재사용) + QR 세션 종료
  if (s.server) { try { localStorage.setItem("cpt.server", s.server); } catch (_) { /* noop */ } }
  stopQrSession();
  statusCard.classList.remove("hidden");
  pairView.classList.add("hidden");
  connectedView.classList.remove("hidden");
  const meta = [s.device_name, s.server].filter(Boolean).join(" · ");
  if (s.running) {
    setStatusClass("online");
    statusTitle.textContent = "연결됨 · 실행 중";
    toggleRunBtn.textContent = "중지";
  } else {
    setStatusClass("offline");
    statusTitle.textContent = "중지됨";
    toggleRunBtn.textContent = "시작";
  }
  statusDesc.textContent = meta;
}

async function refresh() {
  try {
    render(await invoke("daemon_status"));
  } catch (e) {
    console.error("status 실패", e);
  }
}

// ── QR 페어링 세션 ─────────────────────────────────────────────
// QR 세션이 쓸 서버: 고급설정 입력값 > 마지막으로 페어링됐던 서버(localStorage) > null(→ Rust 기본값).
//  미연결 상태엔 config 가 없어 기본이 prod 인데, prod 에 BYO 엔드포인트가 없으면 세션 생성이 실패한다.
//  → 직전에 붙었던 서버를 기억해 재사용(로컬/dev 백엔드 테스트가 바로 됨).
function serverOverride() {
  const v = (serverInput.value || "").trim();
  if (v) return v;
  try { return localStorage.getItem("cpt.server") || null; } catch (_) { return null; }
}

// text 를 담는 QR 을 그린다(맞는 타입 자동 선택).
function renderQr(text) {
  let model = null;
  for (let t = 3; t <= 14; t++) {
    try {
      const m = qrcode(t, "M");
      m.addData(text);
      m.make();
      model = m;
      break;
    } catch (_) { /* 용량 부족 → 타입 증가 */ }
  }
  if (!model) { qrBox.textContent = "QR 생성 실패"; return; }
  qrBox.innerHTML = model.createImgTag(6, 0);
}

async function startQrSession() {
  stopQrSession();
  qrExpired.classList.add("hidden");
  qrBox.innerHTML = '<div class="qr-spinner"></div>';
  codeText.textContent = "····-····";
  try {
    const res = await invoke("daemon_pair_session", { server: serverOverride() });
    qr = {
      code: res.code,
      secret: res.sessionSecret,
      expiresAt: res.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 10 * 60 * 1000,
      poll: null,
      expiryTimer: null,
      busy: false,
    };
    renderQr(res.deepLink || `codingpt://pair?code=${res.code}`);
    codeText.textContent = res.code;
    qr.poll = setInterval(pollQr, 2500);
    const ms = Math.max(1000, qr.expiresAt - Date.now());
    qr.expiryTimer = setTimeout(expireQr, ms);
  } catch (e) {
    qrBox.innerHTML = "";
    qrExpired.classList.remove("hidden");
    qrExpired.querySelector("span").textContent = "세션 생성 실패";
    console.error("pair-session 실패", e);
  }
}

// 미연결 상태 진입 시 1회만 시작(이미 세션 있으면 유지).
function ensureQrSession() {
  if (!qr && !pairView.classList.contains("hidden")) startQrSession();
}

function stopQrSession() {
  if (qr) {
    if (qr.poll) clearInterval(qr.poll);
    if (qr.expiryTimer) clearTimeout(qr.expiryTimer);
  }
  qr = null;
}

function expireQr() {
  if (!qr) return;
  if (qr.poll) clearInterval(qr.poll);
  qr.poll = null;
  qrExpired.querySelector("span").textContent = "코드가 만료됐어요";
  qrExpired.classList.remove("hidden");
}

async function pollQr() {
  if (!qr || qr.busy) return;
  qr.busy = true;
  try {
    const res = await invoke("daemon_pair_poll", { server: serverOverride(), code: qr.code, secret: qr.secret });
    if (res && res.paired) {
      stopQrSession();
      await refresh(); // 연결됨 화면으로 전환
    }
    // pending 이면 계속 폴링
  } catch (e) {
    // 만료/오류 → 다음 새 코드 유도(폴링 중단)
    console.warn("pair-poll", e);
    expireQr();
  } finally {
    if (qr) qr.busy = false;
  }
}

// ── 수동 코드(레거시, 고급) ──
async function doPair() {
  const code = (codeInput.value || "").trim().toUpperCase();
  const server = (serverInput.value || "").trim();
  pairError.classList.add("hidden");
  if (!code) {
    pairError.textContent = "페어링 코드를 입력하세요.";
    pairError.classList.remove("hidden");
    return;
  }
  pairBtn.disabled = true;
  pairBtn.textContent = "연결 중…";
  try {
    const s = await invoke("daemon_pair", { code, server: server || null });
    codeInput.value = "";
    render(s);
  } catch (e) {
    pairError.textContent = String(e);
    pairError.classList.remove("hidden");
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = "코드로 연결";
  }
}

async function toggleRun() {
  toggleRunBtn.disabled = true;
  try {
    render(await invoke(current && current.running ? "daemon_stop" : "daemon_start"));
  } catch (e) {
    console.error(e);
  } finally {
    toggleRunBtn.disabled = false;
  }
}

// 연결 해제 — Tauri 웹뷰는 window.confirm 을 지원하지 않으므로(무반응) 2-클릭 확인으로 처리.
let unpairArmed = false;
let unpairTimer = null;
function resetUnpairBtn() {
  unpairArmed = false;
  if (unpairTimer) { clearTimeout(unpairTimer); unpairTimer = null; }
  unpairBtn.textContent = "연결 해제";
  unpairBtn.classList.remove("danger");
}
async function doUnpair() {
  if (!unpairArmed) {
    unpairArmed = true;
    unpairBtn.textContent = "정말 해제? (다시 탭)";
    unpairBtn.classList.add("danger");
    unpairTimer = setTimeout(resetUnpairBtn, 3000); // 3초 내 재탭 안 하면 원복
    return;
  }
  if (unpairTimer) { clearTimeout(unpairTimer); unpairTimer = null; }
  unpairArmed = false;
  unpairBtn.disabled = true;
  unpairBtn.textContent = "해제 중…";
  try {
    render(await invoke("daemon_unpair"));
  } catch (e) {
    console.error(e);
  } finally {
    unpairBtn.disabled = false;
    unpairBtn.classList.remove("danger");
    unpairBtn.textContent = "연결 해제";
  }
}

// ── 자동 실행(로그인 아이템) 토글 ──
async function syncAutostart() {
  try {
    autostartChk.checked = await invoke("plugin:autostart|is_enabled");
  } catch (_) {}
}
autostartChk?.addEventListener("change", async () => {
  try {
    await invoke(autostartChk.checked ? "plugin:autostart|enable" : "plugin:autostart|disable");
  } catch (e) {
    console.error(e);
    autostartChk.checked = !autostartChk.checked;
  }
});

qrRefreshBtn.addEventListener("click", startQrSession);
pairBtn.addEventListener("click", doPair);
codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doPair(); });
toggleRunBtn.addEventListener("click", toggleRun);
unpairBtn.addEventListener("click", doUnpair);

// 데몬 상태 변경 이벤트(Rust) → 즉시 갱신
listen("daemon-changed", refresh);

// 딥링크 원탭 연결(레거시): codingpt-pc://pair?code=... → 코드 프리필 + 자동 연결
listen("deep-link-pair", (e) => {
  const { code, server } = e.payload || {};
  if (code) codeInput.value = String(code).toUpperCase();
  if (server) serverInput.value = String(server);
  if (code) doPair();
});

// 마지막으로 붙었던 서버를 고급설정에 프리필(미연결 QR 세션이 그 서버를 쓰도록).
try { const ls = localStorage.getItem("cpt.server"); if (ls && !serverInput.value) serverInput.value = ls; } catch (_) { /* noop */ }

// 초기화 + 폴백 폴링(상태만)
refresh();
syncAutostart();
setInterval(refresh, 3000);
