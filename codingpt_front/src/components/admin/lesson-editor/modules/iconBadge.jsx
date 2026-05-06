import * as PhosphorIcons from '@phosphor-icons/react';
import { Field, TextField, NumberField, ColorField } from './_shared/SharedFields';

const FormView = ({ value, onChange }) => (
  <>
    <Field label="아이콘 이름 (Phosphor)">
      <TextField value={value.icon} onChange={(v) => onChange({ ...value, icon: v })} placeholder="KeyReturn" />
    </Field>
    <Field label="아이콘 크기"><NumberField value={value.iconSize} onChange={(v) => onChange({ ...value, iconSize: v })} /></Field>
    <Field label="아이콘 색"><ColorField value={value.iconColor} onChange={(v) => onChange({ ...value, iconColor: v })} /></Field>
    <Field label="배경 색"><ColorField value={value.backgroundColor} onChange={(v) => onChange({ ...value, backgroundColor: v })} /></Field>
    <Field label="배지 크기"><NumberField value={value.size} onChange={(v) => onChange({ ...value, size: v })} /></Field>
  </>
);

// RN IconBadge.tsx 미러: 원형 배경 + 중앙 SVG 아이콘. 웹은 phosphor 아이콘으로 매칭.
const PreviewView = ({ module }) => {
  const Icon = module.icon ? PhosphorIcons[module.icon] : null;
  const size = module.size || 64;
  return (
    <div className="flex justify-center">
      <div
        className="flex items-center justify-center rounded-full"
        style={{
          width: size,
          height: size,
          backgroundColor: module.backgroundColor || '#E6F4EF',
        }}
      >
        {Icon ? (
          <Icon
            size={module.iconSize || 32}
            weight="fill"
            color={module.iconColor || '#08875D'}
          />
        ) : (
          <span style={{ color: '#9CA3AF', fontSize: 12 }}>{module.icon || '?'}</span>
        )}
      </div>
    </div>
  );
};

export default {
  type: 'iconBadge',
  category: 'structure',
  label: '아이콘 배지',
  description: 'SVG 아이콘 + 배경',
  icon: '🔔',
  defaultValue: () => ({ type: 'iconBadge', icon: 'KeyReturn', size: 64, iconSize: 32, iconColor: '#08875D', backgroundColor: '#EDFDF8' }),
  FormView,
  PreviewView,
};
