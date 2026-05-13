import { useEffect, useMemo, useState } from 'react';
import { getModuleDefinition } from '../_registry';
import {
  collectBranch,
  appendToBranch,
  removeModuleAt,
  replaceModuleAt,
} from './resultBranches';

// 퀴즈 result 편집 — 모두 / 정답 / 오답 세 분기로 분리해 편집한다.
// 데이터는 value.result.modules(condition 기반) + value.allResult/correctResult/incorrectResult(키 기반) 둘 다 지원.
// 신규 모듈 추가 시 현재 탭에 해당하는 분기 키(allResult/correctResult/incorrectResult)로 push.
const ADDABLE = ['characterSpeechBubble', 'paragraph', 'image', 'missionList', 'webview', 'terminal'];

const BRANCH_LABEL = { all: '모두', correct: '정답일 때', wrong: '오답일 때' };
const BRANCH_COLOR = {
  all: 'border-slate-500 bg-slate-100 text-slate-700',
  correct: 'border-emerald-500 bg-emerald-50 text-emerald-700',
  wrong: 'border-rose-500 bg-rose-50 text-rose-700',
};

const TabButton = ({ active, onClick, label, count, color }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      'flex-1 rounded-md border px-2 py-1 text-xs font-medium transition ' +
      (active
        ? color
        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
    }
  >
    {label} <span className="ml-1 text-[10px] opacity-70">({count})</span>
  </button>
);

// 분기/가시성 편집은 캔버스 프리뷰 우측 외부의 통합 뱃지에서 처리한다.
// 우측 인스펙터의 모듈 항목은 모듈 콘텐츠 편집만 담당.
const ResultModuleItem = ({ item, index, value, onChange, onRemove }) => {
  const m = item.module;
  const def = getModuleDefinition(m.type);
  const SubForm = def?.FormView;
  return (
    <div className={'mb-3' + (index === 0 ? '' : ' mt-3 border-t border-slate-200 pt-3')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm text-slate-700">
          {def?.label || m.type}
          <span className="ml-1 text-slate-400">#{index + 1}</span>
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-red-500 hover:underline"
        >
          삭제
        </button>
      </div>
      {SubForm ? (
        <SubForm
          value={m}
          onChange={(next) => onChange(replaceModuleAt(value, item.source, item.sourceIndex, next))}
        />
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
  const allItems = collectBranch(value, 'all');
  const correctItems = collectBranch(value, 'correct');
  const wrongItems = collectBranch(value, 'wrong');
  const initialTab = allItems.length > 0
    ? 'all'
    : (correctItems.length === 0 && wrongItems.length > 0 ? 'wrong' : 'correct');
  const [tab, setTab] = useState(initialTab);
  const [showAdd, setShowAdd] = useState(false);

  const items = tab === 'all' ? allItems : tab === 'correct' ? correctItems : wrongItems;

  const handlePick = (def) => {
    const m = def?.defaultValue?.() || { type: def?.type };
    m.id = m.id ?? `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    onChange(appendToBranch(value, tab, m));
  };

  const handleRemove = (item) => {
    onChange(removeModuleAt(value, item.source, item.sourceIndex));
  };

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          채점 후 등장 모듈
        </span>
      </div>
      <div className="mb-2 flex gap-1">
        <TabButton
          active={tab === 'all'}
          onClick={() => setTab('all')}
          label={BRANCH_LABEL.all}
          count={allItems.length}
          color={BRANCH_COLOR.all}
        />
        <TabButton
          active={tab === 'correct'}
          onClick={() => setTab('correct')}
          label={BRANCH_LABEL.correct}
          count={correctItems.length}
          color={BRANCH_COLOR.correct}
        />
        <TabButton
          active={tab === 'wrong'}
          onClick={() => setTab('wrong')}
          label={BRANCH_LABEL.wrong}
          count={wrongItems.length}
          color={BRANCH_COLOR.wrong}
        />
      </div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-cyan-500 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-cyan-600"
        >
          + 모듈 추가 ({BRANCH_LABEL[tab]})
        </button>
      </div>
      {items.length === 0 ? (
        <p className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
          {BRANCH_LABEL[tab]}에 등장할 모듈이 없습니다.
        </p>
      ) : (
        items.map((it, i) => (
          <ResultModuleItem
            key={`${it.source}-${it.sourceIndex}`}
            item={it}
            index={i}
            value={value}
            onChange={onChange}
            onRemove={() => handleRemove(it)}
          />
        ))
      )}
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
