import { useEffect, useRef, useState } from 'react';
import { Field, SelectField } from './SharedFields';

// 퀴즈 채점 후 등장 모듈에 부여되는 condition 뱃지.
// value 는 baseModuleFields.condition 과 동일한 단일 문자열로, UI 상에서는 'correct' | 'wrong' 둘 중 하나만 노출한다.
// (legacy 데이터로 'always' 또는 undefined 가 들어올 수 있는데, 이때는 'correct' 로 정규화해 보여준다.)

const formatLabel = (type) => {
  if (type === 'wrong') return '오답 시';
  return '정답 시';
};

const badgeColor = (type) => {
  switch (type) {
    case 'correct': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'wrong':   return 'bg-rose-50 text-rose-700 border-rose-200';
    default:        return 'bg-slate-50 text-slate-500 border-slate-200';
  }
};

const ConditionBadge = ({ value, onChange }) => {
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

  // 객체 형태로 들어오면 type 만 추출, legacy('always' / undefined)는 'correct' 로 정규화.
  const raw = (typeof value === 'object' && value !== null) ? value.type : value;
  const type = raw === 'wrong' ? 'wrong' : 'correct';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          'whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shadow-sm transition ' +
          badgeColor(type)
        }
        title="채점 후 등장 조건"
      >
        {formatLabel(type)}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <Field label="조건">
            <SelectField
              value={type}
              onChange={(t) => onChange(t === 'wrong' ? 'wrong' : 'correct')}
              options={[
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

export default ConditionBadge;
