import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Field, SelectField } from './SharedFields';

// 등장 트리거 칩 — VisibilityBadge 와 동일한 popover 인라인 편집 패턴.
// VisibilityBadge 가 우측 외부에 있고, 이 칩은 좌측 외부에 배치된다.

const branchLabel = (b) => {
  if (!b || b === 'all') return '무관';
  if (b === 'correct') return '정답';
  if (b === 'wrong') return '오답';
  return b;
};

const formatLabel = (trigger) => {
  if (!trigger || !trigger.type) return '기본';
  if (trigger.type === 'afterGrading') {
    const src = trigger.sourceModuleId != null ? `#${trigger.sourceModuleId}` : '?';
    const br = ` · ${branchLabel(trigger.branch)}`;
    return `채점 후 등장 · ${src}${br}`;
  }
  if (trigger.type === 'afterButtonClick') {
    const src = trigger.sourceModuleId != null ? `#${trigger.sourceModuleId}` : '?';
    return `버튼 클릭 시 · ${src}`;
  }
  return trigger.type;
};

const badgeColor = (type) => {
  switch (type) {
    case 'afterGrading':     return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'afterButtonClick': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    default:                 return 'bg-slate-50 text-slate-500 border-slate-200';
  }
};

const TriggerBadge = ({ module, onChange, slideModules }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const trigger = module.trigger;
  const type = trigger?.type || '';

  const quizzes = (slideModules || []).filter(
    (m) => ['codeFillTheGapV2', 'multipleChoice', 'trueFalseChoice'].includes(m.type)
      && String(m.id) !== String(module.id),
  );
  const buttons = (slideModules || []).filter(
    (m) => ['actionButton', 'actionButtons'].includes(m.type)
      && String(m.id) !== String(module.id),
  );

  const setType = (t) => {
    if (!t) return onChange({ ...module, trigger: undefined });
    if (t === 'afterGrading') return onChange({
      ...module,
      trigger: { type: 'afterGrading', sourceModuleId: quizzes[0]?.id ?? '', branch: 'all' },
    });
    if (t === 'afterButtonClick') return onChange({
      ...module,
      trigger: { type: 'afterButtonClick', sourceModuleId: buttons[0]?.id ?? '' },
    });
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          'whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shadow-sm transition ' +
          badgeColor(type)
        }
        title="등장 시점"
      >
        {formatLabel(trigger)}
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <Field label="등장 시점">
            <SelectField
              value={type}
              onChange={setType}
              options={[
                { value: 'afterGrading',     label: '채점 후 등장' },
                { value: 'afterButtonClick', label: '버튼 클릭 시' },
              ]}
              placeholder="기본"
            />
          </Field>
          {type === 'afterGrading' && (
            <>
              <Field label="기준 퀴즈 모듈">
                <SelectField
                  value={String(trigger?.sourceModuleId ?? '')}
                  onChange={(id) => onChange({ ...module, trigger: { ...trigger, sourceModuleId: id } })}
                  options={quizzes.map((m) => ({ value: String(m.id), label: `#${m.id} · ${m.type}` }))}
                  placeholder={quizzes.length === 0 ? '슬라이드에 퀴즈 모듈 없음' : '퀴즈 모듈 선택'}
                />
              </Field>
              <Field label="분기">
                <div className="flex flex-col gap-1 text-[11px]">
                  {['all', 'correct', 'wrong'].map((b) => (
                    <label key={b} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name={`trigger-branch-${module.id}`}
                        checked={(trigger?.branch || 'all') === b}
                        onChange={() => onChange({ ...module, trigger: { ...trigger, branch: b } })}
                      />
                      <span>{branchLabel(b)}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}
          {type === 'afterButtonClick' && (
            <Field label="기준 actionButton 모듈">
              <SelectField
                value={String(trigger?.sourceModuleId ?? '')}
                onChange={(id) => onChange({ ...module, trigger: { ...trigger, sourceModuleId: id } })}
                options={buttons.map((m) => ({ value: String(m.id), label: `#${m.id} · ${m.type}` }))}
                placeholder={buttons.length === 0 ? '슬라이드에 actionButton 없음' : 'actionButton 선택'}
              />
            </Field>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default TriggerBadge;
