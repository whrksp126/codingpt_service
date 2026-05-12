import { useEffect, useMemo, useState } from 'react';
import { getModuleDefinition } from '../_registry';

// 퀴즈 result.modules — 채점 후 등장하는 모듈 배열을 우측 폼에서 편집한다.
// 결과 모듈은 "존재하면 활성"이므로 토글/펼치기 없이 라벨 + condition + 삭제 + 인라인 폼만 표시.
// condition 은 'correct' | 'wrong' 둘 중 하나로 강제 (UI 상 항상 등장은 별도 모듈로 처리).
// "+ 모듈 추가" 버튼 클릭 시 ModulePopover 와 동일한 모달 UX 로 ADDABLE 화이트리스트 모듈을 선택한다.
const ADDABLE = ['characterSpeechBubble', 'paragraph', 'image', 'missionList'];

const ConditionToggle = ({ value, onChange }) => {
  const current = value === 'wrong' ? 'wrong' : 'correct';
  const baseBtn = 'rounded px-2 py-0.5 text-xs font-medium border transition';
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={() => onChange('correct')}
        className={
          baseBtn + ' ' + (current === 'correct'
            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
        }
      >
        정답일 때
      </button>
      <button
        type="button"
        onClick={() => onChange('wrong')}
        className={
          baseBtn + ' ' + (current === 'wrong'
            ? 'border-rose-500 bg-rose-50 text-rose-700'
            : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
        }
      >
        오답일 때
      </button>
    </div>
  );
};

const ResultModuleItem = ({ module: m, index: i, onChange, onConditionChange, onRemove, isFirst }) => {
  const def = getModuleDefinition(m.type);
  const SubForm = def?.FormView;

  return (
    <div className={'mb-3' + (isFirst ? '' : ' mt-3 border-t border-slate-200 pt-3')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm text-slate-700">
          {def?.label || m.type}
          <span className="ml-1 text-slate-400">#{i + 1}</span>
        </span>
        <div className="flex items-center gap-2">
          <ConditionToggle value={m.condition} onChange={onConditionChange} />
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-red-500 hover:underline"
          >
            삭제
          </button>
        </div>
      </div>
      {SubForm ? (
        <SubForm value={m} onChange={onChange} />
      ) : (
        <div className="text-xs text-amber-600">알 수 없는 모듈 타입: {m.type}</div>
      )}
    </div>
  );
};

const ResultModulesAddModal = ({ onClose, onPick }) => {
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo(() => {
    const term = search.trim().toLowerCase();
    return ADDABLE
      .map((t) => getModuleDefinition(t))
      .filter(Boolean)
      .filter((d) => {
        if (!term) return true;
        return (
          (d.label || '').toLowerCase().includes(term) ||
          (d.description || '').toLowerCase().includes(term) ||
          (d.type || '').toLowerCase().includes(term)
        );
      });
  }, [search]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-16"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">채점 후 등장 모듈 추가</h3>
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
        <div className="border-b border-slate-200 px-4 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="모듈 검색"
            className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">검색 결과 없음</div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {items.map((m) => (
                <button
                  key={m.type}
                  type="button"
                  onClick={() => { onPick(m); onClose(); }}
                  className="flex flex-col items-start gap-0.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-cyan-400 hover:bg-cyan-50"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-base">{m.icon}</span>
                    <span className="text-sm font-medium text-slate-800">{m.label}</span>
                  </div>
                  {m.description && (
                    <span className="line-clamp-2 text-[11px] text-slate-500">{m.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ResultModulesField = ({ value, onChange }) => {
  const [showAdd, setShowAdd] = useState(false);
  const modules = value?.modules || [];
  const setModules = (next) => onChange({ ...(value || {}), modules: next });
  const updateAt = (i, next) => setModules(modules.map((m, idx) => (idx === i ? next : m)));
  const removeAt = (i) => setModules(modules.filter((_, idx) => idx !== i));
  const handlePick = (def) => {
    const m = def?.defaultValue?.() || { type: def?.type };
    m.id = m.id ?? Date.now();
    m.condition = 'correct';
    setModules([...modules, m]);
  };

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          채점 후 등장 모듈 ({modules.length})
        </span>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-cyan-500 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-cyan-600"
        >
          + 모듈 추가
        </button>
      </div>
      {modules.map((m, i) => (
        <ResultModuleItem
          key={m.id ?? i}
          module={m}
          index={i}
          isFirst={i === 0}
          onChange={(next) => updateAt(i, next)}
          onConditionChange={(c) => updateAt(i, { ...m, condition: c })}
          onRemove={() => removeAt(i)}
        />
      ))}
      {showAdd && (
        <ResultModulesAddModal
          onClose={() => setShowAdd(false)}
          onPick={handlePick}
        />
      )}
    </div>
  );
};

export default ResultModulesField;
