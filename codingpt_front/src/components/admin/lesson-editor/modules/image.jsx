import { Field, SelectField, NumberField } from './_shared/SharedFields';
import AssetPickerField from './_shared/AssetPickerField';

const FormView = ({ value, onChange }) => (
  <>
    <AssetPickerField
      label="이미지"
      value={value.src}
      onChange={(v) => onChange({ ...value, src: v })}
      accept="image/*"
      hint="파일 업로드 또는 URL"
    />
    <Field label="크기">
      <SelectField
        value={typeof value.size === 'string' ? value.size : ''}
        onChange={(v) => onChange({ ...value, size: v })}
        options={[
          { value: 'sm', label: 'sm' },
          { value: 'md', label: 'md' },
          { value: 'lg', label: 'lg' },
          { value: 'xl', label: 'xl' },
        ]}
        placeholder="(미지정)"
      />
    </Field>
    <Field label="가로 정렬">
      <SelectField
        value={value.alignX}
        onChange={(v) => onChange({ ...value, alignX: v })}
        options={[
          { value: 'left', label: 'left' },
          { value: 'center', label: 'center' },
          { value: 'right', label: 'right' },
        ]}
        placeholder="center (기본)"
      />
    </Field>
    <Field label="aspectRatio">
      <NumberField value={value.aspectRatio} onChange={(v) => onChange({ ...value, aspectRatio: v })} step={0.1} />
    </Field>
  </>
);

// RN Picture.tsx size 토큰 (sm=140, md=220, lg=350, xl=395) 미러
const SIZE_MAP = { sm: 140, md: 220, lg: 350, xl: 395 };

const PreviewView = ({ module }) => {
  const aspect = module.aspectRatio || 16 / 9;
  const sizeObj = typeof module.size === 'object' && module.size ? module.size : null;
  const width = sizeObj?.width ?? (SIZE_MAP[module.size] || SIZE_MAP.md);
  const height = sizeObj?.height ?? width / aspect;
  const justify =
    module.alignX === 'left' ? 'flex-start' : module.alignX === 'right' ? 'flex-end' : 'center';

  const wrapperStyle = {
    display: 'flex',
    width: '100%',
    justifyContent: justify,
    marginTop: 5,
    marginBottom: 5,
  };
  const containerStyle = module.containerBackground
    ? {
        backgroundColor: module.containerBackground,
        padding: module.containerPadding ?? 20,
        borderRadius: module.containerBorderRadius ?? 16,
        ...(module.containerShadow ? { boxShadow: '0 4px 12px rgba(0,0,0,0.08)' } : {}),
      }
    : {};

  if (!module.src) {
    return (
      <div style={wrapperStyle}>
        <div
          style={{
            width,
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#F1F3F5',
            color: '#9CA3AF',
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          이미지 없음
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div style={containerStyle}>
        <img
          src={module.src}
          alt=""
          style={{
            width,
            height,
            objectFit: module.fit || 'contain',
            display: 'block',
          }}
        />
      </div>
    </div>
  );
};

export default {
  type: 'image',
  category: 'media',
  label: '이미지',
  description: '파일 업로드 또는 URL',
  icon: '',
  defaultValue: () => ({ type: 'image', src: '', size: 'md' }),
  FormView,
  PreviewView,
};
