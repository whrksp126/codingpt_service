import { useEffect, useRef, useState, useMemo } from 'react';
import { useEditor, selectSelectedSlide } from './state/EditorContext';
import { MODULES_BY_CATEGORY, CATEGORIES, getModuleDefinition } from './modules/_registry';

// 슬라이드 안에 존재하는 퀴즈 모듈(채점 가능 모듈) 타입 화이트리스트.
// RN runtime 에서 result.modules 처리하는 모듈들.
const QUIZ_TYPES = new Set([
  'multipleChoice',
  'trueFalseChoice',
  'codeFillTheGapV2',
]);

const ModulePopover = ({ onClose }) => {
  const { state, dispatch } = useEditor();
  const slide = selectSelectedSlide(state);
  const slideId = state.selection.slideId;
  const ref = useRef(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');

  // 채점 후 등장 옵션 — 'correct' | 'wrong' 둘 중 하나로 강제. 항상 등장은 일반 모듈로 추가.
  const [postGrading, setPostGrading] = useState(false);
  const [targetQuizId, setTargetQuizId] = useState(null);
  const [condition, setCondition] = useState('correct');

  // 슬라이드 내 퀴즈 모듈 목록
  const quizModules = useMemo(() => {
    return (slide?.contents?.modules || []).filter((m) => QUIZ_TYPES.has(m.type));
  }, [slide]);

  // 퀴즈가 사라지거나 변경되면 targetQuizId 동기화
  useEffect(() => {
    if (!postGrading) return;
    if (quizModules.length === 0) {
      setPostGrading(false);
      setTargetQuizId(null);
      return;
    }
    if (!targetQuizId || !quizModules.some((q) => q.id === targetQuizId)) {
      setTargetQuizId(quizModules[0].id);
    }
  }, [postGrading, quizModules, targetQuizId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return MODULES_BY_CATEGORY.map((cat) => ({
      ...cat,
      modules: cat.modules.filter((m) => {
        if (activeCategory !== 'all' && cat.key !== activeCategory) return false;
        if (!term) return true;
        return (
          (m.label || '').toLowerCase().includes(term) ||
          (m.description || '').toLowerCase().includes(term) ||
          (m.type || '').toLowerCase().includes(term)
        );
      }),
    })).filter((cat) => cat.modules.length > 0);
  }, [activeCategory, search]);

  const handleAdd = (def) => {
    if (!slideId) return;

    const baseModule = def.defaultValue();

    if (postGrading && targetQuizId) {
      // 채점 후 등장: 대상 퀴즈 모듈의 result.modules 에 추가하면서 condition 설정.
      const quiz = quizModules.find((q) => q.id === targetQuizId);
      if (quiz) {
        const newResultMod = {
          ...baseModule,
          id: baseModule.id ?? `r${Date.now()}`,
          condition,
        };
        const currentResult = quiz.result || {};
        const currentMods = currentResult.modules || [];
        dispatch({
          type: 'updateModule',
          slideId,
          moduleId: targetQuizId,
          patch: {
            result: { ...currentResult, modules: [...currentMods, newResultMod] },
          },
        });
        onClose();
        return;
      }
    }

    // 일반 슬라이드 모듈 추가
    dispatch({
      type: 'addModule',
      slideId,
      module: baseModule,
    });
    onClose();
  };

  const hasQuiz = quizModules.length > 0;

  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-2">
      <div
        ref={ref}
        className="flex max-h-[70vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">모듈 추가</h3>
            <span className="text-xs text-slate-400">ESC로 닫기</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        {hasQuiz && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={postGrading}
                onChange={(e) => setPostGrading(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              채점 후 등장 모듈로 추가
            </label>
            {postGrading && (
              <>
                {quizModules.length > 1 && (
                  <label className="flex items-center gap-1.5 text-xs text-slate-700">
                    대상 퀴즈
                    <select
                      value={targetQuizId ?? ''}
                      onChange={(e) => setTargetQuizId(e.target.value || null)}
                      className="rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                    >
                      {quizModules.map((q) => {
                        const def = getModuleDefinition(q.type);
                        return (
                          <option key={q.id} value={q.id}>
                            {def?.icon} {def?.label || q.type} (id: {String(q.id)})
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-xs text-slate-700">
                  조건
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                  >
                    <option value="correct">정답일 때</option>
                    <option value="wrong">오답일 때</option>
                  </select>
                </label>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="모듈 검색"
            className="flex-1 min-w-[160px] rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
            autoFocus
          />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setActiveCategory('all')}
              className={
                'rounded px-2 py-1 text-xs ' +
                (activeCategory === 'all'
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
              }
            >
              전체
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat.key}
                type="button"
                onClick={() => setActiveCategory(cat.key)}
                className={
                  'rounded px-2 py-1 text-xs ' +
                  (activeCategory === cat.key
                    ? 'bg-slate-800 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                }
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-slate-400">검색 결과 없음</div>
          )}
          {filtered.map((cat) => (
            <div key={cat.key} className="mb-3 last:mb-0">
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {cat.label}
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                {cat.modules.map((m) => (
                  <button
                    key={m.type}
                    type="button"
                    onClick={() => handleAdd(m)}
                    className="flex flex-col items-start gap-0.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-cyan-400 hover:bg-cyan-50"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">{m.icon}</span>
                      <span className="text-sm font-medium text-slate-800">{m.label}</span>
                    </div>
                    {m.description && (
                      <span className="line-clamp-2 text-[11px] text-slate-500">
                        {m.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ModulePopover;
