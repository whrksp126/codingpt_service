import { Field, SelectField } from './_shared/SharedFields';

const LOTTIE_NAMES = [
  'CodingDevelio',
  'BusinessPlan',
  'MoneyRunAway',
  'ThumbsUpBirdie',
  'Trophy',
  'SuccesCcelebration',
  'BusinessmanFliesUpWithRocket',
];

const FormView = ({ value, onChange }) => (
  <>
    <Field label="Lottie 이름">
      <SelectField
        value={value.src}
        onChange={(v) => onChange({ ...value, src: v })}
        options={LOTTIE_NAMES.map((n) => ({ value: n, label: n }))}
      />
    </Field>
    <Field label="크기">
      <SelectField
        value={value.size || 'md'}
        onChange={(v) => onChange({ ...value, size: v })}
        options={['sm', 'md', 'lg', 'xl', 'xxl'].map((s) => ({ value: s, label: s }))}
      />
    </Field>
  </>
);

// RN Lottie.tsx sizeMap 미러 (sm=100, md=200, lg=300, xl=400, xxl=500)
const SIZE_MAP = { sm: 100, md: 200, lg: 300, xl: 400, xxl: 500 };

const PreviewView = ({ module }) => {
  const px = SIZE_MAP[module.size] || SIZE_MAP.md;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 8 }}>
      <div
        style={{
          width: px,
          height: px,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F8F9FC',
          border: '1px dashed #C8CCD6',
          borderRadius: 12,
          color: '#6B7280',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        🎬 {module.src || '(미지정)'}
        <br />
        <span style={{ fontSize: 10, color: '#9CA3AF' }}>{module.size || 'md'} · {px}px</span>
      </div>
    </div>
  );
};

export default {
  type: 'lottie',
  category: 'action',
  label: '로티',
  description: 'Lottie 애니메이션',
  icon: '',
  defaultValue: () => ({ type: 'lottie', src: 'CodingDevelio', size: 'md' }),
  FormView,
  PreviewView,
};
