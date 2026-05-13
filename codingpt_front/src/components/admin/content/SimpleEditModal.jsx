import { useState } from 'react';
import { X, Trash } from '@phosphor-icons/react';

const SimpleEditModal = ({
  title,
  initialName = '',
  initialDescription,
  showDescription = false,
  onSave,
  onDelete,
  onClose,
}) => {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription || '');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(
        showDescription
          ? { name: name.trim(), description: description.trim() }
          : { name: name.trim() },
      );
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!confirm(`"${initialName}"을(를) 완전히 삭제할까요?`)) return;
    setBusy(true);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="text-xs text-slate-600">이름 *</span>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
            />
          </label>
          {showDescription && (
            <label className="block">
              <span className="text-xs text-slate-600">설명</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </label>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          {onDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash size={14} weight="bold" /> 삭제
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-200 bg-white px-4 py-1.5 text-sm"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded bg-cyan-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
            >
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default SimpleEditModal;
