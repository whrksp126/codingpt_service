import { useEditor, selectSelectedModule } from './state/EditorContext';
import ModuleInspector from './ModuleInspector';

const Inspector = () => {
  const { state, dispatch } = useEditor();
  const selectedModule = selectSelectedModule(state);

  if (!state.lesson) return null;

  if (!selectedModule) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-400">
        모듈을 선택하면 여기서 편집할 수 있어요
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <button
        type="button"
        onClick={() => dispatch({ type: 'select', slideId: state.selection.slideId, moduleId: null })}
        className="mb-2 text-left text-xs text-slate-500 hover:text-slate-900"
      >
        ← 슬라이드로 돌아가기
      </button>
      <ModuleInspector />
    </div>
  );
};

export default Inspector;
