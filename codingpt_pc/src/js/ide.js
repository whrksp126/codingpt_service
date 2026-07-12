// ide.js — pane 내장 IDE(VS Code 근사). 파일트리(아이콘·컨텍스트메뉴·DnD·검색) + 에디터 그룹 + 저장.
//  PC 앱이 같은 머신이라 Rust fs 커맨드로 로컬 파일을 직접 다룬다(홈 jail).
//  에디터는 "그룹"으로 분할된다(트리는 하나 공유, 오른쪽 편집 영역만 여러 그룹으로 나눔 — VS Code editor groups).
import { api } from "./api.js";
import { icons } from "./icons.js";
import { fileIcon, folderIcon } from "./fileicons.js";
import * as T from "./tiling.js";

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

export class IdeView {
  constructor(localPath, body, opts = {}) {
    this.root = (localPath || "").replace(/\/+$/, "");
    this.body = body;
    this.opts = opts; // { openPath, paneId, ... }
    this.groups = new Map(); // id → { id, open:[{path,doc,dirty}], active, cm, wrap, tabsBar, tablist, editorHost, empty }
    this.egRoot = null; // 에디터 그룹 타일링 트리(leaf=group, branch={dir,ratio,first,second})
    this.activeGroupId = null;
    this._gseq = 0;
    this.expanded = new Set([this.root]);
    this.treeVisible = true;
    this.tree = null;
    this.searchTree = null;
    this.query = "";
    this._searchToken = 0;
    this._searchTimer = null;
    this._build();
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
    g.tabsBar.append(g.tablist);
    g.editorHost = document.createElement("div");
    g.editorHost.className = "ide-editor";
    g.empty = document.createElement("div");
    g.empty.className = "ide-empty";
    g.empty.textContent = "왼쪽에서 파일을 선택하세요";
    g.wrap.append(g.tabsBar, g.editorHost, g.empty);
    g.cm = CM(g.editorHost, {
      value: "", mode: "javascript", theme: "material-darker",
      lineNumbers: true, autoCloseBrackets: true, matchBrackets: true, styleActiveLine: true,
      indentUnit: 2, tabSize: 2,
      hintOptions: { completeSingle: false },
      extraKeys: {
        "Cmd-S": () => this.save(), "Ctrl-S": () => this.save(),
        "Cmd-/": "toggleComment", "Ctrl-/": "toggleComment",
        "Ctrl-Space": "autocomplete", "Alt-/": "autocomplete",
      },
    });
    g.cm.on("change", () => this._markDirty(g));
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
      this.tree = await api.fsTree(this.root, 4);
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
    try { hits = await api.fsSearch(this.root, q, 500); } catch (_) { hits = []; }
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
      if (n.dir) this._toggleDir(n, row);
      else this.openFile(n.path);
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this._menu(e, n); });
    row.addEventListener("pointerdown", (e) => { if (e.button === 0 && e.pointerType !== "touch") this._beginNodeDrag(n, e); });
  }

  async _toggleDir(n, row) {
    if (this.expanded.has(n.path)) {
      this.expanded.delete(n.path);
    } else {
      this.expanded.add(n.path);
      if (!n.children) {
        try { n.children = await api.fsTree(n.path, 2); } catch (_) {}
      }
    }
    this._renderTree();
  }

  // ── 파일 열기/편집(그룹). line 주어지면 해당 줄로 이동. ──
  async openFile(path, line, group = this.activeGroup) {
    const idx = group.open.findIndex((o) => o.path === path);
    if (idx >= 0) { this._activate(group, idx); if (line) this._jumpTo(group, line); return; }
    try {
      const content = await api.fsRead(path);
      group.open.push({ path, doc: CM.Doc(content, modeFor(baseName(path))), dirty: false });
      this._activate(group, group.open.length - 1);
      if (line) this._jumpTo(group, line);
    } catch (e) {
      this._toast(String(e));
    }
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
  _activate(group, i) {
    if (this._find && this._find.group === group) this.closeSearch();
    group.active = i;
    this._setActiveGroup(group.id);
    const f = group.open[i];
    group.empty.style.display = "none";
    group.editorHost.style.display = "";
    group.cm.swapDoc(f.doc);
    group.cm.setOption("mode", modeFor(baseName(f.path)));
    setTimeout(() => group.cm.refresh(), 0);
    this._renderTabs();
    this._renderBody();
    group.cm.focus();
  }
  _renderTabs() {
    for (const group of this.groups.values()) this._renderGroupTabs(group);
  }
  _renderGroupTabs(group) {
    group.tablist.innerHTML = "";
    group.open.forEach((f, i) => {
      const t = document.createElement("div");
      t.className = "ide-tab" + (i === group.active ? " active" : "");
      t.innerHTML = `<span class="ide-tab-ic">${fileIcon(baseName(f.path), 13)}</span><span class="ide-tab-name">${esc(baseName(f.path))}</span>${f.dirty ? '<span class="ide-dirty"></span>' : ""}`;
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
    const f = group.open[group.active];
    if (f && !f.dirty) { f.dirty = true; this._renderGroupTabs(group); }
  }
  async save() {
    const group = this.activeGroup;
    const f = group.open[group.active];
    if (!f) return;
    try { await api.fsWrite(f.path, f.doc.getValue()); f.dirty = false; this._renderGroupTabs(group); }
    catch (e) { this._toast(String(e)); }
  }
  closeFile(group, i) {
    group.open.splice(i, 1);
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
        if (isDir) await api.fsMkdir(dest); else await api.fsCreateFile(dest);
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
        await api.fsRename(n.path, dest);
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
      await api.fsDelete(n.path);
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
    let dragging = false, ghost = null, overFolder = null, overRow = null;
    // 실제 pointerdown 이면 캡처 성공(CM 선택 방지). 실패 시 window 로 폴백(그래도 동작).
    let captured = false;
    try { row.setPointerCapture(pid); captured = true; } catch (_) {}
    const tgt = captured ? row : window;
    const opt = captured ? false : true;
    const clearDrop = () => {
      if (overRow) { overRow.classList.remove("drop"); overRow = null; }
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
      const tRow = el && el.closest && el.closest(".ide-node.dir");
      const path = tRow && tRow.dataset.path;
      if (path && path !== parentOf(n.path) && !path.startsWith(n.path)) {
        // 폴더 위 → 그 폴더로.
        overFolder = path; overRow = tRow; tRow.classList.add("drop");
      } else if (el && el.closest && el.closest(".ide-tree") && parentOf(n.path) !== this.root) {
        // 트리 빈 영역/루트 위 → 루트로(폴더 밖으로 빼기). 이미 루트면 대상 없음.
        overFolder = this.root;
        this.treeEl.classList.add("drop-root");
      } else {
        overFolder = null;
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
      if (dragging && overFolder) {
        try {
          const dest = overFolder + "/" + n.name;
          await api.fsRename(n.path, dest);
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
  dispose() { this.closeSearch(); closeMenu(); }
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
