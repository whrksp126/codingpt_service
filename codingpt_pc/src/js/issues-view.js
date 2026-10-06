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
const data = new Map();                   // host → { issues, sources, at, error, loading }
const PREF_KEY = "cpt.issues.pref";
let pref = { view: "list", source: "all", cwd: "", done: false, sort: "updatedAt", dir: -1, start: { mode: "task", agent: "claude" } };
try { pref = { ...pref, ...(JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}) }; } catch (_) { /* 기본값 */ }
if (!VIEWS.includes(pref.view)) pref.view = "list";
let query = "";
const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (_) { /* 저장 못 해도 화면은 돈다 */ } };

const curHost = () => Number(S.activeDeviceId());
const wsList = (h) => S.workspacesForDevice(h).filter((w) => w.localPath);
const wsName = (h, cwd) => { const w = wsList(h).find((x) => x.localPath === cwd); return w ? w.name : (cwd ? cwd.split("/").pop() : ""); };

export function issuesSnapshot(host) { return data.get(Number(host)) || null; }
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
function draw() {
  const h = curHost();
  const d = data.get(h) || { issues: [], sources: [] };
  const srcs = sourceOptions(d.issues, d.sources);
  if (!srcs.includes(pref.source)) pref.source = "all";
  const wss = wsList(h);
  if (pref.cwd && !wss.some((w) => w.localPath === pref.cwd)) pref.cwd = "";
  const sig = JSON.stringify([pref.view, pref.source, pref.cwd, pref.done, srcs, wss.map((w) => [w.localPath, w.name]), i18n.getLang(), state.sidebarCollapsed]);
  if (sig !== topSig || !el.querySelector(".tv-top")) {
    topSig = sig;
    el.innerHTML =
      `<div class="tv-top"><span class="tv-title">${esc(t("이슈"))}</span>` +
      `<span class="is-seg">${VIEWS.map((v) => `<button class="is-segb${pref.view === v ? " on" : ""}" data-view="${v}">${esc(t({ list: "목록", board: "보드", table: "표" }[v]))}</button>`).join("")}</span>` +
      `<select class="tk-input is-sel" data-pref="source">${srcs.map((s) => `<option value="${s}"${pref.source === s ? " selected" : ""}>${esc(s === "all" ? t("전체 출처") : (SRC_TEXT[s] || s))}</option>`).join("")}</select>` +
      `<select class="tk-input is-sel" data-pref="cwd"><option value="">${esc(t("전체 워크스페이스"))}</option>${wss.map((w) => `<option value="${esc(w.localPath)}"${pref.cwd === w.localPath ? " selected" : ""}>${esc(w.name)}</option>`).join("")}</select>` +
      `<input class="tk-input is-q" placeholder="${esc(t("검색"))}" value="${esc(query)}">` +
      `<label class="is-done"><input type="checkbox" data-pref="done"${pref.done ? " checked" : ""}>${esc(t("완료 포함"))}</label>` +
      `<span class="is-grow"></span>` +
      `<button class="ic-btn tv-ic" data-act="refresh" title="${esc(t("새로고침"))}">${icons.refresh ? icons.refresh({ size: 14 }) : "↻"}</button>` +
      `<button class="tv-btn" data-act="new">${esc(t("새 이슈"))}</button></div>` +
      `<div class="is-warn" hidden></div><div class="is-body"></div>`;
  }
  drawBody();
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
  const list = filterIssues(d.issues, { ...pref, q: query });
  if (!list.length) {
    body.className = "is-body";
    body.innerHTML = `<div class="tv-detail-empty">${esc(d.loading && !d.at ? t("불러오는 중…") : t("이슈가 없어요"))}<div class="is-empty-sub">${esc(t("할 일을 적어 두고, 준비되면 에이전트에게 시작시키세요."))}</div></div>`;
    return;
  }
  if (pref.view === "board") {
    body.className = "is-body board";
    body.innerHTML = groupByStatus(filterIssues(d.issues, { ...pref, q: query, done: true }), { order: STATUSES, keepEmpty: true })
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
  const a = e.target.closest?.("[data-act]");
  if (a) { if (a.dataset.act === "refresh") void refreshIssues({ fresh: true }); else openSheet(null); return; }
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
  const x = issue || { title: "", body: "", status: "todo", priority: "none", labels: [], cwd: pref.cwd || (state.activeWsId && (state.workspaces.find((w) => w.id === state.activeWsId) || {}).localPath) || "" };
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet is-sheet";
  const opt = (list, cur, text) => list.map((v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(text(v))}</option>`).join("");
  const startAgent = (pref.start && pref.start.agent) || "claude";
  const startMode = (pref.start && pref.start.mode) || "task";
  box.innerHTML =
    `<div class="is-sh-head"><span class="is-key">${esc(isNew ? t("새 이슈") : x.key)}</span>${isNew ? "" : srcChip(x)}<span class="is-grow"></span>` +
    (ext && x.source.url ? `<button class="tv-btn ghost" data-s="ext">${esc(t("원본 열기"))}</button>` : "") +
    `<button class="ic-btn" data-s="close" title="${esc(t("닫기"))}">${icons.x ? icons.x({ size: 14 }) : "×"}</button></div>` +
    `<input class="tk-input is-f-title" placeholder="${esc(t("제목"))}" value="${esc(x.title)}">` +
    `<textarea class="tk-input is-f-body" rows="9" placeholder="${esc(t("무엇을, 왜, 끝났다는 기준은 — 에이전트가 이 글만 보고 시작합니다"))}">${esc(x.body || "")}</textarea>` +
    `<div class="is-f-row"><label>${esc(t("상태"))}<select class="tk-input is-f-status">${opt(STATUSES, x.status, (v) => t(ST_TEXT[v]))}</select></label>` +
    `<label>${esc(t("우선순위"))}<select class="tk-input is-f-pri">${opt(["none", "low", "medium", "high", "urgent"], x.priority || "none", (v) => t(PRI_TEXT[v]))}</select></label>` +
    `<label>${esc(t("워크스페이스"))}<select class="tk-input is-f-cwd"${ext ? " disabled" : ""}><option value="">${esc(t("정하지 않음"))}</option>${wss.map((w) => `<option value="${esc(w.localPath)}"${w.localPath === x.cwd ? " selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label></div>` +
    (ext ? "" : `<label class="is-f-lab">${esc(t("라벨(쉼표로 구분)"))}<input class="tk-input is-f-labels" value="${esc((x.labels || []).join(", "))}"></label>`) +
    (isNew ? `<label class="is-f-gh"><input type="checkbox" class="is-f-github">${esc(t("GitHub 이슈로 만들기"))}</label>` : "") +
    (isNew ? "" : `<div class="is-start"><span class="is-start-h">${esc(t("이 이슈로 시작"))}</span>` +
      `<select class="tk-input is-s-mode">${opt(["task", "terminal", "orch"], startMode, (v) => t(MODE_TEXT[v]))}</select>` +
      `<select class="tk-input is-s-agent">${opt(["claude", "codex", "gemini"], startAgent, (v) => agentName(v) || v)}</select>` +
      `<button class="tv-btn is-go" data-s="start">${esc(t("시작"))}</button>` +
      (x.link ? `<button class="tv-btn ghost" data-s="goto">${esc(t("진행 중인 일 보기"))}</button>` : "") + `</div>`) +
    `<div class="is-sh-foot">${!isNew && !ext ? `<button class="tv-btn ghost is-del" data-s="del">${esc(t("삭제"))}</button>` : ""}<span class="is-grow"></span>` +
    `<button class="tv-btn ghost" data-s="close">${esc(t("취소"))}</button><button class="tv-btn" data-s="save">${esc(isNew ? t("만들기") : t("저장"))}</button></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const q = (s) => box.querySelector(s);
  const ghBox = q(".is-f-github");
  const syncGh = () => { if (!ghBox) return; const ok = ghCwds.has(q(".is-f-cwd").value); ghBox.disabled = !ok; if (!ok) ghBox.checked = false; ghBox.parentElement.classList.toggle("off", !ok); };
  syncGh();
  q(".is-f-cwd").addEventListener("change", syncGh);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); sheet = null; };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const fields = () => ({ title: q(".is-f-title").value.trim(), body: q(".is-f-body").value, status: q(".is-f-status").value, priority: q(".is-f-pri").value,
    cwd: q(".is-f-cwd").value, ...(q(".is-f-labels") ? { labels: q(".is-f-labels").value } : {}) });
  let busy = false;
  async function save() {
    if (busy) return null;
    const f = fields();
    if (!f.title) { q(".is-f-title").focus(); return null; }
    busy = true;
    const r = isNew
      ? await act("orch.issueCreate", { ...f, provider: ghBox && ghBox.checked ? "github" : "codingpt" }, t("이슈를 만들었어요"))
      : await act("orch.issueUpdate", { id: x.id, ...f, ...(ext ? { cwd: undefined } : {}) }, t("저장했어요"));
    busy = false;
    if (r) close();
    return r;
  }
  box.addEventListener("click", async (e) => {
    const b = e.target.closest?.("[data-s]");
    if (!b) return;
    const k = b.dataset.s;
    if (k === "close") { close(); return; }
    if (k === "save") { void save(); return; }
    if (k === "ext") { api.openExternal(x.source.url).catch(() => {}); return; }
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
      busy = true; b.disabled = true;
      const r = await act("orch.issueStart", { id: x.id, mode, agent, cwd }, t("시작했어요"));
      busy = false; b.disabled = false;
      if (r && r.started) { close(); goTo(h, { ...r.started, cwd }); }
    }
  });
  sheet = { close };
  setTimeout(() => q(".is-f-title").focus(), 30);
}
/** 시작한 일로 간다 — 작업이면 그 작업 상세, 터미널이면 그 워크스페이스의 그 터미널. */
function goTo(h, link) {
  if (!link) return;
  if (link.taskId) { openTasksDashboard({ taskId: link.taskId, host: h }); return; }
  const w = wsList(h).find((y) => y.localPath === link.cwd);
  if (w && link.tid != null) void openRunTerminal(w.id, link.tid);
}
