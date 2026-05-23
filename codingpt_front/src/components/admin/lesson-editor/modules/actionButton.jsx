import * as PhosphorIcons from '@phosphor-icons/react';
import JsonField from './_shared/JsonField';
import ActionEditor from './_shared/ActionEditor';
import VisibilityBadge from './_shared/VisibilityBadge';
import { Field, TextField, SelectField } from './_shared/SharedFields';

const ROLE_OPTIONS = [
  { value: 'gate',    label: '게이트 (클릭 전까지 다음 모듈 정지) — 기본' },
  { value: 'default', label: '논블록 (다음 모듈 자동 진행)' },
];

const ButtonRow = ({ value, onChange, onRemove, index }) => (
  <div className="mb-3 rounded-md border border-slate-200 p-3">
    <div className="mb-2 flex items-center justify-between">
      <span className="text-xs font-semibold text-slate-500">버튼 #{index + 1}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100"
      >
        삭제
      </button>
    </div>
    <Field label="버튼 텍스트">
      <TextField value={value.text} onChange={(v) => onChange({ ...value, text: v })} placeholder="다음 레슨 바로가기" />
    </Field>
    <Field label="버튼 역할">
      <SelectField
        value={value.role || 'gate'}
        onChange={(r) => onChange({ ...value, role: r || 'gate' })}
        options={ROLE_OPTIONS}
      />
    </Field>
    <Field label="아이콘 (Phosphor 이름)">
      <TextField value={value.icon} onChange={(v) => onChange({ ...value, icon: v })} placeholder="ArrowRight" />
    </Field>
    <JsonField
      label="style"
      value={value.style}
      onChange={(v) => onChange({ ...value, style: v })}
      hint='{ "backgroundColor": "#8B54F7", "textColor": "#fff" }'
    />
    <ActionEditor value={value.action} onChange={(v) => onChange({ ...value, action: v })} />
  </div>
);

const SingleForm = ({ value, onChange }) => (
  <>
    <Field label="버튼 텍스트">
      <TextField value={value.text} onChange={(v) => onChange({ ...value, text: v })} placeholder="▶ 실행" />
    </Field>
    <Field label="버튼 역할">
      <SelectField
        value={value.role || 'gate'}
        onChange={(r) => onChange({ ...value, role: r || 'gate' })}
        options={ROLE_OPTIONS}
      />
    </Field>
    <Field label="아이콘 (Phosphor 이름)">
      <TextField value={value.icon} onChange={(v) => onChange({ ...value, icon: v })} placeholder="Play" />
    </Field>
    <JsonField label="style" value={value.style} onChange={(v) => onChange({ ...value, style: v })} hint='{ "backgroundColor": "#2F6FED", "textColor": "#fff", "width": 160, "height": 50 }' />
    <ActionEditor value={value.action} onChange={(v) => onChange({ ...value, action: v })} />
  </>
);

const MultiForm = ({ value, onChange }) => {
  const buttons = Array.isArray(value.buttons) ? value.buttons : [];

  const updateAt = (idx, next) => {
    const copy = buttons.slice();
    copy[idx] = next;
    onChange({ ...value, buttons: copy });
  };
  const removeAt = (idx) => {
    const copy = buttons.slice();
    copy.splice(idx, 1);
    onChange({ ...value, buttons: copy });
  };
  const append = () => {
    onChange({
      ...value,
      buttons: [...buttons, { text: '', role: 'default', action: { type: 'navigate_next_lesson' } }],
    });
  };

  return (
    <>
      {buttons.map((b, i) => (
        <ButtonRow
          key={i}
          index={i}
          value={b || {}}
          onChange={(next) => updateAt(i, next)}
          onRemove={() => removeAt(i)}
        />
      ))}
      <button
        type="button"
        onClick={append}
        className="w-full rounded border border-dashed border-slate-300 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
      >
        + 버튼 추가
      </button>
    </>
  );
};

// RN ActionButton.tsx 미러: 가운데 정렬 160x50 rounded 10 단일 버튼.
const ActionButtonPreview = ({ module }) => {
  const Icon = module.icon ? PhosphorIcons[module.icon] : null;
  const style = module.style || {};
  return (
    <div className="flex justify-center">
      <div
        style={{
          background: style.backgroundColor || '#2F6FED',
          width: style.width || 160,
          height: style.height || 50,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
        }}
      >
        {Icon && <Icon size={24} weight="fill" color={style.textColor || '#fff'} />}
        <span
          style={{
            color: style.textColor || '#fff',
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: '-0.32px',
          }}
        >
          {module.text || '▶ 실행'}
        </span>
      </div>
    </div>
  );
};

// RN ActionButtons.tsx 미러: full-width 56h 버튼 세로 스택, gap 20.
// hasItemVisibility=true 이므로 SlideCanvas 외부 VisibilityBadge 는 그리지 않고,
// buttons[i].visibility 를 각 버튼 옆(우측 외부)에 배치한다.
const ActionButtonsPreview = ({ module, onModuleChange }) => {
  const buttons = module.buttons || [];
  const updateButtonAt = (i, patch) => {
    if (!onModuleChange) return;
    const next = buttons.slice();
    next[i] = { ...next[i], ...patch };
    onModuleChange({ ...module, buttons: next });
  };

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      {buttons.map((b, i) => (
        <div key={b.id ?? i} className="relative w-full">
          <div
            style={{
              width: '100%',
              height: 56,
              borderRadius: 10,
              background: b.style?.backgroundColor || '#08875D',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            }}
          >
            <span
              style={{
                color: b.style?.textColor || '#fff',
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              {b.text || b.label || '버튼'}
            </span>
          </div>
          <div
            className="absolute z-20 -translate-y-1/2"
            style={{ left: 'calc(100% + 24px)', top: '50%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <VisibilityBadge
              value={b.visibility}
              onChange={(v) => updateButtonAt(i, { visibility: v })}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

export const actionButton = {
  type: 'actionButton',
  category: 'action',
  label: '액션 버튼',
  description: '단일 액션 버튼',
  icon: '',
  defaultValue: () => ({ type: 'actionButton', text: '▶ 실행', role: 'gate', action: { type: 'executeCode' } }),
  FormView: SingleForm,
  PreviewView: ActionButtonPreview,
};

export const actionButtons = {
  type: 'actionButtons',
  category: 'action',
  hasItemVisibility: true,
  label: '액션 버튼들',
  description: '여러 버튼 그룹 (엔딩 슬라이드 등)',
  icon: '',
  defaultValue: () => ({
    type: 'actionButtons',
    buttons: [
      { text: '다음 레슨 바로가기', role: 'default', action: { type: 'navigate_next_lesson' } },
      { text: '학습 종료',         role: 'default', action: { type: 'end_lesson' } },
    ],
  }),
  FormView: MultiForm,
  PreviewView: ActionButtonsPreview,
};

export default actionButton;
