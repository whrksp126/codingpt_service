import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, selectSelectedSlide } from '../state/EditorContext';
import { Field, TextField, NumberField, SelectField, Section } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';
import ResultModulesField from './_shared/ResultModulesField';
import {
  SUPPORTED_LANGUAGES,
  composeContent,
  decomposeContent,
  reorderBlanks,
  previewHtml,
  validateBlanks,
} from './_shared/codeFillUtils';
import { fetchCodeFillContent, upsertCodeFillContent } from '../../../../utils/lessonApi';

const DEBOUNCE_MS = 1000;

const FormView = ({ value, onChange }) => {
  const { state } = useEditor();
  const currentSlide = selectSelectedSlide(state);
  const slideId = currentSlide?.id;

  const editorRef = useRef(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const plainCode = value.plainCode || '';
  const language = value.language || 'html';
  const blanks = value.blanks || [];
  const answers = value.answers || [];
  const interactionOptions = value.interactionOptions || [];

  // 검증된 blanks (plainCode와 substring 일치 여부)
  const verifiedBlanks = useMemo(
    () => validateBlanks(plainCode, blanks),
    [plainCode, blanks],
  );
  const hasInvalid = verifiedBlanks.some((b) => b.invalid);

  // slideId 자동 주입 + 레거시 데이터 backfill
  const backfilledRef = useRef(false);
  useEffect(() => {
    if (!slideId) return;
    const next = { ...valueRef.current };
    let changed = false;
    if (next.slideId !== slideId) {
      next.slideId = slideId;
      changed = true;
    }
    if (changed) onChange(next);

    // plainCode가 비어있고 DB에 content가 있으면 역추출 시도
    if (backfilledRef.current) return;
    if ((next.plainCode || '').length > 0) {
      backfilledRef.current = true;
      return;
    }
    backfilledRef.current = true;
    (async () => {
      try {
        const data = await fetchCodeFillContent(slideId);
        const content = data?.content || '';
        if (!content) return;
        const { plainCode: pc, blanks: parsedBlanks } = decomposeContent(content, valueRef.current.answers || []);
        if (!pc) return;
        // answers/options 보존, blanks/plainCode/language 채움
        const nextAnswers = parsedBlanks.map((b, i) => valueRef.current.answers?.[i] || {
          userAnswer: null,
          correctAnswer: b.correctAnswer,
          isCorrect: null,
        });
        onChange({
          ...valueRef.current,
          slideId,
          plainCode: pc,
          blanks: parsedBlanks,
          answers: nextAnswers,
          language: valueRef.current.language || 'html',
        });
      } catch (e) {
        // 404 (해당 slide의 code_fill_gap 없음) 는 정상 — 신규 모듈이므로 빈 상태 유지
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideId]);

  // 디바운스 저장 — plainCode/language/blanks 변경 시 DB 합성 + upsert
  const saveTimerRef = useRef(null);
  useEffect(() => {
    if (!slideId) return;
    if (hasInvalid) return; // invalid 상태에서는 저장 보류
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const content = composeContent(plainCode, language, blanks);
        upsertCodeFillContent(slideId, content).catch((e) => {
          console.warn('[codeFillTheGapV2] upsert 실패', e);
        });
      } catch (e) {
        console.warn('[codeFillTheGapV2] composeContent 실패', e);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [slideId, plainCode, language, blanks, hasInvalid]);

  const updatePlainCode = (next) => {
    onChange({ ...value, plainCode: next });
  };

  const updateLanguage = (lang) => {
    onChange({ ...value, language: lang });
  };

  const handleAddBlank = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    if (!sel || sel.isEmpty()) {
      window.alert('Monaco 에디터에서 빈칸으로 만들 텍스트를 먼저 드래그 선택하세요.');
      return;
    }
    const model = editor.getModel();
    const text = model.getValueInRange(sel);
    if (!text) return;
    const start = model.getOffsetAt(sel.getStartPosition());
    const end = model.getOffsetAt(sel.getEndPosition());

    // 기존 blank 와 위치 겹치면 거절
    const overlap = blanks.some((b) => !(end <= b.start || start >= b.end));
    if (overlap) {
      window.alert('이미 빈칸인 영역과 겹칩니다.');
      return;
    }

    const newBlank = { start, end, correctAnswer: text };
    const nextBlanksRaw = [...blanks, newBlank];
    const nextAnswersRaw = [
      ...answers,
      { userAnswer: null, correctAnswer: text, isCorrect: null },
    ];
    const { blanks: sortedBlanks, answers: sortedAnswers } = reorderBlanks(nextBlanksRaw, nextAnswersRaw);

    // 옵션 자동 추가 (없으면)
    const nextOptions = interactionOptions.some((o) => o.value === text)
      ? interactionOptions
      : [...interactionOptions, { value: text }];

    onChange({
      ...value,
      blanks: sortedBlanks,
      answers: sortedAnswers,
      interactionOptions: nextOptions,
    });
  };

  const handleRemoveBlank = (i) => {
    const nextBlanksRaw = blanks.filter((_, idx) => idx !== i);
    const nextAnswersRaw = answers.filter((_, idx) => idx !== i);
    const { blanks: sortedBlanks, answers: sortedAnswers } = reorderBlanks(nextBlanksRaw, nextAnswersRaw);
    onChange({ ...value, blanks: sortedBlanks, answers: sortedAnswers });
  };

  const handleAddOption = () => {
    onChange({
      ...value,
      interactionOptions: [...interactionOptions, { value: '' }],
    });
  };

  const handleUpdateOption = (i, v) => {
    onChange({
      ...value,
      interactionOptions: interactionOptions.map((o, idx) => (idx === i ? { ...o, value: v } : o)),
    });
  };

  const handleRemoveOption = (i) => {
    onChange({
      ...value,
      interactionOptions: interactionOptions.filter((_, idx) => idx !== i),
    });
  };

  return (
    <>
      {!slideId && (
        <p className="mb-2 rounded bg-amber-50 p-2 text-[11px] text-amber-700">
          슬라이드 ID 가 아직 없습니다. 슬라이드 저장 후 다시 시도하세요.
        </p>
      )}
      <Field label="제목 (선택)">
        <TextField value={value.title} onChange={(v) => onChange({ ...value, title: v })} />
      </Field>
      <Field label="언어">
        <SelectField value={language} onChange={updateLanguage} options={SUPPORTED_LANGUAGES} />
      </Field>
      <Field label="높이 (px)">
        <NumberField
          value={value.height}
          onChange={(v) => onChange({ ...value, height: v })}
          min={60}
          max={800}
        />
      </Field>

      <Field label="기본 코드">
        <MonacoField
          value={plainCode}
          onChange={updatePlainCode}
          language={language === 'html' ? 'html' : language}
          height={240}
          onReady={(ed) => { editorRef.current = ed; }}
          disableAutoFormat
        />
      </Field>

      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleAddBlank}
          className="rounded bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-600"
        >
          선택 영역을 빈칸 처리
        </button>
        <button
          type="button"
          onClick={handleAddOption}
          className="rounded bg-slate-100 px-3 py-1.5 text-xs hover:bg-slate-200"
        >
          + 옵션 추가
        </button>
      </div>

      {hasInvalid && (
        <p className="mb-2 rounded bg-red-50 p-2 text-[11px] text-red-700">
          기본 코드가 변경되어 일부 빈칸 위치가 깨졌습니다. 깨진 빈칸을 제거하거나 코드를 원복하세요.
        </p>
      )}

      <Section title={`빈칸 (${verifiedBlanks.length})`} defaultOpen>
        {verifiedBlanks.length === 0 && (
          <p className="text-[11px] text-slate-400">기본 코드를 입력하고 텍스트를 드래그한 뒤 "빈칸 처리"를 누르세요.</p>
        )}
        {verifiedBlanks.map((b, i) => (
          <div
            key={i}
            className={
              'mb-1 flex items-center gap-2 rounded border px-2 py-1 text-xs ' +
              (b.invalid ? 'border-red-300 bg-red-50' : 'border-slate-200')
            }
          >
            <span className="w-12 shrink-0 text-slate-400">#{i}</span>
            <span className="flex-1 truncate font-mono text-slate-700">{b.correctAnswer || '(빈 텍스트)'}</span>
            {b.invalid && <span className="text-[10px] text-red-500">위치 깨짐</span>}
            <button
              type="button"
              onClick={() => handleRemoveBlank(i)}
              className="text-red-500 hover:underline"
            >
              제거
            </button>
          </div>
        ))}
      </Section>

      <Section title={`옵션 (${interactionOptions.length})`} defaultOpen>
        {interactionOptions.length === 0 && (
          <p className="text-[11px] text-slate-400">학습자가 선택할 보기 목록입니다. 빈칸을 만들면 정답 텍스트가 자동 추가됩니다.</p>
        )}
        {interactionOptions.map((o, i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <span className="w-5 text-xs text-slate-400">{i}.</span>
            <TextField value={o.value} onChange={(v) => handleUpdateOption(i, v)} />
            <button type="button" onClick={() => handleRemoveOption(i)} className="text-xs text-red-500">✕</button>
          </div>
        ))}
      </Section>

      <ResultModulesField
        value={value.result}
        onChange={(next) => onChange({ ...value, result: next })}
      />
    </>
  );
};

const PreviewView = ({ module }) => {
  const plainCode = module.plainCode || '';
  const language = module.language || 'html';
  const blanks = module.blanks || [];
  const height = module.height || 220;

  const html = useMemo(
    () => previewHtml(plainCode, language, blanks),
    [plainCode, language, blanks],
  );

  return (
    <div className="overflow-hidden rounded-2xl" style={{ background: '#0A0D14' }}>
      <div className="flex h-[30px] items-center px-4" style={{ gap: 6 }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#981B25' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#80460D' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#066042' }} />
      </div>
      <iframe
        title="code-fill-preview"
        srcDoc={html}
        sandbox="allow-same-origin"
        style={{
          width: '100%',
          height,
          border: 'none',
          background: '#0A0D14',
          display: 'block',
        }}
      />
    </div>
  );
};

export default {
  type: 'codeFillTheGapV2',
  category: 'quiz',
  label: '빈칸 채우기',
  description: '코드의 빈 칸 채우기 (Prism 토큰 + input 마커)',
  icon: '✏️',
  defaultValue: () => ({
    type: 'codeFillTheGapV2',
    language: 'html',
    plainCode: '',
    blanks: [],
    answers: [],
    interactionOptions: [],
    height: 220,
  }),
  FormView,
  PreviewView,
};
