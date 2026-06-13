import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DotsSixVertical, Trash } from '@phosphor-icons/react';
import { useEditor, selectSelectedSlide } from '../state/EditorContext';
import { Field, TextField, NumberField, SelectField } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';
import IdeIntegrationField from './_shared/IdeIntegrationField';
import IdeOpenBadge from './_shared/IdeOpenBadge';
import {
  SUPPORTED_LANGUAGES,
  composeContent,
  decomposeContent,
  reorderBlanks,
  previewHtml,
  validateBlanks,
} from './_shared/codeFillUtils';
import { fetchCodeFillContent, upsertCodeFillContent } from '../../../../utils/lessonApi';
// 채점 후 등장 모듈은 슬라이드 평면 modules 에 두고 각 모듈의 trigger.afterGrading 메타로 연결한다.
// 옵션 조합 캐싱은 simpleTerminal 모듈에서 linkedModuleId 로 이 빈칸채우기를 지정하면 자동 처리.

const DEBOUNCE_MS = 1000;

// 빈칸과 옵션을 연결하기 위한 안정 키 (reorderBlanks 가 id 를 재부여해도 보존됨)
const makeBlankKey = () => `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
// 옵션 DnD 식별자
const makeOptionId = () => `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 슬라이드 목록(SlideList) 의 호버 노출 + 드래그 핸들 UX 미러:
//   · 평소엔 텍스트만 노출, 호버 시 좌측 드래그 핸들 + 우측 ✕ 버튼이 페이드인
//   · 핸들을 잡고 위/아래로 끌어 순서 변경 (PointerSensor 4px 활성)
const SortableOptionItem = ({ option, index, link, onUpdate, onRemove }) => {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: option._id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const linkedBlank = link?.fromBlank;
  const isLocked = !!linkedBlank;
  const isInvalid = isLocked && linkedBlank.invalid;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        'group relative flex items-center gap-2 rounded border pl-5 pr-1 py-1 ' +
        (isInvalid ? 'border-red-300 bg-red-50' : 'border-slate-200 hover:bg-slate-50')
      }
    >
      {/* 좌측 드래그 핸들 — 호버 시 노출 */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 top-1/2 -translate-y-1/2 cursor-grab rounded bg-white/80 px-0.5 text-slate-300 opacity-0 transition hover:text-slate-500 group-hover:opacity-100"
        aria-label="드래그"
        title="드래그해서 순서 변경"
      >
        <DotsSixVertical weight="bold" className="h-4 w-4" />
      </button>

      <span className="w-5 shrink-0 text-xs text-slate-400">{index}.</span>

      {isLocked ? (
        <>
          <span
            className="flex-1 truncate rounded bg-red-50 px-2 py-1 font-mono text-xs text-red-700 border border-red-200"
            title="빈칸으로 만든 옵션이라 수정할 수 없습니다. 제거 시 빈칸도 함께 삭제됩니다."
          >
            🔒 {option.value || '(빈 텍스트)'}
          </span>
          {isInvalid && <span className="text-[10px] text-red-500">위치 깨짐</span>}
        </>
      ) : (
        <div className="flex-1">
          <TextField value={option.value} onChange={onUpdate} />
        </div>
      )}

      {/* 우측 액션 — 호버 시 노출 */}
      <div className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
          aria-label="삭제"
          title={isLocked ? '옵션과 연결된 빈칸을 함께 제거' : '옵션 제거'}
        >
          <Trash weight="bold" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

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

  // 레거시 데이터 1회성 마이그레이션 — blank 에 _key, option 에 fromBlankKey(null|string)+_id 부여.
  // 마이그레이션 이후 옵션의 fromBlankKey 는 항상 명시적 (null = 자유 옵션, string = 빈칸 연결).
  const linkMigratedRef = useRef(false);
  useEffect(() => {
    if (linkMigratedRef.current) return;
    if (blanks.length === 0 && interactionOptions.length === 0) return;
    linkMigratedRef.current = true;

    const nextBlanks = blanks.map((b) => (b._key ? b : { ...b, _key: makeBlankKey() }));
    const usedKeys = new Set();
    interactionOptions.forEach((o) => { if (o.fromBlankKey) usedKeys.add(o.fromBlankKey); });
    const nextOptions = interactionOptions.map((o) => {
      let next = o;
      if (next._id === undefined) next = { ...next, _id: makeOptionId() };
      if (next.fromBlankKey === undefined) {
        const match = nextBlanks.find((b) => !usedKeys.has(b._key) && b.correctAnswer === next.value);
        if (match) {
          usedKeys.add(match._key);
          next = { ...next, fromBlankKey: match._key };
        } else {
          next = { ...next, fromBlankKey: null };
        }
      }
      return next;
    });
    const blanksChanged = nextBlanks.some((b, i) => b._key !== blanks[i]?._key);
    const optionsChanged = nextOptions.some((o, i) => (
      o.fromBlankKey !== interactionOptions[i]?.fromBlankKey || o._id !== interactionOptions[i]?._id
    ));
    if (blanksChanged || optionsChanged) {
      onChange({ ...valueRef.current, blanks: nextBlanks, interactionOptions: nextOptions });
    }
  }, [blanks, interactionOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // DnD 용 _id 가 아직 없는 옵션(레거시 첫 렌더) 을 위한 즉시 합성 — 마이그레이션 effect 가
  // 실제 상태에 _id 를 영구 반영하기 전이라도 SortableContext 가 정상 동작.
  const optionsWithIds = useMemo(() => (
    interactionOptions.map((o) => (o._id ? o : { ...o, _id: makeOptionId() }))
  ), [interactionOptions]);

  // 옵션 ↔ 빈칸 연결 계산 (마이그레이션 후 fromBlankKey 만 신뢰)
  const optionLinks = useMemo(() => {
    const blankByKey = new Map();
    verifiedBlanks.forEach((b) => { if (b._key) blankByKey.set(b._key, b); });
    return optionsWithIds.map((o) => {
      if (o.fromBlankKey && blankByKey.has(o.fromBlankKey)) {
        return { fromBlank: blankByKey.get(o.fromBlankKey) };
      }
      return { fromBlank: null };
    });
  }, [optionsWithIds, verifiedBlanks]);

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

    const blankKey = makeBlankKey();
    const newBlank = { start, end, correctAnswer: text, _key: blankKey };
    const nextBlanksRaw = [...blanks, newBlank];
    const nextAnswersRaw = [
      ...answers,
      { userAnswer: null, correctAnswer: text, isCorrect: null },
    ];
    const { blanks: sortedBlanks, answers: sortedAnswers } = reorderBlanks(nextBlanksRaw, nextAnswersRaw);

    // 옵션은 항상 추가 — 같은 정답의 빈칸이 여러 개여도 옵션도 그 수만큼 필요
    const nextOptions = [
      ...interactionOptions,
      { _id: makeOptionId(), value: text, fromBlankKey: blankKey },
    ];

    onChange({
      ...value,
      blanks: sortedBlanks,
      answers: sortedAnswers,
      interactionOptions: nextOptions,
    });
  };

  const handleAddOption = () => {
    // 명시적 null = 자유 옵션 (마이그레이션 fallback 에서 빈칸과 자동 연결되지 않도록)
    onChange({
      ...value,
      interactionOptions: [
        ...interactionOptions,
        { _id: makeOptionId(), value: '', fromBlankKey: null },
      ],
    });
  };

  const handleUpdateOption = (i, v) => {
    onChange({
      ...value,
      interactionOptions: interactionOptions.map((o, idx) => (idx === i ? { ...o, value: v } : o)),
    });
  };

  const handleRemoveOption = (i) => {
    const link = optionLinks[i];
    const nextOptions = interactionOptions.filter((_, idx) => idx !== i);
    let nextPatch = { interactionOptions: nextOptions };

    // 빈칸 연결 옵션이면 빈칸도 같이 제거
    if (link?.fromBlank) {
      const target = link.fromBlank;
      const blankIdx = blanks.findIndex((b) => (
        b._key
          ? b._key === target._key
          : b.start === target.start && b.end === target.end && b.correctAnswer === target.correctAnswer
      ));
      if (blankIdx >= 0) {
        const nextBlanksRaw = blanks.filter((_, j) => j !== blankIdx);
        const nextAnswersRaw = answers.filter((_, j) => j !== blankIdx);
        const reordered = reorderBlanks(nextBlanksRaw, nextAnswersRaw);
        nextPatch.blanks = reordered.blanks;
        nextPatch.answers = reordered.answers;
      }
    }
    onChange({ ...value, ...nextPatch });
  };

  const handleReorderOptions = (fromId, toId) => {
    if (fromId === toId) return;
    // 마이그레이션 전이라도 정상 동작하도록 optionsWithIds 기준으로 위치 계산
    const from = optionsWithIds.findIndex((o) => o._id === fromId);
    const to = optionsWithIds.findIndex((o) => o._id === toId);
    if (from < 0 || to < 0) return;
    const next = [...optionsWithIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ ...value, interactionOptions: next });
  };

  // DnD 센서 — 슬라이드 목록과 동일하게 4px 이동 이상에서 활성 (텍스트 클릭과 충돌 방지)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

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

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-600">기본 코드</span>
          <button
            type="button"
            onClick={handleAddBlank}
            className="rounded bg-cyan-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-cyan-600"
          >
            선택 영역을 빈칸 처리
          </button>
        </div>
        <MonacoField
          value={plainCode}
          onChange={updatePlainCode}
          language={language === 'html' ? 'html' : language}
          height={240}
          onReady={(ed) => { editorRef.current = ed; }}
          disableAutoFormat
        />
      </div>

      {hasInvalid && (
        <p className="mb-2 rounded bg-red-50 p-2 text-[11px] text-red-700">
          기본 코드가 변경되어 일부 빈칸 위치가 깨졌습니다. 깨진 옵션(자물쇠 표시) 을 제거하거나 코드를 원복하세요.
        </p>
      )}

      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            옵션 ({interactionOptions.length})
          </span>
          <button
            type="button"
            onClick={handleAddOption}
            className="rounded bg-slate-100 px-2.5 py-1 text-[11px] hover:bg-slate-200"
          >
            + 옵션 추가
          </button>
        </div>

        {interactionOptions.length === 0 ? (
          <p className="text-[11px] text-slate-400">
            텍스트를 드래그한 뒤 "선택 영역을 빈칸 처리" 또는 "+ 옵션 추가" 로 보기를 만드세요. 빈칸 처리로 만든 옵션은 자물쇠로 표시되며 텍스트 수정이 막힙니다(제거 시 빈칸도 같이 삭제됩니다).
          </p>
        ) : (
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              const { active, over } = event;
              if (!over) return;
              handleReorderOptions(active.id, over.id);
            }}
          >
            <SortableContext
              items={optionsWithIds.map((o) => o._id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-1">
                {optionsWithIds.map((o, i) => (
                  <SortableOptionItem
                    key={o._id}
                    option={o}
                    index={i}
                    link={optionLinks[i]}
                    onUpdate={(v) => handleUpdateOption(i, v)}
                    onRemove={() => handleRemoveOption(i)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <p className="rounded border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-500">
        채점 후 등장할 모듈은 슬라이드 모듈 카드에서 직접 추가한 뒤 각 카드의 "등장 시점" 셀렉트에서
        이 빈칸 채우기 모듈을 선택하세요. 코드 실행 결과는 simpleTerminal 의 연결 모듈로 본 빈칸 채우기를 지정하면 됩니다.
      </p>

      <IdeIntegrationField value={value.ide} onChange={(ide) => onChange({ ...value, ide })} />
    </>
  );
};

// RN CodeFillTheGapV2.tsx 의 FillGapOptionButton 외형을 그대로 미러:
// 활성 #E02D3C / 흰 글씨, 비활성 #F1F3F9 / #F1F3F9 글씨, 14/700, 30 min-width, 12/8 padding, 8 round.
const FillGapOptionButtonPreview = ({ option }) => {
  const isDisabled = !!option?.disabled;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 30,
        padding: '8px 12px',
        borderRadius: 8,
        background: isDisabled ? '#F1F3F9' : '#E02D3C',
        color: isDisabled ? '#F1F3F9' : '#FFFFFF',
        fontSize: 14,
        fontWeight: 700,
        lineHeight: '1.2',
      }}
    >
      {option?.value ?? ''}
    </div>
  );
};

const PreviewView = ({ module, onModuleChange }) => {
  const plainCode = module.plainCode || '';
  const language = module.language || 'html';
  const blanks = module.blanks || [];
  const height = module.height || 220;
  const interactionOptions = module.interactionOptions || [];

  const html = useMemo(
    () => previewHtml(plainCode, language, blanks),
    [plainCode, language, blanks],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl" style={{ background: '#0A0D14' }}>
        <div className="flex h-[30px] items-center px-4" style={{ gap: 6 }}>
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#981B25' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#80460D' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#066042' }} />
          <IdeOpenBadge module={module} />
        </div>
        <iframe
          title="code-fill-preview"
          srcDoc={html}
          sandbox="allow-scripts allow-same-origin"
          style={{
            width: '100%',
            height,
            border: 'none',
            background: '#0A0D14',
            display: 'block',
          }}
        />
      </div>

      {interactionOptions.length > 0 && (
        <div className="px-[10px] py-[8px]">
          <div className="flex flex-row flex-wrap items-center justify-center" style={{ gap: 12 }}>
            {interactionOptions.map((o, i) => (
              <FillGapOptionButtonPreview key={i} option={o} />
            ))}
          </div>
        </div>
      )}

    </div>
  );
};

export default {
  type: 'codeFillTheGapV2',
  category: 'quiz',
  label: '빈칸 채우기',
  description: '코드의 빈 칸 채우기 (Prism 토큰 + input 마커)',
  icon: '',
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
