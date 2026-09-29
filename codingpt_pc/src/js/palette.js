// 명령 팔레트(⌘P) — PC 화면.
//
// **창은 하나다**(사용자 확정). 접두어 `>` 로 두 모드가 갈린다:
//  · 그냥 치면  → 열린 탭 + 이 워크스페이스의 파일
//  · `>` 로 치면 → 명령
// 모드가 갈려도 창·조작·키는 같다. 두 창을 만들면 "어느 걸 열어야 하지"를 매번 생각하게 된다.
//
// 스코프는 **워크스페이스 단위**다(사용자 확정 2026-08-04). 기본 모드가 파일 열기라 워크스페이스가
//  없으면 보여줄 것이 없고, 명령도 대부분 이 워크스페이스의 터미널·탭에서 벌어진다. 그래서 버튼도
//  헤더의 추가 버튼들 옆에 있다(사이드바 토글 줄이 아니라).
//
// 앱(codingpt_app/src/workspace/PaletteSheet.tsx)이 이 화면의 미러다. 판정(순위·모드)은
//  palette-match.js 를, 명령 표는 commands.js 를, 문구는 text/palette.js 를 **양쪽이 공유**한다.
import { state, activeWs, wsRuntime, isThisHost } from "./state.js";
import { api } from "./api.js";
import { makeRemoteFs } from "./remote-fs.js";
import { icons } from "./icons.js";
import { tx } from "./text/index.js";
import { PALETTE_TEXT } from "./text/palette.js";
import { commandsFor, formatCombo } from "./commands.js";
import { bindings, IS_APPLE } from "./shortcuts.js";
import { isAvailable, runCommand } from "./command-run.js";
import * as M from "./palette-match.js";
import { basename, dirname } from "./path-utils.js";
import { openSurfaces, activateSurface, openFileSmart } from "./workspace-view.js";

const TX = () => tx(PALETTE_TEXT);

const MAX_FILES = 40;
const MAX_TABS = 8;
const MAX_CMDS = 40;

let overlay = null;

// ── 파일 목록 캐시 ───────────────────────────────────────────────────────────
// 트리 조회는 원격이면 왕복이 붙는다(다른 PC 워크스페이스). 팔레트를 여닫을 때마다 다시 읽으면
//  느린 게 아니라 **매번 다르게 느려진다** — 캐시를 두되 짧게 잡아 새 파일이 오래 안 보이는 일도
//  막는다. 워크스페이스를 바꾸면 키가 달라져 자동으로 버려진다.
const CACHE_MS = 20000;
const fileCache = new Map(); // key → { at, files, truncated }

function cacheKey(ws) {
  return `${ws && ws.id}|${ws && ws.hostDeviceId}|${ws && ws.localPath}`;
}

function flattenTree(nodes, out) {
  for (const n of nodes || []) {
    if (n.dir) flattenTree(n.children, out);
    else out.push(n.path);
  }
  return out;
}

/** 워크스페이스 루트 기준 상대경로 목록. 실패는 던진다(조용히 빈 목록을 주지 않는다). */
async function loadFiles(ws) {
  const key = cacheKey(ws);
  const hit = fileCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const fs = isThisHost(ws) ? api : makeRemoteFs(ws.hostDeviceId);
  const root = (ws && ws.localPath) || "";
  const tree = await fs.fsTree(root, 8);
  const abs = flattenTree(tree, []);
  const prefix = root ? root.replace(/\/+$/, "") + "/" : "";
  const files = abs.map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p));
  // 데몬 fs.tree 는 상한(4000개/깊이 8)이 있다. 상한에 닿았으면 "전부 찾은 게 아니다"라고
  //  말해야 한다 — 없는 파일을 없다고 단정하면 사용자는 엉뚱한 곳을 뒤진다.
  const rec = { at: Date.now(), files, truncated: files.length >= 4000, prefix };
  fileCache.set(key, rec);
  return rec;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 맞은 글자에 밑줄. 순위와 같은 규칙(부분수열)으로 칠해야 "왜 이게 떴지"가 안 생긴다. */
function highlight(text, term) {
  const t = String(text || "");
  const q = String(term || "").toLowerCase().replace(/\s+/g, "");
  if (!q) return esc(t);
  const low = t.toLowerCase();
  let qi = 0;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (qi < q.length && low[i] === q[qi]) { out += `<b>${esc(t[i])}</b>`; qi++; }
    else out += esc(t[i]);
  }
  return qi === q.length ? out : esc(t);
}

// ── 행 만들기 ────────────────────────────────────────────────────────────────
// 행은 전부 `{ key, section, icon, label, hint, sub, disabled, run }` 모양이다. 화면 그리기가
//  종류를 몰라야 새 종류를 더할 때 그리기를 안 건드린다.

function tabRows(term) {
  const T = TX();
  const rows = [];
  for (const s of openSurfaces()) {
    const score = M.scoreLabeled(s.label, s.kind, term);
    if (score == null) continue;
    rows.push({
      key: `tab:${s.paneId}:${s.index}`,
      section: T.secOpenTabs,
      score,
      sortKey: s.label,
      icon: s.kind === "ide" ? icons.code({ size: 15 }) : s.kind === "preview" ? icons.globe({ size: 15 }) : icons.terminal({ size: 15 }),
      label: s.label,
      hint: s.active ? "●" : "",
      run: () => activateSurface(s.paneId, s.index),
    });
  }
  return M.rankRows(rows, term, MAX_TABS);
}

function fileRows(files, term) {
  const T = TX();
  return M.rankPaths(files, term, MAX_FILES).map((p) => ({
    key: "file:" + p,
    section: T.secFiles,
    icon: icons.file ? icons.file({ size: 15 }) : icons.code({ size: 15 }),
    label: basename(p), // `/`·`\` 양쪽 인식(win32 경로) — `/` 경로는 종전과 동일
    sub: dirname(p),
    path: p,
    run: () => openFileSmart(p),
  }));
}

function commandRows(term) {
  const T = TX();
  const binds = bindings();
  const rows = [];
  for (const c of commandsFor("pc")) {
    if (!c.palette) continue;
    const label = T.cmd[c.id] || c.id;
    const groupName = T.group[c.group] || c.group;
    const score = M.scoreLabeled(label, `${groupName} ${c.id}`, term);
    if (score == null) continue;
    const usable = isAvailable(c.id);
    rows.push({
      key: "cmd:" + c.id,
      section: T.secCommands,
      score,
      sortKey: label,
      icon: "",
      label,
      hint: binds[c.id] ? formatCombo(binds[c.id], IS_APPLE) : "",
      sub: groupName,
      disabled: !usable,
      run: () => runCommand(c.id),
    });
  }
  return M.rankRows(rows, term, MAX_CMDS);
}

// ── 화면 ─────────────────────────────────────────────────────────────────────

export function isPaletteOpen() {
  return !!overlay;
}

export function closePalette() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
}

export function openPalette(initial) {
  if (overlay) { overlay.querySelector(".cp-input")?.focus(); return; }
  const T = TX();
  const ws = activeWs();

  overlay = document.createElement("div");
  overlay.className = "cp-overlay";
  overlay.innerHTML = `
    <div class="cp-card" role="dialog" aria-modal="true">
      <div class="cp-inputrow">
        <span class="cp-ic">${icons.search({ size: 15 })}</span>
        <input class="cp-input" placeholder="${esc(T.placeholder)}" spellcheck="false" autocomplete="off" />
      </div>
      <div class="cp-list" role="listbox"></div>
      <div class="cp-foot"><span class="cp-foot-l"></span><span class="cp-foot-r">${esc(T.hintCommand)}</span></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".cp-input");
  const listEl = overlay.querySelector(".cp-list");
  const footL = overlay.querySelector(".cp-foot-l");

  let rows = [];
  let sel = 0;
  let files = null;         // null = 아직 안 읽음
  let filesErr = null;
  let truncated = false;

  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closePalette(); });

  function setFoot(msg) { footL.textContent = msg || ""; }

  function build() {
    const { mode, term } = M.parseQuery(input.value);
    input.placeholder = mode === M.MODE_COMMAND ? T.placeholderCommand : T.placeholder;
    if (mode === M.MODE_COMMAND) {
      rows = commandRows(term);
      setFoot("");
    } else {
      const tabs = tabRows(term);
      let fr = [];
      if (files) fr = fileRows(files, term);
      rows = [...tabs, ...fr];
      setFoot(filesErr ? filesErr : files === null ? T.loading : truncated ? T.truncated : "");
    }
    // 실행 가능한 첫 행으로 커서를 둔다(흐린 행에 커서가 앉으면 Enter 가 아무 일도 안 한다).
    sel = Math.max(0, rows.findIndex((r) => !r.disabled));
    paint();
  }

  function paint() {
    listEl.innerHTML = "";
    if (!rows.length) {
      const d = document.createElement("div");
      d.className = "cp-empty";
      const { mode } = M.parseQuery(input.value);
      d.textContent = !ws ? T.needWorkspace
        : mode === M.MODE_FILE && files && !files.length ? T.emptyFiles
          : T.empty;
      listEl.appendChild(d);
      return;
    }
    const { term } = M.parseQuery(input.value);
    let lastSection = null;
    rows.forEach((r, i) => {
      if (r.section !== lastSection) {
        lastSection = r.section;
        const h = document.createElement("div");
        h.className = "cp-sec";
        h.textContent = r.section;
        listEl.appendChild(h);
      }
      const el = document.createElement("button");
      el.className = "cp-row" + (i === sel ? " sel" : "") + (r.disabled ? " off" : "");
      el.innerHTML =
        `<span class="cp-row-ic">${r.icon || ""}</span>`
        + `<span class="cp-row-label">${highlight(r.label, term)}</span>`
        + (r.sub ? `<span class="cp-row-sub">${highlight(r.sub, "")}</span>` : "")
        + `<span class="cp-row-hint">${esc(r.disabled ? T.unavailable : (r.hint || ""))}</span>`;
      el.addEventListener("mousemove", () => { if (sel !== i) { sel = i; paintSel(); } });
      el.addEventListener("click", () => choose(i));
      listEl.appendChild(el);
    });
    scrollSel();
  }

  function paintSel() {
    [...listEl.querySelectorAll(".cp-row")].forEach((el, i) => el.classList.toggle("sel", i === sel));
    scrollSel();
  }

  function scrollSel() {
    const el = listEl.querySelectorAll(".cp-row")[sel];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  function move(d) {
    if (!rows.length) return;
    let i = sel;
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    sel = i;
    paintSel();
  }

  function choose(i) {
    const r = rows[i];
    if (!r || r.disabled) return;
    closePalette();                 // 먼저 닫는다 — 실행이 포커스를 가져가야 하는데 팔레트가 물고
    try { r.run(); } catch (_) { /* 실행부가 자기 방식으로 알린다 */ }
  }

  input.addEventListener("input", build);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); choose(sel); return; }
    // ⌘P 를 한 번 더 누르면 닫힌다(연 키로 닫는 게 가장 손이 짧다).
    if (e.key.toLowerCase() === "p" && (IS_APPLE ? e.metaKey : e.ctrlKey)) { e.preventDefault(); closePalette(); }
  });

  input.value = initial || "";
  build();
  input.focus();

  // 파일 목록은 창을 띄운 **뒤** 읽는다. 읽는 동안에도 열린 탭과 명령은 이미 쓸 수 있다.
  if (ws) {
    loadFiles(ws)
      .then((r) => { if (!overlay) return; files = r.files; truncated = r.truncated; build(); })
      .catch((e) => { if (!overlay) return; files = []; filesErr = String((e && e.message) || e); build(); });
  } else {
    files = [];
  }
}

/** 명령 모드로 바로 열기(설정·다른 곳에서 "명령 찾기"를 부를 때). */
export function openCommandPalette() {
  openPalette("> ");
}
