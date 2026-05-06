import { ColorField, NumberField, Field } from './modules/_shared/SharedFields';
import { useEditor, selectSelectedSlide } from './state/EditorContext';

const BackgroundEditor = () => {
  const { state, dispatch } = useEditor();
  const slide = selectSelectedSlide(state);
  if (!slide) return null;

  const bg = slide.contents?.background || { colors: ['#FFFFFF'], angle: 180 };
  const colors = bg.colors || [];

  const updateBg = (next) => {
    dispatch({
      type: 'updateSlideContents',
      slideId: slide.id,
      update: { background: next },
    });
  };

  const setColor = (i, value) => {
    const next = colors.slice();
    next[i] = value;
    updateBg({ ...bg, colors: next });
  };

  const setLocation = (i, value) => {
    const locs = bg.locations ? bg.locations.slice() : colors.map((_, idx) => idx / Math.max(1, colors.length - 1));
    locs[i] = value;
    updateBg({ ...bg, locations: locs });
  };

  const addStop = () => {
    const next = [...colors, '#FFFFFF'];
    const locs = next.map((_, i) => i / (next.length - 1));
    updateBg({ ...bg, colors: next, locations: locs });
  };

  const removeStop = (i) => {
    if (colors.length <= 1) return;
    const next = colors.filter((_, idx) => idx !== i);
    const locs = next.map((_, idx) => idx / Math.max(1, next.length - 1));
    updateBg({ ...bg, colors: next, locations: locs });
  };

  return (
    <div>
      <Field label="각도 (deg)">
        <NumberField
          value={bg.angle ?? 180}
          onChange={(v) => updateBg({ ...bg, angle: v ?? 180 })}
          min={0}
          max={360}
        />
      </Field>
      <div className="mb-2 text-xs font-medium text-slate-600">색 정지점 ({colors.length})</div>
      {colors.map((c, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <span className="w-5 text-xs text-slate-400">{i + 1}</span>
          <div className="flex-1">
            <ColorField value={c} onChange={(v) => setColor(i, v)} />
          </div>
          <input
            type="number"
            value={bg.locations?.[i] != null ? bg.locations[i] : ''}
            onChange={(e) => setLocation(i, e.target.value === '' ? undefined : Number(e.target.value))}
            min={0}
            max={1}
            step={0.01}
            placeholder="0~1"
            className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
          />
          <button
            type="button"
            onClick={() => removeStop(i)}
            disabled={colors.length <= 1}
            className="text-xs text-red-500 disabled:opacity-30"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addStop}
        className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
      >
        + 정지점 추가
      </button>
    </div>
  );
};

export default BackgroundEditor;
