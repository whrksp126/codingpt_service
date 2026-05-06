import { useRef, useState } from 'react';
import { Plus, X } from '@phosphor-icons/react';
import { useEditor } from './state/EditorContext';
import { useCharacters } from './state/useCharacters';
import CharacterPickerPopover from './CharacterPickerPopover';

const CharacterPool = () => {
  const { state, dispatch } = useEditor();
  const { characters: catalog } = useCharacters();
  const [pickerRect, setPickerRect] = useState(null);
  const addBtnRef = useRef(null);

  const lesson = state.lesson;
  if (!lesson) return null;

  const selectedKeys = Array.isArray(lesson.characters) ? lesson.characters : [];
  const catalogByKey = new Map(catalog.map((c) => [c.key, c]));
  const items = selectedKeys
    .map((key) => catalogByKey.get(key))
    .filter(Boolean);
  const candidates = catalog.filter((c) => !selectedKeys.includes(c.key));

  const setDefault = (key) => {
    if (lesson.default_character === key) return;
    dispatch({ type: 'updateLessonMeta', patch: { default_character: key } });
  };

  const removeKey = (key) => {
    const next = selectedKeys.filter((k) => k !== key);
    const patch = { characters: next };
    if (lesson.default_character === key) {
      patch.default_character = next[0] || null;
    }
    dispatch({ type: 'updateLessonMeta', patch });
  };

  const handleAdd = (c) => {
    const next = [...selectedKeys, c.key];
    const patch = { characters: next };
    if (!lesson.default_character) patch.default_character = c.key;
    dispatch({ type: 'updateLessonMeta', patch });
    setPickerRect(null);
  };

  const togglePicker = () => {
    if (pickerRect) {
      setPickerRect(null);
    } else if (addBtnRef.current) {
      setPickerRect(addBtnRef.current.getBoundingClientRect());
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1">
      {items.map((c) => {
        const isDefault = lesson.default_character === c.key;
        return (
          <div key={c.key} className="group relative shrink-0">
            <button
              type="button"
              onClick={() => setDefault(c.key)}
              title={isDefault ? `${c.label} (기본)` : `${c.label} (클릭하면 기본 캐릭터로 지정)`}
              className={
                'block h-9 w-9 overflow-hidden rounded-full bg-slate-100 transition ' +
                (isDefault
                  ? 'ring-2 ring-cyan-500 ring-offset-1'
                  : 'ring-1 ring-slate-200 hover:ring-slate-400')
              }
            >
              <img src={c.url} alt={c.label} className="h-full w-full object-cover" draggable={false} />
            </button>
            <button
              type="button"
              onClick={() => removeKey(c.key)}
              title="레슨에서 제거"
              className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-white shadow group-hover:flex"
            >
              <X weight="bold" className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
      <button
        ref={addBtnRef}
        type="button"
        onClick={togglePicker}
        title="캐릭터 추가"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 hover:border-slate-500 hover:text-slate-700"
      >
        <Plus weight="bold" className="h-4 w-4" />
      </button>
      {pickerRect && (
        <CharacterPickerPopover
          candidates={candidates}
          anchorRect={pickerRect}
          onPick={handleAdd}
          onClose={() => setPickerRect(null)}
        />
      )}
    </div>
  );
};

export default CharacterPool;
