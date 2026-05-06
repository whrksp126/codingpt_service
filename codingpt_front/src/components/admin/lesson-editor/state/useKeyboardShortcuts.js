import { useEffect } from 'react';
import { useEditor } from './EditorContext';

export const useKeyboardShortcuts = () => {
  const { dispatch } = useEditor();
  useEffect(() => {
    const handler = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      const tag = e.target?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if (isMod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (!isInput) {
          e.preventDefault();
          dispatch({ type: 'undo' });
        }
      } else if (isMod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        if (!isInput) {
          e.preventDefault();
          dispatch({ type: 'redo' });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);
};
