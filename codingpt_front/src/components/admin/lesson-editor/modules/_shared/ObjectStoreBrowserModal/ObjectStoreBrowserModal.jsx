import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  ArrowLeft,
  FolderPlus,
  UploadSimple,
  PencilSimple,
  Trash,
  ArrowsOutCardinal,
  ArrowClockwise,
  Copy,
  Scissors,
  ClipboardText,
  Plus,
} from '@phosphor-icons/react';
import Breadcrumb from './Breadcrumb';
import FileGrid from './FileGrid';
import {
  LESSON_ASSETS_ROOT,
  OBJECTSTORE_BASE_URL,
  listFolder,
  uploadFile,
  createFolder as apiCreateFolder,
  deleteItem,
  renameItem,
  moveItem,
  copyItem,
  isAcceptedFile,
  keyToUrl,
  urlToDisplayKey,
  listAssetUsage,
  updateAssetUrls,
  cleanFileName,
  nextAvailableName,
} from '../../../../../../utils/objectStoreApi';

const sortItems = (items, by) => {
  const folders = items.filter((i) => i.isDirectory);
  const files = items.filter((i) => !i.isDirectory);
  const sorter =
    by === 'lastModified'
      ? (a, b) => (b.lastModified || '').localeCompare(a.lastModified || '')
      : (a, b) => a.name.localeCompare(b.name);
  return [...folders.sort(sorter), ...files.sort(sorter)];
};

const keyToFullUrl = (displayKey) => `${OBJECTSTORE_BASE_URL}/${displayKey}`;

const buildReplacements = ({ oldDisplayKey, newDisplayKey, isDirectory }) => {
  if (isDirectory) {
    const oldPrefix = oldDisplayKey.endsWith('/') ? oldDisplayKey : oldDisplayKey + '/';
    const newPrefix = newDisplayKey.endsWith('/') ? newDisplayKey : newDisplayKey + '/';
    return [{ oldPrefix: keyToFullUrl(oldPrefix), newPrefix: keyToFullUrl(newPrefix) }];
  }
  return [{ oldUrl: keyToFullUrl(oldDisplayKey), newUrl: keyToFullUrl(newDisplayKey) }];
};

const ParentSelectDialog = ({ currentPath, onSelect, onCancel, rootPath = LESSON_ASSETS_ROOT }) => {
  const [path, setPath] = useState(rootPath);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(async (p) => {
    setLoading(true); setError(null);
    try { setItems((await listFolder(p)).filter((i) => i.isDirectory)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(path); }, [path, load]);
  const rootParts = rootPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const isRoot = path.replace(/\/+$/, '') === rootPath.replace(/\/+$/, '');
  const goUp = () => {
    const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length <= rootParts.length) return; // 루트 위로는 못 올라감
    setPath(parts.slice(0, -1).join('/') + '/');
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="flex h-[400px] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <span className="text-sm font-semibold">이동할 폴더 선택</span>
          <button onClick={onCancel} className="rounded p-1 hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
          <button onClick={goUp} disabled={isRoot} className="rounded p-1 disabled:opacity-30 hover:bg-slate-100"><ArrowLeft size={14} /></button>
          <Breadcrumb path={path} onNavigate={(p) => {
            const pp = p.replace(/\/+$/, '').split('/').filter(Boolean);
            if (pp.length >= rootParts.length) setPath(p.endsWith('/') ? p : p + '/');
          }} />
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading && <div className="p-4 text-center text-xs text-slate-400">불러오는 중…</div>}
          {error && <div className="p-2 text-xs text-red-500">{error}</div>}
          {!loading && !items.length && <div className="p-4 text-center text-xs text-slate-400">하위 폴더가 없습니다.</div>}
          {items.map((item) => (
            <button key={item.displayKey} onClick={() => setPath(item.displayKey)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-cyan-50">
              <span className="text-amber-500">📁</span><span className="truncate">{item.name}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2">
          <span className="truncate text-[11px] text-slate-400">현재: {path}</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">취소</button>
            <button onClick={() => onSelect(path)} disabled={path === currentPath}
              className="rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-300">
              여기로 이동
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const RenameDialog = ({ item, onConfirm, onCancel }) => {
  const [value, setValue] = useState(item.name);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    if (inputRef.current) {
      const dot = item.name.lastIndexOf('.');
      const end = dot > 0 && !item.isDirectory ? dot : item.name.length;
      inputRef.current.setSelectionRange(0, end);
    }
  }, [item]);
  const submit = (e) => {
    e.preventDefault();
    if (!value.trim() || value === item.name) { onCancel(); return; }
    onConfirm(value.trim());
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <form className="w-full max-w-sm rounded-xl bg-white p-4 shadow-2xl" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 text-sm font-semibold">이름 변경</div>
        <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)}
          className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none" />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">취소</button>
          <button type="submit" className="rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600">확인</button>
        </div>
      </form>
    </div>
  );
};

const ObjectStoreBrowserModal = ({
  accept = 'image/*',
  initialPath,
  currentValue,
  onSelect,
  onClose,
  title = 'ObjectStore 파일 선택',
  subtitle,
  // 업로드 대신 커스텀 주요 액션(예: TTS 생성). { label, onClick: ({ currentPath, reload }) => void }
  primaryAction = null,
  // 그리드에서 숨길 파일 확장자(소문자, 점 제외). 예: ['json'] — 폴더는 항상 표시.
  hiddenExt = null,
  // 짝 파일 리졸버: (displayKey) => [siblingDisplayKey...]. 이름변경/이동/삭제/복사 시 함께 처리.
  siblingResolver = null,
  // 이동 대상 폴더 선택 다이얼로그의 루트(이 위로는 못 올라감). 기본 lesson-assets.
  moveRoot = LESSON_ASSETS_ROOT,
  // 브라우저 탐색 루트(뒤로가기/브레드크럼이 이 위로 못 올라감). 기본 lesson-assets.
  browseRoot = LESSON_ASSETS_ROOT,
}) => {
  const [currentPath, setCurrentPath] = useState(initialPath || `${LESSON_ASSETS_ROOT}images/`);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [customView, setCustomView] = useState(false); // primaryAction 스텝(예: TTS 생성) 표시
  const [batchProgress, setBatchProgress] = useState(null); // { label, done, total } 다중 이동/작업 진행률
  // contextMenu.kind: 'item' (target item-based) | 'background' (빈 영역)
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [sortBy, setSortBy] = useState('lastModified');
  const [usageMap, setUsageMap] = useState(() => new Map());
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [lastClickIndex, setLastClickIndex] = useState(-1);
  const [draggingInternal, setDraggingInternal] = useState(false);
  // clipboard: { kind: 'copy' | 'cut', items: [{ displayKey, name, isDirectory }] }
  const [clipboard, setClipboard] = useState(null);
  // marquee(박스) 선택: { x, y, x2, y2, baseSelection, additive } | null
  const [marquee, setMarquee] = useState(null);
  const fileInputRef = useRef(null);
  const dragCounter = useRef(0);
  const gridContainerRef = useRef(null);

  const currentValueKey = currentValue ? urlToDisplayKey(currentValue) : '';

  const loadList = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let list = await listFolder(currentPath);
      if (hiddenExt && hiddenExt.length) {
        const hide = new Set(hiddenExt.map((e) => e.toLowerCase()));
        list = list.filter((i) => i.isDirectory || !hide.has((i.name.split('.').pop() || '').toLowerCase()));
      }
      setItems(sortItems(list, sortBy));
      setSelectedKeys(new Set());
      setLastClickIndex(-1);
    } catch (err) { setError(err.message); setItems([]); }
    finally { setLoading(false); }
  }, [currentPath, sortBy, hiddenExt]);

  useEffect(() => { loadList(); }, [loadList]);

  const refreshUsage = useCallback(async () => {
    try {
      const usages = await listAssetUsage();
      const m = new Map();
      for (const [url, list] of Object.entries(usages || {})) {
        const key = urlToDisplayKey(url);
        if (key) m.set(key, list);
      }
      setUsageMap(m);
    } catch (err) { console.warn('자산 사용처 조회 실패:', err); }
  }, []);
  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  useEffect(() => {
    const onKey = (e) => {
      if (batchProgress) return; // 진행 중엔 키 입력 무시
      if (e.key === 'Escape') {
        if (contextMenu) setContextMenu(null);
        else if (renameTarget) setRenameTarget(null);
        else if (moveTarget) setMoveTarget(null);
        else if (selectedKeys.size > 0) { setSelectedKeys(new Set()); setLastClickIndex(-1); }
        else if (customView) setCustomView(false);
        else onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedKeys(new Set(items.map((i) => i.displayKey)));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        if (selectedKeys.size > 0) doCopy();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
        if (selectedKeys.size > 0) doCut();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
        if (clipboard) doPaste();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu, renameTarget, moveTarget, selectedKeys, onClose, items, clipboard, batchProgress]);

  useEffect(() => {
    if (!contextMenu) return;
    // capture phase로 잡아야 모달 내부의 stopPropagation을 우회해서 닫을 수 있음
    const onMouseDown = (e) => {
      // 메뉴 자체 내부 클릭은 메뉴 항목의 onClick에서 자체적으로 닫으므로 여기서는 무시
      if (e.target.closest('[data-context-menu="true"]')) return;
      setContextMenu(null);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [contextMenu]);

  // 짝 파일(예: .mp3 ↔ .json) 목록 — 파일에만 적용
  const siblingsOf = (displayKey) =>
    (siblingResolver && displayKey && !displayKey.endsWith('/')) ? (siblingResolver(displayKey) || []) : [];

  const browseRootNorm = browseRoot.replace(/\/+$/, '');
  const browseRootDepth = browseRootNorm.split('/').filter(Boolean).length;
  const handleEnterFolder = (item) => setCurrentPath(item.displayKey);
  const handleBack = () => {
    const parts = currentPath.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length <= browseRootDepth) return; // 브라우즈 루트 위로는 못 올라감
    setCurrentPath(parts.slice(0, -1).join('/') + '/');
  };
  const isAtRoot = currentPath.replace(/\/+$/, '') === browseRootNorm;

  const handleSelectFile = (item) => {
    if (!isAcceptedFile(item.name, accept)) {
      setError('호환되지 않는 파일 형식입니다.'); return;
    }
    onSelect(keyToUrl(item.displayKey));
  };

  const handleItemClick = (item, index, e) => {
    if (e.shiftKey && lastClickIndex >= 0) {
      const [from, to] = lastClickIndex < index ? [lastClickIndex, index] : [index, lastClickIndex];
      const next = new Set(selectedKeys);
      for (let i = from; i <= to; i++) next.add(items[i].displayKey);
      setSelectedKeys(next);
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedKeys);
      if (next.has(item.displayKey)) next.delete(item.displayKey); else next.add(item.displayKey);
      setSelectedKeys(next); setLastClickIndex(index);
    } else {
      setSelectedKeys(new Set([item.displayKey])); setLastClickIndex(index);
    }
  };

  const handleFilesUpload = async (filesList) => {
    const files = Array.from(filesList).filter(Boolean);
    if (!files.length) return;
    const accepted = files.filter((f) => isAcceptedFile(f.name, accept));
    const rejected = files.length - accepted.length;
    if (rejected > 0 && !accepted.length) { setError('호환되지 않는 파일 형식입니다.'); return; }
    setUploading(true); setError(null);
    let lastResult = null;
    try {
      // 읽는 파일명 유지 + 현재 폴더/배치 내 충돌 시 "name (1).ext" 로 회피
      const taken = new Set(items.map((i) => i.name.toLowerCase()));
      for (let i = 0; i < accepted.length; i++) {
        setUploadProgress({ done: i, total: accepted.length });
        let fileName = nextAvailableName(cleanFileName(accepted[i].name), taken);
        taken.add(fileName.toLowerCase());
        lastResult = await uploadFile(accepted[i], currentPath, { fileName });
      }
      setUploadProgress({ done: accepted.length, total: accepted.length });
      if (rejected > 0) setError(`${rejected}개 파일이 형식 불일치로 제외되었습니다.`);
      await loadList();
      if (lastResult) onSelect(lastResult.url);
    } catch (err) { setError(err.message); }
    finally { setUploading(false); setUploadProgress(null); }
  };
  const handleFileInputChange = (e) => { handleFilesUpload(e.target.files); e.target.value = ''; };

  const handleDragEnter = (e) => {
    e.preventDefault();
    if (draggingInternal) return;
    if (e.dataTransfer?.types?.includes('Files')) { dragCounter.current += 1; setDragOver(true); }
  };
  const handleDragOver = (e) => { e.preventDefault(); };
  const handleDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    if (draggingInternal) return;
    dragCounter.current = 0; setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files?.length) handleFilesUpload(files);
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('새 폴더 이름을 입력하세요.');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (items.some((i) => i.isDirectory && i.name === trimmed)) {
      alert('같은 이름의 폴더가 이미 존재합니다.'); return;
    }
    try {
      setLoading(true);
      await apiCreateFolder(currentPath, trimmed);
      await loadList();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const handleDelete = async (targets) => {
    const list = Array.isArray(targets) ? targets : [targets];
    if (list.length === 0) return;
    const label = list.length === 1
      ? `'${list[0].name}' ${list[0].isDirectory ? '폴더와 그 안의 모든 파일' : '파일'}`
      : `${list.length}개 항목`;
    const hasUsedHere = list.some((it) => currentValueKey && currentValueKey === it.displayKey);
    const usageWarning = hasUsedHere ? '\n\n⚠️ 현재 이 모듈에서 사용 중인 파일이 포함되어 있습니다.' : '';
    if (!window.confirm(`${label}을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.${usageWarning}`)) return;
    try {
      setLoading(true);
      for (const it of list) {
        await deleteItem(it.displayKey, it.isDirectory);
        for (const sk of siblingsOf(it.displayKey)) { try { await deleteItem(sk, false); } catch (_) { /* 사이드카 없을 수 있음 */ } }
      }
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const handleRenameConfirm = async (newName) => {
    if (!renameTarget) return;
    if (items.some((i) => i.name === newName && i.displayKey !== renameTarget.displayKey)) {
      alert('같은 이름의 항목이 이미 존재합니다.'); return;
    }
    try {
      setLoading(true);
      const oldKey = renameTarget.displayKey;
      const oldParts = oldKey.replace(/\/+$/, '').split('/');
      oldParts[oldParts.length - 1] = newName;
      const newKey = renameTarget.isDirectory ? oldParts.join('/') + '/' : oldParts.join('/');
      await renameItem(oldKey, newName, renameTarget.isDirectory);
      await updateAssetUrls(buildReplacements({ oldDisplayKey: oldKey, newDisplayKey: newKey, isDirectory: renameTarget.isDirectory }));
      // 짝 파일(.json 등)도 같은 베이스명으로 이름 변경
      const newBase = newName.replace(/\.[^.]+$/, '');
      for (const sk of siblingsOf(oldKey)) {
        const skExt = (sk.split('.').pop() || '');
        try { await renameItem(sk, `${newBase}.${skExt}`, false); } catch (_) { /* 사이드카 없을 수 있음 */ }
      }
      setRenameTarget(null);
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const moveMany = async (targets, targetParentPath) => {
    const parent = targetParentPath.endsWith('/') ? targetParentPath : targetParentPath + '/';
    const movable = targets.filter((it) => (it.displayKey.replace(/\/+$/, '').split('/').slice(0, -1).join('/') + '/') !== parent);
    if (movable.length > 1) setBatchProgress({ label: '이동 중', done: 0, total: movable.length });
    let processed = 0;
    try {
    for (const it of targets) {
      const sourceParent = it.displayKey.replace(/\/+$/, '').split('/').slice(0, -1).join('/') + '/';
      if (sourceParent === parent) continue;
      if (it.isDirectory && parent.startsWith(it.displayKey.endsWith('/') ? it.displayKey : it.displayKey + '/')) {
        throw new Error(`'${it.name}' 폴더는 자기 자신의 하위로 이동할 수 없습니다.`);
      }
      const baseName = it.isDirectory
        ? it.displayKey.replace(/\/+$/, '').split('/').pop()
        : it.displayKey.split('/').pop();
      const newKey = it.isDirectory ? `${parent}${baseName}/` : `${parent}${baseName}`;
      await moveItem(it.displayKey, parent, it.isDirectory);
      // 참조를 파일별로 즉시 갱신 → 중간 실패해도 이미 옮긴 파일은 참조 일관성 유지(깨진 참조 방지)
      await updateAssetUrls(buildReplacements({ oldDisplayKey: it.displayKey, newDisplayKey: newKey, isDirectory: it.isDirectory }));
      // 짝 파일도 같은 폴더로 이동
      for (const sk of siblingsOf(it.displayKey)) { try { await moveItem(sk, parent, false); } catch (_) { /* 사이드카 없을 수 있음 */ } }
      processed += 1;
      setBatchProgress((p) => (p ? { ...p, done: processed } : p));
    }
    } finally {
      setBatchProgress(null);
    }
  };

  const handleMoveConfirm = async (targetParentPath) => {
    if (!moveTarget) return;
    try {
      setLoading(true);
      await moveMany(Array.isArray(moveTarget) ? moveTarget : [moveTarget], targetParentPath);
      setMoveTarget(null);
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  // === Clipboard 동작 ===
  const doCopy = () => {
    const list = items.filter((i) => selectedKeys.has(i.displayKey));
    if (list.length === 0) return;
    setClipboard({ kind: 'copy', items: list.map((i) => ({ displayKey: i.displayKey, name: i.name, isDirectory: i.isDirectory })) });
  };
  const doCut = () => {
    const list = items.filter((i) => selectedKeys.has(i.displayKey));
    if (list.length === 0) return;
    setClipboard({ kind: 'cut', items: list.map((i) => ({ displayKey: i.displayKey, name: i.name, isDirectory: i.isDirectory })) });
  };
  const doPaste = async () => {
    if (!clipboard || clipboard.items.length === 0) return;
    try {
      setLoading(true);
      if (clipboard.kind === 'cut') {
        await moveMany(clipboard.items, currentPath);
        setClipboard(null);
      } else {
        for (const it of clipboard.items) {
          await copyItem(it.displayKey, currentPath, it.isDirectory);
          for (const sk of siblingsOf(it.displayKey)) { try { await copyItem(sk, currentPath, false); } catch (_) { /* 사이드카 없을 수 있음 */ } }
        }
      }
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  // === Drag/Drop ===
  const handleCardDragStart = (item, e) => {
    let draggingKeys;
    if (selectedKeys.has(item.displayKey) && selectedKeys.size > 1) {
      draggingKeys = new Set(selectedKeys);
    } else {
      draggingKeys = new Set([item.displayKey]);
      setSelectedKeys(draggingKeys);
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-objectstore-keys', JSON.stringify(Array.from(draggingKeys)));
    setDraggingInternal(true);
  };
  const handleCardDragEnd = () => setDraggingInternal(false);
  const handleFolderDrop = async (folderItem, e) => {
    e.preventDefault(); e.stopPropagation();
    setDraggingInternal(false);
    let keys;
    try { keys = JSON.parse(e.dataTransfer.getData('application/x-objectstore-keys') || '[]'); } catch { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return;
    const targets = items.filter((i) => keys.includes(i.displayKey) && i.displayKey !== folderItem.displayKey);
    if (targets.length === 0) return;
    try {
      setLoading(true);
      await moveMany(targets, folderItem.displayKey);
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  const handleBackDrop = async (e) => {
    e.preventDefault();
    setDraggingInternal(false);
    if (isAtRoot) return;
    let keys;
    try { keys = JSON.parse(e.dataTransfer.getData('application/x-objectstore-keys') || '[]'); } catch { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return;
    const targets = items.filter((i) => keys.includes(i.displayKey));
    const parent = currentPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') + '/';
    try {
      setLoading(true);
      await moveMany(targets, parent);
      await loadList(); await refreshUsage();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  const openItemContextMenu = (e, item) => {
    if (!selectedKeys.has(item.displayKey)) {
      setSelectedKeys(new Set([item.displayKey]));
      const idx = items.findIndex((i) => i.displayKey === item.displayKey);
      if (idx >= 0) setLastClickIndex(idx);
    }
    setContextMenu({ kind: 'item', x: e.clientX, y: e.clientY, item });
  };
  const openBackgroundContextMenu = (e) => {
    e.preventDefault();
    setSelectedKeys(new Set()); setLastClickIndex(-1);
    setContextMenu({ kind: 'background', x: e.clientX, y: e.clientY });
  };

  // === Marquee (박스) 선택 ===
  const handleGridMouseDown = (e) => {
    // 카드 위에서 시작하면 박스 선택 안 함 (카드 drag로 처리)
    if (e.button !== 0) return; // 좌클릭만
    if (e.target.closest('[data-card="true"]')) return;
    const container = gridContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left + container.scrollLeft;
    const y = e.clientY - rect.top + container.scrollTop;
    setMarquee({
      x, y, x2: x, y2: y,
      baseSelection: (e.shiftKey || e.metaKey || e.ctrlKey) ? new Set(selectedKeys) : new Set(),
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    });
  };

  useEffect(() => {
    if (!marquee) return;
    const onMove = (e) => {
      const container = gridContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x2 = e.clientX - rect.left + container.scrollLeft;
      const y2 = e.clientY - rect.top + container.scrollTop;
      setMarquee((prev) => prev ? { ...prev, x2, y2 } : null);

      // 박스와 교차하는 카드 선택 갱신
      const left = Math.min(marquee.x, x2);
      const right = Math.max(marquee.x, x2);
      const top = Math.min(marquee.y, y2);
      const bottom = Math.max(marquee.y, y2);
      const next = new Set(marquee.baseSelection);
      const cards = container.querySelectorAll('[data-card="true"]');
      cards.forEach((card) => {
        const cRect = card.getBoundingClientRect();
        const cx1 = cRect.left - rect.left + container.scrollLeft;
        const cy1 = cRect.top - rect.top + container.scrollTop;
        const cx2 = cx1 + cRect.width;
        const cy2 = cy1 + cRect.height;
        const intersects = !(cx2 < left || cx1 > right || cy2 < top || cy1 > bottom);
        if (intersects) {
          const key = card.getAttribute('data-key');
          if (key) {
            if (marquee.additive && marquee.baseSelection.has(key)) next.delete(key);
            else next.add(key);
          }
        }
      });
      setSelectedKeys(next);
    };
    const onUp = () => { setMarquee(null); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [marquee]);

  const selectedItems = items.filter((i) => selectedKeys.has(i.displayKey));
  const contextIsBackground = contextMenu?.kind === 'background';
  const contextItems = contextMenu && contextMenu.kind === 'item'
    ? (selectedKeys.has(contextMenu.item.displayKey) ? selectedItems : [contextMenu.item])
    : [];
  const contextIsMulti = contextItems.length > 1;

  const marqueeRect = marquee ? {
    left: Math.min(marquee.x, marquee.x2),
    top: Math.min(marquee.y, marquee.y2),
    width: Math.abs(marquee.x2 - marquee.x),
    height: Math.abs(marquee.y2 - marquee.y),
  } : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            {customView && (
              <button type="button" onClick={() => setCustomView(false)} className="rounded p-1 text-slate-500 hover:bg-slate-100" title="뒤로">
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold text-slate-800">{customView ? (primaryAction?.label || '생성') : title}</h2>
              <p className="text-[11px] text-slate-400">
                {customView ? '← 뒤로가기로 목록으로 돌아갑니다.' : (subtitle || '빈 영역 드래그 = 박스 선택 · Cmd/Shift+클릭 = 다중 · 우클릭 = 메뉴 · ⌘C/X/V 지원')}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {customView && primaryAction?.render && (
          <div className="flex-1 overflow-y-auto">
            {primaryAction.render({
              currentPath,
              reload: () => { loadList(); refreshUsage(); },
              close: () => setCustomView(false),
            })}
          </div>
        )}

        {!customView && (<>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
          <button type="button" onClick={handleBack}
            onDragEnter={(e) => { if (draggingInternal && !isAtRoot) e.preventDefault(); }}
            onDragOver={(e) => { if (draggingInternal && !isAtRoot) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={handleBackDrop}
            disabled={isAtRoot}
            className={'rounded p-1 text-slate-600 disabled:opacity-30 hover:bg-slate-200 ' + (draggingInternal && !isAtRoot ? 'ring-2 ring-cyan-400 ring-offset-1' : '')}
            title="상위 폴더 (드래그앤드랍으로도 이동)">
            <ArrowLeft size={16} />
          </button>
          <Breadcrumb path={currentPath} onNavigate={setCurrentPath} rootPath={browseRoot} />
          {selectedItems.length > 0 && (
            <span className="ml-2 rounded bg-cyan-100 px-2 py-0.5 text-[11px] font-semibold text-cyan-700">
              {selectedItems.length}개 선택됨
            </span>
          )}
          {clipboard && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              클립보드: {clipboard.items.length}개 ({clipboard.kind === 'cut' ? '잘라내기' : '복사'})
            </span>
          )}
          <div className="flex items-center gap-1">
            <button type="button" onClick={loadList} className="rounded p-1 text-slate-600 hover:bg-slate-200" title="새로고침">
              <ArrowClockwise size={14} />
            </button>
            <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setItems((prev) => sortItems(prev, e.target.value)); }}
              className="rounded border border-slate-200 px-1.5 py-0.5 text-xs" title="정렬">
              <option value="lastModified">최신순</option>
              <option value="name">이름순</option>
            </select>
            <button type="button" onClick={handleCreateFolder}
              className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
              <FolderPlus size={14} /> 새 폴더
            </button>
            {primaryAction ? (
              <button type="button" onClick={() => {
                if (primaryAction.render) setCustomView(true);
                else if (primaryAction.onClick) primaryAction.onClick({ currentPath, reload: () => { loadList(); refreshUsage(); } });
              }}
                className="flex items-center gap-1 rounded bg-cyan-500 px-2 py-1 text-xs font-semibold text-white hover:bg-cyan-600">
                <Plus size={14} weight="bold" /> {primaryAction.label}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
                  className="flex items-center gap-1 rounded bg-cyan-500 px-2 py-1 text-xs font-semibold text-white hover:bg-cyan-600 disabled:bg-slate-300">
                  <UploadSimple size={14} /> 업로드
                </button>
                <input ref={fileInputRef} type="file" accept={accept} multiple onChange={handleFileInputChange} className="hidden" />
              </>
            )}
          </div>
        </div>

        <div
          ref={gridContainerRef}
          className="relative flex-1 overflow-auto bg-white"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onMouseDown={handleGridMouseDown}
          onContextMenu={(e) => {
            // 카드 위 컨텍스트 메뉴는 카드가 직접 처리. 빈 영역만 background 메뉴.
            if (e.target.closest('[data-card="true"]')) return;
            openBackgroundContextMenu(e);
          }}
        >
          <FileGrid
            items={items}
            accept={accept}
            onEnterFolder={handleEnterFolder}
            onSelectFile={handleSelectFile}
            onContextMenu={openItemContextMenu}
            onItemClick={handleItemClick}
            onCardDragStart={handleCardDragStart}
            onCardDragEnd={handleCardDragEnd}
            onFolderDrop={handleFolderDrop}
            draggingOver={dragOver}
            draggingInternal={draggingInternal}
            loading={loading && !uploading}
            currentValueKey={currentValueKey}
            usageMap={usageMap}
            selectedKeys={selectedKeys}
            cutKeys={clipboard?.kind === 'cut' ? new Set(clipboard.items.map((i) => i.displayKey)) : null}
          />
          {marqueeRect && (
            <div
              className="pointer-events-none absolute border-2 border-cyan-500 bg-cyan-200/20"
              style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
            />
          )}
          {uploading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80">
              <div className="rounded-lg bg-white px-4 py-3 text-sm shadow-lg">
                업로드 중…
                {uploadProgress && uploadProgress.total > 1 && (
                  <span className="ml-2 text-xs text-slate-500">({uploadProgress.done}/{uploadProgress.total})</span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex-1 truncate text-xs text-red-500">{error}</div>
          <div className="text-[11px] text-slate-400">{items.length}개 항목</div>
        </div>
        </>)}
      </div>

      {/* 다중 작업(이동 등) 진행 오버레이 — 완료 전까지 상호작용 차단 */}
      {batchProgress && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onClick={(e) => e.stopPropagation()}>
          <div className="w-80 rounded-xl bg-white p-5 shadow-2xl">
            <div className="mb-2 text-sm font-semibold text-slate-800">
              {batchProgress.label}… {batchProgress.done}/{batchProgress.total}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-cyan-500 transition-all"
                style={{ width: `${batchProgress.total ? Math.round((batchProgress.done / batchProgress.total) * 100) : 0}%` }} />
            </div>
            <div className="mt-2 text-[11px] text-slate-400">완료될 때까지 창을 닫지 마세요.</div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div
          data-context-menu="true"
          className="fixed z-[55] min-w-[170px] overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {contextIsBackground ? (
            <>
              <button onClick={() => { handleCreateFolder(); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <FolderPlus size={12} /> 새 폴더
              </button>
              <button onClick={() => { fileInputRef.current?.click(); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <UploadSimple size={12} /> 파일 업로드
              </button>
              <button onClick={() => { doPaste(); setContextMenu(null); }} disabled={!clipboard}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent">
                <ClipboardText size={12} /> 붙여넣기{clipboard ? ` (${clipboard.items.length})` : ''}
              </button>
              <button onClick={() => { setSelectedKeys(new Set(items.map((i) => i.displayKey))); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                모두 선택
              </button>
              <button onClick={() => { loadList(); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <ArrowClockwise size={12} /> 새로고침
              </button>
            </>
          ) : (
            <>
              {!contextIsMulti && !contextMenu.item.isDirectory && (
                <button onClick={() => { if (isAcceptedFile(contextMenu.item.name, accept)) handleSelectFile(contextMenu.item); setContextMenu(null); }}
                  disabled={!isAcceptedFile(contextMenu.item.name, accept)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent">
                  선택
                </button>
              )}
              {!contextIsMulti && contextMenu.item.isDirectory && (
                <button onClick={() => { handleEnterFolder(contextMenu.item); setContextMenu(null); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                  열기
                </button>
              )}
              <button onClick={() => { doCopy(); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <Copy size={12} /> 복사{contextIsMulti ? ` (${contextItems.length})` : ''}
              </button>
              <button onClick={() => { doCut(); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <Scissors size={12} /> 잘라내기{contextIsMulti ? ` (${contextItems.length})` : ''}
              </button>
              {!contextIsMulti && (
                <button onClick={() => { setRenameTarget(contextMenu.item); setContextMenu(null); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                  <PencilSimple size={12} /> 이름 변경
                </button>
              )}
              <button onClick={() => { setMoveTarget(contextIsMulti ? contextItems : contextMenu.item); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
                <ArrowsOutCardinal size={12} /> 이동{contextIsMulti ? ` (${contextItems.length})` : ''}
              </button>
              <button onClick={() => { handleDelete(contextIsMulti ? contextItems : contextMenu.item); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50">
                <Trash size={12} /> 삭제{contextIsMulti ? ` (${contextItems.length})` : ''}
              </button>
            </>
          )}
        </div>
      )}

      {renameTarget && <RenameDialog item={renameTarget} onConfirm={handleRenameConfirm} onCancel={() => setRenameTarget(null)} />}
      {moveTarget && (
        <ParentSelectDialog
          currentPath={currentPath}
          rootPath={moveRoot}
          onSelect={handleMoveConfirm}
          onCancel={() => setMoveTarget(null)}
        />
      )}
    </div>
  );
};

export default ObjectStoreBrowserModal;
