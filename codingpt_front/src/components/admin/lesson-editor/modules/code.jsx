import { useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-python';
import 'prismjs/themes/prism-okaidia.css';
import { Field, SelectField, NumberField } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';

const LANGUAGES = [
  { value: 'html', label: 'html' },
  { value: 'css', label: 'css' },
  { value: 'javascript', label: 'javascript' },
  { value: 'java', label: 'java' },
  { value: 'python', label: 'python' },
];

const PRISM_LANG_MAP = {
  html: 'markup',
  css: 'css',
  javascript: 'javascript',
  js: 'javascript',
  java: 'java',
  python: 'python',
};

const FormView = ({ value, onChange }) => {
  const files = value.files || [];
  const setFiles = (next) => onChange({ ...value, files: next });
  return (
    <>
      <Field label="높이 (px)">
        <NumberField value={value.height} onChange={(v) => onChange({ ...value, height: v })} />
      </Field>
      <Field label={`파일 (${files.length})`}>
        <button
          type="button"
          onClick={() => setFiles([...files, { language: 'javascript', content: '' }])}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 파일 추가
        </button>
      </Field>
      {files.map((f, i) => (
        <div key={i} className="mb-3 rounded border border-slate-200 p-2">
          <Field label="언어">
            <SelectField
              value={f.language}
              onChange={(v) => setFiles(files.map((x, idx) => idx === i ? { ...x, language: v } : x))}
              options={LANGUAGES}
            />
          </Field>
          <Field label="코드">
            <MonacoField
              value={f.content}
              onChange={(v) => setFiles(files.map((x, idx) => idx === i ? { ...x, content: v } : x))}
              language={PRISM_LANG_MAP[f.language] === 'markup' ? 'html' : (f.language || 'plaintext')}
              height={220}
              disableAutoFormat
            />
          </Field>
          <button
            type="button"
            onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
            className="text-xs text-red-500"
          >
            삭제
          </button>
        </div>
      ))}
    </>
  );
};

const highlight = (content, language) => {
  const lang = PRISM_LANG_MAP[language] || 'markup';
  const grammar = Prism.languages[lang] || Prism.languages.markup;
  try {
    return Prism.highlight(content || '', grammar, lang);
  } catch {
    return (content || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
};

const PreviewView = ({ module }) => {
  const files = module.files || [];
  const [active, setActive] = useState(0);
  const file = files[active] || files[0];
  const height = module.height || 220;

  if (!file) {
    return (
      <div className="rounded-2xl bg-slate-100 p-3 text-xs text-slate-400">코드 파일 없음</div>
    );
  }

  const html = highlight(file.content || '', file.language);

  return (
    <div className="overflow-hidden rounded-2xl" style={{ background: '#0A0D14' }}>
      {/* 헤더: traffic lights — RN Code.tsx 의 Danger/Warning/Success-Pressed-900 토큰 미러 */}
      <div className="flex h-[30px] items-center px-4" style={{ gap: 6 }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#981B25' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#80460D' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#066042' }} />
        {files.length > 1 && (
          <div className="ml-3 flex gap-1">
            {files.map((f, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => { e.stopPropagation(); setActive(i); }}
                className={
                  'rounded-t px-2 py-0.5 text-[10px] ' +
                  (i === active
                    ? 'bg-[#0A0D14] text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700')
                }
              >
                {f.language}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className="overflow-auto"
        style={{ height, background: '#0A0D14' }}
      >
        <pre
          className="m-0 p-3 text-[12px] leading-[1.4]"
          style={{ background: '#0A0D14', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}
        >
          <code className={'language-' + (PRISM_LANG_MAP[file.language] || 'markup')} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  );
};

export default {
  type: 'code',
  category: 'code',
  label: '코드',
  description: '언어별 코드 표시 (Prism 다크 테마)',
  icon: '💻',
  defaultValue: () => ({ type: 'code', files: [{ language: 'javascript', content: '// hello' }], height: 220 }),
  FormView,
  PreviewView,
};
