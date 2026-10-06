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
import { STATUSES, VIEWS, filterIssues, groupByStatus, sortIssues, sortTable, sourceOptions, openCount } from "./issues-model.js";

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

/** 입력칸의 ⌘Z / ⇧⌘Z / ⌘Y — 앱 메뉴에 Undo/Redo 가 없어 웹뷰가 대신 해 주지 않는다(주소창·편집기와 같은 처리). 처리했으면 true. */
function undoKey(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k !== "z" && !(k === "y" && !e.shiftKey)) return false;
  const tg = e.target;
  if (!tg || !(tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable)) return false;
  e.preventDefault(); e.stopPropagation();
  document.execCommand(k === "y" || e.shiftKey ? "redo" : "undo");
  return true;
}
const curHost = () => Number(S.activeDeviceId());
const wsList = (h) => S.workspacesForDevice(h).filter((w) => w.localPath);
const wsName = (h, cwd) => { const w = wsList(h).find((x) => x.localPath === cwd); return w ? w.name : (cwd ? cwd.split("/").pop() : ""); };

export function issuesSnapshot(host) { return data.get(Number(host)) || null; }
/** 연결된 외부 서비스(이슈를 읽어 온 것) — 사이드바 이슈 행의 표식. */
export function issuesProviders(host) { const d = data.get(Number(host)); return d ? [...new Set((d.sources || []).filter((x) => x.ok && x.provider !== "codingpt").map((x) => x.provider))] : []; }
export function issuesOpenCount(host) { const d = data.get(Number(host)); return d ? openCount(d.issues) : 0; }

export async function refreshIssues({ fresh = false } = {}) {
  const h = curHost();
  if (!Number.isFinite(h) || h <= 0) return;
  const cur = data.get(h) || { issues: [], sources: [], at: 0, error: null };
  if (cur.loading) return;
  cur.loading = true; data.set(h, cur);
  try {
    const r = await orchRpc("orch.issueList", { cwds: wsList(h).map((w) => w.localPath), fresh }, h, 45000);
    data.set(h, { issues: (r && r.issues) || [], sources: (r && r.sources) || [], at: Date.now(), error: null, loading: false });
  } catch (e) {
    data.set(h, { ...cur, error: (e && e.code) || "ERROR", loading: false });
  }
  S.emit();
}
/** ui_command orch.changed(reason=issues) — 열려 있을 때만 다시 읽는다(닫혀 있으면 열 때 읽는다). */
export function onIssuesChanged() { if (state.view === "issues") void refreshIssues(); else { const d = data.get(curHost()); if (d) d.at = 0; } }

export function openIssues() {
  S.setView("issues");
  void refreshIssues();
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
    `<span class="is-title">${esc(x.title)}</span>${linkMark(x)}${priChip(x)}${(x.labels || []).slice(0, 3).map((l) => `<span class="is-label">${esc(l)}</span>`).join("")}${srcChip(x)}` +
    `<span class="is-ws">${esc(wsName(h, x.cwd))}</span></button>`;
}
function cardHtml(h, x) {
  return `<div class="is-card" draggable="true" data-id="${esc(x.id)}"><div class="is-card-top"><span class="is-key">${esc(x.key)}</span>${linkMark(x)}${priChip(x)}${srcChip(x)}</div>` +
    `<div class="is-card-title">${esc(x.title)}</div><div class="is-card-ws">${esc(wsName(h, x.cwd))}</div></div>`;
}

export function mountIssuesView(container) {
  el = container;
  el.className = "issues-view tasks-view";
  el.tabIndex = 0;
  el.addEventListener("keydown", (e) => { if (undoKey(e)) return; if (e.key === "Escape" && !sheet) closeIssues(); });
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
  const wss = wsList(h);
  if (pref.cwd && !wss.some((w) => w.localPath === pref.cwd)) pref.cwd = "";
  const sig = JSON.stringify([pref.view, pref.source, pref.cwd, pref.state, srcs, wss.map((w) => [w.localPath, w.name]), i18n.getLang(), state.sidebarCollapsed]);
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
      sel("cwd", [["", t("전체 워크스페이스")], ...wss.map((w) => [w.localPath, w.name])], pref.cwd) +
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
      rows.map((x) => `<tr class="is-tr" data-id="${esc(x.id)}"><td class="is-key">${esc(x.key)}</td><td class="is-td-title">${esc(x.title)}</td>` +
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
function openSheet(issue) {
  if (sheet) sheet.close();
  const h = curHost();
  const wss = wsList(h);
  const isNew = !issue;
  const ext = !isNew && issue.source.provider !== "codingpt";
  const d = data.get(h) || { sources: [] };
  const ghCwds = new Set((d.sources || []).filter((s) => s.provider === "github" && s.ok).map((s) => s.cwd));
  const x = issue || { title: "", body: "", status: "todo", priority: "none", labels: [], attachments: [], cwd: pref.cwd || (state.activeWsId && (state.workspaces.find((w) => w.id === state.activeWsId) || {}).localPath) || "" };
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet is-sheet";
  const opt = (list, cur, text) => list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(text(v))}</option>`).join("");
  const startAgent = (pref.start && pref.start.agent) || "claude";
  const startMode = (pref.start && pref.start.mode) || "task";
  const field = (label, html) => `<label class="is-prop"><span class="is-prop-l">${esc(t(label))}</span>${html}</label>`;
  //  창 = 머리줄(번호 + 제목 — 여기서 바로 고친다) / 왼쪽 편집기(가득) / 오른쪽 속성 · 시작 · 저장.
  //  아래 띠는 없다 — 저장·취소·삭제는 오른쪽 칸 맨 아래에 둔다(2026-10-07 사용자 확정).
  box.innerHTML =
    `<div class="is-sh-head"><span class="is-key">${esc(isNew ? t("새 이슈") : x.key)}</span>` +
    `<input class="is-f-title" placeholder="${esc(t("제목"))}" value="${esc(x.title)}">${isNew ? "" : srcChip(x)}` +
    (ext && x.source.url ? `<button class="tv-btn ghost" data-s="ext">${esc(t("원본 열기"))}</button>` : "") +
    `<button class="ic-btn" data-s="close" title="${esc(t("닫기"))}">${icons.x({ size: 14 })}</button></div>` +
    `<div class="is-sh-main"><div class="is-sh-doc"><div class="is-f-ed"></div><div class="is-atts"></div></div>` +
    `<aside class="is-sh-side">` +
    field("상태", `<select class="tk-input is-f-status">${opt(STATUSES, x.status, (v) => t(ST_TEXT[v]))}</select>`) +
    field("우선순위", `<select class="tk-input is-f-pri">${opt(["none", "low", "medium", "high", "urgent"], x.priority || "none", (v) => t(PRI_TEXT[v]))}</select>`) +
    field("워크스페이스", `<select class="tk-input is-f-cwd"${ext ? " disabled" : ""}><option value="">${esc(t("정하지 않음"))}</option>${wss.map((w) => `<option value="${esc(w.localPath)}"${w.localPath === x.cwd ? " selected" : ""}>${esc(w.name)}</option>`).join("")}</select>`) +
    (ext ? "" : field("라벨(쉼표로 구분)", `<input class="tk-input is-f-labels" value="${esc((x.labels || []).join(", "))}">`)) +
    (isNew ? `<label class="is-f-gh"><input type="checkbox" class="is-f-github">${esc(t("GitHub 이슈로 만들기"))}</label>` : "") +
    `<span class="is-grow"></span>` +
    (isNew ? "" : `<div class="is-start"><span class="is-start-h">${esc(t("이 이슈로 시작"))}</span>` +
      `<select class="tk-input is-s-mode">${opt(["task", "terminal", "orch"], startMode, (v) => t(MODE_TEXT[v]))}</select>` +
      `<select class="tk-input is-s-agent">${opt(["claude", "codex", "gemini"], startAgent, (v) => agentName(v) || v)}</select>` +
      `<button class="tv-btn is-go" data-s="start">${esc(t("시작"))}</button>` +
      (x.link ? `<button class="tv-btn ghost" data-s="goto">${esc(t("진행 중인 일 보기"))}</button>` : "") + `</div>`) +
    `<div class="is-acts">${!isNew && !ext ? `<button class="tv-btn ghost is-del" data-s="del">${esc(t("삭제"))}</button>` : ""}<span class="is-grow"></span>` +
    `<button class="tv-btn ghost" data-s="close">${esc(t("취소"))}</button><button class="tv-btn" data-s="save">${esc(isNew ? t("만들기") : t("저장"))}</button></div>` +
    `</aside></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const q = (s) => box.querySelector(s);
  const ghBox = q(".is-f-github");
  const syncGh = () => { if (!ghBox) return; const ok = ghCwds.has(q(".is-f-cwd").value); ghBox.disabled = !ok; if (!ok) ghBox.checked = false; ghBox.parentElement.classList.toggle("off", !ok); };
  syncGh();
  q(".is-f-cwd").addEventListener("change", syncGh);

  // ── 첨부 ── 이미 올라간 것(atts) + 아직 이슈가 없어 기다리는 것(pending — 만들기 직후에 올린다).
  //  이미지는 본문 안에 그대로 그린다(편집기). 그 밖의 파일은 본문 아래 이름표로 둔다. ID 는 여기서 정해 새 이슈에서도 바로 넣는다.
  let atts = (x.attachments || []).slice();
  const pending = [];   // { id, path, name, image }
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
  const pathOfAtt = (id) => { const a = atts.find((y) => y.id === id) || pending.find((y) => y.id === id); return a ? a.path : ""; };
  async function clipFiles() {
    let paths = [];
    try { paths = await api.clipboardPaths(); } catch (_) { paths = []; }
    if (!Array.isArray(paths) || !paths.length) { let img = null; try { img = await api.clipboardImagePng(); } catch (_) { img = null; } paths = img ? [img] : []; }
    return paths;
  }
  const editor = createRichEditor({
    value: x.body || "", t,
    resolveImage: (id) => { const pth = pathOfAtt(id); return pth ? urlOf(pth) : Promise.resolve(""); },
    onPaste: async () => { const paths = await clipFiles(); if (!paths.length) return false; await addFiles(paths); return true; },
    //  도구 줄의 첨부 버튼 — 클립보드에 있는 것을 붙인다(없으면 방법을 알려 준다. 파일 고르기 창은 웹뷰가 경로를 주지 않는다).
    onAttach: async () => { const paths = await clipFiles(); if (paths.length) await addFiles(paths); else toast(t("이미지·파일을 붙여넣거나(⌘V) 이 창에 끌어다 놓으면 첨부됩니다")); },
    onOpenLink: (href) => { if (href) api.openExternal(href).catch(() => {}); },
  });
  q(".is-f-ed").appendChild(editor.el);
  function drawAtts() {
    const files = [...atts, ...pending].filter((a) => !a.image);
    const host = q(".is-atts");
    host.innerHTML = files.map((a) => `<div class="is-att" title="${esc(a.name)}"><span class="is-att-ic">${icons.file({ size: 14 })}</span>` +
      `<span class="is-att-nm">${esc(a.name)}</span><button class="is-att-x" data-s="unatt" data-att="${esc(a.id)}" title="${esc(t("첨부 빼기"))}">${icons.x({ size: 11 })}</button></div>`).join("");
  }
  async function addFiles(paths) {
    for (const pth of (paths || []).filter(Boolean)) {
      const a = { id: newId(), path: pth, name: pth.split("/").pop() || "file", image: IMG_RE.test(pth) };
      if (isNew) pending.push(a);
      else {
        const r = await act("orch.issueAttach", { id: x.id, path: pth, attId: a.id });
        if (!r || !r.issue) continue;
        atts = r.issue.attachments || [];
      }
      if (a.image) editor.insertImage(a, await urlOf(pathOfAtt(a.id) || pth));
      drawAtts();
    }
  }
  dropHook = (paths) => { void addFiles(paths); };   // OS 에서 끌어다 놓은 파일(os-drop.js 가 넘긴다)
  drawAtts();
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); sheet = null; dropHook = null; for (const u of thumbs.values()) { if (u) URL.revokeObjectURL(u); } };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); return; }
    undoKey(e);
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const fields = () => ({ title: q(".is-f-title").value.trim(), body: editor.getMarkdown(), status: q(".is-f-status").value, priority: q(".is-f-pri").value,
    cwd: q(".is-f-cwd").value, ...(q(".is-f-labels") ? { labels: q(".is-f-labels").value } : {}) });
  let busy = false;
  async function save({ keepOpen = false } = {}) {
    if (busy) return null;
    const f = fields();
    if (!f.title) { q(".is-f-title").focus(); return null; }
    busy = true;
    const r = isNew
      ? await act("orch.issueCreate", { ...f, provider: ghBox && ghBox.checked ? "github" : "codingpt" }, t("이슈를 만들었어요"))
      : await act("orch.issueUpdate", { id: x.id, ...f, ...(ext ? { cwd: undefined } : {}) }, keepOpen ? "" : t("저장했어요"));
    //  새 이슈 — 만든 뒤에 기다리던 첨부를 올린다(본문에 적힌 자리의 ID 는 그대로다).
    if (r && isNew && r.issue) for (const a of pending) await act("orch.issueAttach", { id: r.issue.id, path: a.path, attId: a.id, name: a.name });
    //  본문에서 지운 이미지는 첨부에서도 뺀다(남겨 두면 에이전트에게 "첨부" 로 다시 딸려 간다).
    if (r && !isNew) { const used = new Set(editor.imageIds()); for (const a of atts.filter((y) => y.image && !used.has(y.id))) await act("orch.issueDetach", { id: x.id, attId: a.id }); }
    busy = false;
    if (r && !keepOpen) close();
    return r;
  }
  box.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-s]");
    if (!b) return;
    const k = b.dataset.s;
    if (k === "close") { close(); return; }
    if (k === "save") { void save(); return; }
    if (k === "ext") { api.openExternal(x.source.url).catch(() => {}); return; }
    if (k === "unatt") {
      const id = b.dataset.att;
      const pi = pending.findIndex((a) => a.id === id);
      if (pi >= 0) pending.splice(pi, 1);
      else { const r = await act("orch.issueDetach", { id: x.id, attId: id }); if (r && r.issue) atts = r.issue.attachments || []; }
      editor.removeImage(id);
      drawAtts();
      return;
    }
    if (k === "del") {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = t("한 번 더 누르면 삭제"); return; }   // 브라우저 confirm 을 띄우지 않는다(웹뷰를 멈춘다)
      if (await act("orch.issueDelete", { id: x.id }, t("삭제했어요"))) close();
      return;
    }
    if (k === "goto") { close(); goTo(h, x.link); return; }
    if (k === "start") {
      if (busy) return;
      const mode = q(".is-s-mode").value; const agent = q(".is-s-agent").value;
      const cwd = q(".is-f-cwd").value || x.cwd;
      if (!cwd) { toast(t("어느 워크스페이스에서 시작할지 골라 주세요")); q(".is-f-cwd").focus(); return; }
      pref.start = { mode, agent }; savePref();
      //  방금 고친 글로 시작해야 한다 — 먼저 저장한다(창은 그대로).
      if (!(await save({ keepOpen: true }))) return;
      busy = true; b.disabled = true;
      const r = await act("orch.issueStart", { id: x.id, mode, agent, cwd }, t("시작했어요"));
      busy = false; b.disabled = false;
      if (r && r.started) { close(); goTo(h, { ...r.started, cwd }); }
    }
  });
  sheet = { close };
  setTimeout(() => (isNew ? q(".is-f-title").focus() : editor.focus()), 30);
}
/** 시작한 일로 간다 — 작업이면 그 작업 상세, 터미널이면 그 워크스페이스의 그 터미널. */
function goTo(h, link) {
  if (!link) return;
  if (link.taskId) { openTasksDashboard({ taskId: link.taskId, host: h }); return; }
  const w = wsList(h).find((y) => y.localPath === link.cwd);
  if (w && link.tid != null) void openRunTerminal(w.id, link.tid);
}
