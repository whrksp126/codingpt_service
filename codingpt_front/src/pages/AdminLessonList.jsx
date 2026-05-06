import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as content from '../utils/contentApi';
import * as lessonApi from '../utils/lessonApi';
import PickerModal from '../components/admin/content/PickerModal';
import ProductModal from '../components/admin/content/ProductModal';

const Caret = ({ open }) => <span className="inline-block w-3 text-slate-400">{open ? '▾' : '▸'}</span>;

const Pill = ({ color, children }) => (
  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${color}`}>{children}</span>
);

const ActionBtn = ({ children, onClick, color = 'slate', title }) => {
  const colors = {
    slate: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
    cyan: 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100',
    red: 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded border px-1.5 py-0.5 text-[11px] ${colors[color]}`}
    >
      {children}
    </button>
  );
};

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

  const wrap = async (fn) => {
    try {
      await fn();
      await load();
    } catch (e) {
      alert(e.message);
    }
  };

  const onAddClassToProduct = (product) => {
    const linkedClassIds = new Set((product.Classes || []).map((c) => c.id));
    const candidates = (tree.orphans.classes || []).filter((c) => !linkedClassIds.has(c.id));
    setModal({
      type: 'picker',
      title: `"${product.name}"에 클래스 추가`,
      items: candidates,
      onPick: async (cls) => wrap(() => content.linkProductClass(product.id, cls.id)),
      onCreate: async (name) => wrap(async () => {
        const newCls = await content.createClass({ name, description: name });
        await content.linkProductClass(product.id, newCls.id);
      }),
      createLabel: '+ 새 클래스 만들기',
    });
  };

  const onAddSectionToClass = (cls) => {
    const linkedIds = new Set((cls.Sections || []).map((s) => s.id));
    const candidates = (tree.orphans.sections || []).filter((s) => !linkedIds.has(s.id));
    setModal({
      type: 'picker',
      title: `"${cls.name}"에 섹션 추가`,
      items: candidates,
      onPick: async (sec) => wrap(() => content.linkClassSection(cls.id, sec.id)),
      onCreate: async (name) => wrap(async () => {
        const newSec = await content.createSection({ name });
        await content.linkClassSection(cls.id, newSec.id);
      }),
      createLabel: '+ 새 섹션 만들기',
    });
  };

  const onAddLessonToSection = (sec) => {
    const linkedIds = new Set((sec.Lessons || []).map((l) => l.id));
    const candidates = (tree.orphans.lessons || []).filter((l) => !linkedIds.has(l.id));
    setModal({
      type: 'picker',
      title: `"${sec.name}"에 레슨 추가`,
      items: candidates,
      onPick: async (lesson) => wrap(() => content.linkSectionLesson(sec.id, lesson.id)),
      onCreate: async (name) => {
        try {
          const newLesson = await lessonApi.createLesson({ name });
          await content.linkSectionLesson(sec.id, newLesson.id);
          setModal(null);
          navigate(`/admin/lessons/${newLesson.id}/edit`);
        } catch (e) {
          alert(e.message);
        }
      },
      createLabel: '+ 새 레슨 만들기 (에디터로 이동)',
    });
  };

  const onUnlinkClass = (productId, classId) =>
    confirm('이 클래스를 상품에서 제거할까요? 클래스 자체는 유지됩니다.') &&
    wrap(() => content.unlinkProductClass(productId, classId));

  const onUnlinkSection = (classId, sectionId) =>
    confirm('이 섹션을 클래스에서 제거할까요? 섹션 자체는 유지됩니다.') &&
    wrap(() => content.unlinkClassSection(classId, sectionId));

  const onUnlinkLesson = (sectionId, lessonId) =>
    confirm('이 레슨을 섹션에서 제거할까요? 레슨 자체는 유지됩니다.') &&
    wrap(() => content.unlinkSectionLesson(sectionId, lessonId));

  const onDeleteProduct = (product) =>
    confirm(`"${product.name}" 상품을 삭제할까요?`) &&
    wrap(() => content.deleteProduct(product.id));

  const onDeleteClass = (cls) =>
    confirm(`"${cls.name}" 클래스를 완전히 삭제할까요?`) &&
    wrap(() => content.deleteClass(cls.id));

  const onDeleteSection = (sec) =>
    confirm(`"${sec.name}" 섹션을 완전히 삭제할까요?`) &&
    wrap(() => content.deleteSection(sec.id));

  const onDeleteLesson = (lesson) =>
    confirm(`"${lesson.name}" 레슨과 모든 슬라이드를 삭제할까요?`) &&
    wrap(() => lessonApi.deleteLesson(lesson.id));

  const onCreateProduct = () => {
    setModal({
      type: 'product',
      product: null,
      onSave: async (data) => wrap(() => content.createProduct(data)),
    });
  };

  const onEditProduct = (product) => {
    setModal({
      type: 'product',
      product,
      onSave: async (data) => wrap(() => content.updateProduct(product.id, data)),
    });
  };

  const renderLesson = (sectionId, lesson, index) => (
    <div key={`l-${lesson.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 pl-12 hover:bg-slate-50">
      <span className="text-xs text-slate-400">📄</span>
      <span className="flex-1 truncate text-sm text-slate-700">
        <span className="text-slate-400 mr-1">{index + 1}.</span>
        {lesson.name}
      </span>
      {lesson.published_at ? (
        <Pill color="bg-emerald-100 text-emerald-700">발행</Pill>
      ) : (
        <Pill color="bg-slate-100 text-slate-500">draft</Pill>
      )}
      <ActionBtn color="cyan" onClick={() => navigate(`/admin/lessons/${lesson.id}/edit`)}>편집</ActionBtn>
      <ActionBtn onClick={() => onUnlinkLesson(sectionId, lesson.id)} title="섹션에서 분리">−</ActionBtn>
      <ActionBtn color="red" onClick={() => onDeleteLesson(lesson)} title="완전 삭제">✕</ActionBtn>
    </div>
  );

  const renderSection = (classId, sec) => {
    const key = `sec-${sec.id}`;
    const open = expanded[key] !== false;
    return (
      <div key={key}>
        <div className="flex items-center gap-2 rounded px-2 py-1.5 pl-8 hover:bg-slate-50">
          <button onClick={() => toggle(key)}><Caret open={open} /></button>
          <Pill color="bg-amber-100 text-amber-700">SEC</Pill>
          <span className="flex-1 truncate text-sm font-medium text-slate-800">{sec.name}</span>
          <span className="text-xs text-slate-400">{(sec.Lessons || []).length}개 레슨</span>
          <ActionBtn color="cyan" onClick={() => onAddLessonToSection(sec)}>+ 레슨</ActionBtn>
          <ActionBtn onClick={() => onUnlinkSection(classId, sec.id)} title="클래스에서 분리">−</ActionBtn>
          <ActionBtn color="red" onClick={() => onDeleteSection(sec)} title="완전 삭제">✕</ActionBtn>
        </div>
        {open && (sec.Lessons || []).map((l, i) => renderLesson(sec.id, l, i))}
        {open && (sec.Lessons || []).length === 0 && (
          <div className="py-1 pl-12 text-xs text-slate-400">레슨이 없습니다</div>
        )}
      </div>
    );
  };

  const renderClass = (productId, cls) => {
    const key = `cls-${cls.id}`;
    const open = expanded[key] !== false;
    return (
      <div key={key}>
        <div className="flex items-center gap-2 rounded px-2 py-1.5 pl-4 hover:bg-slate-50">
          <button onClick={() => toggle(key)}><Caret open={open} /></button>
          <Pill color="bg-blue-100 text-blue-700">CLS</Pill>
          <span className="flex-1 truncate text-sm font-medium text-slate-800">{cls.name}</span>
          <span className="text-xs text-slate-400">{(cls.Sections || []).length}개 섹션</span>
          <ActionBtn color="cyan" onClick={() => onAddSectionToClass(cls)}>+ 섹션</ActionBtn>
          <ActionBtn onClick={() => onUnlinkClass(productId, cls.id)} title="상품에서 분리">−</ActionBtn>
          <ActionBtn color="red" onClick={() => onDeleteClass(cls)} title="완전 삭제">✕</ActionBtn>
        </div>
        {open && (cls.Sections || []).map((s) => renderSection(cls.id, s))}
        {open && (cls.Sections || []).length === 0 && (
          <div className="py-1 pl-12 text-xs text-slate-400">섹션이 없습니다</div>
        )}
      </div>
    );
  };

  const renderProduct = (p) => {
    const key = `prod-${p.id}`;
    const open = expanded[key] !== false;
    return (
      <div key={key} className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
          <button onClick={() => toggle(key)}><Caret open={open} /></button>
          <Pill color="bg-violet-100 text-violet-700">PRODUCT</Pill>
          <div className="flex-1 truncate">
            <div className="text-sm font-semibold text-slate-900">{p.name}</div>
            {p.description && <div className="truncate text-xs text-slate-500">{p.description}</div>}
          </div>
          {!p.is_active && <Pill color="bg-slate-200 text-slate-500">비활성</Pill>}
          <span className="text-xs text-slate-400">
            {(p.Classes || []).length}개 클래스
          </span>
          <ActionBtn color="cyan" onClick={() => onAddClassToProduct(p)}>+ 클래스</ActionBtn>
          <ActionBtn onClick={() => onEditProduct(p)} title="편집">⚙</ActionBtn>
          <ActionBtn color="red" onClick={() => onDeleteProduct(p)} title="삭제">✕</ActionBtn>
        </div>
        {open && (
          <div className="p-1">
            {(p.Classes || []).map((c) => renderClass(p.id, c))}
            {(p.Classes || []).length === 0 && (
              <div className="px-2 py-2 text-xs text-slate-400">클래스가 없습니다</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const visibleProducts = tree
    ? tree.products.filter((p) => !hideInactive || p.is_active)
    : [];

  const totalCounts = tree && {
    products: visibleProducts.length,
    classes: visibleProducts.reduce((s, p) => s + (p.Classes || []).length, 0),
    sections: visibleProducts.reduce((s, p) => s + (p.Classes || []).reduce((ss, c) => ss + (c.Sections || []).length, 0), 0),
    lessons: visibleProducts.reduce((s, p) => s + (p.Classes || []).reduce((ss, c) => ss + (c.Sections || []).reduce((sss, sec) => sss + (sec.Lessons || []).length, 0), 0), 0),
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <Link to="/" className="text-sm text-slate-500 hover:text-slate-900">← 홈</Link>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">콘텐츠 관리</h1>
            <p className="text-sm text-slate-500">상품 → 클래스 → 섹션 → 레슨 계층 구조</p>
          </div>
          <button
            type="button"
            onClick={onCreateProduct}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600"
          >
            + 새 상품
          </button>
        </header>

        {totalCounts && (
          <div className="mb-4 flex items-center gap-2 text-xs">
            <span className="rounded bg-violet-100 px-2 py-1 text-violet-700">상품 {totalCounts.products}</span>
            <span className="rounded bg-blue-100 px-2 py-1 text-blue-700">클래스 {totalCounts.classes}</span>
            <span className="rounded bg-amber-100 px-2 py-1 text-amber-700">섹션 {totalCounts.sections}</span>
            <span className="rounded bg-emerald-100 px-2 py-1 text-emerald-700">레슨 {totalCounts.lessons}</span>
            <label className="ml-3 flex cursor-pointer items-center gap-1.5 text-slate-600 hover:text-slate-900">
              <input
                type="checkbox"
                checked={hideInactive}
                onChange={(e) => setHideInactive(e.target.checked)}
                className="h-3.5 w-3.5 rounded"
              />
              <span>비활성 상품 숨김</span>
            </label>
            {tree.orphans && (
              <span className="ml-auto text-slate-500">
                미연결: 클래스 {tree.orphans.classes.length}, 섹션 {tree.orphans.sections.length}, 레슨 {tree.orphans.lessons.length}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_280px]">
          <div className="space-y-3">
            {!tree && <div className="rounded-xl bg-white p-6 text-center text-slate-400">불러오는 중…</div>}
            {tree && tree.products.length === 0 && (
              <div className="rounded-xl bg-white p-6 text-center text-slate-400">
                상품이 없습니다. "+ 새 상품"으로 시작하세요.
              </div>
            )}
            {tree && tree.products.length > 0 && visibleProducts.length === 0 && (
              <div className="rounded-xl bg-white p-6 text-center text-slate-400">
                비활성 상품만 있습니다. "비활성 상품 숨김"을 끄면 보입니다.
              </div>
            )}
            {tree && visibleProducts.map(renderProduct)}
          </div>

          {tree && (
            <aside className="space-y-3">
              <OrphanList
                title="미연결 클래스"
                items={tree.orphans.classes}
                color="bg-blue-100 text-blue-700"
                onDelete={(it) => confirm(`"${it.name}" 삭제?`) && wrap(() => content.deleteClass(it.id))}
              />
              <OrphanList
                title="미연결 섹션"
                items={tree.orphans.sections}
                color="bg-amber-100 text-amber-700"
                onDelete={(it) => confirm(`"${it.name}" 삭제?`) && wrap(() => content.deleteSection(it.id))}
              />
              <OrphanList
                title="미연결 레슨"
                items={tree.orphans.lessons}
                color="bg-emerald-100 text-emerald-700"
                onEdit={(it) => navigate(`/admin/lessons/${it.id}/edit`)}
                onDelete={(it) => confirm(`"${it.name}" 삭제?`) && wrap(() => lessonApi.deleteLesson(it.id))}
              />
            </aside>
          )}
        </div>
      </div>

      {modal?.type === 'picker' && (
        <PickerModal
          title={modal.title}
          items={modal.items}
          onPick={modal.onPick}
          onCreate={modal.onCreate}
          createLabel={modal.createLabel}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'product' && (
        <ProductModal
          product={modal.product}
          onSave={modal.onSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
};

const OrphanList = ({ title, items, color, onEdit, onDelete }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="mb-2 flex items-center justify-between">
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${color}`}>{title}</span>
      <span className="text-xs text-slate-400">{items.length}</span>
    </div>
    <div className="space-y-1 text-sm">
      {items.length === 0 && <div className="text-xs text-slate-400">없음</div>}
      {items.map((it) => (
        <div key={it.id} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-slate-50">
          <span className="flex-1 truncate text-slate-700">{it.name}</span>
          <span className="text-[10px] text-slate-400">#{it.id}</span>
          {onEdit && (
            <button onClick={() => onEdit(it)} className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-cyan-600 hover:bg-cyan-50">편집</button>
          )}
          <button onClick={() => onDelete(it)} className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-50">✕</button>
        </div>
      ))}
    </div>
  </div>
);

export default AdminLessonList;
