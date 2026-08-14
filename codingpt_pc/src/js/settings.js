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
  revokeTrust, e2eeStateLabel, e2eeNeedsBootstrap,
  linkStart, linkClaim, bootstrapAccount,
} from "./e2ee.js";
// (개정 7: hostLockLabel/isHostRow 는 이 화면에서 쓰지 않는다 — 행별 암호화 배지와 '연결된 PC 없음'
//  행이 사라졌다. 판정 함수와 그 계약은 host-lock.js 에 그대로 남아 있다: 다시 노출하는 날 규칙을
//  재발명하지 않기 위해서고, 교차검증 테스트가 계속 그 함수를 본다.)
import { renderAgentList, loadAgents, closeAgentPanels } from "./agents-view.js";
import { markPermGranted, permGranted } from "./login-gate.js";
import {
  bindSoundSelect, openNotificationSettingsAndWatch, refreshNotificationPermission,
  sendTestNotification, soundOptionsHtml,
} from "./notification-prefs.js";
import {
  getThemeMode, setThemeMode, getUiFont, setUiFont, getMonoFont, setMonoFont,
  uiFontOptions, monoFontOptions, getTermStyle, setTermStyle,
  getLangSetting, setLangSetting, langOptions,
  TERM_STYLE_OPTIONS, termStylePalette, resolvedTheme,
} from "./theme.js";
import { IS_WINDOWS } from "./shortcuts.js";
import { chatBetaEnabled, setChatBetaEnabled } from "./chat-model.js";
import * as i18n from './i18n/index.js';

let root = null;
let navEl = null;
let contentEl = null;
let connBody = null; // 연결 탭 내부 컨테이너
let autostartChk = null;
let section = "appearance";
let connMode = null; // 'paired' | 'unpaired'
let query = "";
let webLogin = null; // 웹 로그인 폴링 세션
let scCleanup = null; // 단축키 화면의 키 가로채기 해제자(섹션 이동 시 반드시 호출)

//  ★ 2026-08-05 재편(사용자 확정) — 그룹 3개. 원문: "일반 카테고리가 너무 약한거 같은데? 일반
//   카테고리는 없어도 될거 같은데? 재배치하면서". 옛 `일반`(자동 실행 1행)·`보안`·`시스템`은 항목이
//   하나뿐인 그룹이었다 — 그룹 머리글이 항목 수보다 많으면 그건 분류가 아니라 장식이다.
//   · 옛 `일반`(로그인 시 자동 실행) + 옛 `권한 및 보안`(폴더 접근) → `시스템` 한 화면.
//     둘 다 "macOS 와의 연동"이라는 같은 성격이고, 각자 혼자서는 화면 하나를 채우지 못한다.
//   · 옛 `화면 및 편집` → `모양`(언어가 여기 산다 — 화면에 무엇이 보이는지를 정하는 설정들).
//   · 옛 `모바일 연결` → `연결`(사용자 확정: "모바일 연결 말고 연결 이라고 만 해줘").
//  ⚠ 아이콘은 항목마다 **다른 것**을 쓴다: 예전엔 sliders 가 일반·단축키 두 곳에, monitor 가
//   화면·앱 정보 두 곳에 있었다(같은 그림 = 다른 뜻 → 사이드바에서 눈이 미끄러진다).
const NAV = [
  { key: "agents", label: "에이전트", group: "작업 환경", icon: "terminal", keywords: "AI CLI Claude Codex Gemini 설치 연결" },
  { key: "appearance", label: "모양", group: "작업 환경", icon: "palette", keywords: "테마 다크 라이트 글꼴 폰트 터미널 스타일 언어 language locale 다국어 영어 english 日本語 中文 화면 편집" },
  { key: "shortcuts", label: "단축키", group: "작업 환경", icon: "keyboard", keywords: "키보드 keyboard shortcut 키 조합 팔레트 command palette 재바인딩 rebind" },
  { key: "notifications", label: "알림", group: "작업 환경", icon: "bell", keywords: "완료 승인 요청 데스크톱 권한 알림음" },
  { key: "connection", label: "계정", group: "계정 및 기기", icon: "user", keywords: "프로필 닉네임 로그인 암호화 PC 기기 로그아웃 탈퇴" },
  { key: "mobile", label: "연결", group: "계정 및 기기", icon: "smartphone", keywords: "휴대폰 태블릿 모바일 Android iOS QR 인증 코드" },
  { key: "supporter", label: "Supporter", group: "계정 및 기기", icon: "verified", keywords: "후원 구독 결제 플랜 관리 4900" },
  { key: "system", label: "시스템", group: "앱", icon: "monitor", keywords: "자동 실행 시작 로그인 권한 다운로드 데스크탑 문서 폴더 접근" },
  //  ★ 실험실(2026-08-14 사용자 확정: "베타 기능들 많아질 것 같다") — 다듬는 중인 기능의 on/off 를
  //   한자리에 모은다. 처음엔 채팅 모드를 `에이전트` 화면에 얹었는데, 베타가 늘면 각 화면에 흩어져
  //   "이건 정식인가 실험인가"를 화면마다 다시 판단해야 한다. 1항목짜리 **그룹**을 만들지 말라는
  //   기존 규율은 지킨다 — 새 그룹이 아니라 `앱` 그룹의 항목이다.
  { key: "lab", label: "실험실", group: "앱", icon: "flask", keywords: "베타 beta 실험 experimental 미리보기 채팅 chat 채팅 모드" },
  { key: "about", label: "앱 정보", group: "앱", icon: "info", keywords: "버전 업데이트" },
];

/**
 * 실험실 항목 표 — **베타 기능을 늘릴 땐 여기에 한 줄만 더한다**(화면은 이 표를 그린다).
 *  · get/set 은 그 기능의 정본 모듈이 갖는다(여기서 localStorage 를 직접 만지지 않는다).
 *  · onChange = 켜고 끈 직후 화면에 즉시 반영할 일(없으면 생략).
 */
const LAB_FEATURES = [
  {
    id: "chatBeta",
    label: "채팅 모드",
    desc: "터미널의 AI 대화를 채팅 화면으로 바꿔서 봐요. 아직 다듬는 중이라 기본은 꺼져 있어요.",
    get: chatBetaEnabled,
    set: setChatBetaEnabled,
    // 열려 있는 pane 이 **즉시** 따라야 한다(설정을 닫고 다시 열 필요가 없게).
    onChange: () => import("./pane.js").then((m) => m.refreshPaneSurfaces()).catch(() => {}),
  },
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
          <input class="sm-search-input" id="smSearch" placeholder="${i18n.t('검색')}" />
        </div>
        <div class="sm-navlist" id="smNav"></div>
      </aside>
      <div class="sm-main">
        <div class="sm-head">
          <div class="sm-head-title" id="smTitle"></div>
          <button class="sm-close" id="smClose" title="${i18n.t('닫기')}">${icons.x({ size: 18 })}</button>
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
    // 단축키 화면이 keydown 을 물고 있으면 설정을 닫아도 앱이 먹통이다.
    if (scCleanup) { try { scCleanup(); } catch (_) { /* noop */ } scCleanup = null; }
    connMode = null;
    return;
  }
  renderNav();
  renderSection(false);
}

function renderNav() {
  navEl.innerHTML = "";
  const q = query.trim().toLowerCase();
  let renderedGroup = "";
  for (const item of NAV) {
    // 검색은 번역된 이름과 원문 둘 다로 찾는다(영어로 보다가 한국어로 쳐도 찾히게).
    if (q && !`${i18n.t(item.label)} ${i18n.t(item.group)} ${item.label} ${item.group} ${item.keywords}`.toLowerCase().includes(q)) continue;
    if (item.group !== renderedGroup) {
      const group = document.createElement("div");
      group.className = "sm-navgroup";
      group.textContent = i18n.t(item.group);
      navEl.appendChild(group);
      renderedGroup = item.group;
    }
    const b = document.createElement("button");
    b.className = "sm-navitem" + (item.key === section ? " active" : "");
    b.innerHTML = `<span class="sm-navic">${icons[item.icon]({ size: 17 })}</span><span>${i18n.t(item.label)}</span>`;
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
  // 단축키 화면이 keydown 을 capture 로 가로챈 채로 떠나면 앱 전체가 먹통이 된다 — 어떤 경로로
  //  섹션이 바뀌든 여기서 먼저 푼다(단축키 섹션 자신이 다시 걸어 준다).
  if (scCleanup && section !== "shortcuts") { try { scCleanup(); } catch (_) { /* noop */ } scCleanup = null; }
  // 메인 영역 상단 헤더의 제목을 현재 섹션으로(사이드바 말고 메인에 명확히 구분된 헤더).
  const titleEl = root && root.querySelector("#smTitle");
  if (titleEl) titleEl.textContent = i18n.t((NAV.find((n) => n.key === section) || {}).label || "");
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
  } else if (section === "supporter") {
    renderSupporter();
  } else if (section === "agents") {
    // 이 PC 의 AI CLI 목록. 데몬 감지가 정본이라 화면은 그 결과를 그대로 비춘다(추측 표기 금지).
    if (force || !contentEl.querySelector("#agentsBody")) {
      // 하단 요약/설명 문단은 사용자 확정으로 제거(2026-07-27) — 목록만 둔다.
      //  (채팅 모드(베타)는 `실험실` 로 옮겼다 — 2026-08-14 사용자 확정.)
      contentEl.innerHTML = `
        <div class="sm-card2">
          <div class="sett-col"><div id="agentsBody" class="ag-list"></div></div>
        </div>`;
      const body = contentEl.querySelector("#agentsBody");
      const paint = () => renderAgentList(body, { onChange: paint });
      paint();
      loadAgents(true).then(paint).catch((e) => {
        body.innerHTML = `<div class="ag-err"></div>`;
        body.firstChild.textContent = String(e && e.message ? e.message : e);
      });
    }
  } else if (section === "lab") {
    contentEl.innerHTML = `
      <div class="sm-card2">
        ${LAB_FEATURES.map((f, i) => `
          <label class="sett-row sett-row-action" for="lab_${f.id}">
            <span class="sett-copy"><span class="sett-label">${i18n.t(f.label)}<span class="sett-beta">${i18n.t('베타')}</span></span><span class="sett-desc">${i18n.t(f.desc)}</span></span>
            <input id="lab_${f.id}" type="checkbox" class="tgl" data-lab="${i}" aria-label="${i18n.t(f.label)}" />
          </label>`).join("")}
      </div>
      <div class="sm-section-note">${i18n.t('실험실 기능은 아직 다듬는 중이라 예고 없이 바뀌거나 사라질 수 있어요.')}</div>`;
    bindLab(contentEl);
  } else if (section === "system") {
    // 시스템 — macOS 와의 연동만 모은다(로그인 항목 + 보호 폴더 접근). 각각은 카드 하나를 채우지
    //  못하는 설정이라 예전엔 `일반`·`보안` 이라는 1항목짜리 그룹으로 흩어져 있었다(2026-08-05 통합).
    //  win32: 보호 폴더(TCC)는 macOS 개념이라 카드 자체를 숨긴다. 자동 실행은 양 OS 공통(Tauri).
    contentEl.innerHTML = `
      <div class="sm-section-title">${i18n.t('시작')}</div>
      <div class="sm-card2">
        <label class="sett-row sett-row-action" for="autostartChk">
          <span class="sett-copy"><span class="sett-label">${i18n.t('로그인 시 자동 실행')}</span><span class="sett-desc">${IS_WINDOWS ? i18n.t('Windows에 로그인하면 CodingPT를 자동으로 시작해요.') : i18n.t('Mac에 로그인하면 CodingPT를 자동으로 시작해요.')}</span></span>
          <input id="autostartChk" type="checkbox" class="tgl" aria-label="${i18n.t('로그인 시 자동 실행')}" />
        </label>
      </div>
      ${IS_WINDOWS ? "" : `
      <div class="sm-section-title">${i18n.t('폴더 접근 권한')}</div>
      <div class="sm-card2">
        ${folderPermRow("downloads", i18n.t('다운로드 폴더'))}
        ${folderPermRow("desktop", i18n.t('데스크탑 폴더'))}
        ${folderPermRow("documents", i18n.t('문서 폴더'))}
        ${folderPermRow("icloud", "iCloud Drive")}
        ${folderPermRow("media", i18n.t('음악 보관함'))}
        <div class="sett-hint">${i18n.t('워크스페이스 파일을 열고 수정하는 데 필요해요.')}</div>
      </div>`}
      <div class="sm-section-note">${i18n.t('종단 간 암호화와 신뢰 기기는 ‘계정’에서 관리할 수 있어요.')}</div>`;
    autostartChk = contentEl.querySelector("#autostartChk");
    autostartChk.addEventListener("change", async () => {
      try {
        await (autostartChk.checked ? api.autostartEnable() : api.autostartDisable());
      } catch (_) {
        autostartChk.checked = !autostartChk.checked;
      }
    });
    syncAutostart();
    bindFolderPerms(contentEl);
  } else if (section === "shortcuts") {
    // 단축키 — 명령 팔레트의 목록과 **같은 표**를 그린다(commands.js). 표에 줄을 더하면 두 곳에
    //  동시에 나타난다.
    contentEl.innerHTML = `<div id="scHost"></div>`;
    const host = contentEl.querySelector("#scHost");
    // 조합을 받는 중에 화면을 떠나면 키를 계속 삼킨다 → 섹션이 바뀔 때 반드시 해제한다.
    if (scCleanup) { try { scCleanup(); } catch (_) {} scCleanup = null; }
    import("./shortcuts-view.js")
      .then((m) => { scCleanup = m.renderShortcutsInto(host); })
      .catch(() => { host.textContent = i18n.t('단축키 목록을 불러오지 못했어요.'); });
  } else if (section === "appearance") {
    contentEl.innerHTML = `
      <div class="sm-card2">
        <!-- 언어 — 계정 동기화. 목록 이름은 그 언어 자신의 표기라 번역하지 않는다
             (영어로 "Japanese" 라고 쓰면 일본어 쓰는 사람이 못 찾는다). -->
        <div class="sett-row"><span>${i18n.t('언어')}</span><div class="fd" id="langDd"></div></div>
        <div class="sett-row"><span>${i18n.t('테마')}</span>
          <span class="scale-seg seg-ic" id="themeSeg">
            <button class="scale-opt" data-v="system" title="${i18n.t('시스템')}" aria-label="${i18n.t('시스템')}">${icons.monitor({ size: 15 })}</button>
            <button class="scale-opt" data-v="light" title="${i18n.t('라이트')}" aria-label="${i18n.t('라이트')}">${icons.sun({ size: 15 })}</button>
            <button class="scale-opt" data-v="dark" title="${i18n.t('다크')}" aria-label="${i18n.t('다크')}">${icons.moon({ size: 15 })}</button>
          </span>
        </div>
        <div class="sett-row"><span>${i18n.t('인터페이스 글꼴')}</span><div class="fd" id="uiFontDd"></div></div>
        <div class="sett-row"><span>${i18n.t('코드·터미널 글꼴')}</span><div class="fd" id="monoFontDd"></div></div>
        <div class="sett-col"><span>${i18n.t('터미널 스타일')}</span><div class="ts-grid" id="termStyleGrid"></div></div>
        <div class="sett-hint">${i18n.t('글꼴·터미널 스타일은 계정의 모든 기기(PC·모바일)에 함께 적용돼요. 터미널 스타일은 앱 테마(다크/라이트)에 맞는 변형이 자동 선택돼요.')}</div>
      </div>
      `;
    bindAppearance(contentEl);
  } else if (section === "notifications") {
    contentEl.innerHTML = `
      <div id="notifWarning"></div>
      <div class="sm-card2">
        <div class="sett-row">
          <span class="sett-copy"><span class="sett-label">${i18n.t('알림 권한')}</span><span class="sett-desc">${i18n.t('작업 완료와 승인 요청을 백그라운드에서도 알려줘요.')}</span></span>
          <span id="notifPermState" class="sett-attn">${i18n.t('확인 중…')}</span>
        </div>
        <div class="sett-row">
          <span class="sett-copy"><span class="sett-label">${i18n.t('알림음')}</span><span class="sett-desc">${i18n.t('이 PC에서 전달되는 데스크톱 알림에 적용돼요.')}</span></span>
          <span class="notif-controls">
            <select id="notifSound" class="sett-select" aria-label="${i18n.t('알림음')}">${soundOptionsHtml()}</select>
            <button id="notifTest" class="sett-btn">${i18n.t('테스트 알림')}</button>
          </span>
        </div>
      </div>
      `;
    bindNotificationSettings(contentEl);
  } else if (section === "mobile") {
    // ★ 코드를 못 만들면 **이유를 말한다**(2026-08-15 실사고). 예전엔 실패해도 `다시 시도` 버튼만
    //  남아, 눌러도 같은 403 이 조용히 반복됐다 — 화면에는 아무 설명이 없었다(진짜 원인: 다른 PC 가
    //  계정 열쇠를 다시 만들어 이 PC 가 링에서 빠짐 → 서버가 NOT_TRUSTED 로 거절).
    //  그리고 이 PC 에 열쇠가 없을 때는 기다리라고만 하지 않는다 — 열쇠를 가진 기기가 있으면
    //  **그 기기의 코드를 여기서 입력**하는 길(=유일한 회복 경로)을 같은 자리에 둔다.
    const otherKeyed = (e2ee.devices || []).some((d) => !d.isThisDevice && d.state === "trusted");
    const claimBox = `<div class="link-entry">
        <input id="linkCodeInput" class="acct-del-input" maxlength="8" placeholder="${i18n.t('8자 코드')}" autocomplete="off" spellcheck="false" style="text-transform:uppercase;letter-spacing:2px" />
        <button class="sett-btn" data-link-submit="self">${i18n.t('연결')}</button>
      </div>`;
    const codeHtml = e2eeReady()
      ? `<div class="sett-col">
          <span class="sett-label">${i18n.t('이 기기 인증 코드')}</span>
          <div class="link-box">
            ${myLinkBusy ? `<div class="acct-msg">${i18n.t('코드를 만드는 중…')}</div>` : ""}
            ${validMyLink() ? `<div class="link-code">${esc(myLink.code)}</div><div class="acct-msg">${i18n.t('모바일 앱에서 이 코드를 입력하세요.')}</div>` : ""}
            ${!myLinkBusy && !validMyLink() ? `${linkEntryMsg ? `<div class="acct-msg">${esc(linkEntryMsg)}</div>` : ""}<button class="sett-btn" data-link-new="1">${i18n.t('다시 시도')}</button>` : ""}
          </div>
        </div>`
      : `<div class="sett-col">
          <span class="sett-label">${i18n.t('이 기기 인증 코드')}</span>
          <div class="acct-msg">${esc(e2ee.reason || i18n.t('암호화 연결을 준비하고 있어요…'))}</div>
          ${otherKeyed ? `<div class="sett-hint">${i18n.t('암호화 열쇠가 있는 다른 기기에서 코드를 발급해 여기에 입력하세요.')}</div>${claimBox}${linkEntryMsg ? `<div class="acct-msg">${esc(linkEntryMsg)}</div>` : ""}
          <div class="sett-hint" style="margin-top:10px">${i18n.t('그 기기를 쓸 수 없다면 이 PC 를 새 기준으로 삼을 수 있어요 — 다른 기기는 모두 다시 연결해야 해요.')}</div>
          <div><button class="sett-btn" data-e2ee-reboot="1">${i18n.t('이 PC 로 열쇠 다시 만들기')}</button></div>` : ""}
        </div>`;
    contentEl.innerHTML = `
      <div class="sm-card2">
        ${codeHtml}
        <div class="sett-hint">${i18n.t('코드는 이 PC에서 실행하고, 화면은 모바일에서 이어받아요. 카메라로 QR을 스캔해 앱을 설치하세요.')}</div>
        <div class="qr-row">
          <div class="qr-tile">
            <div class="qr-imgwrap"><img class="qr-img" src="${ANDROID_QR}" alt="${i18n.t('Android 앱 설치 QR')}" draggable="false"></div>
            <div class="qr-plat">${icons.smartphone({ size: 15 })}<span>Android</span></div>
          </div>
          <div class="qr-tile">
            <div class="qr-imgwrap"><img class="qr-img" src="${IOS_QR}" alt="${i18n.t('iOS 앱 설치 QR')}" draggable="false"></div>
            <div class="qr-plat">${icons.smartphone({ size: 15 })}<span>iOS</span></div>
          </div>
        </div>
      </div>`;
    bindE2ee(contentEl);
    if (e2eeReady() && !validMyLink() && !myLinkBusy && Date.now() - myLinkFailedAt > MY_LINK_RETRY_MS) {
      queueMicrotask(() => { void ensureMyLink(); });
    }
  } else {
    // force 이거나 미구성일 때만 재구성 — emit(리컨실러 등)마다 통째 리렌더하면
    // 업데이트 진행 상태("새 버전 N"/"다운로드 %")가 몇 초마다 초기화되는 버그가 된다.
    if (!force && contentEl.querySelector("#updBtn")) return;
    contentEl.innerHTML = `
      <div class="sm-card2">
        <div class="sett-row"><span>${i18n.t('버전')}</span><span class="dim sel-text" id="appVerLabel">CodingPT PC …</span></div>
        <div class="sett-row"><span>${i18n.t('업데이트')}</span>
          <span style="display:inline-flex;align-items:center;gap:14px;">
            <span class="dim" id="updStatus" style="min-width:76px;text-align:right;">-</span>
            <button class="sett-btn" id="updBtn">${i18n.t('확인')}</button>
          </span>
        </div>
      </div>`;
    // 실제 앱 버전으로 채움(하드코딩 금지 — 업데이트되면 자동 반영). 실패해도 조용히(dev 등).
    api.appVersion().then((v) => { const el = contentEl.querySelector("#appVerLabel"); if (el && v) el.textContent = `CodingPT PC ${v}`; }).catch(() => {});
    bindUpdate();
  }
}

// Personal 기능은 기기 수 제한 없이 무료다. Supporter는 기능 잠금 해제가 아니라 개발과
// 릴레이 서버 운영을 돕는 선택 구독이므로, 설정에서도 과장된 비교표 없이 상태와 한 행동만 보여준다.
async function renderSupporter() {
  if (!state.daemon?.paired) {
    contentEl.innerHTML = `
      <div class="sm-card2 supporter-card">
        <div class="supporter-copy"><b>${i18n.t('로그인 후 Supporter를 구독할 수 있어요.')}</b><span>${i18n.t('Personal의 모든 원격 작업 기능은 무료로 제공돼요.')}</span></div>
        <button id="supporterLogin" class="sett-btn">${i18n.t('로그인하기')}</button>
      </div>`;
    contentEl.querySelector("#supporterLogin")?.addEventListener("click", () => {
      section = "connection"; renderNav(); renderSection(true);
    });
    return;
  }

  contentEl.innerHTML = `
    <div class="sm-card2 supporter-card">
      <div class="supporter-copy"><b>${i18n.t('구독 상태를 확인하고 있어요…')}</b><span>${i18n.t('Personal의 모든 원격 작업 기능은 무료로 제공돼요.')}</span></div>
    </div>`;
  try {
    const sub = await api.subscriptionMe();
    if (section !== "supporter") return;
    const active = sub && sub.planCode === "supporter" && ["active", "past_due"].includes(sub.status);
    const pastDue = active && sub.status === "past_due";
    const end = sub?.currentPeriodEnd ? fmtDate(sub.currentPeriodEnd) : "";
    contentEl.innerHTML = active ? `
      <div class="sm-section-title">${i18n.t('현재 플랜')}</div>
      <div class="sm-card2 supporter-card">
        <div class="supporter-copy">
          <span class="supporter-plan">CodingPT Supporter</span>
          <b>${pastDue ? "결제 확인이 필요해요" : "함께해 주셔서 고마워요."}</b>
          <span>${pastDue ? "구독 관리에서 결제 수단을 확인해 주세요." : (end ? `${end}까지 이용 중이에요.` : "월 ₩4,900 구독을 이용 중이에요.")}</span>
        </div>
        <button id="supporterAction" class="sett-btn">${i18n.t('구독 관리')}</button>
      </div>` : `
      <div class="sm-section-title">${i18n.t('선택 후원 구독')}</div>
      <div class="sm-card2 supporter-card">
        <div class="supporter-copy">
          <b>${i18n.t('월 ₩4,900으로 CodingPT를 응원해 주세요.')}</b>
        </div>
        <button id="supporterAction" class="sett-btn">${i18n.t('웹에서 구독하기')}</button>
      </div>`;
    const action = contentEl.querySelector("#supporterAction");
    action?.addEventListener("click", async () => {
      action.disabled = true;
      const original = action.textContent;
      action.textContent = i18n.t('브라우저 여는 중…');
      try {
        const result = active ? await api.supporterPortal() : await api.supporterCheckout();
        if (!result?.url) throw new Error(i18n.t('결제 페이지 주소가 없습니다.'));
        await api.openExternal(result.url);
        action.textContent = active ? i18n.t('구독 관리 열림') : i18n.t('결제 페이지 열림');
      } catch (e) {
        action.disabled = false;
        action.textContent = original;
        const msg = document.createElement("div");
        msg.className = "supporter-error";
        msg.textContent = String(e?.message || e).replace(/^HTTP \d+\s*:?\s*/, "");
        contentEl.querySelector(".supporter-card")?.appendChild(msg);
      }
    });
  } catch (e) {
    if (section !== "supporter") return;
    contentEl.innerHTML = `
      <div class="sm-card2 supporter-card">
        <div class="supporter-copy"><b>${i18n.t('구독 상태를 불러오지 못했어요.')}</b><span>${i18n.t('잠시 후 다시 시도해 주세요.')}</span></div>
        <button id="supporterRetry" class="sett-btn">${i18n.t('다시 시도')}</button>
      </div>`;
    contentEl.querySelector("#supporterRetry")?.addEventListener("click", renderSupporter);
  }
}

function bindNotificationSettings(host) {
  const select = host.querySelector("#notifSound");
  const test = host.querySelector("#notifTest");
  const status = host.querySelector("#notifPermState");
  const warning = host.querySelector("#notifWarning");
  bindSoundSelect(select);

  const paintPermission = (value) => {
    const granted = value === "granted";
    if (granted) markPermGranted("notification");
    status.className = granted ? "sett-done" : "sett-attn";
    status.innerHTML = granted ? `${icons.check({ size: 14 })}허용됨` : i18n.t('확인 필요');
    warning.innerHTML = granted ? "" : `
      <div class="notif-warning">
        <span class="notif-warning-copy"><b>${i18n.t('macOS가 CodingPT 알림을 전달하지 않고 있어요.')}</b><small>${i18n.t('시스템 설정에서 CodingPT 알림을 허용해 주세요.')}</small></span>
        <button id="notifOpenSettings" class="sett-btn">${i18n.t('시스템 설정 열기')}</button>
      </div>`;
    warning.querySelector("#notifOpenSettings")?.addEventListener("click", async (e) => {
      const open = e.currentTarget;
      open.disabled = true;
      open.textContent = i18n.t('여는 중…');
      try {
        await openNotificationSettingsAndWatch((next) => paintPermission(next));
        open.textContent = i18n.t('시스템 설정 열림');
      } catch (_) {
        open.disabled = false;
        open.textContent = i18n.t('다시 시도');
      }
    });
  };
  refreshNotificationPermission().then((p) => paintPermission(p === "unknown" && permGranted("notification") ? "granted" : p));

  test.addEventListener("click", async () => {
    test.disabled = true;
    test.textContent = i18n.t('보내는 중…');
    try {
      const ok = await sendTestNotification();
      if (ok) {
        markPermGranted("notification");
        paintPermission("granted");
        test.textContent = i18n.t('보냈어요 ✓');
      } else {
        paintPermission("denied");
        test.textContent = i18n.t('설정 확인');
      }
    } catch (_) {
      test.textContent = i18n.t('다시 시도');
    }
    setTimeout(() => { if (test.isConnected) { test.disabled = false; test.textContent = i18n.t('테스트 알림'); } }, 1200);
  });
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
      st.textContent = i18n.t('실패: ') + e;
      btn.disabled = false;
      btn.textContent = i18n.t('업데이트');
    }
  };

  // 열릴 때 자동 확인 — 버튼은 새 버전이 있을 때만 노출.
  btn.style.display = "none";
  st.textContent = i18n.t('확인 중…');
  api
    .updateCheck()
    .then((r) => {
      if (r && r.available) {
        st.textContent = "";
        btn.textContent = i18n.t('업데이트');
        btn.style.display = "";
        btn.onclick = doInstall;
      } else {
        st.textContent = r && r.error ? i18n.t('확인 불가(개발 실행에선 미지원)') : i18n.t('최신 버전입니다');
      }
    })
    .catch(() => {
      st.textContent = i18n.t('확인 실패');
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
    //  ⚠ `stack`(글꼴 스택)은 **선택**이다 — 언어 드롭다운은 같은 부품을 쓰지만 옵션을 특정 글꼴로
    //   그리지 않는다. 여기서 `cur.stack.replace(...)` 를 무조건 부르면 언어 목록에서 TypeError 가
    //   나고, 그러면 이 함수 이후의 **글꼴 2개와 터미널 스타일까지 통째로 안 그려진다**(2026-08-05
    //   실사고 — 화면에는 빈 알약 하나와 빈 행 셋만 남았다). 없으면 없는 대로 그린다.
    const paintBtn = () => {
      const cur = opts.find((o) => o.value === getCur()) || opts[0];
      if (!cur) return;
      const font = cur.stack ? ` style="font-family:${String(cur.stack).replace(/"/g, "&quot;")}"` : "";
      btn.innerHTML = `<span${font}>${esc(cur.label)}</span><span class="fd-caret">${icons.chevronDown({ size: 13 })}</span>`;
      menu.querySelectorAll(".fd-opt").forEach((el) => el.classList.toggle("sel", el.dataset.v === getCur()));
    };
    for (const o of opts) {
      const it = document.createElement("button");
      it.className = "fd-opt";
      it.dataset.v = o.value;
      if (o.stack) it.style.fontFamily = o.stack;
      it.innerHTML = `<span class="fd-name">${esc(o.label)}</span>${sample ? `<span class="fd-sample">${esc(sample)}</span>` : ""}`;
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
      try { opts.forEach((o) => { if (o.stack) document.fonts?.load?.(`13px ${o.stack}`); }); } catch (_) {}
      menu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => menu.classList.add("hidden"));
    host.append(btn, menu);
    paintBtn();
    host._repaint = paintBtn;
  };
  // 언어 드롭다운 — 글꼴 드롭다운과 같은 부품을 쓴다(옵션을 그 글꼴로 그리는 기능만 안 쓴다).
  //  고르면 theme.js 가 서버 저장 후 창을 새로고침한다(명령형 DOM 이라 다시 그려야 반영된다).
  buildFontDd(rootEl.querySelector("#langDd"), langOptions().map((o) => ({ value: o.value, label: o.label })),
    getLangSetting, setLangSetting, "");
  buildFontDd(rootEl.querySelector("#uiFontDd"), uiFontOptions(), getUiFont, setUiFont, i18n.t('한글과 English 123'));
  buildFontDd(rootEl.querySelector("#monoFontDd"), monoFontOptions(), getMonoFont, setMonoFont, i18n.t('const 한글 = i => 0;'));

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
            <span class="ts-seg" style="background:${seg1};color:${onColor(seg1)}">user@${IS_WINDOWS ? "pc" : "mac"}</span><span class="ts-tri" style="border-left-color:${seg1};background:${seg2}"></span><span class="ts-seg" style="background:${seg2};color:${onColor(seg2)}">~/project</span><span class="ts-tri" style="border-left-color:${seg2}"></span>
          </div>
          <div class="ts-line" style="color:${p.foreground}">claude&nbsp;<span style="opacity:.75">${i18n.t('코드 설명해줘')}</span></div>
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
  if (!me) return `<div class="sm-card2"><div class="dim" style="font-size:13px">${i18n.t('로그인하면 프로필이 표시됩니다.')}</div></div>`;
  const initial = (me.nickname || me.email || "U").trim().charAt(0).toUpperCase();
  const avatar = me.profileImg
    ? `<img class="acct-img" src="${esc(me.profileImg)}" alt="" />`
    : `<span class="acct-initial">${esc(initial)}</span>`;
  return `<div class="sm-card2">
      <div class="prof">
        <div class="acct-avatar big">${avatar}</div>
        <div class="prof-main">
          <div class="prof-nick-row">
            <input id="nickInput" class="prof-nick" value="${esc(me.nickname || "")}" placeholder="${i18n.t('닉네임')}" maxlength="40" spellcheck="false" />
            <button id="nickSave" class="btn small">${i18n.t('저장')}</button>
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
  //  ★ 개정 9(2026-07-28 사용자 확정) — 계정 화면의 순서와 그룹:
  //   ① 프로필 ② `이 기기` ③ `다른 기기` ④ 로그아웃 ⑤ 회원 탈퇴.
  //   · 원문 "이기기, 다른 기기로 그룹을 나눠서 해주고" → 구 제목 `기기` 아래의 소제목 두 개(개정 7)를
  //     **그룹(섹션) 자체**로 올렸다. 제목이 남으면 계층이 3겹(기기 > 이 기기 > 행)이었다.
  //   · 원문 "로그아웃과 회원탈퇴는 설정 > 계정에서 제일 아래로 내려줘! pc, andorid, ios 다!" →
  //     파괴적·희귀 동작이 프로필 바로 밑(첫 화면 상단)에서 매일 보는 기기 관리보다 먼저 읽혔다.
  connBody.innerHTML = `
    <div id="acctCard">${profileCardHtml()}</div>
    <div class="dev-section">
      <div class="dev-title" style="margin:0 2px 8px">${i18n.t('이 기기')}</div>
      <div id="e2eeSelfBox" class="sm-card2"></div>
    </div>
    <div class="dev-section">
      <div class="dev-title" style="margin:0 2px 8px">${i18n.t('다른 기기')}</div>
      <div id="e2eeBox" class="sm-card2"></div>
    </div>
    <div class="acct-line">
      <div class="acct-line-txt">${i18n.t('이 기기에서 로그아웃')}</div>
      <button id="unpairBtn" class="btn small">${i18n.t('로그아웃')}</button>
    </div>
    <div class="acct-line">
      <div class="acct-line-txt">${i18n.t('회원 탈퇴 시 계정과 모든 데이터가 삭제되며 되돌릴 수 없습니다.')}</div>
      <button id="deleteAcctBtn" class="btn small danger">${i18n.t('회원 탈퇴')}</button>
    </div>
    <div id="acctMsg" class="acct-msg"></div>`;
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
//  ⚠ 행마다 같은 설명("워크스페이스 파일을 열고…")을 붙이지 않는다: 세 줄이 글자까지 같으면
//   그건 정보가 아니라 소음이고, 행 높이만 두 배가 된다. 설명은 카드 아래 한 줄로 모았다.
function folderPermRow(id, label) {
  const copy = `<span class="sett-copy"><span class="sett-label">${label}</span></span>`;
  if (permGranted(id)) {
    return `<div class="sett-row">${copy}<span class="sett-done">${icons.check({ size: 14 })}허용됨</span></div>`;
  }
  return `<div class="sett-row">${copy}<button class="sett-btn fpa-btn" data-f="${id}">${i18n.t('허용')}</button></div>`;
}

// 보호 폴더(다운로드/데스크탑/문서) 접근 허용 — 클릭 시 프로브(최초엔 macOS 팝업).
//  허용=버튼 '허용됨' 고정, 거부=버튼이 '설정 열기'(파일 및 폴더 설정)로 전환.
// 실험실 토글 — LAB_FEATURES 표의 get/set 을 그대로 쓴다(화면은 값을 갖지 않는다).
//  켜고 끄면 그 기능이 **즉시** 반영돼야 한다(설정을 닫고 다시 열 필요가 없게).
function bindLab(rootEl) {
  rootEl.querySelectorAll("[data-lab]").forEach((chk) => {
    const f = LAB_FEATURES[Number(chk.dataset.lab)];
    if (!f) return;
    chk.checked = !!f.get();
    chk.addEventListener("change", () => {
      f.set(chk.checked);
      f.onChange?.();
      S.emit();
    });
  });
}

function bindFolderPerms(rootEl) {
  rootEl.querySelectorAll(".fpa-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      if (b.dataset.denied) { api.openFilesPrivacy().catch(() => {}); return; }
      b.disabled = true;
      const prev = b.textContent;
      b.textContent = i18n.t('확인 중…');
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
        b.textContent = i18n.t('설정 열기');
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
    save.textContent = i18n.t('저장 중…');
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
    btn.textContent = i18n.t('취소');
    btn.classList.remove("danger");
    //  ★ 개정 10(사용자 확정): 경고색은 **버튼 하나만**(과한 색은 AI 스러움). 문구·테두리·입력창은 일반색.
    msg.innerHTML = `
      <div class="acct-del-confirm">
        <div>${i18n.t('계속하려면')} <b>${DELETE_CONFIRM_WORD}</b> ${i18n.t('를 입력하세요.')}</div>
        <input id="acctDelEmail" class="acct-del-input" placeholder="${DELETE_CONFIRM_WORD}" autocomplete="off" spellcheck="false" />
        <button id="acctDelGo" class="acct-del-go">
          <span class="acct-del-spin"></span><span class="acct-del-go-txt">${i18n.t('영구 삭제')}</span>
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
  btn.textContent = i18n.t('회원 탈퇴');
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
  if (goTxt) goTxt.textContent = i18n.t('탈퇴 처리 중…');
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
    if (goTxt) goTxt.textContent = i18n.t('영구 삭제');
    if (btn) btn.disabled = false;
    if (errEl) errEl.textContent = i18n.t('탈퇴 실패: ') + (e?.message || e);
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
// (개정 12: 구 '코드 확인' 접기 상태 삭제 — 안전 코드 대조 화면 자체가 사라졌다)

const TONE_C = { on: "var(--accent)", wait: "var(--warn, #FBBF24)", off: "var(--dim)" };

/**
 * self 배지 — 카드/섹션 제목 행 **우측**에 그린다(앱 카드 헤더와 같은 계층).
 *  ★ 판정은 e2ee-label.js(= e2eeStateLabel)가 정본이다. 여기서 `state` 만 다시 분기하면 데몬이
 *   진행상태 정본으로 주는 keyState/checking 이 화면에 반영되지 않아 "확인 중" 과 "확인 끝났고
 *   열쇠 0개(영구 평문)" 가 같은 대기색으로 보인다(둘 다 state='bootstrap' 이다).
 *  ⚠ '켜짐' 이라고 쓰지 않는다: 이 PC 의 열쇠 보유는 트래픽이 암호화된다는 뜻이 아니다(상대 호스트도
 *   열쇠가 있어야 한다) — 그게 거짓 자물쇠의 근원이었다. 실제 자물쇠는 PC 별 배지가 그린다.
 */
//  (★ 개정 12: `e2eeSelfWaiting`(이 PC 가 승인을 기다리는가) 삭제 — 승인 절차 자체가 없어졌다.
//   이 PC 에 열쇠가 없으면 `다른 기기` 목록에서 상대의 코드를 입력한다.)

function e2eeActionRow() {
  //  ★ 개정 12(사용자 확정): 승인·대기 지시문은 **전부 삭제**됐다. 이 기기 영역이 갖는 것은
  //   `자세히 보기`(= 이 기기의 연동 코드)뿐이고, 그건 아래 e2eeMyCodeRow 가 그린다.
  //   부트스트랩 진행만 남긴다(수 초짜리 과도 상태 — 빈 화면으로 두지 않는다).
  if (e2eeNeedsBootstrap()) {
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div class="acct-msg" style="padding:2px 0">${e2ee.autoBootError ? "암호화를 켜지 못했어요 · 잠시 후 다시 시도합니다" : "암호화를 준비하고 있어요…"}</div>
    </td></tr>`;
  }
  return "";
}

/**
 * 이 기기의 **연동 코드**(★ 개정 13) — 로그인 후 키가 준비되는 즉시 자동으로 만들어 항상 보여 준다.
 *  다른 기기가 이 코드를 입력하면 그 자리에서 열쇠가 전달된다(승인 화면 없음).
 *  코드는 3분 만료·1회용이고, 이 화면을 보는 동안 만료되면 자동 갱신한다. 서버에는 **해시만**
 *  올라간다(데몬 e2ee-account linkStart).
 */
let linkEntryFor = null;   // 코드 입력 칸을 연 기기 행 id
let linkEntryMsg = "";     // 그 칸의 오류/진행 문구
let aliasEditFor = null;
let aliasEditValue = "";
let aliasEditError = "";
let myLink = null;      // { code, until, ref, revision } — 표시 중인 코드
let myLinkBusy = false;
let myLinkTimer = null;
//  ★ 마지막 발급 실패 시각 — 자동 재요청의 브레이크. 발급이 실패하면 화면을 다시 그리는데,
//   그 렌더가 다시 자동 발급을 부르므로(아래 renderSection 의 queueMicrotask) 서버가 403 을 주는
//   동안 요청이 무한히 반복된다. 실패 후 잠깐은 사람이 [다시 시도] 를 누를 때만 나간다.
let myLinkFailedAt = 0;
const MY_LINK_RETRY_MS = 30000;

function validMyLink() {
  return !!(myLink && myLink.until > Date.now()
    && myLink.revision === e2ee.linkRevision
    && (!myLink.ref || !e2ee.userRef || myLink.ref === e2ee.userRef));
}

function scheduleMyLinkRenewal() {
  if (myLinkTimer) clearTimeout(myLinkTimer);
  myLinkTimer = null;
  if (!validMyLink()) return;
  const wait = Math.max(1000, myLink.until - Date.now() - 1000);
  myLinkTimer = setTimeout(() => {
    myLinkTimer = null;
    myLink = null;
    if (state.view === "settings" && (section === "connection" || section === "mobile") && e2eeReady()) void ensureMyLink();
  }, wait);
}

async function ensureMyLink({ force = false } = {}) {
  if (!e2eeReady() || myLinkBusy || (!force && validMyLink())) return;
  myLinkBusy = true;
  renderE2ee();
  const r = await linkStart();
  myLinkBusy = false;
  myLink = r.ok ? {
    code: r.code,
    until: Date.now() + (r.ttlMs || 180000),
    ref: e2ee.userRef || "",
    revision: e2ee.linkRevision,
  } : null;
  myLinkFailedAt = r.ok ? 0 : Date.now();
  linkEntryMsg = r.ok ? "" : (r.error || i18n.t('인증 코드를 만들지 못했어요'));
  scheduleMyLinkRenewal();
  if (section === "mobile") renderSection(true);
  else renderE2ee();
}

function e2eeMyCodeRow() {
  // 로그인된 PC에서는 인증 코드가 항상 같은 자리에 실제 값으로 보여야 한다. 키를 준비하는 짧은
  // 구간만 진행 상태를 표시하고, 준비 완료 emit 직후 ensureMyLink 가 실제 8자리 코드를 채운다.
  if (!e2eeReady()) {
    return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
      <div class="appr-reveal" aria-label="${i18n.t('이 기기 인증 코드 준비 중')}">${i18n.t('이 기기 인증 코드')}</div>
      <div class="acct-msg">${e2ee.autoBootError ? "암호화 연결을 준비하지 못했어요 · 잠시 후 다시 시도합니다" : "암호화 연결을 준비하고 있어요…"}</div>
    </td></tr>`;
  }
  //  ★ 계정이 바뀌면(재가입·계정 전환) 옛 코드는 **다른 계정의 코드**라 입력해도 404 다(실사고).
  //   표시 중인 코드에 발급 계정(userRef)을 달아 두고, 달라지면 즉시 버린다.
  if (myLink && myLink.ref && e2ee.userRef && myLink.ref !== e2ee.userRef) {
    myLink = null;
    scheduleMyLinkRenewal();
  }
  if (myLink && myLink.revision !== e2ee.linkRevision) {
    myLink = null;
    scheduleMyLinkRenewal();
  }
  const left = myLink ? Math.max(0, Math.floor((myLink.until - Date.now()) / 1000)) : 0;
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return `<tr class="dev-tr"><td class="dev-c-full" colspan="4">
    <div class="appr-reveal">${i18n.t('이 기기 인증 코드')}</div>
    <div class="link-box">
      ${myLinkBusy ? `<div class="acct-msg">${i18n.t('코드를 만드는 중…')}</div>` : ""}
      ${myLink && left > 0 ? `<div class="link-code">${esc(myLink.code)}</div>
        <div class="acct-msg">다른 기기에서 이 코드를 입력하세요 · ${mm} 남음</div>` : ""}
      ${!myLinkBusy && (!myLink || left <= 0) ? `<button class="sett-btn" data-link-new="1">${i18n.t('다시 시도')}</button>` : ""}
    </div>
  </td></tr>`;
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
function e2eeDeviceRowsHtml(devs, selfReady, { mine } = {}) {
  const all = (state.devices || []).filter((d) => d.runnerKind !== "cloud"); // 클라우드 러너는 숨긴다(BYO 피벗)
  // ⚠ 기기 목록이 아직 안 왔으면 **고아 판정을 하지 않는다**: 키링이 먼저 도착하면 모든 열쇠가 '고아' 로
  //  보여 같은 기기가 두 번 뜨는 화면(합치려던 그 중복)이 로딩 중에 재현된다.
  if (!all.length) return `<tr class="dev-tr"><td class="dev-c-full dim" colspan="4" style="font-size:12px">${i18n.t('불러오는 중…')}</td></tr>`;
  const keyByDevice = new Map();
  // 열쇠 보유 판정은 `state === "trusted"` 하나다(앱 trustedKeys 와 같은 조건 — pending/revoked 는 열쇠가 아니다).
  for (const k of devs) if (k.state === "trusted" && k.deviceId != null) keyByDevice.set(String(k.deviceId), k);
  const ids = new Set(all.map((d) => String(d.id)));
  const orphans = devs.filter((k) => k.state === "trusted" && (k.deviceId == null || !ids.has(String(k.deviceId))));

  //  ★ 개정 7(2026-07-28 사용자 확정): **이 기기와 다른 기기를 나눈다.** 원문 — "기기 목록에 이 기기까지
  //   표현하니까 보기도 안 좋고 복잡해지는 거 같은데! 이 기기와 내 기기 목록을 따로 구분하는 건 어떨까?
  //   기기 목록에서는 이 기기는 안 보이게 하고!" → 목록은 **다른 기기 전용**이고 이 기기는 위에 한 줄이다.
  //   그래서 `이 기기` accent 배지도 없앴다(자리로 이미 구분된다 = 사용자가 지적한 과한 포인트 컬러).
  //  ★ 개정 9: 두 목록이 **각자의 섹션 카드**로 갈라졌다(소제목 폐기) → 이 함수는 `mine` 으로 한쪽만 그린다.
  const row = (d) => {
    const k = keyByDevice.get(String(d.id));
    const canRevoke = typeof d.id === "number" && !d.isCurrent;
    //  연동 여부 = 그 기기가 계정 열쇠를 갖고 있는가. 안 됐으면 [연동] 이 승인 절차를 다시 시작한다.
    //  ⚠ 이 기기 행에는 [연동] 을 두지 않는다: 자기를 자기가 승인할 수는 없다.
    //  ⚠ **승인 대기 중인 행에도 두지 않는다**(개정 9): 요청이 이미 갔고 지금 할 일은 승인/거절 하나다.
    const linked = !!k || (d.isCurrent && selfReady);
    //  ★ 개정 11(사용자 확정): [연동] 은 **PC(host) 행에만** 둔다. 원문 — "저 기기는 모바일 기기자나
    //   android, ios 그러면 그 녀석을 연동요청해봐야 내 pc에서는 이득이 없자나? 모바일이나 태블릿
    //   같은거에서 지금 pc에 연동 승인 요청하거나 다른 pc에서 이 pc에 연동 승인 요청하는 방향".
    //   즉 연동을 **요청하는 쪽**은 모바일·다른 PC 이고, 이 화면에서 누를 이유가 있는 대상은 PC 뿐이다.
    //  ★ 개정 12: [연동] = **코드 입력 열기**(그 행 아래 인라인). 승인 요청을 보내던 구 nudge 는 폐기.
    //   ⚠ 조건은 "**이 기기**에 열쇠가 없고, 그 행이 **열쇠를 가진 기기**" 다: 연동이란 열쇠를 받는
    //    일이고, 줄 수 있는 쪽은 열쇠를 가진 기기뿐이다(열쇠 없는 기기끼리는 서로 줄 것이 없다).
    const canLink = typeof d.id === "number" && !d.isCurrent && (selfReady ? !linked : !!k);
    const link = canLink
      ? `<button class="dev-link-btn" ${selfReady ? `data-link-show-code="${d.id}"` : `data-link-open="${d.id}"`} title="${i18n.t('이 기기와 연동')}" aria-label="${i18n.t('이 기기와 연동')}">${icons.link({ size: 15 })}</button>` : "";
    const linkedMark = linked
      ? `<span class="dev-auth-mark" title="${i18n.t('인증된 기기')}" aria-label="${i18n.t('인증된 기기')}">${icons.verified({ size: 15 })}</span>` : "";
    //  ★ 개정 9: 대기 행 = **미확인 알림**이다. 이름 옆 점(accent = 상태 신호 전용) + 메타 `승인 대기` +
    //   행 클릭 → 화면 상단 전역 승인 카드(설정 모달을 닫고 그 카드를 되살린다).
    //  ★ 개정 11(사용자 확정): 목록에 **연동됨/안 됨을 쓰지 않는다** — "기기 목록에서 연동됨 안됨
    //   이런거 표현하지마!". 남는 것은 최근 시각뿐이고, 할 일이 있는 상태(승인 대기)만 말한다.
    // ⚠ 무장 경고는 **별도 행**(colspan)이다: 같은 셀에 넣으면 그 행만 높이가 늘어 열 정렬이 흔들린다.
    const editing = d.isCurrent && aliasEditFor === String(d.id);
    const nameCell = editing
      ? `<span class="dev-alias-edit"><input class="dev-alias-input" maxlength="40" value="${esc(aliasEditValue)}" aria-label="${i18n.t('기기 별칭')}" /><button class="dev-alias-save" data-alias-save="${d.id}">${icons.check({ size: 14 })}</button><button class="dev-alias-cancel" data-alias-cancel="1">${icons.x({ size: 14 })}</button></span>`
      : `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name || "기기")}</span>${d.isCurrent ? `<button class="dev-alias-btn" data-alias-edit="${d.id}" title="${i18n.t('별칭 변경')}">${icons.edit({ size: 13 })}</button>` : ""}`;
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${d.role === "controller" ? icons.smartphone({ size: 15 }) : icons.monitor({ size: 15 })}</span></td>
      <td class="dev-c-name"><span class="dev-name">${linkedMark}${nameCell}</span>${editing && aliasEditError ? `<div class="acct-msg" style="color:var(--error,#ef6b73)">${esc(aliasEditError)}</div>` : ""}</td>
      <td class="dev-c-meta"></td>
      <td class="dev-c-del" style="white-space:nowrap">${link}${canRevoke ? `<button class="dev-del-btn" data-dev="${d.id}"${k ? ` data-dev-key="${k.deviceKeyId}"` : ""} title="${i18n.t('기기 삭제')}">${icons.trash({ size: 15 })}</button>` : ""}</td>
    </tr>
    ${canRevoke ? `<tr class="dev-tr-note" data-dev-armnote="${d.id}" style="display:none"><td colspan="4"><div class="dev-delete-confirm">${icons.shield({ size: 14 })}<span>${i18n.t('한 번 더 누르면 이 기기를 삭제합니다 · 되돌릴 수 없음')}</span></div></td></tr>` : ""}
    ${linkEntryFor === String(d.id) ? `<tr class="dev-tr-note"><td colspan="4" style="padding:0 0 10px">
      <div class="link-entry">
        <input id="linkCodeInput" class="acct-del-input" maxlength="8" placeholder="${i18n.t('8자 코드')}" autocomplete="off" spellcheck="false" style="text-transform:uppercase;letter-spacing:2px" />
        <button class="sett-btn" data-link-submit="${d.id}">${i18n.t('연결')}</button>
      </div>
      ${linkEntryMsg ? `<div class="acct-msg">${esc(linkEntryMsg)}</div>` : ""}
    </td></tr>` : ""}`;
  };

  //  `이 기기` 섹션 = 이 기기 행만(행동 행은 renderE2ee 가 이 앞에 붙인다).
  if (mine) return all.filter((d) => d.isCurrent).map(row).join("");

  const otherRows = all.filter((d) => !d.isCurrent).map(row).join("");
  //  기기 행이 없는 열쇠(고아) — 삭제 경로를 잃지 않게 목록에 남긴다. ★ 개정 7: 지문(🔒 숫자)은
  //   표시하지 않는다(사용자: "저것도 사용자들은 몰라도 되는 정보 아닌가?"). 정상 경로에서는 이제
  //   열쇠가 기기 행에 묶이므로(back enroll 이 deviceId 를 받는다) 이 행 자체가 예외 상황이다.
  //  ★ 개정 11: 같은 이름의 기기 행이 이미 있으면 고아 열쇠 행을 **그리지 않는다**. 승인 직후 신청서에
  //   deviceId 가 없던 경우(로그인 직후 기기 등록 전에 enroll 이 나감) 열쇠가 잠시 기기 행에 안 묶여
  //   같은 폰이 2줄로 보였다(사용자 지적) — 귀속은 다음 enroll 이 흡수하므로 표시만 합치면 된다.
  const rowNames = new Set(all.map((d) => String(d.name || "")));
  const orphanRows = orphans.filter((k) => !e2eeKeyIsMine(k) && !rowNames.has(String(k.label || ""))).map((k) => {
    const isPc = k.platform === "darwin" || k.platform === "win32" || k.platform === "linux";
    return `<tr class="dev-tr">
      <td class="dev-c-ic"><span class="dev-ic">${isPc ? icons.monitor({ size: 15 }) : icons.smartphone({ size: 15 })}</span></td>
      <td class="dev-c-name"><span class="dev-name"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.label || "기기")}</span></span></td>
      <td class="dev-c-meta"><span style="color:var(--text3)">${i18n.t('이전에 연동된 기기')}</span></td>
      <td class="dev-c-del"><button class="dev-del-btn" data-e2ee-revoke="${k.deviceKeyId}" title="${i18n.t('연동 해제')}">${icons.trash({ size: 15 })}</button></td>
    </tr>
    <tr class="dev-tr-note" data-e2ee-armnote="${k.deviceKeyId}" style="display:none"><td colspan="4" class="acct-msg" style="padding:0 0 8px;color:var(--warn,#FBBF24)">${i18n.t('다시 눌러 해제 · 되돌릴 수 없음')}</td></tr>`;
  }).join("");

  const others = otherRows + orphanRows;
  return others || `<tr class="dev-tr"><td colspan="4" class="dim" style="font-size:12px">${i18n.t('연결된 기기가 없어요')}</td></tr>`;
}

function renderE2ee() {
  const box = connBody?.querySelector("#e2eeBox");
  const selfBox = connBody?.querySelector("#e2eeSelfBox");
  if (!box) return;
  const label = e2eeStateLabel();
  // ★ 승인 카드는 **승인할 수 있는 요청**만 그린다(e2ee.js e2eePendingApprovable — 자기 자신의 옛
  //  enrollment 제외 + 이 PC 에 열쇠가 없으면 0건). 필터 없이 e2ee.pending 을 그리면 눌러도 403 인
  //  카드가 뜬다(2026-07-28 폰 실사고).
  const devs = e2ee.devices || [];
  const selfReady = e2eeReady();
  // 행동 행을 먼저 만든다 — 있으면 그 아래 `reason`(데몬·서버 원문)을 **그리지 않는다**: 두 줄이 같은
  //  사실을 다른 문장으로 말하고(부트스트랩은 서로 상충한다 — reason 은 '폰에서 켜라', 행동 행은 이 PC 의
  //  켜기 버튼) 첫 화면의 '설명문 0줄' 이 무너진다. 정보 손실 0 = 행동 행이 사실 + 다음 행동을 말한다.
  //  ⚠ 앱 E2eeSettingsCard 의 `!action` 조건과 같은 규칙이다(한쪽만 고치면 두 화면의 줄 수가 달라진다).
  const actionRowHtml = e2eeActionRow();
  // ★ 개정 3: 행동 행 + 기기 행이 **한 표**다(`<table class="dev-tbl">`). 예전에는 각 행이 독립 카드
  //  (.dev-row)여서 섹션 카드 안에 카드가 겹쳐 보였다(사용자 지적) → 바깥 카드 1겹 + 1px 구분선.
  //  reason/에러 문구는 표 밖 1줄이다(행이 아니라 섹션 전체에 대한 말이므로).
  // ★ 개정 9: 표가 둘이다 — `이 기기`(이 PC 행 + 이 PC 자신의 상태 행) / `다른 기기`(목록 + 고아 열쇠).
  if (selfBox) {
    selfBox.innerHTML = `
      ${label.tone !== "on" && e2ee.reason && !actionRowHtml ? `<div class="acct-msg" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(e2ee.reason)}</div>` : ""}
      ${e2eeMsg ? `<div class="acct-msg" style="color:var(--text2)">${esc(e2eeMsg)}</div>` : ""}
      <table class="dev-tbl">${e2eeDeviceRowsHtml(devs, selfReady, { mine: true })}${actionRowHtml}</table>`;
    bindE2ee(selfBox);
    // 렌더 함수에서 비동기 호출을 직접 await 하지 않는다. 상태 emit/render 스택이 끝난 뒤 한 번만
    // 발급하고, myLinkBusy/validMyLink 가 이후의 모든 재렌더 중복 호출을 막는다.
    if (selfReady && !validMyLink() && !myLinkBusy) queueMicrotask(() => { void ensureMyLink(); });
  }
  box.innerHTML = `<table class="dev-tbl">${e2eeDeviceRowsHtml(devs, selfReady)}</table>`;
  bindE2ee(box);
}

function bindE2ee(box) {
  //  (개정 6: 승인/거절 핸들러는 이 파일에서 삭제 — device-approval.js(전역 카드)와
  //   notifications.js(알림 행)가 갖는다. 여기 남는 상호작용은 연동 요청·기기 삭제뿐이다.)
  //  ★ 개정 12: [연동] = 그 행 아래에서 **다른 기기의 코드를 입력**한다(승인 요청 발송은 폐기).
  box.querySelectorAll("[data-link-open]").forEach((b) => b.addEventListener("click", () => {
    linkEntryFor = linkEntryFor === b.dataset.linkOpen ? null : b.dataset.linkOpen;
    linkEntryMsg = "";
    renderE2ee();
    const inp = connBody?.querySelector("#linkCodeInput");
    if (inp) inp.focus();
  }));
  box.querySelectorAll("[data-link-show-code]").forEach((b) => b.addEventListener("click", async () => {
    linkEntryFor = null;
    await ensureMyLink({ force: true });
  }));
  //  ⚠ 코드 입력칸은 두 화면에 산다(`계정`의 기기 행 아래 · `연결` 화면). 그래서 입력칸도 다시
  //   그릴 대상도 **부른 쪽 기준**으로 찾는다 — connBody/renderE2ee 로 고정하면 `연결` 화면에서
  //   누른 [연결] 이 남의 DOM 을 읽고 자기 화면은 갱신하지 않는다(무반응으로 보인다).
  const repaint = () => { if (section === "mobile") renderSection(true); else renderE2ee(); };
  box.querySelectorAll("[data-link-submit]").forEach((b) => b.addEventListener("click", async () => {
    const inp = box.querySelector("#linkCodeInput") || connBody?.querySelector("#linkCodeInput");
    const code = String(inp?.value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 8) { linkEntryMsg = i18n.t('코드 8자를 입력해 주세요'); repaint(); return; }
    b.disabled = true;
    linkEntryMsg = i18n.t('연결 중…');
    repaint();
    const r = await linkClaim(code);
    linkEntryMsg = r.ok ? "" : (r.error || i18n.t('연동에 실패했어요'));
    if (r.ok) linkEntryFor = null;
    repaint();
  }));
  //  ★ 최후 수단 — 이 PC 를 새 신뢰 기점으로(계정 링 교체). 자동으로는 절대 돌지 않는다(핑퐁 방지,
  //   e2ee.js maybeAutoBootstrap) → 사람이 경고를 읽고 **두 번** 눌러야 한다.
  box.querySelectorAll("[data-e2ee-reboot]").forEach((b) => b.addEventListener("click", async () => {
    if (!b.classList.contains("arm")) {
      b.classList.add("arm");
      b.textContent = i18n.t('한 번 더 누르면 다시 만듭니다 · 다른 기기는 모두 재연결');
      setTimeout(() => { if (b.isConnected) { b.classList.remove("arm"); b.textContent = i18n.t('이 PC 로 열쇠 다시 만들기'); } }, 6000);
      return;
    }
    b.disabled = true;
    linkEntryMsg = i18n.t('열쇠를 다시 만드는 중…');
    repaint();
    const r = await bootstrapAccount();
    linkEntryMsg = r && r.ok ? "" : ((r && r.error) || i18n.t('열쇠를 만들지 못했어요(잠시 후 다시 시도해 주세요).'));
    repaint();
  }));
  // 이 기기의 연동 코드는 자동 발급·자동 갱신한다. 실패했을 때만 명시적인 재시도 버튼을 둔다.
  box.querySelectorAll("[data-link-new]").forEach((b) => b.addEventListener("click", async () => {
    await ensureMyLink({ force: true });
  }));
  // (개정 4: 정책 세그/암호화 켜기/복구 코드 만들기·복원 핸들러 삭제 — 부트스트랩은
  //  e2ee.js maybeAutoBootstrap 이 자동 수행, 정책은 normalizeE2eePolicy 가 '자동' 으로 고정)
  // 신뢰 해제(기기 행이 없는 고아 열쇠) = 휴지통 2탭. 비가역 경고는 **결정 순간에만** 인라인으로
  //  띄운다(상시 2줄 문단을 없앤 대신 정보량은 유지 — 카피 감사 §2 위치 이동).
  box.querySelectorAll("[data-e2ee-revoke]").forEach((b) => b.addEventListener("click", async () => {
    const note = box.querySelector(`[data-e2ee-armnote="${b.dataset.e2eeRevoke}"]`);
    if (!b.classList.contains("arm")) {
      b.classList.add("arm");
      b.setAttribute("aria-label", i18n.t('한 번 더 눌러 기기 삭제'));
      b.title = i18n.t('한 번 더 눌러 기기 삭제');
      if (note) note.style.display = "";
      setTimeout(() => {
        b.classList.remove("arm");
        b.setAttribute("aria-label", i18n.t('기기 삭제'));
        b.title = i18n.t('기기 삭제');
        if (note) note.style.display = "none";
      }, 4000);
      return;
    }
    b.disabled = true;
    const r = await revokeTrust(Number(b.dataset.e2eeRevoke));
    e2eeMsg = r.ok ? "" : r.error || i18n.t('해제하지 못했어요');
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
      if (!r.ok) e2eeMsg = r.error || i18n.t('해제하지 못했어요');
    }
    try { await api.revokeDevice(Number(b.dataset.dev)); await S.loadDevices(); } catch (_) { b.disabled = false; }
    await refreshE2ee();
    renderE2ee();
  }));
  box.querySelectorAll("[data-alias-edit]").forEach((b) => b.addEventListener("click", () => {
    const d = (state.devices || []).find((x) => String(x.id) === String(b.dataset.aliasEdit) && x.isCurrent);
    if (!d) return;
    aliasEditFor = String(d.id); aliasEditValue = d.name || ""; aliasEditError = ""; renderE2ee();
    setTimeout(() => box.querySelector(".dev-alias-input")?.focus(), 0);
  }));
  box.querySelectorAll("[data-alias-cancel]").forEach((b) => b.addEventListener("click", () => {
    aliasEditFor = null; aliasEditValue = ""; aliasEditError = ""; renderE2ee();
  }));
  const aliasInput = box.querySelector(".dev-alias-input");
  if (aliasInput) aliasInput.addEventListener("input", () => { aliasEditValue = aliasInput.value; });
  box.querySelectorAll("[data-alias-save]").forEach((b) => b.addEventListener("click", async () => {
    const name = aliasEditValue.trim();
    if (!name) return;
    b.disabled = true;
    try { await api.renameOwnDevice(Number(b.dataset.aliasSave), name); aliasEditFor = null; aliasEditError = ""; await S.loadDevices(); }
    catch (e) { aliasEditError = e?.message || i18n.t('별칭을 저장하지 못했어요.'); b.disabled = false; }
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
  title.textContent = d.running ? i18n.t('연결됨 · 실행 중') : i18n.t('중지됨');
  desc.textContent = [d.device_name, d.server].filter(Boolean).join(" · ");
  if (run) run.textContent = d.running ? i18n.t('중지') : i18n.t('시작');
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
    btn.textContent = i18n.t('로그아웃');
    btn.classList.remove("danger");
  };
  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      btn.textContent = i18n.t('다시 클릭');
      btn.classList.add("danger");
      timer = setTimeout(reset, 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed = false;
    btn.disabled = true;
    btn.textContent = i18n.t('로그아웃 중…');
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
      <button id="webLoginBtn" class="btn primary lg">${i18n.t('로그인')}</button>
      <div id="webLoginStatus" class="login-status"></div>
    </div>`;
  connBody.querySelector("#webLoginBtn").addEventListener("click", startWebLogin);
}

// ── 웹 로그인(클로드 코드식): 페어링 세션 → 브라우저 승인 → 폴링 claim ──
function startWebLogin() {
  stopWebLogin();
  const btn = connBody?.querySelector("#webLoginBtn");
  const statusEl = connBody?.querySelector("#webLoginStatus");
  if (btn) { btn.disabled = true; btn.textContent = i18n.t('브라우저 여는 중…'); }
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
      if (statusEl) statusEl.textContent = i18n.t('브라우저에서 로그인 후 ‘이 PC 연결하기’를 누르세요…');
      if (btn) btn.textContent = i18n.t('브라우저에서 로그인 대기 중…');
      webLogin.poll = setInterval(pollWebLogin, 2500);
    } catch (e) {
      if (statusEl) statusEl.textContent = i18n.t('로그인 세션 생성 실패: ') + e;
      if (btn) { btn.disabled = false; btn.textContent = i18n.t('로그인'); }
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
    if (s) s.textContent = i18n.t('코드가 만료됐어요. 다시 시도하세요.');
    if (b) { b.disabled = false; b.textContent = i18n.t('로그인'); }
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
    errEl.textContent = i18n.t('페어링 코드를 입력하세요.');
    errEl.classList.remove("hidden");
    return;
  }
  const btn = connBody.querySelector("#pairBtn");
  btn.disabled = true;
  btn.textContent = i18n.t('연결 중…');
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
    btn.textContent = i18n.t('코드로 연결');
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

/** 트레이 메뉴의 설정/업데이트 진입. 로그인 전에도 로컬 설정과 업데이터는 사용할 수 있다. */
export function openSettingsSection(nextSection = "appearance") {
  section = NAV.some((item) => item.key === nextSection) ? nextSection : "appearance";
  S.setView("settings");
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
