import { useEffect, useState } from 'react';
import { useEditor, selectSelectedSlide } from './state/EditorContext';
import MonacoField from './modules/_shared/MonacoField';
import * as repoApi from '../../../utils/githubRepoApi';

// 레슨 산출물(GitHub 푸시 대상) 정의 패널.
// lesson.meta.github = { enabled, repoId, files: [{ path, language, content, sourceModuleId }] } 를 편집한다.
// 학습자가 레슨을 완료하면, 선택한 레포에 파일들을 "레포 루트 기준 전체 경로"로 커밋한다(점진적 빌드).

const LANGUAGES = ['html', 'css', 'javascript', 'typescript', 'python', 'java', 'json', 'markdown', 'plaintext'];

const extToLang = (path) => {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python',
    java: 'java', json: 'json', md: 'markdown',
  };
  return map[ext] || 'plaintext';
};

const GithubDeliverablesPanel = ({ onClose }) => {
  const { state, dispatch } = useEditor();
  const lesson = state.lesson;
  const slide = selectSelectedSlide(state);

  const github = (lesson?.meta && lesson.meta.github) || { enabled: false, files: [] };
  const files = Array.isArray(github.files) ? github.files : [];

  const [repos, setRepos] = useState([]);
  const [loadingPrev, setLoadingPrev] = useState(false);

  useEffect(() => {
    repoApi.listRepos().then((r) => setRepos(Array.isArray(r) ? r : [])).catch(() => setRepos([]));
  }, []);

  const writeGithub = (nextGithub) => {
    dispatch({
      type: 'updateLessonMeta',
      patch: { meta: { ...(lesson.meta || {}), github: nextGithub } },
    });
  };

  const setFiles = (nextFiles) => writeGithub({ ...github, files: nextFiles });
  const setEnabled = (enabled) => writeGithub({ ...github, enabled });
  const setRepoId = (repoId) => writeGithub({ ...github, repoId: repoId ? Number(repoId) : undefined });

  // 직전 레슨(같은 레포)의 산출물 파일을 불러와 현재 산출물로 채운다(점진적 빌드용).
  const loadPreviousFiles = async () => {
    if (!github.repoId) {
      alert('먼저 레포를 선택하세요.');
      return;
    }
    if (files.length > 0 && !confirm('현재 파일들을 직전 레슨 소스로 덮어쓸까요?')) return;
    setLoadingPrev(true);
    try {
      const res = await repoApi.getPreviousLessonFiles(lesson.id, github.repoId);
      if (!res || !Array.isArray(res.files) || res.files.length === 0) {
        alert('이 레포를 사용하는 직전 레슨이 없습니다.');
        return;
      }
      // sourceModuleId 는 현재 레슨 기준이 아니므로 제거
      const cleaned = res.files.map((f) => ({ path: f.path, language: f.language, content: f.content }));
      setFiles(cleaned);
    } catch (e) {
      alert(`불러오기 실패: ${e.message}`);
    } finally {
      setLoadingPrev(false);
    }
  };

  const addFile = () => {
    setFiles([...files, { path: '', language: 'plaintext', content: '' }]);
  };

  const updateFile = (idx, patch) => {
    const next = files.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    setFiles(next);
  };

  const removeFile = (idx) => {
    setFiles(files.filter((_, i) => i !== idx));
  };

  // 현재 슬라이드의 code 모듈 파일들을 산출물로 가져온다.
  const importFromCodeModules = () => {
    const modules = slide?.contents?.modules || [];
    const codeModules = modules.filter((m) => m.type === 'code' && Array.isArray(m.files));
    const imported = [];
    codeModules.forEach((m) => {
      m.files.forEach((cf) => {
        const path = cf.name || `module-${m.id}.txt`;
        imported.push({
          path,
          language: cf.language || extToLang(path),
          content: cf.content || '',
          sourceModuleId: m.id,
        });
      });
    });
    if (imported.length === 0) {
      alert('현재 슬라이드에 가져올 code 모듈이 없습니다.');
      return;
    }
    // path 중복 제거: 기존에 없는 것만 추가
    const existingPaths = new Set(files.map((f) => f.path));
    const fresh = imported.filter((f) => !existingPaths.has(f.path));
    setFiles([...files, ...fresh]);
  };

  if (!lesson) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">GitHub 산출물</h2>
            <p className="text-xs text-slate-500">레슨 완료 시, 선택한 레포에 아래 파일들이 <b>레포 루트 기준 전체 경로</b>로 커밋됩니다. 같은 경로 파일은 갱신됩니다(점진적 빌드).</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </div>

        {/* 레포 선택 + 활성화 */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={!!github.enabled} onChange={(e) => setEnabled(e.target.checked)} />
            완료 시 GitHub 푸시 활성화
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">레포</span>
            <select
              value={github.repoId || ''}
              onChange={(e) => setRepoId(e.target.value)}
              className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-cyan-500 focus:outline-none"
            >
              <option value="">선택 안 함</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            {repos.length === 0 && (
              <a href="/admin/github-repos" target="_blank" rel="noreferrer" className="text-xs text-cyan-600 underline">레포 만들기</a>
            )}
          </div>
        </div>

        {/* 액션 버튼 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-5 py-2">
          <button
            type="button"
            onClick={loadPreviousFiles}
            disabled={loadingPrev || !github.repoId}
            className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            title="같은 레포를 쓰는 직전 레슨의 산출물을 불러옵니다"
          >
            {loadingPrev ? '불러오는 중…' : '↩ 직전 레슨 소스 불러오기'}
          </button>
          <button
            type="button"
            onClick={importFromCodeModules}
            className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            title="현재 슬라이드의 code 모듈 파일을 가져옵니다"
          >
            ⬇ 현재 슬라이드 code 모듈에서 가져오기
          </button>
          <button
            type="button"
            onClick={addFile}
            className="ml-auto rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600"
          >
            + 파일 추가
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {files.length === 0 && (
            <p className="py-12 text-center text-sm text-slate-400">
              아직 산출물 파일이 없습니다. "파일 추가" 또는 code 모듈에서 가져오기로 시작하세요.
            </p>
          )}
          {files.map((f, idx) => (
            <div key={idx} className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="text"
                  value={f.path || ''}
                  onChange={(e) => updateFile(idx, { path: e.target.value, language: f.language || extToLang(e.target.value) })}
                  placeholder="레포 루트 기준 경로 (예: index.html, src/app.js)"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 font-mono text-sm focus:border-cyan-500 focus:outline-none"
                />
                <select
                  value={f.language || 'plaintext'}
                  onChange={(e) => updateFile(idx, { language: e.target.value })}
                  className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 focus:border-cyan-500 focus:outline-none"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeFile(idx)}
                  className="rounded border border-slate-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  삭제
                </button>
              </div>
              <MonacoField
                value={f.content || ''}
                onChange={(val) => updateFile(idx, { content: val })}
                language={f.language || 'plaintext'}
                height={180}
                disableAutoFormat
              />
              {f.sourceModuleId !== undefined && (
                <p className="mt-1 text-[11px] text-slate-400">code 모듈 #{f.sourceModuleId} 에서 가져옴</p>
              )}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-slate-200 px-5 py-3 text-right">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-slate-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-900"
          >
            완료
          </button>
        </div>
      </div>
    </div>
  );
};

export default GithubDeliverablesPanel;
