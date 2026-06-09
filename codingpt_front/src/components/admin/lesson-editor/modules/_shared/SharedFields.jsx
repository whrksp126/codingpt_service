import { useState } from 'react';

export const Field = ({ label, children, hint }) => (
  <label className="mb-3 block">
    <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
  </label>
);

export const TextField = ({ value, onChange, placeholder, multiline, rows = 3 }) => {
  if (multiline) {
    return (
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
      />
    );
  }
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
    />
  );
};

export const NumberField = ({ value, onChange, min, max, step = 1, placeholder }) => (
  <input
    type="number"
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    min={min}
    max={max}
    step={step}
    placeholder={placeholder}
    className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
  />
);

export const SelectField = ({ value, onChange, options, placeholder }) => (
  <select
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
  >
    {placeholder && <option value="">{placeholder}</option>}
    {options.map((o) => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
);

export const ColorField = ({ value, onChange }) => (
  <div className="flex items-center gap-2">
    <input
      type="color"
      value={value || '#000000'}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-12 cursor-pointer rounded border border-slate-200"
    />
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="#FFFFFF or rgba(...)"
      className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs font-mono focus:border-cyan-500 focus:outline-none"
    />
  </div>
);

export const Switch = ({ checked, onChange, size = 'md' }) => {
  const dims = size === 'sm'
    ? { track: 'h-4 w-7', knob: 'h-3 w-3', on: 'translate-x-[14px]', off: 'translate-x-0.5' }
    : { track: 'h-4 w-7', knob: 'h-3 w-3', on: 'translate-x-[14px]', off: 'translate-x-0.5' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
      className={
        `relative inline-flex shrink-0 items-center rounded-full transition-colors ${dims.track} ` +
        (checked ? 'bg-cyan-500' : 'bg-slate-300')
      }
    >
      <span
        className={
          `inline-block transform rounded-full bg-white shadow transition-transform ${dims.knob} ` +
          (checked ? dims.on : dims.off)
        }
      />
    </button>
  );
};

export const ToggleField = ({ value, onChange, label }) => (
  <label className="mb-2 flex cursor-pointer items-center justify-between gap-2">
    <span className="text-sm text-slate-700">{label}</span>
    <Switch checked={!!value} onChange={onChange} />
  </label>
);

export const Section = ({ title, children, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3 rounded-lg border border-slate-200">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
        <Switch checked={open} onChange={setOpen} size="sm" />
      </div>
      {open && <div className="border-t border-slate-200 p-3">{children}</div>}
    </div>
  );
};

export const VisibilityField = ({ value, onChange }) => {
  const type = value?.type;
  return (
    <Section title="가시성" defaultOpen={false}>
      <Field label="타입">
        <SelectField
          value={type || ''}
          onChange={(t) => {
            if (!t) return onChange(undefined);
            if (t === 'duration') onChange({ type: 'duration', time: 1000 });
            if (t === 'ttsHold') onChange({ type: 'ttsHold', time: 0 });
            if (t === 'step') onChange({ type: 'step', value: 1 });
            if (t === 'time') onChange({ type: 'time' });
          }}
          options={[
            { value: 'duration', label: 'duration (시간 후 표시)' },
            { value: 'ttsHold', label: 'ttsHold (TTS 재생 후 지속)' },
            { value: 'step', label: 'step (특정 단계)' },
            { value: 'time', label: 'time (legacy)' },
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
        <Field label="value (단계 번호)">
          <NumberField
            value={value.value}
            onChange={(v) => onChange({ ...value, value: v || 0 })}
            min={0}
          />
        </Field>
      )}
    </Section>
  );
};

export { default as TTSField } from './TTSField';
