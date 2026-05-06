import { useEffect, useState } from 'react';
import { Field } from './SharedFields';

const JsonField = ({ label, value, onChange, hint }) => {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState(null);

  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2));
  }, [value]);

  const commit = (next) => {
    try {
      const parsed = next.trim() === '' ? undefined : JSON.parse(next);
      onChange(parsed);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Field label={label} hint={hint || 'JSON 형식으로 입력'}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        rows={6}
        className={
          'w-full rounded border px-2 py-1 font-mono text-xs focus:outline-none ' +
          (error ? 'border-red-300 focus:border-red-500' : 'border-slate-200 focus:border-cyan-500')
        }
      />
      {error && <span className="mt-1 block text-xs text-red-500">{error}</span>}
    </Field>
  );
};

export default JsonField;
