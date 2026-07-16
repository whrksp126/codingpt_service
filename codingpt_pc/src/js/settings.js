// settings.js — "내 정보 · 설정" 모달. 좌측 탭 사이드바 + 우측 콘텐츠(오버레이).
//  모바일 연결 관리(웹 로그인/상태/해제)를 "계정" 탭에 담는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { getScale, setScale, SCALE_PRESETS } from "./display-scale.js";

let root = null;
let navEl = null;
let contentEl = null;
let connBody = null; // 연결 탭 내부 컨테이너
let autostartChk = null;
let section = "general"; // 'general' | 'connection' | 'about'  — 일반 탭이 기본
let connMode = null; // 'paired' | 'unpaired'
let query = "";
let webLogin = null; // 웹 로그인 폴링 세션

const NAV = [
  { key: "general", label: "일반", icon: "gear" },
  { key: "connection", label: "계정", icon: "user" },
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
      renderDeviceList();
    }
  } else if (section === "general") {
    const me = state.me;
    const initial = me ? (me.nickname || me.email || "U").trim().charAt(0).toUpperCase() : "";
    const avatar = me?.profileImg
      ? `<img class="acct-img" src="${esc(me.profileImg)}" alt="" />`
      : `<span class="acct-initial">${esc(initial)}</span>`;
    const profileHtml = me
      ? `<div class="sm-card2">
          <div class="prof">
            <div class="acct-avatar big">${avatar}</div>
            <div class="prof-main">
              <div class="prof-nick-row">
                <input id="nickInput" class="prof-nick" value="${esc(me.nickname || "")}" placeholder="닉네임" maxlength="40" spellcheck="false" />
                <button id="nickSave" class="btn small">저장</button>
              </div>
              <div class="prof-email">${esc(me.email || "")}</div>
            </div>
          </div>
        </div>`
      : `<div class="sm-card2"><div class="dim" style="font-size:13px">로그인하면 프로필이 표시됩니다.</div></div>`;
    contentEl.innerHTML = `
      <div class="sm-h">일반</div>
      ${profileHtml}
      <div class="sm-card2">
        <label class="switch"><input id="autostartChk" type="checkbox" /><span>이 Mac 로그인 시 자동 실행</span></label>
        <div class="sett-row"><span>테마</span><span class="dim">다크</span></div>
        <div class="sett-row"><span>터미널·에디터 배율</span><span class="scale-seg" id="scaleSeg">${SCALE_PRESETS.map((p) =>
          `<button class="scale-opt${p === getScale() ? " active" : ""}" data-scale="${p}">${p === 1 ? "1×" : p + "×"}</button>`).join("")}</span></div>
        <div class="sett-hint">이 기기에서 터미널과 코드 에디터의 글자 크기에만 적용돼요. 작게 하면 더 넓게 보여요.</div>
      </div>`;
    contentEl.querySelectorAll("#scaleSeg .scale-opt").forEach((b) =>
      b.addEventListener("click", () => {
        setScale(parseFloat(b.dataset.scale)); // 열린 터미널/에디터 즉시 반영(pane.js 구독)
        contentEl.querySelectorAll("#scaleSeg .scale-opt").forEach((x) => x.classList.toggle("active", x === b));
      }));
    autostartChk = contentEl.querySelector("#autostartChk");
    autostartChk.addEventListener("change", async () => {
      try {
        await (autostartChk.checked ? api.autostartEnable() : api.autostartDisable());
      } catch (_) {
        autostartChk.checked = !autostartChk.checked;
      }
    });
    syncAutostart();
    bindNickname();
    if (state.paired && !state.me) S.loadMe(); // 프로필 지연 로드 → emit 후 재렌더
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
  const holder = connBody.querySelector("#acctCard");
  if (holder) { holder.innerHTML = html; return; }
  const card = connBody.querySelector(".acct-card");
  if (!card) connBody.insertAdjacentHTML("afterbegin", html);
  else card.outerHTML = html;
}

// ── 로그인됨: 계정 + 이 기기 상태 + 내 기기 목록 ──
function buildPaired() {
  stopWebLogin();
  connBody.innerHTML = `
    <div class="acct-line">
      <div class="acct-line-txt">모든 기기에서 로그아웃</div>
      <button id="unpairBtn" class="btn small">로그아웃</button>
    </div>
    <div class="acct-line">
      <div class="acct-line-txt">회원 탈퇴 시 계정과 모든 데이터가 삭제되며 되돌릴 수 없습니다.</div>
      <button id="deleteAcctBtn" class="btn small danger">회원 탈퇴</button>
    </div>
    <div id="acctMsg" class="acct-msg"></div>
    <div class="dev-section">
      <div class="dev-title">내 기기</div>
      <div id="deviceTable" class="dev-table"></div>
    </div>`;
  bindUnpair(connBody.querySelector("#unpairBtn"));
  connBody.querySelector("#deleteAcctBtn").addEventListener("click", onDeleteAccount);
  renderDeviceList();
  if (!state.me) S.loadMe(); // 프로필 지연 로드
  S.loadDevices(); // 기기 목록/온라인 상태 최신화
}

// 닉네임 저장(일반 탭 프로필).
function bindNickname() {
  const save = contentEl?.querySelector("#nickSave");
  const input = contentEl?.querySelector("#nickInput");
  if (!save || !input) return;
  const commit = async () => {
    const v = (input.value || "").trim();
    if (!v || v === (state.me?.nickname || "")) return;
    save.disabled = true;
    const prev = save.textContent;
    save.textContent = "저장 중…";
    try { await api.updateNickname(v); await S.loadMe(); }
    catch (_) { save.disabled = false; save.textContent = prev; }
  };
  save.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
}

// 회원 탈퇴 — 인라인 2단계 확인(파괴적).
let acctDeleting = false;
async function onDeleteAccount() {
  const btn = connBody?.querySelector("#deleteAcctBtn");
  const msg = connBody?.querySelector("#acctMsg");
  if (!btn) return;
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = "1";
    btn.textContent = "정말 탈퇴하시겠어요?";
    if (msg) { msg.textContent = "한 번 더 누르면 계정이 영구 삭제됩니다."; msg.classList.add("warn"); }
    setTimeout(() => { if (btn.dataset.confirm) { delete btn.dataset.confirm; btn.textContent = "회원 탈퇴"; if (msg) { msg.textContent = ""; msg.classList.remove("warn"); } } }, 4000);
    return;
  }
  if (acctDeleting) return;
  acctDeleting = true;
  delete btn.dataset.confirm;
  btn.disabled = true;
  btn.textContent = "탈퇴 중…";
  try {
    await api.deleteAccount();
    await api.unpair().catch(() => {}); // 로컬 자격 정리 → 로그아웃 상태로
    state.me = null;
    state.devices = [];
    connMode = null;
    state.daemon = await api.daemonStatus().catch(() => state.daemon);
    state.paired = !!state.daemon?.paired;
    S.emit();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "회원 탈퇴";
    if (msg) { msg.textContent = "탈퇴 실패: " + e; msg.classList.add("warn"); }
  }
  acctDeleting = false;
}

// 날짜 포맷 — "2026년 7월 3일".
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// "내 기기" 목록 렌더(state.devices). 클라우드 호스트 포함.
// 기기 아래 작은 텍스트 = 운영체제(정확히). 위 텍스트는 기기명(d.name).
function deviceOsLabel(d) {
  if (d.runnerKind === "cloud") return "Linux"; // 클라우드 러너 = Linux 컨테이너
  const p = String(d.platform || "").toLowerCase();
  if (p === "darwin") return "macOS";
  if (p === "win32" || p === "windows") return "Windows";
  if (p === "linux") return "Linux";
  if (p === "ios" || p === "ipados") return /iphone/i.test(d.name || "") ? "iOS" : "iPadOS";
  if (p === "android") return "Android";
  return d.role === "controller" ? "모바일" : "기기";
}
function renderDeviceList() {
  const el = connBody?.querySelector("#deviceTable");
  if (!el) return;
  if (!state.devices.length) { el.innerHTML = `<div class="dim" style="font-size:12px;padding:10px">불러오는 중…</div>`; return; }
  const head = `<div class="dev-tr dev-th"><span class="dc-name">기기</span><span class="dc-os">운영체제</span><span class="dc-loc">위치</span><span class="dc-date">등록됨</span><span class="dc-act"></span></div>`;
  const rows = state.devices.map((d) => {
    const cur = d.isCurrent ? `<span class="dev-badge cur">이 기기</span>` : "";
    const icon = d.runnerKind === "cloud"
      ? icons.cloud({ size: 15 })
      : d.role === "controller"
        ? icons.smartphone({ size: 15 })
        : icons.monitor({ size: 15 });
    const canRevoke = d.runnerKind !== "cloud" && typeof d.id === "number";
    const act = canRevoke ? `<button class="dev-menu-btn" data-dev="${d.id}" title="더보기">${icons.dots({ size: 16 })}</button>` : "";
    return `<div class="dev-tr">
      <span class="dc-name"><span class="dev-ic">${icon}</span><span class="dc-nm">${esc(d.name)}</span>${cur}<span class="dev-dot ${d.online ? "on" : "off"}" title="${d.online ? "온라인" : "오프라인"}"></span></span>
      <span class="dc-os">${esc(deviceOsLabel(d))}</span>
      <span class="dc-loc">—</span>
      <span class="dc-date">${esc(fmtDate(d.createdAt))}</span>
      <span class="dc-act">${act}</span>
    </div>`;
  }).join("");
  el.innerHTML = head + rows;
  el.querySelectorAll(".dev-menu-btn").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); showDeviceMenu(e, Number(b.dataset.dev)); }));
}

// 기기 행 "..." 드롭다운(기기 삭제).
let devMenuEl = null;
function closeDevMenu() {
  if (devMenuEl) { devMenuEl.remove(); devMenuEl = null; }
  document.removeEventListener("mousedown", onDevMenuOutside, true);
}
function onDevMenuOutside(ev) { if (devMenuEl && !devMenuEl.contains(ev.target)) closeDevMenu(); }
function showDeviceMenu(e, deviceId) {
  closeDevMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const del = document.createElement("button");
  del.className = "ctx-item danger";
  del.innerHTML = `<span class="ctx-ic">${icons.trash({ size: 15 })}</span><span class="ctx-label">기기 삭제</span>`;
  del.addEventListener("click", async () => {
    closeDevMenu();
    try { await api.revokeDevice(deviceId); await S.loadDevices(); } catch (_) {}
  });
  menu.appendChild(del);
  document.body.appendChild(menu);
  devMenuEl = menu;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = e.clientX, y = e.clientY;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
  setTimeout(() => document.addEventListener("mousedown", onDevMenuOutside, true), 0);
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
    btn.textContent = "로그아웃";
    btn.classList.remove("danger");
  };
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = "다시 클릭";
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
