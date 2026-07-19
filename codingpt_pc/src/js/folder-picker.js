// folder-picker.js — 새 워크스페이스 폴더 선택.
//  · 이 PC(로컬) = 네이티브 폴더 다이얼로그(createLocalWorkspace).
//  · 외부 PC = macOS Finder 컬럼뷰(원격 fsList) — 모바일 앱과 동일 UX.
//  PC 가 여러 대(이 PC + 외부)면 폴더 선택 전 PC 선택 카드를 먼저 띄운다.
import { api } from "./api.js";
import { state, loadWorkspaces, ensureRuntime, emit, createLocalWorkspace } from "./state.js";

let el = null; // 오버레이
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function ensureOverlay() {
  if (el) return el;
  el = document.createElement("div");
  el.className = "fp-overlay hidden";
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  document.body.appendChild(el);
  return el;
}
function close() { if (el) { el.classList.add("hidden"); el.innerHTML = ""; } }

// ── 진입 ──────────────────────────────────────────────────────────────
export async function openNewWorkspace() {
  let devices = [];
  try {
    const res = await api.fetchDevices();
    devices = (res && (res.devices || res)) || [];
    if (!Array.isArray(devices)) devices = [];
  } catch (_) { devices = []; }

  const isHost = (d) => (d.role || "host") === "host" && d.runnerKind !== "cloud" && d.id !== "cloud";
  const externals = devices.filter((d) => isHost(d) && d.online && !d.isCurrent);
  const self = devices.find((d) => d.isCurrent);

  // 외부 PC 가 없으면 곧장 이 PC 네이티브 폴더 피커(기존 동작).
  if (externals.length === 0) { createLocalWorkspace(); return; }
  renderPcSelect(self, externals);
}

// ── PC 선택 카드 ──────────────────────────────────────────────────────
function renderPcSelect(self, externals) {
  ensureOverlay();
  const row = (name, sub, onClick, dot) => {
    const b = document.createElement("button");
    b.className = "fp-pc-row";
    b.innerHTML = `<span class="fp-pc-ic">🖥️</span><span class="fp-pc-meta"><span class="fp-pc-name">${esc(name)}${dot ? '<i class="fp-dot"></i>' : ""}</span>${sub ? `<span class="fp-pc-sub">${esc(sub)}</span>` : ""}</span><span class="fp-caret">›</span>`;
    b.addEventListener("click", onClick);
    return b;
  };
  el.innerHTML = `<div class="fp-card fp-card-sm"><div class="fp-head"><div class="fp-title">어느 PC에 만들까요?</div></div><div class="fp-sub">워크스페이스를 만들 PC를 선택하세요.</div><div class="fp-pc-list"></div><div class="fp-actions"><button class="fp-btn fp-cancel">취소</button></div></div>`;
  const list = el.querySelector(".fp-pc-list");
  // 이 PC(로컬) — 네이티브 피커.
  list.appendChild(row(self ? `${self.name} (이 PC)` : "이 PC", self && self.platform, () => { close(); createLocalWorkspace(); }, true));
  // 외부 PC — 컬럼 브라우저.
  externals.forEach((d) => list.appendChild(row(d.name || "PC", d.platform, () => renderColumnBrowser(d.id, d.name || "PC"), true)));
  el.querySelector(".fp-cancel").addEventListener("click", close);
  el.classList.remove("hidden");
}

// ── 외부 PC 폴더 컬럼 브라우저(Finder 컬럼뷰) ─────────────────────────
let B = null; // { host, hostName, cols:[{path,items,loading}], sel:[], editingCol, creating }

async function loadCol(path) {
  try {
    const res = await api.remoteFsList(path, B.host);
    const items = (res.items || []).filter((it) => it.dir).map((it) => ({ name: it.name, path: it.path }));
    return { path: res.root != null ? res.root : path, items, loading: false };
  } catch (_) { return { path, items: [], loading: false }; }
}

function renderColumnBrowser(host, hostName) {
  ensureOverlay();
  B = { host, hostName, cols: [{ path: "", items: [], loading: true }], sel: [], editingCol: null, creating: false };
  el.innerHTML = `<div class="fp-card"><div class="fp-head"><div class="fp-title">폴더 선택</div><button class="fp-newfolder">+ 새 폴더</button></div><div class="fp-path"></div><div class="fp-cols"></div><div class="fp-actions"><button class="fp-btn fp-cancel">취소</button><button class="fp-btn fp-designate">이 폴더로 지정</button></div></div>`;
  el.querySelector(".fp-newfolder").addEventListener("click", () => { B.editingCol = B.cols.length - 1; paint(); });
  el.querySelector(".fp-cancel").addEventListener("click", close);
  el.querySelector(".fp-designate").addEventListener("click", designate);
  el.classList.remove("hidden");
  paint();
  loadCol("").then((home) => { B.cols = [home]; paint(); });
}

function targetPath() { return B.sel.length ? B.sel[B.sel.length - 1] : ""; }

function paint() {
  if (!el || !B) return;
  const tp = targetPath();
  const pathEl = el.querySelector(".fp-path");
  if (pathEl) pathEl.textContent = `${B.hostName} / ${tp ? tp.split("/").join(" / ") : "홈"}`;
  const colsEl = el.querySelector(".fp-cols");
  if (!colsEl) return;
  colsEl.innerHTML = "";
  B.cols.forEach((col, ci) => {
    const colEl = document.createElement("div");
    colEl.className = "fp-col";
    // 새 폴더 인라인 입력.
    if (B.editingCol === ci) {
      const wrap = document.createElement("div");
      wrap.className = "fp-row fp-row-edit";
      wrap.innerHTML = `<span class="fp-folder">📁</span>`;
      const inp = document.createElement("input");
      inp.className = "fp-newinput"; inp.placeholder = "새 폴더"; inp.spellcheck = false;
      const commit = () => commitNewFolder(ci, inp.value);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") { B.editingCol = null; paint(); } });
      inp.addEventListener("blur", commit);
      wrap.appendChild(inp);
      colEl.appendChild(wrap);
      setTimeout(() => inp.focus(), 0);
    }
    if (col.loading) {
      colEl.insertAdjacentHTML("beforeend", `<div class="fp-empty">불러오는 중…</div>`);
    } else if (col.items.length === 0) {
      if (B.editingCol !== ci) colEl.insertAdjacentHTML("beforeend", `<div class="fp-empty">하위 폴더 없음</div>`);
    } else {
      col.items.forEach((d) => {
        const selected = B.sel[ci] === d.path;
        const isTarget = selected && d.path === tp; // 체크는 최종 지정 대상에만
        const r = document.createElement("button");
        r.className = "fp-row" + (selected ? " sel" : "");
        r.innerHTML = `<span class="fp-folder">📁</span><span class="fp-name">${esc(d.name)}</span>${isTarget ? '<span class="fp-check">✓</span>' : ""}`;
        r.addEventListener("click", () => pickFolder(ci, d.path));
        colEl.appendChild(r);
      });
    }
    colsEl.appendChild(colEl);
  });
  // 가로 끝으로 스크롤(드릴 시).
  colsEl.scrollLeft = colsEl.scrollWidth;
}

async function pickFolder(ci, folderPath) {
  B.sel = [...B.sel.slice(0, ci), folderPath];
  B.cols = [...B.cols.slice(0, ci + 1), { path: folderPath, items: [], loading: true }];
  B.editingCol = null;
  paint();
  const child = await loadCol(folderPath);
  B.cols = [...B.cols.slice(0, ci + 1), child];
  paint();
}

async function commitNewFolder(ci, name) {
  if (B.creating) return;
  const nm = String(name || "").trim();
  if (!nm) { B.editingCol = null; paint(); return; }
  const base = B.cols[ci] ? B.cols[ci].path : "";
  const target = base ? `${base}/${nm}` : nm;
  B.creating = true; B.editingCol = null;
  try {
    await api.remoteFsMkdir(target, B.host);
    const refreshed = await loadCol(base);
    B.cols[ci] = refreshed;
  } catch (e) { console.error("폴더 생성 실패:", e); }
  finally { B.creating = false; paint(); }
}

async function designate() {
  if (B.creating) return;
  const btn = el && el.querySelector(".fp-designate");
  if (btn) { btn.disabled = true; btn.textContent = "지정 중…"; }
  try {
    const w = await api.remoteWsCreate(targetPath(), B.host);
    close();
    await loadWorkspaces();
    if (w && w.id) { state.activeWsId = w.id; ensureRuntime(w.id); state.view = "workspace"; emit(); }
  } catch (e) {
    console.error("워크스페이스 지정 실패:", e);
    if (btn) { btn.disabled = false; btn.textContent = "이 폴더로 지정"; }
  }
}
