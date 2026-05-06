import { useState, useMemo } from 'react';

const PickerModal = ({ title, items, onPick, onCreate, onClose, createLabel = '+ 새로 만들기', renderLabel }) => {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    if (!search) return items;
    const term = search.toLowerCase();
    return items.filter((it) => (it.name || '').toLowerCase().includes(term));
  }, [items, search]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await onCreate(newName.trim());
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePick = async (item) => {
    setBusy(true);
    try {
      await onPick(item);
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        {!creating ? (
          <>
            <div className="border-b border-slate-200 p-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="검색"
                className="w-full rounded border border-slate-200 px-3 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {filtered.length === 0 && (
                <div className="p-4 text-center text-sm text-slate-400">
                  {items.length === 0 ? '사용 가능한 항목이 없습니다' : '검색 결과 없음'}
                </div>
              )}
              {filtered.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  disabled={busy}
                  onClick={() => handlePick(it)}
                  className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  <span>{renderLabel ? renderLabel(it) : it.name}</span>
                  <span className="text-xs text-slate-400">#{it.id}</span>
                </button>
              ))}
            </div>
            {onCreate && (
              <div className="border-t border-slate-200 p-3">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="w-full rounded bg-cyan-500 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-600"
                >
                  {createLabel}
                </button>
              </div>
            )}
          </>
        ) : (
          <form onSubmit={handleCreate} className="flex flex-col gap-3 p-4">
            <label>
              <span className="text-xs text-slate-600">이름</span>
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={!newName.trim() || busy}
                className="flex-1 rounded bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
              >
                {busy ? '생성 중…' : '생성'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default PickerModal;
