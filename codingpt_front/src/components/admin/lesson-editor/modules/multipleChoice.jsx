import { Field, TextField, NumberField } from './_shared/SharedFields';

const OX_OPTIONS = [{ label: 'O' }, { label: 'X' }];

const QuestionEditor = ({ q, onChange, isTrueFalse }) => {
  const options = q.interactionOptions || [];
  const answer = q.answer?.answer;

  if (isTrueFalse) {
    return (
      <Field label="정답">
        <div className="flex gap-2">
          {OX_OPTIONS.map((o, i) => {
            const isSelected = answer === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onChange({ ...q, interactionOptions: OX_OPTIONS, answer: { ...(q.answer || {}), answer: i } })}
                className={
                  'flex h-12 w-12 items-center justify-center rounded-lg border text-xl font-bold transition ' +
                  (isSelected
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 shadow-sm'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }

  return (
    <div className="mb-3 rounded border border-slate-200 p-2">
      <Field label="문제">
        <TextField value={q.title} onChange={(v) => onChange({ ...q, title: v })} multiline rows={2} />
      </Field>
      <Field label={`보기 (${options.length})`}>
        <button
          type="button"
          onClick={() => onChange({ ...q, interactionOptions: [...options, { label: '' }] })}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 보기 추가
        </button>
      </Field>
      {options.map((o, i) => (
        <div key={i} className="mb-1 flex gap-2">
          <span className="w-5 text-xs text-slate-400">{i}.</span>
          <TextField
            value={o.label}
            onChange={(v) => onChange({ ...q, interactionOptions: options.map((x, idx) => idx === i ? { label: v } : x) })}
          />
          <button type="button" onClick={() => onChange({ ...q, interactionOptions: options.filter((_, idx) => idx !== i) })} className="text-xs text-red-500">✕</button>
        </div>
      ))}
      <Field label="정답 인덱스">
        <NumberField value={q.answer?.answer} onChange={(v) => onChange({ ...q, answer: { ...(q.answer || {}), answer: v } })} min={0} />
      </Field>
    </div>
  );
};

const makeDefaultQuestion = (isTrueFalse) => ({
  title: '',
  interactionOptions: isTrueFalse ? OX_OPTIONS : [{ label: '' }, { label: '' }],
  answer: { answer: 0 },
});

const makeFormView = (isTrueFalse) => ({ value, onChange }) => {
  // 한 슬라이드 한 문제만 사용. questions[0] 만 편집한다.
  const questions = value.questions && value.questions.length > 0
    ? value.questions
    : [makeDefaultQuestion(isTrueFalse)];
  const q = questions[0];
  const updateFirst = (next) => {
    const nextQuestions = [next, ...questions.slice(1)];
    onChange({ ...value, questions: nextQuestions });
  };
  return (
    <>
      <QuestionEditor q={q} onChange={updateFirst} isTrueFalse={isTrueFalse} />
      <p className="rounded border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        채점 후 등장할 모듈은 슬라이드 모듈 카드에서 직접 추가한 뒤 각 카드의 "등장 시점" 셀렉트에서 이 퀴즈 모듈을 선택하세요.
      </p>
    </>
  );
};

const SubmitDoneButton = ({ marginTop }) => (
  <div className="flex items-center justify-center" style={{ marginTop }}>
    <div
      style={{
        width: 160,
        height: 50,
        borderRadius: 10,
        background: '#E02D3C',
        color: '#FFFFFF',
        fontWeight: 700,
        fontSize: 16,
        lineHeight: '24px',
        letterSpacing: '-0.32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 0 5px rgba(0,0,0,0.25)',
        userSelect: 'none',
      }}
    >
      선택 완료
    </div>
  </div>
);

// RN MultipleChoiceOption.tsx 외형 미러: #F8F9FC 배경, 16 round, 24/20 padding, 정답 #08875D 보더.
const MultipleChoicePreview = ({ module, onModuleChange }) => {
  const q = (module.questions || [])[0];
  if (!q) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
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
      <SubmitDoneButton marginTop={70} />
    </div>
  );
};

// RN TrueFalseChoice.tsx 외형 미러: 두 박스 가로 배치, 16 round, 24/20 padding, 큰 O/X 표시.
const TrueFalsePreview = ({ module, onModuleChange }) => {
  const q = (module.questions || [])[0];
  if (!q) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-row px-4" style={{ gap: 20 }}>
          {OX_OPTIONS.map((o, j) => {
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
                {o.label}
              </div>
            );
          })}
        </div>
      </div>
      <SubmitDoneButton marginTop={20} />
    </div>
  );
};

export const multipleChoice = {
  type: 'multipleChoice',
  category: 'quiz',
  label: '객관식',
  description: '단일 선택 퀴즈',
  icon: '',
  defaultValue: () => ({ type: 'multipleChoice', questions: [makeDefaultQuestion(false)] }),
  FormView: makeFormView(false),
  PreviewView: MultipleChoicePreview,
};

export const trueFalseChoice = {
  type: 'trueFalseChoice',
  category: 'quiz',
  label: 'O/X 퀴즈',
  description: '참/거짓 선택',
  icon: '',
  defaultValue: () => ({ type: 'trueFalseChoice', questions: [makeDefaultQuestion(true)] }),
  FormView: makeFormView(true),
  PreviewView: TrueFalsePreview,
};

export default multipleChoice;
