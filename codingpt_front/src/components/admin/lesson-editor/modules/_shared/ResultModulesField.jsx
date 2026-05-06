import { getModuleDefinition } from '../_registry';
import { Section } from './SharedFields';

// 퀴즈 result.modules — 채점 후 등장하는 모듈 배열을 우측 폼에서 펼쳐 편집한다.
// 각 항목은 details/summary collapsible. 내부에 해당 모듈 타입의 FormView를 그대로 재사용.
const ADDABLE = ['characterSpeechBubble', 'paragraph', 'image', 'missionList'];

const ResultModulesField = ({ value, onChange }) => {
  const modules = value?.modules || [];
  const setModules = (next) => onChange({ ...(value || {}), modules: next });
  const updateAt = (i, next) => setModules(modules.map((m, idx) => (idx === i ? next : m)));
  const removeAt = (i) => setModules(modules.filter((_, idx) => idx !== i));
  const addOf = (type) => {
    const def = getModuleDefinition(type);
    const m = def?.defaultValue?.() || { type };
    m.id = m.id ?? Date.now();
    setModules([...modules, m]);
  };

  return (
    <Section title={`채점 후 등장 모듈 (${modules.length})`} defaultOpen={modules.length > 0}>
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        <span className="text-slate-500">+ 추가</span>
        {ADDABLE.map((t) => {
          const d = getModuleDefinition(t);
          if (!d) return null;
          return (
            <button
              key={t}
              type="button"
              onClick={() => addOf(t)}
              className="rounded bg-slate-100 px-2 py-0.5 hover:bg-slate-200"
            >
              {d.icon} {d.label}
            </button>
          );
        })}
      </div>
      {modules.map((m, i) => {
        const def = getModuleDefinition(m.type);
        const SubForm = def?.FormView;
        return (
          <details key={m.id ?? i} className="mb-2 rounded-lg border border-slate-200">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-xs font-semibold text-slate-600">
                <span className="mr-1">{def?.icon}</span>
                {def?.label || m.type}
                <span className="ml-1 text-slate-400">#{i + 1}</span>
              </span>
              <span
                className="flex items-center gap-2"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
              >
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="text-xs text-red-500 hover:underline"
                >
                  삭제
                </button>
              </span>
            </summary>
            <div className="border-t border-slate-200 p-2">
              {SubForm ? (
                <SubForm value={m} onChange={(next) => updateAt(i, next)} />
              ) : (
                <div className="text-xs text-amber-600">알 수 없는 모듈 타입: {m.type}</div>
              )}
            </div>
          </details>
        );
      })}
    </Section>
  );
};

export default ResultModulesField;
