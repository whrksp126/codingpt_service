import { useState, useEffect } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-python';
import 'prismjs/themes/prism-okaidia.css';
import { Field, SelectField, NumberField } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';
import IdeIntegrationField from './_shared/IdeIntegrationField';
import IdeOpenBadge from './_shared/IdeOpenBadge';
import { useEditor, selectSelectedSlide } from '../state/EditorContext';
import { usePrecomputeModule } from '../state/usePrecompute';
import { computeCodeHash } from '../../../../utils/codeHash';
import { getModuleDefinition } from './_registry';

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

  // 같은 슬라이드에 이 코드 모듈을 linkedModuleId 로 가리키는 simpleTerminal 이 이미 있는지 확인 → 중복 생성 방지.
  const { state, dispatch } = useEditor();
  const slide = selectSelectedSlide(state);
  const modules = slide?.contents?.modules || [];
  const myIndex = modules.findIndex((m) => m.id === value.id);
  const resultModule = modules.find(
    (m) => m.type === 'simpleTerminal' && String(m.linkedModuleId) === String(value.id),
  );
  const hasResultModule = !!resultModule;

  const handleAddResultModule = () => {
    if (!slide || !value.id || hasResultModule) return;
    const def = getModuleDefinition('simpleTerminal');
    const base = def?.defaultValue?.() || { type: 'simpleTerminal' };
    dispatch({
      type: 'addModule',
      slideId: slide.id,
      insertAt: myIndex >= 0 ? myIndex + 1 : modules.length,
      module: {
        ...base,
        linkedModuleId: value.id,
        height: 100,
      },
    });
  };

  // === 실행 결과 캐싱 ===
  const lessonId = state.lesson?.id;
  const { run: runPrecompute, running: precomputing, error: precomputeError } =
    usePrecomputeModule(lessonId, slide?.id, resultModule?.id);

  // 현재 코드(첫 파일) 해시 — codeRunResult 모듈의 cachedResult.codeHash 와 비교.
  // 실행 가능 언어(javascript/python)만 캐싱 의미 있음.
  const firstFile = files[0];
  const isExecutableLang = ['javascript', 'python'].includes(String(firstFile?.language || '').toLowerCase());
  const [currentHash, setCurrentHash] = useState(null);
  useEffect(() => {
    if (!firstFile || !isExecutableLang) { setCurrentHash(null); return; }
    let cancelled = false;
    computeCodeHash(firstFile.language, firstFile.content || '').then((h) => {
      if (!cancelled) setCurrentHash(h);
    });
    return () => { cancelled = true; };
  }, [firstFile?.language, firstFile?.content, isExecutableLang]);

  const cached = resultModule?.cachedResult;
  const hashMismatch = cached && currentHash && cached.codeHash !== currentHash;

  return (
    <>
      <Field label="높이 (px)">
        <NumberField value={value.height} onChange={(v) => onChange({ ...value, height: v })} />
      </Field>
      <Field label="실행 결과">
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={handleAddResultModule}
            disabled={hasResultModule}
            className={
              'rounded px-2 py-1 text-xs ' +
              (hasResultModule
                ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200')
            }
            title={hasResultModule ? '이미 추가된 결과 모듈이 있습니다.' : '코드 실행 결과 모듈을 바로 다음 위치에 추가합니다.'}
          >
            {hasResultModule ? '✓ 결과 모듈 추가됨' : '+ 코드 실행 결과 모듈 추가'}
          </button>
          {hasResultModule && (resultModule.executionMode || 'cached') !== 'live' && (
            <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => runPrecompute()}
                  disabled={precomputing || !isExecutableLang || !lessonId}
                  className={
                    'rounded px-2 py-1 text-[11px] font-semibold ' +
                    (precomputing || !isExecutableLang
                      ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                      : 'bg-cyan-500 text-white hover:bg-cyan-600')
                  }
                  title={
                    !isExecutableLang
                      ? 'javascript/python 만 실행 캐싱 지원'
                      : (cached ? '재실행해서 캐시 갱신' : '결과를 미리 실행해서 저장')
                  }
                >
                  {precomputing ? '실행 중...' : (cached ? '재실행' : '결과 저장')}
                </button>
                {cached && (
                  <span className="text-slate-500">
                    exit {cached.exitCode} · {Math.round(cached.durationMs)}ms
                  </span>
                )}
              </div>
              {cached && (
                <div className="mt-1 text-slate-400">
                  마지막 실행: {new Date(cached.executedAt).toLocaleString()}
                </div>
              )}
              {hashMismatch && (
                <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-amber-800">
                  ⚠️ 캐시가 현재 코드와 다릅니다 — 재실행 필요
                </div>
              )}
              {precomputeError && (
                <div className="mt-1 rounded bg-red-50 px-1.5 py-1 text-red-700">
                  실행 실패: {precomputeError}
                </div>
              )}
            </div>
          )}
        </div>
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
      <IdeIntegrationField value={value.ide} onChange={(ide) => onChange({ ...value, ide })} />
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
        <IdeOpenBadge module={module} />
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
  icon: '',
  defaultValue: () => ({ type: 'code', files: [{ language: 'javascript', content: '// hello' }], height: 220 }),
  FormView,
  PreviewView,
};
