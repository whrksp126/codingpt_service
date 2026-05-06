import { Field, SelectField } from './_shared/SharedFields';
import JsonField from './_shared/JsonField';

const FormView = ({ value, onChange }) => (
  <>
    <Field label="variant">
      <SelectField
        value={value.variant}
        onChange={(v) => onChange({ ...value, variant: v })}
        options={[{ value: 'browser', label: 'browser' }]}
        placeholder="(없음)"
      />
    </Field>
    <JsonField label="header (JSON)" value={value.header} onChange={(v) => onChange({ ...value, header: v })} />
    <JsonField label="content (JSON)" value={value.content} onChange={(v) => onChange({ ...value, content: v })} />
  </>
);

// RN Card.tsx 미러: 흰 카드 + browser 헤더(옵션) + label(14/disabled)+value(18/700) 필드, error box, 50h CTA 버튼.
const PreviewView = ({ module }) => {
  const fields = module.content?.fields || [];
  const errorBox = module.content?.errorBox;
  const button = module.content?.button;
  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
      }}
    >
      {module.header?.type === 'browserHeader' && (
        <div
          style={{
            background: '#F1F3F5',
            padding: '8px 12px',
            borderBottom: '1px solid #E5E7EB',
            fontSize: 11,
            color: '#6B7280',
          }}
        >
          🌐 browser
        </div>
      )}
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {fields.map((f, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 14, color: 'rgba(51,51,51,0.65)', letterSpacing: '-0.28px' }}>
              {f.label}
            </span>
            <span style={{ fontSize: 18, fontWeight: 700, color: 'rgba(51,51,51,0.8)' }}>
              {f.value}
            </span>
          </div>
        ))}
        {errorBox?.visible && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 60,
              borderRadius: 10,
              background: '#FEE2E2',
              border: `${errorBox.style === 'dashed' ? '2px dashed' : '1px solid'} #DC2626`,
            }}
          >
            {errorBox.icon && (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  background: '#DC2626',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {errorBox.icon}
              </span>
            )}
            <span style={{ fontSize: 16, fontWeight: 700, color: '#DC2626' }}>{errorBox.text}</span>
          </div>
        )}
        {button && (
          <div
            style={{
              width: '100%',
              height: 50,
              borderRadius: 10,
              background: button.style?.backgroundColor || '#08875D',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ color: button.style?.textColor || '#fff', fontSize: 16, fontWeight: 700 }}>
              {button.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default {
  type: 'card',
  category: 'structure',
  label: '카드',
  description: '브라우저 시뮬 등',
  icon: '🃏',
  defaultValue: () => ({ type: 'card', variant: 'browser', content: { fields: [] } }),
  FormView,
  PreviewView,
};
