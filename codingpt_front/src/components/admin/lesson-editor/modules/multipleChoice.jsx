import { Field, TextField, NumberField } from './_shared/SharedFields';
import ResultModulesField from './_shared/ResultModulesField';
import VisibilityBadge from './_shared/VisibilityBadge';
import ConditionBadge from './_shared/ConditionBadge';
import { getModuleDefinition } from './_registry';

const QuestionEditor = ({ q, onChange, onRemove, isTrueFalse }) => {
  const options = q.interactionOptions || [];
  return (
    <div className="mb-3 rounded border border-slate-200 p-2">
      <Field label="문제">
        <TextField value={q.title} onChange={(v) => onChange({ ...q, title: v })} multiline rows={2} />
      </Field>
      {!isTrueFalse && (
        <Field label={`보기 (${options.length})`}>
          <button
            type="button"
            onClick={() => onChange({ ...q, interactionOptions: [...options, { label: '' }] })}
            className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
          >
            + 보기 추가
          </button>
        </Field>
      )}
      {options.map((o, i) => (
        <div key={i} className="mb-1 flex gap-2">
          <span className="w-5 text-xs text-slate-400">{i}.</span>
          <TextField
            value={o.label}
            onChange={(v) => onChange({ ...q, interactionOptions: options.map((x, idx) => idx === i ? { label: v } : x) })}
          />
          {!isTrueFalse && (
            <button type="button" onClick={() => onChange({ ...q, interactionOptions: options.filter((_, idx) => idx !== i) })} className="text-xs text-red-500">✕</button>
          )}
        </div>
      ))}
      <Field label="정답 인덱스">
        <NumberField value={q.answer?.answer} onChange={(v) => onChange({ ...q, answer: { ...(q.answer || {}), answer: v } })} min={0} />
      </Field>
      <button type="button" onClick={onRemove} className="text-xs text-red-500">문제 삭제</button>
    </div>
  );
};

const makeFormView = (isTrueFalse) => ({ value, onChange }) => {
  const questions = value.questions || [];
  const setQuestions = (next) => onChange({ ...value, questions: next });
  return (
    <>
      <Field label={`문제 (${questions.length})`}>
        <button
          type="button"
          onClick={() => setQuestions([...questions, {
            title: '',
            interactionOptions: isTrueFalse ? [{ label: 'O' }, { label: 'X' }] : [{ label: '' }, { label: '' }],
            answer: { answer: 0 },
          }])}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 문제 추가
        </button>
      </Field>
      {questions.map((q, i) => (
        <QuestionEditor
          key={i}
          q={q}
          onChange={(next) => setQuestions(questions.map((x, idx) => idx === i ? next : x))}
          onRemove={() => setQuestions(questions.filter((_, idx) => idx !== i))}
          isTrueFalse={isTrueFalse}
        />
      ))}
      <ResultModulesField
        value={value.result}
        onChange={(next) => onChange({ ...value, result: next })}
      />
    </>
  );
};

// 퀴즈 PreviewView 아래에 채점 후 result.modules 를 같이 렌더.
// 각 result 모듈은 일반 모듈처럼 캔버스 우측에 가시성 + condition 뱃지를 노출.
const ResultModulesPreview = ({ module, onModuleChange }) => {
  const result = module.result;
  const mods = result?.modules || [];
  if (mods.length === 0) return null;

  const updateResultModuleAt = (i, patch) => {
    if (!onModuleChange) return;
    const nextMods = mods.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    onModuleChange({ ...module, result: { ...(result || {}), modules: nextMods } });
  };
  const propagateResultModuleChange = (i, nextValue) => {
    if (!onModuleChange) return;
    const nextMods = mods.map((m, idx) => (idx === i ? { ...nextValue, id: m.id ?? nextValue.id } : m));
    onModuleChange({ ...module, result: { ...(result || {}), modules: nextMods } });
  };

  return (
    <div className="mt-4 border-t border-dashed border-slate-300 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">채점 후</p>
      <div className="flex flex-col gap-3">
        {mods.map((m, i) => {
          const def = getModuleDefinition(m.type);
          const Sub = def?.PreviewView;
          if (!Sub) return null;
          return (
            <div key={m.id ?? i} className="relative w-full">
              <Sub
                module={m}
                onModuleChange={(next) => propagateResultModuleChange(i, next)}
              />
              <div
                className="absolute left-full top-1 z-20 ml-6 flex flex-col gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <VisibilityBadge
                  value={m.visibility}
                  onChange={(v) => updateResultModuleAt(i, { visibility: v })}
                />
                <ConditionBadge
                  value={m.condition}
                  onChange={(v) => updateResultModuleAt(i, { condition: v })}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// RN MultipleChoiceOption.tsx 외형 미러: #F8F9FC 배경, 16 round, 24/20 padding, 정답 #08875D 보더.
const MultipleChoicePreview = ({ module, onModuleChange }) => (
  <div className="flex flex-col gap-4">
    {(module.questions || []).map((q, i) => (
      <div key={i} className="flex flex-col gap-2">
        {q.title && <div className="text-[15px] font-[600] text-[#111]">{q.title}</div>}
        <div className="flex flex-col" style={{ gap: 5 }}>
          {(q.interactionOptions || []).map((o, j) => {
            const isAnswer = q.answer?.answer === j;
            return (
              <div
                key={j}
                style={{
                  background: '#F8F9FC',
                  borderRadius: 16,
                  padding: '20px 24px',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                  border: '1px solid ' + (isAnswer ? '#08875D' : 'transparent'),
                  fontSize: 14,
                  color: '#111',
                }}
              >
                {o.label || ''}
              </div>
            );
          })}
        </div>
      </div>
    ))}
    <ResultModulesPreview module={module} onModuleChange={onModuleChange} />
  </div>
);

// RN TrueFalseChoice.tsx 외형 미러: 두 박스 가로 배치, 16 round, 24/20 padding, 큰 O/X 표시.
const TrueFalsePreview = ({ module, onModuleChange }) => (
  <div className="flex flex-col gap-4">
    {(module.questions || []).map((q, i) => (
      <div key={i} className="flex flex-col gap-3">
        {q.title && <div className="text-[15px] font-[600] text-[#111]">{q.title}</div>}
        <div className="flex flex-row px-4" style={{ gap: 20 }}>
          {(q.interactionOptions || []).slice(0, 2).map((o, j) => {
            const isAnswer = q.answer?.answer === j;
            return (
              <div
                key={j}
                style={{
                  flex: 1,
                  background: '#F8F9FC',
                  borderRadius: 16,
                  padding: '20px 24px',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                  border: '1px solid ' + (isAnswer ? '#08875D' : 'transparent'),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 56,
                  fontWeight: 700,
                  color: '#333333',
                  minHeight: 100,
                }}
              >
                {o.label || (j === 0 ? 'O' : 'X')}
              </div>
            );
          })}
        </div>
      </div>
    ))}
    <ResultModulesPreview module={module} onModuleChange={onModuleChange} />
  </div>
);

export const multipleChoice = {
  type: 'multipleChoice',
  category: 'quiz',
  label: '객관식',
  description: '단일 선택 퀴즈',
  icon: '📊',
  defaultValue: () => ({ type: 'multipleChoice', questions: [{ title: '', interactionOptions: [{ label: '' }, { label: '' }], answer: { answer: 0 } }] }),
  FormView: makeFormView(false),
  PreviewView: MultipleChoicePreview,
};

export const trueFalseChoice = {
  type: 'trueFalseChoice',
  category: 'quiz',
  label: 'O/X 퀴즈',
  description: '참/거짓 선택',
  icon: '⭕',
  defaultValue: () => ({ type: 'trueFalseChoice', questions: [{ title: '', interactionOptions: [{ label: 'O' }, { label: 'X' }], answer: { answer: 0 } }] }),
  FormView: makeFormView(true),
  PreviewView: TrueFalsePreview,
};

export default multipleChoice;
