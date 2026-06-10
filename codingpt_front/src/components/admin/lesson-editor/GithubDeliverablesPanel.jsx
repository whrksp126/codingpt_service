import { useEffect, useMemo, useState } from 'react';
import { useEditor, selectSelectedSlide } from './state/EditorContext';
import MonacoField from './modules/_shared/MonacoField';
import * as repoApi from '../../../utils/githubRepoApi';

// 레슨 산출물(GitHub 푸시 대상) 정의 패널 — IDE/파인더 스타일.
// lesson.meta.github = { enabled, repoId, files: [{ path, language, content, sourceModuleId }] }
// path 는 레포 루트 기준 전체 경로. 폴더 트리는 path 들로부터 자동 구성된다.
// 빈 폴더는 git 특성상 {folder}/.gitkeep 로 보존한다(트리엔 폴더만 표시).

const LANGUAGES = ['html', 'css', 'javascript', 'typescript', 'python', 'java', 'json', 'markdown', 'plaintext'];
const GITKEEP = '.gitkeep';

const extToLang = (path) => {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python',
    java: 'java', json: 'json', md: 'markdown',
  };
  return map[ext] || 'plaintext';
};

const normPath = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');

// files[] → 중첩 트리. 노드: { name, path, dir, children?, fileIndex? }
const buildTree = (files) => {
  const root = { name: '', path: '', dir: true, children: {} };
  files.forEach((f, idx) => {
    const parts = normPath(f.path).split('/').filter(Boolean);
    if (parts.length === 0) return;
    let node = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      const curPath = parts.slice(0, i + 1).join('/');
      if (isLeaf) {
        node.children[part] = { name: part, path: f.path, dir: false, fileIndex: idx };
      } else {
        if (!node.children[part] || !node.children[part].dir) {
          node.children[part] = { name: part, path: curPath, dir: true, children: {} };
        }
        node = node.children[part];
      }
    });
  });
  return root;
};

const sortedChildren = (node) =>
  Object.values(node.children).sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

const GithubDeliverablesPanel = ({ onClose }) => {
  const { state, dispatch } = useEditor();
  const lesson = state.lesson;
  const slide = selectSelectedSlide(state);

  const github = (lesson?.meta && lesson.meta.github) || { enabled: false, files: [] };
  const files = Array.isArray(github.files) ? github.files : [];

  const [repos, setRepos] = useState([]);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [selectedPath, setSelectedPath] = useState(null);
  const [openTabs, setOpenTabs] = useState([]); // VS Code 식 열린 파일 탭(경로 배열)
  const [activeDir, setActiveDir] = useState(''); // 새 파일/폴더가 생성될 기준 폴더
  const [collapsed, setCollapsed] = useState({});

  // 파일 열기(탭 추가 + 선택)
  const openFile = (path) => {
    setOpenTabs((t) => (t.includes(path) ? t : [...t, path]));
    setSelectedPath(path);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    setActiveDir(dir);
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

  useEffect(() => {
    repoApi.listRepos().then((r) => setRepos(Array.isArray(r) ? r : [])).catch(() => setRepos([]));
  }, []);

  const tree = useMemo(() => buildTree(files), [files]);

  const writeGithub = (nextGithub) => {
    dispatch({ type: 'updateLessonMeta', patch: { meta: { ...(lesson.meta || {}), github: nextGithub } } });
  };
  const setFiles = (nextFiles) => writeGithub({ ...github, files: nextFiles });
  const setEnabled = (enabled) => writeGithub({ ...github, enabled });
  const setRepoId = (repoId) => writeGithub({ ...github, repoId: repoId ? Number(repoId) : undefined });

  const selectedIndex = files.findIndex((f) => f.path === selectedPath);
  const selectedFile = selectedIndex >= 0 ? files[selectedIndex] : null;

  const uniquePath = (candidate) => {
    let p = candidate;
    let n = 1;
    const exists = (x) => files.some((f) => f.path === x);
    while (exists(p)) {
      const dot = candidate.lastIndexOf('.');
      const slash = candidate.lastIndexOf('/');
      if (dot > slash) p = `${candidate.slice(0, dot)}-${n}${candidate.slice(dot)}`;
      else p = `${candidate}-${n}`;
      n += 1;
    }
    return p;
  };

  const updateFile = (idx, patch) => setFiles(files.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  const newFile = () => {
    const base = activeDir ? `${activeDir}/` : '';
    const path = uniquePath(`${base}새파일.txt`);
    setFiles([...files, { path, language: 'plaintext', content: '' }]);
    openFile(path);
  };

  const newFolder = () => {
    const name = normPath(prompt('새 폴더 경로를 입력하세요 (예: src 또는 src/utils)', activeDir ? `${activeDir}/` : '') || '');
    if (!name) return;
    const keep = `${name}/${GITKEEP}`;
    if (files.some((f) => f.path === keep)) { setActiveDir(name); return; }
    setFiles([...files, { path: keep, language: 'plaintext', content: '' }]);
    setActiveDir(name);
  };

  const deleteFile = (path) => {
    setFiles(files.filter((f) => f.path !== path));
    setOpenTabs((t) => t.filter((p) => p !== path));
    if (selectedPath === path) setSelectedPath(null);
  };

  // 폴더 삭제: 하위 모든 파일 제거
  const deleteFolder = (dirPath) => {
    if (!confirm(`"${dirPath}" 폴더와 그 안의 모든 파일을 삭제할까요?`)) return;
    const prefix = `${dirPath}/`;
    const affected = (p) => p === dirPath || p.startsWith(prefix);
    setFiles(files.filter((f) => !affected(f.path)));
    setOpenTabs((t) => t.filter((p) => !affected(p)));
    if (selectedPath && affected(selectedPath)) setSelectedPath(null);
    if (activeDir === dirPath || activeDir.startsWith(prefix)) setActiveDir('');
  };

  const loadPreviousFiles = async () => {
    if (!github.repoId) { alert('먼저 레포를 선택하세요.'); return; }
    if (files.length > 0 && !confirm('현재 파일들을 직전 레슨 소스로 덮어쓸까요?')) return;
    setLoadingPrev(true);
    try {
      const res = await repoApi.getPreviousLessonFiles(lesson.id, github.repoId);
      if (!res || !Array.isArray(res.files) || res.files.length === 0) {
        alert('이 레포를 사용하는 직전 레슨이 없습니다.');
        return;
      }
      setFiles(res.files.map((f) => ({ path: f.path, language: f.language || extToLang(f.path), content: f.content })));
      setSelectedPath(null);
    } catch (e) {
      alert(`불러오기 실패: ${e.message}`);
    } finally {
      setLoadingPrev(false);
    }
  };

  const importFromCodeModules = () => {
    const modules = slide?.contents?.modules || [];
    const codeModules = modules.filter((m) => m.type === 'code' && Array.isArray(m.files));
    const imported = [];
    codeModules.forEach((m) => {
      m.files.forEach((cf) => {
        const path = normPath((activeDir ? `${activeDir}/` : '') + (cf.name || `module-${m.id}.txt`));
        imported.push({ path, language: cf.language || extToLang(path), content: cf.content || '', sourceModuleId: m.id });
      });
    });
    if (imported.length === 0) { alert('현재 슬라이드에 가져올 code 모듈이 없습니다.'); return; }
    const existing = new Set(files.map((f) => f.path));
    const fresh = imported.filter((f) => !existing.has(f.path));
    setFiles([...files, ...fresh]);
  };

  // ── 트리 렌더 ──
  const renderNode = (node, depth = 0) => {
    const children = sortedChildren(node);
    return children.map((child) => {
      if (child.dir) {
        const isCollapsed = collapsed[child.path];
        const isActive = activeDir === child.path;
        return (
          <div key={`d:${child.path}`}>
            <div
              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-sm cursor-pointer hover:bg-slate-100 ${isActive ? 'bg-cyan-50' : ''}`}
              style={{ paddingLeft: depth * 12 + 4 }}
              onClick={() => { setActiveDir(child.path); setCollapsed((c) => ({ ...c, [child.path]: !c[child.path] })); }}
            >
              <span className="text-slate-400">{isCollapsed ? '▶' : '▼'}</span>
              <span className="text-amber-500">📁</span>
              <span className="truncate text-slate-700">{child.name}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); deleteFolder(child.path); }}
                className="ml-auto hidden text-[11px] text-red-500 group-hover:block"
              >삭제</button>
            </div>
            {!isCollapsed && renderNode(child, depth + 1)}
          </div>
        );
      }
      // 파일 (.gitkeep 은 숨김 — 폴더 보존용)
      if (child.name === GITKEEP) return null;
      const isSel = child.path === selectedPath;
      return (
        <div
          key={`f:${child.path}`}
          className={`flex items-center gap-1 rounded px-1 py-0.5 text-sm cursor-pointer hover:bg-slate-100 ${isSel ? 'bg-cyan-100 text-cyan-900' : 'text-slate-700'}`}
          style={{ paddingLeft: depth * 12 + 16 }}
          onClick={() => openFile(child.path)}
        >
          <span>📄</span>
          <span className="truncate">{child.name}</span>
        </div>
      );
    });
  };

  if (!lesson) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">GitHub 산출물</h2>
            <p className="text-xs text-slate-500">레슨 완료 시, 선택한 레포에 아래 파일들이 <b>레포 루트 기준 전체 경로</b>로 커밋됩니다. 같은 경로 파일은 갱신됩니다(점진적 빌드).</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</button>
        </div>

        {/* 상단 컨트롤: 활성화 + 레포 + 액션 */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-2">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={!!github.enabled} onChange={(e) => setEnabled(e.target.checked)} />
            완료 시 푸시
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">레포</span>
            <select
              value={github.repoId || ''}
              onChange={(e) => setRepoId(e.target.value)}
              className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-cyan-500 focus:outline-none"
            >
              <option value="">선택 안 함</option>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {repos.length === 0 && (
              <a href="/admin/github-repos" target="_blank" rel="noreferrer" className="text-xs text-cyan-600 underline">레포 만들기</a>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={loadPreviousFiles} disabled={loadingPrev || !github.repoId}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              {loadingPrev ? '불러오는 중…' : '↩ 직전 레슨 소스'}
            </button>
            <button type="button" onClick={importFromCodeModules}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
              ⬇ code 모듈
            </button>
          </div>
        </div>

        {/* 본문: 좌 트리 + 우 에디터 */}
        <div className="flex min-h-0 flex-1">
          {/* 좌측 파일 트리 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
            <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
              <span className="text-xs font-semibold text-slate-500">
                {activeDir ? `📁 ${activeDir}` : '루트'}
              </span>
              <div className="ml-auto flex gap-1">
                <button type="button" onClick={newFile} title="새 파일" className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-200">＋파일</button>
                <button type="button" onClick={newFolder} title="새 폴더" className="rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-200">＋폴더</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1">
              <div
                className={`mb-1 rounded px-1 py-0.5 text-xs cursor-pointer ${activeDir === '' ? 'bg-cyan-50 text-cyan-700' : 'text-slate-400'}`}
                onClick={() => setActiveDir('')}
              >／ (루트)</div>
              {files.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">파일이 없습니다.<br />＋파일로 시작하세요.</p>
              ) : renderNode(tree)}
            </div>
          </div>

          {/* 우측 에디터 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* VS Code 식 탭 스트립 */}
            {openTabs.length > 0 && (
              <div className="flex shrink-0 items-center overflow-x-auto border-b border-slate-200 bg-slate-100">
                {openTabs.map((p) => {
                  const name = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
                  const exists = files.some((f) => f.path === p);
                  const active = p === selectedPath;
                  return (
                    <div
                      key={p}
                      onClick={() => setSelectedPath(p)}
                      className={`group flex shrink-0 items-center gap-1.5 border-r border-slate-200 px-3 py-1.5 text-xs cursor-pointer ${active ? 'bg-white text-slate-900' : 'text-slate-500 hover:bg-slate-50'}`}
                      title={p}
                    >
                      <span className={exists ? '' : 'text-red-400 line-through'}>{name || '(빈 경로)'}</span>
                      <button
                        type="button"
                        onClick={(e) => closeTab(p, e)}
                        className="rounded px-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                      >✕</button>
                    </div>
                  );
                })}
              </div>
            )}
            {selectedFile ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2">
                  <input
                    type="text"
                    value={selectedFile.path || ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      const old = selectedFile.path;
                      updateFile(selectedIndex, { path: v, language: selectedFile.language || extToLang(v) });
                      setOpenTabs((t) => t.map((p) => (p === old ? v : p)));
                      setSelectedPath(v);
                    }}
                    className="flex-1 rounded border border-slate-200 px-2 py-1 font-mono text-sm focus:border-cyan-500 focus:outline-none"
                    placeholder="레포 루트 기준 경로 (예: src/app.js)"
                  />
                  <select
                    value={selectedFile.language || 'plaintext'}
                    onChange={(e) => updateFile(selectedIndex, { language: e.target.value })}
                    className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 focus:border-cyan-500 focus:outline-none"
                  >
                    {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <button type="button" onClick={() => deleteFile(selectedFile.path)}
                    className="rounded border border-slate-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">삭제</button>
                </div>
                <div className="min-h-0 flex-1 p-2">
                  <MonacoField
                    key={selectedIndex}
                    value={selectedFile.content || ''}
                    onChange={(val) => updateFile(selectedIndex, { content: val })}
                    language={selectedFile.language || 'plaintext'}
                    height={'100%'}
                    disableAutoFormat
                  />
                </div>
                {selectedFile.sourceModuleId !== undefined && (
                  <p className="shrink-0 px-4 pb-2 text-[11px] text-slate-400">code 모듈 #{selectedFile.sourceModuleId} 에서 가져옴</p>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
                왼쪽에서 파일을 선택하거나 ＋파일로 새로 만드세요.
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-200 px-5 py-3 text-right">
          <button type="button" onClick={onClose}
            className="rounded bg-slate-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-900">완료</button>
        </div>
      </div>
    </div>
  );
};

export default GithubDeliverablesPanel;
