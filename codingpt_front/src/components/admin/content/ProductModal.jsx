import { useState } from 'react';
import { Switch } from '../lesson-editor/modules/_shared/SharedFields';

const DIFFICULTY_OPTIONS = ['입문', '초급', '중급', '고급'];

// 중복 제거하며 순서 유지 (빈 값 제외)
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

const ProductModal = ({ product, onSave, onClose, typeOptions = [], categoryOptions = [] }) => {
  const [form, setForm] = useState(product || {
    name: '',
    description: '',
    type: '클래스',
    price: 0,
    category: '',
    difficulty: '입문',
    is_active: true,
  });
  const [busy, setBusy] = useState(false);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      await onSave({
        ...form,
        price: Number(form.price) || 0,
      });
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold text-slate-900">
            {product ? '상품 수정' : '새 상품'}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="text-xs text-slate-600">이름 *</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              required
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-600">설명</span>
            <textarea
              value={form.description || ''}
              onChange={(e) => update({ description: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-600">유형</span>
              <input
                type="text"
                list="product-type-options"
                value={form.type || ''}
                onChange={(e) => update({ type: e.target.value })}
                placeholder="선택하거나 입력"
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
              <datalist id="product-type-options">
                {uniq([...typeOptions, form.type]).map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="text-xs text-slate-600">가격</span>
              <input
                type="number"
                value={form.price ?? 0}
                onChange={(e) => update({ price: e.target.value })}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-600">카테고리</span>
              <input
                type="text"
                list="product-category-options"
                value={form.category || ''}
                onChange={(e) => update({ category: e.target.value })}
                placeholder="선택하거나 입력"
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
              <datalist id="product-category-options">
                {uniq([...categoryOptions, form.category]).map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="text-xs text-slate-600">난이도</span>
              <select
                value={form.difficulty || '입문'}
                onChange={(e) => update({ difficulty: e.target.value })}
                className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              >
                {uniq([...DIFFICULTY_OPTIONS, form.difficulty]).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between rounded border border-slate-200 px-3 py-2">
            <span className="text-sm text-slate-700">활성화</span>
            <Switch checked={!!form.is_active} onChange={(v) => update({ is_active: v })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button type="button" onClick={onClose} className="rounded border border-slate-200 bg-white px-4 py-1.5 text-sm">
            취소
          </button>
          <button type="submit" disabled={busy || !form.name.trim()} className="rounded bg-cyan-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50">
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProductModal;
