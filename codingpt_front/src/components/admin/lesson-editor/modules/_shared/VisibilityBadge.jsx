import { useEffect, useRef, useState } from 'react';
import { SelectField, NumberField, Field } from './SharedFields';

const formatLabel = (value) => {
  if (!value || !value.type) return '항상';
  if (value.type === 'duration') return `duration · ${value.time ?? 0}ms`;
  if (value.type === 'step') return `step ${value.value ?? 0}`;
  if (value.type === 'time') {
    const show = value.showDelay ?? 0;
    const hide = value.hideDelay ?? '∞';
    return `time · ${show}–${hide}`;
  }
  return value.type;
};

const badgeColor = (type) => {
  switch (type) {
    case 'duration': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'step':     return 'bg-cyan-50 text-cyan-700 border-cyan-200';
    case 'time':     return 'bg-violet-50 text-violet-700 border-violet-200';
    default:         return 'bg-slate-50 text-slate-500 border-slate-200';
  }
};

const VisibilityBadge = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
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

  const type = value?.type || '';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={
          'whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shadow-sm transition ' +
          badgeColor(type)
        }
        title="가시성 / 등장 타이밍"
      >
        {formatLabel(value)}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <Field label="타입">
            <SelectField
              value={type}
              onChange={(t) => {
                if (!t) return onChange(undefined);
                if (t === 'duration') return onChange({ type: 'duration', time: 1000 });
                if (t === 'step')     return onChange({ type: 'step', value: 1 });
                if (t === 'time')     return onChange({ type: 'time' });
              }}
              options={[
                { value: 'duration', label: 'duration (시간 후 표시)' },
                { value: 'step',     label: 'step (특정 단계)' },
                { value: 'time',     label: 'time (legacy)' },
              ]}
              placeholder="(없음 = 항상 표시)"
            />
          </Field>
          {type === 'duration' && (
            <Field label="time (ms)">
              <NumberField
                value={value.time}
                onChange={(t) => onChange({ ...value, time: t || 0 })}
                min={0}
              />
            </Field>
          )}
          {type === 'step' && (
            <Field label="단계 번호">
              <NumberField
                value={value.value}
                onChange={(v) => onChange({ ...value, value: v || 0 })}
                min={0}
              />
            </Field>
          )}
          {type === 'time' && (
            <>
              <Field label="showDelay (ms)">
                <NumberField
                  value={value.showDelay}
                  onChange={(v) => onChange({ ...value, showDelay: v ?? 0 })}
                  min={0}
                />
              </Field>
              <Field label="hideDelay (ms)">
                <NumberField
                  value={value.hideDelay}
                  onChange={(v) => onChange({ ...value, hideDelay: v })}
                  min={0}
                />
              </Field>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default VisibilityBadge;
