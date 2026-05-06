import { useEffect, useRef } from 'react';

const CharacterPickerPopover = ({ candidates, anchorRect, onPick, onClose }) => {
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  if (!anchorRect) return null;

  const style = {
    position: 'fixed',
    top: anchorRect.bottom + 6,
    left: Math.max(8, anchorRect.left - 60),
    zIndex: 50,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
    >
      <p className="mb-1 px-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        캐릭터 추가
      </p>
      {candidates.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-xs text-slate-400">
          추가할 캐릭터가 없어요
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {candidates.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-100"
              >
                <img
                  src={c.url}
                  alt={c.label}
                  className="h-7 w-7 shrink-0 rounded-full bg-slate-100 object-cover"
                  draggable={false}
                />
                <span className="truncate text-sm text-slate-700">{c.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default CharacterPickerPopover;
