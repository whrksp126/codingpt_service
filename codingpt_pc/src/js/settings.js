// settings.js — "내 정보 · 설정" 모달. 좌측 탭 사이드바 + 우측 콘텐츠(오버레이).
//  모바일 연결 관리(웹 로그인/상태/해제)를 "계정" 탭에 담는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { ANDROID_QR } from "./store-qr.js";
import { e2ee, refreshE2ee, approveDevice, denyDevice, setPolicy as setE2eePolicy, createRecoveryCode, restoreFromRecovery, revokeTrust } from "./e2ee.js";
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
      renderDeviceList();
      renderE2ee();
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
          <div class="qr-tile qr-tile--soon">
            <div class="qr-imgwrap qr-imgwrap--soon"><span class="qr-soonlbl">준비 중</span></div>
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

// ── 로그인됨: 계정 + 이 기기 상태 + 내 기기 목록 ──
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
      <div class="dev-title">종단간 암호화</div>
      <div id="e2eeBox" class="sm-card2"></div>
    </div>
    <div class="dev-section">
      <div class="dev-title">내 기기</div>
      <div id="deviceTable" class="dev-table"></div>
    </div>`;
  bindUnpair(connBody.querySelector("#unpairBtn"));
  connBody.querySelector("#deleteAcctBtn").addEventListener("click", onDeleteAccount);
  bindNickname(); // 프로필 카드 닉네임 저장
  renderDeviceList();
  renderE2ee();
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
// ── 종단간 암호화(기능2) 카드 — 모바일 E2eeSettingsCard 와 **동일 정보 구조** ──
//  ① 상태 ② 정책(킬스위치) ③ 지문/QR 재검증 ④ 복구 코드 ⑤ 열쇠를 가진 기기(신뢰 해제=회전)
//  마스터키는 데몬에 있으므로 모든 조작은 e2ee.js → cpt.sock 위임이다(JS 에 MK 없음).
let e2eeRecoveryShown = null; // 방금 만든 복구 문구(1회 표시 — 카드 재렌더에도 유지)
let e2eeMsg = "";

function e2eeStatePill() {
  if (e2ee.policy === "off") return { t: "꺼짐", c: "var(--dim)" };
  if (e2ee.available && e2ee.state === "trusted") return { t: "켜짐", c: "var(--accent)" };
  if (e2ee.state === "pending") return { t: "승인 대기", c: "var(--warn, #FBBF24)" };
  if (e2ee.state === "bootstrap") return { t: "준비 중", c: "var(--warn, #FBBF24)" };
  if (!e2ee.available || e2ee.state === "unsupported") return { t: "미지원", c: "var(--dim)" };
  if (e2ee.state === "error") return { t: "오류", c: "var(--error)" };
  return { t: "꺼짐", c: "var(--dim)" };
}

function renderE2ee() {
  const box = connBody?.querySelector("#e2eeBox");
  if (!box) return;
  const pill = e2eeStatePill();
  const pend = e2ee.pending || [];
  const devs = e2ee.devices || [];
  box.innerHTML = `
    <div class="sett-row">
      <span>이 PC 의 암호화 상태</span>
      <span style="font-size:11px;font-weight:800;color:${pill.c}">${pill.t}</span>
    </div>
    <div class="acct-msg">${esc(e2ee.reason || (e2ee.state === "trusted"
      ? "이 PC 와 내 폰/태블릿 사이의 파일·알림 내용을 서버가 볼 수 없게 암호화합니다."
      : "지원되는 기기끼리 자동으로 암호화하고, 아니면 기존 방식(평문)으로 그대로 동작합니다."))}</div>
    ${e2ee.state === "pending" ? `<div class="sett-row"><span>이 PC 확인 숫자</span>
      <span style="font-family:var(--mono);font-size:22px;font-weight:800;letter-spacing:4px">${esc(e2ee.verifyCode || "----")}</span></div>
      <div class="acct-msg">이미 쓰던 폰/PC 에 승인 요청이 갔어요. 그 화면에 같은 숫자가 보이면 승인해 주세요.</div>` : ""}
    ${pend.map((p) => `
      <div class="dev-row" style="border-color:var(--warn,#FBBF24);flex-wrap:wrap">
        <span class="dev-ic">${icons.smartphone({ size: 15 })}</span>
        <span class="dev-meta">
          <span class="dev-name">${esc(p.label || "새 기기")} 에서 접속 시도</span>
          <span class="dev-sub">새 기기 화면의 숫자와 같은지 확인하세요</span>
        </span>
        <span style="font-family:var(--mono);font-size:22px;font-weight:800;letter-spacing:4px;color:${p.verified === false ? "var(--warn,#FBBF24)" : "var(--text)"}"
          title="${p.verified === false ? "이 숫자는 서버가 알려준 값입니다(로컬 계산과 달랐음) — 새 기기가 내 것인지 한 번 더 확인" : "이 PC 에서 직접 계산한 값"}">${esc(p.verifyCode || "----")}</span>
        <button class="btn small" data-e2ee-deny="${esc(p.enrollmentId)}">거절</button>
        <button class="btn small primary" data-e2ee-approve="${esc(p.enrollmentId)}">승인</button>
      </div>`).join("")}
    <div class="sett-row"><span>암호화 사용<br><span class="dim" style="font-size:11px">자동 = 양쪽이 지원하면 암호화(권장) · 항상 = 지원 안 하면 조작 차단</span></span>
      <span class="scale-seg" id="e2eePolicySeg">
        <button class="scale-opt${e2ee.policy === "off" ? " active" : ""}" data-v="off">끄기</button>
        <button class="scale-opt${e2ee.policy === "preferred" ? " active" : ""}" data-v="preferred">자동</button>
        <button class="scale-opt${e2ee.policy === "required" ? " active" : ""}" data-v="required">항상</button>
      </span></div>
    <div class="sett-row"><span>이 PC 보안 지문<br><span class="dim" style="font-size:11px">폰 설정의 같은 항목과 대조하세요(QR 스캔 시 자동 검증)</span></span>
      <span style="font-family:var(--mono);font-size:16px;font-weight:700">${esc(e2ee.fingerprint || "— — —")}</span></div>
    <div class="sett-row"><span>복구 코드<br><span class="dim" style="font-size:11px">${e2ee.recoverySet ? "설정됨 — 새로 만들면 이전 코드는 무효" : "모든 기기를 잃으면 열쇠를 되살릴 수 없어요"}</span></span>
      <button class="btn small" id="e2eeRecBtn"${e2ee.state === "trusted" ? "" : " disabled"}>${e2ee.recoverySet ? "새로 만들기" : "만들기"}</button></div>
    ${e2eeRecoveryShown ? `<div class="acct-msg" style="color:var(--accent)">이 화면을 닫으면 다시 볼 수 없어요 — 지금 안전한 곳에 적어두세요.</div>
      <div style="font-family:var(--mono);font-size:15px;font-weight:700;padding:0 2px 8px;user-select:text">${esc(e2eeRecoveryShown)}</div>` : ""}
    ${e2ee.state !== "trusted" && e2ee.state !== "off" ? `<div class="sett-row">
      <span>복구 코드로 복원<br><span class="dim" style="font-size:11px">모든 기기를 잃었을 때 — 코드 자체가 열쇠입니다</span></span>
      <span style="display:flex;gap:6px;align-items:center">
        <input id="e2eeRecIn" class="prof-nick" placeholder="CPT1-XXXXX-…" style="width:230px;font-family:var(--mono);font-size:12px" spellcheck="false" />
        <button class="btn small" id="e2eeRecRestore">복원</button>
      </span></div>` : ""}
    ${devs.length ? `<div class="dev-title" style="margin-top:10px">열쇠를 가진 기기</div>
      <div class="dev-list">${devs.map((d) => {
        const mine = !!e2ee.fingerprint && d.fingerprint === e2ee.fingerprint;
        const isPc = d.platform === "darwin" || d.platform === "win32" || d.platform === "linux";
        return `<div class="dev-row">
          <span class="dev-ic">${isPc ? icons.monitor({ size: 15 }) : icons.smartphone({ size: 15 })}</span>
          <span class="dev-meta"><span class="dev-name">${esc(d.label || "기기")}${mine ? `<span class="dev-badge cur">이 기기</span>` : ""}</span>
            <span class="dev-sub" style="font-family:var(--mono)">🔒 ${esc(d.fingerprint || "")}</span></span>
          ${mine ? "" : `<button class="dev-del-btn" data-e2ee-revoke="${d.deviceKeyId}" title="신뢰 해제">${icons.trash({ size: 15 })}</button>`}
        </div>`;
      }).join("")}</div>
      <div class="acct-msg">신뢰를 해제하면 열쇠를 새로 만들어 남은 기기에만 다시 나눠줍니다. 해제 이전에 그 기기가 이미 받은 데이터는 회수할 수 없습니다.</div>` : ""}
    <div class="acct-msg">${e2eeMsg ? esc(e2eeMsg) + "<br>" : ""}암호화해도 폴더명·브랜치명 같은 메타데이터와 알림 제목은 서버가 봅니다(기기 목록·그룹핑·잠금화면 알림이 그 정보로 동작합니다).</div>`;
  bindE2ee(box);
}

function bindE2ee(box) {
  box.querySelectorAll("[data-e2ee-approve]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await approveDevice(b.dataset.e2eeApprove);
    e2eeMsg = r.ok ? "" : r.error || "승인에 실패했어요.";
    renderE2ee();
  }));
  box.querySelectorAll("[data-e2ee-deny]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await denyDevice(b.dataset.e2eeDeny);
    e2eeMsg = r.ok ? "" : r.error || "거절에 실패했어요.";
    renderE2ee();
  }));
  box.querySelectorAll("#e2eePolicySeg .scale-opt").forEach((b) => b.addEventListener("click", async () => {
    e2eeMsg = "";
    await setE2eePolicy(b.dataset.v);
    renderE2ee();
  }));
  const rec = box.querySelector("#e2eeRecBtn");
  if (rec) rec.addEventListener("click", async () => {
    rec.disabled = true;
    const code = await createRecoveryCode();
    e2eeRecoveryShown = code;
    e2eeMsg = code ? "" : "복구 코드를 만들 수 없어요(데몬 업데이트 필요).";
    renderE2ee();
  });
  const recIn = box.querySelector("#e2eeRecIn");
  const recGo = box.querySelector("#e2eeRecRestore");
  if (recGo) recGo.addEventListener("click", async () => {
    recGo.disabled = true;
    const r = await restoreFromRecovery(recIn ? recIn.value : "");
    e2eeMsg = r.ok ? "복구 완료 — 이 PC 가 다시 열쇠를 갖습니다." : (r.error || "복원에 실패했어요.");
    renderE2ee();
  });
  // 신뢰 해제 = 휴지통 2탭(모바일/기기삭제와 동일 규율)
  box.querySelectorAll("[data-e2ee-revoke]").forEach((b) => b.addEventListener("click", async () => {
    if (!b.classList.contains("arm")) {
      b.classList.add("arm");
      setTimeout(() => b.classList.remove("arm"), 4000);
      return;
    }
    b.disabled = true;
    const r = await revokeTrust(Number(b.dataset.e2eeRevoke));
    e2eeMsg = r.ok ? "" : r.error || "신뢰 해제에 실패했어요.";
    renderE2ee();
  }));
}

function renderDeviceList() {
  const el = connBody?.querySelector("#deviceTable");
  if (!el) return;
  if (!state.devices.length) { el.innerHTML = `<div class="dim" style="font-size:12px;padding:10px">불러오는 중…</div>`; return; }
  const head = `<div class="dev-tr dev-th"><span class="dc-name">기기</span><span class="dc-os">운영체제</span><span class="dc-date">최근 작업</span><span class="dc-act"></span></div>`;
  // 클라우드 러너는 폐기(BYO 피벗)라 "내 기기" 목록에서 숨긴다 — 사용자에겐 PC/모바일만 노출.
  const rows = state.devices.filter((d) => d.runnerKind !== 'cloud').map((d) => {
    const cur = d.isCurrent ? `<span class="dev-badge cur">이 기기</span>` : "";
    const icon = d.runnerKind === "cloud"
      ? icons.cloud({ size: 15 })
      : d.role === "controller"
        ? icons.smartphone({ size: 15 })
        : icons.monitor({ size: 15 });
    // 모바일과 동일: 클라우드/이 기기는 삭제 불가, 삭제 = 휴지통 아이콘 2탭 확인.
    const canRevoke = d.runnerKind !== "cloud" && typeof d.id === "number" && !d.isCurrent;
    const act = canRevoke ? `<button class="dev-del-btn" data-dev="${d.id}" title="기기 삭제">${icons.trash({ size: 15 })}</button>` : "";
    return `<div class="dev-tr">
      <span class="dc-name"><span class="dev-ic">${icon}</span><span class="dc-nm">${esc(d.name)}</span>${cur}<span class="dev-dot ${d.online ? "on" : "off"}" title="${d.online ? "온라인" : "오프라인"}"></span></span>
      <span class="dc-os">${esc(deviceOsLabel(d))}</span>
      <span class="dc-date">${esc(fmtRecent(d.lastSeenAt || d.createdAt))}</span>
      <span class="dc-act">${act}</span>
    </div>`;
  }).join("");
  el.innerHTML = head + rows;
  el.querySelectorAll(".dev-del-btn").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      // 1탭=무장(빨강), 2탭=삭제 — 모바일 confirmRevokeId 미러.
      if (!b.classList.contains("arm")) {
        b.classList.add("arm");
        setTimeout(() => b.classList.remove("arm"), 4000);
        return;
      }
      b.disabled = true;
      try { await api.revokeDevice(Number(b.dataset.dev)); await S.loadDevices(); } catch (_) { b.disabled = false; }
    }));
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
