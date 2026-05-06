import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { DotsSixVertical, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import * as api from '../../../utils/lessonApi';
import { useEditor } from './state/EditorContext';
import TypeBadgePopover from './TypeBadgePopover';

const SortableSlideItem = ({ slide, index, selected, editing, onSelect, onDelete, onEnterEdit }) => {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: slide.id });
  const { state, dispatch } = useEditor();
  const titleRef = useRef(null);

  const pendingFocus = state.ui.pendingFocus;
  const autoOpenType = pendingFocus?.slideId === slide.id && pendingFocus?.stage === 'type';
  const focusTitle = pendingFocus?.slideId === slide.id && pendingFocus?.stage === 'title';

  // 수정 모드 진입 시 textarea 포커스
  useEffect(() => {
    if (editing && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [editing]);

  // 신규 슬라이드 추가 후 타입 고르면 제목으로 포커스 이동
  useEffect(() => {
    if (focusTitle && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
      dispatch({ type: 'setPendingFocus', payload: null });
    }
  }, [focusTitle, dispatch]);

  // textarea auto-resize
  useLayoutEffect(() => {
    if (editing && titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [editing, slide.contents?.title]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleTitleChange = (e) => {
    dispatch({
      type: 'updateSlideContents',
      slideId: slide.id,
      update: { title: e.target.value },
    });
  };

  const handleTypePicked = () => {
    dispatch({ type: 'setPendingFocus', payload: { slideId: slide.id, stage: 'title' } });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={
        'group relative flex items-start gap-1.5 rounded-lg border px-1.5 py-1.5 ' +
        (selected
          ? 'border-cyan-500 bg-cyan-50'
          : 'border-slate-200 hover:bg-slate-50')
      }
    >
      <span className="mt-1 w-5 shrink-0 text-xs text-slate-400">{index + 1}</span>
      <div onClick={(e) => editing && e.stopPropagation()} className="shrink-0">
        <TypeBadgePopover
          slide={slide}
          autoOpen={autoOpenType}
          onTypePicked={handleTypePicked}
          enabled={editing}
        />
      </div>
      {editing ? (
        <textarea
          ref={titleRef}
          rows={1}
          value={slide.contents?.title || ''}
          placeholder="(제목 없음)"
          onChange={handleTitleChange}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 resize-none overflow-hidden rounded border border-cyan-500 bg-white px-1 py-0.5 text-sm leading-snug text-slate-700 focus:outline-none"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-pointer whitespace-pre-wrap break-words rounded px-1 py-0.5 text-sm leading-snug text-slate-700"
        >
          {slide.contents?.title || <span className="text-slate-400">(제목 없음)</span>}
        </div>
      )}

      {/* 호버 시에만 보이는 액션들 — absolute 처리해서 평소엔 제목 영역이 100% 폭 사용 */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="absolute left-0 top-1 cursor-grab rounded bg-white/80 px-0.5 text-slate-300 opacity-0 transition hover:text-slate-500 group-hover:opacity-100"
        aria-label="드래그"
      >
        <DotsSixVertical weight="bold" className="h-4 w-4" />
      </button>
      <div className="absolute right-1 top-1 flex gap-0.5 rounded bg-white/80 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEnterEdit(); }}
          className="rounded p-0.5 text-slate-400 hover:bg-cyan-50 hover:text-cyan-600"
          aria-label="수정"
          title="수정"
        >
          <PencilSimple weight="bold" className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
          aria-label="삭제"
        >
          <Trash weight="bold" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export const SlideListHeader = ({ lessonId }) => {
  const { state, dispatch } = useEditor();
  const [adding, setAdding] = useState(false);
  const count = state.lesson?.slides?.length || 0;

  const handleAdd = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const slide = await api.addSlide(lessonId, { role: 'custom' });
      dispatch({ type: 'addSlide', slide });
      dispatch({ type: 'setEditingSlide', slideId: slide.id });
      dispatch({ type: 'setPendingFocus', payload: { slideId: slide.id, stage: 'type' } });
    } catch (e) {
      alert(`슬라이드 추가 실패: ${e.message}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        슬라이드 ({count})
      </p>
      <button
        type="button"
        onClick={handleAdd}
        disabled={adding}
        title="슬라이드 추가"
        className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
      >
        <Plus weight="bold" className="h-4 w-4" />
      </button>
    </div>
  );
};

export const SlideListBody = () => {
  const { state, dispatch } = useEditor();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const containerRef = useRef(null);

  // 외부 클릭/Esc로 수정 모드 해제
  useEffect(() => {
    const editingId = state.ui.editingSlideId;
    if (!editingId) return;
    const handleMouseDown = (e) => {
      if (containerRef.current?.contains(e.target)) return;
      dispatch({ type: 'setEditingSlide', slideId: null });
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') dispatch({ type: 'setEditingSlide', slideId: null });
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [state.ui.editingSlideId, dispatch]);

  if (!state.lesson) return null;
  const slides = state.lesson.slides;
  const selectedId = state.selection.slideId;
  const editingId = state.ui.editingSlideId;
  const lessonId = state.lesson.id;

  const handleDelete = async (slideId) => {
    if (!confirm('이 슬라이드를 삭제할까요?')) return;
    try {
      await api.deleteSlide(lessonId, slideId);
      dispatch({ type: 'removeSlide', slideId });
    } catch (e) {
      alert(`삭제 실패: ${e.message}`);
    }
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = slides.findIndex((s) => s.id === active.id);
    const to = slides.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    dispatch({ type: 'reorderSlides', from, to });
  };

  if (slides.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-slate-400">
        상단의 + 버튼으로 슬라이드를 추가하세요
      </div>
    );
  }

  return (
    <div ref={containerRef} className="px-3 py-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={slides.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {slides.map((slide, idx) => (
              <SortableSlideItem
                key={slide.id}
                slide={slide}
                index={idx}
                selected={slide.id === selectedId}
                editing={slide.id === editingId}
                onSelect={() => dispatch({ type: 'select', slideId: slide.id })}
                onEnterEdit={() => {
                  dispatch({ type: 'select', slideId: slide.id });
                  dispatch({ type: 'setEditingSlide', slideId: slide.id });
                }}
                onDelete={() => handleDelete(slide.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
};

const SlideList = ({ lessonId }) => (
  <>
    <SlideListHeader lessonId={lessonId} />
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SlideListBody />
    </div>
  </>
);

export default SlideList;
