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
  const node = kind === "preview" || kind === "ide" ? T.leaf(kind, opts) : T.leaf("terminal", { win: "new" });
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
  if (leaf && leaf.kind === "terminal" && isLocal(ws)) {
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
  }
}
export function setRatio(branchPath, ratio) {
  const w = wsRuntime(state.activeWsId);
  if (!w) return;
  w.layout = T.setRatio(w.layout, branchPath, ratio);
  emit();
}

// ── 알림 ──
export function pushNotification(n) {
  const item = {
    id: "n" + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    read: false,
    ...n,
  };
  state.notifications.unshift(item);
  if (state.notifications.length > 100) state.notifications.length = 100;
  emit();
  return item;
}
export function markAllRead() {
  state.notifications.forEach((n) => (n.read = true));
  emit();
}
export function unreadForWs(wsId) {
  return state.notifications.filter((n) => n.wsId === wsId && !n.read).length;
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
const DEVICE_KEY_LS = "cpt.deviceKey";
function deviceKey() {
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
  if (!w || !w.layout || !meta || !isLocal(meta)) return;
  _reconciling = true;
  try {
    const wins = (await api.listWindows(meta.localPath || "")) || [];
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
