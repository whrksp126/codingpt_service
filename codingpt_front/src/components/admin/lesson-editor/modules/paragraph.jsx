import { Field, TTSField, ToggleField } from './_shared/SharedFields';
import RawHtmlPreview from './_shared/RawHtmlPreview';
import MonacoField from './_shared/MonacoField';
import IconCircle from './_shared/IconCircle';
import { stripHtml } from './_shared/htmlText';

const FormView = ({ value, onChange }) => (
  <>
    <div className="mb-3">
      <ToggleField
        value={!value.iconHidden}
        onChange={(on) => onChange({ ...value, iconHidden: !on })}
        label="아이콘 표시"
      />
    </div>
    <Field label="HTML 내용" hint="<p>, <h2>, <strong>, <span class=&quot;success-700&quot;> 등 사용 가능">
      <MonacoField
        value={value.content}
        onChange={(v) => onChange({ ...value, content: v })}
        language="html"
        height={180}
      />
    </Field>
    <TTSField
      value={value.tts}
      onChange={(v) => onChange({ ...value, tts: v })}
      defaultText={stripHtml(value.content)}
    />
  </>
);

const PreviewView = ({ module }) => (
  <>
    {!module.iconHidden && <IconCircle icon={module.icon} />}
    <RawHtmlPreview html={module.content} />
  </>
);

export default {
  type: 'paragraph',
  category: 'text',
  label: '텍스트',
  description: 'HTML 본문 + 아이콘 + TTS',
  icon: '',
  defaultValue: () => ({ type: 'paragraph', content: '<p>여기에 텍스트를 입력하세요</p>' }),
  FormView,
  PreviewView,
};
