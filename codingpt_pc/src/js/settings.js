// settings.js — "내 정보 · 설정" 모달. 좌측 탭 사이드바 + 우측 콘텐츠(오버레이).
//  모바일 연결 관리(웹 로그인/상태/해제)를 "계정" 탭에 담는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { ANDROID_QR, IOS_QR } from "./store-qr.js";
import {
  // (개정 6: approveDevice/denyDevice 는 더 이상 이 화면의 일이 아니다 — device-approval.js·notifications.js)
  e2ee, e2eeReady, refreshE2ee,
  revokeTrust, e2eeStateLabel, e2eeNeedsBootstrap, e2eePendingApprovable, nudgeDevice,
} from "./e2ee.js";
import { hostE2eeEpoch, hostLockLabel, isHostRow } from "./host-lock.js";
import { renderAgentList, loadAgents, closeAgentPanels } from "./agents-view.js";
import { markPermGranted, permGranted } from "./login-gate.js";
// 안전 코드 칩·요청번호·경고 = 승인 카드(device-approval.js)와 공유하는 조각(e2ee-card.js).
import { safetyChips, requestNo, waitNoSafetyWarn } from "./e2ee-card.js";
import {
  getThemeMode, setThemeMode, getUiFont, setUiFont, getMonoFont, setMonoFont,
  uiFontOptions, monoFontOptions, getTermStyle, setTermStyle,
  TERM_STYLE_OPTIONS, termStylePalette, resolvedTheme,
} from "./theme.js";

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
  { key: "agents", label: "에이전트", icon: "tools" },
  { key: "connection", label: "계정", icon: "user" },
  { key: "about", label: "정보", icon: "monitor" },
];

export function mountSettings(container) {
  root = container;
  root.className = "settings-modal hidden";
  root.innerHTML = `
    <div class="sm-backdrop" id="smBackdrop"></div>
    <div class="sm-card" role="dialog" aria-modal="true" tabindex="-1">
      <aside class="sm-nav">
        <div class="sm-search">
          <span class="sm-search-ic">${icons.search({ size: 15 })}</span>
          <input class="sm-search-input" id="smSearch" placeholder="검색" />
        </div>
        <div class="sm-navgroup">설정</div>
        <div class="sm-navlist" id="smNav"></div>
      </aside>
      <div class="sm-main">
        <div class="sm-head">
          <div class="sm-head-title" id="smTitle"></div>
          <button class="sm-close" id="smClose" title="닫기">${icons.x({ size: 18 })}</button>
        </div>
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
    closeAgentPanels();   // 설치 패널의 xterm/PTY 스트림 정리(닫힌 화면이 스트림을 붙들지 않게)
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
  // 메인 영역 상단 헤더의 제목을 현재 섹션으로(사이드바 말고 메인에 명확히 구분된 헤더).
  const titleEl = root && root.querySelector("#smTitle");
  if (titleEl) titleEl.textContent = (NAV.find((n) => n.key === section) || {}).label || "";
  if (section === "connection") {
    if (force || connMode === null || !contentEl.querySelector("#connBody")) {
      contentEl.innerHTML = `
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
      ensureAccountCard(); // 프로필 지연 로드 반영(닉네임 재바인딩 포함)
      renderE2ee();        // 기기 목록 + 암호화 상태(한 섹션 — 2026-07-27 통합)
    }
  } else if (section === "agents") {
    // 이 PC 의 AI CLI 목록. 데몬 감지가 정본이라 화면은 그 결과를 그대로 비춘다(추측 표기 금지).
    if (force || !contentEl.querySelector("#agentsBody")) {
      // 하단 요약/설명 문단은 사용자 확정으로 제거(2026-07-27) — 목록만 둔다.
      contentEl.innerHTML = `
        <div class="sm-card2">
          <div class="sett-col"><span>이 PC의 AI 에이전트</span><div id="agentsBody" class="ag-list"></div></div>
        </div>`;
      const body = contentEl.querySelector("#agentsBody");
      const paint = () => renderAgentList(body, { onChange: paint });
      paint();
      loadAgents(true).then(paint).catch((e) => {
        body.innerHTML = `<div class="ag-err"></div>`;
        body.firstChild.textContent = String(e && e.message ? e.message : e);
      });
    }
  } else if (section === "general") {
    contentEl.innerHTML = `
      <div class="sm-card2">
        <div class="sett-row"><span>이 Mac 로그인 시 자동 실행</span><input id="autostartChk" type="checkbox" class="tgl" /></div>
      </div>
      <div class="sm-card2">
        <div class="sett-row"><span>테마</span>
          <span class="scale-seg seg-ic" id="themeSeg">
            <button class="scale-opt" data-v="system" title="시스템" aria-label="시스템">${icons.monitor({ size: 15 })}</button>
            <button class="scale-opt" data-v="light" title="라이트" aria-label="라이트">${icons.sun({ size: 15 })}</button>
            <button class="scale-opt" data-v="dark" title="다크" aria-label="다크">${icons.moon({ size: 15 })}</button>
          </span>
        </div>
        <div class="sett-row"><span>인터페이스 글꼴</span><div class="fd" id="uiFontDd"></div></div>
        <div class="sett-row"><span>코드·터미널 글꼴</span><div class="fd" id="monoFontDd"></div></div>
        <div class="sett-col"><span>터미널 스타일</span><div class="ts-grid" id="termStyleGrid"></div></div>
        <div class="sett-hint">글꼴·터미널 스타일은 계정의 모든 기기(PC·모바일)에 함께 적용돼요. 터미널 스타일은 앱 테마(다크/라이트)에 맞는 변형이 자동 선택돼요.</div>
      </div>
      <div class="sm-card2">
        ${folderPermRow("downloads", "다운로드 폴더 접근")}
        ${folderPermRow("desktop", "데스크탑 폴더 접근")}
        ${folderPermRow("documents", "문서 폴더 접근")}
        <div class="sett-hint">한 번 허용하면 모든 워크스페이스에 적용돼요</div>
      </div>
      `;
    // 작업 스냅샷(자동 체크포인트) 카드는 MVP 범위 제외로 잠정 숨김(2026-07-21 결정) —
    //  엔진(auto-checkpoint.js·데몬 sync·back)은 보존, 복원 시 이전 커밋에서 카드+바인딩 복원.
    bindFolderPerms(contentEl);
    bindAppearance(contentEl);
    autostartChk = contentEl.querySelector("#autostartChk");
    autostartChk.addEventListener("change", async () => {
      try {
        await (autostartChk.checked ? api.autostartEnable() : api.autostartDisable());
      } catch (_) {
        autostartChk.checked = !autostartChk.checked;
      }
    });
    syncAutostart();
    if (state.paired && !state.me) S.loadMe(); // 프로필 지연 로드(계정 탭 프로필 카드용)
  } else {
    // force 이거나 미구성일 때만 재구성 — emit(리컨실러 등)마다 통째 리렌더하면
    // 업데이트 진행 상태("새 버전 N"/"다운로드 %")가 몇 초마다 초기화되는 버그가 된다.
    if (!force && contentEl.querySelector("#updBtn")) return;
    contentEl.innerHTML = `
      <div class="sm-card2">
        <div class="qr-head">휴대폰·태블릿에서 이어서 작업하기</div>
        <div class="qr-sub">코드는 이 PC에서 실행하고, 화면은 폰·태블릿에서 이어받아요. 아래 QR을 휴대폰 카메라로 스캔하면 앱 설치 페이지로 바로 이동해요.</div>
        <div class="qr-row">
          <div class="qr-tile">
            <div class="qr-imgwrap"><img class="qr-img" src="${ANDROID_QR}" alt="Android 앱 설치 QR" draggable="false"></div>
            <div class="qr-plat">${icons.smartphone({ size: 15 })}<span>Android</span></div>
          </div>
          <!-- iOS 는 App Store 심사 통과(2026-07-27) → '준비 중' 자리표시를 실제 QR 로 교체.
               두 타일은 같은 규격이어야 한다(한쪽만 자리표시였을 때 폭이 달라 줄이 어긋났다). -->
          <div class="qr-tile">
            <div class="qr-imgwrap"><img class="qr-img" src="${IOS_QR}" alt="iOS 앱 설치 QR" draggable="false"></div>
            <div class="qr-plat">${icons.smartphone({ size: 15 })}<span>iOS</span></div>
          </div>
        </div>
      </div>
      <div class="sm-card2">
        <div class="sett-row"><span>버전</span><span class="dim" id="appVerLabel">CodingPT PC …</span></div>
        <div class="sett-row"><span>업데이트</span>
          <span style="display:inline-flex;align-items:center;gap:14px;">
            <span class="dim" id="updStatus" style="min-width:76px;text-align:right;">-</span>
            <button class="sett-btn" id="updBtn">확인</button>
          </span>
        </div>
      </div>`;
    // 실제 앱 버전으로 채움(하드코딩 금지 — 업데이트되면 자동 반영). 실패해도 조용히(dev 등).
    api.appVersion().then((v) => { const el = contentEl.querySelector("#appVerLabel"); if (el && v) el.textContent = `CodingPT PC ${v}`; }).catch(() => {});
    bindUpdate();
  }
}

// ── 자동 업데이트 — 정보 열리면 자동 확인. 새 버전 있으면 [업데이트] 버튼(클릭=다운로드/설치),
//    없으면 "최신 버전입니다"(클릭 불필요). ──
function bindUpdate() {
  const btn = contentEl.querySelector("#updBtn");
  const st = contentEl.querySelector("#updStatus");
  if (!btn || !st) return;

  // 다운로드+설치(업데이트 버튼 클릭). 진행률은 버튼에만 [ n% ] 하나로.
  const doInstall = async () => {
    btn.disabled = true;
    st.textContent = "";
    btn.textContent = "0%";
    try {
      const un = await api.onUpdateProgress((p) => {
        if (!p) return;
        // chunk = 누적 바이트(Rust에서 델타 누적). total 있으면 %, 없으면 받은 MB 로라도 진행 표시.
        if (p.total) btn.textContent = `${Math.min(100, Math.round((p.chunk / p.total) * 100))}%`;
        else if (p.chunk) btn.textContent = `${(p.chunk / 1048576).toFixed(1)}MB`;
      });
      await api.updateInstall(); // 성공 시 앱이 재시작되므로 이후 코드는 실행 안 될 수 있음
      un?.();
    } catch (e) {
      st.textContent = "실패: " + e;
      btn.disabled = false;
      btn.textContent = "업데이트";
    }
  };

  // 열릴 때 자동 확인 — 버튼은 새 버전이 있을 때만 노출.
  btn.style.display = "none";
  st.textContent = "확인 중…";
  api
    .updateCheck()
    .then((r) => {
      if (r && r.available) {
        st.textContent = "";
        btn.textContent = "업데이트";
        btn.style.display = "";
        btn.onclick = doInstall;
      } else {
        st.textContent = r && r.error ? "확인 불가(개발 실행에선 미지원)" : "최신 버전입니다";
      }
    })
    .catch(() => {
      st.textContent = "확인 실패";
    });
}

// ── 모양(테마·글꼴·터미널 스타일) — theme.js 바인딩. 글꼴은 미리보기 드롭다운,
//    터미널 스타일은 실제 팔레트로 그린 미니 터미널 카드(라디오)로 고른다. ──
function bindAppearance(rootEl) {
  const seg = rootEl.querySelector("#themeSeg");
  const paintSeg = () => {
    const cur = getThemeMode();
    seg?.querySelectorAll(".scale-opt").forEach((b) => b.classList.toggle("active", b.dataset.v === cur));
  };
  if (seg) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest(".scale-opt");
      if (!b) return;
      setThemeMode(b.dataset.v);
      paintSeg();
      paintStyleGrid(); // 테마 변형(다크/라이트)이 바뀌므로 미리보기 다시
    });
    paintSeg();
  }

  // 글꼴 미리보기 드롭다운 — 옵션을 실제 그 글꼴로 렌더 + 샘플 문구.
  const buildFontDd = (host, opts, getCur, onPick, sample) => {
    if (!host) return;
    host.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "fd-btn";
    const menu = document.createElement("div");
    menu.className = "fd-menu hidden";
    const paintBtn = () => {
      const cur = opts.find((o) => o.value === getCur()) || opts[0];
      btn.innerHTML = `<span style="font-family:${cur.stack.replace(/"/g, "&quot;")}">${esc(cur.label)}</span><span class="fd-caret">▾</span>`;
      menu.querySelectorAll(".fd-opt").forEach((el) => el.classList.toggle("sel", el.dataset.v === getCur()));
    };
    for (const o of opts) {
      const it = document.createElement("button");
      it.className = "fd-opt";
      it.dataset.v = o.value;
      it.style.fontFamily = o.stack;
      it.innerHTML = `<span class="fd-name">${esc(o.label)}</span><span class="fd-sample">${esc(sample)}</span>`;
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(o.value);
        menu.classList.add("hidden");
        paintBtn();
      });
      menu.appendChild(it);
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 다른 드롭다운은 먼저 닫는다(하나만 열림 — 겹침 방지).
      document.querySelectorAll(".fd-menu").forEach((m) => { if (m !== menu) m.classList.add("hidden"); });
      // 열 때 내장 웹폰트 로드 트리거(lazy) — 옵션이 폴백 글꼴로 보이지 않게
      try { opts.forEach((o) => document.fonts?.load?.(`13px ${o.stack}`)); } catch (_) {}
      menu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => menu.classList.add("hidden"));
    host.append(btn, menu);
    paintBtn();
    host._repaint = paintBtn;
  };
  buildFontDd(rootEl.querySelector("#uiFontDd"), uiFontOptions(), getUiFont, setUiFont, "한글과 English 123");
  buildFontDd(rootEl.querySelector("#monoFontDd"), monoFontOptions(), getMonoFont, setMonoFont, "const 한글 = i => 0;");

  // 터미널 스타일 카드(라디오) — 실제 팔레트로 "진짜 터미널에 보이는 모습"(파워라인 프롬프트·claude·diff)을
  //  그려 미리보기. 세그먼트 글자색은 배경 밝기에 따라 자동(실제 xterm 의 최소 대비 보정과 동일한 결).
  const grid = rootEl.querySelector("#termStyleGrid");
  const lum = (hex) => {
    const m = /^#?([0-9a-f]{6})/i.exec(hex || "");
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  const onColor = (bg) => (lum(bg) < 150 ? "#F4F6FA" : "#15181E");
  const paintStyleGrid = () => {
    if (!grid) return;
    const variant = resolvedTheme();
    grid.innerHTML = "";
    for (const o of TERM_STYLE_OPTIONS) {
      const p = termStylePalette(o.value, variant);
      const seg1 = "#3A4150"; // p10k 기본 세그먼트(256색 회색) — 실제 프롬프트가 쓰는 색을 그대로 재현
      const seg2 = p.blue || "#61AFEF";
      const card = document.createElement("button");
      card.className = "ts-card" + (o.value === getTermStyle() ? " sel" : "");
      card.dataset.v = o.value;
      card.innerHTML = `
        <div class="ts-name">${esc(o.label)}</div>
        <div class="ts-prev" style="background:${p.background}">
          <div class="ts-pline">
            <span class="ts-seg" style="background:${seg1};color:${onColor(seg1)}">user@mac</span><span class="ts-tri" style="border-left-color:${seg1};background:${seg2}"></span><span class="ts-seg" style="background:${seg2};color:${onColor(seg2)}">~/project</span><span class="ts-tri" style="border-left-color:${seg2}"></span>
          </div>
          <div class="ts-line" style="color:${p.foreground}">claude&nbsp;<span style="opacity:.75">코드 설명해줘</span></div>
        </div>
        <div class="ts-pick"><span class="ts-radio"></span></div>`;
      card.addEventListener("click", () => {
        setTermStyle(o.value);
        paintStyleGrid();
      });
      grid.appendChild(card);
    }
  };
  paintStyleGrid();
}

async function syncAutostart() {
  try {
    if (autostartChk) autostartChk.checked = await api.autostartEnabled();
  } catch (_) {}
}

// 프로필 카드(로그인된 사용자 · 닉네임 편집 + 이메일). 계정 탭 최상단. state.me 없으면 안내 문구.
function profileCardHtml() {
  const me = state.me;
  if (!me) return `<div class="sm-card2"><div class="dim" style="font-size:13px">로그인하면 프로필이 표시됩니다.</div></div>`;
  const initial = (me.nickname || me.email || "U").trim().charAt(0).toUpperCase();
  const avatar = me.profileImg
    ? `<img class="acct-img" src="${esc(me.profileImg)}" alt="" />`
    : `<span class="acct-initial">${esc(initial)}</span>`;
  return `<div class="sm-card2">
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
    </div>`;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// 프로필 지연 로드 후 계정 탭 프로필 카드 반영(paired 뷰 통째 재빌드 없이) + 닉네임 저장 재바인딩.
function ensureAccountCard() {
  if (!connBody) return;
  const holder = connBody.querySelector("#acctCard");
  if (!holder) return;
  holder.innerHTML = profileCardHtml();
  bindNickname();
}

// ── 로그인됨: 계정 + `기기` 섹션(기기 목록 = 암호화 상태 한 곳) ──
function buildPaired() {
  stopWebLogin();
  connBody.innerHTML = `
    <div id="acctCard">${profileCardHtml()}</div>
    <div class="acct-line">
      <div class="acct-line-txt">이 기기에서 로그아웃</div>
      <button id="unpairBtn" class="btn small">로그아웃</button>
    </div>
    <div class="acct-line">
      <div class="acct-line-txt">회원 탈퇴 시 계정과 모든 데이터가 삭제되며 되돌릴 수 없습니다.</div>
      <button id="deleteAcctBtn" class="btn small danger">회원 탈퇴</button>
    </div>
    <div id="acctMsg" class="acct-msg"></div>
    <div class="dev-section">
      <div style="display:flex;align-items:center;gap:10px;margin:0 2px 8px">
        <div class="dev-title" style="margin:0;flex:1;min-width:0">기기</div>
      </div>
      <div id="e2eeBox" class="sm-card2"></div>
    </div>`;
  bindUnpair(connBody.querySelector("#unpairBtn"));
  connBody.querySelector("#deleteAcctBtn").addEventListener("click", onDeleteAccount);
  bindNickname(); // 프로필 카드 닉네임 저장
  renderE2ee();   // 기기 목록 + 암호화 상태(구 '내 기기' 표는 이 안으로 흡수됐다)
  if (!state.me) S.loadMe(); // 프로필 지연 로드 → emit 시 ensureAccountCard 로 카드 채움
  S.loadDevices(); // 기기 목록/온라인 상태 최신화
  void refreshE2ee(); // 열쇠 상태/대기 목록(데몬 위임) — 실패 시 '미지원'으로 표기만
}

/**
 * 보호 폴더 권한 행 — **이미 허용된 것은 버튼을 그리지 않는다**(2026-07-28 사용자 지적:
 *  "온보딩에서 다 허용하고 넘어왔는데 버튼으로 허용해야 한다는 느낌이거든? 허용됨으로 표현해야").
 *  판정 = 온보딩·이 화면의 프로브 성공 기록(login-gate permGranted, 머신 스코프 localStorage).
 *  ⚠ 여기서 렌더 시점에 프로브를 돌려 실측하지 않는다: 아직 결정 안 된 권한은 프로브가 곧 macOS
 *   팝업이라, 설정을 열기만 해도 팝업 3개가 뜬다(사용자가 요청하지 않은 프롬프트 = 금지).
 *   기록이 없지만 실제로 허용된 경우(구버전에서 이미 허용)는 [허용] 을 한 번 누르면 팝업 없이
 *   즉시 '허용됨' 으로 바뀐다 — 기록이 없는 것이 손해가 아니다.
 */
function folderPermRow(id, label) {
  if (permGranted(id)) {
    return `<div class="sett-row"><span>${label}</span><span class="sett-done">${icons.check({ size: 14 })}허용됨</span></div>`;
  }
  return `<div class="sett-row"><span>${label}</span><button class="sett-btn fpa-btn" data-f="${id}">허용</button></div>`;
}

// 보호 폴더(다운로드/데스크탑/문서) 접근 허용 — 클릭 시 프로브(최초엔 macOS 팝업).
//  허용=버튼 '허용됨' 고정, 거부=버튼이 '설정 열기'(파일 및 폴더 설정)로 전환.
function bindFolderPerms(rootEl) {
  rootEl.querySelectorAll(".fpa-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.dataset.denied) { api.openFilesPrivacy().catch(() => {}); return; }
      b.disabled = true;
      const prev = b.textContent;
      b.textContent = "확인 중…";
      try {
        const ok = await api.probeFolder(b.dataset.f);
        // 성공은 로컬에도 기록한다 — 온보딩(login-gate)이 "없는 권한만" 행으로 그리는 판정 근거.
        if (ok) {
          markPermGranted(b.dataset.f);
          // 버튼을 남겨 두면 '허용됨' 이 여전히 눌러야 하는 것처럼 보인다 → 표기로 교체(folderPermRow 와 같은 모양).
          b.outerHTML = `<span class="sett-done">${icons.check({ size: 14 })}허용됨</span>`;
          return;
        }
        b.dataset.denied = "1";
        b.textContent = "설정 열기";
        b.disabled = false;
      } catch (_) { b.textContent = prev; b.disabled = false; }
    });
  });
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

// 회원 탈퇴 — "회원탈퇴" 문구 입력 확인(파괴적 작업 가드, 모바일과 동일 스펙).
//  1탭: 확인 영역(문구 입력 + 영구 삭제) 펼침 → "회원탈퇴" 를 정확히 입력할 때만 실행.
const DELETE_CONFIRM_WORD = "회원탈퇴";
let acctDeleting = false;
async function onDeleteAccount() {
  const btn = connBody?.querySelector("#deleteAcctBtn");
  const msg = connBody?.querySelector("#acctMsg");
  if (!btn || !msg) return;
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = "1";
    btn.textContent = "취소";
    btn.classList.remove("danger");
    msg.classList.add("warn");
    msg.innerHTML = `
      <div class="acct-del-confirm">
        <div>계속하려면 <b>${DELETE_CONFIRM_WORD}</b> 를 입력하세요.</div>
        <input id="acctDelEmail" class="acct-del-input" placeholder="${DELETE_CONFIRM_WORD}" autocomplete="off" spellcheck="false" />
        <button id="acctDelGo" class="acct-del-go">
          <span class="acct-del-spin"></span><span class="acct-del-go-txt">영구 삭제</span>
        </button>
        <div id="acctDelErr" class="acct-del-err"></div>
      </div>`;
    const input = msg.querySelector("#acctDelEmail");
    const go = msg.querySelector("#acctDelGo");
    // 시각적 활성(빨간 버튼)만 토글 — 클릭 차단은 disabled 로 하지 않는다(한글 IME 확정이 첫 클릭과
    //  겹쳐 첫 클릭이 무시되던 문제 회피). 실제 실행 여부는 doDeleteAccount 가 클릭 시점 최신 값으로 판정.
    const syncMatch = () => go.classList.toggle("match", input.value.trim() === DELETE_CONFIRM_WORD);
    input.addEventListener("input", syncMatch);
    input.addEventListener("compositionend", syncMatch); // 한글 IME 확정 시 반영
    go.addEventListener("click", () => doDeleteAccount(btn, go, msg));
    input.focus();
    return;
  }
  // confirm 상태에서 버튼(=취소) 클릭 — 접기.
  delete btn.dataset.confirm;
  btn.textContent = "회원 탈퇴";
  btn.classList.add("danger");
  msg.textContent = "";
  msg.classList.remove("warn");
}

async function doDeleteAccount(btn, go, msg) {
  if (acctDeleting) return;
  // 클릭 시점에 최신 입력값으로 판정(IME 확정 후) — 문구 불일치면 조용히 무시. 첫 클릭에 바로 반응.
  const inputEl = msg?.querySelector("#acctDelEmail");
  if (!inputEl || inputEl.value.trim() !== DELETE_CONFIRM_WORD) {
    if (go) go.classList.toggle("match", (inputEl?.value.trim() || "") === DELETE_CONFIRM_WORD);
    return;
  }
  acctDeleting = true;
  // 스피너·"탈퇴 처리 중…"은 "영구 삭제" 버튼에(모바일과 동일). 취소 버튼도 잠금(중복/취소 방지).
  const goTxt = go?.querySelector(".acct-del-go-txt");
  const errEl = msg?.querySelector("#acctDelErr");
  if (go) { go.disabled = true; go.classList.add("deleting"); }
  if (goTxt) goTxt.textContent = "탈퇴 처리 중…";
  if (btn) btn.disabled = true;
  if (errEl) errEl.textContent = "";
  // 스피너가 반드시 한 프레임 그려진 뒤 네트워크 작업 시작 — 빠른 완료/즉시 재렌더로 프로그래스가 안 보이던 문제 방지.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const _t0 = Date.now();
  try {
    await api.deleteAccount();
    await api.unpair().catch(() => {}); // 로컬 자격 정리 → 로그아웃 상태로
    state.me = null;
    state.devices = [];
    connMode = null;
    // ★ 설정 모달을 닫는다(2026-07-28 실사고: 재가입 로그인 후 게이트가 걷히자 탈퇴 직전에 열려
    //  있던 설정 모달이 그대로 다시 나타났다 — 새 계정은 기본 화면에서 시작해야 한다).
    S.setView("workspace");
    state.daemon = await api.daemonStatus().catch(() => state.daemon);
    state.paired = !!state.daemon?.paired;
    const _elapsed = Date.now() - _t0; // 프로그래스 최소 노출(빠른 완료에도 스피너가 잠깐 보이게)
    if (_elapsed < 500) await new Promise((r) => setTimeout(r, 500 - _elapsed));
    S.emit();
  } catch (e) {
    if (go) { go.disabled = false; go.classList.remove("deleting"); }
    if (goTxt) goTxt.textContent = "영구 삭제";
    if (btn) btn.disabled = false;
    if (errEl) errEl.textContent = "탈퇴 실패: " + (e?.message || e);
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

// 최근 작업 시각 — 가까울수록 상대 표기(방금/분/시간), 하루 넘으면 날짜(모바일 fmtRecent 미러).
function fmtRecent(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return fmtDate(iso);
}

// 기기 행의 부제용 라벨(운영체제) — `기기` 섹션(e2eeDeviceRowsHtml)이 쓴다.
//  구 '내 기기' 표는 2026-07-27 통합으로 사라졌지만 이 라벨 규칙은 그 행에서 계속 쓰인다.
// ── `기기` 섹션 — 모바일 E2eeSettingsCard/DeviceTrustCard 와 **동일 계층·동일 문구** ──
//  문구·구조 정본 = docs/구현설계-2026-07-25/14-설정-카피-감사.md (§3 구조 · §4 확정 문구 표).
//  ★ 2026-07-27 개정 2(사용자 요구): 구 '종단간 암호화' 카드와 구 '내 기기' 표를 **한 섹션으로 합쳤다**.
//   암호화 카드 안 '열쇠를 가진 기기' 목록 + 그 아래 '내 기기' 표 = 같은 기기가 한 화면에 두 번 나왔다.
//   열쇠 보유·암호화 여부는 기기의 속성이므로 **기기 행이 단일 진실**이고 목록은 하나뿐이어야 한다.
//  첫 화면(스크롤 없음, 설명문 0줄 — ★ 개정 4 로 접기 섹션 없이 이것이 전부다):
//    [섹션 제목 행] 기기 ......................... [self 배지 = 계정 열쇠 상태]
//    ⚠ 행동 행 — **동시 1개만**: 새 기기 N대 승인(펼치면 그 자리에서 대조·승인) > 기존 기기에서 승인해
//      주세요 > 준비 중 1줄(자동 부트스트랩 — e2ee.js maybeAutoBootstrap 이 켠다, 버튼 없음)
//    (배지 톤이 on 이 아니고 행동 행이 없을 때만) reason 1줄(2줄 클램프)
//    기기 행: [아이콘] 이름 [이 기기] · {최근 작업} .......... [🗑]
//    (온라인 PC 0대일 때) 🖥 연결된 PC 없음 ....... [확인 중]   ← §2.7 정직성 기제. **절대 접지 않는다**
//  ★ 개정 4(2026-07-27 사용자 확정, 카피 감사 §3 개정 4 블록이 정본): 접기 섹션·수동 켜기 버튼·정책
//    세그(자동 고정)·안전 코드 상시 행·복구 UI·메타 고지·행 메타 지문을 전부 삭제했다. 문자열 부재는
//    test/contract.mjs ① 이 고정한다.
//  ★ 암호화 배지는 **그 기기의 실제 상태**다: 근거(runner_status.e2eeEpoch)를 가진 **온라인 PC** 행에만
//   그린다(isHostRow = 앱 필터와 동치). 오프라인·모바일 행에는 배지를 그리지 않는다 — 모름을 초록도
//   평문도 아닌 상태로 남기는 유일한 정직한 표시다(배지 도메인 4종은 계약 = '오프라인' 을 새로 만들지
//   않는다). 섹션 헤더 배지(self)는 개별 기기 상태를 덮어쓰지 않는다.
//
//  ★ 문구는 위 문서 §4 표를 **글자까지** 옮긴 것이다(임의 윤문 금지 — 사용자가 폰과 PC 를 나란히 놓고
//    대조하므로 한 글자 차이가 곧 버그다). 라벨 동치는 test/e2ee-crossimpl.mjs §4 가, 삭제한 상시
//    설명문이 되살아나지 않는지는 test/contract.mjs 의 소스 단정이 고정한다.
//  ★ 사람이 대조하는 값은 **60비트 안전 코드**다(계약 §2.10). 4자리는 "요청 번호"로 강등하고 라벨에
//    `· 대조용 아님` 을 붙인다 — 13비트는 서버가 같은 값이 나오는 자기 키쌍을 1코어 1.3초에 찾는다(실측).
//  ★ 표시값은 전부 ikX 에서 **로컬 계산**한 것이다(e2ee.js deriveDisplay). 서버가 준 안전 코드는
//    받지도 그리지도 않는다 — 서버가 이 채널을 위조하는 것을 막는 게 이 UX 의 존재 이유다.
//  ★ 마스터키는 데몬에 있으므로 모든 조작은 e2ee.js → cpt.sock 위임이다(JS 에 MK 없음).
let e2eeMsg = "";
// 접기 상태는 **로컬 플래그**다(state.js 에 넣지 않는다 — 기기 간 동기화 대상이 아니다).
//  리컨실러 emit 마다 renderE2ee 가 다시 도므로 모듈 스코프에 둬야 펼친 상태가 유지된다.
//  (개정 4: `자세히`(e2eeAdvOpen)·복구 1회 표시(e2eeRecoveryShown)는 UI 와 함께 삭제)
// 개정 5: 코드는 요청별로 접혀 있다(enrollmentId 집합 · 'self' = 이 PC 의 대기 화면).
//  '승인됐는지 확인' 버튼은 삭제됐다 — 승인은 WS(resolved) 로 즉시 반영되고 폴링이 보증한다.
const e2eeCodeOpen = new Set();

const TONE_C = { on: "var(--accent)", wait: "var(--warn, #FBBF24)", off: "var(--dim)" };

/**
 * self 배지 — 카드/섹션 제목 행 **우측**에 그린다(앱 카드 헤더와 같은 계층).
 *  ★ 판정은 e2ee-label.js(= e2eeStateLabel)가 정본이다. 여기서 `state` 만 다시 분기하면 데몬이
 *   진행상태 정본으로 주는 keyState/checking 이 화면에 반영되지 않아 "확인 중" 과 "확인 끝났고
 *   열쇠 0개(영구 평문)" 가 같은 대기색으로 보인다(둘 다 state='bootstrap' 이다).
 *  ⚠ '켜짐' 이라고 쓰지 않는다: 이 PC 의 열쇠 보유는 트래픽이 암호화된다는 뜻이 아니다(상대 호스트도
 *   열쇠가 있어야 한다) — 그게 거짓 자물쇠의 근원이었다. 실제 자물쇠는 PC 별 배지가 그린다.
 */
/** 이 PC 가 승인을 기다리는 중인가 — 판정 정본은 keyState(state 확장값은 방어적으로 함께 본다). */
function e2eeSelfWaiting() {
  return e2ee.keyState === "pending" || e2ee.keyState === "enrolled"
    || e2ee.state === "pending" || e2ee.state === "enrolled";
}
// (★ 개정 6, 2026-07-28 사용자 확정: **승인 카드는 이 파일에서 사라졌다** — 원문 "기기 목록 안에서
//  새 기기 승인을 처리하는 게 이상하지 않니? 승인하는 건 일시적으로 나타나는 거니까 나눠야 할 것
//  같은데?" · "승인 같은 건 설정>계정에서 하려고 하지 말고 별도의 알림에서 바로 승인 … 구글에서
//  다른 기기로 로그인했을 때 승인된 기기에서 알림이 뜨는 것처럼".
//  승인 표면 2곳 = `device-approval.js`(화면 상단 전역 카드) · `notifications.js`(알림 행 인라인).
//  개정 5 의 카드 구성(제목·본인 확인 질문·접힌 `코드 확인`)은 그 파일로 **그대로** 옮겨졌다.
//  이 화면(설정 > 계정 > 기기)이 남겨 갖는 것은 **연동 상태 관리**뿐이다: 누가 연동됐는지 · [연동]
//  버튼으로 요청 재발송 · 기기 삭제. 승인 버튼을 여기 되살리면 두 표면이 같은 사건을 두 군데서
//  처리하게 되고(어느 쪽을 눌러야 하나) 사용자가 지적한 그 구조로 되돌아간다.)

/**
 * 행동 행 — **동시에 하나만** 그린다(우선순위 = 승인 > 자기 대기 > 부트스트랩).
 *  ⚠ 경고 삼각형(⚠)은 쓰지 않는다: PC 아이콘 규약상 "오류"로 읽힌다(icons.js:52) → 방패+체크.
 *  ★ 2026-07-27 개정 3: 이 행들도 **표의 행**(`<tr>`)이다 — 기기 목록 맨 위에 들어간다. 예전에는
 *   각자 `.dev-row` 카드였고 그 카드가 섹션 카드(sm-card2) 안에 또 있어서 "카드 안에 카드" 였다
 *   (사용자 지적). 박스는 승인 카드(펼침 영역) 하나만 남긴다 = `.appr-card`.
 *  ⚠ 반환 문자열은 `<tr>` 이어야 한다(renderE2ee 가 `<table class="dev-tbl">` 안에 넣는다) — div 를
 *   돌려주면 브라우저가 표 밖으로 끌어올려(foster parenting) 행 정렬이 조용히 깨진다.
 */
function e2eeActionRow(pend) {
  //  ★ 개정 6(2026-07-28 사용자 확정): **승인은 이 화면에서 하지 않는다.** 원문 — "기기 목록 안에서
  //   새 기기 승인을 처리하는 게 이상하지 않니? 승인하는 건 일시적으로 나타나는 거니까! 나눠야 할 것
  //   같은데?" → 승인은 사건 표면(전역 카드 device-approval.js · 알림 행 인라인)으로 옮겼고 여기는
  //   **연동 상태 관리**만 한다. 대기 건이 있으면 그 사실만 한 줄로 알린다(누를 것 없음 — 카드가 뜬다).
  if (pend.length) {
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${icons.shield({ size: 15 })}</span></td>
      <td colspan="3" style="font-size:13px">새 기기 ${pend.length}대가 승인을 기다려요 · 알림에서 승인할 수 있어요</td>
      <td class="dev-c-del"></td>
    </tr>`;
  }
  // 이 PC 가 승인을 기다린다 — 설명문 0줄. 대조는 **기존 기기 화면에서** 하므로 여기엔 지침이 없다.
  //  ★ 안전 코드를 계산할 수 없으면(userRef 미상 → e2ee.js deriveDisplay 가 null) 칩을 **무음으로
  //   생략하지 않는다**: 승인하는 폰은 그 PC 의 ikX 로 안전 코드를 정상 파생해 크게 그리는데(폰은
  //   userRef 를 서버에서 받는다) 이 화면에 아무것도 없으면 사용자는 대조할 값을 찾다 못 찾고 그냥
  //   [승인] 을 누른다 = 사람 눈 대조라는 유일한 MITM 방어가 그 승인에서 통째로 빠진다(§2.10).
  //   그래서 승인 카드와 **같은 3항**을 쓴다(앱 DeviceTrustWaiting 미러). 단 경고 **문구는 다르다**:
  //   이 화면에는 승인 버튼이 없으므로 누르지 말아야 할 곳을 명시한다(waitNoSafetyWarn).
  //  (개정 4: 구 '자세히 → 복구 코드로 복원' 힌트는 복구 UI 와 함께 삭제 — 현 스코프엔 잠긴 저장
  //   데이터가 없어 기기 전손실 = 새 기기에서 자동으로 새 열쇠가 생긴다.)
  if (e2eeSelfWaiting()) {
    const noSafety = !e2ee.safetyCode;
    const open = e2eeCodeOpen.has("self");
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
        <div class="wait-box">
          <span class="wait-spin"></span>
          <div style="min-width:0">
            <div class="wait-title">폰·태블릿에서 승인해 주세요</div>
            <div class="wait-sub">이미 로그인된 기기에 요청을 보냈어요</div>
          </div>
        </div>
        ${noSafety ? waitNoSafetyWarn() : `<button class="appr-reveal" data-e2ee-code="self">코드 확인 ${open ? "▴" : "▾"}</button>`}
        ${open && !noSafety ? `<div class="appr-code">${safetyChips(e2ee.safetyCode, "var(--text)")}${requestNo(e2ee.verifyCode)}</div>` : ""}
      </div>
    </td></tr>`;
  }
  // 계정에 열쇠가 0개 — ★ 개정 4(사용자 확정): 버튼 없이 **이 화면(사람이 보는 앱)이 자동으로 켠다**
  //  (e2ee.js maybeAutoBootstrap). "데몬(헤드리스) 자동 부트스트랩 금지" 원칙은 그대로다 — 주체가
  //  상호작용 표면이면 모바일 앱의 기존 자동 부트스트랩과 같은 등급이다. 여기는 진행/실패 표시만 한다.
  if (e2eeNeedsBootstrap()) {
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div class="acct-msg" style="padding:2px 0">${e2ee.autoBootError ? "암호화를 켜지 못했어요 · 잠시 후 다시 시도합니다" : "암호화를 준비하고 있어요…"}</div>
    </td></tr>`;
  }
  return "";
}

// (★ 개정 4, 2026-07-27 사용자 확정: `자세히` 섹션 전체 삭제 — 카피 감사 §3 개정 4 블록이 정본.
//   ① 정책 [끄기|자동|항상] → **자동 고정**(env 킬스위치 CPT_E2EE=0 은 ops 용 존치, 클라는 정책을
//     저장도 전송도 하지 않는다. 구 UI 로 '끄기/항상' 을 저장한 기기는 normalizeE2eePolicy 가 복원)
//   ② 이 기기 안전 코드 행 → 대조는 승인 카드/자기 대기 행에서만 일어난다(상시 노출 가치 없음)
//   ④ 복구 코드 만들기/복원 → 현 스코프(rpc)엔 암호화로 잠긴 저장 데이터가 없어 지킬 자산이 없다.
//     데몬 RPC e2ee.recovery.* 는 존치(스냅샷 봉인을 켜는 날 UI 만 되살린다)
//   ⑥ 메타데이터 고지 → 문서로 이관)

/** 열쇠를 가진 기기 판정 — '이 기기' 는 **ikX(공개키) 우선**이다(지문은 userRef 미상이면 비어 있다). */
function e2eeKeyIsMine(d) {
  //  지문으로만 보면(deriveDisplay 가드로 빈 값) 자기 행을 남으로 보고 **자기 신뢰 해제 버튼**을 띄운다
  //  = 스스로 잠긴다. ikX 는 그 기준과 무관하게 항상 알고 있다. 지문 비교는 구 데몬 호환으로 남긴다.
  return (!!e2ee.ikX && d.ikX === e2ee.ikX) || (!!e2ee.fingerprint && d.fingerprint === e2ee.fingerprint);
}

/**
 * 기기 목록(= 이 섹션의 본문) — **단일 진실**. 한 행 = 한 기기이고, 그 행이 그 기기에 대한 모든 것을 말한다.
 *  · 암호화 배지: **온라인 PC** 행에만(isHostRow = 앱 필터와 동치). 근거가 없는 행에 배지를 그리면
 *    꺼둔 노트북이 영구 '확인 중'(거짓 진행 신호)이 되고 폰 화면과 색·행 수가 갈라진다.
 *  · 🔒 지문: 그 기기가 계정 열쇠를 갖고 있다는 표시(구 '열쇠를 가진 기기' 목록 흡수).
 *  · 🗑 : 기기 삭제. **열쇠를 가진 기기면 열쇠 해제 + 세대 회전까지** 함께 한다(bindE2ee) — back
 *    `revokeDevice` 는 열쇠를 'revoked' 로 표시하고 rotate_needed 만 팬아웃하므로, 회전 없이 지우면
 *    지운 기기가 이미 가진 MK_epoch 로 이후 트래픽까지 계속 열 수 있다.
 *  · 기기 행이 없는 열쇠(고아)는 마지막에 따로 그린다 — 그러지 않으면 **해제할 방법이 사라진 열쇠**가
 *    계정에 남는다(보안 후퇴).
 *
 * ★ 2026-07-27 개정 3(사용자 요구: "카드 안에 카드 구조인데 그렇게 안햇으면 좋겠어! 차라리 테이블
 *  구조는 어떨까") — 행마다 `.dev-row` 카드를 그리던 구조를 **표**로 바꿨다. 열 = [아이콘]
 *  [기기 이름] [운영체제·최근 작업·지문] [암호화 상태] [삭제], 행 구분은 1px 선 하나뿐이다.
 *  헤더 행은 **두지 않는다**(지난 라운드에 표 헤더 3개를 텍스트 감축으로 지웠다 — 되살리면 그 감축을
 *  되돌린다). 정렬은 <table> 자동 폭이 맞춘다(grid 로 하면 행마다 셀 폭을 다시 계산해 어긋난다).
 *  반환값은 `<tr>` 들의 문자열이다 — 감싸는 `<table>` 은 renderE2ee 가 만든다.
 */
function e2eeDeviceRowsHtml(devs, selfReady) {
  const all = (state.devices || []).filter((d) => d.runnerKind !== "cloud"); // 클라우드 러너는 숨긴다(BYO 피벗)
  // ⚠ 기기 목록이 아직 안 왔으면 **고아 판정을 하지 않는다**: 키링이 먼저 도착하면 모든 열쇠가 '고아' 로
  //  보여 같은 기기가 두 번 뜨는 화면(합치려던 그 중복)이 로딩 중에 재현된다.
  if (!all.length) return `<tr class="dev-tr"><td class="dev-c-full dim" colspan="4" style="font-size:12px">불러오는 중…</td></tr>`;
  const keyByDevice = new Map();
  // 열쇠 보유 판정은 `state === "trusted"` 하나다(앱 trustedKeys 와 같은 조건 — pending/revoked 는 열쇠가 아니다).
  for (const k of devs) if (k.state === "trusted" && k.deviceId != null) keyByDevice.set(String(k.deviceId), k);
  const ids = new Set(all.map((d) => String(d.id)));
  const orphans = devs.filter((k) => k.state === "trusted" && (k.deviceId == null || !ids.has(String(k.deviceId))));

  const rows = all.map((d) => {
    const k = keyByDevice.get(String(d.id));
    // 이 PC 자신은 사이드카 데몬(e2ee.state)이 정본이다 — runner_status 프레임보다 빠르고 정확하다.
    //  ★ 3번째 인자 = 내 열쇠 세대 · 4번째 = 서버가 말하는 계정 세대(자기 행이 항상 초록이던 결함 ③-2).
    // ★ 행별 자물쇠 열('암호화됨'/'평문')은 **표시하지 않는다**(사용자 확정 2026-07-27: 제거 요청).
    //  판정 함수(hostLockLabel)와 그 계약(거짓 자물쇠 금지 · 세대 일치 검사)은 그대로 남는다 —
    //  다시 노출할 때 규칙을 재발명하지 않기 위해서다. 상태는 '자세히' 섹션에서 확인할 수 있다.
    const canRevoke = typeof d.id === "number" && !d.isCurrent;
    // ★ OS 라벨(`macOS ·`)은 제거했다(사용자 확정 2026-07-27): 좌측 아이콘이 이미 PC/모바일을 구분하고,
    //  같은 정보를 글자로 또 쓰면 최근 접속 시각이 뒤로 밀린다.
    // ★ 개정 4: 🔒 지문은 기기 행 메타에서 삭제(사용자가 읽을 수 없는 값) — 열쇠 보유 여부는 🗑 동작
    //  (해제+회전)에만 쓰고 표기하지 않는다. 고아 열쇠 행은 예외(지문이 유일한 식별자다).
    const sub = fmtRecent(d.lastSeenAt || d.createdAt);
    //  ★ 개정 6(2026-07-28 사용자 확정): 기기 행은 **연동 여부**를 말한다 — "기기 목록은 뜨지만 연동
    //   승인 절차를 완료하지 않으면 연동이 안 되는 거야". 열쇠가 없으면(k 없음) 연동 전 상태이고,
    //   [연동] 버튼이 그 기기와의 승인 절차를 다시 시작한다(nudgeDevice → 서버가 방향 판단).
    //   ⚠ '이 기기' 행에는 버튼을 두지 않는다: 자기 자신을 자기가 승인할 수는 없다(승인은 다른 기기의 일).
    const linked = !!k || (d.isCurrent && selfReady);
    const link = !linked && typeof d.id === "number" && !d.isCurrent
      ? `<button class="sett-btn dev-link-btn" data-e2ee-link="${d.id}">연동</button>` : "";
    // ⚠ 무장 경고는 **별도 행**(colspan)이다: 같은 셀에 넣으면 그 행만 높이가 늘어 열 정렬이 흔들린다.
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${d.role === "controller" ? icons.smartphone({ size: 15 }) : icons.monitor({ size: 15 })}</span></td>
      <td class="dev-c-name"><span class="dev-name"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name || "기기")}</span>${d.isCurrent ? `<span class="dev-badge cur">이 기기</span>` : ""}<span class="dev-dot ${d.online ? "on" : "off"}" title="${d.online ? "온라인" : "오프라인"}"></span></span></td>
      <td class="dev-c-meta">${linked ? esc(sub) : `<span style="color:var(--text3)">연동 안 됨 · ${esc(sub)}</span>`}</td>
      <td class="dev-c-del" style="white-space:nowrap">${link}${canRevoke ? `<button class="dev-del-btn" data-dev="${d.id}"${k ? ` data-dev-key="${k.deviceKeyId}"` : ""} title="기기 삭제">${icons.trash({ size: 15 })}</button>` : ""}</td>
    </tr>
    ${canRevoke && k ? `<tr class="dev-tr-note" data-dev-armnote="${d.id}" style="display:none"><td colspan="4" class="acct-msg" style="padding:0 0 8px;color:var(--warn,#FBBF24)">다시 눌러 해제 · 되돌릴 수 없음</td></tr>` : ""}`;
  }).join("");

  const orphanRows = orphans.map((k) => {
    const mine = e2eeKeyIsMine(k);
    const isPc = k.platform === "darwin" || k.platform === "win32" || k.platform === "linux";
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${isPc ? icons.monitor({ size: 15 }) : icons.smartphone({ size: 15 })}</span></td>
      <td class="dev-c-name"><span class="dev-name"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.label || "기기")}</span>${mine ? `<span class="dev-badge cur">이 기기</span>` : ""}</span></td>
      <td class="dev-c-meta">${k.fingerprint ? `🔒 ${esc(k.fingerprint)}` : ""}</td>
      <td class="dev-c-del">${mine ? "" : `<button class="dev-del-btn" data-e2ee-revoke="${k.deviceKeyId}" title="신뢰 해제">${icons.trash({ size: 15 })}</button>`}</td>
    </tr>
    ${mine ? "" : `<tr class="dev-tr-note" data-e2ee-armnote="${k.deviceKeyId}" style="display:none"><td colspan="4" class="acct-msg" style="padding:0 0 8px;color:var(--warn,#FBBF24)">다시 눌러 해제 · 되돌릴 수 없음</td></tr>`}`;
  }).join("");

  // 온라인 PC 가 0대여도 그 자리를 비우지 않는다: 초록 self 배지 한 줄만 남으면 사용자는 '내 데이터가
  //  안전하다' 로 읽는데 사실은 '이 기기에 열쇠가 있다' 뿐이다(§2.7 정직성 기제가 화면에서 사라진다).
  const hosts = (state.devices || []).filter(isHostRow);
  // 개정 4: 정책 UI 삭제로 '끄기' 는 존재하지 않는다 — env 킬스위치(state==='off')일 때만 이 행을 접는다.
  const noHost = e2ee.state !== "off" && !hosts.length
    ? `<tr class="dev-tr">
        <td class="dev-c-ic"><span class="dev-ic">${icons.monitor({ size: 15 })}</span></td>
        <td class="dev-c-name"><span class="dev-name" style="color:var(--dim)">연결된 PC 없음</span></td>
        <td class="dev-c-meta"></td>
        <td class="dev-c-del"></td>
      </tr>`
    : "";
  return `${rows}${orphanRows}${noHost}`;
}

function renderE2ee() {
  const box = connBody?.querySelector("#e2eeBox");
  if (!box) return;
  const label = e2eeStateLabel();
  // ★ 승인 카드는 **승인할 수 있는 요청**만 그린다(e2ee.js e2eePendingApprovable — 자기 자신의 옛
  //  enrollment 제외 + 이 PC 에 열쇠가 없으면 0건). 필터 없이 e2ee.pending 을 그리면 눌러도 403 인
  //  카드가 뜬다(2026-07-28 폰 실사고).
  const pend = e2eePendingApprovable();
  const devs = e2ee.devices || [];
  const selfReady = e2eeReady();
  // 행동 행을 먼저 만든다 — 있으면 그 아래 `reason`(데몬·서버 원문)을 **그리지 않는다**: 두 줄이 같은
  //  사실을 다른 문장으로 말하고(부트스트랩은 서로 상충한다 — reason 은 '폰에서 켜라', 행동 행은 이 PC 의
  //  켜기 버튼) 첫 화면의 '설명문 0줄' 이 무너진다. 정보 손실 0 = 행동 행이 사실 + 다음 행동을 말한다.
  //  ⚠ 앱 E2eeSettingsCard 의 `!action` 조건과 같은 규칙이다(한쪽만 고치면 두 화면의 줄 수가 달라진다).
  const actionRowHtml = e2eeActionRow(pend);
  // ★ 개정 3: 행동 행 + 기기 행 + '연결된 PC 없음' 행이 **한 표**다(`<table class="dev-tbl">`). 예전에는
  //  각 행이 독립 카드(.dev-row)여서 섹션 카드 안에 카드가 겹쳐 보였다(사용자 지적) → 바깥 카드
  //  1겹 + 1px 구분선. reason/에러 문구는 표 밖 1줄이다(행이 아니라 섹션 전체에 대한 말이므로).
  box.innerHTML = `
    ${label.tone !== "on" && e2ee.reason && !actionRowHtml ? `<div class="acct-msg" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(e2ee.reason)}</div>` : ""}
    ${e2eeMsg ? `<div class="acct-msg" style="color:var(--text2)">${esc(e2eeMsg)}</div>` : ""}
    <table class="dev-tbl">${actionRowHtml}${e2eeDeviceRowsHtml(devs, selfReady)}</table>`;
  bindE2ee(box);
}

function bindE2ee(box) {
  //  (개정 6: 승인/거절 핸들러는 이 파일에서 삭제 — device-approval.js(전역 카드)와
  //   notifications.js(알림 행)가 갖는다. 여기 남는 상호작용은 연동 요청·기기 삭제뿐이다.)
  //  [연동] — 그 기기와의 연동 절차를 다시 시작한다(서버가 방향을 판단: 재알림 or 상대 기기 재신청).
  box.querySelectorAll("[data-e2ee-link]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    b.textContent = "요청 중…";
    const r = await nudgeDevice(Number(b.dataset.e2eeLink));
    if (r.ok) {
      // 상태가 바뀌는 데는 상대 기기의 응답이 필요하다 → 버튼을 "요청됨"으로 굳히고 사실만 말한다.
      b.textContent = "요청 보냄";
      e2eeMsg = "연동 요청을 보냈어요 · 그 기기에서 승인하면 연결돼요";
      renderE2ee();
    } else {
      b.disabled = false;
      b.textContent = "연동";
      e2eeMsg = r.error || "요청을 보내지 못했어요";
      renderE2ee();
    }
  }));
  // '코드 확인' 접기/펼치기(개정 5) — 자기 대기 화면(이 PC 가 승인을 기다릴 때)에서 쓴다.
  box.querySelectorAll("[data-e2ee-code]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.e2eeCode;
    if (e2eeCodeOpen.has(k)) e2eeCodeOpen.delete(k); else e2eeCodeOpen.add(k);
    renderE2ee();
  }));
  // (개정 4: 정책 세그/암호화 켜기/복구 코드 만들기·복원 핸들러 삭제 — 부트스트랩은
  //  e2ee.js maybeAutoBootstrap 이 자동 수행, 정책은 normalizeE2eePolicy 가 '자동' 으로 고정)
  // 신뢰 해제(기기 행이 없는 고아 열쇠) = 휴지통 2탭. 비가역 경고는 **결정 순간에만** 인라인으로
  //  띄운다(상시 2줄 문단을 없앤 대신 정보량은 유지 — 카피 감사 §2 위치 이동).
  box.querySelectorAll("[data-e2ee-revoke]").forEach((b) => b.addEventListener("click", async () => {
    const note = box.querySelector(`[data-e2ee-armnote="${b.dataset.e2eeRevoke}"]`);
    if (!b.classList.contains("arm")) {
      b.classList.add("arm");
      if (note) note.style.display = "";
      setTimeout(() => { b.classList.remove("arm"); if (note) note.style.display = "none"; }, 4000);
      return;
    }
    b.disabled = true;
    const r = await revokeTrust(Number(b.dataset.e2eeRevoke));
    e2eeMsg = r.ok ? "" : r.error || "해제하지 못했어요";
    renderE2ee();
  }));
  // 기기 삭제 = 휴지통 2탭(모바일과 동일 규율). **열쇠를 가진 기기면 열쇠 해제 + 세대 회전까지** 한다:
  //  back `revokeDevice` 는 그 기기의 열쇠를 'revoked' 로 표시하고 rotate_needed 만 팬아웃하므로(회전은
  //  사람이 있는 클라이언트가 한다) 회전 없이 지우면 지운 기기가 이미 가진 MK_epoch 로 이후 트래픽까지
  //  계속 열 수 있다. 회전이 불가능한 상태(이 PC 에 열쇠 없음)면 기기 삭제만 한다(구 동작 유지).
  box.querySelectorAll("[data-dev]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const note = box.querySelector(`[data-dev-armnote="${b.dataset.dev}"]`);
    if (!b.classList.contains("arm")) {
      b.classList.add("arm");
      if (note) note.style.display = "";
      setTimeout(() => { b.classList.remove("arm"); if (note) note.style.display = "none"; }, 4000);
      return;
    }
    b.disabled = true;
    const keyId = b.dataset.devKey ? Number(b.dataset.devKey) : 0;
    if (keyId && e2eeReady()) {
      const r = await revokeTrust(keyId);
      if (!r.ok) e2eeMsg = r.error || "해제하지 못했어요";
    }
    try { await api.revokeDevice(Number(b.dataset.dev)); await S.loadDevices(); } catch (_) { b.disabled = false; }
    await refreshE2ee();
    renderE2ee();
  }));
}

// (구 renderDeviceList — '내 기기' 표는 2026-07-27 통합으로 `기기` 섹션(e2eeDeviceRowsHtml)에 흡수됐다:
//  같은 기기가 '열쇠를 가진 기기' 목록과 이 표에 두 번 나오던 화면을 하나로 합쳤다)

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
    S.setView("workspace"); // 로그아웃 → 설정 모달 닫기(메인은 로그인 게이트로 전환)
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
/** 설정 > 계정 탭으로 이동(기기 승인 알림 클릭 등 — 종단간 암호화 카드가 여기 있다). */
export function openAccountSection() {
  section = "connection";
  // 알림을 눌러 들어온 사용자는 곧바로 승인 카드를 봐야 한다(앱의 '기기 승인' 시트와 같은 진입).
  S.setView("settings");
  void refreshE2ee();
}

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
