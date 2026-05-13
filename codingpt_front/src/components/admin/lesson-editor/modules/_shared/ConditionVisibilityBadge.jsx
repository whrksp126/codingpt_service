import { useEffect, useRef, useState } from 'react';
import { Field, SelectField } from './SharedFields';

// 채점 후 등장 모듈의 분기(모두/정답/오답)만 선택하는 뱃지.
// 가시성(duration/step 등)은 각 모듈/콘텐츠가 자체 visibility 필드로 관리하므로 여기서는 다루지 않는다.

const BRANCH_LABEL = { all: '모두', correct: '정답', wrong: '오답' };
const BRANCH_COLOR = {
  all: 'bg-slate-50 text-slate-700 border-slate-200',
  correct: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  wrong: 'bg-rose-50 text-rose-700 border-rose-200',
};

const ConditionVisibilityBadge = ({ branch, onBranchChange }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const branchKey = branch || 'all';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          'whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shadow-sm transition ' +
          (BRANCH_COLOR[branchKey] || BRANCH_COLOR.all)
        }
        title="등장 조건"
      >
        {BRANCH_LABEL[branchKey] || '모두'}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <Field label="조건">
            <SelectField
              value={branchKey}
              onChange={(t) => onBranchChange?.(t)}
              options={[
                { value: 'all',     label: '모두 (정답/오답 무관)' },
                { value: 'correct', label: '정답일 때' },
                { value: 'wrong',   label: '오답일 때' },
              ]}
            />
          </Field>
        </div>
      )}
    </div>
  );
};

export default ConditionVisibilityBadge;
