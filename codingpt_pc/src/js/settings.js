// settings.js — "내 정보 · 설정" 모달. 좌측 탭 사이드바 + 우측 콘텐츠(오버레이).
//  모바일 연결 관리(QR 페어링/상태/해제)를 "연결" 탭에 담는다. QR = vendor/qrcode.js(전역 qrcode).
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";

let root = null;
let navEl = null;
let contentEl = null;
let connBody = null; // 연결 탭 내부 컨테이너
let autostartChk = null;
let section = "connection"; // 'connection' | 'general' | 'about'
let connMode = null; // 'paired' | 'unpaired'
let query = "";
let qr = null;
let webLogin = null; // 웹 로그인 폴링 세션

const NAV = [
  { key: "connection", label: "계정", icon: "user" },
  { key: "general", label: "일반", icon: "gear" },
  { key: "about", label: "정보", icon: "monitor" },
];

export function mountSettings(container) {
  root = container;
  root.className = "settings-modal hidden";
  root.innerHTML = `
    <div class="sm-backdrop" id="smBackdrop"></div>
    <div class="sm-card" role="dialog" aria-modal="true">
      <aside class="sm-nav">
        <div class="sm-search">
          <span class="sm-search-ic">${icons.search({ size: 15 })}</span>
          <input class="sm-search-input" id="smSearch" placeholder="검색" />
        </div>
        <div class="sm-navgroup">설정</div>
        <div class="sm-navlist" id="smNav"></div>
      </aside>
      <div class="sm-main">
        <button class="sm-close" id="smClose" title="닫기">${icons.x({ size: 18 })}</button>
        <div class="sm-content" id="smContent"></div>
      </div>
    </div>`;
  navEl = root.querySelector("#smNav");
  contentEl = root.querySelector("#smContent");
  root.querySelector("#smClose").addEventListener("click", close);
  root.querySelector("#smBackdrop").addEventListener("click", close);
  const search = root.querySelector("#smSearch");
  search.addEventListener("input", () => { query = search.value; renderNav(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.view === "settings") { e.preventDefault(); close(); }
  });
}

function close() {
  S.setView("workspace");
}

export function updateSettings() {
  if (!root) return;
  const show = state.view === "settings";
  root.classList.toggle("hidden", !show);
  if (!show) {
    stopQr();
    stopWebLogin();
    connMode = null;
    return;
  }
  renderNav();
  renderSection(false);
}

function renderNav() {
  navEl.innerHTML = "";
  const q = query.trim().toLowerCase();
  for (const item of NAV) {
    if (q && !item.label.toLowerCase().includes(q)) continue;
    const b = document.createElement("button");
    b.className = "sm-navitem" + (item.key === section ? " active" : "");
    b.innerHTML = `<span class="sm-navic">${icons[item.icon]({ size: 17 })}</span><span>${item.label}</span>`;
    b.addEventListener("click", () => {
      if (section === item.key) return;
      section = item.key;
      renderNav();
      renderSection(true);
    });
    navEl.appendChild(b);
  }
}

// force = 탭 전환 등으로 강제 재구성. 아니면 상태만 갱신.
function renderSection(force) {
  if (section !== "connection") stopQr();
  if (section === "connection") {
    if (force || connMode === null || !contentEl.querySelector("#connBody")) {
      contentEl.innerHTML = `
        <div class="sm-h">계정</div>
        <div id="connBody" class="conn-body"></div>`;
      connBody = contentEl.querySelector("#connBody");
      connMode = null;
    }
    const paired = !!state.daemon?.paired;
    const mode = paired ? "paired" : "unpaired";
    if (mode !== connMode) {
      connMode = mode;
      paired ? buildPaired() : buildUnpaired();
    } else if (paired) {
      updatePairedStatus();
      ensureAccountCard();
      renderDeviceList();
    }
  } else if (section === "general") {
    contentEl.innerHTML = `
      <div class="sm-h">일반</div>
      <div class="sm-card2">
        <label class="switch"><input id="autostartChk" type="checkbox" /><span>이 Mac 로그인 시 자동 실행</span></label>
        <div class="sett-row"><span>테마</span><span class="dim">다크</span></div>
      </div>`;
    autostartChk = contentEl.querySelector("#autostartChk");
    autostartChk.addEventListener("change", async () => {
      try {
        await (autostartChk.checked ? api.autostartEnable() : api.autostartDisable());
      } catch (_) {
        autostartChk.checked = !autostartChk.checked;
      }
    });
    syncAutostart();
  } else {
    contentEl.innerHTML = `
      <div class="sm-h">정보</div>
      <div class="sm-card2">
        <div class="sett-row"><span>버전</span><span class="dim">CodingPT PC 0.1.0</span></div>
        <div class="sett-row"><span>이 창을 닫아도</span><span class="dim">메뉴바에서 계속 실행됩니다</span></div>
      </div>`;
  }
}

async function syncAutostart() {
  try {
    if (autostartChk) autostartChk.checked = await api.autostartEnabled();
  } catch (_) {}
}

// 계정 카드(로그인된 사용자 프로필). state.me 없으면 빈 문자열.
function accountCardHtml() {
  const me = state.me;
  if (!me) return "";
  const name = esc(me.nickname || me.email || "사용자");
  const email = esc(me.email || "");
  const initial = (me.nickname || me.email || "U").trim().charAt(0).toUpperCase();
  const avatar = me.profileImg
    ? `<img class="acct-img" src="${esc(me.profileImg)}" alt="" />`
    : `<span class="acct-initial">${esc(initial)}</span>`;
  return `
    <div class="acct-card">
      <div class="acct-avatar">${avatar}</div>
      <div class="acct-meta"><div class="acct-name">${name}</div>${email ? `<div class="acct-email">${email}</div>` : ""}</div>
      <span class="acct-badge">로그인됨</span>
    </div>`;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// 프로필 지연 로드 후 계정 카드 반영(paired 뷰 통째 재빌드 없이).
function ensureAccountCard() {
  if (!connBody || !state.me) return;
  const html = accountCardHtml();
  if (!html) return;
  const card = connBody.querySelector(".acct-card");
  if (!card) connBody.insertAdjacentHTML("afterbegin", html);
  else card.outerHTML = html;
}

// ── 로그인됨: 계정 + 이 기기 상태 + 내 기기 목록 ──
function buildPaired() {
  stopQr();
  stopWebLogin();
  connBody.innerHTML = `
    ${accountCardHtml()}
    <div class="conn-status">
      <span class="cst-dot"></span>
      <div class="cst-text"><div class="cst-title" id="cstTitle">로그인됨</div><div class="cst-desc" id="cstDesc"></div></div>
    </div>
    <div class="conn-actions">
      <button id="toggleRunBtn" class="btn">중지</button>
      <button id="unpairBtn" class="btn ghost">로그아웃</button>
    </div>
    <div class="dev-section">
      <div class="dev-title">내 기기</div>
      <div id="deviceList" class="dev-list"></div>
    </div>`;
  connBody.querySelector("#toggleRunBtn").addEventListener("click", toggleRun);
  bindUnpair(connBody.querySelector("#unpairBtn"));
  updatePairedStatus();
  renderDeviceList();
  if (!state.me) S.loadMe(); // 프로필 지연 로드 → emit 후 재렌더
  S.loadDevices(); // 기기 목록/온라인 상태 최신화
}

// "내 기기" 목록 렌더(state.devices). 클라우드 호스트 포함.
function renderDeviceList() {
  const el = connBody?.querySelector("#deviceList");
  if (!el) return;
  if (!state.devices.length) { el.innerHTML = `<div class="dim" style="font-size:12px">불러오는 중…</div>`; return; }
  el.innerHTML = state.devices.map((d) => {
    const cur = d.isCurrent ? `<span class="dev-badge cur">이 기기</span>` : "";
    const kindLabel = d.runnerKind === "cloud" ? "클라우드 · 항상 켜짐" : `${d.platform || "기기"} · ${d.online ? "온라인" : "오프라인"}`;
    const icon = d.runnerKind === "cloud" ? icons.cloud({ size: 16 }) : icons.monitor({ size: 16 });
    return `<div class="dev-row">
      <span class="dev-ic">${icon}</span>
      <div class="dev-meta"><div class="dev-name">${esc(d.name)}${cur}</div><div class="dev-sub">${esc(kindLabel)}</div></div>
      <span class="dev-dot ${d.online ? "on" : "off"}"></span>
    </div>`;
  }).join("");
}

function updatePairedStatus() {
  const d = state.daemon;
  if (!d || !connBody) return;
  const dot = connBody.querySelector(".cst-dot");
  const title = connBody.querySelector("#cstTitle");
  const desc = connBody.querySelector("#cstDesc");
  const run = connBody.querySelector("#toggleRunBtn");
  if (!dot) return;
  dot.className = "cst-dot " + (d.running ? "on" : "off");
  title.textContent = d.running ? "연결됨 · 실행 중" : "중지됨";
  desc.textContent = [d.device_name, d.server].filter(Boolean).join(" · ");
  if (run) run.textContent = d.running ? "중지" : "시작";
}

async function toggleRun() {
  const run = connBody.querySelector("#toggleRunBtn");
  run.disabled = true;
  try {
    state.daemon = await (state.daemon?.running ? api.daemonStop() : api.daemonStart());
  } catch (_) {}
  run.disabled = false;
  updatePairedStatus();
  S.emit();
}

// 연결 해제 — Tauri 웹뷰는 confirm 미지원 → 2-클릭 확인.
function bindUnpair(btn) {
  let armed = false;
  let timer = null;
  const reset = () => {
    armed = false;
    if (timer) clearTimeout(timer);
    btn.textContent = "연결 해제";
    btn.classList.remove("danger");
  };
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "정말 해제? (다시 클릭)";
      btn.classList.add("danger");
      timer = setTimeout(reset, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed = false;
    btn.disabled = true;
    btn.textContent = "로그아웃 중…";
    try {
      state.daemon = await api.unpair();
      state.me = null;
    } catch (_) {}
    btn.disabled = false;
    reset();
    S.emit();
  });
}

// ── 미연결: QR 페어링 ──
function serverOverride() {
  const inp = connBody?.querySelector("#serverInput");
  const v = (inp?.value || "").trim();
  if (v) return v;
  try {
    return localStorage.getItem("cpt.server") || null;
  } catch (_) {
    return null;
  }
}

function buildUnpaired() {
  stopWebLogin();
  connBody.innerHTML = `
    <div class="login-primary">
      <button id="webLoginBtn" class="btn primary lg">로그인</button>
      <div id="webLoginStatus" class="login-status"></div>
    </div>`;
  connBody.querySelector("#webLoginBtn").addEventListener("click", startWebLogin);
}

// ── 웹 로그인(클로드 코드식): 페어링 세션 → 브라우저 승인 → 폴링 claim ──
function startWebLogin() {
  stopWebLogin();
  const btn = connBody?.querySelector("#webLoginBtn");
  const statusEl = connBody?.querySelector("#webLoginStatus");
  if (btn) { btn.disabled = true; btn.textContent = "브라우저 여는 중…"; }
  (async () => {
    try {
      // 서버는 null 로 넘겨 Rust(resolve_server=config→DEFAULT)가 정하게 한다.
      //  desktopLoginUrl 도 같은 소스를 쓰므로 "세션 생성 서버"와 "브라우저 서버"가 항상 일치.
      const res = await api.pairSession(null);
      const url = await api.desktopLoginUrl(res.code);
      await api.openExternal(url).catch(() => {});
      webLogin = {
        code: res.code,
        secret: res.sessionSecret,
        expiresAt: res.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 600000,
        poll: null,
        busy: false,
      };
      if (statusEl) statusEl.textContent = "브라우저에서 로그인 후 ‘이 PC 연결하기’를 누르세요…";
      if (btn) btn.textContent = "브라우저에서 로그인 대기 중…";
      webLogin.poll = setInterval(pollWebLogin, 2500);
    } catch (e) {
      if (statusEl) statusEl.textContent = "로그인 세션 생성 실패: " + e;
      if (btn) { btn.disabled = false; btn.textContent = "로그인"; }
    }
  })();
}
function stopWebLogin() {
  if (webLogin && webLogin.poll) clearInterval(webLogin.poll);
  webLogin = null;
}
async function pollWebLogin() {
  if (!webLogin || webLogin.busy) return;
  if (Date.now() > webLogin.expiresAt) {
    stopWebLogin();
    const s = connBody?.querySelector("#webLoginStatus");
    const b = connBody?.querySelector("#webLoginBtn");
    if (s) s.textContent = "코드가 만료됐어요. 다시 시도하세요.";
    if (b) { b.disabled = false; b.textContent = "로그인"; }
    return;
  }
  webLogin.busy = true;
  try {
    const res = await api.pairPoll(null, webLogin.code, webLogin.secret);
    if (res && res.paired) {
      stopWebLogin();
      state.daemon = await api.daemonStatus();
      state.paired = !!state.daemon?.paired;
      await S.loadMe();
      await S.loadWorkspaces();
      S.emit();
    }
  } catch (_) {
    /* 계속 폴링 — 만료 시 위에서 종료 */
  } finally {
    if (webLogin) webLogin.busy = false;
  }
}

function renderQr(text) {
  const qrBox = connBody.querySelector("#qrBox");
  let model = null;
  for (let t = 3; t <= 14; t++) {
    try {
      const m = window.qrcode(t, "M");
      m.addData(text);
      m.make();
      model = m;
      break;
    } catch (_) {}
  }
  if (!model) {
    qrBox.textContent = "QR 생성 실패";
    return;
  }
  qrBox.innerHTML = model.createImgTag(6, 0);
}

async function startQr() {
  stopQr();
  const qrExpired = connBody.querySelector("#qrExpired");
  const qrBox = connBody.querySelector("#qrBox");
  if (!qrBox) return;
  qrExpired.classList.add("hidden");
  qrBox.innerHTML = '<div class="qr-spinner"></div>';
  connBody.querySelector("#codeText").textContent = "····-····";
  try {
    const res = await api.pairSession(serverOverride());
    qr = {
      code: res.code,
      secret: res.sessionSecret,
      expiresAt: res.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 600000,
      poll: null,
      expiryTimer: null,
      busy: false,
    };
    renderQr(res.deepLink || `codingpt://pair?code=${res.code}`);
    connBody.querySelector("#codeText").textContent = res.code;
    qr.poll = setInterval(pollQr, 2500);
    qr.expiryTimer = setTimeout(expireQr, Math.max(1000, qr.expiresAt - Date.now()));
  } catch (e) {
    qrBox.innerHTML = "";
    qrExpired.classList.remove("hidden");
    qrExpired.querySelector("span").textContent = "세션 생성 실패";
  }
}

function stopQr() {
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
  const qrExpired = connBody?.querySelector("#qrExpired");
  if (qrExpired) {
    qrExpired.querySelector("span").textContent = "코드가 만료됐어요";
    qrExpired.classList.remove("hidden");
  }
}
async function pollQr() {
  if (!qr || qr.busy) return;
  qr.busy = true;
  try {
    const res = await api.pairPoll(serverOverride(), qr.code, qr.secret);
    if (res && res.paired) {
      stopQr();
      state.daemon = await api.daemonStatus();
      state.paired = !!state.daemon?.paired;
      await S.loadWorkspaces();
      S.emit();
    }
  } catch (e) {
    expireQr();
  } finally {
    if (qr) qr.busy = false;
  }
}

async function doPair() {
  // 레거시 QR/코드 페어링은 폐기(멀티기기=웹 로그인). UI 미노출 시 안전 종료.
  const codeEl = connBody.querySelector("#codeInput");
  if (!codeEl) return;
  const code = (codeEl.value || "").trim().toUpperCase();
  const server = (connBody.querySelector("#serverInput").value || "").trim();
  const errEl = connBody.querySelector("#pairError");
  errEl.classList.add("hidden");
  if (!code) {
    errEl.textContent = "페어링 코드를 입력하세요.";
    errEl.classList.remove("hidden");
    return;
  }
  const btn = connBody.querySelector("#pairBtn");
  btn.disabled = true;
  btn.textContent = "연결 중…";
  try {
    state.daemon = await api.pair(code, server || null);
    state.paired = !!state.daemon?.paired;
    if (server) {
      try {
        localStorage.setItem("cpt.server", server);
      } catch (_) {}
    }
    await S.loadWorkspaces();
    S.emit();
  } catch (e) {
    errEl.textContent = String(e);
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "코드로 연결";
  }
}

// 딥링크(codingpt-pc://pair?code=)로 프리필 + 자동 연결.
export function deepLinkPair(payload) {
  section = "connection";
  S.setView("settings");
  setTimeout(() => {
    const ci = connBody?.querySelector("#codeInput");
    const si = connBody?.querySelector("#serverInput");
    if (payload?.code && ci) ci.value = String(payload.code).toUpperCase();
    if (payload?.server && si) si.value = String(payload.server);
    if (payload?.code) doPair();
  }, 80);
}
