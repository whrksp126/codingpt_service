import { useEffect, useRef } from 'react';
import * as api from '../../../../utils/lessonApi';
import { useEditor } from './EditorContext';

const DEBOUNCE_MS = 800;

export const useAutosave = (lessonId) => {
  const { state, dispatch, getState, lastSavedRef } = useEditor();
  const timerRef = useRef(null);
  const inflightRef = useRef(null);

  useEffect(() => {
    if (!lessonId || !state.ui.dirty) return undefined;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const snapshot = getState();
      if (!snapshot.lesson) return;
      dispatch({ type: 'savingState', value: 'saving' });

      try {
        const lesson = snapshot.lesson;
        const lastSaved = lastSavedRef.current || {};

        if (
          lesson.name !== lastSaved.name ||
          lesson.description !== lastSaved.description ||
          lesson.type !== lastSaved.type ||
          lesson.default_character !== lastSaved.default_character ||
          JSON.stringify(lesson.meta) !== JSON.stringify(lastSaved.meta)
        ) {
          await api.updateLessonMeta(lessonId, {
            name: lesson.name,
            type: lesson.type,
            description: lesson.description,
            default_character: lesson.default_character,
            meta: lesson.meta,
          });
        }

        for (const slide of lesson.slides) {
          const prev = (lastSaved.slides || []).find((s) => s.id === slide.id);
          if (!prev || JSON.stringify(prev.contents) !== JSON.stringify(slide.contents)) {
            await api.updateSlideContents(lessonId, slide.id, slide.contents);
          }
        }

        const prevOrder = (lastSaved.slides || []).map((s) => s.id).join(',');
        const currOrder = lesson.slides.map((s) => s.id).join(',');
        if (prevOrder && prevOrder !== currOrder) {
          await api.reorderSlides(lessonId, lesson.slides.map((s) => s.id));
        }

        lastSavedRef.current = JSON.parse(JSON.stringify(lesson));
        dispatch({ type: 'savingState', value: 'saved' });
      } catch (e) {
        console.error('autosave failed', e);
        dispatch({ type: 'savingState', value: 'error', error: e.message });
      } finally {
        inflightRef.current = null;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state.lesson, state.ui.dirty, lessonId, dispatch, getState]);

  useEffect(() => {
    if (state.lesson && lastSavedRef.current === null) {
      lastSavedRef.current = JSON.parse(JSON.stringify(state.lesson));
    }
  }, [state.lesson]);
};
