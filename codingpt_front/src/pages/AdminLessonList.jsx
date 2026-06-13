import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CaretDown,
  CaretRight,
  CaretUp,
  GearSix,
  Plus,
  DotsSixVertical,
} from '@phosphor-icons/react';
import * as content from '../utils/contentApi';
import * as lessonApi from '../utils/lessonApi';
import { formatRelativeTime } from '../utils/relativeTime';
import ProductModal from '../components/admin/content/ProductModal';
import SimpleEditModal from '../components/admin/content/SimpleEditModal';
import { Switch } from '../components/admin/lesson-editor/modules/_shared/SharedFields';

// ============================================================================
// 디자인 토큰
// ============================================================================
const TYPE_STYLES = {
  product: {
    label: '상품',
    badge: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    summary: 'bg-violet-100 text-violet-700',
    accent: 'border-l-violet-300',
  },
  class: {
    label: '클래스',
    badge: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    summary: 'bg-blue-100 text-blue-700',
    accent: 'border-l-blue-300',
  },
  section: {
    label: '섹션',
    badge: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    summary: 'bg-amber-100 text-amber-700',
    accent: 'border-l-amber-300',
  },
  lesson: {
    label: '레슨',
    badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    summary: 'bg-emerald-100 text-emerald-700',
    accent: 'border-l-emerald-300',
  },
};

// ============================================================================
// 메인 페이지
// ============================================================================
const AdminLessonList = () => {
  const navigate = useNavigate();
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [modal, setModal] = useState(null);
  const [hideInactive, setHideInactive] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await content.getTree();
      setTree(data);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setExpanded((s) => ({ ...s, [key]: !s[key] }));

  const setAllExpanded = (value) => {
    if (!tree) return;
    const next = {};
    for (const p of tree.products) {
      next[`prod-${p.id}`] = value;
      for (const c of p.Classes || []) {
        next[`cls-${c.id}`] = value;
        for (const s of c.Sections || []) {
          next[`sec-${s.id}`] = value;
        }
      }
    }
    setExpanded(next);
  };

  const wrap = async (fn) => {
    try {
      await fn();
      await load();
    } catch (e) {
      alert(e.message);
    }
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // ---- create handlers ----
  const promptCreateClass = (productId) => {
    setModal({
      type: 'simple',
      title: '새 클래스',
      showDescription: true,
      onSave: async ({ name, description }) =>
        wrap(async () => {
          const newCls = await content.createClass({ name, description: description || name });
          await content.linkProductClass(productId, newCls.id);
        }),
    });
  };
  const promptCreateSection = (classId) => {
    setModal({
      type: 'simple',
      title: '새 섹션',
      onSave: async ({ name }) =>
        wrap(async () => {
          const newSec = await content.createSection({ name });
          await content.linkClassSection(classId, newSec.id);
        }),
    });
  };
  const promptCreateLesson = (sectionId) => {
    setModal({
      type: 'simple',
      title: '새 레슨',
      onSave: async ({ name }) => {
        try {
          const newLesson = await lessonApi.createLesson({ name });
          await content.linkSectionLesson(sectionId, newLesson.id);
          setModal(null);
          navigate(`/admin/lessons/${newLesson.id}/edit`);
        } catch (e) {
          alert(e.message);
        }
      },
    });
  };

  // ---- edit handlers ----
  const openEditProduct = (product) => {
    setModal({
      type: 'product',
      product,
      onSave: async (data) => wrap(() => content.updateProduct(product.id, data)),
    });
  };
  const openEditClass = (cls) => {
    setModal({
      type: 'simple',
      title: '클래스 수정',
      initialName: cls.name,
      initialDescription: cls.description,
      showDescription: true,
      onSave: async (data) => wrap(() => content.updateClass(cls.id, data)),
      onDelete: async () => wrap(() => content.deleteClass(cls.id)),
    });
  };
  const openEditSection = (sec) => {
    setModal({
      type: 'simple',
      title: '섹션 수정',
      initialName: sec.name,
      onSave: async (data) => wrap(() => content.updateSection(sec.id, data)),
      onDelete: async () => wrap(() => content.deleteSection(sec.id)),
    });
  };

  // ---- reorder handlers ----
  const onDragEndClasses = (productId, classes) => (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = classes.findIndex((c) => c.id === active.id);
    const newIndex = classes.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(classes, oldIndex, newIndex);
    setTree((t) => {
      const next = structuredClone(t);
      const p = next.products.find((x) => x.id === productId);
      if (p) p.Classes = reordered;
      return next;
    });
    content
      .reorderClassesInProduct(productId, reordered.map((c) => c.id))
      .catch((e) => { alert(e.message); load(); });
  };

  const onClassLevelDragEnd = (cls) => (event) => {
    const { active, over } = event;
    if (!over) return;

    const sections = cls.Sections || [];
    const sectionIds = sections.map((s) => s.id);

    if (sectionIds.includes(active.id)) {
      if (!sectionIds.includes(over.id) || active.id === over.id) return;
      const oldIdx = sectionIds.indexOf(active.id);
      const newIdx = sectionIds.indexOf(over.id);
      const reordered = arrayMove(sections, oldIdx, newIdx);
      setTree((t) => {
        const next = structuredClone(t);
        for (const p of next.products) {
          for (const c of p.Classes || []) {
            if (c.id === cls.id) c.Sections = reordered;
          }
        }
        return next;
      });
      content
        .reorderSectionsInClass(cls.id, reordered.map((s) => s.id))
        .catch((e) => { alert(e.message); load(); });
      return;
    }

    const findLessonSection = (lessonId) => {
      for (const s of sections) {
        if ((s.Lessons || []).some((l) => l.id === lessonId)) return s.id;
      }
      return null;
    };
    const fromSectionId = findLessonSection(active.id);
    if (!fromSectionId) return;

    let toSectionId;
    let dropAtEnd = false;
    if (typeof over.id === 'string' && over.id.startsWith('lesson-drop-')) {
      toSectionId = Number(over.id.replace('lesson-drop-', ''));
      dropAtEnd = true;
    } else {
      toSectionId = findLessonSection(over.id);
    }
    if (!toSectionId) return;

    const fromLessons = sections.find((s) => s.id === fromSectionId)?.Lessons || [];
    const toLessons = sections.find((s) => s.id === toSectionId)?.Lessons || [];
    const lesson = fromLessons.find((l) => l.id === active.id);
    if (!lesson) return;

    if (fromSectionId === toSectionId) {
      const oldIdx = fromLessons.findIndex((l) => l.id === active.id);
      const newIdx = dropAtEnd
        ? fromLessons.length - 1
        : fromLessons.findIndex((l) => l.id === over.id);
      if (oldIdx === newIdx || newIdx < 0) return;
      const reordered = arrayMove(fromLessons, oldIdx, newIdx);
      setTree((t) => {
        const next = structuredClone(t);
        for (const p of next.products) {
          for (const c of p.Classes || []) {
            for (const s of c.Sections || []) {
              if (s.id === fromSectionId) s.Lessons = reordered;
            }
          }
        }
        return next;
      });
      content
        .reorderLessonsInSection(fromSectionId, reordered.map((l) => l.id))
        .catch((e) => { alert(e.message); load(); });
      return;
    }

    const newFromLessons = fromLessons.filter((l) => l.id !== active.id);
    const insertAt = dropAtEnd
      ? toLessons.length
      : Math.max(0, toLessons.findIndex((l) => l.id === over.id));
    const newToLessons = [...toLessons];
    newToLessons.splice(insertAt, 0, lesson);

    setTree((t) => {
      const next = structuredClone(t);
      for (const p of next.products) {
        for (const c of p.Classes || []) {
          for (const s of c.Sections || []) {
            if (s.id === fromSectionId) s.Lessons = newFromLessons;
            if (s.id === toSectionId) s.Lessons = newToLessons;
          }
        }
      }
      return next;
    });

    (async () => {
      try {
        await content.unlinkSectionLesson(fromSectionId, lesson.id);
        await content.linkSectionLesson(toSectionId, lesson.id);
        await content.reorderLessonsInSection(toSectionId, newToLessons.map((l) => l.id));
        if (newFromLessons.length > 0) {
          await content.reorderLessonsInSection(fromSectionId, newFromLessons.map((l) => l.id));
        }
      } catch (e) {
        alert(e.message);
        load();
      }
    })();
  };

  const visibleProducts = useMemo(() => {
    if (!tree) return [];
    return tree.products.filter((p) => !hideInactive || p.is_active);
  }, [tree, hideInactive]);

  // 상품 유형/카테고리 콤보박스 옵션 — 기존 상품들의 distinct 값 + 시드(합집합).
  // 새로 입력·저장한 값은 다음 로드 시 distinct 에 포함되어 자동으로 프리셋이 된다.
  const productFieldOptions = useMemo(() => {
    const types = new Set(['클래스']);
    const categories = new Set(['HTML', 'CSS', 'JS']);
    for (const p of tree?.products || []) {
      if (p.type) types.add(p.type);
      if (p.category) categories.add(p.category);
    }
    return { typeOptions: [...types], categoryOptions: [...categories] };
  }, [tree]);

  // 펼치기/접기 단일 토글용 — 펼쳐진 상품이 하나라도 있으면 "접기" 상태로 본다.
  const anyExpanded = useMemo(
    () => (tree?.products || []).some((p) => expanded[`prod-${p.id}`]),
    [tree, expanded],
  );

  const totalCounts = useMemo(() => {
    if (!tree) return null;
    return {
      products: visibleProducts.length,
      classes: visibleProducts.reduce((s, p) => s + (p.Classes || []).length, 0),
      sections: visibleProducts.reduce(
        (s, p) => s + (p.Classes || []).reduce((ss, c) => ss + (c.Sections || []).length, 0),
        0,
      ),
      lessons: visibleProducts.reduce(
        (s, p) =>
          s +
          (p.Classes || []).reduce(
            (ss, c) =>
              ss + (c.Sections || []).reduce((sss, sec) => sss + (sec.Lessons || []).length, 0),
            0,
          ),
        0,
      ),
    };
  }, [tree, visibleProducts]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="mb-1 flex items-center justify-between">
            <div>
              <Link to="/" className="text-xs text-slate-500 hover:text-slate-900">← 홈</Link>
              <h1 className="mt-1 text-xl font-bold text-slate-900">콘텐츠 관리</h1>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/admin/github-repos"
                className="rounded-md border border-slate-800 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-900"
              >
                GitHub 레포 관리
              </Link>
              <button
                type="button"
                onClick={() =>
                  setModal({
                    type: 'product',
                    product: null,
                    onSave: async (data) => wrap(() => content.createProduct(data)),
                  })
                }
                className="ml-1 inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-cyan-600"
              >
                <Plus size={14} weight="bold" /> 새 상품
              </button>
            </div>
          </div>

          {totalCounts && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <SummaryChip type="product" count={totalCounts.products} />
              <SummaryChip type="class" count={totalCounts.classes} />
              <SummaryChip type="section" count={totalCounts.sections} />
              <SummaryChip type="lesson" count={totalCounts.lessons} />
              <button
                type="button"
                onClick={() => setAllExpanded(!anyExpanded)}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                {anyExpanded ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
                {anyExpanded ? '전체 접기' : '전체 펼치기'}
              </button>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                <span>비활성 상품 숨김</span>
                <Switch checked={hideInactive} onChange={setHideInactive} />
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-6xl p-6">
        {error && (
          <div className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-3">
          {!tree && (
            <div className="rounded-xl bg-white p-10 text-center text-slate-400 shadow-sm">불러오는 중…</div>
          )}
          {tree && tree.products.length === 0 && (
            <EmptyHero
              title="아직 상품이 없습니다"
              hint="상품 → 클래스 → 섹션 → 레슨 순서로 만들어보세요"
              actionLabel="새 상품 만들기"
              onAction={() =>
                setModal({
                  type: 'product',
                  product: null,
                  onSave: async (data) => wrap(() => content.createProduct(data)),
                })
              }
            />
          )}
          {tree && tree.products.length > 0 && visibleProducts.length === 0 && (
            <div className="rounded-xl bg-white p-10 text-center text-sm text-slate-400 shadow-sm">
              비활성 상품만 있습니다. "비활성 상품 숨김"을 끄면 보입니다.
            </div>
          )}
          {tree && visibleProducts.length > 0 && (
            <DndContext sensors={sensors} collisionDetection={closestCenter}>
              <div className="space-y-3">
                {visibleProducts.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    expanded={expanded}
                    toggle={toggle}
                    sensors={sensors}
                    onEditProduct={openEditProduct}
                    onEditClass={openEditClass}
                    onEditSection={openEditSection}
                    onCreateClass={promptCreateClass}
                    onCreateSection={promptCreateSection}
                    onCreateLesson={promptCreateLesson}
                    onNavigateToLesson={(id) => navigate(`/admin/lessons/${id}/edit`)}
                    onDragEndClasses={onDragEndClasses}
                    onClassLevelDragEnd={onClassLevelDragEnd}
                  />
                ))}
              </div>
            </DndContext>
          )}
        </div>
      </div>

      {modal?.type === 'product' && (
        <ProductModal
          product={modal.product}
          onSave={modal.onSave}
          onClose={() => setModal(null)}
          typeOptions={productFieldOptions.typeOptions}
          categoryOptions={productFieldOptions.categoryOptions}
        />
      )}
      {modal?.type === 'simple' && (
        <SimpleEditModal
          title={modal.title}
          initialName={modal.initialName}
          initialDescription={modal.initialDescription}
          showDescription={modal.showDescription}
          onSave={modal.onSave}
          onDelete={modal.onDelete}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
};

// ============================================================================
// 공용 작은 컴포넌트
// ============================================================================
const SummaryChip = ({ type, count }) => {
  const s = TYPE_STYLES[type];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-1 ${s.summary}`}>
      {s.label} <strong className="tabular-nums">{count}</strong>
    </span>
  );
};

const TypeBadge = ({ type }) => {
  const s = TYPE_STYLES[type];
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.badge}`}>
      {s.label}
    </span>
  );
};

const HoverCount = ({ count }) => (
  <span className="ml-1.5 text-xs text-slate-400 opacity-0 transition-opacity tabular-nums group-hover:opacity-100">
    ({count})
  </span>
);

const HoverGear = ({ onClick, title }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    title={title}
    className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
  >
    <GearSix size={15} weight="regular" />
  </button>
);

const HoverAddButton = ({ label, onClick }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className="inline-flex items-center gap-1 rounded-md border border-dashed border-cyan-300 bg-white px-2 py-1 text-[11px] font-medium text-cyan-700 hover:border-cyan-500 hover:bg-cyan-50"
  >
    <Plus size={12} weight="bold" /> {label}
  </button>
);

// 각 행의 우측에 시간 표시 + 호버 액션 그룹을 absolute로 고정시키는 슬롯.
// - 시간: 항상 우측에 보이고, 호버 시 페이드 아웃
// - 액션(설정/추가 버튼): 호버 시 우측 중앙에 absolute로 등장
const RowEndSlot = ({ at, children }) => (
  <>
    {at && (
      <span
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 shrink-0 text-[11px] tabular-nums text-slate-400 transition-opacity group-hover:opacity-0"
        title={new Date(at).toLocaleString('ko-KR')}
      >
        {formatRelativeTime(at)}
      </span>
    )}
    {children && (
      <div className="invisible absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover:visible">
        {children}
      </div>
    )}
  </>
);

const DragHandle = ({ attributes, listeners }) => (
  <button
    type="button"
    {...attributes}
    {...listeners}
    className="invisible cursor-grab rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-500 group-hover:visible active:cursor-grabbing"
    title="드래그하여 이동"
  >
    <DotsSixVertical size={14} weight="bold" />
  </button>
);

const CaretButton = ({ open, onClick }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
  >
    {open ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
  </button>
);

const EmptyState = ({ message, actionLabel, onAction, depth = 0 }) => (
  <div
    className="my-1.5 flex items-center justify-between rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-2.5 text-[11px] text-slate-400"
    style={{ marginLeft: depth }}
  >
    <span>{message}</span>
    {actionLabel && (
      <button
        type="button"
        onClick={onAction}
        className="inline-flex items-center gap-1 rounded border border-cyan-200 bg-white px-2 py-0.5 text-[11px] font-medium text-cyan-700 hover:bg-cyan-50"
      >
        <Plus size={11} weight="bold" /> {actionLabel}
      </button>
    )}
  </div>
);

const EmptyHero = ({ title, hint, actionLabel, onAction }) => (
  <div className="rounded-xl bg-white p-12 text-center shadow-sm">
    <div className="mb-1 text-base font-semibold text-slate-700">{title}</div>
    <div className="mb-4 text-sm text-slate-400">{hint}</div>
    <button
      type="button"
      onClick={onAction}
      className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600"
    >
      <Plus size={14} weight="bold" /> {actionLabel}
    </button>
  </div>
);

// ============================================================================
// Product
// ============================================================================
const ProductCard = ({
  product: p,
  expanded,
  toggle,
  sensors,
  onEditProduct,
  onEditClass,
  onEditSection,
  onCreateClass,
  onCreateSection,
  onCreateLesson,
  onNavigateToLesson,
  onDragEndClasses,
  onClassLevelDragEnd,
}) => {
  const key = `prod-${p.id}`;
  const open = expanded[key] !== false;
  const classes = p.Classes || [];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* 상품 헤더 */}
      <div className="group relative flex items-center gap-2 border-b border-slate-200 bg-slate-50/40 px-3 py-3 pr-20">
        <CaretButton open={open} onClick={() => toggle(key)} />
        <TypeBadge type="product" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center">
            <span className="truncate text-sm font-semibold text-slate-900">{p.name}</span>
            <HoverCount count={classes.length} />
            {!p.is_active && (
              <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">
                비활성
              </span>
            )}
          </div>
          {p.description && (
            <div className="truncate text-xs text-slate-500">{p.description}</div>
          )}
        </div>
        <RowEndSlot at={p.updated_at}>
          <HoverAddButton label="클래스" onClick={() => onCreateClass(p.id)} />
          <HoverGear onClick={() => onEditProduct(p)} title="상품 설정" />
        </RowEndSlot>
      </div>

      {/* 클래스 리스트 */}
      {open && (
        <div className="px-2 py-1.5">
          {classes.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEndClasses(p.id, classes)}
            >
              <SortableContext items={classes.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {classes.map((c) => (
                  <ClassRow
                    key={c.id}
                    cls={c}
                    expanded={expanded}
                    toggle={toggle}
                    sensors={sensors}
                    onEditClass={onEditClass}
                    onEditSection={onEditSection}
                    onCreateSection={onCreateSection}
                    onCreateLesson={onCreateLesson}
                    onNavigateToLesson={onNavigateToLesson}
                    onClassLevelDragEnd={onClassLevelDragEnd}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <EmptyState
              message="클래스가 없습니다"
              actionLabel="클래스 추가"
              onAction={() => onCreateClass(p.id)}
            />
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Class
// ============================================================================
const ClassRow = ({
  cls,
  expanded,
  toggle,
  sensors,
  onEditClass,
  onEditSection,
  onCreateSection,
  onCreateLesson,
  onNavigateToLesson,
  onClassLevelDragEnd,
}) => {
  const key = `cls-${cls.id}`;
  const open = expanded[key] !== false;
  const sections = cls.Sections || [];

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: cls.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="my-0.5">
      <div className="group relative flex items-center gap-1.5 rounded-md py-1.5 pl-1.5 pr-20 hover:bg-slate-50">
        <DragHandle attributes={attributes} listeners={listeners} />
        <CaretButton open={open} onClick={() => toggle(key)} />
        <TypeBadge type="class" />
        <div className="flex min-w-0 flex-1 items-center">
          <span className="truncate text-sm font-medium text-slate-800">{cls.name}</span>
          <HoverCount count={sections.length} />
        </div>
        <RowEndSlot at={cls.updated_at}>
          <HoverAddButton label="섹션" onClick={() => onCreateSection(cls.id)} />
          <HoverGear onClick={() => onEditClass(cls)} title="클래스 설정" />
        </RowEndSlot>
      </div>
      {open && (
        <div className="ml-4 border-l border-slate-200 pl-2">
          {sections.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onClassLevelDragEnd(cls)}
            >
              <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                {sections.map((s) => (
                  <SectionRow
                    key={s.id}
                    sec={s}
                    expanded={expanded}
                    toggle={toggle}
                    onEditSection={onEditSection}
                    onCreateLesson={onCreateLesson}
                    onNavigateToLesson={onNavigateToLesson}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <EmptyState
              message="섹션이 없습니다"
              actionLabel="섹션 추가"
              onAction={() => onCreateSection(cls.id)}
            />
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Section
// ============================================================================
const SectionRow = ({
  sec,
  expanded,
  toggle,
  onEditSection,
  onCreateLesson,
  onNavigateToLesson,
}) => {
  const key = `sec-${sec.id}`;
  const open = expanded[key] !== false;
  const lessons = sec.Lessons || [];

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: sec.id });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `lesson-drop-${sec.id}`,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="my-0.5">
      <div className="group relative flex items-center gap-1.5 rounded-md py-1.5 pl-1.5 pr-20 hover:bg-slate-50">
        <DragHandle attributes={attributes} listeners={listeners} />
        <CaretButton open={open} onClick={() => toggle(key)} />
        <TypeBadge type="section" />
        <div className="flex min-w-0 flex-1 items-center">
          <span className="truncate text-sm font-medium text-slate-700">{sec.name}</span>
          <HoverCount count={lessons.length} />
        </div>
        <RowEndSlot at={sec.updated_at}>
          <HoverAddButton label="레슨" onClick={() => onCreateLesson(sec.id)} />
          <HoverGear onClick={() => onEditSection(sec)} title="섹션 설정" />
        </RowEndSlot>
      </div>
      {open && (
        <div
          ref={setDropRef}
          className={`ml-4 border-l pl-2 transition-colors ${
            isOver ? 'border-cyan-300 bg-cyan-50/40' : 'border-slate-200'
          }`}
        >
          <SortableContext items={lessons.map((l) => l.id)} strategy={verticalListSortingStrategy}>
            {lessons.map((l, i) => (
              <LessonRow
                key={l.id}
                lesson={l}
                index={i}
                onOpen={onNavigateToLesson}
              />
            ))}
          </SortableContext>
          {lessons.length === 0 && (
            <EmptyState
              message="레슨이 없습니다 (다른 섹션의 레슨을 여기로 드래그할 수도 있어요)"
              actionLabel="레슨 추가"
              onAction={() => onCreateLesson(sec.id)}
            />
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Lesson
// ============================================================================
const LessonRow = ({ lesson, index, onOpen }) => {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: lesson.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative my-0.5 flex items-center gap-1.5 rounded-md py-1.5 pl-1.5 pr-12 hover:bg-slate-50"
    >
      <DragHandle attributes={attributes} listeners={listeners} />
      <span className="w-4" />
      <TypeBadge type="lesson" />
      <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-slate-400">{index + 1}.</span>
      <span className="flex-1 truncate text-sm text-slate-700">{lesson.name}</span>
      <RowEndSlot at={lesson.updated_at}>
        <HoverGear onClick={() => onOpen(lesson.id)} title="레슨 에디터 열기" />
      </RowEndSlot>
    </div>
  );
};

export default AdminLessonList;
