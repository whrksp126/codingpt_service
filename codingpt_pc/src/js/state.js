// state.js — 앱 중앙 상태 + 구독 + 영속화. 뷰 모듈이 이 상태를 읽어 렌더한다.
import { api } from "./api.js";
import * as T from "./tiling.js";
import { getPane } from "./pane.js";

export const state = {
  paired: false,
  daemon: null, // 최근 daemon_status
  workspaces: [], // 백엔드 목록 [{id,name,localPath,compute,...}]
  wsError: null, // 워크스페이스 로드 오류(오프라인 등)
  activeWsId: null,
  ws: {}, // wsId -> { layout, focusId, surfaces:[{index,active,command}], branch:{}, ports:[] }
  notifications: [], // [{id, wsId, paneId, title, body, ts, read}]
  view: "workspace", // 'workspace' | 'settings'
  sidebarCollapsed: false,
  creatingWs: false,
  me: null, // 로그인 계정 프로필 {id,email,nickname,profileImg,...} — 웹 로그인 후 표시
  authChecked: false, // loadMe 를 최소 1회 시도했는지(로그인 게이트 판정용 — 페어링돼도 계정 확인 실패 시 게이트)
  devices: [], // 계정의 모든 기기(멀티기기 "내 기기")
  currentDeviceId: null, // 이 기기의 DaemonDevice id
};

// 워크스페이스 로컬 표시 설정(순서/고정/색/이름) — 백엔드 목록과 별개로 pc-ui.json 에 영속.
export const wsPrefs = { order: [], pinned: [], color: {}, rename: {} };

export function wsDisplayName(w) {
  return (w && (wsPrefs.rename[w.id] || w.name)) || "워크스페이스";
}
export function wsColor(id) {
  return wsPrefs.color[id] || null;
}
export function wsPinned(id) {
  return wsPrefs.pinned.includes(id);
}

// order 배열을 현재 워크스페이스 집합에 맞춰 정합화(신규는 뒤에 편입, 사라진 건 제거).
function ensureWsOrder() {
  for (const w of state.workspaces) if (!wsPrefs.order.includes(w.id)) wsPrefs.order.push(w.id);
  wsPrefs.order = wsPrefs.order.filter((id) => state.workspaces.some((w) => w.id === id));
  wsPrefs.pinned = wsPrefs.pinned.filter((id) => state.workspaces.some((w) => w.id === id));
}

// 표시 순서: 고정 먼저 → order 순. (고정은 항상 상단으로 float)
export function sortedWorkspaces() {
  ensureWsOrder();
  const idx = (id) => { const i = wsPrefs.order.indexOf(id); return i === -1 ? 1e9 : i; };
  return state.workspaces.slice().sort((a, b) => {
    const pa = wsPinned(a.id) ? 0 : 1, pb = wsPinned(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return idx(a.id) - idx(b.id);
  });
}

// 시각 순서(id 배열)를 절대 순서로 채택 — 드래그앤드롭/이동 공용.
export function applyWsVisualOrder(ids) {
  wsPrefs.order = ids.slice();
  emit();
  schedulePersist();
}
export function moveWs(id, dir) { // 'up' | 'down' | 'top'
  const ids = sortedWorkspaces().map((w) => w.id);
  const i = ids.indexOf(id);
  if (i < 0) return;
  const j = dir === "top" ? 0 : dir === "up" ? i - 1 : i + 1;
  if (dir !== "top" && (j < 0 || j >= ids.length)) return;
  ids.splice(i, 1);
  ids.splice(dir === "top" ? 0 : j, 0, id);
  applyWsVisualOrder(ids);
}
export function togglePinWs(id) {
  if (wsPinned(id)) wsPrefs.pinned = wsPrefs.pinned.filter((x) => x !== id);
  else wsPrefs.pinned.push(id);
  emit();
  schedulePersist();
}
export function setWsColor(id, color) {
  if (color) wsPrefs.color[id] = color;
  else delete wsPrefs.color[id];
  emit();
  schedulePersist();
}
export function renameWs(id, name) {
  const v = String(name || "").trim();
  if (v) wsPrefs.rename[id] = v.slice(0, 80);
  else delete wsPrefs.rename[id];
  emit();
  schedulePersist();
}

// 로그인 계정 프로필 로드(deviceToken→user). 미로그인이면 null.
export async function loadMe() {
  try {
    state.me = (await api.fetchMe()) || null;
  } catch (_) {
    state.me = null;
  }
  state.authChecked = true; // 페어링됐는데 me 가 null 이면(=토큰 폐기됨) 로그인 게이트가 뜬다.
  emit();
}

// 계정의 기기 목록 로드(멀티기기).
export async function loadDevices() {
  try {
    const r = await api.fetchDevices();
    state.devices = (r && r.devices) || [];
    state.currentDeviceId = (r && r.currentDeviceId) || null;
  } catch (_) {
    state.devices = [];
  }
  emit();
}

// 멀티기기 백필: hostDeviceId 없는 로컬 워크스페이스 중, 그 경로가 이 기기에 실재하면 이 호스트로 귀속.
export async function reconcileWorkspaceHosts() {
  if (!state.paired) return;
  const targets = state.workspaces.filter((w) => isLocal(w) && w.localPath && w.hostDeviceId == null);
  if (!targets.length) return;
  let changed = false;
  for (const w of targets) {
    try {
      if (!(await api.pathExists(w.localPath))) continue; // 이 기기에 그 폴더가 없으면 남의 것 → 건너뜀
      const meta = await api.claimWorkspace(w.id);
      const hid = meta && (meta.hostDeviceId ?? meta.data?.hostDeviceId);
      if (hid != null) { w.hostDeviceId = hid; changed = true; }
    } catch (_) {
      /* 개별 실패는 무시 */
    }
  }
  if (changed) emit();
}

export function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  emit();
}

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
  schedulePersist();
}

// ── 워크스페이스 조회 헬퍼 ──
export function activeWs() {
  return state.workspaces.find((w) => w.id === state.activeWsId) || null;
}
export function wsRuntime(id) {
  return state.ws[id] || null;
}
export function isLocal(w) {
  return w && (w.compute === "local" || (!w.compute && w.localPath));
}
// 이 PC(호스트)의 워크스페이스인가 — 로컬 tmux 직결 가능 여부. 다른 PC 의 사본(hostDeviceId 상이)은
// back 릴레이로 열어야 한다(멀티 PC). deviceId 를 모르면(구버전/미페어링) 기존 동작(전부 내 것) 보존.
export function isThisHost(w) {
  if (!isLocal(w)) return false;
  const my = state.daemon?.deviceId;
  return w.hostDeviceId == null || my == null || w.hostDeviceId === my;
}

// 워크스페이스 런타임 보장(레이아웃 없으면 단일 터미널로 초기화).
export function ensureRuntime(id) {
  if (!state.ws[id]) {
    state.ws[id] = { layout: T.leaf("terminal", { win: "new" }), focusId: null, surfaces: [], ports: [] };
    state.ws[id].focusId = T.firstLeafId(state.ws[id].layout);
  }
  return state.ws[id];
}

export function setActive(id) {
  state.activeWsId = id;
  state.view = "workspace";
  if (id) {
    ensureRuntime(id);
    pullSession(id); // 첫 활성 시 원격 세션 이어받기(1회)
  }
  emit();
  // 워크스페이스 진입 = 읽음 처리 X(모바일 패리티). 미읽음 알림이 있으면 그 알림이 귀속된
  //  터미널을 활성 탭+포커스로 "잘 보이게"만 한다(읽음은 사용자가 실제로 볼 때만).
  //  대상 터미널이 아직 레이아웃에 없으면(다른 기기가 만든 창=리컨실 대기) 한 번 지연 재시도.
  if (id) {
    if (!activateNotifTerminal(id)) setTimeout(() => activateNotifTerminal(id), 400);
  }
}

// 미읽음 알림이 귀속된 터미널(win)을 활성 탭 + 포커스로 올린다 — 읽음은 처리하지 않는다.
//  preferredWin 지정 시 그 win 우선, 없으면 가장 최근(맨 앞) 미읽음의 win.
//  반환: true = 처리했거나 미읽음 없음, false = 미읽음은 있으나 대상 터미널 미발견(재시도 권장).
export function activateNotifTerminal(wsId, preferredWin) {
  const meta = state.workspaces.find((w) => w.id === wsId);
  const w = state.ws[wsId];
  if (!meta || !meta.localPath || !w || !w.layout) return true;
  const unread = state.notifications.filter(
    (n) => !n.read && n.cwd && n.cwd === meta.localPath && typeof n.win === "number"
  );
  if (!unread.length) return true;
  const wins = new Set(unread.map((n) => n.win));
  const targetWin = preferredWin != null && wins.has(Number(preferredWin)) ? Number(preferredWin) : unread[0].win;
  let hit = null, hitIdx = -1;
  T.eachLeaf(w.layout, (l) => {
    if (hit || l.kind !== "terminal") return;
    const idx = (l.tabs || []).findIndex((t) => typeof t.win === "number" && t.win === targetWin);
    if (idx >= 0) { hit = l; hitIdx = idx; }
  });
  if (!hit) return false; // 대상 터미널이 아직 레이아웃에 없음(리컨실 대기)
  w.focusId = hit.id;
  const pane = getPane(hit.id);
  if (pane && typeof pane.switchTab === "function") {
    pane.switchTab(hitIdx); // 활성 탭 전환 + view + 포커스(읽음 트리거 없음 — 프로그램적)
    pane.focus?.();
  } else {
    hit.active = hitIdx; // pane 미생성 — 상태만 반영해 렌더가 올바른 활성 탭으로 뜨게
    emit();
  }
  return true;
}

export function setView(v) {
  state.view = v;
  emit();
}

// ── 분할/닫기/포커스 ──
export function splitPane(paneId, dir, kind, opts) {
  const w = wsRuntime(state.activeWsId);
  if (!w || !paneId) return;
  // 새 터미널 pane = 풀에 새 터미널('new' → _ensureWin 이 생성, 전 기기에 나타남).
  //  opts.fresh: 사용자가 명시적으로 "터미널 추가"한 경우 — 입양(claim) 없이 반드시 새로 생성.
  const node = kind === "preview" || kind === "ide" ? T.leaf(kind, opts) : T.leaf("terminal", { win: "new" });
  if (node.kind === "terminal" && opts && opts.fresh) node.tabs[0].fresh = true;
  const r = T.split(w.layout, paneId, dir, node);
  w.layout = r.tree;
  w.focusId = r.added.id;
  emit();
}
export function splitFocused(dir, kind, opts) {
  const w = wsRuntime(state.activeWsId);
  if (w && w.focusId) splitPane(w.focusId, dir, kind, opts);
}
export function closeFocused() {
  closePane(state.activeWsId, wsRuntime(state.activeWsId)?.focusId);
}
export function closePane(wsId, paneId) {
  const w = wsRuntime(wsId);
  if (!w || !paneId) return;
  // 닫는 pane 의 터미널 window(작업)를 kill — 로컬. "닫으면 날아가고, 새로 열면 새 터미널".
  const ws = state.workspaces.find((x) => x.id === wsId);
  const leaf = T.findLeaf(w.layout, paneId);
  if (leaf && leaf.kind === "terminal" && isThisHost(ws)) {
    for (const t of leaf.tabs || []) {
      if (typeof t.win === "number") api.killWindow(ws.localPath || "", t.win).catch(() => {});
    }
  }
  const r = T.closeLeaf(w.layout, paneId);
  w.layout = r.tree;
  w.focusId = r.focusId || (w.layout ? T.firstLeafId(w.layout) : null);
  if (!w.layout) {
    // 마지막 pane 을 닫으면 완전히 새 터미널(새 tmux window)로 — 이전 작업 안 보임.
    w.layout = T.leaf("terminal", { win: "new" });
    w.focusId = T.firstLeafId(w.layout);
  }
  emit();
}
export function focusPane(paneId) {
  const w = wsRuntime(state.activeWsId);
  if (w) {
    w.focusId = paneId;
    emit();
    // 프로그램적/포커스 이동으로는 읽음 처리하지 않는다(모바일 패리티). 읽음은 사용자가
    //  터미널을 실제 클릭하거나 탭을 직접 클릭할 때만(pane.js 에서 onTabActivated 로 트리거).
  }
}
export function setRatio(branchPath, ratio) {
  const w = wsRuntime(state.activeWsId);
  if (!w) return;
  w.layout = T.setRatio(w.layout, branchPath, ratio);
  emit();
}

// ── 알림(서버 미러) ──
//  원천 = 백엔드 /api/notifications. state.notifications 는 서버 행 그대로(read=!!readAt 파생)를
//  미러하고, ui-channel(WS notif_event)이 실시간 반영한다. 서버 미가용 시 pushNotification 로컬 폴백.

// PC 창이 포커스/가시 상태가 아니면(사용자가 다른 앱/브라우저를 보는 중) OS 네이티브 알림.
//  · 새 알림이 state 에 편입되는 단일 지점(applyNotifEvent 'new' / pushNotical)에서만 호출 →
//    로컬 OSC(handleOsc)가 별도로 api.notify 를 부르지 않아 이중 발송이 없다(pushNotification/applyNotifEvent).
//  · 이미 읽은 알림엔 울리지 않고, 400ms 스로틀로 연속 알림 폭주를 막는다.
let _lastOsNotify = 0;
// alertForMe = 서버가 이 기기를 present(지금 보고 있는 기기)로 지정했는지 — 아니면 소리/배너 없이 뱃지만.
export function maybeOsNotify(n, alertForMe = true) {
  if (!n || n.read || !alertForMe) return;
  let hidden = false;
  try {
    hidden = !document.hasFocus() || document.visibilityState !== "visible";
  } catch (_) {
    hidden = true;
  }
  if (!hidden) return;
  const now = Date.now();
  if (now - _lastOsNotify < 400) return;
  _lastOsNotify = now;
  const title = String(n.title || n.wsName || "CodingPT");
  const body = String(n.body || "");
  try {
    const r = api.notify(title, body);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

// 로컬 폴백 — 서버 기록 실패 시 이 세션 한정으로만 쌓는다(id 는 문자열 "n…" = 서버 미기록 표식).
export function pushNotification(n) {
  const item = {
    id: "n" + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    read: false,
    ...n,
  };
  state.notifications.unshift(item);
  if (state.notifications.length > 100) state.notifications.length = 100;
  maybeOsNotify(item);
  emit();
  return item;
}

// 서버 알림 목록 로드(부팅·ui-channel 재접속 시). 실패해도 부팅을 막지 않는다.
export async function loadNotifications() {
  try {
    const data = await api.notifList(50);
    const rows = (data && (data.notifications || data.data?.notifications)) || [];
    state.notifications = rows.map((n) => ({ ...n, read: !!n.readAt }));
    emit();
  } catch (_) {
    /* 서버 미가용 — 기존(로컬) 목록 유지 */
  }
}

// ui-channel WS 이벤트 반영 — kind:'new'(id 로 dedupe·100개 상한) | kind:'read'(ids 읽음).
export function applyNotifEvent(ev) {
  if (!ev) return;
  if (ev.kind === "new" && ev.notification) {
    const n = { ...ev.notification, read: !!ev.notification.readAt };
    if (n.id != null && state.notifications.some((x) => x.id === n.id)) return; // WS 에코 dedupe
    state.notifications.unshift(n);
    if (state.notifications.length > 100) state.notifications.length = 100;
    // 서버가 present 로 지정한 기기(alertClientKey===내 deviceKey)에서만 OS 알림 — 나머진 뱃지만.
    maybeOsNotify(n, ev.alertClientKey == null ? false : ev.alertClientKey === deviceKey());
    emit();
  } else if (ev.kind === "read" && Array.isArray(ev.ids)) {
    const set = new Set(ev.ids);
    let changed = false;
    for (const n of state.notifications) {
      if (set.has(n.id) && !n.read) { n.read = true; changed = true; }
    }
    if (changed) emit();
  }
}

// 알림 발생 보고 — 서버에 기록(fire-and-forget). 생성 행은 WS 에코로도 오지만, WS 가 끊겨 있어도
//  패널에 보이도록 응답 행을 직접 반영한다(applyNotifEvent 가 id 로 dedupe). 실패 시 로컬 폴백.
export function reportNotification(p) {
  api
    .notifCreate(p)
    .then((row) => {
      const n = row && row.id != null ? row : row?.data;
      if (n && n.id != null) applyNotifEvent({ kind: "new", notification: n });
    })
    .catch(() => {
      pushNotification({ ...p, wsId: p.workspaceId });
    });
}

export function markAllRead() {
  state.notifications.forEach((n) => (n.read = true));
  emit();
  api.notifReadAll().catch(() => {});
}

// 스코프 읽음 처리 — 사용자가 그 터미널을 실제로 클릭/탭 클릭한 순간(pane.js onTabActivated),
//  그 cwd(+win) 의 로컬 미읽음이 있을 때만 서버 호출(+낙관 반영). 프로그램적 포커스/전환은 제외.
export function readScope(cwd, win) {
  if (!cwd) return;
  const w = win == null ? null : win;
  const hit = state.notifications.filter(
    (n) => !n.read && n.cwd && n.cwd === cwd && (w == null || String(n.win) === String(w))
  );
  if (!hit.length) return;
  hit.forEach((n) => (n.read = true));
  emit();
  api.notifRead({ scope: { cwd, win: w } }).catch(() => {});
}

// 워크스페이스별 미읽음 수 — 서버 행(workspaceId/cwd)과 로컬 폴백(wsId) 모두 매칭.
export function unreadForWs(w) {
  if (!w) return 0;
  return state.notifications.filter(
    (n) => !n.read && (n.workspaceId === w.id || n.wsId === w.id || (n.cwd && n.cwd === w.localPath))
  ).length;
}

// ── 원격 상태 스트림(ui_command status.changed) — cwd(홈-상대 localPath) 키 ──
//  back 이 흘려주는 워크스페이스 작업 상태(status[]/progress/logTail)를 미러. 사이드바가 최소 표시.
export const wsStatus = new Map(); // cwd -> { status:[], progress, logTail, ts }
export function setWsStatus(cwd, payload) {
  if (!cwd) return;
  wsStatus.set(cwd, { ...(payload || {}), ts: Date.now() });
  emit();
}

// ── 백엔드 워크스페이스 로드 ──
export async function loadWorkspaces() {
  try {
    const data = await api.fetchWorkspaces();
    const list = Array.isArray(data) ? data : data?.workspaces || data?.data || [];
    state.workspaces = list;
    state.wsError = null;
    // 활성 워크스페이스가 사라졌으면 초기화.
    if (state.activeWsId && !state.workspaces.some((w) => w.id === state.activeWsId)) {
      state.activeWsId = null;
    }
    // 첫 로컬 워크스페이스를 기본 활성으로.
    if (!state.activeWsId) {
      const first = state.workspaces.find(isLocal) || state.workspaces[0];
      if (first) {
        state.activeWsId = first.id;
        ensureRuntime(first.id);
        pullSession(first.id);
      }
    } else {
      pullSession(state.activeWsId);
    }
  } catch (e) {
    state.wsError = String(e);
  }
  emit();
}

// ── 새 워크스페이스(폴더 피커 → 로컬 워크스페이스 생성 → 터미널 열기) ──
export async function createLocalWorkspace() {
  if (state.creatingWs) return;
  state.creatingWs = true;
  try {
    const abs = await api.pickFolder();
    if (!abs) {
      state.creatingWs = false;
      return;
    }
    const meta = await api.createWorkspace(String(abs));
    await loadWorkspaces();
    if (meta && meta.id) {
      state.activeWsId = meta.id;
      ensureRuntime(meta.id);
      state.view = "workspace";
    }
  } catch (e) {
    state.wsError = String(e);
    // 알림 대신 콘솔(폴더가 홈 밖이면 여기로).
    console.error("워크스페이스 생성 실패:", e);
  } finally {
    state.creatingWs = false;
    emit();
  }
}

// 이 PC 설치본의 안정 기기 키 — 세션 매니페스트에 발신 기기를 표시(다른 기기가 pull 시 win 리셋 판단).
//  ui-channel 의 ui_hello(clientKey)도 같은 키를 재사용한다.
const DEVICE_KEY_LS = "cpt.deviceKey";
export function deviceKey() {
  let k = "";
  try { k = localStorage.getItem(DEVICE_KEY_LS) || ""; } catch (_) {}
  if (!k) {
    k = "pc-" + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(DEVICE_KEY_LS, k); } catch (_) {}
  }
  return k;
}

// 터미널 탭의 win 을 전부 'new' 로 리셋(제목/배치 유지) — 다른 기기(또는 구 아키텍처)에서 온
//  레이아웃의 win 은 이 기기의 pane 세션에 존재하지 않으므로, 새 셸로 다시 확보한다.
function resetTerminalWins(node) {
  if (!node) return;
  if (T.isLeaf(node)) {
    if (node.kind === "terminal" && Array.isArray(node.tabs)) {
      node.tabs = node.tabs.map((t) => ({ win: "new", title: (t && t.title) || "" }));
    }
    return;
  }
  resetTerminalWins(node.first);
  resetTerminalWins(node.second);
}

// ── 영속화(pc-ui.json) ──
function serialize() {
  const ws = {};
  for (const [id, w] of Object.entries(state.ws)) {
    ws[id] = { layout: w.layout, focusId: w.focusId };
  }
  // v: 2 = pane 독립 세션 아키텍처 이후 저장본(복원 시 win 재사용 가능 표식).
  return { v: 3, activeWsId: state.activeWsId, ws, wsPrefs };
}
let saveTimer = null;
function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.uiSave(serialize()).catch(() => {});
  }, 600);
  scheduleSessionPush();
}

// ── 워크스페이스 세션 동기화(이어받기: PC↔모바일) ──
//  레이아웃 트리(열린 터미널=tmux window, IDE, 프리뷰)를 기기 무관 표면 목록 + 트리로 백엔드에 푸시.
//  모바일은 surfaces[] 를 자기 UI(탭)로 렌더, PC/PC 는 layout 트리로 완전 복원.
const _sessionPulled = new Set(); // 앱 실행 중 워크스페이스별 1회만 pull(라이브 상태 덮어쓰기 방지)
const _lastPushed = {}; // wsId -> 마지막 푸시 JSON(무변경 스킵)
let _sessionPushTimer = null;

function leafSurfaces(node, acc = []) {
  if (!node) return acc;
  if (T.isLeaf(node)) {
    if (node.kind === "terminal") {
      for (const t of node.tabs || []) {
        if (typeof t.win === "number") acc.push({ id: `${node.id}:${t.win}`, kind: "terminal", win: t.win, title: t.title || "" });
      }
    } else if (node.kind === "ide") {
      acc.push({ id: node.id, kind: "ide", path: node.openPath || null });
    } else if (node.kind === "preview") {
      acc.push({ id: node.id, kind: "preview", url: node.url || "" });
    }
    return acc;
  }
  leafSurfaces(node.first, acc);
  leafSurfaces(node.second, acc);
  return acc;
}

function buildSession(wsId) {
  const w = state.ws[wsId];
  if (!w || !w.layout) return null;
  // device = 발신 기기 키. pull 하는 쪽이 "내가 푸시한 것"인지 판단해 win 재사용/리셋을 가른다.
  return { version: 1, device: deviceKey(), surfaces: leafSurfaces(w.layout), layout: w.layout, focusId: w.focusId || null };
}

function scheduleSessionPush() { /* no-op — 세션 매니페스트 동기화 폐지(공유 풀 모델) */ }

// 세션 이어받기 폐지(공유 풀 모델) — 배치는 기기별(로컬 영속만). 터미널 내역은 tmux 풀이
//  원천이라 리컨실러가 실시간 동기화한다. (레이아웃 원격 pull 은 pane 을 갈아치우며
//  스트림 킥/복제 혼란을 만들던 주범이라 제거.)
export async function pullSession(_wsId) { /* no-op */ }

// 구버전 레이아웃(leaf.win 단일)을 새 형식(leaf.tabs)으로 마이그레이션.
function migrateTree(node) {
  if (!node) return node;
  if (T.isLeaf(node)) {
    if (node.kind !== "preview" && !Array.isArray(node.tabs)) {
      node.kind = "terminal";
      node.tabs = [{ win: typeof node.win === "number" ? node.win : 0, title: "" }];
      node.active = 0;
      delete node.win;
    }
    return node;
  }
  migrateTree(node.first);
  migrateTree(node.second);
  return node;
}

// ── 풀 리컨실러 — 공유 터미널 풀(전 기기 내역의 원천)과 이 PC 레이아웃을 동기화(7s) ──
//  · 풀에 없는 탭 제거(다른 기기에서 터미널 삭제됨). 빈 터미널 pane 은 leaf 제거.
//  · 레이아웃에 없는 풀 터미널은 포커스(없으면 첫) 터미널 pane 탭으로 편입(다른 기기가 생성).
//  · 탭 제목 = 풀 window 이름("터미널 N") 동기화.
let _reconciling = false;
export async function reconcilePool() {
  if (_reconciling || state.view !== "workspace") return;
  const wsId = state.activeWsId;
  const w = wsId ? state.ws[wsId] : null;
  const meta = state.workspaces.find((x) => x.id === wsId);
  if (!w || !w.layout || !meta || !isThisHost(meta)) return;
  _reconciling = true;
  try {
    const wins = (await api.listWindows(meta.localPath || "")) || [];
    // 빈 목록은 신뢰하지 않는다 — Rust list_terminals 는 tmux 오류도 [] 로 주므로, "전부 삭제됨"
    //  오판이 레이아웃 전멸(pane 교체)로 이어진다. 진짜 비었으면 pty_open(resolve_tid)이 새로 만든다.
    if (!wins.length) return;
    // 'new'(풀 window 확보 진행 중) 탭이 있으면 이번 틱 스킵 — 방금 만든 터미널의 중복 편입 방지.
    let pending = false;
    T.eachLeaf(w.layout, (l) => { if (l.kind === "terminal") { for (const t of l.tabs) if (t.win === "new") pending = true; } });
    if (pending) return;
    const pool = new Map(wins.map((x) => [x.index, x]));
    const seen = new Set();
    const touched = new Set();
    const deadPanes = [];
    let changed = false;
    T.eachLeaf(w.layout, (l) => {
      if (l.kind !== "terminal") return;
      const before = l.tabs.length;
      const activeTab = l.tabs[l.active];
      l.tabs = l.tabs.filter((t) => {
        if (typeof t.win !== "number") return true;
        const p = pool.get(t.win);
        if (!p) { changed = true; return false; }
        seen.add(t.win);
        if (p.name && t.title !== p.name) { t.title = p.name; changed = true; touched.add(l.id); }
        // 실행 중 명령(pane_current_command) — 탭 라벨 부제("이름 · claude")로 표시(cmux 미러).
        const cmd = p.command || "";
        if ((t.cmd || "") !== cmd) { t.cmd = cmd; changed = true; touched.add(l.id); }
        return true;
      });
      if (l.tabs.length !== before) touched.add(l.id);
      if (!l.tabs.length) { deadPanes.push(l.id); return; }
      const ai = l.tabs.indexOf(activeTab);
      l.active = ai >= 0 ? ai : Math.max(0, Math.min(l.tabs.length - 1, l.active));
    });
    // 빈 pane 제거 — 터미널이 타 기기에서 삭제됨(풀은 이미 정리, 로컬 kill 불필요).
    for (const id of deadPanes) {
      const r = T.closeLeaf(w.layout, id);
      w.layout = r.tree || T.leaf("terminal", { win: "new" });
      w.focusId = r.focusId || T.firstLeafId(w.layout);
      changed = true;
    }
    // 레이아웃에 없는 풀 터미널 편입(다른 기기가 생성).
    const missing = wins.filter((x) => !seen.has(x.index));
    if (missing.length && w.layout) {
      let targetId = null;
      const f = w.focusId ? T.findLeaf(w.layout, w.focusId) : null;
      if (f && f.kind === "terminal") targetId = f.id;
      if (!targetId) T.eachLeaf(w.layout, (l) => { if (!targetId && l.kind === "terminal") targetId = l.id; });
      if (targetId) {
        const leafT = T.findLeaf(w.layout, targetId);
        for (const m of missing) leafT.tabs.push({ win: m.index, title: m.name || "" });
        // 트리 전멸 폴백으로 방금 만든 'new' placeholder 는 실제 풀 window 가 편입됐으면 제거 —
        //  남겨두면 mount 의 _ensureWin 이 풀에 불필요한 새 터미널을 또 만든다.
        //  (진짜 진행 중인 'new' 탭이 있으면 위 pending 가드가 이번 틱을 이미 스킵했으므로 안전)
        if (leafT.tabs.length > 1) {
          leafT.tabs = leafT.tabs.filter((t) => t.win !== "new");
          leafT.active = Math.max(0, Math.min(leafT.active, leafT.tabs.length - 1));
        }
        touched.add(targetId);
        changed = true;
      } else {
        // 터미널 pane 이 하나도 없으면(전부 IDE/프리뷰) 첫 leaf 우측 분할로 편입.
        const anchor = T.firstLeafId(w.layout);
        if (anchor) {
          const leafNode = { id: T.newPaneId(), kind: "terminal", tabs: missing.map((m) => ({ win: m.index, title: m.name || "" })), active: 0 };
          w.layout = T.split(w.layout, anchor, "h", leafNode).tree;
          changed = true;
        }
      }
    }
    if (changed) {
      for (const id of touched) getPane(id)?.buildHead();
      emit();
    }
  } catch (_) { /* 오프라인 */ } finally { _reconciling = false; }
}
setInterval(() => { reconcilePool(); }, 7000);

export async function restorePersisted() {
  try {
    const saved = await api.uiLoad();
    if (!saved) return;
    // v3 이전 저장본 — win 이 공유 풀 인덱스가 아니라 무효. 레이아웃 복원을 건너뛰고(1회 초기화)
    //  풀 리컨실러가 실제 터미널들을 새 레이아웃에 편입하게 한다.
    if (saved.v === 3 && saved.ws && typeof saved.ws === "object") {
      const allIds = [];
      for (const [id, w] of Object.entries(saved.ws)) {
        if (w && w.layout) {
          const layout = migrateTree(w.layout);
          state.ws[id] = { layout, focusId: w.focusId || T.firstLeafId(layout), surfaces: [], ports: [] };
          allIds.push(...T.leafIds(layout));
        }
      }
      T.bumpSeq(allIds);
    }
    if (saved.activeWsId) state.activeWsId = saved.activeWsId;
    if (saved.wsPrefs && typeof saved.wsPrefs === "object") {
      wsPrefs.order = Array.isArray(saved.wsPrefs.order) ? saved.wsPrefs.order : [];
      wsPrefs.pinned = Array.isArray(saved.wsPrefs.pinned) ? saved.wsPrefs.pinned : [];
      wsPrefs.color = saved.wsPrefs.color && typeof saved.wsPrefs.color === "object" ? saved.wsPrefs.color : {};
      wsPrefs.rename = saved.wsPrefs.rename && typeof saved.wsPrefs.rename === "object" ? saved.wsPrefs.rename : {};
    }
  } catch (_) {
    /* 복원 실패는 무시(빈 상태로 시작) */
  }
}
