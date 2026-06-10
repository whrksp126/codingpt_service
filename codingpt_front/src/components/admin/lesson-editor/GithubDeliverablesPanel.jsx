import { useEditor, selectSelectedSlide } from './state/EditorContext';
import MonacoField from './modules/_shared/MonacoField';

// 레슨 산출물(GitHub 푸시 대상) 정의 패널.
// lesson.meta.github = { enabled, files: [{ path, language, content, sourceModuleId }] } 를 편집한다.
// 학습자가 레슨을 완료하면 백엔드가 이 파일들을 클래스 레포의 섹션/레슨 폴더에 커밋한다.

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

  const writeGithub = (nextGithub) => {
    dispatch({
      type: 'updateLessonMeta',
      patch: { meta: { ...(lesson.meta || {}), github: nextGithub } },
    });
  };

  const setFiles = (nextFiles) => writeGithub({ ...github, files: nextFiles });
  const setEnabled = (enabled) => writeGithub({ ...github, enabled });

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
            <p className="text-xs text-slate-500">학습자가 이 레슨을 완료하면 아래 파일들이 학습자 GitHub 레포에 커밋됩니다.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-5 py-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={!!github.enabled} onChange={(e) => setEnabled(e.target.checked)} />
            완료 시 GitHub 푸시 활성화
          </label>
          <div className="ml-auto flex gap-2">
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
              className="rounded bg-cyan-500 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-600"
            >
              + 파일 추가
            </button>
          </div>
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
                  placeholder="파일 경로 (예: src/index.html)"
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
