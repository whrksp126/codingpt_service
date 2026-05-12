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

const buildBackgroundStyle = (bg) => {
  if (!bg || !bg.colors) return { background: '#FFFFFF' };
  const angle = bg.angle ?? 180;
  const stops = bg.colors.map((c, i) => {
    const loc = bg.locations?.[i];
    return loc != null ? `${c} ${loc * 100}%` : c;
  });
  return { background: `linear-gradient(${angle}deg, ${stops.join(', ')})` };
};

const SortableModule = ({ module, selected, onClick, onVisibilityChange, onModuleChange }) => {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        'group relative rounded-lg border-2 transition-all ' +
        (selected
          ? 'border-cyan-500 ring-2 ring-cyan-200'
          : 'border-transparent hover:border-cyan-300')
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
        className="flex min-h-[640px] w-[375px] flex-col gap-2 rounded-2xl border border-slate-300 p-4 shadow-sm"
        style={buildBackgroundStyle(bg)}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
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
                onClick={() => dispatch({ type: 'select', slideId: slide.id, moduleId: m.id })}
                onVisibilityChange={(v) => dispatch({
                  type: 'updateModule',
                  slideId: slide.id,
                  moduleId: m.id,
                  patch: { visibility: v },
                })}
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
