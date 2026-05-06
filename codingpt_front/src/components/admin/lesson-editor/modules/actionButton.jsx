import * as PhosphorIcons from '@phosphor-icons/react';
import JsonField from './_shared/JsonField';
import { Field, TextField } from './_shared/SharedFields';

const SingleForm = ({ value, onChange }) => (
  <>
    <Field label="버튼 텍스트">
      <TextField value={value.text} onChange={(v) => onChange({ ...value, text: v })} placeholder="▶ 실행" />
    </Field>
    <Field label="아이콘 (Phosphor 이름)">
      <TextField value={value.icon} onChange={(v) => onChange({ ...value, icon: v })} placeholder="Play" />
    </Field>
    <JsonField label="style" value={value.style} onChange={(v) => onChange({ ...value, style: v })} hint='{ "backgroundColor": "#2F6FED", "textColor": "#fff", "width": 160, "height": 50 }' />
    <JsonField label="action" value={value.action} onChange={(v) => onChange({ ...value, action: v })} hint='예: { "type": "executeCode", "s3Path": "...", "targetWebViewId": "..." }' />
  </>
);

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
const ActionButtonsPreview = ({ module }) => (
  <div className="flex flex-col" style={{ gap: 20 }}>
    {(module.buttons || []).map((b, i) => (
      <div
        key={i}
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
    ))}
  </div>
);

export const actionButton = {
  type: 'actionButton',
  category: 'action',
  label: '액션 버튼',
  description: '단일 액션 버튼',
  icon: '🔘',
  defaultValue: () => ({ type: 'actionButton', text: '▶ 실행', action: { type: 'executeCode' } }),
  FormView: SingleForm,
  PreviewView: ActionButtonPreview,
};

export const actionButtons = {
  type: 'actionButtons',
  category: 'action',
  label: '액션 버튼들',
  description: '여러 버튼 그룹',
  icon: '🔢',
  defaultValue: () => ({ type: 'actionButtons', buttons: [] }),
  FormView: ({ value, onChange }) => (
    <>
      <JsonField label="buttons (배열)" value={value.buttons} onChange={(v) => onChange({ ...value, buttons: v || [] })} />
    </>
  ),
  PreviewView: ActionButtonsPreview,
};

export default actionButton;
