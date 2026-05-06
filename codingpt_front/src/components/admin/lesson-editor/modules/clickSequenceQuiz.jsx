import { Field, TextField, NumberField } from './_shared/SharedFields';
import JsonField from './_shared/JsonField';

const FormView = ({ value, onChange }) => {
  const options = value.options || [];
  const setOptions = (next) => onChange({ ...value, options: next });
  return (
    <>
      <Field label="질문">
        <TextField value={value.question} onChange={(v) => onChange({ ...value, question: v })} multiline rows={2} />
      </Field>
      <Field label="슬롯 수">
        <NumberField value={value.slots} onChange={(v) => onChange({ ...value, slots: v })} min={1} />
      </Field>
      <Field label={`옵션 (${options.length})`}>
        <button type="button" onClick={() => setOptions([...options, { id: `opt-${options.length}`, label: '' }])} className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200">
          + 옵션 추가
        </button>
      </Field>
      {options.map((o, i) => (
        <div key={i} className="mb-1 flex gap-2">
          <TextField value={o.id} onChange={(v) => setOptions(options.map((x, idx) => idx === i ? { ...x, id: v } : x))} placeholder="id" />
          <TextField value={o.label} onChange={(v) => setOptions(options.map((x, idx) => idx === i ? { ...x, label: v } : x))} placeholder="label" />
          <button type="button" onClick={() => setOptions(options.filter((_, idx) => idx !== i))} className="text-xs text-red-500">✕</button>
        </div>
      ))}
      <JsonField label="정답 (id 배열)" value={value.answer} onChange={(v) => onChange({ ...value, answer: v })} hint='예: ["opt-0","opt-1"]' />
      <JsonField label="피드백" value={value.feedback} onChange={(v) => onChange({ ...value, feedback: v })} />
    </>
  );
};

const PreviewView = ({ module }) => (
  <div className="rounded bg-white p-2">
    <div className="text-xs font-semibold text-slate-700">{module.question}</div>
    <div className="mt-2 flex gap-1">
      {Array.from({ length: module.slots || 0 }).map((_, i) => (
        <div key={i} className="h-8 flex-1 rounded border border-dashed border-slate-300" />
      ))}
    </div>
    <div className="mt-2 flex flex-wrap gap-1">
      {(module.options || []).map((o, i) => (
        <div key={i} className="rounded bg-slate-100 px-2 py-1 text-xs">{o.label}</div>
      ))}
    </div>
  </div>
);

export default {
  type: 'clickSequenceQuiz',
  category: 'quiz',
  label: '순서 맞추기',
  description: '블록을 순서대로 배열',
  icon: '🔢',
  defaultValue: () => ({ type: 'clickSequenceQuiz', question: '', slots: 2, options: [], answer: [] }),
  FormView,
  PreviewView,
};
