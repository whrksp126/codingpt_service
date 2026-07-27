// settings.js — "내 정보 · 설정" 모달. 좌측 탭 사이드바 + 우측 콘텐츠(오버레이).
//  모바일 연결 관리(웹 로그인/상태/해제)를 "계정" 탭에 담는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { ANDROID_QR, IOS_QR } from "./store-qr.js";
import {
  e2ee, e2eeReady, refreshE2ee, approveDevice, denyDevice, setPolicy as setE2eePolicy,
  createRecoveryCode, restoreFromRecovery, revokeTrust, e2eeStateLabel, e2eeNeedsBootstrap, bootstrapAccount,
  e2eeCanRestore,
} from "./e2ee.js";
import { hostE2eeEpoch, hostLockLabel, isHostRow } from "./host-lock.js";
import { renderAgentList, loadAgents, cachedAgents } from "./agents-view.js";
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
      contentEl.innerHTML = `
        <div class="sm-card2">
          <div class="sett-col"><span>이 PC의 AI 에이전트</span><div id="agentsBody" class="ag-list"></div></div>
          <div class="sett-hint" id="agentsHint">에이전트를 확인하는 중…</div>
        </div>`;
      const body = contentEl.querySelector("#agentsBody");
      const hint = contentEl.querySelector("#agentsHint");
      const paint = () => {
        renderAgentList(body, { onChange: paint });
        const c = cachedAgents();
        const on = c.agents.filter((a) => a.installed && a.wired).length;
        const missing = c.agents.filter((a) => !a.installed).length;
        hint.textContent = `연동 ${on}개 · 미설치 ${missing}개. 연동을 켜면 그 에이전트를 실행할 때만 우리 훅이 얹혀요 — `
          + `사용자 개인 설정 파일(~/.claude, ~/.codex)은 수정하지 않아요.`;
      };
      paint();
      loadAgents(true).then(paint).catch((e) => { hint.textContent = String(e && e.message ? e.message : e); });
    }
  } else if (section === "general") {
    contentEl.innerHTML = `
      <div class="sm-card2">
        <div class="sett-row"><span>이 Mac 로그인 시 자동 실행</span><input id="autostartChk" type="checkbox" class="tgl" /></div>
      </div>
      <div class="sm-card2">
        <div class="sett-row"><span>테마</span>
          <span class="scale-seg" id="themeSeg">
            <button class="scale-opt" data-v="system">시스템</button>
            <button class="scale-opt" data-v="light">라이트</button>
            <button class="scale-opt" data-v="dark">다크</button>
          </span>
        </div>
        <div class="sett-row"><span>인터페이스 글꼴</span><div class="fd" id="uiFontDd"></div></div>
        <div class="sett-row"><span>코드·터미널 글꼴</span><div class="fd" id="monoFontDd"></div></div>
        <div class="sett-col"><span>터미널 스타일</span><div class="ts-grid" id="termStyleGrid"></div></div>
        <div class="sett-hint">글꼴·터미널 스타일은 계정의 모든 기기(PC·모바일)에 함께 적용돼요. 터미널 스타일은 앱 테마(다크/라이트)에 맞는 변형이 자동 선택돼요.</div>
      </div>
      <div class="sm-card2">
        <div class="sett-row"><span>다운로드 폴더 접근</span><button class="sett-btn fpa-btn" data-f="downloads">허용</button></div>
        <div class="sett-row"><span>데스크탑 폴더 접근</span><button class="sett-btn fpa-btn" data-f="desktop">허용</button></div>
        <div class="sett-row"><span>문서 폴더 접근</span><button class="sett-btn fpa-btn" data-f="documents">허용</button></div>
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
        if (ok) { b.textContent = "허용됨"; return; } // disabled 유지
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
//  첫 화면(스크롤 없음, 설명문 0줄):
//    [섹션 제목 행] 기기 ......................... [self 배지 = 계정 열쇠 상태]
//    ⚠ 행동 행 — **동시 1개만**: 새 기기 N대 승인(펼치면 그 자리에서 대조·승인) > 기존 기기에서 승인해
//      주세요 > 암호화 열쇠가 없어요
//    (배지 톤이 on 이 아니고 행동 행이 없을 때만) reason 1줄(2줄 클램프)
//    기기 행: [아이콘] 이름 [이 기기] ............. [암호화 배지]  [🗑]
//             {OS} · {최근 작업} · 🔒 {지문}
//    (온라인 PC 0대일 때) 🖥 연결된 PC 없음 ....... [확인 중]   ← §2.7 정직성 기제. **절대 접지 않는다**
//    자세히 ▾ (기본 접힘) → ① 정책 ② 안전 코드 ④ 복구 코드 ⑥ 메타데이터 고지
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
let e2eeRecoveryShown = null; // 방금 만든 복구 문구(1회 표시 — 카드 재렌더에도 유지)
let e2eeMsg = "";
// 접기 상태는 **로컬 플래그**다(state.js 에 넣지 않는다 — 기기 간 동기화 대상이 아니다).
//  PC 에는 접기 컴포넌트가 없어 `sett-row` 하나를 토글로 쓴다(카피 감사 §3-A 의 PC 적용 메모).
//  리컨실러 emit 마다 renderE2ee 가 다시 도므로 모듈 스코프에 둬야 펼친 상태가 유지된다.
let e2eeAdvOpen = false;   // '자세히'
let e2eeApprOpen = false;  // 행동 행(새 기기 N대 승인) → 승인 카드
let e2eeWaitBusy = false;  // '승인됐는지 확인' 진행 중

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
/** 승인 카드 헤더의 시각(모바일 DeviceTrustCard fmtWhen 미러 — 같은 표기여야 한다). */
function fmtWhen(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!t) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

/** 60비트 안전 코드 — 4글자 3그룹 칩(모바일 SafetyCode 와 같은 그룹 구분·글자수). */
function safetyChips(code, color) {
  const groups = String(code || "").split("-").filter(Boolean);
  const g = groups.length ? groups : ["—", "—", "—"];
  // flex-wrap = 좁은 창에서도 3블록이 잘리지 않고 접힌다(칩 자체는 줄어들지 않는다 — 대조 대상이다).
  return `<span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${g.map((s) => `
    <span style="padding:7px 10px;border-radius:var(--r-md);background:var(--elevated2);border:1px solid var(--border-ctrl);
      font-family:var(--mono);font-size:22px;font-weight:800;letter-spacing:2px;color:${color};user-select:text">${esc(s)}</span>`).join("")}</span>`;
}
/** 요청 구분용 4자리(보조 표기) — 크기·문구로 "대조용이 아님"을 분명히 한다(모바일 RequestNo 미러). */
function requestNo(code) {
  if (!code) return "";
  return `<div class="acct-msg" style="text-align:center">요청 <span style="font-family:var(--mono)">${esc(code)}</span> · 대조용 아님</div>`;
}
/**
 * 안전 코드를 **계산할 수 없을 때**의 경고(= 파생 기준 userRef 미상 → e2ee.js deriveDisplay 가 null).
 *  '—' 만 그려 두면 사용자는 "글자까지 같으면 승인" 을 읽고 무엇을 대조해야 할지 모른 채 승인한다
 *  → 대조 없는 승인이 습관이 되면 이 UX 의 존재 이유가 사라진다. 그래서 칩 대신 이 경고를 그리고
 *  **승인 버튼을 비활성**한다(앱도 같은 규칙으로 통일 — 카피 감사 §3-B).
 */
function noSafetyCodeWarn() {
  return `<div class="acct-msg" style="color:var(--warn,#FBBF24)">안전 코드를 아직 못 만들었어요 · 승인하지 마세요</div>`;
}
/**
 * 같은 상황이지만 **이 PC 자신이 대기 기기**인 화면 전용 경고(모바일 `COPY.wait.noSafety` 와 동일 문구).
 *  이 화면에는 승인 버튼이 없다 → 승인자용 '승인하지 마세요' 를 재사용하면 지시 대상이 어긋난다
 *  (사용자는 "여기서 뭘 승인하나" 로 멈춘다). 누르지 말아야 할 곳(기존 기기)을 명시한다.
 *  ⚠ 코드가 없어도 이 자리를 **비워 두지 않는다**: 빈 화면이면 승인하는 기기 쪽은 코드를 정상 표시하므로
 *   사용자는 대조할 값이 없는 채로 [승인] 을 누른다(§2.10 이 막으려는 '대조 없는 습관 승인').
 */
function waitNoSafetyWarn() {
  return `<div class="acct-msg" style="color:var(--warn,#FBBF24)">안전 코드를 아직 못 만들었어요 · 기존 기기에서 승인하지 마세요</div>`;
}

/**
 * 승인 카드(PC 는 시트가 없어 카드 인라인) — 카드 안 텍스트는 지침 1줄 + 요청번호 1줄뿐이다.
 *  ★ 요청번호는 **안전 코드 유무와 무관하게** 그린다(앱 DeviceTrustCard 와 동일 구성 — 폰과 PC 를
 *   나란히 놓으면 카드 구성이 같아야 한다). 안전 코드가 없다고 요청번호까지 감추면 요청이 여러 건일 때
 *   **어느 요청을 처리하는지 구분할 표식이 하나도 없다**. 요청번호는 대조 대상이 아니므로(라벨에
 *   `· 대조용 아님`) 이 자리에서 대조 위험을 만들지 않는다.
 *  ★ 반대로 `verified=false` 경고는 안전 코드가 **있을 때만** 그린다(앱과 동일 — 카피 감사 §3-B):
 *   안전 코드를 못 만든 상태는 항상 verified=false 를 동반하므로 두 경고가 겹치면 노이즈가 되고,
 *   그때 사용자가 읽어야 하는 지시는 더 강한 쪽('승인하지 마세요') 하나다. 경고는 한 번에 하나만.
 */
function e2eeApprovalCard(p) {
  const noSafety = !p.safetyCode;
  return `<div class="appr-card">
    <div style="display:flex;align-items:center;gap:6px">
      <span class="dev-ic" style="color:var(--warn,#FBBF24)">${icons.shield({ size: 15 })}</span>
      <span style="flex:1;font-size:13px;font-weight:700">새 기기 승인</span>
      <span class="dim" style="font-size:11px;flex:none">${esc(fmtWhen(p.requestedAt))}</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px;min-width:0">
      <span class="dev-ic">${icons.smartphone({ size: 15 })}</span>
      <span class="dev-name" style="flex:1;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label || "새 기기")}</span>
    </div>
    <div class="acct-msg" style="color:var(--text2)">아래 코드가 새 기기 화면과 글자까지 같으면 승인, 다르면 거절하세요.</div>
    ${noSafety ? noSafetyCodeWarn() : safetyChips(p.safetyCode, "var(--accent)")}
    ${requestNo(p.verifyCode)}
    ${!noSafety && p.verified === false ? `<div class="acct-msg" style="color:var(--warn,#FBBF24)">요청 번호는 서버 값 · 코드로만 대조하세요</div>` : ""}
    <div style="display:flex;gap:8px">
      <button class="btn small" style="flex:1" data-e2ee-deny="${esc(p.enrollmentId)}">거절</button>
      <button class="btn small primary" style="flex:1.4" data-e2ee-approve="${esc(p.enrollmentId)}"${noSafety ? " disabled" : ""}>승인</button>
    </div>
  </div>`;
}

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
  if (pend.length) {
    return `<tr class="dev-tr" id="e2eeApprRow" style="cursor:pointer" role="button" tabindex="0">
      <td class="dev-c-ic"><span class="dev-ic" style="color:var(--warn,#FBBF24)">${icons.shield({ size: 15 })}</span></td>
      <td colspan="3" style="font-size:13px;font-weight:700;color:var(--warn,#FBBF24)">새 기기 ${pend.length}대 승인</td>
      <td class="dev-c-del"><span class="dim" style="font-size:12px">${e2eeApprOpen ? "▴" : "▾"}</span></td>
    </tr>
    ${e2eeApprOpen ? `<tr class="dev-tr-note"><td colspan="4"><div class="dev-list">${pend.map(e2eeApprovalCard).join("")}</div></td></tr>` : ""}`;
  }
  // 이 PC 가 승인을 기다린다 — 설명문 0줄. 대조는 **기존 기기 화면에서** 하므로 여기엔 지침이 없다.
  //  ★ 안전 코드를 계산할 수 없으면(userRef 미상 → e2ee.js deriveDisplay 가 null) 칩을 **무음으로
  //   생략하지 않는다**: 승인하는 폰은 그 PC 의 ikX 로 안전 코드를 정상 파생해 크게 그리는데(폰은
  //   userRef 를 서버에서 받는다) 이 화면에 아무것도 없으면 사용자는 대조할 값을 찾다 못 찾고 그냥
  //   [승인] 을 누른다 = 사람 눈 대조라는 유일한 MITM 방어가 그 승인에서 통째로 빠진다(§2.10).
  //   그래서 승인 카드와 **같은 3항**을 쓴다(앱 DeviceTrustWaiting 미러). 단 경고 **문구는 다르다**:
  //   이 화면에는 승인 버튼이 없으므로 누르지 말아야 할 곳을 명시한다(waitNoSafetyWarn).
  //  ★ 부제 1줄만 예외적으로 붙인다: 기기를 전부 잃은 사용자에게 '기존 기기에서 승인' 은 실행 불가능한
  //   지시이고 유일한 출구(복구 코드)는 접힌 `자세히` 안에 있다 → 경로를 알린다(앱 act.selfWaitHint 미러).
  if (e2eeSelfWaiting()) {
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div style="display:flex;flex-direction:column;align-items:stretch;gap:8px">
        <div style="font-size:13px;font-weight:700">기존 기기에서 승인해 주세요</div>
        ${e2eeCanRestore() ? `<div class="acct-msg" style="padding-top:0">기기가 없으면 자세히 → 복구 코드로 복원</div>` : ""}
        ${e2ee.safetyCode ? safetyChips(e2ee.safetyCode, "var(--accent)") : waitNoSafetyWarn()}
        ${requestNo(e2ee.verifyCode)}
        <button class="btn small" id="e2eeWaitRefresh"${e2eeWaitBusy ? " disabled" : ""}>${e2eeWaitBusy ? "확인 중…" : "승인됐는지 확인"}</button>
      </div>
    </td></tr>`;
  }
  // 계정에 열쇠가 0개 = 사람이 켜기 전까지 **영구 평문**. 데몬은 이 경로를 자동으로 타지 않는다.
  if (e2eeNeedsBootstrap()) {
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div style="display:flex;flex-direction:column;align-items:stretch;gap:6px">
        <div style="font-size:13px;font-weight:700">암호화 열쇠가 없어요</div>
        <div class="acct-msg" style="padding-top:0">주로 쓰는 기기에서 켜세요</div>
        <button class="btn small primary" id="e2eeBootBtn" style="margin-top:2px">암호화 켜기</button>
      </div>
    </td></tr>`;
  }
  return "";
}

/**
 * 자세히 안 — 순서 고정(정책 → 안전 코드 → 복구 → 메타데이터 고지).
 *  ★ 개정 2 에서 '열쇠를 가진 기기' 목록은 **삭제**했다: 그 정보(열쇠 보유 + 지문 + 해제)는 기기 행에
 *   흡수됐다(같은 기기가 두 목록에 중복 등장하던 화면을 하나로). 어느 기기 행에도 붙지 않는 열쇠만
 *   목록에 남는다 — 그래야 해제 경로를 잃지 않는다(e2eeDeviceRowsHtml).
 *  ★ ④ 복구 코드의 컨트롤 유무는 **`state` 값으로 분기하지 않는다**(계약 §2.4 규약 3): 만들기 활성 =
 *   `e2eeReady()`(구 `state==='trusted'` 은 policy='off' + 열쇠 보유에서 "열쇠는 있는데 만들 수 없다"
 *   였다), 복원 행 노출 = `e2eeCanRestore()`(구 `state!=='trusted'&&state!=='off'` 은 사용 불가 상태에도
 *   행을 띄워 눌러도 실패했다). 두 판정 모두 앱 E2eeSettingsCard 와 동치다(테스트가 대조한다).
 */
function e2eeAdvancedHtml() {
  return `
    <div class="sett-row"><span>종단간 암호화<br><span class="dim" style="font-size:11px">자동 권장 · 항상 = 안 되면 조작 차단</span></span>
      <span class="scale-seg" id="e2eePolicySeg">
        <button class="scale-opt${e2ee.policy === "off" ? " active" : ""}" data-v="off">끄기</button>
        <button class="scale-opt${e2ee.policy === "preferred" ? " active" : ""}" data-v="preferred">자동</button>
        <button class="scale-opt${e2ee.policy === "required" ? " active" : ""}" data-v="required">항상</button>
      </span></div>
    <div class="sett-row" style="align-items:flex-start;gap:12px"><span>이 기기 안전 코드<br><span class="dim" style="font-size:11px">다른 기기 화면과 같은지 확인</span></span>
      <span style="flex:none;font-family:var(--mono);font-size:18px;font-weight:800;letter-spacing:1.2px;user-select:text;text-align:right;word-break:break-all">${esc(e2ee.safetyCode || "—")}</span></div>
    <!-- (구 ③ '지문' 행은 2026-07-27 삭제 — 아래 ⑤ 열쇠 목록의 자기 행이 같은 6자리를 '이 기기' 배지와
         함께 이미 보여 준다. 대조는 안전 코드로 하므로 이 행은 아무 행동도 유발하지 않는 중복이었다) -->
    <div class="sett-row"><span>복구 코드<br><span class="dim" style="font-size:11px">${e2ee.recoverySet ? "새로 만들면 이전 코드 무효" : "기기를 다 잃으면 복구 불가"}</span></span>
      <button class="btn small" id="e2eeRecBtn"${e2eeReady() ? "" : " disabled"}>${e2ee.recoverySet ? "새로 만들기" : "만들기"}</button></div>
    ${e2eeRecoveryShown ? `<div class="acct-msg" style="color:var(--accent)">지금 적어두세요 · 다시 못 봅니다</div>
      <div style="display:flex;align-items:center;gap:10px;padding:4px 2px 8px">
        <span style="flex:1;min-width:0;font-family:var(--mono);font-size:15px;font-weight:700;user-select:text;word-break:break-all">${esc(e2eeRecoveryShown)}</span>
        <button class="btn small" id="e2eeRecDone" style="flex:none">적어뒀어요</button>
      </div>` : ""}
    ${e2eeCanRestore() ? `<div class="sett-row">
      <span>복구 코드로 복원</span>
      <span style="display:flex;gap:6px;align-items:center">
        <input id="e2eeRecIn" class="prof-nick" placeholder="CPT1-XXXXX-…" style="width:200px;font-family:var(--mono);font-size:12px" spellcheck="false" />
        <button class="btn small" id="e2eeRecRestore">복원</button>
      </span></div>` : ""}
    <div class="acct-msg">폴더명·알림 제목은 서버가 봅니다</div>`;
}

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
    const sub = [fmtRecent(d.lastSeenAt || d.createdAt), k && k.fingerprint ? `🔒 ${k.fingerprint}` : ""]
      .filter(Boolean).join(" · ");
    // ⚠ 무장 경고는 **별도 행**(colspan)이다: 같은 셀에 넣으면 그 행만 높이가 늘어 열 정렬이 흔들린다.
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${d.role === "controller" ? icons.smartphone({ size: 15 }) : icons.monitor({ size: 15 })}</span></td>
      <td class="dev-c-name"><span class="dev-name"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name || "기기")}</span>${d.isCurrent ? `<span class="dev-badge cur">이 기기</span>` : ""}<span class="dev-dot ${d.online ? "on" : "off"}" title="${d.online ? "온라인" : "오프라인"}"></span></span></td>
      <td class="dev-c-meta">${esc(sub)}</td>
      <td class="dev-c-del">${canRevoke ? `<button class="dev-del-btn" data-dev="${d.id}"${k ? ` data-dev-key="${k.deviceKeyId}"` : ""} title="기기 삭제">${icons.trash({ size: 15 })}</button>` : ""}</td>
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
  const noHost = e2ee.policy !== "off" && !hosts.length
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
  const pend = e2ee.pending || [];
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
    <table class="dev-tbl">${actionRowHtml}${e2eeDeviceRowsHtml(devs, selfReady)}</table>
    <div class="sett-row" id="e2eeAdvToggle" style="cursor:pointer;border-top:1px solid var(--border)" role="button" tabindex="0">
      <span>자세히</span><span class="dim" style="font-size:12px">${e2eeAdvOpen ? "▴" : "▾"}</span></div>
    ${e2eeAdvOpen ? e2eeAdvancedHtml() : ""}`;
  bindE2ee(box);
}

function bindE2ee(box) {
  // 접기 토글 — 로컬 플래그만 뒤집고 다시 그린다(서버·state.js 왕복 없음).
  const adv = box.querySelector("#e2eeAdvToggle");
  if (adv) adv.addEventListener("click", () => { e2eeAdvOpen = !e2eeAdvOpen; renderE2ee(); });
  const apprRow = box.querySelector("#e2eeApprRow");
  if (apprRow) apprRow.addEventListener("click", () => { e2eeApprOpen = !e2eeApprOpen; renderE2ee(); });
  box.querySelectorAll("[data-e2ee-approve]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await approveDevice(b.dataset.e2eeApprove);
    e2eeMsg = r.ok ? "" : r.error || "승인하지 못했어요";
    renderE2ee();
  }));
  box.querySelectorAll("[data-e2ee-deny]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await denyDevice(b.dataset.e2eeDeny);
    e2eeMsg = r.ok ? "" : r.error || "거절하지 못했어요";
    renderE2ee();
  }));
  // 이 PC 가 대기 중일 때 — 기존 기기에서 승인했는지 지금 확인(폴링을 기다리지 않는다).
  const waitBtn = box.querySelector("#e2eeWaitRefresh");
  if (waitBtn) waitBtn.addEventListener("click", async () => {
    e2eeWaitBusy = true;
    renderE2ee();
    try { await refreshE2ee(); } finally { e2eeWaitBusy = false; renderE2ee(); }
  });
  box.querySelectorAll("#e2eePolicySeg .scale-opt").forEach((b) => b.addEventListener("click", async () => {
    e2eeMsg = "";
    await setE2eePolicy(b.dataset.v);
    renderE2ee();
  }));
  // 계정 최초 열쇠 생성 — 사람이 누르는 유일한 지점(데몬은 자동으로 하지 않는다).
  const boot = box.querySelector("#e2eeBootBtn");
  if (boot) boot.addEventListener("click", async () => {
    boot.disabled = true;
    boot.textContent = "켜는 중…";
    const r = await bootstrapAccount();
    e2eeMsg = r.ok ? "켜졌어요 · 다른 기기는 여기서 승인" : (r.error || "열쇠를 만들지 못했어요.");
    renderE2ee();
  });
  const rec = box.querySelector("#e2eeRecBtn");
  if (rec) rec.addEventListener("click", async () => {
    rec.disabled = true;
    const code = await createRecoveryCode();
    e2eeRecoveryShown = code;
    e2eeMsg = code ? "" : "복구 코드를 만들 수 없어요";
    renderE2ee();
  });
  // 1회 표시를 사용자가 닫는다(적어뒀다고 확인) — 다시 볼 수 없는 값이라 화면에 남겨 두지 않는다.
  const recDone = box.querySelector("#e2eeRecDone");
  if (recDone) recDone.addEventListener("click", () => { e2eeRecoveryShown = null; renderE2ee(); });
  const recIn = box.querySelector("#e2eeRecIn");
  const recGo = box.querySelector("#e2eeRecRestore");
  if (recGo) recGo.addEventListener("click", async () => {
    recGo.disabled = true;
    const r = await restoreFromRecovery(recIn ? recIn.value : "");
    e2eeMsg = r.ok ? "복구 완료" : (r.error || "코드가 올바르지 않아요");
    renderE2ee();
  });
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
  e2eeApprOpen = true;
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
