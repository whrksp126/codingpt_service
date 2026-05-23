import { useState, useCallback } from 'react';
import { useEditor } from './EditorContext';
import { precomputeModuleResult, precomputeModulePermutations } from '../../../../utils/lessonApi';

// code/terminal/codeRunResult 모듈 1개 캐싱 훅.
// 응답으로 받은 contents 를 통째로 슬라이드에 적용 + autosave lastSavedRef 동기화 → 중복 PUT 방지.
export const usePrecomputeModule = (lessonId, slideId, moduleId) => {
  const { dispatch, markSlidePersisted } = useEditor();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async ({ tabIndex } = {}) => {
    if (!lessonId || !slideId || !moduleId) return null;
    setRunning(true);
    setError(null);
    try {
      const data = await precomputeModuleResult(lessonId, slideId, moduleId, { tabIndex });
      if (data?.contents) {
        dispatch({ type: 'applyServerPersistedSlide', slideId, contents: data.contents });
        markSlidePersisted(slideId, data.contents);
      }
      return data;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    } finally {
      setRunning(false);
    }
  }, [lessonId, slideId, moduleId, dispatch, markSlidePersisted]);

  return { run, running, error };
};

// codeFillTheGapV2 옵션 순열 캐싱 훅. SSE 진행률.
export const usePrecomputePermutations = (lessonId, slideId, moduleId) => {
  const { dispatch, markSlidePersisted } = useEditor();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total } | { type:'start', total, mode }
  const [error, setError] = useState(null);

  const run = useCallback(async () => {
    if (!lessonId || !slideId || !moduleId) return null;
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const done = await precomputeModulePermutations(lessonId, slideId, moduleId, (evt) => {
        if (evt.type === 'start') setProgress({ done: 0, total: evt.total, mode: evt.mode });
        else if (evt.type === 'progress') setProgress((p) => ({ ...(p || {}), done: evt.done, total: evt.total }));
      });
      if (done?.contents) {
        dispatch({ type: 'applyServerPersistedSlide', slideId, contents: done.contents });
        markSlidePersisted(slideId, done.contents);
      }
      return done;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    } finally {
      setRunning(false);
    }
  }, [lessonId, slideId, moduleId, dispatch, markSlidePersisted]);

  return { run, running, progress, error };
};
