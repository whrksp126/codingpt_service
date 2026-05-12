import { Field, TextField, TTSField } from './_shared/SharedFields';
import RawHtmlPreview from './_shared/RawHtmlPreview';
import IconCircle from './_shared/IconCircle';
import { stripHtml } from './_shared/htmlText';

const FormView = ({ value, onChange }) => (
  <>
    <Field label="HTML 내용 (TTS 동기화)">
      <TextField value={value.content} onChange={(v) => onChange({ ...value, content: v })} multiline rows={5} />
    </Field>
    <TTSField
      value={value.tts}
      onChange={(v) => onChange({ ...value, tts: v })}
      defaultText={stripHtml(value.content)}
    />
  </>
);

const PreviewView = ({ module }) => (
  <div className="px-3 py-2 flex flex-col items-center">
    <IconCircle icon={module.icon} />
    <div className="w-full text-center">
      <RawHtmlPreview html={module.content} />
    </div>
  </div>
);

export default {
  type: 'highlightParagraph',
  category: 'text',
  label: '하이라이트 텍스트',
  description: 'TTS 타임스탬프와 동기화',
  icon: '🔆',
  defaultValue: () => ({ type: 'highlightParagraph', content: '<p></p>' }),
  FormView,
  PreviewView,
};
