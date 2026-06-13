import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import {
  DeviceMobile, Folder, File as FileIcon, FilePlus, FolderPlus, UploadSimple,
  CaretRight, CaretDown, X, ArrowsClockwise, FloppyDisk,
  FileHtml, FileCss, FileJs, FileJsx, FileTs, FileTsx, FilePy,
  FileCode, FileMd, FileC, FileCpp, FileSql, BracketsCurly, FileImage,
} from '@phosphor-icons/react';
import MonacoField from './modules/_shared/MonacoField';
import * as ideApi from '../../../utils/ideSourceApi';

// 모바일 IDE 소스 관리 패널 — objectstore `codingpt/execute/ide/<projectId>/` 의 실제 프로젝트 소스를
// 트리/탭/Monaco 로 편집. 구조 변경(생성/삭제/이름변경/업로드)은 즉시 objectstore 반영,
// 텍스트 편집은 로컬에서 하다가 저장 시 일괄 PUT. GitHub 산출물 패널과 동일한 VS Code 스타일.

const FILE_ICONS = {
  html: [FileHtml, 'text-orange-500'], htm: [FileHtml, 'text-orange-500'],
  css: [FileCss, 'text-blue-500'],
  js: [FileJs, 'text-amber-500'], mjs: [FileJs, 'text-amber-500'], cjs: [FileJs, 'text-amber-500'],
  jsx: [FileJsx, 'text-amber-500'],
  ts: [FileTs, 'text-blue-600'], tsx: [FileTsx, 'text-blue-600'],
  py: [FilePy, 'text-blue-500'],
  json: [BracketsCurly, 'text-amber-600'],
  md: [FileMd, 'text-slate-500'],
  java: [FileCode, 'text-red-500'],
  c: [FileC, 'text-blue-500'], h: [FileC, 'text-blue-500'],
  cpp: [FileCpp, 'text-blue-500'], cc: [FileCpp, 'text-blue-500'], hpp: [FileCpp, 'text-blue-500'],
  sql: [FileSql, 'text-teal-600'],
  png: [FileImage, 'text-emerald-500'], jpg: [FileImage, 'text-emerald-500'], jpeg: [FileImage, 'text-emerald-500'],
  gif: [FileImage, 'text-emerald-500'], webp: [FileImage, 'text-emerald-500'], svg: [FileImage, 'text-emerald-500'],
  ico: [FileImage, 'text-emerald-500'],
};
const fileIconFor = (name) => {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  const [Icon, color] = FILE_ICONS[ext] || [FileIcon, 'text-slate-400'];
  return { Icon, color };
};

const extToLang = (path) => {
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  const map = {
    html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python',
    java: 'java', json: 'json', md: 'markdown', xml: 'xml', svg: 'xml', sql: 'sql',
  };
  return map[ext] || 'plaintext';
};

const GITKEEP = '.gitkeep';
const normPath = (p) =>
  String(p || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

// 파일 경로 배열(+ 생성중 draft) → 중첩 트리
const buildTree = (paths, draft) => {
  const root = { name: '', path: '', dir: true, children: {} };
  const ensureDir = (dirPath) => {
    if (!dirPath) return root;
    const parts = dirPath.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const cp = parts.slice(0, i + 1).join('/');
      if (!node.children[part] || !node.children[part].dir) {
        node.children[part] = { name: part, path: cp, dir: true, children: {} };
      }
      node = node.children[part];
    });
    return node;
  };
  paths.forEach((p) => {
    const parts = normPath(p).split('/').filter(Boolean);
    if (parts.length === 0) return;
    const parent = ensureDir(parts.slice(0, -1).join('/'));
    const name = parts[parts.length - 1];
    parent.children[name] = { name, path: normPath(p), dir: false };
  });
  if (draft) {
    const parent = ensureDir(draft.parent);
    parent.children[' draft'] = { name: '', path: ' draft', draft: true, dir: draft.kind === 'folder' };
  }
  return root;
};

const sortedChildren = (node) =>
  Object.values(node.children).sort((a, b) => {
    if (a.draft) return -1;
    if (b.draft) return 1;
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

const MobileIdePanel = ({
  projectId, projectName, entryFile, onChangeMeta, onClose,
  initialTabs, activeTab, highlights: savedHighlights,
}) => {
  const [paths, setPaths] = useState([]); // 상대경로 파일 목록 (.gitkeep 포함)
  const [contentCache, setContentCache] = useState({}); // { relPath: text }
  const [dirty, setDirty] = useState({}); // { relPath: true }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const [selectedPath, setSelectedPath] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);

  // ── 하이라이트(학습자 IDE 에서 강조할 구간) ──
  // { '경로': [{ startLine, startColumn, endLine, endColumn }] }. Monaco 선택영역(1-based) 그대로 보존.
  const [highlights, setHighlights] = useState(savedHighlights || {});
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const monacoRef = useRef(null);     // 현재 마운트된 Monaco editor
  const monacoPathRef = useRef(null); // 그 editor 가 보여주는 파일 경로
  const decoRef = useRef([]);         // 적용된 데코레이션 id 들
  const initedRef = useRef(false);    // 저장된 탭/활성 1회 복원 가드
  const [activeDir, setActiveDir] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [edit, setEdit] = useState(null); // { mode:'create'|'rename', kind:'file'|'folder', parent?, path? }
  const [editValue, setEditValue] = useState('');
  const fileInputRef = useRef(null);

  // 우클릭 컨텍스트 메뉴 / 드래그앤드롭
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, kind:'file'|'folder'|'root', node? }
  const closeCtx = () => setCtxMenu(null);
  const openCtx = (e, kind, node) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, kind, node });
  };
  const [dropTarget, setDropTarget] = useState(null); // 드롭 대상 폴더 경로 ('' = 루트, null = 없음)
  const dragRef = useRef(null); // 드래그 중인 노드 { path, dir }
  const tabDragRef = useRef(null); // 드래그 중인 탭 경로
  const [tabDragOver, setTabDragOver] = useState(null); // 드래그 중 삽입 위치(이 탭 앞)

  // 이미지 프리뷰 캐시 { relPath: dataUrl }
  const [imgCache, setImgCache] = useState({});

  const htmlFiles = useMemo(() => paths.filter((p) => /\.html?$/i.test(p)), [paths]);

  useEffect(() => {
    if (!ctxMenu) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctxMenu]);

  // 탭 순서 변경: from 탭을 to 탭 위치 앞으로 이동
  const reorderTabs = (from, to) => {
    if (!from || from === to) return;
    setOpenTabs((t) => {
      const arr = t.filter((p) => p !== from);
      const idx = arr.indexOf(to);
      if (idx < 0) return t;
      arr.splice(idx, 0, from);
      return arr;
    });
  };

  const isImagePath = (p) => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(String(p || ''));

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const files = await ideApi.listProject(projectId);
      setPaths(files.map((f) => f.path));
    } catch (e) {
      // 빈 프로젝트(아직 파일 없음)는 정상 — 빈 목록으로 처리
      if (e.status === 404) setPaths([]);
      else setErr(e.message || '목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const tree = useMemo(
    () => buildTree(paths, edit && edit.mode === 'create' ? edit : null),
    [paths, edit],
  );

  const isTextSel = selectedPath && ideApi.isTextPath(selectedPath);

  const openFile = async (path) => {
    setSelectedPath(path);
    setActiveDir(dirOf(path));
    if (isImagePath(path)) {
      // 이미지는 탭으로 열고 프리뷰(data URL) 로드
      setOpenTabs((t) => (t.includes(path) ? t : [...t, path]));
      if (imgCache[path] === undefined) {
        try {
          const url = await ideApi.getBinaryDataUrl(projectId, path);
          setImgCache((c) => ({ ...c, [path]: url }));
        } catch (e) {
          setImgCache((c) => ({ ...c, [path]: null }));
        }
      }
      return;
    }
    if (!ideApi.isTextPath(path)) return; // 기타 바이너리는 편집 불가
    setOpenTabs((t) => (t.includes(path) ? t : [...t, path]));
    if (contentCache[path] === undefined) {
      try {
        const content = await ideApi.getContent(projectId, path);
        setContentCache((c) => ({ ...c, [path]: content }));
      } catch (e) {
        setContentCache((c) => ({ ...c, [path]: `// 불러오기 실패: ${e.message}` }));
      }
    }
  };

  const closeTab = (path, e) => {
    if (e) e.stopPropagation();
    setOpenTabs((t) => {
      const idx = t.indexOf(path);
      const next = t.filter((p) => p !== path);
      if (selectedPath === path) setSelectedPath(next[idx] || next[idx - 1] || null);
      return next;
    });
  };

  const setFileContent = (path, val) => {
    setContentCache((c) => ({ ...c, [path]: val }));
    setDirty((d) => ({ ...d, [path]: true }));
  };

  // 저장된 탭/활성 탭 1회 복원 — 파일 목록 로드 완료 후.
  useEffect(() => {
    if (initedRef.current || loading) return;
    initedRef.current = true;
    const valid = (initialTabs || []).filter((p) => paths.includes(p));
    if (valid.length) {
      setOpenTabs(valid);
      const act = activeTab && valid.includes(activeTab) ? activeTab : valid[0];
      if (act) openFile(act);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── 하이라이트 데코레이션/추가/제거 ──
  const applyDecorations = (editor, path) => {
    if (!editor) return;
    const ranges = highlightsRef.current[path] || [];
    const decos = ranges.map((r) => ({
      range: { startLineNumber: r.startLine, startColumn: r.startColumn, endLineNumber: r.endLine, endColumn: r.endColumn },
      options: { className: 'cpt-hl-range', inlineClassName: 'cpt-hl-range' },
    }));
    decoRef.current = editor.deltaDecorations(decoRef.current, decos);
  };

  const addHighlight = (path, range) => {
    setHighlights((h) => {
      const arr = h[path] || [];
      const dup = arr.some((x) => x.startLine === range.startLine && x.startColumn === range.startColumn && x.endLine === range.endLine && x.endColumn === range.endColumn);
      const merged = { ...h, [path]: dup ? arr : [...arr, range] };
      highlightsRef.current = merged;
      if (monacoPathRef.current === path) applyDecorations(monacoRef.current, path);
      return merged;
    });
  };

  // 커서/선택이 걸친 하이라이트 제거
  const removeHighlightAt = (path, line, col) => {
    setHighlights((h) => {
      const arr = h[path] || [];
      const after = (a, b) => (a.line > b.line || (a.line === b.line && a.col >= b.col));
      const before = (a, b) => (a.line < b.line || (a.line === b.line && a.col <= b.col));
      const next = arr.filter((r) => !(
        after({ line, col }, { line: r.startLine, col: r.startColumn }) &&
        before({ line, col }, { line: r.endLine, col: r.endColumn })
      ));
      const merged = { ...h };
      if (next.length) merged[path] = next; else delete merged[path];
      highlightsRef.current = merged;
      if (monacoPathRef.current === path) applyDecorations(monacoRef.current, path);
      return merged;
    });
  };

  // Monaco 준비 시: 우클릭 메뉴 액션 등록 + 기존 하이라이트 데코레이션 렌더
  const setupHighlightEditor = (editor, path) => {
    monacoRef.current = editor;
    monacoPathRef.current = path;
    decoRef.current = [];
    editor.addAction({
      id: 'cpt-add-highlight',
      label: '🟡 하이라이트 추가',
      contextMenuGroupId: 'cpt',
      contextMenuOrder: 1,
      run: (ed) => {
        const sel = ed.getSelection();
        if (!sel) return;
        const range = sel.isEmpty()
          ? { startLine: sel.startLineNumber, startColumn: 1, endLine: sel.startLineNumber, endColumn: ed.getModel().getLineMaxColumn(sel.startLineNumber) }
          : { startLine: sel.startLineNumber, startColumn: sel.startColumn, endLine: sel.endLineNumber, endColumn: sel.endColumn };
        addHighlight(path, range);
      },
    });
    editor.addAction({
      id: 'cpt-remove-highlight',
      label: '🚫 하이라이트 제거(이 위치)',
      contextMenuGroupId: 'cpt',
      contextMenuOrder: 2,
      run: (ed) => {
        const pos = ed.getPosition();
        if (pos) removeHighlightAt(path, pos.lineNumber, pos.column);
      },
    });
    applyDecorations(editor, path);
  };

  // 콘텐츠가 비동기로 로드되면 Monaco 가 setValue 로 모델을 교체하며 데코레이션이 지워진다.
  // → 활성 파일의 콘텐츠/하이라이트가 바뀔 때마다 데코레이션을 재적용(처음 열 때부터 보이도록).
  const activeContent = contentCache[selectedPath];
  useEffect(() => {
    if (monacoRef.current && monacoPathRef.current === selectedPath) {
      applyDecorations(monacoRef.current, selectedPath);
    }
  }, [selectedPath, activeContent, highlights]);

  // ── 저장 (dirty 텍스트 일괄 PUT) — 보기상태 메타는 여기서 기록하지 않음(완료/닫기로도 호출되므로) ──
  const saveAll = async () => {
    const targets = Object.keys(dirty).filter((p) => dirty[p]);
    if (targets.length === 0) return true;
    setSaving(true);
    try {
      for (const p of targets) {
        await ideApi.saveText(projectId, p, contentCache[p] ?? '');
      }
      setDirty({});
      return true;
    } catch (e) {
      setErr(`저장 실패: ${e.message}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleClose = async () => {
    const ok = await saveAll();
    if (ok) onClose();
  };

  // 저장 버튼 — 텍스트 저장 + 보기 상태(탭/활성/하이라이트)를 모듈 ide 메타에 기록.
  // 이 버튼을 눌러야만 상태가 유지된다(완료/닫기만으로는 메타 미기록 → 이전 상태 유지).
  const [savedFlash, setSavedFlash] = useState(false);
  const handleSave = async () => {
    onChangeMeta({ initialTabs: openTabs, activeTab: selectedPath || undefined, highlights });
    const ok = await saveAll();
    if (ok) { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500); }
  };

  // ── 인라인 생성/이름변경 ──
  const startCreate = (kind, parent = activeDir) => { setEdit({ mode: 'create', kind, parent }); setEditValue(''); };
  const startRename = (node) => {
    setEdit({ mode: 'rename', kind: node.dir ? 'folder' : 'file', path: node.path });
    setEditValue(node.name);
  };
  const cancelEdit = () => { setEdit(null); setEditValue(''); };

  const commitEdit = async () => {
    const e = edit;
    if (!e) return;
    const v = normPath(editValue);
    if (!v) { cancelEdit(); return; }
    cancelEdit();
    try {
      if (e.mode === 'create') {
        const base = e.parent ? `${e.parent}/` : '';
        if (e.kind === 'folder') {
          await ideApi.createFolder(projectId, normPath(base + v));
        } else {
          const filePath = normPath(base + v);
          await ideApi.saveText(projectId, filePath, '');
          await refresh();
          openFile(filePath);
          return;
        }
      } else if (e.kind === 'file' || e.kind === 'folder') {
        await ideApi.renamePath(projectId, e.path, baseOf(v), e.kind === 'folder');
      }
      await refresh();
    } catch (ex) {
      setErr(ex.message || '작업 실패');
    }
  };

  const removeNode = async (node) => {
    if (!confirm(`"${node.path}" ${node.dir ? '폴더와 그 안의 모든 파일을' : '파일을'} 삭제할까요?`)) return;
    try {
      await ideApi.deletePath(projectId, node.path, node.dir);
      setOpenTabs((t) => t.filter((p) => p !== node.path && !p.startsWith(`${node.path}/`)));
      if (selectedPath === node.path) setSelectedPath(null);
      await refresh();
    } catch (ex) {
      setErr(ex.message || '삭제 실패');
    }
  };

  // ── 드래그앤드롭 이동 (파일/폴더를 다른 폴더로) ──
  const moveItems = async (node, targetDir) => {
    if (!node) return;
    const p = node.path;
    const isDir = node.dir;
    const td = targetDir || '';
    if (dirOf(p) === td) return; // 제자리
    if (isDir && (td === p || td.startsWith(`${p}/`))) return; // 자기 자신/하위 금지
    const newPath = (td ? `${td}/` : '') + baseOf(p);
    const remap = (path) => {
      if (isDir) {
        if (path === p) return newPath;
        if (path.startsWith(`${p}/`)) return newPath + path.slice(p.length);
      } else if (path === p) return newPath;
      return path;
    };
    try {
      await ideApi.movePath(projectId, p, td, isDir);
      setOpenTabs((t) => t.map(remap));
      if (selectedPath) setSelectedPath(remap(selectedPath));
      setActiveDir((d) => remap(d));
      await refresh();
    } catch (ex) {
      setErr(ex.message || '이동 실패');
    }
  };
  const onDropTo = (targetDir, e) => {
    e.preventDefault();
    e.stopPropagation();
    const node = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (node) moveItems(node, targetDir);
  };

  // ── 파일 복제 ──
  const duplicateNode = async (node) => {
    if (!node || node.dir) return;
    const p = node.path;
    const dot = p.lastIndexOf('.');
    const slash = p.lastIndexOf('/');
    const mk = (suffix) => (dot > slash ? `${p.slice(0, dot)}${suffix}${p.slice(dot)}` : `${p}${suffix}`);
    let cand = mk(' copy');
    let n = 1;
    while (paths.includes(cand)) { cand = mk(` copy ${n}`); n += 1; }
    try {
      await ideApi.copyFile(projectId, p, cand);
      await refresh();
      openFile(cand);
    } catch (ex) {
      setErr(ex.message || '복제 실패');
    }
  };

  const onUpload = async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (files.length === 0) return;
    try {
      for (const f of files) {
        await ideApi.uploadBinary(projectId, activeDir, f);
      }
      await refresh();
    } catch (ex) {
      setErr(ex.message || '업로드 실패');
    }
  };

  // ── 인라인 입력 ──
  const renderInput = () => (
    <input
      autoFocus
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') cancelEdit(); }}
      onBlur={commitEdit}
      placeholder={edit?.kind === 'folder' ? '폴더명' : '파일명 (예: app.js)'}
      className="w-full rounded border border-cyan-400 px-1 py-0.5 font-mono text-xs focus:outline-none"
    />
  );

  // ── 트리 렌더 ──
  const renderNode = (node, depth = 0) =>
    sortedChildren(node).map((child) => {
      if (child.draft) {
        const DraftIcon = child.dir ? null : fileIconFor(editValue).Icon;
        return (
          <div key="__draft" className="flex items-center gap-1 px-1 py-0.5" style={{ paddingLeft: depth * 12 + 4 }}>
            {child.dir ? <Folder size={14} weight="fill" className="text-amber-500" />
              : <DraftIcon size={14} className={fileIconFor(editValue).color} />}
            {renderInput()}
          </div>
        );
      }
      const isEditing = edit && edit.mode === 'rename' && edit.path === child.path;
      if (child.dir) {
        const isCollapsed = collapsed[child.path];
        const isActive = activeDir === child.path;
        return (
          <div key={`d:${child.path}`}>
            <div
              draggable={!isEditing}
              onDragStart={(e) => { dragRef.current = { path: child.path, dir: true }; e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(child.path); }}
              onDrop={(e) => onDropTo(child.path, e)}
              className={`flex items-center gap-1 rounded px-1 py-0.5 text-sm cursor-pointer ${dropTarget === child.path ? 'bg-cyan-100 ring-2 ring-inset ring-cyan-400' : isActive ? 'bg-cyan-50' : 'hover:bg-slate-100'}`}
              style={{ paddingLeft: depth * 12 + 4 }}
              onClick={() => { if (isEditing) return; setActiveDir(child.path); setCollapsed((c) => ({ ...c, [child.path]: !c[child.path] })); }}
              onContextMenu={(e) => openCtx(e, 'folder', child)}
            >
              {isCollapsed ? <CaretRight size={12} className="text-slate-400" /> : <CaretDown size={12} className="text-slate-400" />}
              <Folder size={14} weight="fill" className="text-amber-500" />
              {isEditing ? renderInput() : <span className="flex-1 truncate text-slate-700">{child.name}</span>}
            </div>
            {!isCollapsed && renderNode(child, depth + 1)}
          </div>
        );
      }
      if (child.name === GITKEEP) return null; // 빈 폴더 보존용 — 숨김
      const isSel = selectedPath === child.path;
      const { Icon: FIcon, color: fColor } = fileIconFor(child.name);
      const isDirty = dirty[child.path];
      return (
        <div
          key={`f:${child.path}`}
          draggable={!isEditing}
          onDragStart={(e) => { dragRef.current = { path: child.path, dir: false }; e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(dirOf(child.path)); }}
          onDrop={(e) => onDropTo(dirOf(child.path), e)}
          className={`flex items-center gap-1 rounded px-1 py-0.5 text-sm cursor-pointer ${isSel ? 'bg-cyan-100 text-cyan-900' : 'text-slate-700 hover:bg-slate-100'}`}
          style={{ paddingLeft: depth * 12 + 16 }}
          onClick={() => { if (!isEditing) openFile(child.path); }}
          onContextMenu={(e) => openCtx(e, 'file', child)}
        >
          <FIcon size={14} className={`shrink-0 ${fColor}`} />
          {isEditing ? renderInput() : <span className="flex-1 truncate">{child.name}{isDirty ? ' •' : ''}</span>}
        </div>
      );
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleClose}>
      <div className="flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <DeviceMobile size={22} weight="fill" className="text-slate-800" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">모바일 IDE 소스</h2>
              <p className="text-xs text-slate-500">학습자가 모바일 IDE에서 열어볼 실제 프로젝트 소스입니다. 변경 시 objectstore에 저장됩니다.</p>
            </div>
          </div>
          <button type="button" onClick={handleClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18} weight="bold" /></button>
        </div>

        {/* 상단 컨트롤: 프로젝트명 / 진입 파일 */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">작업영역 이름</span>
            <input
              value={projectName || ''}
              onChange={(e) => onChangeMeta({ projectName: e.target.value })}
              placeholder="예: html 기초"
              className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">진입 파일(프리뷰)</span>
            <select
              value={entryFile || ''}
              onChange={(e) => onChangeMeta({ entryFile: e.target.value })}
              className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-cyan-500 focus:outline-none"
            >
              <option value="">자동 (index.html)</option>
              {htmlFiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {err && <span className="text-xs text-red-500">{err}</span>}
        </div>

        {/* 본문 */}
        <div className="flex min-h-0 flex-1">
          {/* 좌측 트리 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
            <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
              <span className="flex items-center gap-1 truncate text-xs font-semibold text-slate-500">
                {activeDir ? <><Folder size={13} weight="fill" className="text-amber-500" />{activeDir}</> : (projectName || '작업영역')}
              </span>
              <div className="ml-auto flex gap-1">
                <button type="button" onClick={() => startCreate('file')} title="새 파일" className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-200"><FilePlus size={14} /></button>
                <button type="button" onClick={() => startCreate('folder')} title="새 폴더" className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-200"><FolderPlus size={14} /></button>
                <button type="button" onClick={() => fileInputRef.current?.click()} title="파일 업로드" className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-200"><UploadSimple size={14} /></button>
                <button type="button" onClick={refresh} title="새로고침" className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-200"><ArrowsClockwise size={14} /></button>
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onUpload} />
            </div>
            <div
              className={`flex-1 overflow-y-auto p-1 outline-none ${dropTarget === '' ? 'ring-1 ring-inset ring-cyan-400' : ''}`}
              onContextMenu={(e) => openCtx(e, 'root', null)}
              onDragOver={(e) => { e.preventDefault(); setDropTarget(''); }}
              onDrop={(e) => onDropTo('', e)}
            >
              <div className={`mb-1 rounded px-1 py-0.5 text-xs cursor-pointer ${activeDir === '' ? 'bg-cyan-50 text-cyan-700' : 'text-slate-400'}`}
                onClick={() => setActiveDir('')}>／ {projectName || '작업영역'}</div>
              {loading ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">불러오는 중…</p>
              ) : paths.length === 0 && !edit ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">파일이 없습니다.<br />상단의 파일/폴더로 추가하세요.</p>
              ) : renderNode(tree)}
            </div>
          </div>

          {/* 우측: 탭 + 에디터 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {openTabs.length > 0 && (
              <div className="flex shrink-0 items-center overflow-x-auto border-b border-slate-200 bg-slate-100">
                {openTabs.map((p) => {
                  const active = p === selectedPath;
                  const { Icon: TIcon, color: tColor } = fileIconFor(baseOf(p));
                  const showInsert = tabDragOver === p && tabDragRef.current && tabDragRef.current !== p;
                  return (
                    <div key={p} onClick={() => openFile(p)} title={p}
                      draggable
                      onDragStart={(e) => { tabDragRef.current = p; e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => { if (tabDragRef.current) { e.preventDefault(); setTabDragOver(p); } }}
                      onDrop={(e) => { e.preventDefault(); reorderTabs(tabDragRef.current, p); tabDragRef.current = null; setTabDragOver(null); }}
                      onDragEnd={() => { tabDragRef.current = null; setTabDragOver(null); }}
                      className={`group relative flex shrink-0 items-center gap-1.5 border-r border-slate-200 px-3 py-1.5 text-xs cursor-pointer ${active ? 'bg-white text-slate-900' : 'text-slate-500 hover:bg-slate-50'}`}>
                      {showInsert && <span className="pointer-events-none absolute left-0 top-0 h-full w-0.5 bg-cyan-500" />}
                      <TIcon size={12} className={tColor} />
                      <span>{baseOf(p)}{dirty[p] ? ' •' : ''}</span>
                      <button type="button" onClick={(e) => closeTab(p, e)} className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={11} weight="bold" /></button>
                    </div>
                  );
                })}
              </div>
            )}
            {isTextSel ? (
              <div className="min-h-0 flex-1 p-2">
                <MonacoField
                  key={selectedPath}
                  value={contentCache[selectedPath] ?? ''}
                  onChange={(val) => setFileContent(selectedPath, val)}
                  language={extToLang(selectedPath)}
                  height={'100%'}
                  disableAutoFormat
                  onReady={(editor) => setupHighlightEditor(editor, selectedPath)}
                />
              </div>
            ) : selectedPath && isImagePath(selectedPath) ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto bg-slate-50 p-4">
                {imgCache[selectedPath] === undefined ? (
                  <span className="text-sm text-slate-400">불러오는 중…</span>
                ) : imgCache[selectedPath] ? (
                  <>
                    <img src={imgCache[selectedPath]} alt={baseOf(selectedPath)} className="max-h-full max-w-full object-contain" />
                    <span className="text-xs text-slate-400">{baseOf(selectedPath)}</span>
                  </>
                ) : (
                  <span className="text-sm text-red-400">이미지를 불러오지 못했습니다.</span>
                )}
              </div>
            ) : selectedPath ? (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                이미지/바이너리 파일은 편집할 수 없습니다. (프리뷰에서 렌더됩니다)
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                왼쪽에서 파일을 선택하거나 새로 만드세요.
              </div>
            )}
          </div>
        </div>

        {/* 푸터 */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          {savedFlash && <span className="text-xs font-medium text-emerald-600">저장됨 — 탭·하이라이트 상태 기록</span>}
          <button type="button" onClick={handleSave} disabled={saving}
            className="flex items-center gap-1 rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            <FloppyDisk size={15} /> {saving ? '저장 중…' : '저장'}
          </button>
          <button type="button" onClick={handleClose}
            className="rounded bg-slate-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-900">완료</button>
        </div>
      </div>

      {/* 우클릭 컨텍스트 메뉴 */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={(e) => { e.stopPropagation(); closeCtx(); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); closeCtx(); }}
          />
          <div
            className="fixed z-[61] min-w-[160px] overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.kind === 'file' && (
              <>
                <CtxItem onClick={() => { openFile(ctxMenu.node.path); closeCtx(); }}>열기</CtxItem>
                <CtxItem onClick={() => { startRename(ctxMenu.node); closeCtx(); }}>이름 변경</CtxItem>
                <CtxItem onClick={() => { duplicateNode(ctxMenu.node); closeCtx(); }}>복제</CtxItem>
                <div className="my-1 border-t border-slate-100" />
                <CtxItem danger onClick={() => { removeNode(ctxMenu.node); closeCtx(); }}>삭제</CtxItem>
              </>
            )}
            {ctxMenu.kind === 'folder' && (
              <>
                <CtxItem onClick={() => { startCreate('file', ctxMenu.node.path); closeCtx(); }}>새 파일</CtxItem>
                <CtxItem onClick={() => { startCreate('folder', ctxMenu.node.path); closeCtx(); }}>새 폴더</CtxItem>
                <CtxItem onClick={() => { startRename(ctxMenu.node); closeCtx(); }}>이름 변경</CtxItem>
                <div className="my-1 border-t border-slate-100" />
                <CtxItem danger onClick={() => { removeNode(ctxMenu.node); closeCtx(); }}>삭제</CtxItem>
              </>
            )}
            {ctxMenu.kind === 'root' && (
              <>
                <CtxItem onClick={() => { startCreate('file', ''); closeCtx(); }}>새 파일</CtxItem>
                <CtxItem onClick={() => { startCreate('folder', ''); closeCtx(); }}>새 폴더</CtxItem>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// 컨텍스트 메뉴 항목
const CtxItem = ({ onClick, danger, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`block w-full px-3 py-1.5 text-left hover:bg-slate-100 ${danger ? 'text-red-600' : 'text-slate-700'}`}
  >
    {children}
  </button>
);

export default MobileIdePanel;
