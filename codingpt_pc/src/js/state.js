// state.js — 앱 중앙 상태 + 구독 + 영속화. 뷰 모듈이 이 상태를 읽어 렌더한다.
import { api } from "./api.js";
import * as T from "./tiling.js";
import { getPane } from "./pane.js";

export const state = {
  paired: false,
  daemon: null, // 최근 daemon_status
  workspaces: [], // 백엔드 목록 [{id,name,localPath,compute,...}]
  wsError: null, // 워크스페이스 로드 오류(오프라인 등)
  // 목록이 로컬 캐시(pc-ws-cache.json)에서 왔음 = 서버 미가용. { cachedAt } | null.
  //  ⚠ 캐시가 있다고 원격 조작을 허용하면 안 된다 — 이 PC 로컬 워크스페이스 진입만 허용하고
  //    서버가 원천인 조작(생성/삭제/그룹핑/claim)과 다른 PC/클라우드 진입은 전부 막는다.
  wsStale: null,
  activeWsId: null,
  ws: {}, // wsId -> { layout, focusId, surfaces:[{index,active,command}], branch:{}, ports:[] }
  notifications: [], // [{id, wsId, paneId, title, body, ts, read}]
  // 원격 승인 인박스(기능1) — 대기 중 승인 카드. 정본은 데몬, back 은 인덱스, 우리는 미러다.
  //  push(approval_event)는 힌트고 pull(GET /api/daemon/approvals)이 정본 — 부팅/재접속마다 재조회.
  approvals: [], // [{id, tool, kind, summary, prompt, relPath, cwd, wsName, win, deadlineAt, …, _busy?, _err?}]
  view: "workspace", // 'workspace' | 'settings'
  sidebarCollapsed: false,
  creatingWs: false,
  me: null, // 로그인 계정 프로필 {id,email,nickname,profileImg,...} — 웹 로그인 후 표시
  authChecked: false, // loadMe 를 최소 1회 시도했는지(로그인 게이트 판정용 — 페어링돼도 계정 확인 실패 시 게이트)
  devices: [], // 계정의 모든 기기(멀티기기 "내 기기")
  currentDeviceId: null, // 이 기기의 DaemonDevice id
};

// 워크스페이스 로컬 표시 설정(순서/고정/색/이름/터미널 시드 여부) — 백엔드 목록과 별개로 pc-ui.json 영속.
//  seeded: 이 기기에서 그 워크스페이스에 "최초 1회 터미널 자동 준비"를 이미 했는가 — 이후엔
//  사용자가 터미널을 전부 닫으면 0개 상태를 존중한다(자동 재생성 금지, 전 기기 공통).
export const wsPrefs = { order: [], pinned: [], color: {}, rename: {}, seeded: [] };

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
//  ⚠ "서버에 못 물어봤다"와 "미로그인"을 구분한다. Rust fetch_me 는 401(토큰 폐기)만 Ok(null) 로,
//    네트워크/5xx 실패는 Err 로 올린다. Err 를 미로그인으로 처리하면 **서버가 죽은 동안 로그인 게이트가
//    앱을 덮어** 로컬 폴더 작업(터미널·IDE — 서버 무관)에 진입조차 못 한다(오프라인 부팅의 진짜 벽).
//    그러므로 실패 시엔 authChecked 를 켜지 않고(=게이트 판정 보류) 알고 있던 프로필도 지우지 않는다.
export async function loadMe() {
  try {
    state.me = (await api.fetchMe()) || null;
    // 모양 설정(계정 동기화) 부트 적용 — 서버 정본을 로컬 캐시/화면에 반영(서버로 되밀지 않음).
    if (state.me && state.me.appearance) {
      try { (await import("./theme.js")).applyRemoteAppearance(state.me.appearance); } catch (_) {}
    }
    state.authChecked = true; // 페어링됐는데 me 가 null 이면(=토큰 폐기됨) 로그인 게이트가 뜬다.
  } catch (_) {
    /* 서버 미가용 — 판정 보류(게이트 없음, 기존 프로필 유지) */
  }
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

// 멀티기기 백필 + 스테일 호스트 복구:
//  ① hostDeviceId 없는 로컬 워크스페이스 — 경로가 이 기기에 실재하면 이 호스트로 귀속(기존).
//  ② hostDeviceId 가 "내 계정의 죽은 기기"를 가리키는 워크스페이스 — 재로그인마다 페어링이 새
//     device 행을 만들면 기존 워크스페이스가 옛(오프라인·무효토큰) 기기에 고아로 묶여 터미널이
//     영구 409(DAEMON_OFFLINE)가 된다. 경로가 이 기기에 실재하고 묶인 기기가 온라인이 아니면
//     현재 기기로 재클레임한다. (묶인 기기가 온라인이면 진짜 다른 PC → 건드리지 않음)
export async function reconcileWorkspaceHosts() {
  if (!state.paired) return;
  // 캐시(stale) 목록으로는 절대 실행하지 않는다 — 옛 목록으로 claimWorkspace 가 돌면 호스트 귀속이
  //  오염된다(그리고 claim 자체가 서버 호출이라 어차피 실패한다).
  if (state.wsStale) return;
  const myId = state.daemon?.deviceId;
  const nullTargets = state.workspaces.filter((w) => isLocal(w) && w.localPath && w.hostDeviceId == null);
  const staleCands = myId != null
    ? state.workspaces.filter((w) => isLocal(w) && w.localPath && w.hostDeviceId != null && w.hostDeviceId !== myId)
    : [];
  if (!nullTargets.length && !staleCands.length) return;
  // 스테일 판정용 — 내 기기 목록에서 온라인 기기 id 집합(목록에 없으면 내 계정 기기 아님=스테일).
  let onlineIds = null;
  if (staleCands.length) {
    try {
      const d = await api.fetchDevices();
      const list = (d && (d.devices || d.data?.devices)) || (Array.isArray(d) ? d : []);
      onlineIds = new Set(list.filter((x) => x && x.online).map((x) => x.id));
    } catch (_) { onlineIds = null; /* 목록 실패 시 스테일 재클레임 보류(안전) */ }
  }
  const targets = [...nullTargets];
  if (onlineIds) {
    for (const w of staleCands) {
      if (!onlineIds.has(w.hostDeviceId)) targets.push(w); // 묶인 기기가 온라인이 아님 → 복구 대상
    }
  }
  let changed = false;
  for (const w of targets) {
    try {
      if (!(await api.pathExists(w.localPath))) continue; // 이 기기에 그 폴더가 없으면 남의 것 → 건너뜀
      const meta = await api.claimWorkspace(w.id);
      const hid = meta && (meta.hostDeviceId ?? meta.data?.hostDeviceId);
      if (hid != null && hid !== w.hostDeviceId) {
        api.debugLog(`hosts: 워크스페이스 ${w.id} 호스트 재클레임 ${w.hostDeviceId} → ${hid}`);
        w.hostDeviceId = hid;
        changed = true;
      } else if (hid != null) { w.hostDeviceId = hid; changed = true; }
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

// 오프라인(캐시 목록) 전용 판정 — **확실히 내 것일 때만** true.
//  isThisHost 는 "모르면 내 것"으로 관용하는데(구버전·미페어링 호환), 오프라인에서는 그 관용이
//  구멍이 된다: 서버가 죽은 채 부팅하면 daemon_status 가 오기 전(또는 데몬 미기동)에 my == null 이라
//  **다른 PC 의 워크스페이스도 게이트를 통과**해 진입한다 → 빈 화면 + 실패 폭풍(이 라운드가 막으려던
//  바로 그 증상). 그래서 여기서는 내 deviceId 를 알고 그것과 일치할 때만 허용한다.
//  hostDeviceId 가 없는 레거시 항목은 로컬 경로가 있으면 이 PC 것으로 본다(그 시절엔 멀티PC 가 없었다).
function isThisHostStrict(w) {
  if (!isLocal(w)) return false;
  const my = state.daemon?.deviceId;
  if (w.hostDeviceId == null) return true;   // 레거시 = 귀속 정보 없음 → 로컬 경로 신뢰
  return my != null && w.hostDeviceId === my;
}

// 워크스페이스 런타임 보장. 최초 진입(기기별 1회)에만 터미널 시드('new' → 기존 입양 우선, 없으면
//  생성) — 이미 시드한 적 있으면 빈 pane 으로 시작해 리컨실러가 실제 터미널 목록을 그대로 반영한다.
export function ensureRuntime(id) {
  if (!state.ws[id]) {
    const seeded = wsPrefs.seeded.includes(id);
    state.ws[id] = {
      layout: T.leaf("terminal", seeded ? { empty: true } : { win: "new" }),
      focusId: null, surfaces: [], ports: [],
    };
    state.ws[id].focusId = T.firstLeafId(state.ws[id].layout);
    if (!seeded) { wsPrefs.seeded.push(id); schedulePersist(); }
  }
  return state.ws[id];
}

export function setActive(id) {
  // 오프라인(캐시 목록)에서는 이 PC 로컬 워크스페이스만 진입 허용 — 다른 PC/클라우드는 서버 릴레이가
  //  있어야 조작되므로 열면 빈 화면 + 실패 폭풍이 된다(캐시가 원격 조작 허가는 아니다).
  if (id && state.wsStale) {
    const meta = state.workspaces.find((w) => w.id === id);
    if (meta && !isThisHostStrict(meta)) { blockedOffline("다른 기기의 워크스페이스 열기"); return; }
  }
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
  // opts.launchAgent: 터미널이 준비되면 그 에이전트를 실행(pane.js _ensureWin 이 tid 를 알 때 수행).
  if (node.kind === "terminal" && opts && opts.launchAgent) node.tabs[0].launchAgent = opts.launchAgent;
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
// 표면(프리뷰/IDE) 닫힘 훅 — ui-channel 이 등록해 다른 기기로 "같이 닫힘"을 전파한다.
let _surfaceCloseHook = null;
export function onSurfaceClose(fn) { _surfaceCloseHook = fn; }
export function fireSurfaceClose(kind, wsId) { try { _surfaceCloseHook?.(kind, wsId); } catch (_) { /* noop */ } }

export function closePane(wsId, paneId) {
  const w = wsRuntime(wsId);
  if (!w || !paneId) return;
  // 닫는 pane 의 터미널 window(작업)를 kill — 로컬. "닫으면 날아가고, 새로 열면 새 터미널".
  const ws = state.workspaces.find((x) => x.id === wsId);
  const leaf = T.findLeaf(w.layout, paneId);
  // pane 통째 닫힘에 프리뷰가 포함되면 다른 기기도 같이 닫도록 신호(원격 적용 중이면 훅이 재전파 안 함).
  if (leaf && (leaf.kind === "preview" || (leaf.kind === "terminal" && (leaf.tabs || []).some((t) => t.kind === "preview")))) {
    fireSurfaceClose("preview", wsId);
  }
  if (leaf && leaf.kind === "terminal" && isThisHost(ws)) {
    for (const t of leaf.tabs || []) {
      if (typeof t.win === "number") api.killWindow(ws.localPath || "", t.win).catch(() => {});
    }
  }
  const r = T.closeLeaf(w.layout, paneId);
  w.layout = r.tree;
  w.focusId = r.focusId || (w.layout ? T.firstLeafId(w.layout) : null);
  if (!w.layout) {
    // 마지막 pane 닫힘 = 터미널 0개 상태 유지(자동 재생성 금지 — 닫힘은 전 기기 공통 의사).
    //  빈 자리 pane 에서 + 로 언제든 추가.
    w.layout = T.leaf("terminal", { empty: true });
    w.focusId = T.firstLeafId(w.layout);
  }
  emit();
}
export function focusPane(paneId) {
  const w = wsRuntime(state.activeWsId);
  if (w) {
    // 이미 그 pane 이 포커스면 아무것도 하지 않는다 — pane 내부 mousedown(capture, pane.js)이 매번
    //  이걸 부르므로, 무조건 emit 하면 **클릭 한 번마다 전체 재렌더**가 돈다. 그 재렌더가 버튼의
    //  자식 노드를 교체하면 mousedown↔mouseup 사이에 타깃이 사라져 click 이 아예 발화하지 않는다
    //  (2026-07-27 TUI↔Chat 토글이 이 경로로 영구히 눌리지 않았다 — 실증). 렌더 억제는 그 사고 계열의
    //  재발 표면 자체를 줄이는 1차 방어이고, 2차 방어는 "글리프가 바뀔 때만 innerHTML 재작성"이다.
    if (w.focusId === paneId) return;
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
    // 순환 import 를 피하려고 알림 시점에만 로드한다. 설정 모듈 부재/구 캐시는 기본 소리로 폴백.
    const r = import("./notification-prefs.js")
      .then((m) => api.notify(title, body, m.getNotificationSound()))
      .catch(() => api.notify(title, body, "default"));
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

// ── 낙관(로컬 선표시) 알림의 서버 행 흡수 ──
//  로컬 터미널에서 난 알림을 "서버 왕복 후"에 보여주면 서버가 느리거나 죽었을 때 같은 화면에 띄울
//  알림이 늦거나 안 보인다. 그래서 즉시 로컬 항목(_pending)을 넣고, 나중에 도착한 서버 행(응답 또는
//  WS 에코)이 그 항목을 **흡수**한다. 흡수 규칙이 없으면 같은 알림이 2줄로 보인다(과거 dedupe 사고와 동형).
const PENDING_ABSORB_MS = 15000;
function absorbPending(n) {
  const i = state.notifications.findIndex(
    (x) =>
      x._pending &&
      Date.now() - (x.ts || 0) < PENDING_ABSORB_MS &&
      String(x.title || "") === String(n.title || "") &&
      String(x.body || "") === String(n.body || "") &&
      String(x.cwd || "") === String(n.cwd || "") &&
      String(x.win ?? "") === String(n.win ?? "")
  );
  if (i < 0) return false;
  const local = state.notifications[i];
  // 자리(정렬 위치)는 유지하고 id 만 서버 행으로 승격 — 읽음 상태는 로컬 판단을 존중한다.
  state.notifications[i] = { ...n, read: local.read || !!n.readAt, ts: local.ts };
  // 사용자가 서버 응답 전에 이미 읽었다면 승격된 숫자 id 로 읽음을 서버에 반영(뱃지 유령 방지).
  if (local.read && !n.readAt && typeof n.id === "number") api.notifRead({ ids: [n.id] }).catch(() => {});
  emit();
  return true;
}

// ui-channel WS 이벤트 반영 — kind:'new'(id 로 dedupe·100개 상한) | kind:'read'(ids 읽음).
export function applyNotifEvent(ev) {
  if (!ev) return;
  if (ev.kind === "new" && ev.notification) {
    const n = { ...ev.notification, read: !!ev.notification.readAt };
    if (n.id != null && state.notifications.some((x) => x.id === n.id)) return; // WS 에코 dedupe
    // 낙관 삽입분이 있으면 그것을 승격(2줄 방지). OS 배너는 낙관 시점에 이미 1회 울렸으므로 재발송 금지.
    if (absorbPending(n)) return;
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

// 알림 발생 보고 — **선표시-후동기화**. 같은 기기에서 난 알림을 같은 기기 화면에 띄우는 일에
//  서버 왕복을 기다리지 않는다(서버가 느리면 늦고, 죽으면 아예 안 보였다).
//   ① 즉시 로컬 항목(_pending) 삽입 + OS 배너 판단은 로컬 규칙(내 창 비포커스)으로 1회.
//   ② 서버 응답/WS 에코가 오면 그 항목을 흡수해 서버 id 로 승격(absorbPending) — 2줄 방지.
//   ③ 서버 실패 시 로컬 항목을 그대로 남긴다(기존 폴백과 동일 결과, 다만 지연 0).
//  ⚠ present 라우팅(다른 기기 알림 억제)은 서버 판정이 정본이고 여기서 건드리지 않는다. 낙관 배너는
//    **이 PC 자기 기기 화면**에만 해당하므로 기존 3케이스 규약과 충돌하지 않는다.
export function reportNotification(p) {
  const local = pushNotification({ ...p, wsId: p.workspaceId, _pending: true });
  api
    .notifCreate(p)
    .then((row) => {
      const n = row && row.id != null ? row : row?.data;
      if (n && n.id != null) promoteLocalNotif(local, { ...n, read: !!n.readAt });
    })
    .catch(() => {
      // 서버 미가용 — 이미 보이는 로컬 항목이 최종본이 된다(_pending 해제해 흡수 대상에서 제외).
      delete local._pending;
    });
}

// 응답 경로 승격 — 어떤 로컬 항목인지 **참조로 정확히** 안다(문자열 매칭 불필요).
//  이미 WS 에코가 같은 서버 행을 넣어 놨으면(에코가 먼저 도착 + 흡수 휴리스틱 미스) 로컬 항목을 제거한다
//  — 같은 id 가 2줄 남는 것이 최악이므로 이 경로에서 확정적으로 정리한다.
function promoteLocalNotif(local, n) {
  const i = state.notifications.indexOf(local);
  if (i < 0) return; // 100개 상한으로 밀려남 — 할 일 없음
  if (n.id != null && state.notifications.some((x) => x !== local && x.id === n.id)) {
    state.notifications.splice(i, 1);
    emit();
    return;
  }
  state.notifications[i] = { ...n, read: local.read || !!n.readAt, ts: local.ts };
  if (local.read && !n.readAt && typeof n.id === "number") api.notifRead({ ids: [n.id] }).catch(() => {});
  emit();
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

// ── 원격 승인 인박스(기능1) ──
// 캐치업 = REST 재조회(부팅·WS 재접속·창 재포커스). 실패해도 앱을 막지 않는다(카드만 안 보임).
export async function loadApprovals() {
  try {
    const data = await api.approvalList();
    const rows = (data && (data.approvals || data.data?.approvals)) || [];
    // 로컬 진행 상태(_busy/_err)는 재조회로 날리지 않는다 — 버튼 누른 직후 목록이 갱신되면
    //  스피너가 사라져 사용자가 두 번 누르게 된다.
    const prev = new Map(state.approvals.map((a) => [a.id, a]));
    const next = rows
      .filter((a) => a && a.id)
      .map((a) => ({ ...a, _busy: prev.get(a.id)?._busy || false, _err: prev.get(a.id)?._err || null }));
    // ★ 마감이 지난 카드는 서버 목록에서 빠지지만 **화면에서 조용히 지우지 않는다**(사용자 확정
    //  2026-07-28). 카드는 남아 '마감됐습니다 — PC 터미널에서 답해주세요' 로 바뀌고, 치우는 건
    //  사용자의 [확인]이다. 이미 응답된 건은 resolved 이벤트가 id 로 걷어가므로 여기 남지 않는다.
    const now = Date.now();
    const have = new Set(next.map((a) => a.id));
    for (const a of state.approvals) {
      if (!have.has(a.id) && a.deadlineAt && a.deadlineAt <= now) next.push(a);
    }
    state.approvals = next;
    emit();
  } catch (_) { /* 미페어링/오프라인 — 기존 목록 유지 */ }
}

// WS 이벤트 반영 — kind:'pending'(신규/멱등 재광고) | 'resolved'(해소 → 전 기기에서 카드 회수).
//  구 서버가 kind:'new'/'canceled' 를 보낼 수 있으므로 둘 다 수용한다(하위호환).
export function applyApprovalEvent(ev) {
  if (!ev) return;
  const kind = ev.kind === "new" ? "pending" : ev.kind === "canceled" ? "resolved" : ev.kind;
  if (kind === "pending" && ev.approval && ev.approval.id) {
    const a = ev.approval;
    const i = state.approvals.findIndex((x) => x.id === a.id);
    if (i >= 0) state.approvals[i] = { ...state.approvals[i], ...a }; // 멱등 재광고 = 마감만 갱신
    else state.approvals.push({ ...a, _busy: false, _err: null });
    // OS 알림은 **여기서 보내지 않는다**. 승인은 서버가 notification 행(kind='approval_request')을
    //  같이 만들고, 그 notif_event 가 기존 경로(applyNotifEvent → maybeOsNotify)로 이미 울린다.
    //  여기서 또 부르면 같은 승인에 배너가 2번 뜬다(기존 알림 3케이스 규약 무간섭 원칙).
    //  단 알림 행 생성이 실패한 경우(notifId 없음)만 폴백으로 직접 울린다.
    if (a.notifId == null) {
      maybeOsNotify(
        { title: `승인 필요 — ${a.agent === "claude" ? "Claude Code" : a.agent || "에이전트"}`,
          body: `${a.tool || "Tool"}${a.relPath || a.summary ? " · " + String(a.relPath || a.summary).slice(0, 80) : ""}`,
          read: false },
        ev.alertClientKey == null ? true : ev.alertClientKey === deviceKey()
      );
    }
    emit();
    return;
  }
  if (kind === "resolved" && ev.id) {
    const before = state.approvals.length;
    state.approvals = state.approvals.filter((x) => x.id !== ev.id);
    if (state.approvals.length !== before) emit();
  }
}

// 카드 응답 — 실패 코드별로 UI 가 분기한다(카드 철수 vs 재시도 가능).
//  Rust back_api 가 `HTTP <status> <DETAIL_CODE>: <메시지>` 로 코드를 실어 준다.
export async function respondApproval(id, body) {
  const a = state.approvals.find((x) => x.id === id);
  if (!a || a._busy) return { ok: false, code: "BUSY" };
  a._busy = true;
  a._err = null;
  emit();
  try {
    await api.approvalRespond(id, { ...body, deviceName: state.daemon?.device_name || "PC" });
    // 성공 — resolved 팬아웃이 곧 오지만, WS 가 끊겨 있어도 카드가 남지 않게 즉시 철수한다.
    state.approvals = state.approvals.filter((x) => x.id !== id);
    emit();
    return { ok: true };
  } catch (e) {
    const msg = String(e || "");
    const code = /HTTP \d+ ([A-Z_]+)/.exec(msg)?.[1] || "";
    if (code === "ALREADY_RESOLVED" || code === "EXPIRED" || code === "NOT_FOUND") {
      // 다른 기기 또는 PC 터미널(TUI 다이얼로그)이 먼저 답했다 / 마감됐다 → 카드 즉시 철수.
      state.approvals = state.approvals.filter((x) => x.id !== id);
      emit();
      return { ok: false, code };
    }
    a._busy = false;
    a._err = code === "HOST_OFFLINE" ? "PC 가 연결돼 있지 않습니다" : msg.replace(/^HTTP \d+( [A-Z_]+)?: ?/, "") || "응답 실패";
    emit();
    return { ok: false, code: code || "FAILED" };
  }
}

// 사용자가 카드를 직접 닫음(마감된 카드의 "확인") — 서버에는 아무것도 보내지 않는다.
//  마감 = 데몬이 이미 defer 해서 TUI 다이얼로그로 넘어간 상태이므로 여기서 응답을 보내면 안 된다.
export function dismissApproval(id) {
  const before = state.approvals.length;
  state.approvals = state.approvals.filter((x) => x.id !== id);
  if (state.approvals.length !== before) emit();
}

// ── 에이전트 상태(기능3) — `${cwd}|${win}` 키. 데몬 push(agent_state)가 오면 채워진다 ──
//  와이어 계약 정본 = docs/구현설계-2026-07-25/11-배관-계약.md §1.2~1.5.
//   프레임 = { cwd(홈-상대, "" 도 유효), win(tid 정수), state, agent, version, at, sessionId, source, since }
//           + back 이 hostDeviceId/kind 를 스탬프. 내용성 필드(요약·본문)는 오지 않는다(순수 메타데이터).
//  ★ 키에 hostDeviceId 를 넣지 않는다(계약 §1.2 확정) — PC 는 (cwd,win) 만으로 색인한다. 멀티 PC 에서
//    같은 홈-상대 경로가 두 PC 에 있으면 나중 프레임이 이긴다(허용된 한계). 대신 version 역전 폐기는
//    **같은 호스트끼리만** 적용한다(호스트가 바뀌면 인수인계로 보고 무조건 수용해야 판정이 멈추지 않는다).
//  ★ 폴백을 지우지 않는다: push 가 0건이거나 stale 이면 pane.js 의 tab.cmd 규칙이 그대로 판정한다(§1.5).
const AGENT_STATE_STALE_MS = 15 * 60 * 1000; // 이보다 오래된 push 는 믿지 않는다(§1.5-c)
export const agentStates = new Map();
export function setAgentState(ev) {
  if (!ev || typeof ev.cwd !== "string" || ev.win == null) return; // cwd 는 "" (홈) 도 유효한 값이다
  const key = `${ev.cwd}|${ev.win}`;
  const st = String(ev.state || "");
  const host = ev.hostDeviceId == null ? null : Number(ev.hostDeviceId);
  // 'ended' 는 데몬이 'gone' 으로 변환해 보내기로 계약했지만(§1.3), 어느 한쪽이 그대로 흘려도
  //  토글이 영구히 켜진 채 남지 않게 여기서도 소멸로 취급한다(계약 부록 A 의 1번 사고 방어).
  if (st === "gone" || st === "ended") {
    if (agentStates.delete(key)) emit();
    return;
  }
  const prev = agentStates.get(key);
  const version = Number(ev.version);
  const sentAt = Number(ev.at);
  // 순서 역전 방어 — 같은 호스트·같은 터미널에서 온 오래된 프레임은 버린다(§1.3, rseq 없음).
  //  ★ version 만으로 버리면 **데몬 재기동**(version 이 1부터 다시 시작)에서 새 프레임을 전량 폐기하고
  //    낡은 상태에 15분(stale) 고착한다 — 재기동은 이 제품에서 상시 이벤트다(PC 업데이트/데몬 재시작).
  //    그래서 "version 도 후퇴 && 발신 시각(at)도 후퇴" 일 때만 폐기한다(둘 중 하나라도 전진하면 채택).
  //    앱 `agentStateStore.applyAgentState` 와 **같은 규칙**이다 — 두 화면이 갈리면 안 된다.
  if (prev && Number.isFinite(version) && Number.isFinite(prev.version)
      && prev.hostDeviceId === host && version <= prev.version
      && Number.isFinite(sentAt) && Number.isFinite(prev.at) && sentAt <= prev.at) return;
  agentStates.set(key, {
    agent: ev.agent || "claude",
    state: st || "idle",
    sessionId: ev.sessionId || null,
    at: Number(ev.at) || Date.now(),
    version: Number.isFinite(version) ? version : null,
    hostDeviceId: host,
    // stale 판정은 **수신 시각** 기준이다 — 호스트 시계가 어긋나도 판정이 뒤집히지 않게.
    recvAt: Date.now(),
  });
  emit();
}
export function agentStateOf(cwd, win) {
  if (typeof cwd !== "string" || win == null) return null;
  const key = `${cwd}|${win}`;
  const st = agentStates.get(key);
  if (!st) return null;
  // 마지막 push 가 너무 오래됐다 = 데몬/서버가 조용히 끊겼을 수 있다 → 폴백(tab.cmd)으로 되돌린다.
  //  ※ 여기서 emit() 하지 않는다(렌더 경로에서 호출되므로 재렌더 루프가 된다).
  if (Date.now() - (st.recvAt || st.at) > AGENT_STATE_STALE_MS) { agentStates.delete(key); return null; }
  return st;
}
/**
 * 호스트가 오프라인이 되면 그 PC 가 남긴 상태는 더 이상 진실이 아니다(§1.5-b) → 폐기해 폴백으로 되돌린다.
 *  back 이 hostDeviceId 를 스탬프하지 않는 구버전에서는 cwd(그 워크스페이스의 홈-상대 경로)로 지운다.
 */
export function forgetAgentStatesForHost(hostDeviceId, cwd) {
  const hid = hostDeviceId == null ? null : Number(hostDeviceId);
  let changed = false;
  for (const [k, v] of agentStates) {
    const hostMatch = hid != null && Number.isFinite(hid) && v.hostDeviceId === hid;
    const cwdMatch = v.hostDeviceId == null && typeof cwd === "string" && cwd !== "" && k.startsWith(`${cwd}|`);
    if (hostMatch || cwdMatch) { agentStates.delete(k); changed = true; }
  }
  if (changed) emit();
}

/**
 * 보유 상태 전량 폐기 — **제어 WS(ui-channel) 재접속 시점**에 부른다(§1.5-a/b 의 빈틈).
 *  왜 필요한가: back 의 라스트-스테이트 리플레이는 '삭제'를 표현할 수 없다. 끊긴 사이 에이전트가 끝나
 *  데몬이 'gone' 을 보내면 back 은 그 키를 캐시에서 **지우므로**(daemonRelayService 의 agentStateLast)
 *  재접속 리플레이에는 그 키에 대한 프레임이 **한 건도 오지 않는다** → 우리가 들고 있던 {working} 이
 *  유령으로 15분 남아 토글 ON + '중단' 버튼이 유지되고, push 가 존재하므로 tab.cmd 폴백도 건너뛰어진다.
 *  폐기의 대가는 "폴백(5~9s 지연)" 이라 알려진 지연이고, 반대(스테일 신뢰)는 조용한 고착이다.
 *  ★ 순서: 폐기 → ui_hello. 그러면 back 리플레이가 곧바로 **살아 있는 것만** 복원한다(앱 규약과 동일).
 */
export function resetAgentStates() {
  if (!agentStates.size) return;
  agentStates.clear();
  emit();
}

// ── 원격 상태 스트림(ui_command status.changed) — cwd(홈-상대 localPath) 키 ──
//  back 이 흘려주는 워크스페이스 작업 상태(status[]/progress/logTail)를 미러. 사이드바가 최소 표시.
export const wsStatus = new Map(); // cwd -> { status:[], progress, logTail, ts }
export function setWsStatus(cwd, payload) {
  if (!cwd) return;
  wsStatus.set(cwd, { ...(payload || {}), ts: Date.now() });
  emit();
}

// 서버가 원천인 조작 게이트 — stale(캐시) 목록 상태에서는 호출하면 안 되는 것들.
//  true 를 돌려주면 "막았다"는 뜻(호출측은 즉시 return). 사용자에게는 토스트로 이유를 알린다.
export function blockedOffline(what) {
  if (!state.wsStale) return false;
  import("./workspace-view.js")
    .then((m) => m.wvToast(`오프라인 — ${what}은(는) 서버에 연결된 뒤에 가능합니다`))
    .catch(() => {});
  return true;
}

// ── 백엔드 워크스페이스 로드 ──
export async function loadWorkspaces() {
  try {
    const data = await api.fetchWorkspaces();
    const list = Array.isArray(data) ? data : data?.workspaces || data?.data || [];
    // stale = Rust 가 last-known 캐시로 응답(서버 미가용). 목록은 "마지막으로 본 것" 그대로다.
    const stale = !Array.isArray(data) && !!data?.stale;
    state.workspaces = list;
    state.wsStale = stale ? { cachedAt: Number(data.cachedAt) || 0 } : null;
    state.wsError = null;
    // 오프라인 호스트가 남긴 에이전트 상태 push 는 폐기(§1.5-b) — 토글 판정을 tab.cmd 폴백으로 되돌린다.
    //  ※ 호스트 온/오프라인 표시 자체는 기존 hostOnline 경로가 단독 판정한다(여기서 UX 를 바꾸지 않는다).
    for (const w of list) {
      if (w && isLocal(w) && w.hostOnline === false) forgetAgentStatesForHost(w.hostDeviceId, w.localPath);
    }
    // 활성 워크스페이스가 사라졌으면 초기화.
    if (state.activeWsId && !state.workspaces.some((w) => w.id === state.activeWsId)) {
      state.activeWsId = null;
    }
    // 오프라인(캐시)에서는 이 PC 워크스페이스만 열 수 있다 — 활성 선택도 그 규칙을 따른다.
    if (stale && state.activeWsId) {
      const cur = state.workspaces.find((w) => w.id === state.activeWsId);
      if (cur && !isThisHost(cur)) state.activeWsId = null;
    }
    // 첫 로컬 워크스페이스를 기본 활성으로.
    if (!state.activeWsId) {
      const first = stale
        ? state.workspaces.find((w) => isLocal(w) && isThisHost(w))
        : state.workspaces.find(isLocal) || state.workspaces[0];
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
  if (blockedOffline("워크스페이스 추가")) return;
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

// ── 영속화(pc-ui.json) ──
// 리컨실러가 매 틱(7s) 다시 채우는 **휘발 판정 신호는 저장하지 않는다**. 저장하면 다음 실행 첫 몇 초를
//  "지난 세션의 판정"이 지배한다 — 데몬이 `agent:false` 를 싣던 순간에 저장됐다면 claude 가 도는데도
//  토글이 잠깐 사라진다(이 라운드가 없애려던 증상의 축소판). 탭 이름/cmd 는 라벨 복원에 쓰므로 유지.
export function stripVolatile(node) { // export = test/agent-toggle.mjs 대조용(내부 헬퍼)
  if (!node) return node;
  if (T.isLeaf(node)) {
    if (!Array.isArray(node.tabs)) return node;
    return { ...node, tabs: node.tabs.map(({ agent, agentState, ...rest }) => rest) };
  }
  return { ...node, first: stripVolatile(node.first), second: stripVolatile(node.second) };
}
function serialize() {
  const ws = {};
  for (const [id, w] of Object.entries(state.ws)) {
    ws[id] = { layout: stripVolatile(w.layout), focusId: w.focusId };
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
let _pendingTicks = 0; // 'new' 탭으로 인한 연속 스킵 횟수 — 유한화(고착 회수)용
export async function reconcilePool() {
  if (_reconciling || state.view !== "workspace") return;
  const wsId = state.activeWsId;
  const w = wsId ? state.ws[wsId] : null;
  const meta = state.workspaces.find((x) => x.id === wsId);
  if (!w || !w.layout || !meta || !isThisHost(meta)) return;
  // localPath 없는 메타로 진행 금지 — 빈 경로는 홈 네임스페이스(codingpt)로 폴백돼 "터미널 0개"
  //  목록을 받게 되고, 그걸 신뢰하면 이 워크스페이스 탭이 전부 오소거된다.
  if (!meta.localPath) return;
  _reconciling = true;
  try {
    // 빈 목록도 신뢰한다(터미널 0개 = 정식 상태 — 다른 기기가 전부 닫았으면 여기서도 탭 정리).
    //  tmux 오류는 Rust tmux_list_windows 가 Err 로 구분해 던지므로(catch 로 이번 틱 스킵) 안전.
    const wins = (await api.listWindows(meta.localPath || "")) || [];
    // 'new'(풀 window 확보 진행 중) 탭이 있으면 이번 틱 스킵 — 방금 만든 터미널의 중복 편입 방지.
    //  단 유한하게: 정상 확보는 수 초면 끝나므로, 4틱(≈28s) 연속이면 고착('new' 잔류 = 확보 실패
    //  잔재)으로 보고 회수한다 — 'new' 고착은 리컨실 전체를 영구 정지시킨다(실제 저장본에서 발견).
    let pending = false;
    T.eachLeaf(w.layout, (l) => { if (l.kind === "terminal") { for (const t of l.tabs) if (t.win === "new") pending = true; } });
    if (pending) {
      _pendingTicks += 1;
      if (_pendingTicks < 4) return;
      T.eachLeaf(w.layout, (l) => {
        if (l.kind !== "terminal" || !l.tabs.some((t) => t.win === "new")) return;
        api.debugLog(`reconcile: 'new' 고착 탭 회수 pane=${l.id} (${_pendingTicks}틱 연속 미확보)`);
        l.tabs = l.tabs.filter((t) => t.win !== "new");
        l.active = Math.max(0, Math.min(l.tabs.length - 1, l.active));
        getPane(l.id)?.buildHead();
      });
    }
    _pendingTicks = 0;
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
        if (!p) {
          // 라이브 attach = 존재 증명 — 이 pane 이 지금 그 세션에 붙어 데이터를 주고받는 중이면
          //  목록이 뭐라 하든 제거하지 않는다(목록 조회가 프로세스-로컬로 오염돼 살아있는 세션을
          //  0개로 보고한 실사고 — 사용 중인 터미널이 눈앞에서 사라졌다). 죽은 attach 는
          //  워치독(pty_alive)이 7s 내 _attachedWin 을 비우므로 진짜 삭제는 여전히 정리된다.
          if (getPane(l.id)?._attachedWin === t.win) {
            if (!t.miss) { t.miss = 1; api.debugLog(`reconcile: 탭 win=${t.win} 목록 부재지만 attach 생존 — 제거 보류`); }
            return true;
          }
          // 2-strike: 목록 스냅샷은 이 틱의 list 요청 "시작 시점" 기준이라, 요청 중에 생성돼
          //  win 이 확정된 새 탭이 스냅샷에 없을 수 있다(실제로 add 직후 탭이 오소거된 사고).
          //  1틱 유예 후 다음 틱에도 없을 때만 진짜 삭제(타 기기 close)로 확정한다.
          if (!t.miss) { t.miss = 1; api.debugLog(`reconcile: 탭 win=${t.win} 목록 부재 — 1틱 유예`); return true; }
          changed = true;
          api.debugLog(`reconcile: 탭 제거 win=${t.win} pane=${l.id} (2틱 연속 목록 ${wins.length}개에 없음)`);
          return false;
        }
        if (t.miss) delete t.miss;
        // 같은 tmux window 가 다른 pane/탭에 이미 있음 = 더블링(복제). 같은 window 를 두 pane 이
        //  공유하면 한쪽을 닫을 때 killWindow 가 공유 세션을 죽여 양쪽이 함께 사라진다(마지막 세션이면
        //  tmux 서버까지 사망). 이 중복 탭을 제거 — 먼저 만난(원본) pane 만 그 window 를 유지한다.
        if (seen.has(t.win)) { changed = true; touched.add(l.id); api.debugLog(`reconcile: 중복 탭 제거 win=${t.win} pane=${l.id} (더블링 방지)`); return false; }
        seen.add(t.win);
        if (p.name && t.title !== p.name) { t.title = p.name; changed = true; touched.add(l.id); }
        // 실행 중 명령(pane_current_command) — 탭 라벨 부제("이름 · claude")로 표시(cmux 미러).
        const cmd = p.command || "";
        if ((t.cmd || "") !== cmd) { t.cmd = cmd; changed = true; touched.add(l.id); }
        // ── 토글 판정용 pull 신호(agent-signal.js 사다리 ②) — 목록은 7s 마다 무조건 다시 온다 ──
        //  agent/agentState = 데몬이 정규화해 실어 보내는 플래그(additive). 없으면 undefined 로 남고
        //  사다리가 다음 칸으로 내려간다 — "없으면 에이전트 아님" 으로 단정하지 않는다(구 데몬 대응).
        //  ⚠ 이 PC 의 로컬 워크스페이스 목록은 Rust(tmux 직결)라 두 필드가 **구조적으로 오지 않는다**
        //   → 사다리 ③'(제목 글리프)·④(기본 ON)가 판정을 맡는다. 원격 목록(데몬 경유)에서만 채워진다.
        //  ※ pane_title 원본(ptitle)은 싣지 않는다 — 사다리에서 도달 불가였고(window name 은 자동 개명이든
        //   수동 rename 이든 항상 비지 않는다) 앱 입력과의 동치만 깨뜨렸다(2026-07-25 교차실행).
        if (p.agent !== undefined && t.agent !== p.agent) { t.agent = p.agent; changed = true; touched.add(l.id); }
        if (p.agentState !== undefined && t.agentState !== p.agentState) { t.agentState = p.agentState; changed = true; touched.add(l.id); }
        return true;
      });
      if (l.tabs.length !== before) touched.add(l.id);
      // 원래부터 빈 자리 pane(터미널 0개 상태)은 보존 — "탭이 있었다가 전부 사라진" pane 만 정리.
      if (!l.tabs.length) { if (before) deadPanes.push(l.id); return; }
      const ai = l.tabs.indexOf(activeTab);
      l.active = ai >= 0 ? ai : Math.max(0, Math.min(l.tabs.length - 1, l.active));
    });
    // 빈 pane 제거 — 터미널이 타 기기에서 삭제됨(실체는 이미 소멸, 로컬 kill 불필요).
    //  전부 사라졌으면 빈 자리 pane 유지(자동 재생성 금지 — 삭제는 전 기기 공통 의사).
    for (const id of deadPanes) {
      const r = T.closeLeaf(w.layout, id);
      w.layout = r.tree || T.leaf("terminal", { empty: true });
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
        for (const m of missing) {
          // 편입 시점에도 판정 재료를 같이 싣는다 — 다음 틱(7s)까지 토글이 비어 보이지 않게.
          const nt = { win: m.index, title: m.name || "", cmd: m.command || "" };
          if (m.agent !== undefined) nt.agent = m.agent;
          if (m.agentState !== undefined) nt.agentState = m.agentState;
          leafT.tabs.push(nt);
        }
        api.debugLog(`reconcile: 탭 편입 ${missing.map((m) => m.index).join(",")} → pane=${targetId}`);
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
    // 자가치유 워치독 — 변경 유무와 무관하게 매 틱, 모든 터미널 pane 의 채널 생존을 확인해
    //  죽은 attach(이벤트 유실·레이스 등 원인 불문)를 활성 탭으로 재수립한다. 정상 상태에선
    //  pane 당 IPC 1회의 no-op.
    T.eachLeaf(w.layout, (l) => { if (l.kind === "terminal") getPane(l.id)?.ensureAttached?.(); });
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
          let layout = migrateTree(w.layout);
          // 복원 정리: ① 'new'(미완료 add 잔재 — 남기면 pending 가드가 리컨실을 영구 정지) 제거,
          //  ② miss(런타임 전용 유예 마킹) 제거, ③ 같은 tmux window 가 여러 pane/탭에 중복 저장된
          //  더블링 제거 — 첫(원본) pane 만 유지. 중복 제거로 완전히 빈 split pane 은 아래서 collapse.
          const seenWins = new Set();
          const dedupedEmpty = [];
          T.eachLeaf(layout, (l) => {
            if (l.kind !== "terminal" || !Array.isArray(l.tabs)) return;
            const before = l.tabs.length;
            for (const t of l.tabs) delete t.miss;
            l.tabs = l.tabs.filter((t) => {
              if (t.win === "new") return false;
              if (typeof t.win === "number") { if (seenWins.has(t.win)) return false; seenWins.add(t.win); }
              return true;
            });
            l.active = Math.max(0, Math.min(l.tabs.length - 1, l.active || 0));
            if (before > 0 && l.tabs.length === 0) dedupedEmpty.push(l.id); // 정리로 비워진 leaf(중복 split)
          });
          // 정리로 빈 leaf 는 트리에서 제거(원본 pane 만 남김). 단 leaf 가 하나뿐이면 유지(빈 pane UI 정상 상태).
          for (const eid of dedupedEmpty) {
            if (T.leafIds(layout).length <= 1) break;
            const r = T.closeLeaf(layout, eid);
            if (r && r.tree) { layout = r.tree; w.focusId = r.focusId || w.focusId; }
          }
          state.ws[id] = { layout, focusId: (w.focusId && T.findLeaf(layout, w.focusId)) ? w.focusId : T.firstLeafId(layout), surfaces: [], ports: [] };
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
      wsPrefs.seeded = Array.isArray(saved.wsPrefs.seeded) ? saved.wsPrefs.seeded : [];
    }
    // 구 저장본(seeded 없음) 마이그레이션 — 복원된 레이아웃이 있는 워크스페이스는 이미 시드된 것.
    for (const id of Object.keys(state.ws)) if (!wsPrefs.seeded.includes(id)) wsPrefs.seeded.push(id);
  } catch (_) {
    /* 복원 실패는 무시(빈 상태로 시작) */
  }
}
