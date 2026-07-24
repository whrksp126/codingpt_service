// ide.js — pane 내장 IDE(VS Code 근사). 파일트리(아이콘·컨텍스트메뉴·DnD·검색) + 에디터 그룹 + 저장.
//  PC 앱이 같은 머신이라 Rust fs 커맨드로 로컬 파일을 직접 다룬다(홈 jail).
//  에디터는 "그룹"으로 분할된다(트리는 하나 공유, 오른쪽 편집 영역만 여러 그룹으로 나눔 — VS Code editor groups).
import { api } from "./api.js";
import { icons } from "./icons.js";
import { fileIcon, folderIcon } from "./fileicons.js";
import * as T from "./tiling.js";
import { cmThemeName } from "./theme.js";
import { termTargetAt, shq, insertIntoTerminal } from "./os-drop.js";

const CM = window.CodeMirror;

function modeFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "js": case "mjs": case "cjs": return "javascript";
    case "ts": return { name: "javascript", typescript: true };
    case "jsx": case "tsx": return "jsx";
    case "json": return { name: "javascript", json: true };
    case "py": return "python";
    case "css": case "scss": case "less": return "css";
    case "html": case "htm": case "vue": case "svelte": return "htmlmixed";
    case "xml": case "svg": return "xml";
    case "md": case "markdown": return "markdown";
    case "sh": case "bash": case "zsh": return "shell";
    case "c": case "h": return "text/x-csrc";
    case "cpp": case "cc": case "hpp": return "text/x-c++src";
    case "java": return "text/x-java";
    case "go": return "text/x-go";
    case "rs": return "text/x-rustsrc";
    default: return "text/plain";
  }
}
const baseName = (p) => p.split("/").pop() || p;
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── 전역 미저장 상태 — 앱 종료 가드용. dirty 전이 때마다 Rust(set_ide_dirty)에 미러한다. ──
const _ideInstances = new Set();
let _lastDirtyFlag = null;
export function ideDirtyPaths() {
  const seen = new Set();
  for (const inst of _ideInstances) for (const g of inst.groups.values()) for (const f of g.open)
    if (f.dirty) seen.add(f.path);
  return [...seen];
}
function syncGlobalDirty() {
  const flag = ideDirtyPaths().length > 0;
  if (flag === _lastDirtyFlag) return;
  _lastDirtyFlag = flag;
  api.setIdeDirty(flag).catch(() => { /* 구 버전 브리지 등 — 가드 없이 기존 동작 */ });
}

export class IdeView {
  constructor(localPath, body, opts = {}) {
    this.root = (localPath || "").replace(/\/+$/, "");
    this.body = body;
    this.opts = opts; // { openPath, paneId, fs(원격 전송 어댑터), ... }
    // 파일 전송 계층 — 기본=로컬 fsapi, 원격 워크스페이스면 back 릴레이 어댑터(remote-fs.js) 주입.
    this.fs = opts.fs || api;
    this.groups = new Map(); // id → { id, open:[{path,doc,dirty}], active, cm, wrap, tabsBar, tablist, editorHost, empty }
    this.egRoot = null; // 에디터 그룹 타일링 트리(leaf=group, branch={dir,ratio,first,second})
    this.activeGroupId = null;
    this._gseq = 0;
    this.expanded = new Set([this.root]);
    this.selectedPath = null; // 트리에서 키보드로 선택된 행(Return=이름변경·화살표 이동 대상)
    this.treeVisible = true;
    this.tree = null;
    this.searchTree = null;
    this.query = "";
    this._searchToken = 0;
    this._searchTimer = null;
    this._build();
    // 외부 변경 리컨실러 — 다른 기기(모바일 IDE)/터미널/에이전트가 바꾼 파일을 열린 버퍼에 반영.
    //  로컬 디스크 직결이라 워처 없이 저비용 폴링: dirty 아닌 열린 파일만 다시 읽어 달라지면 교체.
    this._syncTick = 0;
    this._reloadingExternal = false;
    //  원격(릴레이)은 호출당 서버 왕복이라 주기를 완화(열린 버퍼 1.2s → 4s).
    this._syncTimer = setInterval(() => { this._reconcileDisk().catch(() => {}); }, this.fs.remote ? 4000 : 1200);
    // 자동 저장(VS Code afterDelay) — 타이핑이 멈추고 800ms 뒤 디스크 기록 → 다른 기기에 곧바로 반영.
    this._autoTimers = new Map(); // path → timeout
    _ideInstances.add(this); // 앱 종료 가드의 전역 dirty 집계 대상
  }

  get activeGroup() { return this.groups.get(this.activeGroupId) || this.groups.values().next().value; }
  _openFilesAll() { return [...this.groups.values()].flatMap((g) => g.open); }

  _build() {
    const wrap = document.createElement("div");
    wrap.className = "ide";
    this.treeEl = document.createElement("div");
    this.treeEl.className = "ide-tree";
    this.treeW = 230;
    this.treeEl.style.width = this.treeW + "px";
    this.resizer = document.createElement("div");
    this.resizer.className = "ide-resizer";
    this._wireResizer();
    this.mainEl = document.createElement("div");
    this.mainEl.className = "ide-main";
    this.editorAreaEl = document.createElement("div");
    this.editorAreaEl.className = "ide-editor-area";
    this.mainEl.append(this.editorAreaEl);
    wrap.append(this.treeEl, this.resizer, this.mainEl);
    this.body.appendChild(wrap);

    const g0 = this._makeGroup();
    this.egRoot = g0;
    this.activeGroupId = g0.id;
    this._renderEditorArea();

    // 트리 빈 공간 포함 전체 우클릭 → 루트 컨텍스트 메뉴.
    this.treeEl.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".ide-node") || e.target.closest(".ide-tree-hdr")) return;
      e.preventDefault();
      this._menu(e, { path: this.root, dir: true });
    });
  }

  // ── 에디터 그룹(타일링 트리) ──
  _makeGroup() {
    const g = { id: "g" + ++this._gseq, open: [], active: -1 };
    g.wrap = document.createElement("div");
    g.wrap.className = "eg";
    g.tabsBar = document.createElement("div");
    g.tabsBar.className = "ide-tabs";
    g.tablist = document.createElement("div");
    g.tablist.className = "ide-tablist";
    // 파일 탭 바 맨 우측 = 탐색기(파일 트리) 토글 — pane 헤더 대신 IDE 안에 둬서
    //  IDE 가 다른 pane 의 혼합 탭으로 들어가도 항상 보인다(독립 pane/혼합 탭 무관).
    g.treeToggle = document.createElement("button");
    g.treeToggle.className = "ide-tabtoggle"; // 액티브(색) 표시 제거 — 채운/빈 아이콘으로만 구분
    g.treeToggle.title = "탐색기 토글";
    // 열림=채운 아이콘, 닫힘=빈 아이콘.
    g.treeToggle.innerHTML = icons[this.treeVisible ? "sidebarFilled" : "sidebar"]({ size: 15 });
    g.treeToggle.addEventListener("click", (e) => { e.stopPropagation(); this.toggleTree(); });
    g.tabsBar.append(g.tablist, g.treeToggle);
    g.editorHost = document.createElement("div");
    g.editorHost.className = "ide-editor";
    g.empty = document.createElement("div");
    g.empty.className = "ide-empty";
    g.empty.textContent = "왼쪽에서 파일을 선택하세요";
    g.wrap.append(g.tabsBar, g.editorHost, g.empty);
    g.cm = CM(g.editorHost, {
      value: "", mode: "javascript", theme: cmThemeName(),
      lineNumbers: true, autoCloseBrackets: true, matchBrackets: true, styleActiveLine: true,
      indentUnit: 2, tabSize: 2,
      hintOptions: { completeSingle: false },
      extraKeys: {
        "Cmd-S": () => this.save(), "Ctrl-S": () => this.save(),
        "Cmd-/": "toggleComment", "Ctrl-/": "toggleComment",
        "Ctrl-Space": "autocomplete", "Alt-/": "autocomplete",
        // 실행취소/다시실행은 현재 활성 문서(파일)에만 스코프 — CM5 는 history 가 Doc 에 있어 swapDoc
        //  이면 파일별로 분리되지만, 기본 keymap 낙하 대신 명시 바인딩으로 경계 누수를 확실히 막는다.
        "Cmd-Z": (cm) => cm.undo(), "Ctrl-Z": (cm) => cm.undo(),
        "Shift-Cmd-Z": (cm) => cm.redo(), "Shift-Ctrl-Z": (cm) => cm.redo(),
        "Cmd-Y": (cm) => cm.redo(), "Ctrl-Y": (cm) => cm.redo(),
      },
    });
    g.cm.on("change", () => {
      this._markDirty(g);
      // 가상 문서(diff)는 자동 저장 경로에 절대 태우지 않는다(읽기 전용 — setValue 갱신만 발생).
      if (!this._reloadingExternal) { const f = g.open[g.active]; if (f && !f.virtual) this._scheduleAutosave(f.path); }
    });
    g.cm.on("inputRead", (cm, change) => {
      if (cm.state.completionActive) return;
      const ch = change.text && change.text[change.text.length - 1];
      if (ch && /[\w.@$#-]/.test(ch) && cm.showHint) cm.showHint({ completeSingle: false });
    });
    g.cm.on("focus", () => this._setActiveGroup(g.id));
    g.wrap.addEventListener("mousedown", () => this._setActiveGroup(g.id), true);
    g.editorHost.style.display = "none";
    this.groups.set(g.id, g);
    return g;
  }

  _renderEditorArea() {
    this.editorAreaEl.innerHTML = "";
    if (this.egRoot) this.editorAreaEl.appendChild(this._buildEg(this.egRoot));
    setTimeout(() => this.groups.forEach((g) => g.cm.refresh()), 0);
  }

  _buildEg(node) {
    if (!node.dir) {
      // leaf = 그룹
      node.wrap.style.flex = "1 1 0";
      node.wrap.classList.toggle("focused", node.id === this.activeGroupId && this.groups.size > 1);
      return node.wrap;
    }
    const box = document.createElement("div");
    box.className = "eg-split eg-split-" + node.dir;
    const firstWrap = document.createElement("div");
    firstWrap.className = "eg-child";
    firstWrap.style.flexBasis = node.ratio * 100 + "%";
    firstWrap.appendChild(this._buildEg(node.first));
    const div = document.createElement("div");
    div.className = "eg-divider eg-divider-" + node.dir;
    const secondWrap = document.createElement("div");
    secondWrap.className = "eg-child";
    secondWrap.style.flexBasis = (1 - node.ratio) * 100 + "%";
    secondWrap.appendChild(this._buildEg(node.second));
    this._wireEgDivider(div, box, firstWrap, secondWrap, node);
    box.append(firstWrap, div, secondWrap);
    return box;
  }

  // 에디터 그룹 분할선 폭/높이 조절.
  _wireEgDivider(divEl, box, firstWrap, secondWrap, node) {
    divEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const horiz = node.dir === "h";
      divEl.setPointerCapture(e.pointerId);
      const move = (ev) => {
        let r = horiz ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        r = Math.max(0.12, Math.min(0.88, r));
        node.ratio = r;
        firstWrap.style.flexBasis = r * 100 + "%";
        secondWrap.style.flexBasis = (1 - r) * 100 + "%";
      };
      const up = (ev) => {
        divEl.removeEventListener("pointermove", move);
        divEl.removeEventListener("pointerup", up);
        divEl.removeEventListener("lostpointercapture", up);
        try { divEl.releasePointerCapture(ev.pointerId); } catch (_) {}
        this.groups.forEach((g) => g.cm.refresh());
      };
      divEl.addEventListener("pointermove", move);
      divEl.addEventListener("pointerup", up);
      divEl.addEventListener("lostpointercapture", up);
    });
  }

  _setActiveGroup(id) {
    if (!this.groups.has(id)) return;
    this.activeGroupId = id;
    this.groups.forEach((g) => g.wrap.classList.toggle("focused", g.id === id && this.groups.size > 1));
  }

  toggleTree() {
    this.treeVisible = !this.treeVisible;
    this.treeEl.style.display = this.treeVisible ? "" : "none";
    this.resizer.style.display = this.treeVisible ? "" : "none";
    // 모든 그룹의 탭바 토글 아이콘 동기화(트리는 IDE 하나 공유) — 채운/빈 아이콘으로 표현.
    this.groups.forEach((g) => { if (g.treeToggle) g.treeToggle.innerHTML = icons[this.treeVisible ? "sidebarFilled" : "sidebar"]({ size: 15 }); });
    setTimeout(() => this.groups.forEach((g) => g.cm.refresh()), 0);
  }

  // ── 파일 내부 검색(⌘F/Ctrl+F) — 활성 에디터 그룹 위 플로팅 위젯 ──
  openSearch() {
    const g = this.activeGroup;
    if (!g) return;
    if (this._find && this._find.group === g) { this._find.input.focus(); this._find.input.select(); return; }
    this.closeSearch();
    const bar = document.createElement("div");
    bar.className = "ide-find";
    bar.innerHTML = `
      <span class="ide-find-ic">${icons.search({ size: 13 })}</span>
      <input class="ide-find-input" type="text" placeholder="파일 내 검색" />
      <span class="ide-find-count">0/0</span>
      <button class="ide-find-btn" data-a="prev" title="이전 (⇧Enter)">${icons.chevronUp({ size: 14 })}</button>
      <button class="ide-find-btn" data-a="next" title="다음 (Enter)">${icons.chevronDown({ size: 14 })}</button>
      <button class="ide-find-btn" data-a="close" title="닫기 (Esc)">${icons.x({ size: 14 })}</button>`;
    g.wrap.appendChild(bar);
    const input = bar.querySelector(".ide-find-input");
    const countEl = bar.querySelector(".ide-find-count");
    this._find = { group: g, bar, input, countEl, marks: [], activeMark: null, matches: [], idx: -1 };
    input.addEventListener("input", () => this._runFind());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.closeSearch(); }
    });
    bar.querySelector('[data-a="prev"]').addEventListener("click", () => { this._stepFind(-1); input.focus(); });
    bar.querySelector('[data-a="next"]').addEventListener("click", () => { this._stepFind(1); input.focus(); });
    bar.querySelector('[data-a="close"]').addEventListener("click", () => this.closeSearch());
    const sel = g.cm.getSelection();
    if (sel && sel.length < 100 && !/\n/.test(sel)) input.value = sel;
    setTimeout(() => { input.focus(); input.select(); if (input.value) this._runFind(); }, 0);
  }

  _clearFindMarks() {
    const f = this._find;
    if (!f) return;
    f.marks.forEach((m) => { try { m.clear(); } catch (_) {} });
    f.marks = [];
    if (f.activeMark) { try { f.activeMark.clear(); } catch (_) {} f.activeMark = null; }
  }

  _runFind() {
    const f = this._find;
    if (!f) return;
    const cm = f.group.cm;
    const q = f.input.value;
    this._clearFindMarks();
    f.matches = [];
    f.idx = -1;
    if (!q) { f.countEl.textContent = "0/0"; return; }
    let cur, guard = 0;
    try { cur = cm.getSearchCursor(q, { line: 0, ch: 0 }, { caseFold: true }); } catch (_) { return; }
    while (cur.findNext() && guard < 5000) {
      guard++;
      const from = cur.from(), to = cur.to();
      f.matches.push({ from, to });
      f.marks.push(cm.markText(from, to, { className: "cm-find-match" }));
    }
    if (!f.matches.length) { f.countEl.textContent = "0/0"; return; }
    const head = cm.getCursor("from");
    let start = f.matches.findIndex((m) => CM.cmpPos(m.from, head) >= 0);
    if (start < 0) start = 0;
    this._gotoFind(start);
  }

  _stepFind(dir) {
    const f = this._find;
    if (!f || !f.matches.length) return;
    let i = f.idx + dir;
    if (i < 0) i = f.matches.length - 1;
    if (i >= f.matches.length) i = 0;
    this._gotoFind(i);
  }

  _gotoFind(i) {
    const f = this._find;
    const cm = f.group.cm;
    if (f.activeMark) { try { f.activeMark.clear(); } catch (_) {} f.activeMark = null; }
    f.idx = i;
    const m = f.matches[i];
    try { f.activeMark = cm.markText(m.from, m.to, { className: "cm-find-active" }); } catch (_) {}
    cm.setSelection(m.from, m.to);
    cm.scrollIntoView({ from: m.from, to: m.to }, 80);
    f.countEl.textContent = `${i + 1}/${f.matches.length}`;
  }

  closeSearch() {
    if (!this._find) return;
    this._clearFindMarks();
    const g = this._find.group;
    this._find.bar.remove();
    this._find = null;
    try { g.cm.focus(); } catch (_) {}
  }

  _wireResizer() {
    this.resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.treeEl.getBoundingClientRect().width;
      this.resizer.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing-col");
      const move = (ev) => {
        const w = Math.max(150, Math.min(560, startW + (ev.clientX - startX)));
        this.treeW = w;
        this.treeEl.style.width = w + "px";
      };
      const up = (ev) => {
        this.resizer.removeEventListener("pointermove", move);
        this.resizer.removeEventListener("pointerup", up);
        this.resizer.removeEventListener("lostpointercapture", up);
        document.body.classList.remove("resizing-col");
        try { this.resizer.releasePointerCapture(ev.pointerId); } catch (_) {}
        this.groups.forEach((g) => g.cm.refresh());
      };
      this.resizer.addEventListener("pointermove", move);
      this.resizer.addEventListener("pointerup", up);
      this.resizer.addEventListener("lostpointercapture", up);
    });
  }

  async mount() {
    await this._reload();
    if (this.opts.openPath) {
      const p = this.opts.openPath;
      this.opts.openPath = null;
      this.openFile(p).catch?.(() => {});
    }
  }
  async _reload() {
    try {
      this.tree = await this.fs.fsTree(this.root, 4);
      this.searchTree = null;
      this._renderTree();
    } catch (e) {
      this.treeEl.innerHTML = `<div class="ide-err">${esc(String(e))}</div>`;
    }
  }

  // ── 트리 ──
  _renderTree() {
    this.treeEl.innerHTML = "";
    const hdr = document.createElement("div");
    hdr.className = "ide-tree-hdr";
    const title = document.createElement("span");
    title.className = "ide-tree-title";
    title.textContent = baseName(this.root) || "workspace";
    const acts = document.createElement("div");
    acts.className = "ide-tree-acts";
    const mini = (iconFn, label, fn) => {
      const b = document.createElement("button");
      b.className = "ide-mini"; b.title = label; b.innerHTML = iconFn({ size: 14 });
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    acts.append(
      mini(icons.plus, "새 파일", () => this._startCreate(this.root, false)),
      mini(icons.folder, "새 폴더", () => this._startCreate(this.root, true)),
      mini(icons.refresh, "새로고침", () => { this.tree = null; this.searchTree = null; this._reload(); })
    );
    hdr.append(title, acts);
    const search = document.createElement("div");
    search.className = "ide-search";
    search.innerHTML = `<span class="ide-search-ic">${icons.search({ size: 13 })}</span>`;
    const input = document.createElement("input");
    input.className = "ide-search-input";
    input.placeholder = "프로젝트 전체 검색 (파일 내용)";
    input.value = this.query || "";
    input.addEventListener("input", () => {
      this.query = input.value;
      clearTimeout(this._searchTimer);
      if (!this.query.trim()) { this._renderBody(); return; }
      this._searchTimer = setTimeout(() => this._renderBody(), 220);
    });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { input.value = ""; this.query = ""; clearTimeout(this._searchTimer); this._renderBody(); } });
    search.appendChild(input);
    this.treeEl.append(hdr, search);
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "ide-tree-body";
    this.treeEl.appendChild(this.bodyEl);
    this._renderBody();
  }

  _renderBody() {
    if (!this.bodyEl) return;
    const q = (this.query || "").trim().toLowerCase();
    this.bodyEl.innerHTML = "";
    if (q) { this._renderSearch(q); return; }
    const list = document.createElement("div");
    list.className = "ide-tree-list";
    list.appendChild(this._renderNodes(this.tree || [], 0));
    this.bodyEl.appendChild(list);
  }

  // 프로젝트 전체 텍스트 검색(파일 내용 기반) — 파일별 그룹 + 매칭 줄, 클릭 시 해당 줄로 이동.
  async _renderSearch(q) {
    const token = ++this._searchToken;
    this.bodyEl.innerHTML = `<div class="ide-empty">검색 중…</div>`;
    let hits = [];
    try { hits = await this.fs.fsSearch(this.root, q, 500); } catch (_) { hits = []; }
    if (token !== this._searchToken) return; // 그 사이 쿼리 변경 → 취소
    this.bodyEl.innerHTML = "";
    if (!hits.length) { this.bodyEl.innerHTML = `<div class="ide-empty">일치하는 결과가 없어요</div>`; return; }
    // 파일별 그룹.
    const byFile = new Map();
    for (const h of hits) {
      if (!byFile.has(h.path)) byFile.set(h.path, { name: h.name, list: [] });
      byFile.get(h.path).list.push(h);
    }
    const rootLen = this.root.length + 1;
    const wrap = document.createElement("div");
    wrap.className = "ide-search-results";
    for (const [path, { name, list }] of byFile) {
      const rel = path.slice(rootLen);
      const dir = rel.split("/").slice(0, -1).join("/");
      const lineHits = list.filter((h) => h.line > 0);
      const fh = document.createElement("div");
      fh.className = "ide-search-file";
      fh.innerHTML =
        `<span class="ide-icon">${fileIcon(name, 14)}</span>` +
        `<span class="ide-sf-name">${esc(name)}</span>` +
        (dir ? `<span class="ide-npath">${esc(dir)}</span>` : "") +
        (lineHits.length ? `<span class="ide-sf-count">${lineHits.length}</span>` : "");
      fh.addEventListener("click", () => this.openFile(path));
      wrap.appendChild(fh);
      for (const h of lineHits) {
        const row = document.createElement("div");
        row.className = "ide-search-line";
        row.innerHTML = `<span class="ide-sl-no">${h.line}</span><span class="ide-sl-text">${esc(h.text)}</span>`;
        row.addEventListener("click", () => this.openFile(path, h.line));
        wrap.appendChild(row);
      }
    }
    this.bodyEl.appendChild(wrap);
  }

  _renderNodes(nodes, depth) {
    const activePath = this.activeGroup?.open[this.activeGroup.active]?.path;
    const openPaths = new Set(this._openFilesAll().map((f) => f.path));
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "ide-node" + (n.dir ? " dir" : " file");
      row.style.paddingLeft = 6 + depth * 12 + "px";
      row.dataset.path = n.path;
      row.dataset.dir = n.dir ? "1" : "0";
      row.tabIndex = 0; // 포커스 가능 — 키보드 네비게이션 + Return=이름변경(Finder 시맨틱)
      if (n.path === this.selectedPath) row.classList.add("selected");
      const isOpen = this.expanded.has(n.path);
      if (n.dir) {
        row.innerHTML =
          `<span class="ide-caret${isOpen ? " open" : ""}">${icons.caretRight({ size: 11 })}</span>` +
          `<span class="ide-icon">${folderIcon(isOpen, 16, n.name)}</span>` +
          `<span class="ide-nname">${esc(n.name)}</span>`;
      } else {
        row.innerHTML =
          `<span class="ide-caret ghost"></span>` +
          `<span class="ide-icon">${fileIcon(n.name, 15)}</span>` +
          `<span class="ide-nname">${esc(n.name)}</span>`;
        if (n.path === activePath) row.classList.add("active");
        else if (openPaths.has(n.path)) row.classList.add("opened");
      }
      this._wireNode(row, n, depth);
      frag.appendChild(row);
      if (n.dir) {
        const box = document.createElement("div");
        box.className = "ide-children";
        box.dataset.parent = n.path;
        if (!isOpen) box.style.display = "none";
        else if (n.children) box.appendChild(this._renderNodes(n.children, depth + 1));
        frag.appendChild(box);
      }
    }
    return frag;
  }

  _wireNode(row, n, depth) {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".ide-rename-input")) return;
      this._select(n.path);
      if (n.dir) this._toggleDir(n, row);
      else this.openFile(n.path, undefined, this.activeGroup, false); // 파일은 열되 포커스는 트리에 유지(Return=rename)
      // 클릭 후 포커스를 이 행에 둬 Return/화살표 키가 트리로 온다(파일 열림은 뷰만, 편집은 에디터 클릭).
      row.focus({ preventScroll: true });
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this._select(n.path); this._menu(e, n); });
    row.addEventListener("pointerdown", (e) => { if (e.button === 0 && e.pointerType !== "touch") this._beginNodeDrag(n, e); });
    row.addEventListener("keydown", (e) => this._treeKeydown(e, n, row));
  }

  // 현재 선택 행 표시(선택 모델). rerender 없이 클래스만 토글해 가볍게.
  _select(path) {
    if (this.selectedPath === path) return;
    this.bodyEl?.querySelector(".ide-node.selected")?.classList.remove("selected");
    this.selectedPath = path;
    const row = this.bodyEl?.querySelector(`.ide-node[data-path="${cssEsc(path)}"]`);
    row?.classList.add("selected");
  }

  // 트리 행 키보드 — Return=이름변경(Finder), ↑/↓=행 이동, →/←=폴더 펼침/접기.
  _treeKeydown(e, n, row) {
    if (e.target.closest(".ide-rename-input")) return; // 편집 인풋 내부 키는 그쪽이 처리
    if (e.key === "Enter") {
      if (n.path === this.root) return;
      e.preventDefault();
      this._startRename(n);
      return;
    }
    if (e.key === "ArrowRight" && n.dir && !this.expanded.has(n.path)) { e.preventDefault(); this._toggleDir(n, row); return; }
    if (e.key === "ArrowLeft" && n.dir && this.expanded.has(n.path)) { e.preventDefault(); this._toggleDir(n, row); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...this.bodyEl.querySelectorAll(".ide-node")];
      const i = rows.indexOf(row);
      const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { this._select(next.dataset.path); next.focus({ preventScroll: false }); }
    }
  }

  async _toggleDir(n, row) {
    if (this.expanded.has(n.path)) {
      this.expanded.delete(n.path);
    } else {
      this.expanded.add(n.path);
      if (!n.children) {
        try { n.children = await this.fs.fsTree(n.path, 2); } catch (_) {}
      }
    }
    this._renderTree();
  }

  // ── 파일 열기/편집(그룹). line 주어지면 해당 줄로 이동. ──
  async openFile(path, line, group = this.activeGroup, focusEditor = true) {
    const idx = group.open.findIndex((o) => o.path === path);
    if (idx >= 0) { this._activate(group, idx, focusEditor); if (line) this._jumpTo(group, line); return; }
    try {
      // 같은 파일이 다른 그룹에 열려 있으면 linkedDoc 으로 버퍼 공유 — 그룹별로 편집이 따로 놀아
      //  마지막 저장이 덮어쓰는 문제를 원천 차단(VS Code 동작).
      let doc = null;
      for (const g of this.groups.values()) {
        const e = g.open.find((o) => o.path === path);
        if (e) { doc = e.doc.linkedDoc({ sharedHist: false, mode: modeFor(baseName(path)) }); break; }
      }
      if (!doc) {
        const content = await this.fs.fsRead(path);
        doc = CM.Doc(content, modeFor(baseName(path)));
      }
      group.open.push({ path, doc, dirty: false });
      this._activate(group, group.open.length - 1, focusEditor);
      if (line) this._jumpTo(group, line);
    } catch (e) {
      this._toast(String(e));
    }
  }
  // ── ui.ideDiff — 읽기 전용 가상 diff 문서(CodeMirror 'diff' 모드) ──
  //  실파일이 아니므로 저장(⌘S)/자동저장/디스크 리컨실러 어디에도 태우지 않는다(virtual 플래그로 격리).
  //  같은 path 의 diff 문서가 이미 열려 있으면 내용만 갱신 + 활성화(중복 탭 금지).
  openDiff(path, diffText, group = this.activeGroup) {
    const key = "diff:" + path; // 실파일 경로와 절대 충돌하지 않는 가상 키
    const text = String(diffText || "");
    for (const g of this.groups.values()) {
      const i = g.open.findIndex((o) => o.virtual && o.path === key);
      if (i >= 0) {
        const f = g.open[i];
        // setValue 가 dirty/자동저장을 타지 않게 외부 변경과 동일 가드로 감싼다.
        this._reloadingExternal = true;
        try { f.doc.setValue(text); } finally { this._reloadingExternal = false; }
        this._activate(g, i);
        return;
      }
    }
    const doc = CM.Doc(text, "diff");
    group.open.push({ path: key, label: "diff: " + baseName(path), doc, dirty: false, virtual: true });
    this._activate(group, group.open.length - 1);
  }

  _jumpTo(group, line) {
    setTimeout(() => {
      const l = Math.max(0, (line | 0) - 1);
      try {
        group.cm.setCursor({ line: l, ch: 0 });
        group.cm.scrollIntoView({ line: l, ch: 0 }, 120);
        group.cm.focus();
      } catch (_) {}
    }, 30);
  }
  _activate(group, i, focusEditor = true) {
    if (this._find && this._find.group === group) this.closeSearch();
    group.active = i;
    this._setActiveGroup(group.id);
    const f = group.open[i];
    group.empty.style.display = "none";
    group.editorHost.style.display = "";
    group.cm.swapDoc(f.doc);
    // 가상 diff 문서 = 'diff' 모드 + 읽기 전용. 일반 파일로 돌아오면 반드시 해제.
    group.cm.setOption("mode", f.virtual ? "diff" : modeFor(baseName(f.path)));
    group.cm.setOption("readOnly", f.virtual ? true : false);
    setTimeout(() => group.cm.refresh(), 0);
    this._renderTabs();
    this._renderBody();
    if (focusEditor) group.cm.focus();
  }
  _renderTabs() {
    for (const group of this.groups.values()) this._renderGroupTabs(group);
  }
  _renderGroupTabs(group) {
    group.tablist.innerHTML = "";
    group.open.forEach((f, i) => {
      const t = document.createElement("div");
      t.className = "ide-tab" + (i === group.active ? " active" : "");
      t.innerHTML = `<span class="ide-tab-ic">${fileIcon(baseName(f.path), 13)}</span><span class="ide-tab-name">${esc(f.label || baseName(f.path))}</span>${f.dirty ? '<span class="ide-dirty"></span>' : ""}`;
      const x = document.createElement("span"); x.className = "ide-tab-x"; x.innerHTML = icons.x({ size: 11 });
      x.addEventListener("click", (e) => { e.stopPropagation(); this.closeFile(group, i); });
      t.appendChild(x);
      t.addEventListener("click", () => this._activate(group, i));
      t.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".ide-tab-x")) return;
        e.preventDefault();
        this._beginTabDrag(group, i, e);
      });
      group.tablist.appendChild(t);
    });
  }
  _markDirty(group) {
    if (this._reloadingExternal) return; // 외부 변경 반영(setValue)은 편집이 아님
    const f = group.open[group.active];
    if (!f || f.dirty || f.virtual) return; // 가상 문서(diff)는 dirty/저장 대상이 아님
    // 공유 버퍼(linkedDoc) — 같은 파일을 연 모든 그룹의 dirty 를 함께 표시.
    for (const g of this.groups.values()) {
      let hit = false;
      for (const o of g.open) if (o.path === f.path && !o.dirty) { o.dirty = true; hit = true; }
      if (hit) this._renderGroupTabs(g);
    }
    syncGlobalDirty();
  }
  async save() {
    const group = this.activeGroup;
    const f = group.open[group.active];
    if (!f || f.virtual) return; // 가상 문서(diff)는 ⌘S 무시(실파일 아님)
    const t = this._autoTimers.get(f.path);
    if (t) { clearTimeout(t); this._autoTimers.delete(f.path); }
    const text = f.doc.getValue();
    try {
      await this.fs.fsWrite(f.path, text);
      // 쓰는 동안 추가 편집됐으면 dirty 유지(자동 저장이 이어서 기록).
      if (f.doc.getValue() !== text) { this._scheduleAutosave(f.path); return; }
      this._clearDirty(f.path);
    }
    catch (e) { this._toast(String(e)); }
  }
  // ── 자동 저장 — 마지막 편집 후 800ms 디바운스, 파일(path) 단위 ──
  _scheduleAutosave(path) {
    const t = this._autoTimers.get(path);
    if (t) clearTimeout(t);
    this._autoTimers.set(path, setTimeout(() => { this._autoTimers.delete(path); this._autosave(path).catch(() => {}); }, 800));
  }
  async _autosave(path) {
    let f = null;
    for (const g of this.groups.values()) { f = g.open.find((o) => o.path === path); if (f) break; }
    if (!f || !f.dirty || f.virtual) return;
    const text = f.doc.getValue();
    try { await this.fs.fsWrite(path, text); } catch (e) { this._toast(String(e)); return; }
    if (f.doc.getValue() !== text) { this._scheduleAutosave(path); return; } // 쓰는 동안 추가 편집
    this._clearDirty(path);
  }
  _clearDirty(path) {
    for (const g of this.groups.values()) {
      let hit = false;
      for (const o of g.open) if (o.path === path && o.dirty) { o.dirty = false; hit = true; }
      if (hit) this._renderGroupTabs(g);
    }
    syncGlobalDirty();
  }
  closeFile(group, i) {
    const f = group.open[i];
    // 미저장 편집이 있으면 버리지 않고 플러시(자동 저장 정책 — 편집분 유실 방지).
    if (f && f.dirty) this._autosave(f.path).catch(() => {});
    // linkedDoc 해제(누수 방지) — 남은 쪽 문서는 그대로 유지된다.
    try {
      if (f && f.doc && f.doc.iterLinkedDocs) {
        const linked = [];
        f.doc.iterLinkedDocs((d) => linked.push(d));
        linked.forEach((d) => { try { f.doc.unlinkDoc(d); } catch (_) {} });
      }
    } catch (_) {}
    group.open.splice(i, 1);
    syncGlobalDirty();
    if (group.active >= group.open.length) group.active = group.open.length - 1;
    if (group.active < 0) { group.cm.swapDoc(CM.Doc("", "text/plain")); group.editorHost.style.display = "none"; group.empty.style.display = ""; }
    else this._activate(group, group.active);
    // 빈 그룹은 제거(마지막 하나는 유지).
    if (!group.open.length && this.groups.size > 1) {
      this._removeGroup(group);
      return;
    }
    this._renderGroupTabs(group);
    this._renderBody();
  }
  // ── ui_command(원격 조작) 진입점 — 홈-상대 경로(path)로 열린 파일 제어 ──
  //  ui-channel 이 ws 상대 → 홈-상대(normPath)로 맞춰 넘긴다. 표면(pane/혼합탭) 무관.
  //  열린 파일 탭 하나 닫기 — 활성 그룹 우선, 없으면 아무 그룹에서 찾아 기존 closeFile 로 닫는다.
  closeFileByPath(path) {
    let hit = null;
    const ag = this.activeGroup;
    if (ag) { const i = ag.open.findIndex((o) => o.path === path); if (i >= 0) hit = { group: ag, i }; }
    if (!hit) {
      for (const g of this.groups.values()) {
        const i = g.open.findIndex((o) => o.path === path);
        if (i >= 0) { hit = { group: g, i }; break; }
      }
    }
    if (!hit) return false;
    this.closeFile(hit.group, hit.i);
    return true;
  }
  // 지금 열린 파일 목록(중복 제거) — 활성 그룹의 활성 파일을 active 로 표시. 경로는 홈-상대(f.path).
  // 현재 활성 파일 + 커서 줄(스냅샷 IDE 상태 캡처용). 없으면 null.
  getActiveState() {
    const g = this.activeGroup;
    const f = g && g.open[g.active];
    if (!f || f.virtual) return null; // 가상 문서(diff)는 스냅샷 캡처 대상 아님
    let line = 0;
    try { const c = g.cm && g.cm.getCursor(); if (c && typeof c.line === "number") line = c.line + 1; } catch (_) { /* noop */ }
    return { path: f.path, line };
  }

  listOpenFiles() {
    const g = this.activeGroup;
    const activePath = g && g.open[g.active] ? g.open[g.active].path : null;
    const seen = new Set();
    const list = [];
    for (const gg of this.groups.values()) {
      for (const f of gg.open) {
        if (f.virtual || seen.has(f.path)) continue; // 가상 문서(diff)는 실파일 목록에서 제외
        seen.add(f.path);
        list.push({ path: f.path, active: f.path === activePath });
      }
    }
    return list;
  }

  _removeGroup(group) {
    if (this.groups.size <= 1) return;
    const r = T.closeLeaf(this.egRoot, group.id);
    this.egRoot = r.tree;
    this.groups.delete(group.id);
    try { group.cm.getWrapperElement().remove(); } catch (_) {}
    if (this.activeGroupId === group.id) {
      this.activeGroupId = r.focusId || (this.egRoot ? T.firstLeafId(this.egRoot) : null);
    }
    this._renderEditorArea();
    this._renderTabs();
    this._renderBody();
  }

  // ── 파일 탭 드래그(그룹 내 재배치 / 그룹 간 이동 / 편집영역 분할) ──
  _beginTabDrag(srcGroup, index, e) {
    const f = srcGroup.open[index];
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let dragging = false, ghost = null, drop = null;
    const overlay = document.createElement("div"); overlay.className = "drag-overlay";
    let zoneEl = null, insEl = null;
    const clearInd = () => {
      this.editorAreaEl.querySelectorAll(".ide-tab.drop-before,.ide-tab.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
      zoneEl && zoneEl.classList.add("hidden");
    };
    const start = () => {
      dragging = true;
      document.body.classList.add("tab-dragging");
      try { window.getSelection()?.removeAllRanges(); } catch (_) {}
      document.body.appendChild(overlay);
      try { overlay.setPointerCapture(pid); } catch (_) {}
      ghost = document.createElement("div"); ghost.className = "tab-ghost";
      ghost.innerHTML = `<span class="tg-ic">${fileIcon(baseName(f.path), 13)}</span>${esc(baseName(f.path))}`;
      document.body.appendChild(ghost);
      zoneEl = document.createElement("div"); zoneEl.className = "drop-zone hidden"; document.body.appendChild(zoneEl);
      insEl = document.createElement("div"); insEl.className = "tab-insert hidden"; document.body.appendChild(insEl);
      overlay.addEventListener("pointermove", move);
      overlay.addEventListener("pointerup", up);
      overlay.addEventListener("lostpointercapture", up);
    };
    const move = (ev) => {
      ghost.style.left = ev.clientX + 12 + "px"; ghost.style.top = ev.clientY + 12 + "px";
      overlay.style.pointerEvents = "none";
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      overlay.style.pointerEvents = "";
      clearInd();
      drop = null;
      const groupWrap = el && el.closest && el.closest(".eg");
      if (!groupWrap) { insEl.classList.add("hidden"); return; }
      const g = [...this.groups.values()].find((x) => x.wrap === groupWrap);
      if (!g) return;
      const barR = g.tabsBar.getBoundingClientRect();
      if (ev.clientY <= barR.bottom) {
        // 탭바 위 → 그 그룹의 위치에 삽입(재배치/이동).
        const tabs = [...g.tablist.querySelectorAll(".ide-tab")];
        let ti = tabs.length;
        for (let k = 0; k < tabs.length; k++) { const r = tabs[k].getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) { ti = k; break; } }
        drop = { group: g, mode: "tabbar", index: ti };
        const lineX = ti < tabs.length ? tabs[ti].getBoundingClientRect().left : (tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right : barR.left + 40);
        insEl.style.left = lineX - 1 + "px"; insEl.style.top = barR.top + 3 + "px"; insEl.style.height = barR.height - 6 + "px";
        insEl.classList.remove("hidden");
        return;
      }
      // 편집 영역 → 사분면(좌/우/상/하 28%)은 분할, 가운데는 그 그룹으로 이동.
      const r = g.wrap.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const fy = (ev.clientY - r.top) / r.height;
      const m = Math.min(fx, 1 - fx, fy, 1 - fy);
      let mode = "center", zx = r.left, zy = r.top, zw = r.width, zh = r.height;
      if (m < 0.28) {
        if (m === fx) { mode = "split-left"; zw = r.width / 2; }
        else if (m === 1 - fx) { mode = "split-right"; zx = r.left + r.width / 2; zw = r.width / 2; }
        else if (m === fy) { mode = "split-top"; zh = r.height / 2; }
        else { mode = "split-bottom"; zy = r.top + r.height / 2; zh = r.height / 2; }
      }
      drop = { group: g, mode };
      zoneEl.style.left = zx + "px"; zoneEl.style.top = zy + "px"; zoneEl.style.width = zw + "px"; zoneEl.style.height = zh + "px";
      zoneEl.classList.remove("hidden");
    };
    const up = () => {
      window.removeEventListener("pointermove", preMove, true);
      window.removeEventListener("pointerup", preUp, true);
      overlay.removeEventListener("pointermove", move);
      overlay.removeEventListener("pointerup", up);
      overlay.removeEventListener("lostpointercapture", up);
      overlay.remove(); ghost?.remove(); zoneEl?.remove(); insEl?.remove();
      document.body.classList.remove("tab-dragging");
      if (dragging) {
        this._applyTabDrop(srcGroup, index, drop);
        const sc = (ce) => { ce.stopPropagation(); ce.preventDefault(); window.removeEventListener("click", sc, true); };
        window.addEventListener("click", sc, true);
      }
    };
    const preMove = (ev) => {
      if (dragging) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      start(); move(ev);
    };
    const preUp = () => up();
    window.addEventListener("pointermove", preMove, true);
    window.addEventListener("pointerup", preUp, true);
  }

  _applyTabDrop(srcGroup, index, drop) {
    if (!drop) return;
    const f = srcGroup.open[index];
    if (!f) return;
    if (drop.mode === "tabbar") {
      if (drop.group === srcGroup) {
        let to = drop.index > index ? drop.index - 1 : drop.index;
        to = Math.max(0, Math.min(srcGroup.open.length - 1, to));
        if (to === index) return;
        srcGroup.open.splice(index, 1);
        srcGroup.open.splice(to, 0, f);
        srcGroup.active = to;
        this._renderGroupTabs(srcGroup);
      } else {
        this._moveFile(srcGroup, index, drop.group, drop.index);
      }
      return;
    }
    if (drop.mode === "center") {
      if (drop.group === srcGroup) return;
      this._moveFile(srcGroup, index, drop.group, drop.group.open.length);
      return;
    }
    // 분할(좌/우/상/하): 편집영역 타일링 트리에 새 그룹 삽입 후 파일 이동.
    if (srcGroup === drop.group && srcGroup.open.length <= 1) return; // 자기 자신 단일파일 분할 무의미
    const dir = drop.mode === "split-left" || drop.mode === "split-right" ? "h" : "v";
    const before = drop.mode === "split-left" || drop.mode === "split-top";
    const newG = this._makeGroup();
    const r = T.split(this.egRoot, drop.group.id, dir, newG, before);
    this.egRoot = r.tree;
    this._renderEditorArea();
    const srcIdx = srcGroup.open.indexOf(f);
    this._moveFile(srcGroup, srcIdx, newG, 0);
    this._setActiveGroup(newG.id);
  }

  // 파일을 그룹 간 이동. 같은 Doc 을 두 CodeMirror 에 붙이면 오류나므로,
  //  소스 CM 에서 먼저 떼어낸(다른 doc 로 스왑) 뒤 대상 CM 에 붙인다.
  _moveFile(fromGroup, index, toGroup, insertIndex) {
    if (fromGroup === toGroup) return;
    const f = fromGroup.open[index];
    if (!f) return;
    fromGroup.open.splice(index, 1);
    if (fromGroup.active >= fromGroup.open.length) fromGroup.active = fromGroup.open.length - 1;
    // 소스에서 f.doc 를 해제(다른 파일 활성화 또는 빈 doc 로 스왑).
    if (fromGroup.active < 0) {
      fromGroup.cm.swapDoc(CM.Doc("", "text/plain"));
      fromGroup.editorHost.style.display = "none";
      fromGroup.empty.style.display = "";
    } else {
      this._activate(fromGroup, fromGroup.active);
    }
    // 이제 대상에 붙인다.
    const at = Math.max(0, Math.min(toGroup.open.length, insertIndex));
    toGroup.open.splice(at, 0, f);
    this._activate(toGroup, at);
    if (!fromGroup.open.length && this.groups.size > 1) this._removeGroup(fromGroup);
    this._renderTabs();
    this._renderBody();
  }

  // ── 컨텍스트 메뉴 ──
  _menu(e, n) {
    closeMenu();
    const dirTarget = n.dir ? n.path : parentOf(n.path);
    const items = [];
    items.push(["새 파일", () => this._startCreate(dirTarget, false)]);
    items.push(["새 폴더", () => this._startCreate(dirTarget, true)]);
    if (n.path !== this.root) {
      items.push(["이름 변경", () => this._startRename(n)]);
      items.push(["삭제", () => this._delete(n), "danger"]);
    }
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    for (const [label, fn, cls] of items) {
      const it = document.createElement("div");
      it.className = "ctx-item" + (cls ? " " + cls : "");
      it.textContent = label;
      it.addEventListener("click", () => { closeMenu(); fn(); });
      menu.appendChild(it);
    }
    document.body.appendChild(menu);
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = x + "px"; menu.style.top = y + "px";
    activeMenu = menu;
    setTimeout(() => document.addEventListener("mousedown", closeMenuOnce, true), 0);
  }

  _startCreate(dirPath, isDir) {
    this.expanded.add(dirPath);
    if (this.tree === null) return;
    this.query = "";
    this._renderTree();
    const box = dirPath === this.root ? this.bodyEl.querySelector(".ide-tree-list") : this.bodyEl.querySelector(`.ide-children[data-parent="${cssEsc(dirPath)}"]`);
    if (!box) return;
    if (dirPath !== this.root) box.style.display = "";
    const depth = dirPath === this.root ? 0 : (dirPath.slice(this.root.length).split("/").filter(Boolean).length);
    const row = document.createElement("div");
    row.className = "ide-node new";
    row.style.paddingLeft = 6 + (dirPath === this.root ? 0 : depth) * 12 + "px";
    row.innerHTML = `<span class="ide-caret ghost"></span><span class="ide-icon">${isDir ? folderIcon(false, 15) : fileIcon("x", 15)}</span>`;
    const input = document.createElement("input");
    input.className = "ide-rename-input";
    input.placeholder = isDir ? "폴더 이름" : "파일 이름";
    row.appendChild(input);
    box.prepend(row);
    input.focus();
    const done = async (commit) => {
      const name = input.value.trim();
      row.remove();
      if (!commit || !name) return;
      const dest = dirPath + "/" + name;
      try {
        if (isDir) await this.fs.fsMkdir(dest); else await this.fs.fsCreateFile(dest);
        const node = this._findNode(dirPath);
        if (node) node.children = null;
        await this._reload();
        if (!isDir) this.openFile(dest);
      } catch (e) { this._toast(String(e)); }
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); else if (ev.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
  }

  _startRename(n) {
    const row = this.bodyEl.querySelector(`.ide-node[data-path="${cssEsc(n.path)}"]`);
    if (!row) return;
    const nameEl = row.querySelector(".ide-nname");
    const input = document.createElement("input");
    input.className = "ide-rename-input";
    input.value = n.name;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const done = async (commit) => {
      const name = input.value.trim();
      if (!commit || !name || name === n.name) { this._renderTree(); return; }
      try {
        const dest = parentOf(n.path) + "/" + name;
        await this.fs.fsRename(n.path, dest);
        if (this.selectedPath === n.path) this.selectedPath = dest; // 이름변경 후 선택 유지
        for (const g of this.groups.values()) for (const fo of g.open) if (fo.path === n.path) fo.path = dest;
        const pnode = this._findNode(parentOf(n.path));
        if (pnode) pnode.children = null;
        await this._reload();
        this._renderTabs();
      } catch (e) { this._toast(String(e)); this._renderTree(); }
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); else if (ev.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
  }

  async _delete(n) {
    try {
      await this.fs.fsDelete(n.path);
      for (const g of this.groups.values()) {
        g.open = g.open.filter((f) => f.path !== n.path && !f.path.startsWith(n.path + "/"));
        if (g.active >= g.open.length) g.active = g.open.length - 1;
        if (g.active < 0) { g.editorHost.style.display = "none"; g.empty.style.display = ""; }
      }
      const pnode = this._findNode(parentOf(n.path));
      if (pnode) pnode.children = null;
      await this._reload();
      this._renderTabs();
    } catch (e) { this._toast(String(e)); }
  }

  // ── 파일 DnD 이동 — pointerdown 대상(row)에 즉시 포인터 캡처(CodeMirror 선택 방지) ──
  _beginNodeDrag(n, e) {
    if (n.path === this.root || e.button !== 0) return;
    const row = e.currentTarget;
    if (!row) return;
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let dragging = false, ghost = null, overFolder = null, overRow = null, overTerm = null, overTermEl = null;
    // 실제 pointerdown 이면 캡처 성공(CM 선택 방지). 실패 시 window 로 폴백(그래도 동작).
    let captured = false;
    try { row.setPointerCapture(pid); captured = true; } catch (_) {}
    const tgt = captured ? row : window;
    const opt = captured ? false : true;
    const clearDrop = () => {
      if (overRow) { overRow.classList.remove("drop"); overRow = null; }
      if (overTermEl) { overTermEl.classList.remove("os-drop"); overTermEl = null; }
      overTerm = null;
      this.treeEl.classList.remove("drop-root");
    };
    const start = () => {
      dragging = true;
      document.body.classList.add("tab-dragging");
      try { window.getSelection()?.removeAllRanges(); } catch (_) {}
      ghost = document.createElement("div"); ghost.className = "tab-ghost";
      ghost.innerHTML = `<span class="tg-ic">${fileIcon(n.name, 13)}</span>${esc(n.name)}`;
      document.body.appendChild(ghost);
    };
    const move = (ev) => {
      if (!dragging) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return; start(); }
      ghost.style.left = ev.clientX + 14 + "px"; ghost.style.top = ev.clientY + 14 + "px";
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      clearDrop();
      overFolder = null;
      const tRow = el && el.closest && el.closest(".ide-node.dir");
      const path = tRow && tRow.dataset.path;
      const inTree = el && el.closest && el.closest(".ide-tree");
      if (path && path !== parentOf(n.path) && !path.startsWith(n.path)) {
        // 폴더 위 → 그 폴더로.
        overFolder = path; overRow = tRow; tRow.classList.add("drop");
      } else if (inTree && parentOf(n.path) !== this.root) {
        // 트리 빈 영역/루트 위 → 루트로(폴더 밖으로 빼기). 이미 루트면 대상 없음.
        overFolder = this.root;
        this.treeEl.classList.add("drop-root");
      } else if (!inTree && !n.dir) {
        // 트리 밖 터미널 pane 위 → 파일 경로 삽입(파일만; 폴더는 이동 전용). os-drop 과 동일 히트테스트.
        const tgt = termTargetAt(ev.clientX * (window.devicePixelRatio || 1), ev.clientY * (window.devicePixelRatio || 1));
        if (tgt) { overTerm = tgt; overTermEl = tgt.pane.el; overTermEl.classList.add("os-drop"); }
      }
    };
    const finish = async () => {
      tgt.removeEventListener("pointermove", move, opt);
      tgt.removeEventListener("pointerup", finish, opt);
      row.removeEventListener("lostpointercapture", finish);
      try { row.releasePointerCapture(pid); } catch (_) {}
      clearDrop();
      ghost?.remove();
      document.body.classList.remove("tab-dragging");
      if (dragging) {
        const sc = (ce) => { ce.stopPropagation(); ce.preventDefault(); window.removeEventListener("click", sc, true); };
        window.addEventListener("click", sc, true);
      }
      if (dragging && overTerm) {
        // 파일을 터미널 pane 에 드롭 → 절대경로(원격은 폴백=워크스페이스 상대) 를 터미널에 삽입.
        const t = overTerm;
        try {
          let p = this.fs.fsAbs ? await this.fs.fsAbs(n.path).catch(() => null) : null;
          if (!p) p = n.path.startsWith(this.root + "/") ? n.path.slice(this.root.length + 1) : n.path;
          insertIntoTerminal(t, shq(p) + " ");
        } catch (e) { this._toast(String(e)); }
      } else if (dragging && overFolder) {
        try {
          const dest = overFolder + "/" + n.name;
          await this.fs.fsRename(n.path, dest);
          for (const g of this.groups.values()) for (const fo of g.open) if (fo.path === n.path) fo.path = dest;
          this.tree = null;
          this.searchTree = null;
          this.expanded.add(overFolder);
          await this._reload();
        } catch (e) { this._toast(String(e)); }
      }
    };
    tgt.addEventListener("pointermove", move, opt);
    tgt.addEventListener("pointerup", finish, opt);
    row.addEventListener("lostpointercapture", finish);
  }

  _findNode(path, nodes = this.tree) {
    if (!nodes) return null;
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.dir && n.children) { const f = this._findNode(path, n.children); if (f) return f; }
    }
    return null;
  }

  refresh() { setTimeout(() => this.groups.forEach((g) => g.cm?.refresh()), 0); }
  /** 앱 테마 전환 → 모든 그룹 CM 테마 교체(pane.js onAppearanceChange 가 호출). */
  setTheme(name) { this.groups.forEach((g) => { try { g.cm?.setOption("theme", name); } catch (_) {} }); }

  // ── 외부 변경 리컨실러 — 열린 파일(디스크) ↔ 버퍼 동기화 + 주기적 트리 갱신 ──
  //  dirty(내가 편집 중)인 파일은 보호(마지막 저장 승리 — 모바일 IDE 와 동일 정책).
  async _reconcileDisk() {
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      const seen = new Set(); // 같은 path 는 linkedDoc 공유 — 한 번만
      for (const g of this.groups.values()) {
        for (const f of g.open) {
          if (f.dirty || f.virtual || seen.has(f.path)) continue; // 가상 문서(diff)는 디스크 리컨실 제외
          seen.add(f.path);
          let content;
          try { content = await this.fs.fsRead(f.path); } catch (_) { continue; }
          if (typeof content !== "string" || f.dirty || content === f.doc.getValue()) continue;
          this._applyExternal(f, content);
        }
      }
      // 트리는 6틱(7.2초)마다 — 다른 기기의 새 파일/삭제 반영. 검색 표시 중엔 건너뜀.
      this._syncTick = (this._syncTick + 1) % 6;
      if (this._syncTick === 0 && !this.searchTree) {
        try {
          const t = await this.fs.fsTree(this.root, 4);
          if (JSON.stringify(t) !== JSON.stringify(this.tree)) { this.tree = t; this._renderTree(); }
        } catch (_) { /* noop */ }
      }
    } finally { this._reconciling = false; }
  }
  _applyExternal(f, content) {
    this._reloadingExternal = true;
    try {
      // 이 문서를 표시 중인 그룹들의 커서/스크롤 보존 후 교체(linkedDoc 라 한 번이면 전 그룹 반영)
      const views = [];
      for (const g of this.groups.values()) {
        const cf = g.open[g.active];
        if (cf && cf.path === f.path) views.push({ g, cur: g.cm.getCursor(), sc: g.cm.getScrollInfo() });
      }
      f.doc.setValue(content);
      for (const v of views) { try { v.g.cm.setCursor(v.cur); v.g.cm.scrollTo(v.sc.left, v.sc.top); } catch (_) {} }
    } finally { this._reloadingExternal = false; }
  }

  dispose() {
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
    // 대기 중 자동 저장 즉시 플러시(pane 닫기/앱 종료 시 편집분 유실 방지).
    this._autoTimers.forEach((t) => clearTimeout(t));
    this._autoTimers.clear();
    const seen = new Set();
    for (const g of this.groups.values()) for (const f of g.open) {
      if (f.dirty && !seen.has(f.path)) { seen.add(f.path); this.fs.fsWrite(f.path, f.doc.getValue()).catch(() => {}); }
    }
    _ideInstances.delete(this);
    syncGlobalDirty();
    this.closeSearch(); closeMenu();
  }
  _toast(msg) {
    const d = document.createElement("div"); d.className = "ide-toast"; d.textContent = msg;
    this.mainEl.appendChild(d); setTimeout(() => d.remove(), 2800);
  }
}

// ── 컨텍스트 메뉴 전역 ──
let activeMenu = null;
function closeMenu() { activeMenu?.remove(); activeMenu = null; }
function closeMenuOnce(e) {
  if (activeMenu && !activeMenu.contains(e.target)) { closeMenu(); document.removeEventListener("mousedown", closeMenuOnce, true); }
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }
