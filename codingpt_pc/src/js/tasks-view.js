// tasks-view.js — 작업 현황판(설계 §6.1). 메인 영역 뷰(state.view === 'tasks').
//
// 무엇을 보여 주나: **모든 PC · 모든 워크스페이스의 에이전트**를 입력 대기 / 작업 중 / 리뷰 준비 / 대기 중 / 완료 로.
//  그룹 판정과 정렬은 tasks-model.js(앱과 픽스처로 교차 검증) 가 정본이고, 여기는 입력을 모으고 그리기만 한다.
//
// 데이터 흐름:
//  · 호스트별 `task.list`(봉인 우선, tasks-api.taskRpc) → state.tasks.byHost. 정본은 각 PC 데몬의 tasks.json.
//  · 라이브 = 기존 agent_state(listAgentSnaps) + 승인 대기(state.approvals) + 미읽음 알림.
//  · 갱신 트리거 = ui_command `tasks.changed {host}`(300ms 디바운스) · 보이는 동안 60초 폴링 ·
//    runner_status online 전이(ui-channel → noteRunnerStatus) · 수동 [새로고침].
//
// 규율: 이모지 0 · 선택/활성은 무채색 명암(--hover) · 상태 점만 warn/error/cta · 문구는 text/tasks.js 의 §9 원문뿐.
import { state } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { getPane } from "./pane.js";
import { icons, agentMarkHtml, iconBtn } from "./icons.js";
import { buildDashboard, GROUPS, isTaskWorkspace } from "./tasks-model.js";
import { taskRpc, refreshHostCaps, hostHasTasks, serverHasTasks, onCapsChanged, newOpId, isLocalHostId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import * as i18n from "./i18n/index.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 현황판 아이콘(체크리스트 모양) — 사이드바 행·타이틀바가 같은 글리프를 쓴다(icons.js 선 규칙과 같은 svg). */
export function tasksIcon(o = {}) {
  const size = o.size || 16;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${o.sw || 1.8}" stroke-linecap="round" stroke-linejoin="round" class="ic"><path d="M4 6.5l1.5 1.5L8.5 5"/><line x1="11" y1="6.5" x2="20" y2="6.5"/><path d="M4 12.5l1.5 1.5 3-3"/><line x1="11" y1="12.5" x2="20" y2="12.5"/><circle cx="6" cy="18.5" r="1.2"/><line x1="11" y1="18.5" x2="20" y2="18.5"/></svg>`;
}

const AGENT_NAMES = { claude: "Claude", codex: "Codex", gemini: "Gemini", "cursor-agent": "Cursor", opencode: "OpenCode" };
export function agentName(id) { return AGENT_NAMES[id] || (id ? String(id) : ""); }

// ── 스토어/갱신 ────────────────────────────────────────────────────────────────
const POLL_MS = 60000;
let el = null;
let pollTimer = null;
const changedTimers = new Map(); // host → 디바운스 타이머
const inflight = new Map();      // host → Promise
let sel = null;                  // { host, taskId, runId?, k? } — 선택된 카드/상세
let focusK = null;               // 키보드 커서(행 키)
const collapsed = new Set(["idle", "done"]); // 기본 접힘(§6.1)
const dismissedOps = new Set();  // `${runId}:${opId}` — 실패 op 을 카드에서 [확인] 했다(로컬만 지운다, §5.3)
let lastSig = "";                // 뼈대(상단 바·2단/1단) 시그니처
let listSig = "";                // 목록 시그니처
let detailSig = "";              // 상세 시그니처
let detailGen = 0;               // invalidate() 가 올린다 — 상세가 비동기 데이터를 받았다
let detailPending = false;       // 편집 중이라 미룬 상세 재렌더
let detailSelKey = "";           // 상세가 그리고 있는 선택 — 선택이 바뀌면 편집 중이어도 다시 그린다
const openAppr = new Set();      // 승인 인라인 박스를 연 카드 키 — 목록을 다시 그려도 다시 연다
let detailMod = null;            // task-detail.js(지연 로드 — 현황판을 열 때만)

/** 작업을 조회할 호스트 — 온라인 PC 중 task.v1 이 **없다고 확인된** 것은 뺀다(모름은 시도한다). */
function queryHosts() {
  // 서버 킬스위치(serverCaps 에 task.v1 없음) — 다른 PC 는 서버를 거쳐야 하므로 뺀다(봉인 경로 포함).
  //  이 PC 는 로컬 소켓 직결이라 서버와 무관하다.
  const serverOff = serverHasTasks() === false;
  return S.pcDevices()
    .filter((d) => d.online !== false && typeof d.id === "number")
    .filter((d) => hostHasTasks(d.id) !== false)
    .filter((d) => !serverOff || isLocalHostId(state, d.id))
    .map((d) => d.id);
}

/** 한 호스트의 task.list — 겹치면 진행 중인 것을 기다린다(폭주 방지). */
export function refreshHost(host) {
  const h = Number(host);
  if (inflight.has(h)) return inflight.get(h);
  const p = (async () => {
    try {
      const r = await taskRpc("task.list", {}, h);
      S.setTasksForHost(h, { items: (r && r.items) || [], gh: (r && r.caps && r.caps.gh) || null, at: Date.now(), error: null });
    } catch (e) {
      // 목록은 지우지 않는다(마지막으로 본 것 유지) — 에러만 표시.
      S.setTasksForHost(h, { error: { code: (e && e.code) || "", message: String((e && e.message) || e) }, at: Date.now() });
    } finally {
      inflight.delete(h);
    }
  })();
  inflight.set(h, p);
  return p;
}

export async function refreshAll() {
  await Promise.allSettled(queryHosts().map((h) => refreshHost(h)));
}

/** ui_command `tasks.changed {host, taskIds, reason}` — 300ms 디바운스 후 그 host 재조회(+ 상세가 보는 작업이면 상세도). */
export function onTasksChanged(p) {
  // host:null(데몬 config 에 deviceId 가 아직 없음) 을 Number() 하면 0 — 유령 호스트 0 을 조회하게 된다.
  const raw = p ? p.host : null;
  const h = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(h) || h <= 0) { void refreshAll(); return; }
  clearTimeout(changedTimers.get(h));
  changedTimers.set(h, setTimeout(() => {
    changedTimers.delete(h);
    void refreshHost(h);
    if (detailMod && sel && Number(sel.host) === h) {
      const ids = Array.isArray(p.taskIds) ? p.taskIds : [];
      if (!ids.length || ids.includes(sel.taskId)) detailMod.onTaskChanged(sel.host, sel.taskId, p.reason);
    }
  }, 300));
}

// 60초 폴링 — 현황판이 안 보여도 돈다(사이드바 `작업 [n]` 배지가 이 목록을 센다). 창이 숨으면 쉰다.
//  라이브 갱신의 주 경로는 tasks.changed 이고, 이건 놓친 통지·재접속 사이의 안전망이다(§3.4).
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !state.paired) return;
    void refreshAll();
  }, POLL_MS);
}

/** 부팅 후 1회(main.js) — 기기 목록이 온 뒤 caps·목록을 받고 폴링을 건다. */
export function startTasksBackground() {
  void refreshHostCaps().then(() => refreshAll());
  startPolling();
}

// ── 입력 조립(§5.1) ────────────────────────────────────────────────────────────
function modelInput() {
  const hosts = S.pcDevices().map((d) => ({ id: Number(d.id), name: d.name || "", online: d.online !== false, caps: [] }));
  const tasks = Object.entries(state.tasks.byHost).map(([h, v]) => ({
    host: Number(h),
    // [확인] 한 실패 op 는 로컬에서 지운다 — 데몬 기록은 그대로(다른 기기에는 계속 보인다).
    items: (v.items || []).map((t) => ({
      ...t,
      runs: (t.runs || []).map((r) => (r.lastOp && dismissedOps.has(`${r.id}:${r.lastOp.opId}`) ? { ...r, lastOp: null } : r)),
    })),
  }));
  const unreadMap = new Map();
  for (const n of state.notifications) {
    if (n.read || typeof n.cwd !== "string" || typeof n.win !== "number") continue;
    const k = `${n.hostDeviceId ?? 0}|${n.cwd}|${n.win}`;
    const u = unreadMap.get(k) || { host: n.hostDeviceId ?? 0, cwd: n.cwd, win: n.win, count: 0 };
    u.count++;
    unreadMap.set(k, u);
  }
  return {
    now: Date.now(),
    hosts,
    tasks,
    agentSnaps: S.listAgentSnaps(),
    approvals: state.approvals
      .filter((a) => typeof a.cwd === "string" && a.win != null)
      .map((a) => ({ id: a.id, host: a.hostDeviceId ?? 0, cwd: a.cwd, win: a.win, createdAt: a.createdAt || 0 })),
    unread: [...unreadMap.values()],
    terminalsFallback: [],
    workspaces: state.workspaces.filter((w) => S.isLocal(w)).map((w) => ({
      id: w.id, host: w.hostDeviceId ?? 0, localPath: w.localPath || "", name: S.wsDisplayName(w),
    })),
  };
}

export function dashboard() { return buildDashboard(modelInput()); }

/** 사이드바 `작업 [n]` 배지 — 입력 대기 수. */
export function needsInputCount() {
  try { return dashboard().counts.needs_input; } catch (_) { return 0; }
}

// ── 열기/닫기 ──────────────────────────────────────────────────────────────────
/** 현황판 열기. opts = { taskId?, runId?, host? } — 딥링크·알림에서 바로 그 작업 상세로. */
export function openTasksDashboard(opts) {
  const o = opts || {};
  if (o.taskId) sel = { host: o.host != null ? Number(o.host) : guessHost(o.taskId), taskId: o.taskId, runId: o.runId || null };
  S.setView("tasks");
  void refreshHostCaps();
  void refreshAll();
  startPolling();
  setTimeout(() => el?.focus?.(), 30);
}
export function closeTasksDashboard() { S.setView("workspace"); }

function guessHost(taskId) {
  for (const [h, v] of Object.entries(state.tasks.byHost)) if ((v.items || []).some((t) => t.id === taskId)) return Number(h);
  return state.daemon?.deviceId ?? null;
}

export function findTask(host, taskId) {
  const v = state.tasks.byHost[String(host)];
  return v ? (v.items || []).find((t) => t.id === taskId) || null : null;
}
export function ghLiteOf(host) {
  const v = state.tasks.byHost[String(host)];
  return (v && v.gh) || null;
}

/** 작업 워크스페이스의 제목(워크스페이스 헤더 배지용) — 봉인 task.list 로만 온다(§10). 모르면 null. */
export function taskTitleForWs(wsId) {
  for (const v of Object.values(state.tasks.byHost)) {
    for (const t of v.items || []) if ((t.runs || []).some((r) => r.workspaceId === wsId)) return t.title || null;
  }
  return null;
}

// ── 터미널 열기(§4) ────────────────────────────────────────────────────────────
/** 워크스페이스 활성화 + 그 tid 탭 포커스. 목록에 없으면 먼저 새로고침(back 은 생성을 브로드캐스트하지 않는다). */
export async function openRunTerminal(wsId, tid, { task = false } = {}) {
  if (!wsId) { toast(tt("wsNotRegistered")); return false; }
  if (!state.workspaces.some((w) => w.id === wsId)) await S.loadWorkspaces().catch(() => {});
  const meta = state.workspaces.find((w) => w.id === wsId);
  if (!meta) { toast(tt("wsNotRegistered")); return false; }
  S.setActive(wsId, { allowTask: task || isTaskWorkspace(meta) });
  if (tid == null) return true;
  // 리컨실러가 그 터미널을 레이아웃에 올리기 전일 수 있다 → 몇 번 재시도.
  for (let i = 0; i < 8; i++) {
    if (focusTid(wsId, Number(tid))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}
function focusTid(wsId, tid) {
  const rt = S.wsRuntime(wsId);
  if (!rt || !rt.layout) return false;
  let hit = null;
  T.eachLeaf(rt.layout, (l) => {
    if (!hit && l.kind === "terminal" && (l.tabs || []).some((t) => typeof t.win === "number" && t.win === tid)) hit = l;
  });
  if (!hit) return false;
  const idx = hit.tabs.findIndex((t) => typeof t.win === "number" && t.win === tid);
  if (idx >= 0 && idx !== hit.active) getPane(hit.id)?.switchTab(idx);
  S.focusPane(hit.id);
  return true;
}

export function toast(msg) {
  import("./workspace-view.js").then((m) => m.wvToast(msg)).catch(() => {});
}

// ── 공용 행동(카드·상세가 같이 쓴다) ─────────────────────────────────────────────
/** 동기 RPC 실행 + 실패 토스트. 성공 결과를 돌려주고 실패면 null. */
export async function act(host, method, params) {
  try {
    const r = await taskRpc(method, params, host);
    void refreshHost(host);
    return r || {};
  } catch (e) {
    toast(errText(e && e.code));
    // 변이 실패 = 호스트가 이미 끝냈을 수 있다 → 실제 상태를 다시 본다(§3.2).
    void refreshHost(host);
    return null;
  }
}
export async function trustRun(host, taskId, runId) { return act(host, "task.run.trust", { taskId, runId }); }
export async function resendPrompt(host, taskId, runId) {
  const r = await act(host, "task.run.prompt", { taskId, runId });
  if (r && r.delivered === false) toast(tt("promptNotDelivered"));
  return r;
}
export async function reopenRun(host, taskId, runId) { return act(host, "task.run.reopen", { opId: newOpId(), taskId, runId }); }
export async function deleteRecord(host, taskId) {
  const r = await act(host, "task.delete", { taskId });
  if (r && sel && sel.taskId === taskId) sel = null;
  return r;
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────
export function mountTasksView(container) {
  el = container;
  el.className = "tasks-view";
  el.tabIndex = 0;
  el.addEventListener("keydown", onKey);
  onCapsChanged(() => S.emit());
  // 폭이 바뀌면 2단/1단 전환(≥1100px 2단 — §6.1). 창 크기·사이드바 폭 양쪽이 원인이라 관찰자로 본다.
  try { new ResizeObserver(() => { updateTasksView(); }).observe(el); } catch (_) { /* noop */ }
}

const GROUP_LABEL = {
  needs_input: "groupNeedsInput", working: "groupWorking", review_ready: "groupReviewReady", idle: "groupIdle", done: "groupDone",
};

// 시그니처에서 뺄 휘발 필드 — PR 폴링(30초)·touch() 가 매번 바꾸지만 화면에는 안 보인다.
const VOLATILE = new Set(["updatedAt", "at", "lastActivityAt"]);
const stable = (v) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x));

/** 상세가 지금 편집 중인가 — 리뷰 코멘트 입력칸이 열려 있거나 안의 입력칸에 포커스가 있으면 다시 그리지 않는다. */
function detailBusy(det) {
  if (!det) return false;
  if (det.querySelector(".rv-cbox")) return true;
  const a = document.activeElement;
  if (a && det.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return true;
  return false;
}

/**
 * ★ 통째로 다시 그리지 않는다 — 리뷰 코멘트 입력칸·승인 박스·목록/상세 스크롤은 DOM 에만 있다.
 *  뼈대(상단 바·2단/1단) / 목록 / 상세를 각자의 시그니처로 따로 갱신하고, 스크롤은 보존, 편집 중인 상세는 미룬다.
 */
export function updateTasksView() {
  if (!el) return;
  const on = state.view === "tasks";
  el.hidden = !on;
  if (!on) return;
  startPolling();
  const dash = dashboard();
  const wide = el.clientWidth >= 1100;
  const now = Date.now();
  const frameSig = JSON.stringify([wide, !!sel, state.sidebarCollapsed]);
  const lSig = JSON.stringify([
    wide, sel, focusK, [...collapsed], serverHasTasks(), queryHosts(),
    GROUPS.map((g) => dash.groups[g].map((r) => [r.k, r.group, r.reason, r.live && r.live.state, r.approvals.length, r.unread,
      r.run && [r.run.state, r.run.op && r.run.op.opId, r.run.lastOp && r.run.lastOp.opId, r.run.trustPending, r.run.agentGone, r.run.terminalAlive,
        r.run.diff && [r.run.diff.files, r.run.diff.additions, r.run.diff.deletions], r.run.commits && r.run.commits.ahead,
        r.run.pr && [r.run.pr.number, r.run.pr.state, r.run.pr.isDraft, r.run.pr.mergeable, r.run.pr.checks && r.run.pr.checks.status]],
      r.task && [r.task.state, r.task.title, r.task.winnerRunId],
      // "{t} 대기" 는 입력 대기 행에만 보인다 — 다른 행은 분 단위로 다시 그릴 이유가 없다.
      r.group === "needs_input" ? Math.floor((now - r.waitSince) / 60000) : 0])),
    dash.offline, Object.entries(state.tasks.byHost).map(([h, v]) => [h, v.error && v.error.code, v.gh]),
    S.pcDevices().map((d) => [d.id, d.name, d.online]),
  ]);
  const dSig = sel ? stable([
    wide, sel, detailGen,
    sel.taskId ? findTask(sel.host, sel.taskId) : GROUPS.map((g) => dash.groups[g].find((r) => r.k === sel.k)).find(Boolean) || null,
    ghLiteOf(sel.host), (state.tasks.byHost[String(sel.host)] || {}).error || null,
  ]) : "";
  const frameChanged = frameSig !== lastSig || !el.querySelector(".tv-body");
  if (frameChanged) {
    lastSig = frameSig;
    renderFrame(wide);
    listSig = ""; detailSig = "";
  }
  const listEl = el.querySelector(".tv-list");
  if (listEl && lSig !== listSig) {
    listSig = lSig;
    const top = listEl.scrollTop;
    const fresh = renderList(dash);
    listEl.replaceWith(fresh);
    fresh.scrollTop = top;
  }
  const det = el.querySelector(".tv-detail");
  if (det && (dSig !== detailSig || detailPending)) {
    const selKey = JSON.stringify(sel && [sel.host, sel.taskId, sel.runId, sel.k]);
    if (detailBusy(det) && !frameChanged && selKey === detailSelKey) { detailPending = true; return; }
    detailPending = false;
    detailSig = dSig;
    detailSelKey = selKey;
    renderDetail(det);
  }
}

function renderDetail(det) {
  const top = det.scrollTop;
  const restore = () => { if (det.isConnected) det.scrollTop = top; };
  if (sel) {
    if (detailMod) { detailMod.renderTaskDetail(det, sel); restore(); }
    else import("./task-detail.js").then((m) => { detailMod = m; if (det.isConnected) { m.renderTaskDetail(det, sel); restore(); } }).catch(() => {});
  } else {
    det.className = "tv-detail";
    det.innerHTML = `<div class="tv-detail-empty">${esc(tt("detail"))}</div>`;
  }
}

function renderFrame(wide) {
  const listFirst = wide || !sel;
  el.classList.toggle("tv-wide", wide);
  el.innerHTML = "";

  const top = document.createElement("div");
  top.className = "tv-top";
  top.setAttribute("data-tauri-drag-region", "");
  if (state.sidebarCollapsed) {
    // 사이드바가 접혀 있으면 워크스페이스 헤더처럼 타이틀바 컨트롤을 여기로 옮긴다.
    import("./sidebar.js").then((m) => {
      const ctl = document.createElement("span");
      ctl.className = "mt-ctl";
      ctl.append(m.buildTopControls(false));
      top.prepend(ctl);
    }).catch(() => {});
  }
  if (!wide && sel) {
    const back = btn("tv-back", tt("title"), () => { sel = null; updateTasksView(); });
    back.innerHTML = icons.chevronLeft({ size: 14 }) + `<span>${esc(tt("title"))}</span>`;
    top.append(back);
  } else {
    const t = document.createElement("span");
    t.className = "tv-title";
    t.textContent = tt("title");
    top.append(t);
  }
  const sp = document.createElement("span");
  sp.className = "mt-spacer";
  top.append(sp);
  //  상단 동작은 아이콘(툴팁·aria 는 원문) — 텍스트 버튼은 한눈에 안 읽힌다(사용자 지시 2026-09-29).
  const newB = iconBtn("plus", { cls: "tv-ic", size: 16, sw: 1.6, title: tt("newTask"), onClick: () => openNewTask() });
  const refB = iconBtn("refresh", { cls: "tv-ic", size: 16, sw: 1.6, title: tt("refresh"), onClick: () => { void refreshHostCaps(); void refreshAll(); } });
  for (const b of [newB, refB]) b.setAttribute("aria-label", b.title);
  top.append(newB, refB);
  el.append(top);

  const body = document.createElement("div");
  body.className = "tv-body";
  el.append(body);

  if (listFirst) {
    const ph = document.createElement("div");
    ph.className = "tv-list";
    body.append(ph);
  }
  if (wide || sel) {
    const det = document.createElement("div");
    det.className = "tv-detail";
    // 편집이 끝나면(포커스가 상세 밖으로) 미뤄 둔 재렌더를 한다.
    det.addEventListener("focusout", () => setTimeout(() => { if (detailPending) updateTasksView(); }, 0));
    body.append(det);
  }
}

function renderList(dash) {
  const list = document.createElement("div");
  list.className = "tv-list";

  // 배너 — 서버/PC 업데이트 필요(§6.7 A).
  const hostErrs = Object.entries(state.tasks.byHost).filter(([, v]) => v && v.error);
  const serverOld = serverHasTasks() === false || hostErrs.some(([, v]) => v.error.code === "SERVER_NEEDS_UPDATE");
  if (serverOld) list.append(banner(tt("serverNeedsUpdate")));
  for (const d of S.pcDevices()) {
    if (d.online !== false && hostHasTasks(d.id) === false) list.append(banner(`${d.name || tt("pc")} · ${tt("pcNeedsUpdate")}`));
  }
  // 조회 실패 — 빈 목록을 "작업 없음" 으로 보이게 두지 않는다(요청이 실패했음을 호스트별로 알린다).
  for (const [h, v] of hostErrs) {
    if (v.error.code === "SERVER_NEEDS_UPDATE") continue;
    const d = S.pcDevices().find((x) => Number(x.id) === Number(h));
    if (d && d.online === false) continue; // 오프라인 줄이 따로 있다
    const b = banner(`${(d && d.name) || tt("pc")} · ${errText(v.error.code)}`);
    b.classList.add("tv-banner-err");
    b.append(btn("tv-btn ghost", tt("refresh"), () => { void refreshHost(Number(h)); }));
    list.append(b);
  }
  const onlineHosts = S.pcDevices().filter((d) => d.online !== false);
  const total = GROUPS.reduce((n, g) => n + dash.groups[g].length, 0);
  if (!onlineHosts.length && !total) {
    list.append(emptyState(tt("noHost"), null, tt("connectPc"), () => import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings"))));
    return list;
  }
  if (!total && !dash.offline.length) {
    if (hostErrs.length || serverOld) return list; // 실패를 "작업 없음" 으로 덮지 않는다
    list.append(emptyState(tt("empty"), tt("emptyHint"), tt("newTask"), () => openNewTask()));
    return list;
  }

  for (const g of GROUPS) {
    const rows = dash.groups[g];
    if (!rows.length) continue;
    const head = document.createElement("button");
    head.className = "tv-group";
    const folded = collapsed.has(g);
    head.innerHTML = `<span class="tv-caret">${folded ? icons.chevronRight({ size: 12 }) : icons.chevronDown({ size: 12 })}</span>`
      + `<span>${esc(tt(GROUP_LABEL[g]))}</span><span class="tv-count">${rows.length}</span>`;
    head.addEventListener("click", () => { folded ? collapsed.delete(g) : collapsed.add(g); updateTasksView(); });
    list.append(head);
    if (folded) continue;
    for (const r of rows) list.append(card(r));
  }
  // 오프라인 PC 는 1줄(호스트 이름만) — §5.4.
  for (const h of dash.offline) {
    const d = S.pcDevices().find((x) => Number(x.id) === h);
    const row = document.createElement("div");
    row.className = "tv-offline";
    row.innerHTML = `<span class="tv-dot off"></span><span>${esc((d && d.name) || tt("pc"))}</span><span class="tv-sub">${esc(tt("hostOffline"))}</span>`;
    list.append(row);
  }
  return list;
}

function banner(text) {
  const b = document.createElement("div");
  b.className = "tv-banner";
  b.textContent = text;
  return b;
}
function emptyState(title, hint, cta, onCta) {
  const e = document.createElement("div");
  e.className = "tv-empty";
  e.innerHTML = `<div class="tv-empty-title">${esc(title)}</div>` + (hint ? `<div class="tv-empty-hint">${esc(hint)}</div>` : "");
  if (cta) e.append(btn("tv-btn", cta, onCta));
  return e;
}
function btn(cls, label, onClick, { disabled = false, title = "" } = {}) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.disabled = !!disabled;
  if (title) b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick?.(e); });
  return b;
}

/** 상대 시간 "{t}" — 기존 카탈로그 문구({n}분 / {n}시간)만 쓴다. */
export function relTime(ms) {
  const m = Math.max(1, Math.round(Math.max(0, ms) / 60000));
  return m < 60 ? i18n.t("{n}분", { n: m }) : i18n.t("{n}시간", { n: Math.round(m / 60) });
}

/** 카드 상태 한 줄 + 상태 점 종류(§5.4). */
export function statusOf(r) {
  const run = r.run;
  const task = r.task;
  if (r.kind === "task") {
    const k = { merged: "taskMerged", closed: "taskClosed", failed: "taskFailed" }[task.state] || "taskOpen";
    const win = task.winnerRunId && (task.runs || []).find((x) => x.id === task.winnerRunId);
    const line = tt(k) + (win ? " · " + tt("mergedInto", { branch: win.branch, base: task.base }) : "");
    return { line, dot: task.state === "failed" ? "error" : task.state === "merged" ? "cta" : "" };
  }
  if (r.group === "needs_input") {
    const wait = tt("waitingFor", { t: relTime(Date.now() - r.waitSince) });
    switch (r.reason) {
      case "failed": return { line: errText(run.error && run.error.code), dot: "error" };
      case "promptNotDelivered": return { line: tt("promptNotDelivered"), dot: "warn" };
      case "interrupted": return { line: errText("OP_INTERRUPTED"), dot: "warn" };
      case "trust": return { line: tt("trustNeeded"), dot: "warn" };
      case "terminalGone": return { line: tt("terminalGone"), dot: "warn" };
      case "agentGone": return { line: tt("agentGone"), dot: "warn" };
      case "keptDirty": return { line: tt("keptDirty"), dot: "warn" };
      case "opFailed": return { line: errText(run.lastOp && run.lastOp.code), dot: "error" };
      default: return { line: wait, dot: "warn" };
    }
  }
  if (r.group === "working") {
    if (run && run.op) return { line: tt("opInProgress"), dot: "spin" };
    const k = run && { creating: "stateCreating", launching: "stateLaunching", merging: "stateMerging" }[run.state];
    return { line: tt(k || "groupWorking"), dot: "spin" };
  }
  if (r.group === "review_ready") return { line: reviewLine(run), dot: prDot(run && run.pr) };
  return { line: run ? tt(runStateKey(run.state)) : tt("groupIdle"), dot: "" };
}
export function runStateKey(s) {
  return ({ creating: "stateCreating", launching: "stateLaunching", running: "stateRunning", review_ready: "stateReviewReady",
    merging: "stateMerging", merged: "stateMerged", discarded: "stateDiscarded", failed: "stateFailed" })[s] || "stateRunning";
}
/** "리뷰 준비 · 파일 3개 · +41 −7 · 커밋 2개 · PR #12 · 검사 통과" — 조각마다 §9 원문, 구분자 ` · ` 만 코드가 붙인다. */
export function reviewLine(run) {
  const parts = [tt("stateReviewReady")];
  if (run && run.diff) parts.push(tt("filesSummary", { n: run.diff.files }), tt("diffStat", { a: run.diff.additions, d: run.diff.deletions }));
  if (run && run.commits && run.commits.ahead) parts.push(tt("commitsAhead", { n: run.commits.ahead }));
  parts.push(prLine(run && run.pr));
  return parts.join(" · ");
}
export function prLine(pr) {
  if (!pr) return tt("noPr");
  if (pr.state === "closed") return tt("prNumber", { n: pr.number }) + " · " + tt("prClosed");
  const c = pr.checks || {};
  const ck = { none: "checksNone", pending: "checksPending", passing: "checksPassing", failing: "checksFailing" }[c.status] || "checksNone";
  return tt("prNumber", { n: pr.number }) + (pr.isDraft ? " · " + tt("prDraft") : "") + " · " + tt(ck);
}
function prDot(pr) {
  if (!pr) return "";
  if (pr.checks && pr.checks.status === "failing") return "error";
  if (pr.state === "open" && pr.mergeable === "MERGEABLE" && (!pr.checks || pr.checks.status !== "pending")) return "cta";
  return "";
}

function card(r) {
  const run = r.run;
  const task = r.task;
  const c = document.createElement("div");
  const selected = sel && ((r.kind !== "agent" && task && sel.taskId === task.id && (!run || !sel.runId || sel.runId === run.id)) || sel.k === r.k);
  c.className = "tv-card" + (selected ? " selected" : "") + (focusK === r.k ? " kbd" : "");
  c.dataset.k = r.k;
  c.tabIndex = -1;
  const pc = S.pcDevices().find((d) => Number(d.id) === r.host);
  const where = r.kind === "agent"
    ? (r.wsName || r.cwd || "")
    : [task && task.title, run && run.branch].filter(Boolean).join(" · ");
  const st = statusOf(r);
  const who = r.kind === "task" ? (task.title || tt("title")) : agentName(r.agent || (r.live && r.live.agent));
  const logo = r.kind === "task" ? tasksIcon({ size: 15 }) : (agentMarkHtml(r.agent || (r.live && r.live.agent), { size: 15 }) || icons.terminal({ size: 15 }));
  c.innerHTML =
    `<div class="tvc-head"><span class="tvc-logo">${logo}</span><span class="tvc-who">${esc(who)}</span>`
    + `<span class="tvc-where">${esc([pc && pc.name, r.kind === "task" ? null : where].filter(Boolean).join(" · "))}</span>`
    + (r.unread ? `<span class="wsr-badge">${r.unread}</span>` : "")
    + `</div>`
    + `<div class="tvc-status"><span class="tv-dot ${st.dot}"></span><span class="tvc-line">${esc(st.line)}</span></div>`;
  const acts = document.createElement("div");
  acts.className = "tvc-acts";
  for (const b of cardActions(r)) acts.append(b);
  if (acts.childElementCount) c.append(acts);
  if (openAppr.has(r.k)) { if (r.approvals.length) c.append(approvalBox(r)); else openAppr.delete(r.k); }
  c.addEventListener("click", () => select(r));
  c.addEventListener("dblclick", () => openRow(r));
  return c;
}

function select(r) {
  focusK = r.k;
  if (r.kind === "agent") sel = { host: r.host, k: r.k, taskId: null };
  else sel = { host: r.host, taskId: r.task.id, runId: r.run ? r.run.id : null, k: r.k };
  updateTasksView();
}
function openRow(r) {
  if (r.kind === "task") { select(r); return; }
  if (r.run) void openRunTerminal(r.run.workspaceId, r.run.tid, { task: true });
  else void openRunTerminal(r.wsId, r.win);
}

/** 카드 행동(§5.4) — 그룹·사유별. */
function cardActions(r) {
  const out = [];
  const run = r.run;
  const task = r.task;
  const host = r.host;
  const term = () => btn("tv-btn ghost", tt("openTerminal"), () => openRow(r), {
    disabled: !!run && !run.workspaceId, title: run && !run.workspaceId ? tt("wsNotRegistered") : "",
  });
  if (r.kind === "task") {
    out.push(btn("tv-btn ghost", tt("detail"), () => select(r)));
    out.push(btn("tv-btn ghost", tt("deleteRecord"), () => deleteRecord(host, task.id)));
    return out;
  }
  if (r.group === "needs_input") {
    if (r.approvals.length) out.push(btn("tv-btn", tt("answer"), (e) => toggleApproval(e.currentTarget, r)));
    switch (r.reason) {
      case "trust": out.push(btn("tv-btn", tt("trustContinue"), () => trustRun(host, task.id, run.id))); break;
      case "agentGone": out.push(btn("tv-btn", tt("relaunchAgent"), () => reopenRun(host, task.id, run.id))); break;
      case "terminalGone": out.push(btn("tv-btn", tt("reopenTerminal"), () => reopenRun(host, task.id, run.id))); break;
      case "failed":
        out.push(btn("tv-btn", tt("reopen"), () => reopenRun(host, task.id, run.id)));
        out.push(btn("tv-btn ghost", tt("resendPrompt"), () => resendPrompt(host, task.id, run.id)));
        out.push(btn("tv-btn ghost danger", tt("discard"), () => discardFlow(host, task, run)));
        return out;
      case "promptNotDelivered": out.push(btn("tv-btn", tt("resendPrompt"), () => resendPrompt(host, task.id, run.id))); break;
      case "interrupted": out.push(btn("tv-btn", tt("reopen"), () => reopenRun(host, task.id, run.id))); break;
      case "keptDirty": out.push(btn("tv-btn ghost danger", tt("discard"), () => discardFlow(host, task, run))); return out;
      case "opFailed":
        out.push(btn("tv-btn ghost", tt("confirm"), () => { dismissedOps.add(`${run.id}:${run.lastOp.opId}`); S.emit(); }));
        break;
      default: break;
    }
    if (r.reason !== "terminalGone") out.push(term());
    return out;
  }
  if (r.group === "review_ready") {
    out.push(btn("tv-btn", tt("review"), () => select(r)));
    out.push(term());
    return out;
  }
  out.push(term());
  return out;
}

/** 승인 인라인 응답 — 알림 패널 행과 같은 모양·같은 순서(허용 → 묻지 않기 → 거절). 선택형은 터미널로. */
function toggleApproval(anchor, r) {
  const cardEl = anchor.closest(".tv-card");
  const had = cardEl.querySelector(".tvc-appr");
  if (had) { had.remove(); openAppr.delete(r.k); return; }
  openAppr.add(r.k);
  cardEl.append(approvalBox(r));
}
function approvalBox(r) {
  const box = document.createElement("div");
  box.className = "tvc-appr";
  for (const id of r.approvals) {
    const a = state.approvals.find((x) => x.id === id);
    if (!a) continue;
    const row = document.createElement("div");
    row.className = "tvc-appr-row";
    const summary = a.summary || (a.prompt && (a.prompt.title || a.prompt.question)) || a.tool || "";
    row.innerHTML = `<div class="tvc-appr-sum">${icons.shield({ size: 12 })}<span>${esc(summary)}</span></div>`;
    const acts = document.createElement("div");
    acts.className = "tvc-acts";
    const choice = a.prompt && a.prompt.kind === "choice";
    if (choice) {
      acts.append(btn("tv-btn ghost", tt("openTerminal"), () => openRow(r)));
    } else {
      acts.append(btn("tv-btn", i18n.t("허용"), () => S.respondApproval(a.id, { decision: "allow" })));
      if (a.alwaysLabel) acts.append(btn("tv-btn ghost", i18n.t("허용하고 묻지 않기"), () => S.respondApproval(a.id, { decision: "allow", always: true })));
      acts.append(btn("tv-btn ghost", i18n.t("거절"), () => S.respondApproval(a.id, { decision: "deny" })));
    }
    row.append(acts);
    box.append(row);
  }
  return box;
}

/** 폐기 — force:false 로 먼저, UNCOMMITTED/UNMERGED 면 확인 뒤 force:true(§6.7 A). 상세도 이 함수를 쓴다. */
export async function discardFlow(host, task, run, { all = false } = {}) {
  if (all && !window.confirm(tt("discardAllConfirm"))) return null;
  const params = { opId: newOpId(), taskId: task.id, ...(all ? {} : { runId: run.id }), force: false };
  let r;
  try {
    r = await taskRpc("task.discard", params, host);
  } catch (e) {
    toast(errText(e && e.code));
    void refreshHost(host);
    return null;
  }
  void refreshHost(host);
  const done = await waitOp(host, task.id, all ? null : run.id, params.opId);
  const code = done && done.lastOp && done.lastOp.ok === false ? done.lastOp.code : null;
  if (code === "UNCOMMITTED_CHANGES" || code === "UNMERGED_COMMITS") {
    const n = code === "UNCOMMITTED_CHANGES" ? ((run && run.diff && run.diff.files) || 1) : ((run && run.commits && run.commits.ahead) || 1);
    const ok = window.confirm(tt(code === "UNCOMMITTED_CHANGES" ? "discardConfirm" : "discardUnmergedConfirm", { n }));
    if (!ok) return r;
    try { await taskRpc("task.discard", { ...params, opId: newOpId(), force: true }, host); } catch (e) { toast(errText(e && e.code)); }
    void refreshHost(host);
  } else if (code) {
    toast(errText(code));
  }
  return r;
}

/**
 * op 마감 대기 — `run.op` 가 그 opId 에서 풀리고 `lastOp.opId === opId` 가 될 때까지 task.get 을 본다.
 *  tasks.changed 가 먼저 와도 무해(짧은 폴링이 안전망이다). 최대 limitMs. runId 가 없으면(전 run 폐기) 첫 run 기준.
 * @returns run(마감된) | null(시간 초과 — 호출부는 "확인 중…" 으로 남긴다)
 */
export async function waitOp(host, taskId, runId, opId, limitMs = 6 * 60 * 1000) {
  const until = Date.now() + limitMs;
  let delay = 700;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(3000, Math.round(delay * 1.4));
    let t;
    try { t = (await taskRpc("task.get", { taskId }, host)).task; } catch (_) { continue; }
    const runs = (t && t.runs) || [];
    const run = runId ? runs.find((x) => x.id === runId) : runs.find((x) => x.lastOp && x.lastOp.opId === opId) || runs[0];
    if (!run) return null;
    if (run.lastOp && run.lastOp.opId === opId && !(run.op && run.op.opId === opId)) return run;
  }
  return null;
}

/** 새 작업 시트(§6.3) — 현재 워크스페이스를 저장소 기본값으로. */
export function openNewTask(prefill) {
  const ws = S.activeWs();
  const def = prefill || (ws && !isTaskWorkspace(ws) && S.isLocal(ws) ? { wsId: ws.id, host: ws.hostDeviceId ?? state.daemon?.deviceId } : {});
  import("./new-task-sheet.js").then((m) => m.openNewTaskSheet(def)).catch(() => {});
}

/** 상세가 run 을 고르면 카드 선택도 따라간다. */
export function setSelection(next) {
  sel = next ? { ...sel, ...next } : null;
  updateTasksView();
}
export function selection() { return sel; }
/** 강제 재렌더(상세가 비동기로 데이터를 받았을 때) — 시그니처 캐시를 버리고 다시 그린다. */
export function invalidate() { detailGen++; updateTasksView(); }

// ── 키보드(§6.1) — ↑↓ 이동, Enter 터미널, r 리뷰, Esc 워크스페이스로 ─────────────────
function onKey(e) {
  if (state.view !== "tasks") return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
  // 버튼·링크·접이 요약에서 Enter/Space 는 그 요소 자신의 동작이다 — 가로채서 커서 행을 열지 않는다.
  if ((tag === "BUTTON" || tag === "SUMMARY" || tag === "A") && (e.key === "Enter" || e.key === " ")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const dash = dashboard();
  const flat = GROUPS.filter((g) => !collapsed.has(g)).flatMap((g) => dash.groups[g]);
  const i = flat.findIndex((r) => r.k === focusK);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!flat.length) return;
    const j = i < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
    focusK = flat[j].k;
    updateTasksView();
    el.querySelector(`.tv-card[data-k="${CSS.escape(focusK)}"]`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  const cur = i >= 0 ? flat[i] : null;
  if (e.key === "Enter" && cur) { e.preventDefault(); openRow(cur); return; }
  if ((e.key === "r" || e.key === "R") && cur && cur.kind !== "agent") { e.preventDefault(); select(cur); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    if (sel && el.clientWidth < 1100) { sel = null; updateTasksView(); return; }
    closeTasksDashboard();
  }
}
