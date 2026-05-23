import { CaretRight } from '@phosphor-icons/react';
import { LESSON_ASSETS_ROOT } from '../../../../../../utils/objectStoreApi';

const Breadcrumb = ({ path, onNavigate }) => {
  // path 예: 'lesson-assets/lessons/python-basics/'
  const trimmed = (path || LESSON_ASSETS_ROOT).replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  // parts 예: ['lesson-assets', 'lessons', 'python-basics']

  const segments = parts.map((name, idx) => {
    const accumulated = parts.slice(0, idx + 1).join('/') + '/';
    return { name, path: accumulated, isRoot: idx === 0 };
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
