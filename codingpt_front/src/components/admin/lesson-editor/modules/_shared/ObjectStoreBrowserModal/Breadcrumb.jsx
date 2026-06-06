import { CaretRight } from '@phosphor-icons/react';
import { LESSON_ASSETS_ROOT } from '../../../../../../utils/objectStoreApi';

const Breadcrumb = ({ path, onNavigate, rootPath = LESSON_ASSETS_ROOT }) => {
  // path 예: 'lesson-assets/lessons/python-basics/'
  const trimmed = (path || rootPath).replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  // 루트(rootPath)의 마지막 세그먼트부터 표시 — 그 위로는 노출/이동하지 않음
  const rootParts = rootPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const startIdx = Math.min(Math.max(0, rootParts.length - 1), Math.max(0, parts.length - 1));

  const segments = parts.slice(startIdx).map((name, i) => {
    const idx = startIdx + i;
    const accumulated = parts.slice(0, idx + 1).join('/') + '/';
    return { name, path: accumulated, isRoot: i === 0 };
  });

  return (
    <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-xs">
      {segments.map((seg, idx) => {
        const isLast = idx === segments.length - 1;
        const disabled = seg.isRoot && segments.length === 1;
        return (
          <div key={seg.path} className="flex items-center gap-1">
            {idx > 0 && <CaretRight size={12} className="text-slate-400" />}
            <button
              type="button"
              onClick={() => !disabled && !isLast && onNavigate(seg.path)}
              disabled={disabled || isLast}
              className={
                'rounded px-1.5 py-0.5 ' +
                (isLast
                  ? 'cursor-default font-semibold text-slate-700'
                  : 'cursor-pointer text-cyan-600 hover:bg-cyan-50')
              }
            >
              {seg.name}
            </button>
          </div>
        );
      })}
    </nav>
  );
};

export default Breadcrumb;
