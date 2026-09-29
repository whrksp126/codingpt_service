// automations-view.js — `자동화` 장소(automation-design §5.9). 메인 영역 뷰(state.view === 'automations').
//
// 사이드바 고른 PC 밑 `진행 현황` 다음 줄 `자동화` 가 여는 곳이다(사이드바 개정 1 규칙 그대로 — PC 안의 장소,
//  선택 배경은 지금 들어가 있는 곳 하나). 목록·상세·일시정지/재개/지금 실행/삭제/이름 변경만 한다 — 자동화를 폼으로
//  처음부터 만드는 편집 UI 는 비목표(§1.2). 생성은 한 줄 지시 또는 에이전트(`cpt auto create`).
//
// 데이터 흐름:
//  · 보고 있는 PC 의 `auto.list`(봉인 우선, automations-api.autoRpc) → state.automations.byHost. 정본은 그 PC 데몬.
//  · 갱신 = ui_command `automations.changed {host, ids, reason}`(300ms 디바운스) · 열려 있는 동안 60초 폴링 ·
//    runner_status online 전이 · 수동 [새로고침]. 상세는 `auto.get`(로그 꼬리 50줄 포함).
//  · 판정(그룹·점·정렬)은 automations-model.js(앱과 픽스처로 교차 검증)가 정본이고, 여기는 그리기만 한다.
//
// 규율: 이모지 0 · 선택/활성은 무채색 명암(--hover) · 상태 점만 error/spin · 전체 일시정지는 무채색 토글 + 배너.
import { state } from "./state.js";
import * as S from "./state.js";
import { icons, agentMarkHtml, iconBtn } from "./icons.js";
import { buildAutomations, autoRow } from "./automations-model.js";
import { autoRpc, hostHasAuto, hostAwake } from "./automations-api.js";
import { refreshHostCaps, onCapsChanged, newOpId, isLocalHostId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import { at } from "./text/automations.js";
import { agentName, toast, openTasksDashboard, pcNameButton } from "./tasks-view.js";
import * as i18n from "./i18n/index.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const POLL_MS = 60000;
let el = null;
let pollTimer = null;
const changedTimers = new Map(); // host → 디바운스 타이머
const inflight = new Map();      // host → Promise
let sel = null;                  // { host, id }
let pausedOpen = false;          // 일시정지됨 그룹 — 기본 접힘(§5.9)
const busy = new Set();          // `${id}:${kind}` — 누른 버튼을 응답 전까지 잠근다
const details = new Map();       // `${host}|${id}` → { automation, log, at, loading, error }
let renaming = null;             // 이름 편집 중인 id
let frameSig = "", listSig = "", detailSig = "";

/** 지금 보고 있는 PC(자동화는 만든 PC 에 산다 — §5.5 멀티 PC). */
function curHost() {
  const h = Number(S.activeDeviceId());
  return Number.isFinite(h) && h > 0 ? h : state.daemon?.deviceId ?? null;
}
function hostName(h) {
  const d = S.pcDevices().find((x) => Number(x.id) === Number(h));
  return d ? d.name || "" : "";
}
function hostOnline(h) {
  const d = S.pcDevices().find((x) => Number(x.id) === Number(h));
  return !d || d.online !== false;
}

// ── 스토어/갱신 ────────────────────────────────────────────────────────────────
export function refreshAutoHost(host) {
  const h = Number(host);
  if (!Number.isFinite(h) || h <= 0) return Promise.resolve();
  if (inflight.has(h)) return inflight.get(h);
  const p = (async () => {
    try {
      const r = await autoRpc("auto.list", {}, h);
      S.setAutomationsForHost(h, {
        items: (r && r.items) || [], paused: !!(r && r.paused), limits: (r && r.limits) || null,
        counts: (r && r.counts) || null, at: Date.now(), error: null,
      });
    } catch (e) {
      // 목록은 지우지 않는다(마지막으로 본 것 유지) — 에러만 표시.
      S.setAutomationsForHost(h, { error: { code: (e && e.code) || "", message: String((e && e.message) || e) }, at: Date.now() });
    } finally {
      inflight.delete(h);
    }
  })();
  inflight.set(h, p);
  return p;
}

/** 보고 있는 PC 만 — 자동화는 PC 안의 장소다(다른 PC 의 것은 그 PC 를 골랐을 때 받는다). */
export function refreshAutomations() {
  const h = curHost();
  if (h == null || !hostOnline(h) || hostHasAuto(h) === false) return Promise.resolve();
  return refreshAutoHost(h);
}

/** ui_command `automations.changed {host, ids, reason}` — 300ms 디바운스 후 그 host 재조회(+ 상세가 보는 항목이면 상세도). */
export function onAutomationsChanged(p) {
  const raw = p ? p.host : null;
  const h = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(h) || h <= 0) { void refreshAutomations(); return; }
  clearTimeout(changedTimers.get(h));
  changedTimers.set(h, setTimeout(() => {
    changedTimers.delete(h);
    void refreshAutoHost(h);
    if (sel && Number(sel.host) === h) {
      const ids = Array.isArray(p.ids) ? p.ids : [];
      if (!ids.length || ids.includes(sel.id)) void loadDetail(h, sel.id);
    }
  }, 300));
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !state.paired || state.view !== "automations") return;
    void refreshAutomations();
  }, POLL_MS);
}

/** 부팅 후 1회(main.js) — 사이드바 배지(주의 수)를 위해 보고 있는 PC 의 목록을 한 번 받는다. 폴링은 열려 있을 때만. */
export function startAutomationsBackground() {
  void refreshHostCaps().then(() => refreshAutomations());
}

/** 사이드바 `자동화 [n]` 배지 — 보고 있는 PC 의 주의(실패·오류 일시정지) 수. */
export function autoAttentionCount() {
  try { return modelFor(curHost()).counts.attention; } catch (_) { return 0; }
}

function modelFor(h) {
  const v = state.automations.byHost[String(h)] || {};
  return buildAutomations({ now: Date.now(), items: v.items || [], paused: !!v.paused, hostOnline: hostOnline(h) });
}

// ── 열기/닫기 ──────────────────────────────────────────────────────────────────
/** 자동화 장소 열기. opts = { id?, host? } — 딥링크(codingpt://auto/<id>?host=)·작업 카드 `자동` 칩·한 줄 지시에서. */
export function openAutomations(opts) {
  const o = opts || {};
  const h = o.host != null && o.host !== "" ? Number(o.host) : null;
  // 다른 PC 의 자동화를 가리키면 그 PC 로 옮긴다(장소는 PC 안). setActiveDevice 는 워크스페이스로 이동시키므로
  //  그 뒤에 view 를 다시 세운다.
  if (h && h !== Number(S.activeDeviceId()) && S.pcDevices().some((d) => Number(d.id) === h)) S.setActiveDevice(h);
  if (o.id) { sel = { host: h || curHost(), id: String(o.id) }; void loadDetail(sel.host, sel.id); }
  S.setView("automations");
  void refreshHostCaps();
  void refreshAutomations();
  startPolling();
  setTimeout(() => el?.focus?.(), 30);
}
export function closeAutomations() { S.setView("workspace"); }

// ── 행동 ──────────────────────────────────────────────────────────────────────
async function act(host, id, kind, method, params, { done } = {}) {
  const key = `${id}:${kind}`;
  if (busy.has(key)) return null;
  busy.add(key);
  updateAutomationsView();
  try {
    const r = await autoRpc(method, params, host);
    done?.(r);
    return r || {};
  } catch (e) {
    toast(errText(e && e.code));
    return null;
  } finally {
    busy.delete(key);
    void refreshAutoHost(host);
    if (sel && sel.id === id) void loadDetail(host, id);
    updateAutomationsView();
  }
}
const runNow = (host, id) => act(host, id, "run", "auto.runNow", { opId: newOpId(), id });
const pauseOne = (host, id) => act(host, id, "pause", "auto.pause", { id });
const resumeOne = (host, id) => act(host, id, "pause", "auto.resume", { id });
async function removeOne(host, id) {
  if (!window.confirm(at("deleteAutoConfirm"))) return;
  await act(host, id, "remove", "auto.remove", { id }, { done: () => { if (sel && sel.id === id) sel = null; details.delete(`${host}|${id}`); } });
}
const renameOne = (host, id, name) => act(host, id, "rename", "auto.update", { id, patch: { name } });
async function pauseAll(host, paused) {
  try {
    await autoRpc("auto.pauseAll", { paused }, host);
  } catch (e) {
    toast(errText(e && e.code));
  }
  void refreshAutoHost(host);
}

async function loadDetail(host, id) {
  const k = `${host}|${id}`;
  const cur = details.get(k);
  if (cur && cur.loading) return;
  details.set(k, { ...(cur || {}), loading: true });
  try {
    const r = await autoRpc("auto.get", { id }, host);
    details.set(k, { automation: (r && r.automation) || null, log: (r && r.log) || [], at: Date.now(), loading: false, error: null });
  } catch (e) {
    details.set(k, { ...(cur || {}), loading: false, error: (e && e.code) || "x" });
  }
  detailSig = "";
  updateAutomationsView();
}

// ── 문장 ──────────────────────────────────────────────────────────────────────
/** 절대 시각 — "9월 30일 09:00"(언어별 Intl). 상대 표현("…뒤")은 카탈로그 원문이 없어 쓰지 않는다. */
export function whenText(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  try {
    return new Intl.DateTimeFormat(i18n.getLang() === "zh-CN" ? "zh-CN" : i18n.getLang(), {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(Number(ms)));
  } catch (_) { return new Date(Number(ms)).toISOString().slice(5, 16).replace("T", " "); }
}
/** 트리거 한 줄(§8.2 — cron 은 원문 그대로). */
export function triggerLabel(row) {
  const v = { ...(row.triggerVars || {}) };
  if (row.triggerKey === "trigOnce") v.t = whenText(v.at);
  if (row.triggerKey === "trigSchedule" && !v.tz) return String(v.cron || "");
  // 라벨이 없으면 대상 저장소 이름 — 빈 채로 두면 "새 이슈 ·" 로 끝이 잘려 보인다(앱과 같은 규칙).
  if (row.triggerKey === "trigIssues" && !v.labels && v.repo) v.labels = String(v.repo).split("/").filter(Boolean).pop() || "";
  return at(row.triggerKey, v);
}
function creatorLine(row) {
  if (row.creator === "agent") return at("madeByAgent", { agent: agentName(row.creatorAgent) || "Agent" });
  if (row.creator === "dispatch") return at("madeByDispatch");
  return at("madeByUser");
}
function pausedLine(row) {
  const k = { error: "pausedByError", limit: "pausedByLimit", server: "pausedByServer" }[row.pausedReason];
  return k ? at(k) : null;
}
function lastLine(row) {
  if (row.lastOk == null) return null;
  const base = at(row.lastOk ? "lastOk" : "lastFailed", { t: whenText(row.lastAt) });
  if (row.lastOk && row.taskIds.length) return base + " · " + at("lastCreatedTasks", { n: row.taskIds.length });
  if (!row.lastOk && row.lastCode) return base + " · " + errText(row.lastCode);
  return base;
}
function nextLine(row) {
  if (row.group === "paused") return pausedLine(row);
  return row.nextRunAt != null ? at("nextRun", { t: whenText(row.nextRunAt) }) : null;
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────
export function mountAutomationsView(container) {
  el = container;
  el.className = "automations-view";
  el.tabIndex = 0;
  el.addEventListener("keydown", onKey);
  onCapsChanged(() => { if (state.view === "automations") S.emit(); });
  try { new ResizeObserver(() => { updateAutomationsView(); }).observe(el); } catch (_) { /* noop */ }
}

export function updateAutomationsView() {
  if (!el) return;
  const on = state.view === "automations";
  el.hidden = !on;
  if (!on) return;
  startPolling();
  const h = curHost();
  if (sel && Number(sel.host) !== Number(h)) sel = null; // 다른 PC 로 옮겼으면 이전 PC 의 상세는 닫는다
  const v = state.automations.byHost[String(h)] || {};
  const m = modelFor(h);
  const wide = el.clientWidth >= 1100;
  const fSig = JSON.stringify([wide, !!sel, state.sidebarCollapsed, h, hostName(h), !!v.paused, hostAwake(h)]);
  const lSig = JSON.stringify([wide, sel, pausedOpen, [...busy], v.items, v.paused, v.error, hostOnline(h), hostHasAuto(h), i18n.getLang()]);
  const det = sel ? details.get(`${sel.host}|${sel.id}`) : null;
  const dSig = sel ? JSON.stringify([wide, sel, renaming, [...busy], det && [det.automation, det.log, det.error, !!det.loading],
    (v.items || []).find((x) => x.id === sel.id) || null]) : "none";
  const frameChanged = fSig !== frameSig || !el.querySelector(".tv-body");
  if (frameChanged) { frameSig = fSig; renderFrame(wide, h, v); listSig = ""; detailSig = ""; }
  const listEl = el.querySelector(".tv-list");
  if (listEl && lSig !== listSig) {
    listSig = lSig;
    const top = listEl.scrollTop;
    const fresh = renderList(h, v, m);
    listEl.replaceWith(fresh);
    fresh.scrollTop = top;
  }
  const detEl = el.querySelector(".tv-detail");
  if (detEl && dSig !== detailSig) {
    // 이름 편집 중이면 다시 그리지 않는다(입력이 날아간다).
    if (renaming && detEl.querySelector(".au-rename")) return;
    detailSig = dSig;
    const top = detEl.scrollTop;
    renderDetail(detEl, h, v);
    detEl.scrollTop = top;
  }
}

function renderFrame(wide, h, v) {
  el.classList.toggle("tv-wide", wide);
  el.innerHTML = "";
  const top = document.createElement("div");
  top.className = "tv-top";
  top.setAttribute("data-tauri-drag-region", "");
  if (state.sidebarCollapsed) {
    import("./sidebar.js").then((m) => {
      const ctl = document.createElement("span");
      ctl.className = "mt-ctl";
      ctl.append(m.buildTopControls(false));
      top.prepend(ctl);
    }).catch(() => {});
  }
  if (!wide && sel) {
    const back = document.createElement("button");
    back.className = "tv-back";
    back.innerHTML = icons.chevronLeft({ size: 14 }) + `<span>${esc(at("automations"))}</span>`;
    back.addEventListener("click", () => { sel = null; updateAutomationsView(); });
    top.append(back);
  } else {
    const t = document.createElement("span");
    t.className = "tv-title";
    t.textContent = at("automations");
    top.append(t);
    const dn = hostName(h);
    if (dn) top.append(pcNameButton(h, dn));
  }
  const sp = document.createElement("span");
  sp.className = "mt-spacer";
  top.append(sp);
  // 전체 일시정지(킬스위치) — 무채색 토글. 켜지면 헤더 아래 배너(§5.9). 상태 컨트롤이라 아이콘이 아니라 토글이다.
  if (hostHasAuto(h) !== false && hostOnline(h)) {
    const lab = document.createElement("label");
    lab.className = "au-pauseall";
    lab.title = at("pauseAll");
    const txt = document.createElement("span");
    txt.textContent = at("pauseAll");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "tgl sm";
    cb.checked = !!v.paused;
    cb.setAttribute("aria-label", at("pauseAll"));
    cb.addEventListener("change", () => { void pauseAll(h, cb.checked); });
    lab.append(txt, cb);
    top.append(lab);
  }
  const refB = iconBtn("refresh", { cls: "tv-ic", size: 16, sw: 1.6, title: tt("refresh"), onClick: () => { void refreshHostCaps(); void refreshAutomations(); if (sel) void loadDetail(sel.host, sel.id); } });
  refB.setAttribute("aria-label", refB.title);
  top.append(refB);
  el.append(top);

  const body = document.createElement("div");
  body.className = "tv-body";
  el.append(body);
  if (wide || !sel) {
    const ph = document.createElement("div");
    ph.className = "tv-list";
    body.append(ph);
  }
  if (wide || sel) {
    const det = document.createElement("div");
    det.className = "tv-detail";
    body.append(det);
  }
}

function banner(text, cls) {
  const b = document.createElement("div");
  b.className = "tv-banner" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
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

function openDispatch() {
  import("./dispatch-sheet.js").then((m) => m.openDispatchSheet()).catch(() => {});
}

function renderList(h, v, m) {
  const list = document.createElement("div");
  list.className = "tv-list au-list";
  if (!hostOnline(h)) {
    list.append(banner(`${hostName(h) || tt("pc")} · ${tt("hostOffline")}`));
  } else if (hostHasAuto(h) === false) {
    list.append(banner(`${hostName(h) || tt("pc")} · ${tt("pcNeedsUpdate")}`));
    return list;
  }
  if (v.error && v.error.code) {
    const b = banner(`${hostName(h) || tt("pc")} · ${errText(v.error.code)}`, "tv-banner-err");
    b.append(btn("tv-btn ghost", tt("refresh"), () => { void refreshAutoHost(h); }));
    list.append(b);
  }
  if (v.paused) list.append(banner(at("autoPausedAll")));
  if (!m.rows.length) {
    if (v.error && v.error.code) return list; // 실패를 "없음" 으로 덮지 않는다
    if (!v.at && hostOnline(h)) { list.append(emptyNote(tt("checking"))); return list; }
    const e = document.createElement("div");
    e.className = "tv-empty";
    e.innerHTML = `<div class="tv-empty-title">${esc(at("autoEmpty"))}</div><div class="tv-empty-hint">${esc(at("autoEmptyHint"))}</div>`;
    e.append(btn("tv-btn", at("dispatch"), openDispatch));
    list.append(e);
    return list;
  }
  for (const r of m.groups.active) list.append(rowCard(h, r));
  if (m.groups.paused.length) {
    const head = document.createElement("button");
    head.className = "tv-group";
    head.innerHTML = `<span class="tv-caret">${pausedOpen ? icons.chevronDown({ size: 12 }) : icons.chevronRight({ size: 12 })}</span>`
      + `<span>${esc(at("groupPaused"))}</span><span class="tv-count">${m.groups.paused.length}</span>`;
    head.addEventListener("click", () => { pausedOpen = !pausedOpen; updateAutomationsView(); });
    list.append(head);
    if (pausedOpen) for (const r of m.groups.paused) list.append(rowCard(h, r));
  }
  return list;
}
function emptyNote(text) {
  const d = document.createElement("div");
  d.className = "tv-detail-empty";
  d.textContent = text;
  return d;
}

function rowCard(h, r) {
  const c = document.createElement("div");
  const selected = sel && sel.id === r.id;
  c.className = "tv-card au-row" + (selected ? " selected" : "") + (r.group === "paused" ? " au-paused" : "");
  c.dataset.id = r.id;
  const mark = r.creator === "agent" ? (agentMarkHtml(r.creatorAgent, { size: 13 }) || "") : "";
  const subs = [creatorLine(r), nextLine(r), lastLine(r)].filter(Boolean);
  c.innerHTML =
    `<div class="tvc-head"><span class="tv-dot ${r.dot === "none" ? "" : r.dot}"></span>`
    + `<span class="au-name">${esc(r.name)}</span><span class="au-trig${r.triggerKey === "trigSchedule" ? " cron" : ""}">${esc(triggerLabel(r))}</span></div>`
    + `<div class="au-sub">${mark ? `<span class="au-mark">${mark}</span>` : ""}<span class="au-subtx">${esc(subs.join(" · "))}</span></div>`;
  const acts = document.createElement("div");
  acts.className = "tvc-acts au-acts";
  for (const b of rowActions(h, r)) acts.append(b);
  c.append(acts);
  c.addEventListener("click", () => { sel = { host: h, id: r.id }; void loadDetail(h, r.id); updateAutomationsView(); });
  return c;
}

function rowActions(h, r) {
  const out = [];
  const locked = !hostOnline(h);
  out.push(btn("tv-btn ghost", at("runNow"), () => runNow(h, r.id), { disabled: locked || busy.has(`${r.id}:run`) }));
  if (r.group === "paused") out.push(btn("tv-btn ghost", at("resume"), () => resumeOne(h, r.id), { disabled: locked || busy.has(`${r.id}:pause`) }));
  else out.push(btn("tv-btn ghost", at("pause"), () => pauseOne(h, r.id), { disabled: locked || busy.has(`${r.id}:pause`) }));
  out.push(btn("tv-btn ghost danger", at("deleteAuto"), () => removeOne(h, r.id), { disabled: locked || busy.has(`${r.id}:remove`) }));
  return out;
}

function renderDetail(det, h, v) {
  det.innerHTML = "";
  det.className = "tv-detail td au-detail";
  if (!sel) {
    det.innerHTML = `<div class="tv-detail-empty">${esc(tt("detail"))}</div>`;
    return;
  }
  const d = details.get(`${sel.host}|${sel.id}`) || {};
  const lite = (v.items || []).find((x) => x.id === sel.id) || null;
  const a = d.automation || lite;
  if (!a) {
    det.innerHTML = `<div class="tv-detail-empty">${esc(d.error ? errText(d.error) : tt("checking"))}</div>`;
    return;
  }
  const r = autoRow(a);
  // 머리 — 이름(누르면 인라인 편집 → auto.update {name}) · 만든 이 · 상태
  const head = document.createElement("div");
  head.className = "td-head";
  const title = document.createElement("div");
  title.className = "td-title";
  if (renaming === r.id) {
    const inp = document.createElement("input");
    inp.className = "tk-input au-rename";
    inp.value = r.name;
    inp.maxLength = 80;
    const commit = () => {
      const name = inp.value.trim();
      renaming = null;
      if (name && name !== r.name) void renameOne(h, r.id, name);
      detailSig = ""; updateAutomationsView();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); renaming = null; detailSig = ""; updateAutomationsView(); }
    });
    inp.addEventListener("blur", commit);
    title.append(inp);
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  } else {
    title.innerHTML = `<span class="tv-dot ${r.dot === "none" ? "" : r.dot}"></span>`;
    const nm = document.createElement("button");
    nm.className = "au-title-btn";
    nm.textContent = r.name;
    nm.title = at("rename");
    nm.addEventListener("click", () => { renaming = r.id; detailSig = ""; updateAutomationsView(); });
    title.append(nm);
  }
  head.append(title);
  const meta = document.createElement("div");
  meta.className = "td-meta";
  const chips = [];
  if (r.group === "paused") chips.push(`<span class="td-chip">${esc(at("groupPaused"))}</span>`);
  meta.innerHTML = chips.join("")
    + `<span class="au-meta-by">${r.creator === "agent" ? agentMarkHtml(r.creatorAgent, { size: 12 }) || "" : ""}${esc(creatorLine(r))}</span>`
    + (pausedLine(r) ? `<span>${esc(pausedLine(r))}</span>` : "");
  head.append(meta);
  det.append(head);

  // 트리거
  const trig = document.createElement("div");
  trig.className = "au-card";
  trig.innerHTML = `<div class="au-card-title${r.triggerKey === "trigSchedule" ? " cron" : ""}">${icons.repeat({ size: 13 })}<span>${esc(triggerLabel(r))}</span></div>`
    + (r.triggerVars && r.triggerVars.repo ? `<div class="au-card-sub mono">${esc(r.triggerVars.repo)}</div>` : "");
  det.append(trig);

  // 액션(매크로 = 순서열)
  const acts = Array.isArray(a.actions) ? a.actions : [];
  if (acts.length) {
    const list = document.createElement("div");
    list.className = "au-steps";
    acts.forEach((x, i) => list.append(stepRow(x, i)));
    det.append(list);
  }

  // 제한 · 상태
  const info = document.createElement("div");
  info.className = "au-facts";
  const facts = [
    [at("guards"), at("runsToday", { n: r.runsToday, d: r.maxRunsPerDay })],
    [null, r.nextRunAt != null && r.group === "active" ? at("nextRun", { t: whenText(r.nextRunAt) }) : at("noNextRun")],
    [null, lastLine(r)],
  ].filter(([, val]) => val);
  info.innerHTML = facts.map(([k, val]) => `<div class="au-fact">${k ? `<span class="au-fact-k">${esc(k)}</span>` : `<span class="au-fact-k"></span>`}<span>${esc(val)}</span></div>`).join("");
  det.append(info);

  // 행동 바
  const bar = document.createElement("div");
  bar.className = "td-actions";
  for (const b of rowActions(h, r)) bar.append(b);
  det.append(bar);
  // 이 자동화가 만든 작업 — 진행 현황으로
  if (r.taskIds.length) {
    const b = btn("tv-btn ghost", tt("overview"), () => openTasksDashboard({ taskId: r.taskIds[0], host: h }));
    bar.append(b);
  }

  // 실행 기록(감사 로그 꼬리)
  const log = Array.isArray(d.log) ? d.log : [];
  const lg = document.createElement("div");
  lg.className = "au-log-wrap";
  lg.innerHTML = `<div class="au-sec-title">${esc(at("auditLog"))}</div>`;
  const pre = document.createElement("div");
  pre.className = "au-log mono";
  if (!log.length) pre.innerHTML = `<div class="au-log-empty">${esc(d.loading ? tt("checking") : "—")}</div>`;
  for (const l of log.slice(-50).reverse()) {
    const line = document.createElement("div");
    line.className = "au-log-line" + (l.ok === false ? " err" : "");
    line.textContent = [whenText(l.at), l.stage, l.type, l.code, l.taskId].filter(Boolean).join("  ");
    pre.append(line);
  }
  lg.append(pre);
  det.append(lg);
}

function stepRow(x, i) {
  const row = document.createElement("div");
  row.className = "au-step";
  const typeKey = { "task.create": "actTaskCreate", "terminal.prompt": "actPrompt", notify: "actNotify" }[x.type] || null;
  const target = x.type === "task.create" ? [x.repo, x.subdir].filter(Boolean).join("/")
    + (Array.isArray(x.agents) && x.agents.length ? " · " + x.agents.map((a) => `${agentName(a.id)}${a.count > 1 ? " ×" + a.count : ""}`).join(", ") : "")
    : x.type === "terminal.prompt" ? (x.target && (x.target.taskId || x.target.cwd || (x.target.event ? "event" : ""))) || ""
    : x.title || "";
  row.innerHTML = `<div class="au-step-head"><span class="au-step-n">${esc(at("stepN", { n: i + 1 }))}</span>`
    + `<span class="au-step-type">${esc(typeKey ? at(typeKey) : x.type)}</span>`
    + (target ? `<span class="au-step-tgt mono">${esc(target)}</span>` : "") + `</div>`;
  const tpl = x.prompt || x.text || x.subtitle || "";
  if (tpl) {
    const dd = document.createElement("details");
    dd.className = "td-prompt";
    dd.innerHTML = `<summary>${esc(tt("prompt"))}</summary><pre>${esc(tpl)}</pre>`;
    row.append(dd);
  }
  return row;
}

function onKey(e) {
  if (state.view !== "automations") return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (sel && el.clientWidth < 1100) { sel = null; updateAutomationsView(); return; }
    if (sel) { sel = null; updateAutomationsView(); return; }
    closeAutomations();
  }
}

/** 이 PC 인가(설정 카드·시트가 쓴다). */
export function isThisPc(host) { return isLocalHostId(state, host); }
