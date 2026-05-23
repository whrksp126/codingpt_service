import { useEffect, useMemo, useState } from 'react';
import { Field, TextField, NumberField } from './_shared/SharedFields';
import { useEditor, selectSelectedSlide } from '../state/EditorContext';
import { usePrecomputeModule, usePrecomputePermutations } from '../state/usePrecompute';
import { computeCodeHash } from '../../../../utils/codeHash';

// linked code/codeFillTheGapV2 의 첫 파일 / plainCode 의 언어를 정규화.
const langToExecutable = (lang) => {
  const l = String(lang || '').toLowerCase();
  if (l === 'js') return 'javascript';
  if (l === 'py') return 'python';
  return l;
};
const isCacheableLang = (lang) => ['javascript', 'python'].includes(langToExecutable(lang));

const TOKEN_RE = /\{\{userAnswer_(\d+)\}\}/g;

// 옵션 N 개 + 빈칸 M 개 → 순열 P(N, M). 옵션 > 6 또는 빈칸 0/초과 시 0 (정답 1조합만 실행).
const countPermutations = (n, m) => {
  if (n > 6 || m === 0 || m > n) return 0;
  let p = 1;
  for (let i = 0; i < m; i++) p *= (n - i);
  return p;
};

// linkedModuleId 가 code 모듈일 때의 단일 캐싱 패널.
const CodeLinkedPrecompute = ({ moduleId, linkedCode }) => {
  const { state } = useEditor();
  const slide = selectSelectedSlide(state);
  const lessonId = state.lesson?.id;
  const { run, running, error } = usePrecomputeModule(lessonId, slide?.id, moduleId);

  const firstFile = linkedCode?.files?.[0];
  const language = firstFile?.language;
  const code = firstFile?.content || '';
  const cacheable = isCacheableLang(language);

  // 모듈 cachedResult.codeHash vs 현재 코드 해시 비교 — stale 표시
  const [currentHash, setCurrentHash] = useState(null);
  useEffect(() => {
    if (!cacheable) { setCurrentHash(null); return; }
    let cancelled = false;
    computeCodeHash(langToExecutable(language), code).then((h) => {
      if (!cancelled) setCurrentHash(h);
    });
    return () => { cancelled = true; };
  }, [language, code, cacheable]);

  // 현재 모듈 자신의 cachedResult 를 조회하려면 슬라이드에서 다시 찾아야 함
  const myMod = (slide?.contents?.modules || []).find((m) => String(m.id) === String(moduleId));
  const cached = myMod?.cachedResult;
  const hashMismatch = cached && currentHash && cached.codeHash !== currentHash;
  const disabled = !cacheable || !lessonId || !slide?.id || running;
  const disabledReason = !cacheable
    ? `${language || '(언어 없음)'} 은 실행 캐싱 미지원 — js/python 만 가능`
    : '';

  return (
    <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-600">실행 결과 캐시 (단일)</span>
        <button
          type="button"
          onClick={() => run()}
          disabled={disabled}
          className={
            'rounded px-2 py-1 text-[11px] font-semibold ' +
            (disabled ? 'cursor-not-allowed bg-slate-200 text-slate-400' : 'bg-cyan-500 text-white hover:bg-cyan-600')
          }
          title={disabledReason || (cached ? '재실행해서 캐시 갱신' : '결과를 미리 실행해서 저장')}
        >
          {running ? '실행 중...' : (cached ? '재실행' : '결과 저장')}
        </button>
      </div>
      {cached && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-slate-500">
          <span>exit {cached.exitCode}</span>
          <span>· {Math.round(cached.durationMs)}ms</span>
          <span className="text-slate-400">· {new Date(cached.executedAt).toLocaleString()}</span>
        </div>
      )}
      {cached?.stdout && (
        <pre className="mt-1 max-h-16 overflow-auto rounded bg-slate-900 px-1.5 py-1 text-[10px] text-slate-100">{cached.stdout.slice(0, 400)}</pre>
      )}
      {hashMismatch && (
        <div className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-amber-800">
          ⚠️ 캐시가 현재 연결 코드와 다릅니다 — 재실행 필요
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

// linkedModuleId 가 codeFillTheGapV2 일 때의 옵션 조합별 캐싱 패널.
const FillGapLinkedPrecompute = ({ moduleId, linkedFillGap, cachedResults }) => {
  const { state } = useEditor();
  const slide = selectSelectedSlide(state);
  const lessonId = state.lesson?.id;
  const { run, running, progress, error } = usePrecomputePermutations(lessonId, slide?.id, moduleId);

  const language = linkedFillGap?.language;
  const cacheable = isCacheableLang(language);
  const blanksLen = (linkedFillGap?.blanks || []).length;
  const optionsLen = (linkedFillGap?.interactionOptions || []).length;
  const expected = countPermutations(optionsLen, blanksLen);
  const correctOnly = optionsLen > 6 || expected === 0;
  const cachedCount = Object.keys(cachedResults || {}).length;
  const disabled = !cacheable || blanksLen === 0 || !lessonId || !slide?.id || running;
  const disabledReason = !cacheable
    ? `${language || '(언어 없음)'} 은 실행 캐싱 미지원 — js/python 만 가능`
    : blanksLen === 0
      ? '연결된 빈칸 채우기에 빈칸이 없습니다'
      : '';

  return (
    <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-600">옵션 조합 캐싱</span>
        <button
          type="button"
          onClick={() => run()}
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

// initialCommand 토큰 미리보기 — 부모(linked codeFillTheGapV2) 의 정답값으로 치환한 결과를 보여줌.
const InitialCommandPreview = ({ text, linkedFillGap }) => {
  if (!text || !linkedFillGap) return null;
  const blanks = linkedFillGap.blanks || [];
  TOKEN_RE.lastIndex = 0;
  const used = new Set();
  const invalid = new Set();
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const idx = parseInt(m[1], 10);
    used.add(idx);
    if (Number.isNaN(idx) || idx < 0 || idx >= blanks.length) invalid.add(idx);
  }
  if (used.size === 0) return null;
  const sample = text.replace(TOKEN_RE, (mm, n) => {
    const i = parseInt(n, 10);
    return blanks[i]?.correctAnswer ?? mm;
  });
  return (
    <div className="mt-1 text-[11px] text-slate-500">
      <div>토큰 미리보기 (정답 기준): <span className="font-mono text-slate-700">{sample}</span></div>
      {invalid.size > 0 && (
        <div className="mt-0.5 text-red-600">⚠ 유효하지 않은 토큰: {[...invalid].map((i) => `#${i}`).join(', ')}</div>
      )}
    </div>
  );
};

const FormView = ({ value, onChange }) => {
  const { state, dispatch } = useEditor();
  const slide = selectSelectedSlide(state);
  const modules = slide?.contents?.modules || [];

  const linked = useMemo(() => modules.find((m) => String(m.id) === String(value.linkedModuleId)), [modules, value.linkedModuleId]);
  const isLinkedCode = linked?.type === 'code';
  const isLinkedFillGap = linked?.type === 'codeFillTheGapV2';
  const linkingMode = state.ui?.linkingMode;
  const isPickingHere = linkingMode?.sourceModuleId != null
    && String(linkingMode.sourceModuleId) === String(value.id);

  const enterLinking = () => dispatch({ type: 'enterLinkingMode', sourceModuleId: value.id });
  const exitLinking = () => dispatch({ type: 'exitLinkingMode' });

  // #N 버튼 클릭 → 슬라이드 캔버스에서 해당 모듈 카드로 스크롤 + 1.2s 동안 amber ring 강조.
  const flashLinked = () => {
    if (linked?.id == null) return;
    dispatch({ type: 'flashModule', moduleId: linked.id });
    setTimeout(() => dispatch({ type: 'flashModule', moduleId: null }), 1200);
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
        <div className="flex-1 truncate">
          {value.linkedModuleId == null ? (
            <span className="text-amber-700">연결 모듈 미설정</span>
          ) : !linked ? (
            <span className="text-red-600">연결 모듈을 찾을 수 없음 (#{value.linkedModuleId})</span>
          ) : (
            <span className="text-cyan-700">
              연결 모듈:{' '}
              <button
                type="button"
                onClick={flashLinked}
                className="rounded bg-white px-1.5 py-0.5 font-mono font-semibold text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-50"
                title="슬라이드에서 위치 강조"
              >
                #{linked.id}
              </button>
            </span>
          )}
        </div>
        {isPickingHere ? (
          <button
            type="button"
            onClick={exitLinking}
            className="rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-50"
          >
            선택 취소
          </button>
        ) : (
          <button
            type="button"
            onClick={enterLinking}
            className="rounded bg-cyan-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-cyan-600"
          >
            {value.linkedModuleId == null ? '연결 모듈 선택' : '연결 모듈 변경'}
          </button>
        )}
      </div>

      <Field label="초기 명령어 (initialCommand)">
        <TextField
          value={value.initialCommand}
          onChange={(v) => onChange({ ...value, initialCommand: v })}
          placeholder="예: python index.py"
        />
        {isLinkedFillGap && (
          <InitialCommandPreview text={value.initialCommand} linkedFillGap={linked} />
        )}
      </Field>

      <Field label="높이 (px)">
        <NumberField
          value={value.height}
          onChange={(v) => onChange({ ...value, height: v })}
          min={60}
          max={800}
        />
      </Field>

      {(value.executionMode || 'cached') !== 'live' && (
        isLinkedCode ? (
          <CodeLinkedPrecompute moduleId={value.id} linkedCode={linked} />
        ) : isLinkedFillGap ? (
          <FillGapLinkedPrecompute moduleId={value.id} linkedFillGap={linked} cachedResults={value.cachedResults} />
        ) : null
      )}
    </>
  );
};

// 정답 기준 answerKey (RN buildAnswerKey 와 동일 규약).
const buildCorrectAnswerKey = (blanks) =>
  JSON.stringify((blanks || []).map((b, i) => [i, b?.correctAnswer ?? null]));

// initialCommand 토큰 치환 — 부모 codeFillTheGapV2 정답 기준.
const substituteInitialCommand = (text, blanks) => {
  if (!text) return '';
  return String(text).replace(/\{\{userAnswer_(\d+)\}\}/g, (mm, n) => {
    const i = parseInt(n, 10);
    const v = blanks?.[i]?.correctAnswer;
    return v != null ? String(v) : mm;
  });
};

// 어드민 미리보기:
//   - linked=code  → cachedResult (단일) stdout
//   - linked=codeFillTheGapV2 → 정답 조합으로 cachedResults lookup → stdout (정답 시나리오 시각화)
//   - initialCommand 는 부모가 codeFillTheGapV2 일 때 토큰 정답 치환 후 표시
const PreviewView = ({ module }) => {
  const { state } = useEditor();
  const slide = selectSelectedSlide(state);
  const modules = slide?.contents?.modules || [];
  const linked = modules.find((m) => String(m.id) === String(module.linkedModuleId));

  const height = module.height || 120;
  const cachedCount = Object.keys(module.cachedResults || {}).length;

  // 표시할 결과 선택
  let displayCached = null;
  let displaySource = '';
  if (linked?.type === 'code') {
    displayCached = module.cachedResult;
    if (displayCached) displaySource = '연결 코드 실행 결과';
  } else if (linked?.type === 'codeFillTheGapV2') {
    const key = buildCorrectAnswerKey(linked.blanks);
    displayCached = module.cachedResults?.[key];
    if (displayCached) displaySource = '정답 조합 실행 결과';
  } else if (module.cachedResult) {
    displayCached = module.cachedResult;
  }

  // initialCommand 토큰 치환 (정답 기준)
  const cmd = linked?.type === 'codeFillTheGapV2'
    ? substituteInitialCommand(module.initialCommand, linked.blanks)
    : (module.initialCommand || '');

  return (
    <div className="overflow-hidden rounded-[10px] border border-[#5e5e5e]">
      <div className="flex items-end h-[26px] px-[10px]" style={{ background: '#3c3c3c', gap: 10 }}>
        <div className="flex items-center h-full" style={{ gap: 5 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="w-[10px] h-[10px] rounded-full" style={{ background: '#545454' }} />
          ))}
        </div>
      </div>
      <pre
        style={{
          background: '#000',
          height,
          color: '#fff',
          margin: 0,
          padding: 12,
          fontFamily: 'Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.3,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {cmd ? <div style={{ color: '#9CA3AF' }}>{`$ ${cmd}`}</div> : null}
        {displayCached ? (
          <>
            {displayCached.stdout || ''}
            {displayCached.stderr ? <span style={{ color: '#FCA5A5' }}>{`\n[stderr] ${displayCached.stderr}`}</span> : null}
          </>
        ) : cachedCount > 0 ? (
          <div style={{ color: '#6B7280' }}>{`// 옵션 조합 캐시 ${cachedCount}개 저장됨 — 정답 조합 결과 없음 (재실행 필요?)`}</div>
        ) : (
          <div style={{ color: '#6B7280' }}>{'// 연결 모듈 코드 실행 결과 (캐시 없음 — RN 라이브 실행)'}</div>
        )}
      </pre>
    </div>
  );
};

export default {
  type: 'simpleTerminal',
  category: 'code',
  label: '심플 터미널',
  description: '연결한 코드/빈칸채우기 모듈의 실행 결과를 출력 (initialCommand 지원)',
  icon: '',
  defaultValue: () => ({
    type: 'simpleTerminal',
    linkedModuleId: null,
    initialCommand: '',
    height: 120,
    executionMode: 'cached',
  }),
  FormView,
  PreviewView,
};
