import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SelectField, NumberField, Field } from './SharedFields';

const formatLabel = (value) => {
  if (!value || !value.type) return '항상';
  if (value.type === 'duration') return `시간 후 · ${value.time ?? 0}ms`;
  if (value.type === 'ttsHold') return `TTS 후 · ${value.time ?? 0}ms`;
  if (value.type === 'step') return `단계 ${value.value ?? 0}`;
  if (value.type === 'time') {
    const show = value.showDelay ?? 0;
    const hide = value.hideDelay ?? '∞';
    return `시간 · ${show}–${hide}`;
  }
  return value.type;
};

// "항상" 도 duration 과 동일 amber — 가시성 칩 전체를 같은 색 계열로 통일.
const badgeColor = (type) => {
  switch (type) {
    case 'duration': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'ttsHold':  return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'step':     return 'bg-cyan-50 text-cyan-700 border-cyan-200';
    case 'time':     return 'bg-violet-50 text-violet-700 border-violet-200';
    default:         return 'bg-amber-50 text-amber-700 border-amber-200';
  }
};

const VisibilityBadge = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // 칩 위치 기준으로 popover 좌표 계산 — dnd-kit transform 이 만든 stacking context 우회 위해
  // document.body 로 portal + position:fixed 사용.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POPOVER_WIDTH = 224; // w-56 = 14rem = 224px
    setPos({ top: rect.bottom + 4, left: rect.right - POPOVER_WIDTH });
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
      {open && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <Field label="가시성 타입">
            <SelectField
              value={type}
              onChange={(t) => {
                if (!t) return onChange(undefined);
                if (t === 'duration') return onChange({ type: 'duration', time: 1000 });
                if (t === 'ttsHold')  return onChange({ type: 'ttsHold', time: 0 });
                if (t === 'step')     return onChange({ type: 'step', value: 1 });
                if (t === 'time')     return onChange({ type: 'time' });
              }}
              options={[
                { value: 'duration', label: '시간 후 표시' },
                { value: 'ttsHold',  label: 'TTS 재생 후 지속' },
                { value: 'step',     label: '특정 단계에서 표시' },
                { value: 'time',     label: '시간 범위 표시 (legacy)' },
              ]}
              placeholder="항상 표시"
            />
          </Field>
          {type === 'duration' && (
            <Field label="등장 후 머무는 시간 (ms)">
              <NumberField
                value={value.time}
                onChange={(t) => onChange({ ...value, time: t || 0 })}
                min={0}
              />
            </Field>
          )}
          {type === 'ttsHold' && (
            <Field label="TTS 종료 후 유지 시간 (ms)">
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
              <Field label="표시 지연 (ms)">
                <NumberField
                  value={value.showDelay}
                  onChange={(v) => onChange({ ...value, showDelay: v ?? 0 })}
                  min={0}
                />
              </Field>
              <Field label="숨김 지연 (ms)">
                <NumberField
                  value={value.hideDelay}
                  onChange={(v) => onChange({ ...value, hideDelay: v })}
                  min={0}
                />
              </Field>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default VisibilityBadge;
