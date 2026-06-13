import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, SelectField, TextField, NumberField } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';
import IdeIntegrationField from './_shared/IdeIntegrationField';
import IdeOpenBadge from './_shared/IdeOpenBadge';
import { useResultParent } from '../state/ResultParentContext';
import { useEditor, selectSelectedSlide } from '../state/EditorContext';
import { usePrecomputeModule, usePrecomputePermutations } from '../state/usePrecompute';
import { computeCodeHash } from '../../../../utils/codeHash';
import * as monaco from 'monaco-editor';

// 언어 약어 → executor 가 이해하는 언어로 정규화 (백엔드 캐싱 지원: javascript/python)
const langToExecutable = (lang) => {
  const l = String(lang || '').toLowerCase();
  if (l === 'js') return 'javascript';
  if (l === 'py') return 'python';
  return l;
};
const isCacheableLang = (lang) => ['javascript', 'python'].includes(langToExecutable(lang));

// 코드에 빈칸 토큰이 있으면 캐싱 불가 (학생이 채워야 결정됨 — 부모 codeFillTheGapV2.cachedResults 가 담당).
const hasTokens = (code) => /\{\{userAnswer_\d+\}\}/.test(code || '');

// 옵션 N 개 + 빈칸 M 개 → 순열 P(N, M). 표시용 카운트 (옵션 ≤ 6 일 때만).
const countPermutations = (n, m) => {
  if (n > 6 || m === 0 || m > n) return 0;
  let p = 1;
  for (let i = 0; i < m; i++) p *= (n - i);
  return p;
};

// 부모가 codeFillTheGapV2 (결과 영역 안의 terminal) 일 때 — 옵션 순열 캐싱 패널.
// 백엔드가 부모 자동 탐색 + 토큰 치환 + 실행 → terminal.cachedResults 누적.
const PermutationPrecomputePanel = ({ moduleId, tabIndex, language, optionsLen, blanksLen, cachedResults }) => {
  const { state } = useEditor();
  const slide = selectSelectedSlide(state);
  const lessonId = state.lesson?.id;
  const { run, running, progress, error } = usePrecomputePermutations(lessonId, slide?.id, moduleId);

  const cacheable = isCacheableLang(language);
  const expected = countPermutations(optionsLen, blanksLen);
  const correctOnly = optionsLen > 6 || expected === 0;
  const cachedCount = Object.keys(cachedResults || {}).length;
  const disabled = !cacheable || blanksLen === 0 || !lessonId || !slide?.id || running;
  const disabledReason = !cacheable
    ? `${language || '(언어 없음)'} 은 실행 캐싱 미지원 — js/python 만 가능`
    : blanksLen === 0
      ? '부모 빈칸이 없습니다'
      : '';

  return (
    <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-600">
          옵션 조합 캐싱{Number.isInteger(tabIndex) ? ` · 탭 ${tabIndex}` : ''}
        </span>
        <button
          type="button"
          onClick={() => run({ tabIndex })}
          disabled={disabled}
          className={
            'rounded px-2 py-1 text-[11px] font-semibold ' +
            (disabled ? 'cursor-not-allowed bg-slate-200 text-slate-400' : 'bg-cyan-500 text-white hover:bg-cyan-600')
          }
          title={disabledReason || (correctOnly ? '정답 조합만 실행해 저장 (옵션 > 6)' : `모든 순열 ${expected}개 실행해 저장`)}
        >
          {running
            ? (progress?.total ? `실행 중 ${progress.done ?? 0}/${progress.total}` : '실행 중...')
            : (correctOnly ? '정답 조합만 실행 저장' : '모든 옵션 조합 실행 저장')}
        </button>
      </div>
      <div className="text-slate-500">
        캐시된 조합: {cachedCount}{correctOnly ? ' (정답만)' : ` / ${expected}`}
      </div>
      {disabledReason && <div className="mt-1 text-slate-400">{disabledReason}</div>}
      {error && <div className="mt-1 rounded bg-red-50 px-1.5 py-1 text-red-700">실행 실패: {error}</div>}
    </div>
  );
};

// 단일/탭별 캐싱 패널 — 모듈 ID + 선택적 tabIndex 받음.
const PrecomputePanel = ({ moduleId, tabIndex, code, language, cachedResult, disabledReason }) => {
  const { state } = useEditor();
  const slide = selectSelectedSlide(state);
  const lessonId = state.lesson?.id;
  const { run, running, error } = usePrecomputeModule(lessonId, slide?.id, moduleId);

  const [currentHash, setCurrentHash] = useState(null);
  useEffect(() => {
    if (disabledReason) { setCurrentHash(null); return; }
    let cancelled = false;
    computeCodeHash(langToExecutable(language), code || '').then((h) => {
      if (!cancelled) setCurrentHash(h);
    });
    return () => { cancelled = true; };
  }, [language, code, disabledReason]);

  const hashMismatch = cachedResult && currentHash && cachedResult.codeHash !== currentHash;
  const blocked = !!disabledReason || !lessonId || !slide?.id;

  return (
    <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-600">실행 결과 캐시{Number.isInteger(tabIndex) ? ` · 탭 ${tabIndex}` : ''}</span>
        <button
          type="button"
          onClick={() => run({ tabIndex })}
          disabled={running || blocked}
          className={
            'rounded px-2 py-1 text-[11px] font-semibold ' +
            (running || blocked
              ? 'cursor-not-allowed bg-slate-200 text-slate-400'
              : 'bg-cyan-500 text-white hover:bg-cyan-600')
          }
          title={disabledReason || (cachedResult ? '재실행해서 캐시 갱신' : '결과를 미리 실행해서 저장')}
        >
          {running ? '실행 중...' : (cachedResult ? '재실행' : '결과 저장')}
        </button>
      </div>
      {cachedResult && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-slate-500">
          <span>exit {cachedResult.exitCode}</span>
          <span>· {Math.round(cachedResult.durationMs)}ms</span>
          <span className="text-slate-400">· {new Date(cachedResult.executedAt).toLocaleString()}</span>
        </div>
      )}
      {cachedResult?.stdout && (
        <pre className="mt-1 max-h-16 overflow-auto rounded bg-slate-900 px-1.5 py-1 text-[10px] text-slate-100">{cachedResult.stdout.slice(0, 400)}</pre>
      )}
      {hashMismatch && (
        <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-amber-800">
          ⚠️ 캐시가 현재 코드와 다릅니다 — 재실행 필요
        </div>
      )}
      {disabledReason && (
        <div className="mt-1 text-slate-400">{disabledReason}</div>
      )}
      {error && (
        <div className="mt-1 rounded bg-red-50 px-1.5 py-1 text-red-700">실행 실패: {error}</div>
      )}
    </div>
  );
};

// {{userAnswer_N}} 토큰 패턴 — 채점 후 터미널 input 코드 안에서 빈칸 입력값으로 치환되는 자리표시자.
// 런타임 치환은 LessonLearningScreenV5.tsx 의 동일 패턴이 담당. 어드민에서는
// "부모(codeFillTheGapV2)의 blanks 인덱스 0..N-1" 만 유효하며, 범위 밖은 죽은 참조로 간주.
const TOKEN_RE = /\{\{userAnswer_(\d+)\}\}/g;

const LANG_OPTIONS = [
  { value: 'js', label: 'js' },
  { value: 'py', label: 'py' },
  { value: 'java', label: 'java' },
  { value: 'html', label: 'html' },
  { value: 'css', label: 'css' },
];

const MONACO_LANG = { js: 'javascript', py: 'python', java: 'java', html: 'html', css: 'css' };

const PROMPT_BY_LANG = { py: '>>> ', java: '$ ', js: '> ', html: '> ', css: '> ' };

const findInvalidTokens = (text, blanksLen) => {
  const out = [];
  if (!text) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const idx = parseInt(m[1], 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= blanksLen) {
      out.push({ idx, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
};

// 텍스트를 토큰 단위로 분해해 미리보기에서 색상 강조용 세그먼트 배열로 변환.
const splitWithTokens = (text) => {
  if (!text) return [];
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'token', value: m[0], idx: parseInt(m[1], 10) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
};

const detectMode = (value) => {
  if (Array.isArray(value?.files) && value.files.length > 0) return 'multi';
  if (Array.isArray(value?.script)) return 'single';
  return 'multi';
};

// script[] → 단일 코드 문자열. type 무관 모두 input 코드로 간주.
const scriptToCode = (script) => (script || []).map((s) => s?.text || '').join('\n');
// 단일 코드 문자열 → script[]. 모두 type: 'input' 으로 통일 (실행 대상 코드).
const codeToScript = (code) => {
  const lines = (code || '').split('\n');
  return lines.map((line) => ({ type: 'input', text: line }));
};

// ============================================================================
// 공용 — 토큰 삽입 패널 + Monaco 스크립트 에디터
// ============================================================================
const TokenInsertPanel = ({ blanksLen, parentValue, tokenSummary, onInsert }) => (
  <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-2">
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      빈칸 토큰 삽입
    </div>
    {blanksLen === 0 ? (
      <p className="text-[11px] text-slate-400">부모 빈칸 채우기에 빈칸이 없습니다.</p>
    ) : (
      <>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: blanksLen }, (_, n) => {
            const sample = parentValue?.blanks?.[n]?.correctAnswer;
            const inUse = tokenSummary.used.includes(n);
            return (
              <button
                type="button"
                key={n}
                onClick={() => onInsert(n)}
                className={
                  'inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] ' +
                  (inUse
                    ? 'bg-cyan-500 text-white ring-1 ring-cyan-600'
                    : 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-100')
                }
                title={sample ? `정답 예: ${sample}` : ''}
              >
                <span className="font-bold">#{n}</span>
                <span className="opacity-80">{`{{userAnswer_${n}}}`}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400">
          Monaco 에디터의 커서 위치에 삽입됩니다.
        </p>
        {tokenSummary.invalid.length > 0 && (
          <p className="mt-1 text-[11px] text-red-600">
            ⚠ 유효하지 않은 토큰: {tokenSummary.invalid.map((i) => `#${i}`).join(', ')} — 부모 빈칸 범위(0..{blanksLen - 1}) 밖입니다.
          </p>
        )}
      </>
    )}
  </div>
);

// 토큰 사용/유효성 요약 — code 문자열을 입력으로.
const summarizeTokens = (code, blanksLen) => {
  const used = new Set();
  const invalid = new Set();
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(code || '')) !== null) {
    const idx = parseInt(m[1], 10);
    used.add(idx);
    if (Number.isNaN(idx) || idx < 0 || idx >= blanksLen) invalid.add(idx);
  }
  return { used: [...used].sort((a, b) => a - b), invalid: [...invalid].sort((a, b) => a - b) };
};

// Monaco 에디터에 토큰 텍스트를 커서 위치에 삽입.
const insertTokenIntoEditor = (editor, n, fallbackAppend) => {
  const token = `{{userAnswer_${n}}}`;
  if (!editor) {
    fallbackAppend?.(token);
    return;
  }
  const selection = editor.getSelection();
  const range = selection && !selection.isEmpty()
    ? selection
    : new monaco.Range(
        selection?.startLineNumber || 1,
        selection?.startColumn || 1,
        selection?.startLineNumber || 1,
        selection?.startColumn || 1,
      );
  editor.executeEdits('insert-token', [
    { range, text: token, forceMoveMarkers: true },
  ]);
  editor.focus();
};

// 단일 파일 객체({language, script, showInput, ...}) 에 대한 Monaco 코드 에디터.
// script[] ↔ code 문자열 변환은 내부 처리. legacy(type: 'output'/'error') 라인은 1회성으로 정리.
const FileScriptEditor = ({ file, onChange, blanksLen, height, editorRef }) => {
  const language = file?.language || 'js';
  const monacoLang = MONACO_LANG[language] || 'plaintext';
  const code = useMemo(() => scriptToCode(file?.script), [file?.script]);

  // legacy 데이터 정리 — type 무관 input 만 남기고 showInput 항상 true 고정.
  const cleanedRef = useRef(false);
  useEffect(() => {
    if (cleanedRef.current) return;
    cleanedRef.current = true;
    const orig = file?.script || [];
    const filtered = orig.filter((s) => !s?.type || s.type === 'input');
    if (filtered.length !== orig.length || file?.showInput !== true) {
      onChange({
        ...file,
        script: filtered.length !== orig.length ? filtered : orig,
        showInput: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCodeChange = (next) => {
    onChange({ ...file, script: codeToScript(next), showInput: true });
  };

  return (
    <MonacoField
      value={code}
      onChange={handleCodeChange}
      language={monacoLang}
      height={Math.max(120, Math.min(height || 200, 360))}
      disableAutoFormat
      onReady={(ed) => { if (editorRef) editorRef.current = ed; }}
    />
  );
};

// ============================================================================
// 단일 탭 모드 (루트 script[] — 채점 후 코드 실행 대상)
// type 구분/showInput 토글 없음. 라인 단위 input 묶음 대신 Monaco 1개로 통합.
// ============================================================================
const SingleScriptForm = ({ value, onChange }) => {
  const language = value.language || 'js';
  const editorRef = useRef(null);
  const { parentType, parentValue } = useResultParent();
  const isFillGapChild = parentType === 'codeFillTheGapV2';
  const blanksLen = isFillGapChild ? (parentValue?.blanks?.length || 0) : 0;

  const code = useMemo(() => scriptToCode(value.script), [value.script]);
  const tokenSummary = useMemo(() => summarizeTokens(code, blanksLen), [code, blanksLen]);

  // 파일 객체로 모양을 맞춰 FileScriptEditor 재사용.
  const pseudoFile = { language, script: value.script, showInput: value.showInput };
  const handleFileChange = (next) => {
    onChange({ ...value, language: next.language, script: next.script, showInput: next.showInput });
  };

  return (
    <>
      <Field label="높이 (px)">
        <NumberField value={value.height} onChange={(v) => onChange({ ...value, height: v })} min={60} max={800} />
      </Field>
      <Field label="언어 (실행 시 사용)">
        <SelectField
          value={language}
          onChange={(v) => onChange({ ...value, language: v })}
          options={LANG_OPTIONS}
        />
      </Field>

      {isFillGapChild && (
        <TokenInsertPanel
          blanksLen={blanksLen}
          parentValue={parentValue}
          tokenSummary={tokenSummary}
          onInsert={(n) => insertTokenIntoEditor(editorRef.current, n, (token) => {
            handleFileChange({ ...pseudoFile, script: codeToScript((code || '') + token) });
          })}
        />
      )}

      <Field label="스크립트 (실행될 코드)">
        <FileScriptEditor
          file={pseudoFile}
          onChange={handleFileChange}
          blanksLen={blanksLen}
          height={value.height}
          editorRef={editorRef}
        />
      </Field>

      {(value.executionMode || 'cached') !== 'live' && (
        isFillGapChild ? (
          <PermutationPrecomputePanel
            moduleId={value.id}
            language={language}
            optionsLen={parentValue?.interactionOptions?.length || 0}
            blanksLen={blanksLen}
            cachedResults={value.cachedResults}
          />
        ) : (
          <PrecomputePanel
            moduleId={value.id}
            code={code}
            language={language}
            cachedResult={value.cachedResult}
            disabledReason={
              !isCacheableLang(language)
                ? 'javascript/python 만 실행 캐싱 지원'
                : hasTokens(code)
                  ? '빈칸 토큰이 포함되어 캐싱 불가'
                  : ''
            }
          />
        )
      )}
    </>
  );
};

// ============================================================================
// 다중 탭 모드 (files[] — 여러 파일 = 여러 탭, 각 파일은 단일 탭과 동일한 Monaco UX)
// ============================================================================
const MultiFilesForm = ({ value, onChange }) => {
  const files = value.files || [];
  const [active, setActive] = useState(0);
  const safeActive = Math.min(active, Math.max(files.length - 1, 0));
  const editorRef = useRef(null);
  const { parentType, parentValue } = useResultParent();
  const isFillGapChild = parentType === 'codeFillTheGapV2';
  const blanksLen = isFillGapChild ? (parentValue?.blanks?.length || 0) : 0;

  const setFiles = (next) => onChange({ ...value, files: next });
  const updateFile = (idx, patch) => setFiles(files.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  const activeFile = files[safeActive];
  const activeCode = useMemo(() => scriptToCode(activeFile?.script), [activeFile?.script]);
  const tokenSummary = useMemo(() => summarizeTokens(activeCode, blanksLen), [activeCode, blanksLen]);

  return (
    <>
      <Field label="높이 (px)">
        <NumberField value={value.height} onChange={(v) => onChange({ ...value, height: v })} min={60} max={800} />
      </Field>

      <Field label={`파일 / 탭 (${files.length})`}>
        <div className="flex flex-wrap items-center gap-1">
          {files.map((f, i) => (
            <button
              type="button"
              key={i}
              onClick={() => setActive(i)}
              className={
                'rounded border px-2 py-1 text-[11px] font-medium transition ' +
                (i === safeActive
                  ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
              }
            >
              {f.name || `script.${f.language || 'js'}`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              const next = [...files, { name: `script${files.length + 1}.js`, language: 'js', script: [], showInput: true }];
              setFiles(next);
              setActive(next.length - 1);
            }}
            className="rounded bg-slate-100 px-2 py-1 text-[11px] hover:bg-slate-200"
          >
            + 파일 추가
          </button>
        </div>
      </Field>

      {activeFile ? (
        <div className="rounded border border-slate-200 p-2">
          <Field label="파일명">
            <TextField value={activeFile.name} onChange={(v) => updateFile(safeActive, { name: v })} />
          </Field>
          <Field label="언어 (실행 시 사용)">
            <SelectField
              value={activeFile.language || 'js'}
              onChange={(v) => updateFile(safeActive, { language: v })}
              options={LANG_OPTIONS}
            />
          </Field>

          {isFillGapChild && (
            <TokenInsertPanel
              blanksLen={blanksLen}
              parentValue={parentValue}
              tokenSummary={tokenSummary}
              onInsert={(n) => insertTokenIntoEditor(editorRef.current, n, (token) => {
                updateFile(safeActive, { script: codeToScript((activeCode || '') + token), showInput: true });
              })}
            />
          )}

          <Field label="스크립트 (실행될 코드)">
            <FileScriptEditor
              key={safeActive}
              file={activeFile}
              onChange={(next) => updateFile(safeActive, next)}
              blanksLen={blanksLen}
              height={value.height}
              editorRef={editorRef}
            />
          </Field>

          {(value.executionMode || 'cached') !== 'live' && (
            isFillGapChild ? (
              <PermutationPrecomputePanel
                moduleId={value.id}
                tabIndex={safeActive}
                language={activeFile.language || 'js'}
                optionsLen={parentValue?.interactionOptions?.length || 0}
                blanksLen={blanksLen}
                cachedResults={value.cachedResults}
              />
            ) : (
              <PrecomputePanel
                moduleId={value.id}
                tabIndex={safeActive}
                code={activeCode}
                language={activeFile.language || 'js'}
                cachedResult={activeFile.cachedResult}
                disabledReason={
                  !isCacheableLang(activeFile.language || 'js')
                    ? 'javascript/python 만 실행 캐싱 지원'
                    : hasTokens(activeCode)
                      ? '빈칸 토큰이 포함되어 캐싱 불가'
                      : ''
                }
              />
            )
          )}

          <button
            type="button"
            onClick={() => {
              const next = files.filter((_, i) => i !== safeActive);
              setFiles(next);
              setActive(Math.min(safeActive, Math.max(next.length - 1, 0)));
            }}
            className="text-xs text-red-500 hover:underline"
          >
            현재 탭 삭제
          </button>
        </div>
      ) : (
        <p className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-400">
          파일이 없습니다. + 파일 추가를 눌러 탭을 만들어보세요.
        </p>
      )}
    </>
  );
};

const FormView = ({ value, onChange }) => {
  const detected = detectMode(value);
  const [mode, setMode] = useState(detected);

  const switchMode = (next) => {
    if (next === mode) return;
    if (next === 'single') {
      // multi → single: 첫 번째 파일을 루트로 끌어올림. 다른 파일이 있으면 데이터 손실 경고.
      const files = value.files || [];
      if (files.length > 1) {
        const ok = window.confirm(`다중 탭 ${files.length}개 중 첫 번째 파일만 단일 탭으로 옮겨집니다. 나머지는 제거됩니다. 계속할까요?`);
        if (!ok) return;
      }
      const first = files[0];
      onChange({
        ...value,
        files: undefined,
        language: first?.language || value.language || 'js',
        script: first?.script || value.script || [],
        showInput: true,
      });
    } else {
      // single → multi: 루트 script 를 단일 파일로 변환.
      onChange({
        ...value,
        files: [{
          name: 'script.js',
          language: value.language || 'js',
          showInput: value.showInput,
          script: value.script || [],
        }],
        language: undefined,
        script: undefined,
      });
    }
    setMode(next);
  };

  return (
    <>
      <Field label="모드">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => switchMode('single')}
            className={
              'rounded border px-2 py-0.5 text-xs font-medium transition ' +
              (mode === 'single'
                ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
            }
          >
            단일 탭
          </button>
          <button
            type="button"
            onClick={() => switchMode('multi')}
            className={
              'rounded border px-2 py-0.5 text-xs font-medium transition ' +
              (mode === 'multi'
                ? 'border-cyan-500 bg-cyan-50 text-cyan-700'
                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300')
            }
          >
            다중 탭
          </button>
        </div>
      </Field>

      {mode === 'single' ? <SingleScriptForm value={value} onChange={onChange} /> : <MultiFilesForm value={value} onChange={onChange} />}

      <IdeIntegrationField value={value.ide} onChange={(ide) => onChange({ ...value, ide })} />
    </>
  );
};

// 토큰을 원본 텍스트 `{{userAnswer_N}}` 그대로 노출하되 해당 영역에 cyan 하이라이트.
const renderTextWithTokens = (text, blanksLen) => {
  const parts = splitWithTokens(text);
  if (parts.length === 0) return null;
  return parts.map((p, idx) => {
    if (p.kind === 'text') return <span key={idx}>{p.value}</span>;
    const isInvalid = typeof blanksLen === 'number' && (p.idx < 0 || p.idx >= blanksLen);
    return (
      <span
        key={idx}
        style={{
          background: isInvalid ? 'rgba(248,113,113,0.35)' : 'rgba(6,182,212,0.25)',
          color: isInvalid ? '#FCA5A5' : '#67E8F9',
          padding: '0 2px',
          borderRadius: 3,
          fontWeight: 700,
        }}
      >
        {p.value}
      </span>
    );
  });
};

// RN Terminal.tsx 의 runScript() 와 동일한 시퀀스를 정적으로 미러링.
// - Java: `$ javac Main.java`, `$ java Main` 두 줄 → output 라인들 → 마지막 prompt 줄
// - JS/Python (showInput): 첫 라인 앞에만 prompt, 이후 라인은 prompt 없이, 마지막에 prompt 줄
// - showInput=false: output 라인만 출력 (prompt 없음)
// 모든 텍스트는 xterm 기본 색(흰색)을 따르고 error 만 빨강. 토큰 영역만 cyan 하이라이트.
const ScriptLines = ({ file, blanksLen, forceShowInput }) => {
  if (!file) return null;
  const showInput = forceShowInput || file.showInput === true;
  const prompt = PROMPT_BY_LANG[file.language] || '> ';
  const script = file.script || [];
  const lang = file.language;

  const renderLine = (key, text, opts = {}) => {
    const { isError = false, leadingPrompt = false } = opts;
    return (
      <div key={key} style={{ color: isError ? '#FCA5A5' : '#fff' }}>
        {leadingPrompt ? prompt : ''}
        {renderTextWithTokens(text || '', blanksLen)}
      </div>
    );
  };

  const out = [];
  if (lang === 'java') {
    out.push(renderLine('jvc', 'javac Main.java', { leadingPrompt: true }));
    out.push(renderLine('jrn', 'java Main', { leadingPrompt: true }));
    script.forEach((s, i) => {
      if (s?.type === 'output') {
        const lines = (s.text || '').split('\n');
        lines.forEach((ln, j) => out.push(renderLine(`o-${i}-${j}`, ln)));
      } else if (s?.type === 'error') {
        out.push(renderLine(`e-${i}`, s.text, { isError: true }));
      }
    });
    out.push(renderLine('tail', '', { leadingPrompt: true }));
  } else {
    let promptRendered = false;
    script.forEach((s, i) => {
      const isInput = !s?.type || s.type === 'input';
      if (isInput && !showInput) return;
      const leading = isInput && showInput && !promptRendered;
      if (isInput && showInput) promptRendered = true;
      out.push(renderLine(`s-${i}`, s?.text, {
        isError: s?.type === 'error',
        leadingPrompt: leading,
      }));
    });
    if (showInput) out.push(renderLine('tail', '', { leadingPrompt: true }));
  }
  return out;
};

// RN Terminal.tsx 외형 미러: 26px 어두운 회색 헤더 + 회색 traffic lights + 검정 본문.
// 단일 탭 모드: 탭 버튼 없음, traffic lights 만. 다중 탭 모드: 탭 버튼 노출.
const PreviewView = ({ module }) => {
  const { parentType, parentValue } = useResultParent();
  const blanksLen = parentType === 'codeFillTheGapV2' ? (parentValue?.blanks?.length || 0) : undefined;

  const files = module.files || [];
  const [active, setActive] = useState(0);
  const height = module.height || 200;
  const isSingleMode = !files.length && Array.isArray(module.script);
  const singleFile = useMemo(() => (
    isSingleMode
      ? {
          name: 'script',
          language: module.language || 'js',
          showInput: true,
          script: module.script || [],
        }
      : null
  ), [isSingleMode, module]);
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
        <IdeOpenBadge module={module} />
      </div>
      <pre
        style={{
          background: '#000',
          height,
          color: '#fff',
          margin: 0,
          padding: 12,
          fontFamily: 'Menlo, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.2,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      >
        {isSingleMode
          ? <ScriptLines file={singleFile} blanksLen={blanksLen} forceShowInput />
          : <ScriptLines file={files[active]} blanksLen={blanksLen} />}
      </pre>
    </div>
  );
};

export default {
  type: 'terminal',
  category: 'code',
  label: '터미널',
  description: 'xterm.js 터미널 (단일/다중 탭). 단일 탭 모드는 백엔드 executor 연동.',
  icon: '',
  defaultValue: () => ({
    type: 'terminal',
    height: 200,
    files: [{ name: 'script.js', language: 'js', script: [{ type: 'output', text: 'Hello, world!' }] }],
  }),
  FormView,
  PreviewView,
};
