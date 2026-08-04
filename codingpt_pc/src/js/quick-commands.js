// 저장한 명령(Quick Commands) — PC 화면.
//
// 저장소는 **그 워크스페이스를 호스팅하는 PC 의 데몬 로컬 파일**이다(사용자 확정 2026-08-04).
//  그래서 여기서 하는 일은 전부 "그 PC 에 물어보고 그 PC 에 저장하기"다. 이 PC 워크스페이스면
//  사이드카 소켓 직결(1~2ms), 다른 PC 면 back 릴레이(150~285ms) — 데몬 구현은 한 벌이다.
//
// 앱(codingpt_app/src/workspace/QuickCommands*.tsx)이 이 화면의 미러다. 목록 순서·문구·동작을
//  바꾸면 양쪽을 함께 본다(문구는 text/quick-commands.js 에 모여 있다).
import { api } from "./api.js";
import { state, activeWs, wsRuntime, isThisHost } from "./state.js";
import * as T from "./tiling.js";
import { icons, agentMarkHtml } from "./icons.js";
import { cachedAgents, loadAgents } from "./agents-view.js";
import { tx } from "./text/index.js";
import { QC_TEXT } from "./text/quick-commands.js";
import { wvToast } from "./workspace-view.js";
import * as i18n from './i18n/index.js';

const TX = tx(QC_TEXT);

// ── 전송 ─────────────────────────────────────────────────────────────────────
// ws 인자는 **홈-상대 워크스페이스 경로**다. 빈 문자열('')은 홈 루트라는 유효한 값이므로
//  "없음"과 구분해 그대로 넘긴다 — 조회 API 가 POST 인 이유가 이것이다(back 주석 참조).
function hostOf(ws) {
  return ws && ws.hostDeviceId != null ? ws.hostDeviceId : null;
}

async function call(cmd, args, ws) {
  const local = isThisHost(ws);
  if (local) return api.qcLocal(cmd, args);
  const body = { ...args, ...(hostOf(ws) != null ? { hostDeviceId: hostOf(ws) } : {}) };
  if (cmd === "qc.list") return api.qcList(body);
  if (cmd === "qc.listAll") return api.qcListAll();
  if (cmd === "qc.save") return api.qcSave(body);
  if (cmd === "qc.remove") return api.qcRemove(body);
  if (cmd === "qc.reorder") return api.qcReorder(body);
  if (cmd === "qc.run") return api.qcRun(body);
  throw new Error(i18n.t('알 수 없는 명령: ') + cmd);
}

/** back 응답은 successResponse 라 data 가 최상위로 펼쳐져 온다. 로컬 소켓은 그대로다. */
function unwrap(r) {
  return (r && typeof r === "object" && r.data && typeof r.data === "object") ? r.data : r;
}

export async function listQuickCommands(ws) {
  const r = unwrap(await call("qc.list", { ws: wsPathOf(ws) }, ws));
  return Array.isArray(r && r.items) ? r.items : [];
}

export async function listAllQuickCommands(ws) {
  const r = unwrap(await call("qc.listAll", {}, ws));
  return { items: Array.isArray(r && r.items) ? r.items : [], limits: (r && r.limits) || {} };
}

export async function saveQuickCommand(item, ws) {
  return unwrap(await call("qc.save", { item }, ws));
}

export async function removeQuickCommand(id, ws) {
  return unwrap(await call("qc.remove", { id }, ws));
}

/** 워크스페이스의 홈-상대 경로. 데몬이 스코프 판정에 쓰는 키와 같아야 한다. */
function wsPathOf(ws) {
  return ws && typeof ws.localPath === "string" ? ws.localPath : "";
}

/** 지금 활성 pane 에서 보고 있는 터미널 id(없으면 null) — target:'current' 의 대상. */
function focusedTid() {
  const rt = wsRuntime(state.activeWsId);
  if (!rt || !rt.layout) return null;
  const focusId = rt.focusId || T.firstLeafId(rt.layout);
  const leaf = focusId ? T.findLeaf(rt.layout, focusId) : null;
  if (!leaf || leaf.kind !== "terminal") return null;
  const tab = (leaf.tabs || [])[leaf.active];
  return tab && typeof tab.win === "number" ? tab.win : null;
}

/**
 * 실행. 결과를 **감추지 않는다** — 준비가 안 된 채 보냈으면 그렇다고 말한다(사용자가 화면을
 *  보고 판단할 수 있어야 한다. 조용히 성공한 척하면 "눌렀는데 아무 일도 없었다"가 된다).
 */
export async function runQuickCommand(item, ws) {
  const path = wsPathOf(ws);
  const tid = item.target === "current" ? focusedTid() : null;
  if (item.target === "current" && tid == null) { wvToast(TX.needTerminal); return null; }
  try {
    const r = unwrap(await call("qc.run", { id: item.id, cwd: path, ...(tid != null ? { tid } : {}) }, ws));
    if (r && r.busy) { wvToast(TX.busy); return r; }
    if (r && r.ready === false) wvToast(TX.notReady);
    return r;
  } catch (e) {
    wvToast((e && e.message) || TX.failed);
    return null;
  }
}

// ── 헤더 드롭다운 ─────────────────────────────────────────────────────────────
// 스타일은 "터미널 추가 ▾"(.pv-menu)를 그대로 쓴다 — 같은 자리의 같은 성격이라 새 모양을
//  만들 이유가 없다. 목록이 비어 있어도 메뉴는 연다(비었다는 사실과 만드는 길을 보여줘야 한다).
export function openQuickCommandsMenu(anchor) {
  document.querySelectorAll(".pv-menu").forEach((el) => el.remove());
  const ws = activeWs();
  const menu = document.createElement("div");
  menu.className = "pv-menu";
  menu.style.minWidth = "232px";
  const close = () => { menu.remove(); document.removeEventListener("mousedown", closer, true); };
  const closer = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };

  const row = (html, onClick, cls) => {
    const b = document.createElement("button");
    b.className = "pv-menu-item" + (cls ? " " + cls : "");
    b.innerHTML = html;
    b.addEventListener("click", () => { close(); onClick(); });
    menu.appendChild(b);
    return b;
  };
  const note = (text) => {
    const d = document.createElement("div");
    d.className = "pv-menu-note";
    d.textContent = text;
    menu.appendChild(d);
  };

  const paint = (items) => {
    menu.innerHTML = "";
    if (!items) { note("…"); return; }
    if (!items.length) {
      note(TX.empty);
      note(TX.emptyHint);
    }
    for (const it of items) {
      const isAgent = it.kind === "agent";
      const ic = isAgent
        ? (agentMarkHtml(it.agent, { size: 15 }) || icons.terminal({ size: 15 }))
        : icons.terminal({ size: 15 });
      // 어디서 도는지를 아이콘 옆에 한 글자로 — 눌러 보기 전에 알 수 있어야 한다.
      const where = it.target === "current" ? TX.targetCurrent : TX.targetNew;
      row(
        `<span class="pvm-ic">${ic}</span><span class="pvm-label">${esc(it.label)}</span>`
        + `<span class="pvm-hint">${esc(where)}</span>`,
        () => runQuickCommand(it, ws),
      );
    }
    const div = document.createElement("div");
    div.className = "pv-menu-div";
    menu.appendChild(div);
    row(`<span class="pvm-ic">${icons.gear ? icons.gear({ size: 15 }) : ""}</span><span class="pvm-label">${esc(TX.manage)}</span>`,
      () => openManageSheet(ws));
  };

  paint(null);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.right = Math.max(6, window.innerWidth - r.right) + "px";
  document.body.append(menu);
  setTimeout(() => document.addEventListener("mousedown", closer, true), 0);
  listQuickCommands(ws)
    .then((items) => { if (menu.isConnected) paint(items); })
    .catch(() => { if (menu.isConnected) { menu.innerHTML = ""; note(TX.failed); } });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── 관리 UI(목록 + 추가/수정/삭제) ──────────────────────────────────────────
// 시트(헤더 메뉴 → "명령 관리")와 설정 화면이 **같은 그리기 함수**를 쓴다. 두 곳에 따로 만들면
//  한쪽만 고쳐지는 결함이 된다(전례가 많다).
export function openManageSheet(wsArg) {
  const ws = wsArg || activeWs();
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const sheet = document.createElement("div");
  sheet.className = "wv-sheet qc-sheet";
  overlay.appendChild(sheet);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  renderManageInto(sheet, ws, { title: true });
}

/** 설정 화면용 — 이미 있는 컨테이너 안에 목록을 그린다. opts.title=false 면 제목을 안 그린다. */
export function renderManageInto(host, wsArg, opts) {
  const ws = wsArg || activeWs();
  const withTitle = !opts || opts.title !== false;
  let limits = {};
  const render = (items) => {
    host.innerHTML = "";
    if (withTitle) {
      const title = document.createElement("div");
      title.className = "wv-sheet-title";
      title.textContent = TX.title;
      host.appendChild(title);
    }
    const sheet = host;

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "qc-empty";
      empty.textContent = TX.emptyHint;
      sheet.appendChild(empty);
    }
    for (const it of items) {
      const r = document.createElement("div");
      r.className = "qc-row";
      const body = it.kind === "agent" ? it.prompt : it.text;
      const scope = it.ws == null ? TX.scopeGlobal : TX.scopeWs;
      r.innerHTML =
        `<div class="qc-row-main">`
        + `<div class="qc-row-label">${esc(it.label)}</div>`
        + `<div class="qc-row-body">${esc(oneLine(body))}</div>`
        + `<div class="qc-row-meta">${esc(it.kind === "agent" ? TX.kindAgent : TX.kindShell)}`
        + ` · ${esc(it.target === "current" ? TX.targetCurrent : TX.targetNew)} · ${esc(scope)}</div>`
        + `</div>`;
      const edit = document.createElement("button");
      edit.className = "qc-row-btn";
      edit.textContent = TX.edit;
      edit.addEventListener("click", () => openEditor(ws, it, reload));
      const del = document.createElement("button");
      del.className = "qc-row-btn danger";
      del.textContent = TX.remove;
      del.addEventListener("click", async () => {
        if (!window.confirm(TX.removeConfirm(it.label))) return;
        await removeQuickCommand(it.id, ws).catch(() => {});
        reload();
      });
      r.append(edit, del);
      sheet.appendChild(r);
    }
    const add = document.createElement("button");
    add.className = "qc-add";
    add.textContent = TX.add;
    add.addEventListener("click", () => {
      if (limits.maxItems && items.length >= limits.maxItems) { wvToast(TX.limitReached(limits.maxItems)); return; }
      openEditor(ws, null, reload);
    });
    sheet.appendChild(add);
  };

  const reload = () => listAllQuickCommands(ws)
    .then((r) => { limits = r.limits || {}; render(r.items); })
    .catch(() => { host.innerHTML = `<div class="qc-empty">${esc(TX.failed)}</div>`; });
  reload();
  return reload;
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

// ── 편집기 ───────────────────────────────────────────────────────────────────
function openEditor(ws, existing, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const sheet = document.createElement("div");
  sheet.className = "wv-sheet qc-editor";
  overlay.appendChild(sheet);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  const draft = {
    id: existing?.id,
    label: existing?.label || "",
    kind: existing?.kind || "shell",
    text: existing?.text || "",
    agent: existing?.agent || "",
    prompt: existing?.prompt || "",
    target: existing?.target || "new",
    // 새로 만들 땐 **이 워크스페이스 전용**이 기본이다. 전역은 명시적으로 고르게 한다 —
    //  전역이 기본이면 프로젝트 전용 명령이 다른 데서 계속 튀어나온다.
    ws: existing ? existing.ws : wsPathOf(ws),
  };

  const paint = () => {
    sheet.innerHTML = "";
    const title = document.createElement("div");
    title.className = "wv-sheet-title";
    title.textContent = existing ? TX.edit : TX.add;
    sheet.appendChild(title);

    sheet.appendChild(seg(TX.kindShell, TX.kindAgent, draft.kind === "agent", (isAgent) => {
      draft.kind = isAgent ? "agent" : "shell";
      paint();
    }));

    sheet.appendChild(field(TX.labelField, input(draft.label, TX.labelPlaceholder, (v) => { draft.label = v; })));

    if (draft.kind === "agent") {
      const sel = document.createElement("select");
      sel.className = "qc-input";
      const agents = cachedAgents().agents.filter((a) => a.installed);
      if (!agents.length) loadAgents(false).then(() => paint()).catch(() => {});
      for (const a of agents) {
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = a.name;
        if (a.id === draft.agent) o.selected = true;
        sel.appendChild(o);
      }
      if (!draft.agent && agents.length) draft.agent = agents[0].id;
      sel.addEventListener("change", () => { draft.agent = sel.value; });
      sheet.appendChild(field(TX.agentPick, sel));
      sheet.appendChild(field(TX.agentField, textarea(draft.prompt, TX.agentPlaceholder, (v) => { draft.prompt = v; })));
    } else {
      sheet.appendChild(field(TX.shellField, textarea(draft.text, TX.shellPlaceholder, (v) => { draft.text = v; })));
    }

    const targetSeg = seg(TX.targetNew, TX.targetCurrent, draft.target === "current", (isCur) => {
      draft.target = isCur ? "current" : "new";
      paint();
    });
    sheet.appendChild(field(TX.targetField, targetSeg));
    sheet.appendChild(hint(draft.target === "current" ? TX.targetCurrentHint : TX.targetNewHint));

    sheet.appendChild(field(TX.scopeField, seg(TX.scopeGlobal, TX.scopeWs, draft.ws != null, (wsOnly) => {
      draft.ws = wsOnly ? wsPathOf(ws) : null;
      paint();
    })));

    const actions = document.createElement("div");
    actions.className = "qc-actions";
    const cancel = document.createElement("button");
    cancel.className = "qc-btn";
    cancel.textContent = TX.cancel;
    cancel.addEventListener("click", close);
    const save = document.createElement("button");
    save.className = "qc-btn primary";
    save.textContent = TX.save;
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveQuickCommand(draft, ws);
        close();
        onDone?.();
      } catch (e) {
        save.disabled = false;
        wvToast((e && e.message) || TX.failed);
      }
    });
    actions.append(cancel, save);
    sheet.appendChild(actions);
  };
  paint();
}

function field(label, control) {
  const d = document.createElement("div");
  d.className = "qc-field";
  const l = document.createElement("div");
  l.className = "qc-field-label";
  l.textContent = label;
  d.append(l, control);
  return d;
}

function hint(text) {
  const d = document.createElement("div");
  d.className = "qc-hint";
  d.textContent = text;
  return d;
}

function input(value, placeholder, onChange) {
  const el = document.createElement("input");
  el.className = "qc-input";
  el.value = value || "";
  el.placeholder = placeholder || "";
  el.addEventListener("input", () => onChange(el.value));
  return el;
}

function textarea(value, placeholder, onChange) {
  const el = document.createElement("textarea");
  el.className = "qc-input qc-textarea";
  el.value = value || "";
  el.placeholder = placeholder || "";
  el.rows = 3;
  el.addEventListener("input", () => onChange(el.value));
  return el;
}

/** 두 갈래 토글. 색은 무채색 명암으로만 — accent 는 상태 신호 전용이다(2026-07-28 색 규율). */
function seg(leftLabel, rightLabel, rightOn, onPick) {
  const d = document.createElement("div");
  d.className = "qc-seg";
  const mk = (text, on, val) => {
    const b = document.createElement("button");
    b.className = "qc-seg-btn" + (on ? " on" : "");
    b.textContent = text;
    b.addEventListener("click", () => onPick(val));
    return b;
  };
  d.append(mk(leftLabel, !rightOn, false), mk(rightLabel, rightOn, true));
  return d;
}
