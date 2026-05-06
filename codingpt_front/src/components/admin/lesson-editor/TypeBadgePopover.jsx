import { useEffect, useRef, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { SLIDE_ROLES, SLIDE_ROLE_PRESETS, getRoleMeta } from './slidePresets';
import { useEditor } from './state/EditorContext';

const previewStyle = (preset) => {
  if (!preset?.colors?.length) return { background: '#FAFAFA' };
  const stops = preset.colors.map((c, i) => {
    const loc = preset.locations?.[i];
    return loc != null ? `${c} ${loc * 100}%` : c;
  });
  return { background: `linear-gradient(${preset.angle ?? 180}deg, ${stops.join(', ')})` };
};

const TypeBadgePopover = ({ slide, autoOpen = false, onTypePicked, enabled = true }) => {
  const { dispatch } = useEditor();
  const [open, setOpen] = useState(autoOpen && enabled);
  const [anchorRect, setAnchorRect] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const role = slide.contents?.role || 'custom';
  const meta = getRoleMeta(role);
  const background = slide.contents?.background || SLIDE_ROLE_PRESETS[role];

  useEffect(() => {
    if (autoOpen && enabled && btnRef.current) {
      setAnchorRect(btnRef.current.getBoundingClientRect());
      setOpen(true);
    }
  }, [autoOpen, enabled]);

  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!enabled) return;
    if (open) {
      setOpen(false);
    } else if (btnRef.current) {
      setAnchorRect(btnRef.current.getBoundingClientRect());
      setOpen(true);
    }
  };

  const pickRole = (nextRole) => {
    dispatch({
      type: 'updateSlideContents',
      slideId: slide.id,
      update: { role: nextRole, background: SLIDE_ROLE_PRESETS[nextRole] },
    });
    setOpen(false);
    if (onTypePicked) onTypePicked(nextRole);
  };

  const updateColorAt = (idx, value) => {
    const colors = [...(background?.colors || [])];
    colors[idx] = value;
    dispatch({
      type: 'updateSlideContents',
      slideId: slide.id,
      update: { background: { ...background, colors } },
    });
  };

  const resetBackground = () => {
    dispatch({
      type: 'updateSlideContents',
      slideId: slide.id,
      update: { background: SLIDE_ROLE_PRESETS[role] },
    });
  };

  const popStyle = anchorRect
    ? {
      position: 'fixed',
      top: anchorRect.bottom + 6,
      left: Math.max(8, anchorRect.left),
      zIndex: 60,
    }
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className={'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ' + meta.color}
        title="타입 변경"
      >
        {meta.label}
      </button>
      {open && popStyle && (
        <div
          ref={popRef}
          style={popStyle}
          className="w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
        >
          <p className="mb-1 px-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            슬라이드 타입
          </p>
          <ul className="mb-2 flex flex-col gap-0.5">
            {SLIDE_ROLES.map((r) => (
              <li key={r.value}>
                <button
                  type="button"
                  onClick={() => pickRole(r.value)}
                  className={
                    'flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-sm hover:bg-slate-100 ' +
                    (r.value === role ? 'bg-slate-50' : '')
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-4 w-4 rounded border border-slate-200"
                      style={previewStyle(SLIDE_ROLE_PRESETS[r.value])}
                    />
                    <span className={'text-slate-700'}>{r.label}</span>
                  </span>
                  {r.value === role && <Check weight="bold" className="h-3.5 w-3.5 text-cyan-600" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-100 pt-2">
            <div className="mb-1 flex items-center justify-between px-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                배경 색상
              </p>
              <button
                type="button"
                onClick={resetBackground}
                className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
              >
                기본값
              </button>
            </div>
            <div className="flex items-center gap-1.5 px-1.5">
              {(background?.colors || []).map((c, i) => (
                <label
                  key={i}
                  className="relative block h-7 w-7 cursor-pointer overflow-hidden rounded border border-slate-200"
                  style={{ background: c.startsWith('rgba') || c.length > 7 ? c : c }}
                  title={c}
                >
                  <input
                    type="color"
                    value={/^#[0-9A-Fa-f]{6}$/.test(c) ? c : '#ffffff'}
                    onChange={(e) => updateColorAt(i, e.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default TypeBadgePopover;
