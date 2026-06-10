import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../../../utils/lessonApi';
import { useEditor } from './state/EditorContext';
import CharacterPool from './CharacterPool';
import GithubDeliverablesPanel from './GithubDeliverablesPanel';

const SAVE_LABEL = {
  idle: '저장 대기',
  saving: '저장 중…',
  saved: '저장됨',
  error: '저장 실패',
};

const EditorTopBar = () => {
  const { state, dispatch } = useEditor();
  const { lesson, ui } = state;
  const [publishing, setPublishing] = useState(false);
  const [showGithub, setShowGithub] = useState(false);

  if (!lesson) return null;

  const isPublished = !!lesson.published_at;
  const githubEnabled = !!(lesson.meta && lesson.meta.github && lesson.meta.github.repoId);

  const handlePublishToggle = async () => {
    if (ui.dirty) {
      alert('저장되지 않은 변경사항이 있습니다. 잠시 후 다시 시도하세요.');
      return;
    }
    setPublishing(true);
    try {
      const data = await api.publishLesson(lesson.id, !isPublished);
      dispatch({
        type: 'updateLessonMeta',
        patch: { published_at: data.published_at },
      });
      dispatch({ type: 'savingState', value: 'saved' });
    } catch (e) {
      alert(`발행 실패: ${e.message}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <div className="flex shrink-0 items-center gap-3">
        <Link to="/admin/lessons" className="text-sm text-slate-500 hover:text-slate-900">
          ← 목록
        </Link>
        <input
          type="text"
          value={lesson.name}
          onChange={(e) => dispatch({ type: 'updateLessonMeta', patch: { name: e.target.value } })}
          className="w-64 rounded border border-transparent px-2 py-1 text-base font-semibold text-slate-900 hover:border-slate-200 focus:border-cyan-500 focus:outline-none"
          placeholder="레슨 이름"
        />
        <input
          type="text"
          value={lesson.type || ''}
          onChange={(e) => dispatch({ type: 'updateLessonMeta', patch: { type: e.target.value } })}
          className="w-20 rounded border border-transparent px-2 py-1 text-sm text-slate-500 hover:border-slate-200 focus:border-cyan-500 focus:outline-none"
          placeholder="유형"
          title="레슨 유형"
        />
      </div>
      <CharacterPool />
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <span
          className={
            'rounded px-2 py-1 ' +
            (ui.saving === 'saving'
              ? 'bg-amber-50 text-amber-700'
              : ui.saving === 'saved'
                ? 'bg-emerald-50 text-emerald-700'
                : ui.saving === 'error'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-slate-100 text-slate-500')
          }
        >
          {SAVE_LABEL[ui.saving]}
          {ui.saving === 'error' && ui.error ? ` — ${ui.error}` : ''}
        </span>
        <button
          type="button"
          onClick={() => dispatch({ type: 'undo' })}
          className="rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
          title="실행 취소"
        >
          ↶
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'redo' })}
          className="rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50"
          title="다시 실행"
        >
          ↷
        </button>
        <button
          type="button"
          onClick={() => setShowGithub(true)}
          className={
            'rounded border px-3 py-1 text-xs font-semibold ' +
            (githubEnabled
              ? 'border-slate-800 bg-slate-800 text-white hover:bg-slate-900'
              : 'border-slate-200 text-slate-600 hover:bg-slate-50')
          }
          title="GitHub 산출물 정의"
        >
          {githubEnabled ? '✓ GitHub 산출물' : 'GitHub 산출물'}
        </button>
        <button
          type="button"
          onClick={handlePublishToggle}
          disabled={publishing}
          className={
            'rounded px-3 py-1 text-xs font-semibold ' +
            (isPublished
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
              : 'bg-cyan-500 text-white hover:bg-cyan-600') +
            ' disabled:opacity-50'
          }
        >
          {publishing ? '...' : (isPublished ? '✓ 발행됨' : '발행')}
        </button>
      </div>
      {showGithub && <GithubDeliverablesPanel onClose={() => setShowGithub(false)} />}
    </header>
  );
};

export default EditorTopBar;
