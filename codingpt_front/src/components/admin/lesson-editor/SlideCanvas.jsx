import { useEffect, useRef } from 'react';
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
import { useEditor, selectSelectedSlide } from './state/EditorContext';
import { getModuleDefinition } from './modules/_registry';
import VisibilityBadge from './modules/_shared/VisibilityBadge';
import TriggerBadge from './modules/_shared/TriggerBadge';

const buildBackgroundStyle = (bg) => {
  if (!bg || !bg.colors) return { background: '#FFFFFF' };
  const angle = bg.angle ?? 180;
  const stops = bg.colors.map((c, i) => {
    const loc = bg.locations?.[i];
    return loc != null ? `${c} ${loc * 100}%` : c;
  });
  return { background: `linear-gradient(${angle}deg, ${stops.join(', ')})` };
};

// 좌측 외부 메타 칩 — id + 등장 시점. (simpleTerminal 의 연결 모듈 시각화는 모듈 상세 영역에서만.)
const LeftMetaBadges = ({ module, slideModules, onTriggerChange }) => (
  <div className="absolute right-full top-1 z-20 mr-6 flex flex-col items-end gap-1">
    <span
      className="whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-mono font-medium leading-none text-slate-500 shadow-sm"
      title="모듈 ID"
    >
      #{module.id}
    </span>
    <TriggerBadge module={module} onChange={onTriggerChange} slideModules={slideModules} />
  </div>
);

const SortableModule = ({ module, selected, onClick, onVisibilityChange, onModuleChange, onTriggerChange, slideModules, linkingMode, isFlashing }) => {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: module.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const def = getModuleDefinition(module.type);
  const PreviewView = def?.PreviewView;
  const cardRef = useRef(null);

  // flashing 시 부드럽게 스크롤 — 연결 모듈 ID 버튼 클릭에 대응.
  useEffect(() => {
    if (isFlashing && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFlashing]);

  // 연결 모드일 때 — 자기 자신이 source면 비활성, 연결 가능 타입(code/codeFillTheGapV2)이면 강조, 그 외는 흐릿.
  const isLinkingActive = !!linkingMode;
  const isLinkSource = isLinkingActive && String(linkingMode.sourceModuleId) === String(module.id);
  const isLinkable = isLinkingActive && !isLinkSource && (module.type === 'code' || module.type === 'codeFillTheGapV2');
  const isLinkDimmed = isLinkingActive && !isLinkSource && !isLinkable;

  const combinedRef = (el) => {
    setNodeRef(el);
    cardRef.current = el;
  };

  return (
    <div
      ref={combinedRef}
      style={style}
      className={
        'group relative rounded-lg border-2 transition-all ' +
        (isFlashing
          ? 'border-amber-500 ring-4 ring-amber-300 animate-pulse'
          : selected
            ? 'border-cyan-500 ring-2 ring-cyan-200'
            : isLinkable
              ? 'border-cyan-400 ring-2 ring-cyan-200 cursor-pointer'
              : 'border-transparent hover:border-cyan-300') +
        (isLinkDimmed ? ' opacity-40' : '')
      }
      onClick={onClick}
    >
      <div className="absolute -left-1 top-1 z-10 hidden gap-1 group-hover:flex">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab rounded bg-slate-700/80 px-1 text-[10px] text-white"
          title="드래그"
        >
          ⋮⋮
        </button>
      </div>
      <LeftMetaBadges module={module} slideModules={slideModules} onTriggerChange={onTriggerChange} />
      {!def?.hasItemVisibility && (
        <div className="absolute left-full top-1 z-20 ml-6">
          <VisibilityBadge value={module.visibility} onChange={onVisibilityChange} />
        </div>
      )}
      <div className="block w-full text-left">
        {PreviewView ? (
          <PreviewView module={module} onModuleChange={onModuleChange} />
        ) : (
          <div className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
            {module.type} (미리보기 없음)
          </div>
        )}
      </div>
    </div>
  );
};

const SlideCanvas = ({ onOpenPalette }) => {
  const { state, dispatch } = useEditor();
  const slide = selectSelectedSlide(state);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const linkingMode = state.ui?.linkingMode || null;
  const flashingModuleId = state.ui?.flashingModuleId ?? null;

  // ESC 로 연결 모드 취소
  useEffect(() => {
    if (!linkingMode) return;
    const handler = (e) => {
      if (e.key === 'Escape') dispatch({ type: 'exitLinkingMode' });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [linkingMode, dispatch]);

  if (!slide) {
    return (
      <div className="relative flex h-full flex-col">
        {onOpenPalette && (
          <button
            type="button"
            onClick={onOpenPalette}
            disabled
            className="absolute left-4 top-4 z-10 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm opacity-50"
          >
            + 모듈 추가
          </button>
        )}
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          슬라이드를 선택하세요
        </div>
      </div>
    );
  }

  const bg = slide.contents?.background;
  const modules = slide.contents?.modules || [];
  const slideTitle = slide.contents?.title;

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = modules.findIndex((m) => m.id === active.id);
    const to = modules.findIndex((m) => m.id === over.id);
    if (from < 0 || to < 0) return;
    dispatch({ type: 'reorderModules', slideId: slide.id, from, to });
  };

  // 연결 모드일 때: 연결 가능 타입(code/codeFillTheGapV2) 클릭 시 source 의 linkedModuleId 갱신.
  // 그 외 클릭은 기존 select 동작.
  const handleModuleClick = (m) => {
    if (linkingMode) {
      const isLinkable = (m.type === 'code' || m.type === 'codeFillTheGapV2')
        && String(m.id) !== String(linkingMode.sourceModuleId);
      if (isLinkable) {
        dispatch({
          type: 'updateModule',
          slideId: slide.id,
          moduleId: linkingMode.sourceModuleId,
          patch: { linkedModuleId: m.id, cachedResult: undefined, cachedResults: undefined },
        });
        dispatch({ type: 'exitLinkingMode' });
        return;
      }
      // 연결 불가 모듈 클릭은 무시 (모드 유지)
      return;
    }
    dispatch({ type: 'select', slideId: slide.id, moduleId: m.id });
  };

  return (
    <div className="relative flex h-full flex-col items-center justify-start gap-3 overflow-y-auto p-6">
      {onOpenPalette && (
        <button
          type="button"
          onClick={onOpenPalette}
          className="absolute left-4 top-4 z-10 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-cyan-600"
        >
          + 모듈 추가
        </button>
      )}

      {linkingMode && (
        <div className="sticky top-0 z-30 mb-2 flex w-full max-w-[420px] items-center justify-between gap-2 rounded-md border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-[12px] text-cyan-800 shadow-sm">
          <span>
            🔗 #{linkingMode.sourceModuleId} 의 연결 모듈 선택 중 — code 또는 빈칸 채우기 모듈을 클릭하세요.
            <span className="ml-1 text-cyan-600/70">(ESC 로 취소)</span>
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: 'exitLinkingMode' })}
            className="rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-100"
          >
            취소
          </button>
        </div>
      )}

      <div className="text-xs text-slate-500">
        {slideTitle && (
          <>
            <span className="font-medium text-slate-700">{slideTitle}</span>
            <span className="mx-1">·</span>
          </>
        )}
        슬라이드 #{slide.id} · {modules.length}개 모듈
      </div>
      <div
        className="flex min-h-[640px] w-[375px] shrink-0 flex-col gap-[60px] rounded-2xl border border-slate-300 p-4 shadow-sm"
        style={buildBackgroundStyle(bg)}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            if (linkingMode) {
              dispatch({ type: 'exitLinkingMode' });
              return;
            }
            dispatch({ type: 'select', slideId: slide.id, moduleId: null });
          }
        }}
      >
        {modules.length === 0 && (
          <div className="m-auto rounded-lg border border-dashed border-slate-400 bg-white/60 px-4 py-3 text-center text-xs text-slate-500">
            왼쪽 팔레트에서 모듈을 추가하세요
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={modules.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            {modules.map((m) => (
              <SortableModule
                key={m.id}
                module={m}
                selected={state.selection.moduleId === m.id}
                slideModules={modules}
                linkingMode={linkingMode}
                isFlashing={flashingModuleId != null && String(flashingModuleId) === String(m.id)}
                onClick={() => handleModuleClick(m)}
                onVisibilityChange={(v) => dispatch({
                  type: 'updateModule',
                  slideId: slide.id,
                  moduleId: m.id,
                  patch: { visibility: v },
                })}
                onTriggerChange={(next) => {
                  const { id, ...patch } = next;
                  dispatch({
                    type: 'updateModule',
                    slideId: slide.id,
                    moduleId: m.id,
                    patch,
                  });
                }}
                onModuleChange={(next) => {
                  // PreviewView 내부에서 모듈 객체 자체를 갱신할 때 사용 (말풍선/항목별 가시성 등).
                  // id 는 유지하기 위해 patch 형태로 전달.
                  const { id, ...patch } = next;
                  dispatch({
                    type: 'updateModule',
                    slideId: slide.id,
                    moduleId: m.id,
                    patch,
                  });
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
};

export default SlideCanvas;
