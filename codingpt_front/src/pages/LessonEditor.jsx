import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../utils/lessonApi';
import { EditorProvider, useEditor } from '../components/admin/lesson-editor/state/EditorContext';
import { useAutosave } from '../components/admin/lesson-editor/state/useAutosave';
import { useKeyboardShortcuts } from '../components/admin/lesson-editor/state/useKeyboardShortcuts';
import EditorTopBar from '../components/admin/lesson-editor/EditorTopBar';
import { SlideListHeader, SlideListBody } from '../components/admin/lesson-editor/SlideList';
import SlideCanvas from '../components/admin/lesson-editor/SlideCanvas';
import Inspector from '../components/admin/lesson-editor/Inspector';
import ModulePopover from '../components/admin/lesson-editor/ModulePopover';

const EditorShell = ({ lessonId }) => {
  const { state, dispatch } = useEditor();
  const [loadError, setLoadError] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const lesson = await api.getLesson(lessonId);
        if (!cancelled) dispatch({ type: 'load', lesson });
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [lessonId, dispatch]);

  useAutosave(lessonId);
  useKeyboardShortcuts();

  if (loadError) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100">
        <div className="rounded-lg bg-red-50 p-6 text-sm text-red-700">
          레슨을 불러올 수 없습니다: {loadError}
        </div>
      </div>
    );
  }
  if (!state.lesson) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">
        불러오는 중…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <EditorTopBar />
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-72 flex-col border-r border-slate-200 bg-white">
          <SlideListHeader lessonId={lessonId} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SlideListBody />
          </div>
        </aside>

        <main className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-auto bg-slate-100">
            <SlideCanvas onOpenPalette={() => setPaletteOpen(true)} />
          </div>
          {paletteOpen && <ModulePopover onClose={() => setPaletteOpen(false)} />}
        </main>

        <aside className="w-80 border-l border-slate-200 bg-white">
          <Inspector />
        </aside>
      </div>
    </div>
  );
};

const LessonEditor = () => {
  const { id } = useParams();
  const lessonId = Number(id);
  return (
    <EditorProvider>
      <EditorShell lessonId={lessonId} />
    </EditorProvider>
  );
};

export default LessonEditor;
