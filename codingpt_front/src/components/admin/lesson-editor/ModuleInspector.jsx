import { useEditor, selectSelectedModule } from './state/EditorContext';
import { getModuleDefinition } from './modules/_registry';
import ExecutionModeToggle from './modules/_shared/ExecutionModeToggle';

const ModuleInspector = () => {
  const { state, dispatch } = useEditor();
  const module = selectSelectedModule(state);
  if (!module) return null;

  const def = getModuleDefinition(module.type);
  if (!def) {
    return (
      <div className="rounded bg-amber-50 p-2 text-xs text-amber-700">
        알 수 없는 모듈 타입: {module.type}
      </div>
    );
  }

  const FormView = def.FormView;
  const handleChange = (next) => {
    const { id, ...patch } = next;
    dispatch({
      type: 'updateModule',
      slideId: state.selection.slideId,
      moduleId: module.id,
      patch,
    });
  };

  const handleDelete = () => {
    if (!confirm('이 모듈을 삭제할까요?')) return;
    dispatch({
      type: 'removeModule',
      slideId: state.selection.slideId,
      moduleId: module.id,
    });
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2">
        <span className="text-sm font-semibold text-slate-900">
          <span className="mr-1">{def.icon}</span>
          {def.label}
        </span>
        <button
          type="button"
          onClick={handleDelete}
          className="text-xs text-red-500 hover:underline"
        >
          삭제
        </button>
      </div>
      <ExecutionModeToggle module={module} onChange={handleChange} />
      <FormView value={module} onChange={handleChange} />
    </div>
  );
};

export default ModuleInspector;
