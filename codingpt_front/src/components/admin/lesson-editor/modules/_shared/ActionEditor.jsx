import { useMemo } from 'react';
import JsonField from './JsonField';
import { Field, SelectField } from './SharedFields';

const KNOWN_TYPES = ['executeCode', 'navigate_next_lesson', 'end_lesson'];

const TYPE_OPTIONS = [
  { value: 'executeCode',          label: 'executeCode — 코드 실행' },
  { value: 'navigate_next_lesson', label: 'navigate_next_lesson — 다음 레슨으로 이동' },
  { value: 'end_lesson',           label: 'end_lesson — 학습 종료' },
  { value: 'custom',               label: 'custom — 자유 JSON' },
];

const modeFromValue = (value) => {
  const t = value?.type;
  if (!t) return 'executeCode';
  if (KNOWN_TYPES.includes(t)) return t;
  return 'custom';
};

const ActionEditor = ({ value, onChange }) => {
  const mode = useMemo(() => modeFromValue(value), [value]);

  const handleTypeChange = (next) => {
    if (next === 'navigate_next_lesson' || next === 'end_lesson') {
      onChange({ type: next });
      return;
    }
    if (next === 'executeCode') {
      onChange({ type: 'executeCode', ...(value?.s3Path ? { s3Path: value.s3Path } : {}) });
      return;
    }
    onChange(value || {});
  };

  return (
    <>
      <Field label="action.type">
        <SelectField value={mode} onChange={handleTypeChange} options={TYPE_OPTIONS} />
      </Field>

      {mode === 'executeCode' && (
        <JsonField
          label="action (executeCode 파라미터)"
          value={value}
          onChange={onChange}
          hint='{ "type": "executeCode", "s3Path": "...", "targetWebViewId": "..." }'
        />
      )}

      {mode === 'navigate_next_lesson' && (
        <p className="mb-3 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
          클릭 시 같은 클래스의 다음 레슨으로 이동합니다. 다음 레슨이 없으면 학습 종료로 폴백.
        </p>
      )}

      {mode === 'end_lesson' && (
        <p className="mb-3 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
          클릭 시 학습 결과 화면을 거쳐 학습을 종료합니다.
        </p>
      )}

      {mode === 'custom' && (
        <JsonField
          label="action (사용자 정의 JSON)"
          value={value}
          onChange={onChange}
          hint='임의의 type 값을 그대로 저장합니다.'
        />
      )}
    </>
  );
};

export default ActionEditor;
