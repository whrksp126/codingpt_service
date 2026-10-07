// issues-view.js — 이슈 장소(state.view === "issues"). 메인 영역을 대신 쓰는 장소 — 진행 현황·자동화와 같은 규칙.
//  CodingPT 자체 이슈와 외부 서비스(GitHub) 이슈를 **한 목록**으로 보고, 출처·워크스페이스·검색으로 거른다.
//  보기 = 목록(상태별 묶음) · 보드(칸반, 끌어서 상태 변경) · 표(열 정렬). 이슈에서 [시작] 을 누르면 에이전트가 그 이슈로 일한다.
//  데이터는 고른 PC 의 데몬(orch.issue*)이 준다 — 받은 신호(orch.changed)와 60초 폴링으로 맞춘다(pull).
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import * as i18n from "./i18n/index.js";
import { orchRpc } from "./orch-api.js";
import { toast, openTasksDashboard, openRunTerminal, agentName } from "./tasks-view.js";
import { agentGlyphHtml } from "./agent-glyph.js";
import { createRichEditor } from "./rich-editor.js";
import { attachInputUndo } from "./undo-history.js";
import { STATUSES, VIEWS, filterIssues, groupByStatus, sortIssues, sortTable, sourceOptions, openCount } from "./issues-model.js";
import { createAutosaver, normFields, isBlank, displayTitle, workspaceOptions, isSeatOrWorktree, SAVE_DELAY_EXT_MS } from "./issues-autosave.js";

const t = (s, v) => i18n.t(s, v);
const ST_TEXT = { todo: "할 일", in_progress: "진행 중", in_review: "리뷰 중", done: "완료" };
const PRI_TEXT = { none: "없음", low: "낮음", medium: "보통", high: "높음", urgent: "긴급" };
const SRC_TEXT = { all: "전체", codingpt: "CodingPT", github: "GitHub", gitlab: "GitLab", linear: "Linear", jira: "Jira", notion: "Notion" };
const MODE_TEXT = { task: "새 작업(전용 브랜치)", terminal: "새 터미널(이 폴더)", orch: "오케스트레이션" };
const ERR_TEXT = { GH_AUTH: "GitHub 로그인이 필요해요(gh auth login)", GH_MISSING: "gh 가 설치되어 있지 않아요", ISSUES_DISABLED: "이 저장소는 이슈를 쓰지 않아요",
  NOT_GITHUB: "GitHub 저장소가 아니에요", DAEMON_OFFLINE: "PC 가 연결되어 있지 않아요", START_FAILED: "시작하지 못했어요" };
const errText = (code) => t(ERR_TEXT[String(code || "")] || "문제가 생겼어요. 다시 시도해 주세요");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let el = null;
let pollTimer = null;
let sheet = null;                         // 열린 상세/새 이슈 시트 { close }
let dropHook = null;                      // 시트가 열려 있을 때 OS 파일 드롭을 받는 곳
/** os-drop.js — 이슈 시트가 열려 있으면 끌어다 놓은 파일을 첨부로 받는다. 받았으면 true. */
export function issueSheetDrop(paths) { if (!dropHook) return false; dropHook(paths); return true; }
const data = new Map();                   // host → { issues, sources, at, error, loading }
const PREF_KEY = "cpt.issues.pref";
let pref = { view: "list", source: "all", cwd: "", state: "open", sort: "updatedAt", dir: -1, start: { mode: "task", agent: "claude" } };
try { pref = { ...pref, ...(JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}) }; } catch (_) { /* 기본값 */ }
if (!VIEWS.includes(pref.view)) pref.view = "list";
let query = "";
const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (_) { /* 저장 못 해도 화면은 돈다 */ } };

const curHost = () => Number(S.activeDeviceId());
const wsAll = (h) => S.workspacesForDevice(h).filter((w) => w.localPath);
//  이슈가 묻는 워크스페이스 = 이 PC 의 프로젝트 폴더. VM 자리 폴더(~/.codingpt/vm/<os>/ws/…)·작업 폴더는 뺀다 —
//  그대로 늘어놓으면 같은 이름("codingpt")이 OS 수만큼 더 나온다(issues-autosave.js workspaceOptions 머리말).
const wsList = (h) => wsAll(h).filter((w) => !isSeatOrWorktree(w.localPath));
/** 고르는 목록 → [{ cwd, label }]. keep = 그 이슈에 이미 적힌 폴더(목록에 없어도 남긴다). */
const wsOpts = (h, keep) => workspaceOptions(wsAll(h).map((w) => ({ cwd: w.localPath, name: S.wsDisplayName(w) })), keep);
const wsName = (h, cwd) => { if (!cwd) return ""; const o = wsOpts(h, cwd).find((x) => x.cwd === cwd); return o ? o.label : cwd.split("/").pop(); };
/** 목록에 보일 제목 — 제목 없는 초안은 본문 첫 줄(없으면 "제목 없음"). */
const titleOf = (x) => displayTitle(x, t("제목 없음"));

export function issuesSnapshot(host) { return data.get(Number(host)) || null; }
/** 연결된 외부 서비스(이슈를 읽어 온 것) — 사이드바 이슈 행의 표식. */
export function issuesProviders(host) { const d = data.get(Number(host)); return d ? [...new Set((d.sources || []).filter((x) => x.ok && x.provider !== "codingpt").map((x) => x.provider))] : []; }
export function issuesOpenCount(host) { const d = data.get(Number(host)); return d ? openCount(d.issues) : 0; }

export async function refreshIssues({ fresh = false } = {}) {
  const h = curHost();
  if (!Number.isFinite(h) || h <= 0) return;
  const cur = data.get(h) || { issues: [], sources: [], at: 0, error: null };
  //  읽는 중에 또 바뀌었으면(자동 저장 직후의 신호) 끝난 뒤 한 번 더 읽는다 — 그냥 버리면 저장 전 사본이 목록에 남는다.
  if (cur.loading) { cur.again = true; return; }
  cur.loading = true; data.set(h, cur);
  try {
    const r = await orchRpc("orch.issueList", { cwds: [...new Set(wsList(h).map((w) => w.localPath))], fresh }, h, 45000);
    data.set(h, { issues: (r && r.issues) || [], sources: (r && r.sources) || [], at: Date.now(), error: null, loading: false });
  } catch (e) {
    data.set(h, { ...cur, error: (e && e.code) || "ERROR", loading: false, again: false });
  }
  S.emit();
  if (sheet && sheet.onRemote && h === curHost()) sheet.onRemote();   // 열린 이슈 — 고치는 중이 아닌 칸만 따라간다
  if (cur.again) { cur.again = false; void refreshIssues(); }
}
/** ui_command orch.changed(reason=issues) — 열려 있을 때만 다시 읽는다(닫혀 있으면 열 때 읽는다). */
export function onIssuesChanged() { if (state.view === "issues") void refreshIssues(); else { const d = data.get(curHost()); if (d) d.at = 0; } }

export function openIssues() {
  S.setView("issues");
  void refreshIssues();
  resumeDraft(curHost());
  if (!pollTimer) pollTimer = setInterval(() => { if (state.view === "issues" && !document.hidden) void refreshIssues(); }, 60000);
  setTimeout(() => el?.focus?.(), 30);
}
export function closeIssues() { S.setView("workspace"); }

async function act(method, params, okMsg) {
  try {
    const r = await orchRpc(method, params, curHost(), method === "orch.issueStart" ? 90000 : 45000);
    if (okMsg) toast(okMsg);
    void refreshIssues();
    return r || {};
  } catch (e) { toast(errText(e && e.code)); return null; }
}

// ── 조각 ──────────────────────────────────────────────────────────────────────
const stGlyph = (st) => st === "done" ? agentGlyphHtml("done") : `<span class="is-st ${st}"></span>`;
const srcChip = (x) => x.source.provider === "codingpt" ? "" : `<span class="is-chip">${esc(SRC_TEXT[x.source.provider] || x.source.provider)}</span>`;
const priChip = (x) => x.priority && x.priority !== "none" ? `<span class="is-pri ${x.priority}">${esc(t(PRI_TEXT[x.priority]))}</span>` : "";
const linkMark = (x) => x.link ? `<span class="is-link" title="${esc(t(MODE_TEXT[x.link.mode] || ""))}">${agentMarkHtml(x.link.agent || "claude", { size: 12 }) || ""}</span>` : "";
function rowHtml(h, x) {
  return `<button class="is-row" data-id="${esc(x.id)}">${stGlyph(x.status)}<span class="is-key">${esc(x.key)}</span>` +
    `<span class="is-title${x.title ? "" : " blank"}">${esc(titleOf(x))}</span>${linkMark(x)}${priChip(x)}${(x.labels || []).slice(0, 3).map((l) => `<span class="is-label">${esc(l)}</span>`).join("")}${srcChip(x)}` +
    `<span class="is-ws">${esc(wsName(h, x.cwd))}</span></button>`;
}
function cardHtml(h, x) {
  return `<div class="is-card" draggable="true" data-id="${esc(x.id)}"><div class="is-card-top"><span class="is-key">${esc(x.key)}</span>${linkMark(x)}${priChip(x)}${srcChip(x)}</div>` +
    `<div class="is-card-title${x.title ? "" : " blank"}">${esc(titleOf(x))}</div><div class="is-card-ws">${esc(wsName(h, x.cwd))}</div></div>`;
}

export function mountIssuesView(container) {
  el = container;
  el.className = "issues-view tasks-view";
  el.tabIndex = 0;
  attachInputUndo(el);   // 검색칸의 ⌘Z
  el.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet) closeIssues(); });
  el.addEventListener("click", onClick);
  el.addEventListener("input", (e) => { if (e.target.classList?.contains("is-q")) { query = e.target.value; drawBody(); } });
  el.addEventListener("change", (e) => {
    const k = e.target.dataset?.pref;
    if (!k) return;
    pref[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    savePref(); draw();
  });
  // 보드 — 카드를 끌어 다른 열에 놓으면 상태가 바뀐다.
  el.addEventListener("dragstart", (e) => { const c = e.target.closest?.(".is-card"); if (c) { e.dataTransfer.setData("text/plain", c.dataset.id); e.dataTransfer.effectAllowed = "move"; } });
  el.addEventListener("dragover", (e) => { const col = e.target.closest?.(".is-col"); if (col) { e.preventDefault(); col.classList.add("over"); } });
  el.addEventListener("dragleave", (e) => { e.target.closest?.(".is-col")?.classList.remove("over"); });
  el.addEventListener("drop", (e) => {
    const col = e.target.closest?.(".is-col");
    if (!col) return;
    e.preventDefault(); col.classList.remove("over");
    const id = e.dataTransfer.getData("text/plain");
    const x = (data.get(curHost())?.issues || []).find((y) => y.id === id);
    if (x && x.status !== col.dataset.status) { x.status = col.dataset.status; drawBody(); void act("orch.issueUpdate", { id, status: col.dataset.status }); }
  });
}

let topSig = "";
export function updateIssuesView() {
  if (!el) return;
  const on = state.view === "issues";
  el.hidden = !on;
  if (!on) { if (sheet) sheet.close(); return; }
  const d = data.get(curHost());
  if (!d || (!d.loading && Date.now() - d.at > 60000)) void refreshIssues();
  draw();
}
// 배치(2026-10-07 사용자 확정) — CodingPT 의 장소 규칙을 따른다(진행 현황·자동화와 같은 뼈대):
//   타이틀바 = 제목 + 오른쪽 아이콘 동작(새 이슈 · 새로고침)       ← .tv-top / .tv-ic
//   도구 줄  = [출처 세그][상태 세그] ………… [검색][워크스페이스][보기 세그]   ← 한 줄(좁으면 두 줄로 접힌다)
//   본문     = 목록 · 보드 · 표(테두리 두른 카드로 감싸지 않는다 — 면은 장소 바탕 그대로)
//  세그는 설정의 세그먼트(.scale-seg/.scale-opt)를 그대로 쓴다: 선택 = 한 칸 올라온 무채색 면.
const SRC_ICON = { all: () => icons.layers({ size: 13 }), codingpt: () => icons.tasksList({ size: 13 }), github: () => icons.github({ size: 13 }) };
const STATE_CHIPS = [["open", "열린 이슈"], ["todo", "할 일"], ["in_progress", "진행 중"], ["in_review", "리뷰 중"], ["done", "완료"], ["all", "전체"]];
const VIEW_ICON = { list: () => icons.viewList({ size: 13 }), board: () => icons.viewBoard({ size: 13 }), table: () => icons.viewTable({ size: 13 }) };
const VIEW_TEXT = { list: "목록", board: "보드", table: "표" };
function draw() {
  const h = curHost();
  const d = data.get(h) || { issues: [], sources: [] };
  const srcs = sourceOptions(d.issues, d.sources);
  if (!srcs.includes(pref.source)) pref.source = "all";
  if (!STATE_CHIPS.some(([k]) => k === pref.state)) pref.state = "open";
  const wss = wsOpts(h, "");
  if (pref.cwd && !wss.some((w) => w.cwd === pref.cwd)) pref.cwd = "";
  const sig = JSON.stringify([pref.view, pref.source, pref.cwd, pref.state, srcs, wss, i18n.getLang(), state.sidebarCollapsed]);
  if (sig !== topSig || !el.querySelector(".tv-top")) {
    topSig = sig;
    //  고르는 것은 전부 드롭다운이다(2026-10-07 사용자 확정) — 누르면 목록이 나온다. 셀렉트는 작업 시트와 같은 것(.tk-input).
    const sel = (key, items, cur) => `<select class="tk-input is-sel" data-pref="${key}">${items.map(([v, n]) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
    el.innerHTML =
      `<div class="tv-top"><span class="tv-title">Tasks</span><span class="is-grow"></span>` +
      `<button class="ic-btn tv-ic" data-act="refresh" title="${esc(t("새로고침"))}">${icons.refresh({ size: 14 })}</button>` +
      `<button class="ic-btn tv-ic" data-act="new" title="${esc(t("새 이슈"))}">${icons.plus({ size: 15 })}</button></div>` +
      `<div class="is-bar">` +
      sel("source", srcs.map((sv) => [sv, sv === "all" ? t("전체 출처") : (SRC_TEXT[sv] || sv)]), pref.source) +
      sel("state", STATE_CHIPS.map(([k, n]) => [k, t(n)]), pref.state) +
      sel("cwd", [["", t("전체 워크스페이스")], ...wss.map((w) => [w.cwd, w.label])], pref.cwd) +
      `<span class="is-count"></span><span class="is-grow"></span>` +
      `<span class="is-qwrap">${icons.search({ size: 13 })}<input class="tk-input is-q" placeholder="${esc(t("이슈 검색"))}" value="${esc(query)}"></span>` +
      sel("view", VIEWS.map((v) => [v, t(VIEW_TEXT[v])]), pref.view) +
      `</div><div class="is-warn" hidden></div><div class="is-body"></div>`;
  }
  drawBody();
}
/** 상태 칩 → 걸러 보기. "열린 이슈" = 완료가 아닌 것(기본). */
function stateFilter(list) {
  if (pref.state === "all") return list;
  if (pref.state === "open") return list.filter((x) => x.status !== "done");
  return list.filter((x) => x.status === pref.state);
}
function drawBody() {
  const body = el.querySelector(".is-body");
  if (!body) return;
  const h = curHost();
  const d = data.get(h) || { issues: [], sources: [] };
  const warn = el.querySelector(".is-warn");
  const bad = (d.sources || []).filter((s) => !s.ok);
  warn.hidden = !d.error && !bad.length;
  warn.textContent = d.error ? errText(d.error) : bad.map((s) => `${SRC_TEXT[s.provider] || s.provider} · ${wsName(h, s.cwd)}: ${errText(s.error)}`).join("  /  ");
  const base = filterIssues(d.issues, { source: pref.source, cwd: pref.cwd, q: query, done: true });
  const list = stateFilter(base);
  const cnt = el.querySelector(".is-count");
  if (cnt) cnt.textContent = String(pref.view === "board" ? base.length : list.length);
  if (!list.length && pref.view !== "board") {
    body.className = "is-body";
    body.innerHTML = `<div class="tv-detail-empty">${esc(d.loading && !d.at ? t("불러오는 중…") : t("이슈가 없어요"))}<div class="is-empty-sub">${esc(t("할 일을 적어 두고, 준비되면 에이전트에게 시작시키세요."))}</div></div>`;
    return;
  }
  if (pref.view === "board") {
    body.className = "is-body board";
    //  보드는 열 자체가 상태다 — 상태 칩은 적용하지 않는다(네 열을 항상 다 보인다).
    body.innerHTML = groupByStatus(base, { order: STATUSES, keepEmpty: true })
      .map((g) => `<div class="is-col" data-status="${g.status}"><div class="is-col-h">${stGlyph(g.status)}<span>${esc(t(ST_TEXT[g.status]))}</span><span class="is-n">${g.items.length}</span></div>` +
        `<div class="is-col-b">${(g.status === "done" ? g.items.slice(0, 30) : g.items).map((x) => cardHtml(h, x)).join("")}</div></div>`).join("");
    return;
  }
  if (pref.view === "table") {
    const cols = [["key", "번호"], ["title", "제목"], ["status", "상태"], ["priority", "우선순위"], ["source", "출처"], ["cwd", "워크스페이스"], ["updatedAt", "바뀐 때"]];
    const rows = sortTable(list, pref.sort, pref.dir);
    body.className = "is-body table";
    body.innerHTML = `<table class="is-table"><thead><tr>${cols.map(([k, n]) => `<th data-sort="${k}">${esc(t(n))}${pref.sort === k ? (pref.dir === 1 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((x) => `<tr class="is-tr" data-id="${esc(x.id)}"><td class="is-key">${esc(x.key)}</td><td class="is-td-title${x.title ? "" : " blank"}">${esc(titleOf(x))}</td>` +
        `<td><span class="is-cellst">${stGlyph(x.status)}${esc(t(ST_TEXT[x.status]))}</span></td><td>${priChip(x)}</td><td>${esc(SRC_TEXT[x.source.provider] || x.source.provider)}</td>` +
        `<td>${esc(wsName(h, x.cwd))}</td><td class="is-when">${x.updatedAt ? new Date(x.updatedAt).toLocaleDateString(i18n.getLang()) : ""}</td></tr>`).join("") + `</tbody></table>`;
    return;
  }
  body.className = "is-body list";
  body.innerHTML = groupByStatus(list).map((g) => `<div class="is-group"><div class="is-group-h">${esc(t(ST_TEXT[g.status]))}<span class="is-n">${g.items.length}</span></div>${g.items.map((x) => rowHtml(h, x)).join("")}</div>`).join("");
}

function onClick(e) {
  const seg = e.target.closest?.("[data-view]");
  if (seg) { pref.view = seg.dataset.view; savePref(); draw(); return; }
  const src = e.target.closest?.("[data-source]");
  if (src) { pref.source = src.dataset.source; savePref(); draw(); return; }
  const chip = e.target.closest?.("[data-state]");
  if (chip) { pref.state = chip.dataset.state; savePref(); draw(); return; }
  const a = e.target.closest?.("[data-act]");
  if (a) { const k = a.dataset.act; if (k === "refresh") void refreshIssues({ fresh: true }); else openSheet(null); return; }
  const th = e.target.closest?.("th[data-sort]");
  if (th) { if (pref.sort === th.dataset.sort) pref.dir = -pref.dir; else { pref.sort = th.dataset.sort; pref.dir = 1; } savePref(); drawBody(); return; }
  const row = e.target.closest?.("[data-id]");
  if (row) { const x = (data.get(curHost())?.issues || []).find((y) => y.id === row.dataset.id); if (x) openSheet(x); }
}

// ── 상세·새 이슈 시트 ─────────────────────────────────────────────────────────
//  자동 저장이다(2026-10-08 사용자 요청) — 만들기·저장·취소 버튼이 없다. 규칙은 issues-autosave.js(순수) 가 쥔다:
//   새 이슈는 제목·본문에 뜻 있는 첫 입력이 들어올 때 진짜 이슈가 되고, 그 뒤로는 바뀐 칸만 조용히 저장된다.
//   창을 닫는 것은 "그만 본다" 일 뿐이다 — 적은 것은 남는다. 지우려면 [삭제] 를 누른다.
const lingering = new Map();              // 닫힌 뒤에도 저장이 덜 끝난 것(오프라인 등) — id | "new" → { saver, h }
const DRAFT_KEY = "cpt.issues.draft";     // 아직 이슈가 못 된 새 초안(만들기가 실패한 채 앱이 꺼져도 남는다)
const readDraft = (h) => { try { const j = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); return j && Number(j.h) === Number(h) && j.fields && !isBlank(j.fields) ? j.fields : null; } catch (_) { return null; } };
const writeDraft = (h, f) => { try { if (f && !isBlank(f)) localStorage.setItem(DRAFT_KEY, JSON.stringify({ h, fields: f, at: Date.now() })); else localStorage.removeItem(DRAFT_KEY); } catch (_) { /* 저장 못 해도 화면은 돈다 */ } };
/** 받은 이슈 하나를 목록 사본에 곧바로 반영(다시 읽기 전에 화면이 먼저 따라간다). */
function patchLocal(h, issue, removedId) {
  const d = data.get(h);
  if (!d) return;
  if (removedId) d.issues = d.issues.filter((y) => y.id !== removedId);
  if (issue) d.issues = d.issues.some((y) => y.id === issue.id) ? d.issues.map((y) => (y.id === issue.id ? issue : y)) : [issue, ...d.issues];
  if (state.view === "issues" && el && !el.hidden) drawBody();
}
/** 자동 저장이 부르는 RPC 두 개. 제목 없는 초안을 모르는 옛 데몬(BAD_PARAMS)에는 보이는 제목을 대신 적어 보낸다. */
function saverRpc(h, ext) {
  const send = async (method, params) => {
    try { return await orchRpc(method, params, h, 45000); } catch (e) {
      if (!(e && e.code === "BAD_PARAMS") || params.title !== "" || ext) throw e;
      return orchRpc(method, { ...params, title: displayTitle(params, t("제목 없음")) }, h, 45000);
    }
  };
  const done = (r) => { if (!r || !r.issue) throw new Error("NO_ISSUE"); patchLocal(h, r.issue); return { id: r.issue.id, rev: r.issue.updatedAt || 0, issue: r.issue }; };
  return {
    create: async (f) => done(await send("orch.issueCreate", { ...f, provider: "codingpt", draft: true })),
    update: async (id, patch) => done(await send("orch.issueUpdate", { id, ...patch })),
  };
}
/** 앱을 다시 켰을 때 — 이슈가 못 된 초안이 남아 있으면 조용히 이슈로 만든다(열면 목록에 있다). */
function resumeDraft(h) {
  const f = readDraft(h);
  if (!f || sheet || lingering.has("new")) return;
  const rpc = saverRpc(h, false);
  const saver = createAutosaver({ fields: f, create: rpc.create, update: rpc.update,
    onStatus: (s) => { if (s === "saved") { saver.dispose(); lingering.delete("new"); } }, onCreated: () => writeDraft(h, null) });
  lingering.set("new", { saver, h });
  saver.set(f);
  void saver.flush();
}

function openSheet(issue) {
  if (sheet) sheet.close();
  const h = curHost();
  const d = data.get(h) || { sources: [] };
  const ghCwds = new Set((d.sources || []).filter((s) => s.provider === "github" && s.ok).map((s) => s.cwd));
  const ext = !!issue && issue.source.provider !== "codingpt";
  const activeCwd = (state.activeWsId && (state.workspaces.find((w) => w.id === state.activeWsId) || {}).localPath) || "";
  const x0 = issue || { title: "", body: "", status: "todo", priority: "none", labels: [], attachments: [], cwd: pref.cwd || (isSeatOrWorktree(activeCwd) ? "" : activeCwd) };
  //  닫힌 뒤에도 저장이 덜 끝난 것이 있으면 그 글을 이어받는다(같은 이슈를 둘이 저장하지 않게 옛 것은 거둔다).
  //  단, 새 초안을 **만드는 중**이면 그대로 둔다 — 거두고 이어받으면 같은 글의 이슈가 둘 생긴다(그 초안은 곧 목록에 나온다).
  let held = lingering.get(issue ? issue.id : "new");
  const making = !issue && held && held.saver.status() === "saving";
  if (making) held = null;
  if (held) { held.saver.dispose(); lingering.delete(issue ? issue.id : "new"); }
  const carry = held && Number(held.h) === h ? held.saver.fields() : (issue || making ? null : readDraft(h));
  const init = normFields(carry ? { ...x0, ...carry } : x0);
  let cur = issue || null;                  // 지금 이 창이 고치는 이슈(새 이슈는 만들어진 뒤에 생긴다)
  let createdHere = false;
  let closed = false; let deleted = false;
  let busy = false;

  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet is-sheet";
  const opt = (list, c, text) => list.map((v) => `<option value="${esc(v)}"${v === c ? " selected" : ""}>${esc(text(v))}</option>`).join("");
  const startAgent = (pref.start && pref.start.agent) || "claude";
  const startMode = (pref.start && pref.start.mode) || "task";
  const field = (label, html) => `<label class="is-prop"><span class="is-prop-l">${esc(t(label))}</span>${html}</label>`;
  //  창 = 머리줄(번호 + 제목 — 여기서 바로 고친다 + 저장 표시) / 왼쪽 편집기(가득) / 오른쪽 속성 · 시작 · 삭제.
  //  새 이슈에서는 번호·시작·삭제가 숨어 있다가, 이슈가 만들어지면(첫 입력) 나타난다.
  box.innerHTML =
    `<div class="is-sh-head"><span class="is-key"${cur ? "" : " hidden"}>${esc(cur ? cur.key : "")}</span>` +
    `<div class="is-title"><button type="button" class="is-title-t" data-s="title" title="${esc(t("제목 고치기"))}"></button>` +
    `<input class="is-f-title" placeholder="${esc(t("제목"))}" hidden></div>${cur ? srcChip(cur) : ""}` +
    `<span class="is-save" aria-live="polite"></span>` +
    (ext && cur.source.url ? `<button class="tv-btn ghost" data-s="ext">${esc(t("원본 열기"))}</button>` : "") +
    `<button class="ic-btn" data-s="close" title="${esc(t("닫기"))}">${icons.x({ size: 14 })}</button></div>` +
    `<div class="is-sh-main"><div class="is-sh-doc"><div class="is-f-ed"></div><div class="is-atts"></div></div>` +
    `<aside class="is-sh-side">` +
    field("상태", `<select class="tk-input is-f-status" data-f="status">${opt(STATUSES, init.status, (v) => t(ST_TEXT[v]))}</select>`) +
    field("우선순위", `<select class="tk-input is-f-pri" data-f="priority">${opt(["none", "low", "medium", "high", "urgent"], init.priority, (v) => t(PRI_TEXT[v]))}</select>`) +
    field("워크스페이스", `<select class="tk-input is-f-cwd" data-f="cwd"${ext ? " disabled" : ""}></select>`) +
    (ext ? "" : field("라벨(쉼표로 구분)", `<input class="tk-input is-f-labels" value="${esc(init.labels)}">`)) +
    `<span class="is-grow"></span>` +
    `<div class="is-start"${cur ? "" : " hidden"}><span class="is-start-h">${esc(t("이 이슈로 시작"))}</span>` +
    `<select class="tk-input is-s-mode">${opt(["task", "terminal", "orch"], startMode, (v) => t(MODE_TEXT[v]))}</select>` +
    `<select class="tk-input is-s-agent">${opt(["claude", "codex", "gemini"], startAgent, (v) => agentName(v) || v)}</select>` +
    `<button class="tv-btn is-go" data-s="start">${esc(t("시작"))}</button>` +
    (cur && cur.link ? `<button class="tv-btn ghost" data-s="goto">${esc(t("진행 중인 일 보기"))}</button>` : "") + `</div>` +
    (ext ? "" : `<div class="is-acts"${cur ? "" : " hidden"}><button class="tv-btn ghost is-del" data-s="del">${esc(t("삭제"))}</button><span class="is-grow"></span>` +
      `<button class="tv-btn ghost is-to-gh" data-s="togh" hidden>${esc(t("GitHub 이슈로 만들기"))}</button></div>`) +
    `</aside></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const q = (s) => box.querySelector(s);
  const cwdSel = q(".is-f-cwd");
  const fillCwd = (c) => { cwdSel.innerHTML = `<option value="">${esc(t("정하지 않음"))}</option>` + wsOpts(h, c).map((w) => `<option value="${esc(w.cwd)}"${w.cwd === c ? " selected" : ""}>${esc(w.label)}</option>`).join(""); };
  fillCwd(init.cwd);

  // ── 저장 ── 표시는 머리줄의 작은 글자 하나(토스트를 띄우지 않는다).
  const saveEl = q(".is-save");
  const SAVE_TEXT = { idle: "", dirty: "저장 중…", saving: "저장 중…", saved: "저장됨", error: "저장하지 못했어요 · 다시 시도 중" };
  const rpc = saverRpc(h, ext);
  const lingerKey = () => saver.id() || "new";
  const saver = createAutosaver({
    id: cur ? cur.id : null, fields: issue ? issue : x0, rev: issue ? issue.updatedAt : 0,
    keys: ext ? ["title", "body", "status", "priority"] : undefined, delay: ext ? SAVE_DELAY_EXT_MS : undefined,
    create: async (f) => { const r = await rpc.create(f); cur = r.issue; return r; },
    update: async (id, patch) => { const r = await rpc.update(id, patch); cur = r.issue; return r; },
    onCreated: () => { createdHere = true; writeDraft(h, null); },
    onStatus: (s) => {
      if (closed) { if (s === "saved") { saver.dispose(); for (const [k, v] of lingering) if (v.saver === saver) lingering.delete(k); } return; }
      saveEl.textContent = SAVE_TEXT[s] ? t(SAVE_TEXT[s]) : "";
      saveEl.classList.toggle("error", s === "error");
      if (s === "saved") reveal();
    },
  });
  /** 이슈가 생겼다 — 번호·시작·삭제를 보인다. */
  function reveal() {
    const id = saver.id();
    if (!id) return;
    if (cur) { const k = q(".is-key"); k.textContent = cur.key; k.hidden = false; }
    q(".is-start").hidden = false;
    if (q(".is-acts")) q(".is-acts").hidden = false;
    syncGh();
  }
  const syncGh = () => { const b = q(".is-to-gh"); if (b) b.hidden = !(saver.id() && ghCwds.has(cwdSel.value)); };
  /** 칸이 바뀌었다 → 자동 저장에 알린다. now = 기다리지 않고 곧바로(고르는 칸·칸에서 나갈 때). */
  const put = (patch, now) => {
    saver.set(patch);
    if (!saver.id()) writeDraft(h, saver.fields());
    if (now) void saver.flush();
  };

  // ── 첨부 ── 이미지는 본문 안에 그대로 그린다(편집기). 그 밖의 파일은 본문 아래 이름표로 둔다.
  //  첨부는 이슈에 붙는다 — 새 이슈면 먼저 이슈를 만든다(적은 것이 없어도).
  let atts = (x0.attachments || []).slice();
  let attRev = (issue && issue.updatedAt) || 0;   // 내가 아는 첨부 목록의 때 — 이보다 오래된 사본(늦게 온 목록)은 받지 않는다
  const IMG_RE = /\.(png|jpe?g|gif|webp|heic|svg)$/i;
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
  const thumbs = new Map();   // 경로 → blob URL
  async function urlOf(absPath) {
    if (thumbs.has(absPath)) return thumbs.get(absPath);
    let url = "";
    try {
      const home = String(await api.fsAbs("") || "").replace(/\/+$/, "");
      const r = home && absPath.startsWith(home + "/") ? await api.fsReadBytes(absPath.slice(home.length + 1)) : null;
      let raw = r && (typeof r === "string" ? r : r.base64 || r.b64 || r.data || "");
      if (!raw && api.filePreviewB64) raw = await api.filePreviewB64(absPath).catch(() => "");
      if (raw) { const bin = atob(raw); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); url = URL.createObjectURL(new Blob([u8])); }
    } catch (_) { url = ""; }
    thumbs.set(absPath, url);
    return url;
  }
  const pathOfAtt = (id) => { const a = atts.find((y) => y.id === id); return a ? a.path : ""; };
  async function clipFiles() {
    let paths = [];
    try { paths = await api.clipboardPaths(); } catch (_) { paths = []; }
    if (!Array.isArray(paths) || !paths.length) { let img = null; try { img = await api.clipboardImagePng(); } catch (_) { img = null; } paths = img ? [img] : []; }
    return paths;
  }
  const editor = createRichEditor({
    value: init.body, t,
    resolveImage: (id) => { const pth = pathOfAtt(id); return pth ? urlOf(pth) : Promise.resolve(""); },
    onPaste: async () => { const paths = await clipFiles(); if (!paths.length) return false; await addFiles(paths); return true; },
    //  도구 줄의 첨부 버튼 — 클립보드에 있는 것을 붙인다(없으면 방법을 알려 준다. 파일 고르기 창은 웹뷰가 경로를 주지 않는다).
    onAttach: async () => { const paths = await clipFiles(); if (paths.length) await addFiles(paths); else toast(t("이미지·파일을 붙여넣거나(⌘V) 이 창에 끌어다 놓으면 첨부됩니다")); },
    onOpenLink: (href) => { if (href) api.openExternal(href).catch(() => {}); },
  });
  q(".is-f-ed").appendChild(editor.el);
  //  이 창에서 본문에 있던(또는 넣은) 그림 — 닫을 때 본문에서 사라졌으면 첨부에서도 뺀다(처음부터 자리가 없던 첨부는 건드리지 않는다).
  const seenImgs = new Set(editor.imageIds());
  //  본문은 **손댄 적이 있을 때만** 편집기에서 읽는다 — 열었다 닫기만 해도 마크다운이 다시 써지며 "저장" 되는 일을 막는다.
  let bodyTouched = false;
  const bodyChanged = (now) => { if (bodyTouched) { put({ body: editor.getMarkdown() }, now); if (!titleVal) paintTitle(); } else if (now) void saver.flush(); };
  //  한글 조합 중의 input 은 건너뛴다 — 음절이 확정될 때(compositionend) 한 번 읽는다. 칸에 값을 되쓰는 일은 없다.
  editor.el.addEventListener("input", (e) => { bodyTouched = true; if (!e.isComposing) bodyChanged(false); });
  editor.el.addEventListener("compositionend", () => setTimeout(() => { bodyTouched = true; bodyChanged(false); }, 0));
  editor.el.addEventListener("focusout", () => { bodyChanged(true); pullDeferred(); });
  function drawAtts() {
    const files = atts.filter((a) => !a.image);
    q(".is-atts").innerHTML = files.map((a) => `<div class="is-att" title="${esc(a.name)}"><span class="is-att-ic">${icons.file({ size: 14 })}</span>` +
      `<span class="is-att-nm">${esc(a.name)}</span><button class="is-att-x" data-s="unatt" data-att="${esc(a.id)}" title="${esc(t("첨부 빼기"))}">${icons.x({ size: 11 })}</button></div>`).join("");
  }
  async function addFiles(paths) {
    for (const pth of (paths || []).filter(Boolean)) {
      const id = await saver.ensureCreated();
      if (!id) { toast(errText("DAEMON_OFFLINE")); return; }
      const a = { id: newId(), path: pth, name: pth.split("/").pop() || "file", image: IMG_RE.test(pth) };
      const r = await act("orch.issueAttach", { id, path: pth, attId: a.id });
      if (!r || !r.issue || closed) continue;
      atts = r.issue.attachments || []; attRev = r.issue.updatedAt || attRev;
      if (a.image) { seenImgs.add(a.id); editor.insertImage(a, await urlOf(pathOfAtt(a.id) || pth)); bodyTouched = true; bodyChanged(true); }
      drawAtts();
    }
  }
  dropHook = (paths) => { void addFiles(paths); };   // OS 에서 끌어다 놓은 파일(os-drop.js 가 넘긴다)
  drawAtts();

  // ── 제목 ── 글자 ↔ 입력칸. 비어 있으면 본문 첫 줄(없으면 "제목 없음")을 흐리게 보인다.
  const titleIn = q(".is-f-title"); const titleBtn = q(".is-title-t");
  let titleVal = init.title; let titleBefore = titleVal;
  const paintTitle = () => { titleBtn.textContent = titleVal || displayTitle({ body: saver.fields().body }, t("제목 없음")); titleBtn.classList.toggle("blank", !titleVal); };
  const editTitle = () => { titleBefore = titleVal; titleBtn.hidden = true; titleIn.hidden = false; titleIn.value = titleVal; inputUndo.reset(titleIn); titleIn.focus(); titleIn.select(); };
  const endTitle = (keep) => {
    if (titleIn.hidden) return;
    const v = titleIn.value.trim();
    //  외부 이슈는 제목을 비울 수 없다 — 비워 두고 나가면 고치기 전 제목으로 돌아간다.
    titleVal = keep && (v || !ext) ? v : titleBefore;
    titleIn.hidden = true; titleBtn.hidden = false;
    put({ title: titleVal }, true);
    paintTitle();
  };
  titleIn.addEventListener("input", (e) => { if (!e.isComposing && (titleIn.value.trim() || !ext)) put({ title: titleIn.value }, false); });
  titleIn.addEventListener("compositionend", () => setTimeout(() => { if (!titleIn.hidden && (titleIn.value.trim() || !ext)) put({ title: titleIn.value }, false); }, 0));
  titleIn.addEventListener("blur", () => { if (!inputUndo.holding(titleIn)) { endTitle(true); pullDeferred(); } });
  const inputUndo = attachInputUndo(box);   // 제목·라벨·링크 칸의 ⌘Z (본문은 편집기가 제 기록으로 한다)
  paintTitle();
  // ── 속성 ── 고르면 곧 저장.
  box.addEventListener("change", (e) => { const k = e.target.dataset?.f; if (!k) return; put({ [k]: e.target.value }, true); if (k === "cwd") syncGh(); });
  const labelsIn = q(".is-f-labels");
  if (labelsIn) {
    labelsIn.addEventListener("input", (e) => { if (!e.isComposing) put({ labels: labelsIn.value }, false); });
    labelsIn.addEventListener("compositionend", () => setTimeout(() => put({ labels: labelsIn.value }, false), 0));
    labelsIn.addEventListener("blur", () => { put({ labels: labelsIn.value }, true); pullDeferred(); });
  }
  syncGh();

  // ── 다른 기기에서 고친 것 ── 목록을 다시 읽을 때마다 받아, 내가 고치는 중이 아닌 칸만 따라간다.
  const editing = () => {
    const a = document.activeElement; const out = [];
    if (!titleIn.hidden) out.push("title");
    if (a && editor.el.contains(a)) out.push("body");
    if (a && a === labelsIn) out.push("labels");
    return out;
  };
  function applyRemote(keys) {
    if (!keys.length) return;
    const f = saver.fields();
    for (const k of keys) {
      if (k === "title") titleVal = f.title;
      else if (k === "body") editor.setMarkdown(f.body);
      else if (k === "status") q(".is-f-status").value = f.status;
      else if (k === "priority") q(".is-f-pri").value = f.priority;
      else if (k === "cwd") fillCwd(f.cwd);
      else if (k === "labels" && labelsIn) labelsIn.value = f.labels;
    }
    paintTitle(); syncGh();
  }
  const pullDeferred = () => { if (!closed) applyRemote(saver.mergeRemote(null, editing())); };
  function onRemote() {
    const id = saver.id();
    const r = id && (data.get(h)?.issues || []).find((y) => y.id === id);
    if (!r || closed) return;
    if ((r.updatedAt || 0) > attRev) { attRev = r.updatedAt; atts = (r.attachments || []).slice(); drawAtts(); }   // 본문의 새 그림이 경로를 찾게 먼저
    applyRemote(saver.mergeRemote(r, editing()));
  }

  // ── 닫기 ── 화면은 곧바로 닫고, 남은 저장은 뒤에서 끝낸다.
  const onAway = () => { if (!closed) void saver.flush(); };   // 창이 뒤로 갔다(다른 앱·다른 창) — 곧바로 저장
  window.addEventListener("blur", onAway);
  document.addEventListener("visibilitychange", onAway);
  async function finalize() {
    const r = await saver.flush();
    const id = r.id;
    if (id && r.ok) {
      const f = saver.fields();
      //  이 창에서 만들었는데 끝내 아무것도 안 남겼으면(적었다가 다 지움) 빈 이슈를 남기지 않는다.
      if (createdHere && isBlank(f) && !atts.length) { try { await orchRpc("orch.issueDelete", { id }, h, 45000); patchLocal(h, null, id); } catch (_) { /* 남으면 목록에서 지울 수 있다 */ } }
      else for (const a of atts.filter((y) => y.image && seenImgs.has(y.id) && !f.body.includes(`(att:${y.id})`))) { try { await orchRpc("orch.issueDetach", { id, attId: a.id }, h, 45000); } catch (_) { /* 첨부로 남는다 */ } }
    }
    if (r.ok) { saver.dispose(); if (!id) writeDraft(h, null); }
    else { lingering.set(lingerKey(), { saver, h }); toast(t("저장하지 못했어요 · 다시 시도 중")); }   // 입력은 쥐고 있다 — 연결되면 저장된다
    for (const u of thumbs.values()) { if (u) URL.revokeObjectURL(u); }
  }
  const close = () => {
    if (closed) return;
    if (!deleted) { endTitle(true); bodyChanged(false); }
    closed = true;
    overlay.remove(); document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onAway); document.removeEventListener("visibilitychange", onAway);
    sheet = null; dropHook = null;
    if (deleted) { saver.dispose(); for (const u of thumbs.values()) { if (u) URL.revokeObjectURL(u); } } else void finalize();
  };
  const onKey = (e) => {
    if (e.target === titleIn && !e.isComposing) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endTitle(false); editor.focus(); return; }
      if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); endTitle(true); editor.focus(); return; }
    }
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-s]");
    if (!b) return;
    const k = b.dataset.s;
    if (k === "title") { editTitle(); return; }
    if (k === "close") { close(); return; }
    if (k === "ext") { api.openExternal(cur.source.url).catch(() => {}); return; }
    if (k === "unatt") {
      const id = b.dataset.att;
      const r = await act("orch.issueDetach", { id: saver.id(), attId: id });
      if (r && r.issue) { atts = r.issue.attachments || []; attRev = r.issue.updatedAt || attRev; }
      editor.removeImage(id); bodyTouched = true; bodyChanged(true);
      drawAtts();
      return;
    }
    if (k === "del") {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = t("한 번 더 누르면 삭제"); return; }   // 브라우저 confirm 을 띄우지 않는다(웹뷰를 멈춘다)
      await saver.flush();   // 저장 중인 요청이 지운 뒤에 도착해 되살리지 않게, 먼저 끝낸다
      if (await act("orch.issueDelete", { id: saver.id() }, t("삭제했어요"))) { deleted = true; saver.dispose(); patchLocal(h, null, saver.id()); close(); }
      return;
    }
    if (k === "goto") { close(); goTo(h, cur.link); return; }
    if (k === "togh") {
      //  밖(GitHub)에 글을 올리는 일이라 자동으로 하지 않는다 — 누를 때만. 올린 뒤 이 PC 의 초안은 지운다(첨부는 옮겨 붙인다).
      if (busy) return;
      endTitle(true); bodyChanged(false);
      const f = saver.fields();
      if (!f.title) { editTitle(); return; }   // GitHub 이슈는 제목이 있어야 한다
      busy = true; b.disabled = true;
      const s1 = await saver.flush();
      const r = s1.ok ? await act("orch.issueCreate", { ...f, provider: "github" }, t("이슈를 만들었어요")) : null;
      if (r && r.issue) {
        for (const a of atts) await act("orch.issueAttach", { id: r.issue.id, path: a.path, attId: a.id, name: a.name });
        saver.dispose();
        if (await act("orch.issueDelete", { id: s1.id })) patchLocal(h, null, s1.id);
        deleted = true; close();
        return;
      }
      busy = false; b.disabled = false;
      return;
    }
    if (k === "start") {
      if (busy) return;
      const mode = q(".is-s-mode").value; const agent = q(".is-s-agent").value;
      const cwd = cwdSel.value || (cur && cur.cwd) || "";
      if (!cwd) { toast(t("어느 워크스페이스에서 시작할지 골라 주세요")); cwdSel.focus(); return; }
      pref.start = { mode, agent }; savePref();
      //  방금 고친 글로 시작해야 한다 — 먼저 끝까지 저장한다(창은 그대로).
      endTitle(true); bodyChanged(false);
      busy = true; b.disabled = true;
      const s1 = await saver.flush();
      const r = s1.ok && s1.id ? await act("orch.issueStart", { id: s1.id, mode, agent, cwd }, t("시작했어요")) : (toast(errText("")), null);
      busy = false; b.disabled = false;
      if (r && r.started) { close(); goTo(h, { ...r.started, cwd }); }
    }
  });
  sheet = { close, onRemote };
  //  이어받은 글(닫힌 뒤 저장이 덜 끝난 것·만들지 못한 초안)은 다시 저장 줄에 세운다.
  if (carry) put(carry, false);
  if (saver.id()) reveal();
  //  새 이슈는 제목부터 적는다(Enter 로 본문으로 넘어간다). 있던 이슈는 본문에서 시작한다.
  setTimeout(() => { if (closed) return; if (!issue && !init.title) editTitle(); else editor.focus(); }, 30);
}
/** 시작한 일로 간다 — 작업이면 그 작업 상세, 터미널이면 그 워크스페이스의 그 터미널. */
function goTo(h, link) {
  if (!link) return;
  if (link.taskId) { openTasksDashboard({ taskId: link.taskId, host: h }); return; }
  const w = wsAll(h).find((y) => y.localPath === link.cwd);
  if (w && link.tid != null) void openRunTerminal(w.id, link.tid);
}
