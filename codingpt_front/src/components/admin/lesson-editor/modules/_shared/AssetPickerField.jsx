import { useState } from 'react';
import { ImageSquare, X } from '@phosphor-icons/react';
import ObjectStoreBrowserModal from './ObjectStoreBrowserModal/ObjectStoreBrowserModal';
import { LESSON_ASSETS_ROOT } from '../../../../../utils/objectStoreApi';

const AssetPickerField = ({ label, value, onChange, accept = 'image/*' }) => {
  const [modalOpen, setModalOpen] = useState(false);

  const handleClear = (e) => {
    e.stopPropagation();
    onChange('');
  };

  const handleOpen = () => setModalOpen(true);

  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-medium text-slate-600">{label}</div>
      <button
        type="button"
        onClick={handleOpen}
        className={
          'group relative flex min-h-[140px] w-full cursor-pointer items-center justify-center ' +
          'rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 transition ' +
          'hover:border-cyan-400 hover:bg-slate-100'
        }
        title="ObjectStore에서 이미지 선택"
      >
        {value ? (
          <>
            <img
              src={value}
              alt=""
              className="max-h-32 max-w-full rounded object-contain"
              onError={(e) => {
                e.target.style.opacity = '0.3';
              }}
            />
            <span
              role="button"
              tabIndex={0}
              onClick={handleClear}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleClear(e);
              }}
              className="absolute right-2 top-2 rounded-full bg-white/90 p-1 text-slate-500 shadow-sm opacity-0 transition group-hover:opacity-100 hover:text-red-500"
              title="제거"
            >
              <X size={14} />
            </span>
          </>
        ) : (
          <div className="pointer-events-none flex flex-col items-center gap-1 text-slate-400">
            <ImageSquare size={28} />
            <span className="text-xs">클릭하여 ObjectStore에서 선택</span>
          </div>
        )}
      </button>

      {modalOpen && (
        <ObjectStoreBrowserModal
          accept={accept}
          initialPath={`${LESSON_ASSETS_ROOT}images/`}
          currentValue={value}
          onSelect={(url) => {
            onChange(url);
            setModalOpen(false);
          }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
};

export default AssetPickerField;
