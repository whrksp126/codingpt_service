import { useState } from 'react';
import { Field, SelectField, TextField, NumberField, ToggleField } from './_shared/SharedFields';

const FormView = ({ value, onChange }) => {
  const files = value.files || [];
  const setFiles = (next) => onChange({ ...value, files: next });
  const updateFile = (idx, patch) => setFiles(files.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  const updateScriptLine = (fileIdx, lineIdx, patch) => {
    const file = files[fileIdx];
    const nextScript = (file.script || []).map((s, i) => (i === lineIdx ? { ...s, ...patch } : s));
    updateFile(fileIdx, { script: nextScript });
  };
  return (
    <>
      <Field label="높이 (px)">
        <NumberField value={value.height} onChange={(v) => onChange({ ...value, height: v })} />
      </Field>
      <Field label={`파일 (${files.length})`}>
        <button
          type="button"
          onClick={() => setFiles([...files, { name: 'script.js', language: 'js', script: [] }])}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 파일 추가
        </button>
      </Field>
      {files.map((f, i) => (
        <div key={i} className="mb-3 rounded border border-slate-200 p-2">
          <Field label="파일명">
            <TextField value={f.name} onChange={(v) => updateFile(i, { name: v })} />
          </Field>
          <Field label="언어">
            <SelectField
              value={f.language}
              onChange={(v) => updateFile(i, { language: v })}
              options={[
                { value: 'js', label: 'js' },
                { value: 'py', label: 'py' },
                { value: 'java', label: 'java' },
                { value: 'html', label: 'html' },
                { value: 'css', label: 'css' },
              ]}
            />
          </Field>
          <ToggleField value={f.showInput} onChange={(v) => updateFile(i, { showInput: v })} label="입력 라인 표시" />
          <Field label={`스크립트 (${(f.script || []).length})`}>
            <button
              type="button"
              onClick={() => updateFile(i, { script: [...(f.script || []), { type: 'output', text: '' }] })}
              className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
            >
              + 라인 추가
            </button>
          </Field>
          {(f.script || []).map((s, j) => (
            <div key={j} className="mb-1 flex gap-2">
              <SelectField
                value={s.type}
                onChange={(v) => updateScriptLine(i, j, { type: v })}
                options={[
                  { value: 'input', label: 'in' },
                  { value: 'output', label: 'out' },
                ]}
              />
              <div className="flex-1">
                <TextField value={s.text} onChange={(v) => updateScriptLine(i, j, { text: v })} />
              </div>
              <button
                type="button"
                onClick={() => updateFile(i, { script: (f.script || []).filter((_, idx) => idx !== j) })}
                className="text-xs text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
            className="mt-2 text-xs text-red-500"
          >
            파일 삭제
          </button>
        </div>
      ))}
    </>
  );
};

const PROMPT_BY_LANG = { py: '>>> ', java: '$ ', js: '> ', html: '> ', css: '> ' };

const ScriptLines = ({ file }) => {
  if (!file) return null;
  const showInput = file.showInput === true;
  const prompt = PROMPT_BY_LANG[file.language] || '> ';
  return (file.script || []).map((s, i) => {
    const isInput = s.type === 'input';
    if (isInput && !showInput) return null;
    return (
      <div
        key={i}
        style={{ color: s.type === 'error' ? '#FCA5A5' : isInput ? '#7DD3FC' : '#fff' }}
      >
        {isInput ? prompt : ''}
        {s.text || s.content || ''}
      </div>
    );
  });
};

// RN Terminal.tsx 외형 미러: 26px 어두운 회색 헤더 + 회색 traffic lights + 검정 본문.
const PreviewView = ({ module }) => {
  const files = module.files || [];
  const [active, setActive] = useState(0);
  const height = module.height || 200;
  const isLegacy = !files.length && Array.isArray(module.script);
  const showTabs = files.length > 0;

  return (
    <div className="overflow-hidden rounded-[10px] border border-[#5e5e5e]">
      <div className="flex items-end h-[26px] px-[10px]" style={{ background: '#3c3c3c', gap: 10 }}>
        <div className="flex items-center h-full" style={{ gap: 5 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="w-[10px] h-[10px] rounded-full" style={{ background: '#545454' }} />
          ))}
        </div>
        {showTabs && (
          <div className="flex flex-1 h-full" style={{ gap: 5 }}>
            {files.map((f, i) => (
              <button
                type="button"
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  setActive(i);
                }}
                className={`flex-1 max-w-[125px] rounded-t-[5px] px-[6px] flex items-center self-end h-[20px] text-[12px] ${
                  active === i ? 'bg-black text-white' : 'bg-[#3c3c3c] text-white/80'
                }`}
              >
                {f.name || f.language}
              </button>
            ))}
          </div>
        )}
      </div>
      <pre
        style={{
          background: '#000',
          height,
          color: '#fff',
          margin: 0,
          padding: 12,
          fontFamily: 'Menlo, Consolas, monospace',
          fontSize: 13,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      >
        {isLegacy
          ? (module.script || []).map((s, i) => (
              <div
                key={i}
                style={{
                  color: s.type === 'error' ? '#FCA5A5' : s.type === 'input' ? '#7DD3FC' : '#fff',
                }}
              >
                {s.type === 'input' ? '$ ' : ''}
                {s.content || s.text}
              </div>
            ))
          : <ScriptLines file={files[active]} />}
      </pre>
    </div>
  );
};

export default {
  type: 'terminal',
  category: 'code',
  label: '터미널',
  description: 'xterm.js 터미널 (탭 + 스크립트)',
  icon: '⌨️',
  defaultValue: () => ({
    type: 'terminal',
    height: 200,
    files: [{ name: 'script.js', language: 'js', script: [{ type: 'output', text: 'Hello, world!' }] }],
  }),
  FormView,
  PreviewView,
};
