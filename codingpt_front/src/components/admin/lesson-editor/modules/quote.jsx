import { Field } from './_shared/SharedFields';
import RawHtmlPreview from './_shared/RawHtmlPreview';
import MonacoField from './_shared/MonacoField';

const FormView = ({ value, onChange }) => (
  <Field
    label="HTML 내용"
    hint='callout-box(좌측 파란 보더 + 회색 배경)가 자동으로 감싸집니다. 안쪽 HTML만 입력하세요. 예: <p class="regular-14">...</p>'
  >
    <MonacoField
      value={value.content}
      onChange={(v) => onChange({ ...value, content: v })}
      language="html"
      height={180}
    />
  </Field>
);

const PreviewView = ({ module }) => (
  <RawHtmlPreview html={`<div class="callout-box">${module.content || ''}</div>`} />
);

export default {
  type: 'quote',
  category: 'text',
  label: '인용',
  description: 'callout-box로 감싸진 인용/강조 HTML',
  icon: '',
  defaultValue: () => ({
    type: 'quote',
    content: '<p class="regular-14">인용 내용을 입력하세요.</p>',
  }),
  FormView,
  PreviewView,
};
