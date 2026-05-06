import React, { createContext, useContext, useReducer, useMemo, useRef } from 'react';
import { produce } from 'immer';
import { nanoid } from 'nanoid';

const EditorContext = createContext(null);

const initialState = {
  lesson: null,
  selection: { slideId: null, moduleId: null },
  ui: { dirty: false, saving: 'idle', error: null, pendingFocus: null, editingSlideId: null },
  history: { past: [], future: [] },
};

const HISTORY_LIMIT = 50;

const pushHistory = (draft) => {
  draft.history.past.push({
    lesson: draft.lesson,
    selection: { ...draft.selection },
  });
  if (draft.history.past.length > HISTORY_LIMIT) {
    draft.history.past.shift();
  }
  draft.history.future = [];
};

const reducer = produce((draft, action) => {
  switch (action.type) {
    case 'load': {
      draft.lesson = action.lesson;
      draft.selection = { slideId: action.lesson?.slides?.[0]?.id ?? null, moduleId: null };
      draft.ui.dirty = false;
      draft.ui.saving = 'idle';
      draft.ui.error = null;
      draft.history = { past: [], future: [] };
      break;
    }
    case 'updateLessonMeta': {
      if (!draft.lesson) break;
      pushHistory(draft);
      Object.assign(draft.lesson, action.patch);
      draft.ui.dirty = true;
      break;
    }
    case 'addSlide': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = {
        id: action.slide.id,
        order_no: action.slide.order_no ?? draft.lesson.slides.length,
        contents: action.slide.contents,
      };
      const insertIdx = action.insertAt ?? draft.lesson.slides.length;
      draft.lesson.slides.splice(insertIdx, 0, slide);
      draft.selection = { slideId: slide.id, moduleId: null };
      draft.ui.dirty = true;
      break;
    }
    case 'removeSlide': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const idx = draft.lesson.slides.findIndex((s) => s.id === action.slideId);
      if (idx >= 0) {
        draft.lesson.slides.splice(idx, 1);
        const next = draft.lesson.slides[idx] || draft.lesson.slides[idx - 1] || null;
        draft.selection = { slideId: next?.id ?? null, moduleId: null };
        draft.ui.dirty = true;
      }
      break;
    }
    case 'reorderSlides': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const moved = draft.lesson.slides.splice(action.from, 1)[0];
      draft.lesson.slides.splice(action.to, 0, moved);
      draft.ui.dirty = true;
      break;
    }
    case 'updateSlideContents': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = draft.lesson.slides.find((s) => s.id === action.slideId);
      if (slide) {
        slide.contents = typeof action.update === 'function'
          ? action.update(slide.contents)
          : { ...slide.contents, ...action.update };
        draft.ui.dirty = true;
      }
      break;
    }
    case 'addModule': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = draft.lesson.slides.find((s) => s.id === action.slideId);
      if (slide) {
        if (!slide.contents.modules) slide.contents.modules = [];
        const module = { ...action.module, id: action.module.id ?? nanoid(8) };
        const insertIdx = action.insertAt ?? slide.contents.modules.length;
        slide.contents.modules.splice(insertIdx, 0, module);
        draft.selection = { slideId: action.slideId, moduleId: module.id };
        draft.ui.dirty = true;
      }
      break;
    }
    case 'updateModule': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = draft.lesson.slides.find((s) => s.id === action.slideId);
      const mod = slide?.contents?.modules?.find((m) => m.id === action.moduleId);
      if (mod) {
        Object.assign(mod, action.patch);
        draft.ui.dirty = true;
      }
      break;
    }
    case 'removeModule': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = draft.lesson.slides.find((s) => s.id === action.slideId);
      if (slide?.contents?.modules) {
        slide.contents.modules = slide.contents.modules.filter((m) => m.id !== action.moduleId);
        if (draft.selection.moduleId === action.moduleId) {
          draft.selection.moduleId = null;
        }
        draft.ui.dirty = true;
      }
      break;
    }
    case 'reorderModules': {
      if (!draft.lesson) break;
      pushHistory(draft);
      const slide = draft.lesson.slides.find((s) => s.id === action.slideId);
      if (slide?.contents?.modules) {
        const moved = slide.contents.modules.splice(action.from, 1)[0];
        slide.contents.modules.splice(action.to, 0, moved);
        draft.ui.dirty = true;
      }
      break;
    }
    case 'select': {
      draft.selection = {
        slideId: action.slideId ?? draft.selection.slideId,
        moduleId: action.moduleId ?? null,
      };
      break;
    }
    case 'setPendingFocus': {
      draft.ui.pendingFocus = action.payload || null;
      break;
    }
    case 'setEditingSlide': {
      draft.ui.editingSlideId = action.slideId || null;
      break;
    }
    case 'savingState': {
      draft.ui.saving = action.value;
      if (action.value === 'saved') {
        draft.ui.dirty = false;
        draft.ui.error = null;
      } else if (action.value === 'error') {
        draft.ui.error = action.error || null;
      }
      break;
    }
    case 'undo': {
      const prev = draft.history.past.pop();
      if (prev) {
        draft.history.future.push({ lesson: draft.lesson, selection: { ...draft.selection } });
        draft.lesson = prev.lesson;
        draft.selection = prev.selection;
        draft.ui.dirty = true;
      }
      break;
    }
    case 'redo': {
      const next = draft.history.future.pop();
      if (next) {
        draft.history.past.push({ lesson: draft.lesson, selection: { ...draft.selection } });
        draft.lesson = next.lesson;
        draft.selection = next.selection;
        draft.ui.dirty = true;
      }
      break;
    }
    default:
      break;
  }
});

export const EditorProvider = ({ children }) => {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const value = useMemo(() => ({
    state,
    dispatch,
    getState: () => stateRef.current,
  }), [state]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
};

export const useEditor = () => {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be inside EditorProvider');
  return ctx;
};

export const useEditorState = () => useEditor().state;
export const useEditorDispatch = () => useEditor().dispatch;

export const selectSelectedSlide = (state) =>
  state.lesson?.slides.find((s) => s.id === state.selection.slideId) || null;

export const selectSelectedModule = (state) => {
  const slide = selectSelectedSlide(state);
  if (!slide) return null;
  return slide.contents?.modules?.find((m) => m.id === state.selection.moduleId) || null;
};
