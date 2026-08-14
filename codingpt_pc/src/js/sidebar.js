// sidebar.js — 좌측: 상단 컨트롤(사이드바 토글·알림·새 워크스페이스) + 워크스페이스 목록 + 하단 내 정보.
import { state, isLocal } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { getPane } from "./pane.js";
import { renderNotifPanel, jumpLatestUnread } from "./notifications.js";
import { openNewWorkspace } from "./folder-picker.js";
import lan from "./lan.js";
import * as i18n from './i18n/index.js';

let el = null;
let notifPanel = null;
let notifOpen = false;

// 사이드바 폭 — 우측 테두리 드래그로 조절, localStorage 영속(기본 264, 200~420 클램프).
const SB_MIN = 200, SB_MAX = 420;
function applySbWidth(w) {
  const v = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(w)));
  document.documentElement.style.setProperty("--sb-w", v + "px");
  return v;
}
let sbGrip = null; // updateSidebar 가 innerHTML 을 비워도 재부착할 수 있게 모듈 보관
function mountSbResizer() {
  const saved = parseInt(localStorage.getItem("cpt:sbW") || "", 10);
  if (saved) applySbWidth(saved);
  const grip = document.createElement("div");
  sbGrip = grip;
  grip.className = "sb-resizer";
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("resizing-col");
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    let cur = startW;
    const move = (ev) => { cur = applySbWidth(startW + (ev.clientX - startX)); };
    const up = () => {
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing-col");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      try { localStorage.setItem("cpt:sbW", String(Math.round(cur))); } catch (_) {}
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  el.appendChild(grip);
}

export function mountSidebar(container) {
  el = container;
  el.className = "sidebar";
  mountSbResizer();
  // LAN 직결 경로 변화 시 배지만 갱신(경로 상태는 호스트 온/오프라인과 무관 — 오프라인 UX 무간섭).
  lan.onLanChange(() => updateSidebar());
  startLanBadgePoll();
  notifPanel = document.createElement("div");
  notifPanel.className = "notif-panel hidden";
  document.body.appendChild(notifPanel);
  document.addEventListener("mousedown", (e) => {
    if (notifOpen && !notifPanel.contains(e.target) && !e.target.closest?.(".bell")) closeNotif();
  });
}

// "직결" 배지 폴링 — 경로 상태의 소유자는 데몬이므로 PC 는 물어보기만 한다(캐시 10s·쿨다운·미지원
//  휴면·승격 probe 는 전부 lan.js 안에 있고, 여기서는 **대상 고르기**만 한다).
//  ★ 실패는 전부 무음이다: 배지가 안 뜨는 것 말고 어떤 UX 도 바뀌지 않는다(lan.js 헤더 규율).
//  ★ 다른 PC(원격 호스트)만 대상이다 — 이 PC 자신의 워크스페이스는 로컬 fsapi/tmux 직결이라 LAN 무의미.
//  ★ 오프라인 호스트에는 쏘지 않는다(온/오프라인 판정은 기존 hostOnline 이 단독으로 한다).
let lanPollTimer = null;
function startLanBadgePoll() {
  if (lanPollTimer) return;
  const tick = () => {
    if (!state.paired) return;
    if (typeof document !== "undefined" && document.hidden) return; // 창이 안 보이면 IPC 낭비 금지
    const seen = new Set();
    for (const w of state.workspaces || []) {
      if (!isLocal(w) || S.isThisHost(w) || w.hostOnline === false) continue;
      const hid = Number(w.hostDeviceId);
      if (!Number.isFinite(hid) || seen.has(hid)) continue;
      seen.add(hid);
      void lan.refreshStatus(hid);
    }
  };
  lanPollTimer = setInterval(tick, 10000);
  tick();
}

export function jumpToNotification(n) {
  // 기기 승인 알림(기능2)은 워크스페이스가 없다 — 설정>계정(종단간 암호화 카드)이 목적지다.
  if (n && n.kind === "device_approval") {
    import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings"));
    return;
  }
  // 대상 워크스페이스 활성화 — 서버 행(workspaceId → cwd 매칭) 우선, 로컬 폴백(wsId)도 지원.
  const ws =
    state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId)) ||
    (n.cwd ? state.workspaces.find((w) => w.localPath === n.cwd) : null);
  if (ws) S.setActive(ws.id);
  // 발생한 터미널(win)을 보여주는 leaf 로 점프 — 다른 pane 탭에 숨어 있으면 그 탭으로 전환.
  const rt = S.wsRuntime(state.activeWsId);
  if (rt && rt.layout && n.win != null) {
    let hit = null;
    T.eachLeaf(rt.layout, (l) => {
      if (!hit && l.kind === "terminal" && (l.tabs || []).some((t) => typeof t.win === "number" && t.win === Number(n.win))) hit = l;
    });
    if (hit) {
      const idx = hit.tabs.findIndex((t) => typeof t.win === "number" && t.win === Number(n.win));
      if (idx >= 0 && idx !== hit.active) getPane(hit.id)?.switchTab(idx);
      S.focusPane(hit.id);
      // 알림을 눌러 그 터미널로 왔다 = 사용자가 그 터미널을 봤다 → 그 터미널의 미읽음을 **전부**
      //  읽음 처리한다. 누른 한 건만 읽음으로 두면(readOne) 같은 터미널의 나머지 미읽음이 남아
      //  강조 테두리가 그대로다 — 사용자에겐 "눌렀는데 안 없어진다"로 보인다(2026-08-14).
      if (n.cwd) S.readScope(n.cwd, Number(n.win));
    }
  } else if (n.paneId) {
    S.focusPane(n.paneId); // 로컬 폴백 알림(구 형식)
  }
  closeNotif();
}
export function toggleLatestUnread() {
  jumpLatestUnread((n) => jumpToNotification(n));
}

/** 알림 패널 열고/닫기 — 명령 팔레트(notif.panel)가 벨 클릭과 같은 길을 타게 한다. */
export function toggleNotifPanel() {
  if (!notifPanel) return;
  notifOpen ? closeNotif() : openNotif();
}

// 알림 패널 — punch-through(프리뷰=아래층) 덕에 평범한 DOM 으로 프리뷰 위에 뜬다.
function openNotif() {
  notifOpen = true;
  notifPanel.classList.remove("hidden");
  renderNotifPanel(notifPanel, (n) => jumpToNotification(n));
  // 접힘 시 bell 은 메인 상단바에 있으므로 화면에 보이는 bell 을 기준으로 위치.
  const bell = [...document.querySelectorAll(".bell")].find((b) => b.offsetParent !== null) || el.querySelector(".bell");
  if (bell) {
    const r = bell.getBoundingClientRect();
    notifPanel.style.left = r.left + "px";
    notifPanel.style.top = r.bottom + 6 + "px";
  }
}
function closeNotif() {
  notifOpen = false;
  notifPanel.classList.add("hidden");
}

export function updateSidebar() {
  if (!el) return;
  const totalUnread = state.notifications.filter((n) => !n.read).length;
  el.innerHTML = "";
  if (sbGrip) el.appendChild(sbGrip); // 리사이즈 핸들 재부착(innerHTML 초기화로 떨어짐)

  // 상단 컨트롤(트래픽 라이트 여백 + 토글/알림/추가). 드래그 영역.
  const top = document.createElement("div");
  top.className = "sb-top";
  top.setAttribute("data-tauri-drag-region", "");
  top.append(buildTopControls());
  el.appendChild(top);

  // 목록.
  const list = document.createElement("div");
  list.className = "sb-list";
  // 맨 위에서 아래로 당김(오버스크롤) → 워크스페이스 목록 새로고침(pull-to-refresh).
  attachPullToRefresh(list);

  // 서버 미가용 — 목록은 로컬 캐시(last-known)다. 이 PC 폴더 작업은 그대로 되지만 서버가 원천인
  //  조작(추가/삭제)과 다른 기기 진입은 막혀 있다는 것을 한 줄로 알린다(오프라인 톤, 위험색 금지).
  if (state.wsStale) list.appendChild(note(i18n.t('오프라인 — 마지막으로 본 목록')));

  // ── ① 내 PC (2026-08-14 기기 우선 개편) ────────────────────────────────
  //  예전엔 프로젝트(projectId) 묶음이 위, 그 안에 기기별 사본이 있었다. 사용자 지적: "이해도 안
  //  가고 사용성도 안 좋다". 실제 소유 관계는 반대다 — 워크스페이스는 **그 PC 의 로컬 폴더**다.
  //  그래서 PC 를 먼저 고르고, 고른 PC 의 워크스페이스만 아래에 그린다.
  const devices = S.pcDevices();
  const activeDev = S.activeDeviceId();
  // 새 PC 는 이 화면에서 만들 수 없다(그 PC 에 앱을 깔고 로그인해야 나타난다) → + 버튼 없음.
  //  ★ `PC 연결하기` 안내도 뺐다(2026-08-14 사용자 확정: "PC 에서는 필요 없을 것 같다") —
  //   PC 앱을 쓰고 있다는 것 자체가 이미 그 방법을 아는 것이다. 폰에서는 그 안내가 여전히 필요해
  //   앱(SidebarContent) 쪽에는 남겨 둔다.
  list.appendChild(sectionHead(i18n.t('내 PC'), [
    { icon: icons.sliders({ size: 15 }), label: i18n.t('기기 관리'), onClick: () => import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings")) },
  ]));
  if (!devices.length) {
    list.appendChild(note(state.paired ? i18n.t('불러오는 중…') : i18n.t('PC를 연결하세요')));
  }
  for (const d of devices) list.appendChild(deviceRow(d, activeDev));

  // ── ② 선택한 PC 의 워크스페이스 ───────────────────────────────────────
  const wss = devices.length ? S.workspacesForDevice(activeDev) : [];
  //  ★ [+] 와 ⋯ 을 함께 두지 않는다(2026-08-14 사용자 확정) — 둘 다 "워크스페이스 추가" 하나를
  //   가리켜서, 같은 일을 하는 버튼이 나란히 두 개 있는 꼴이었다. ⋯ 하나로 통일한다.
  list.appendChild(sectionHead(i18n.t('워크스페이스'), [
    { icon: icons.plus({ size: 14 }), label: i18n.t('워크스페이스 추가'), onClick: () => startNewWorkspace(activeDev) },
  ]));
  if (devices.length && !wss.length) {
    if (state.wsError && !state.workspaces.length) list.appendChild(note(i18n.t('목록을 불러오지 못했습니다')));
    else list.appendChild(note(i18n.t('+ 로 이 PC의 폴더를 추가하세요')));
  }
  for (const w of wss) list.appendChild(wsRow(w));
  el.appendChild(list);

  // 하단: 내 정보.
  const online = state.daemon?.running && state.daemon?.paired;
  const foot = document.createElement("button");
  foot.className = "sb-me" + (state.view === "settings" ? " active" : "");
  const me = state.me;
  const av = document.createElement("span");
  av.className = "me-avatar";
  av.innerHTML = me?.profileImg
    ? `<img class="me-img" src="${escapeHtml(me.profileImg)}" alt="" />`
    : me?.nickname
      ? `<span class="me-initial">${escapeHtml((me.nickname || me.email || "U").trim().charAt(0).toUpperCase())}</span>`
      : icons.user({ size: 16 });
  const txt = document.createElement("span");
  txt.className = "me-text";
  const name = me?.nickname || i18n.t('내 정보');
  const sub = me
    ? me.email || state.daemon?.device_name || i18n.t('로그인됨')
    : state.daemon?.device_name || (state.paired ? i18n.t('연결됨') : i18n.t('로그인 필요'));
  txt.innerHTML = `<span class="me-name">${escapeHtml(name)}</span><span class="me-sub">${escapeHtml(sub)}</span>`;
  foot.append(av, txt);
  foot.addEventListener("click", () => S.setView(state.view === "settings" ? "workspace" : "settings"));
  el.appendChild(foot);

  if (notifOpen) renderNotifPanel(notifPanel, (n) => jumpToNotification(n));
}

// pull-to-refresh — 목록 맨 위에서 "잡고 아래로 당김"(마우스 드래그) 또는 트랙패드 오버스크롤 → 새로고침.
//  당기는 양만큼 상단 인디케이터가 커지고, 임계값을 넘겨 놓으면 loadWorkspaces() 실행.
let __ptrBusy = false;
function attachPullToRefresh(list) {
  const THRESH = 56;
  let pull = 0;

  // 상단 인디케이터(당길수록 높이가 커지며 내용을 밀어냄).
  const ind = document.createElement("div");
  ind.className = "ptr-indicator";
  ind.style.cssText =
    "height:0px;overflow:hidden;display:flex;align-items:center;justify-content:center;" +
    "font-size:11px;color:var(--text-dim,#8b93a7);opacity:0;transition:height .12s,opacity .12s;user-select:none;";
  list.prepend(ind);

  const render = () => {
    const v = Math.min(pull, 96);
    if (__ptrBusy) return;
    ind.style.height = v > 3 ? Math.min(6 + v * 0.5, 44) + "px" : "0px";
    ind.style.opacity = v > 3 ? "1" : "0";
    ind.textContent = pull >= THRESH ? i18n.t('놓으면 새로고침 ↑') : i18n.t('당겨서 새로고침 ↓');
  };
  const reset = () => { pull = 0; render(); };
  const fire = () => {
    if (pull >= THRESH && !__ptrBusy) {
      __ptrBusy = true;
      ind.style.height = "30px";
      ind.style.opacity = "1";
      ind.textContent = i18n.t('새로고침 중…');
      Promise.resolve(S.loadWorkspaces()).finally(() => {
        setTimeout(() => { __ptrBusy = false; }, 400);
      });
    } else {
      reset();
    }
  };

  // 마우스로 잡고 당김.
  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || list.scrollTop > 0 || __ptrBusy) return;
    const startY = e.clientY;
    let active = true;
    const mv = (ev) => {
      if (!active) return;
      if (list.scrollTop > 0) { pull = 0; render(); return; }
      const dy = ev.clientY - startY;
      if (dy > 0) { ev.preventDefault(); pull = dy; render(); }
      else { pull = 0; render(); }
    };
    const up = () => {
      active = false;
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      fire();
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });

  // 트랙패드 오버스크롤(위로 튕김).
  let wt = null;
  list.addEventListener(
    "wheel",
    (e) => {
      if (list.scrollTop > 0 || __ptrBusy) return;
      if (e.deltaY < 0) {
        pull += -e.deltaY;
        render();
        clearTimeout(wt);
        wt = setTimeout(fire, 130);
      }
    },
    { passive: true }
  );
}

function ctlBtn(iconName, title, onClick) {
  const b = document.createElement("button");
  b.className = "ic-btn";
  b.title = title;
  b.innerHTML = icons[iconName]({ size: 17 });
  b.addEventListener("click", onClick);
  return b;
}

// 상단 컨트롤(토글·알림·추가) — 사이드바 상단바 + 접힘 시 메인 상단바에서 공용 사용(정합성).
//  withAdd=false: 접힘 시 이식되는 축약판 — 워크스페이스 추가(+)는 사이드바를 열어야 보인다.
// ★ 2026-08-14: `withAdd` 는 **더 이상 아무것도 하지 않는다**(사용자 확정으로 상단 + 제거).
//  워크스페이스 추가는 사이드바 안의 `워크스페이스` 섹션 머리에 산다 — 무엇을 어디에 만드는지가
//  그 자리에서 드러난다(옛 상단 + 는 "어느 PC 에?" 를 매번 다시 물어야 했다).
//  인자를 남겨 둔 이유는 접힌 사이드바의 상단바(main-top)가 같은 함수를 부르기 때문이다.
export function buildTopControls(_withAdd = true) {
  const frag = document.createDocumentFragment();
  const totalUnread = state.notifications.filter((n) => !n.read).length;
  // 열림=채운 아이콘, 닫힘=빈 아이콘(색이 아니라 채움 유무로 상태 표현).
  const toggle = ctlBtn(state.sidebarCollapsed ? "sidebar" : "sidebarFilled", state.sidebarCollapsed ? i18n.t('사이드바 펼치기') : i18n.t('사이드바 접기'), () => S.toggleSidebar());
  const bell = ctlBtn("bell", i18n.t('알림'), (e) => {
    e.stopPropagation();
    notifOpen ? closeNotif() : openNotif();
  });
  bell.classList.add("bell");
  if (totalUnread) {
    const badge = document.createElement("span");
    badge.className = "bell-badge";
    badge.textContent = totalUnread > 9 ? "9+" : String(totalUnread);
    bell.appendChild(badge);
  }
  frag.append(toggle, bell);
  return frag;
}
function note(text) {
  const d = document.createElement("div");
  d.className = "sb-note";
  d.textContent = text;
  return d;
}

// ── 기기 우선 사이드바의 조각들 (2026-08-14) ────────────────────────────────
/**
 * 섹션 머리 — 제목 + ⋯ 메뉴.
 *  ★ [+] 는 두지 않는다(2026-08-14 사용자 확정: "그냥 옆에 ... 으로만 하자"). 처음엔 워크스페이스
 *   섹션에 [+] 와 ⋯ 을 나란히 뒀는데, ⋯ 안의 유일한 항목도 `워크스페이스 추가` 라서 **같은 일을
 *   하는 버튼이 두 개** 있는 꼴이었다.
 *  · 메뉴 항목은 워크스페이스 우클릭 메뉴(buildMenu)와 **같은 모양**을 쓴다 — 사이드바 안에서
 *    메뉴가 두 종류로 보이면 그건 디자인이 아니라 누락이다.
 */
function sectionHead(title, items) {
  const head = document.createElement("div");
  head.className = "sb-sec";
  const nm = document.createElement("span");
  nm.className = "sb-sec-nm";
  nm.textContent = title;
  head.appendChild(nm);
  const acts = document.createElement("span");
  acts.className = "sb-sec-acts";
  if (items && items.length) {
    const m = document.createElement("button");
    m.className = "sb-sec-btn" + (state.creatingWs && title === i18n.t('워크스페이스') ? " busy" : "");
    m.title = i18n.t('더 보기');
    m.innerHTML = icons.dots({ size: 15 });
    m.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = m.getBoundingClientRect();
      showPopupMenu(r.left, r.bottom + 4, items);
    });
    acts.appendChild(m);
  }
  head.appendChild(acts);
  return head;
}

/** PC 행 — 클릭 = 그 PC 로 전환(오프라인도 고를 수 있다: 뭘 등록해 뒀는지 볼 수 있어야 한다). */
function deviceRow(d, activeId) {
  const on = d.online !== false;
  const sel = String(d.id) === String(activeId);
  const row = document.createElement("button");
  row.className = "pc-row" + (sel ? " active" : "") + (on ? "" : " pc-off");
  row.dataset.devId = String(d.id);
  // 미읽음은 그 PC 의 워크스페이스 것을 합산한다 — 다른 PC 를 보고 있어도 "저기서 뭔가 왔다"를 안다.
  const unread = S.workspacesForDevice(d.id).reduce((n, w) => n + S.unreadForWs(w), 0);
  row.innerHTML =
    `<span class="pc-ic">${icons.monitor({ size: 14 })}</span>` +
    `<span class="pc-nm">${escapeHtml(d.name || i18n.t('내 PC'))}</span>` +
    (d.isCurrent ? `<span class="pc-here">${i18n.t('이 PC')}</span>` : "") +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "") +
    `<span class="wsr-dot ${on ? "on" : "off"}"></span>`;
  row.addEventListener("click", () => { if (!sel) S.setActiveDevice(d.id); });
  return row;
}

/** 새 워크스페이스 — 고른 PC 를 대상으로 연다(다른 PC 를 보는 중이면 그 PC 의 폴더를 고른다). */
function startNewWorkspace(deviceId) {
  if (S.blockedOffline(i18n.t('워크스페이스 추가'))) return;
  openNewWorkspace({ hostDeviceId: deviceId });
}

// ── 유령(폴더 소실) 감지 ──
//  서버 신선도 플래그(w.git.missing)와, 자기 호스트(이 PC) 행은 로컬 pathExists 즉시 판정을 OR
//  (서버 보고 주기 지연 보완). 로컬 판정은 행 렌더마다 IPC 를 부르지 않도록 refreshWsMeta
//  갱신 주기(시작+15s)에만 조회해 캐시한다. 원격 PC 행은 서버 플래그만.
const localMissing = new Map(); // wsId -> true(이 PC 에 폴더 없음)
function wsMissing(w) {
  return !!w?.git?.missing || localMissing.get(w.id) === true;
}

// ★ 2026-08-14: `group`(프로젝트 묶음) 인자는 없어졌다. 이제 행은 **고른 PC 의 워크스페이스** 하나이고,
//  호스트 이름·상태점·직결 배지는 위 기기 행이 이미 말한다 → 행에서 중복 제거(이름과 경로만 남는다).
function wsRow(w) {
  const rt = S.wsRuntime(w.id);
  const unread = S.unreadForWs(w);
  const local = isLocal(w);
  const color = S.wsColor(w.id);
  const pinned = S.wsPinned(w.id);
  const online = local ? (w.hostOnline !== false) : true;
  const row = document.createElement("button");
  row.className = "ws-row" + (w.id === state.activeWsId && state.view === "workspace" ? " active" : "") + (online ? "" : " ws-off");
  row.draggable = true;
  row.dataset.wsId = w.id;
  if (color) row.style.boxShadow = `inset 3px 0 0 ${color}`;

  const name = document.createElement("div");
  name.className = "wsr-name";
  name.innerHTML =
    (pinned ? `<span class="wsr-pin" title="${i18n.t('고정됨')}">${icons.pin({ size: 12 })}</span>` : "") +
    `<span class="wsr-nm">${escapeHtml(S.wsDisplayName(w))}</span>` +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "");

  const meta = document.createElement("div");
  meta.className = "wsr-meta";
  // 호스트 이름·온라인 점·직결 배지는 **기기 행**이 담당한다 — 여기 다시 쓰면 같은 말이 두 줄이다.
  //  이 줄에 남는 것은 그 워크스페이스에서만 알 수 있는 것(원격 상태 스트림)뿐이다.
  meta.innerHTML = "";

  // 원격 상태 스트림(ui_command status.changed) 최소 표시 — status[0].value 텍스트 + 진행률 %.
  const st = w.localPath ? S.wsStatus.get(w.localPath) : null;
  const stText = st?.status?.[0]?.value;
  if (stText || typeof st?.progress === "number") {
    const badge = document.createElement("span");
    badge.className = "wsr-status";
    badge.textContent =
      (stText || "") + (typeof st.progress === "number" ? ` ${Math.round(st.progress)}%` : "");
    meta.appendChild(badge);
  }

  row.append(name);
  if (meta.innerHTML) row.append(meta); // 빈 meta 줄(그룹 멤버 + 상태 배지 없음)은 여백만 남으니 생략
  const missing = wsMissing(w);
  if (missing) {
    // 유령 — 경로 서브라벨 대신 소실 라벨(오프라인 라벨 톤, 위험 뉘앙스 과하지 않게).
    const miss = document.createElement("div");
    miss.className = "wsr-path wsr-missing";
    miss.textContent = i18n.t('폴더를 찾을 수 없음');
    row.appendChild(miss);
  } else if (w.localPath) {
    const path = document.createElement("div");
    path.className = "wsr-path";
    path.textContent = "~/" + w.localPath;
    row.appendChild(path);
  }
  const ports = (rt?.ports || []).slice(0, 3);
  if (ports.length) {
    const p = document.createElement("div");
    p.className = "wsr-ports";
    p.innerHTML = ports.map((x) => `<span class="port">:${x}</span>`).join("");
    row.appendChild(p);
  }
  row.addEventListener("click", (e) => {
    if (row.classList.contains("dragging")) return;
    // 유령(폴더 소실) — 열지 않고 안내 다이얼로그(목록에서 삭제 제안)만.
    if (wsMissing(w)) { showMissingDialog(w); return; }
    // 오프라인(캐시 목록): 이 PC 것만 진입. 캐시의 hostOnline 은 옛 판정이므로 "온라인 사본 제안"
    //  흐름(=거짓 정보)을 태우지 않고, 내 PC 워크스페이스는 로컬 직결로 그냥 연다.
    if (state.wsStale) {
      if (!S.isThisHost(w)) { S.blockedOffline(i18n.t('다른 기기의 워크스페이스 열기')); return; }
      S.setActive(w.id);
      return;
    }
    // ★ 프로젝트 그룹핑 폐기(2026-08-14)로 "켜진 사본으로 갈아타기" 제안도 함께 없앴다 — 사본이라는
    //  개념 자체가 화면에서 사라졌으므로, 꺼진 PC 의 워크스페이스를 누르면 그냥 그것을 연다.
    //  (호스트가 꺼져 있다는 사실은 위 기기 행의 상태점과 이 행의 흐린 표시가 이미 말한다.)
    S.setActive(w.id);
  });
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  bindWsDrag(row, w);
  return row;
}

// ── 워크스페이스 드래그앤드롭 순서 변경 ──
let dragSrcId = null;
function bindWsDrag(row, w) {
  row.addEventListener("dragstart", (e) => {
    dragSrcId = w.id;
    row.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", String(w.id)); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
  });
  row.addEventListener("dragend", () => {
    dragSrcId = null;
    row.classList.remove("dragging");
    el?.querySelectorAll(".ws-row.drop-before,.ws-row.drop-after").forEach((r) => r.classList.remove("drop-before", "drop-after"));
  });
  row.addEventListener("dragover", (e) => {
    if (dragSrcId == null || dragSrcId === w.id) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const after = row.classList.contains("drop-after");
    row.classList.remove("drop-before", "drop-after");
    if (dragSrcId == null || dragSrcId === w.id) return;
    const ids = S.sortedWorkspaces().map((x) => x.id).filter((id) => id !== dragSrcId);
    let idx = ids.indexOf(w.id);
    if (idx === -1) idx = ids.length; else if (after) idx += 1;
    ids.splice(idx, 0, dragSrcId);
    S.applyWsVisualOrder(ids);
  });
}

// ── 워크스페이스 우클릭 컨텍스트 메뉴 ──
const WS_COLORS = [
  ["없음", ""], ["빨강", "#f87171"], ["주황", "#fb923c"], ["초록", "#34d399"],
  ["파랑", "#60a5fa"], ["보라", "#a78bfa"], ["분홍", "#f472b6"],
];
let wsMenuEl = null;
function closeWsMenu() {
  if (wsMenuEl) { wsMenuEl.remove(); wsMenuEl = null; }
  document.removeEventListener("mousedown", onWsMenuOutside, true);
  document.removeEventListener("keydown", onWsMenuKey, true);
  window.removeEventListener("blur", closeWsMenu);
}
function onWsMenuOutside(e) { if (wsMenuEl && !wsMenuEl.contains(e.target)) closeWsMenu(); }
function onWsMenuKey(e) { if (e.key === "Escape") closeWsMenu(); }

// ctx-menu 요소 빌드(디자인=styles.css .ctx-menu). onAfter=항목 클릭 시 메뉴 닫기 콜백.
//  items: {icon,label,danger,onClick}(기본 항목) | {type:'sep'} | {type:'colors',icon,label,colors:[{title,c,sel,onClick}]}
function buildCtxEl(items, onAfter) {
  const tag = (elm, fn) => elm.addEventListener("click", () => { onAfter?.(); fn(); });
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (!it) continue;
    if (it.type === "sep") { const d = document.createElement("div"); d.className = "ctx-sep"; menu.appendChild(d); continue; }
    if (it.type === "colors") {
      const row = document.createElement("div");
      row.className = "ctx-item ctx-static";
      row.innerHTML = `<span class="ctx-ic">${it.icon || ""}</span><span class="ctx-label">${escapeHtml(it.label)}</span>`;
      const wrap = document.createElement("div");
      wrap.className = "ctx-colors";
      for (const c of it.colors) {
        const sw = document.createElement("button");
        sw.className = "ctx-sw" + (c.c ? "" : " none") + (c.sel ? " sel" : "");
        if (c.c) sw.style.background = c.c;
        sw.title = c.title;
        tag(sw, c.onClick);
        wrap.appendChild(sw);
      }
      row.appendChild(wrap);
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.innerHTML = `<span class="ctx-ic">${it.icon || ""}</span><span class="ctx-label">${escapeHtml(it.label)}</span>`;
    tag(b, it.onClick);
    menu.appendChild(b);
  }
  return menu;
}

// 워크스페이스 우클릭 메뉴 항목 모델.
function wsMenuItems(w) {
  const pinned = S.wsPinned(w.id);
  const items = [
    { icon: icons.edit({ size: 15 }), label: i18n.t('이름 변경'), onClick: () => inlineRename(w) },
    { icon: icons.pin({ size: 15 }), label: pinned ? i18n.t('고정 해제') : i18n.t('고정'), onClick: () => S.togglePinWs(w.id) },
    { type: "colors", icon: icons.palette({ size: 15 }), label: i18n.t('색상'), colors: WS_COLORS.map(([title, c]) => ({ title, c, sel: (S.wsColor(w.id) || "") === c, onClick: () => S.setWsColor(w.id, c) })) },
    { type: "sep" },
    { icon: icons.arrowUp({ size: 15 }), label: i18n.t('위로 이동'), onClick: () => S.moveWs(w.id, "up") },
    { icon: icons.arrowDown({ size: 15 }), label: i18n.t('아래로 이동'), onClick: () => S.moveWs(w.id, "down") },
    { icon: icons.arrowTop({ size: 15 }), label: i18n.t('맨 위로 이동'), onClick: () => S.moveWs(w.id, "top") },
    { type: "sep" },
  ];
  // ★ 프로젝트 분리/합치기 제거(2026-08-14 사용자 확정) — 기기 우선 구조에서는 한 화면에 한 PC 의
  //  워크스페이스만 있어서 "무엇과 합칠지"가 화면에 없다. 서버의 projectId 필드는 그대로 두므로
  //  되돌리려면 이 두 항목만 다시 붙이면 된다(api.projectDetach/projectAttach 도 살아 있다).
  // 목록 메타만 삭제(폴더/파일 무영향). 서버가 원천이라 오프라인에서는 막는다.
  items.push({ type: "sep" });
  items.push({ icon: icons.trash({ size: 15 }), label: i18n.t('워크스페이스 삭제'), danger: true, onClick: () => { if (S.blockedOffline(i18n.t('워크스페이스 삭제'))) return; confirmDeleteWs(w); } });
  return items;
}

// ── 워크스페이스 삭제(서버 목록 메타만 — 로컬 폴더/파일은 절대 건드리지 않음) ──
// 확인 다이얼로그 — quit-guard 패턴/스타일 재사용(취소 / 위험색 확정 2택).
function confirmDialog({ title, lines, confirmLabel, onConfirm }) {
  if (document.querySelector(".quit-guard-backdrop")) return; // 중복 방지
  const bd = document.createElement("div");
  bd.className = "quit-guard-backdrop";
  bd.innerHTML = `
    <div class="quit-guard">
      <div class="qg-title">${escapeHtml(title)}</div>
      <div class="qg-desc">${lines.map((l) => escapeHtml(l)).join("<br/>")}</div>
      <div class="qg-actions">
        <button class="qg-btn qg-cancel">${i18n.t('취소')}</button>
        <button class="qg-btn qg-quit qg-confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  bd.querySelector(".qg-cancel").addEventListener("click", () => bd.remove());
  bd.querySelector(".qg-confirm").addEventListener("click", () => { bd.remove(); onConfirm(); });
  bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
  document.body.appendChild(bd);
}

function confirmDeleteWs(w) {
  confirmDialog({
    title: i18n.t('워크스페이스 삭제'),
    lines: [`‘${S.wsDisplayName(w)}’을(를) 목록에서 삭제할까요? PC의 폴더와 파일은 그대로 유지됩니다.`],
    confirmLabel: i18n.t('삭제'),
    onConfirm: () => deleteWs(w),
  });
}

// 유령(폴더 소실) 행 클릭 — 열지 않고 안내 + 목록에서 삭제 제안(경로 다시 지정은 스코프 제외).
function showMissingDialog(w) {
  confirmDialog({
    title: i18n.t('폴더를 찾을 수 없습니다'),
    lines: [
      "~/" + (w.localPath || ""),
      i18n.t('폴더가 이동되었거나 삭제된 것 같습니다. 목록에서 삭제해도 폴더/파일에는 영향이 없습니다.'),
    ],
    confirmLabel: i18n.t('목록에서 삭제'),
    onConfirm: () => deleteWs(w),
  });
}

async function deleteWs(w) {
  if (S.blockedOffline(i18n.t('워크스페이스 삭제'))) return;
  try {
    await api.wsDelete(w.id);
    localMissing.delete(w.id);
    // 목록 리프레시 — 삭제된 ws 가 활성이었으면 loadWorkspaces 가 다른 ws 로 전환(없으면 빈 상태).
    await S.loadWorkspaces();
    refreshWsMeta();
  } catch (e) {
    console.error("워크스페이스 삭제 실패:", e);
    state.wsError = String(e);
    S.emit();
  }
}

// 우클릭 컨텍스트 메뉴 — DOM(punch-through 로 프리뷰 위에 뜸).
function showWsMenu(e, w) {
  showCtxDom(e.clientX, e.clientY, wsMenuItems(w));
}

function showCtxDom(x, y, items) {
  closeWsMenu();
  const menu = buildCtxEl(items, closeWsMenu);
  document.body.appendChild(menu);
  wsMenuEl = menu;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
  setTimeout(() => {
    document.addEventListener("mousedown", onWsMenuOutside, true);
    document.addEventListener("keydown", onWsMenuKey, true);
    window.addEventListener("blur", closeWsMenu);
  }, 0);
}

// 지정 좌표 팝업 메뉴 — items: [{icon,label,onClick}].
function showPopupMenu(x, y, items) {
  showCtxDom(x, y, items);
}

// ★ showOfflineFallback / showAttachMenu 삭제(2026-08-14) — 둘 다 **프로젝트 그룹핑 전용**이었다
//  ("같은 프로젝트의 켜진 사본으로 열기" / "다른 프로젝트와 합치기"). 그룹핑을 없앤 이상 화면에
//  근거가 없는 기능이라 죽은 코드로 남기지 않는다(살릴 땐 api.projectAttach/Detach 가 그대로 있다).

// 인라인 이름 변경 — 해당 행의 이름을 입력창으로 교체.
function inlineRename(w) {
  const row = el?.querySelector(`.ws-row[data-ws-id="${w.id}"]`);
  const nm = row?.querySelector(".wsr-nm");
  if (!nm) return;
  const input = document.createElement("input");
  input.className = "wsr-rename";
  input.value = S.wsDisplayName(w);
  input.spellcheck = false;
  nm.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => { S.renameWs(w.id, input.value); };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); S.emit(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (e) => e.stopPropagation());
}

export async function refreshWsMeta() {
  for (const w of state.workspaces) {
    if (!isLocal(w)) continue;
    const rt = S.wsRuntime(w.id) || S.ensureRuntime(w.id);
    if (S.isThisHost(w)) {
      // 유령 감지(로컬 즉시 판정) — 갱신 주기에만 조회해 캐시(행 렌더마다 IPC 금지).
      if (w.localPath) {
        try {
          localMissing.set(w.id, !(await api.pathExists(w.localPath)));
        } catch (_) {}
      }
      // 그 워크스페이스 폴더 안에서 실제로 도는 dev 서버 포트만 감지(시스템/타 폴더 포트 제외).
      try {
        rt.ports = await api.listenPorts(w.localPath || "");
      } catch (_) {}
    } else if (state.wsStale) {
      rt.ports = []; // 오프라인(캐시 목록) — 릴레이 조회가 불가하므로 무의미한 호출을 하지 않는다
    } else {
      // 다른 PC 워크스페이스 — 포트는 그 호스트 데몬에 조회(브랜치는 신선도 메타 w.git 폴백이 이미 있음).
      //  로컬 lsof 를 원격 사본 경로에 돌리면 "이 기기의" 포트가 잡히는 오답이라 반드시 릴레이로.
      try {
        const r = await api.backApi(
          "GET",
          `/api/daemon/preview/ports?cwd=${encodeURIComponent(w.localPath || "")}&hostDeviceId=${w.hostDeviceId}`,
        );
        rt.ports = r?.ports || [];
      } catch (_) { rt.ports = []; } // 호스트 오프라인 등 — 배지 없음
    }
  }
  S.emit();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
