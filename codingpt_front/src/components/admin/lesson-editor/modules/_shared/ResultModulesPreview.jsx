import ConditionBadge from './ConditionBadge';
import { getModuleDefinition } from '../_registry';

// 퀴즈 모듈(객관식/OX/빈칸채우기) PreviewView 하단에 "채점 후" result.modules 미리보기를 렌더.
// enabled === false 인 모듈은 데이터는 보존하되 프리뷰/RN 양쪽에서 숨김.
const ResultModulesPreview = ({ module, onModuleChange }) => {
  const result = module.result;
  const allMods = result?.modules || [];
  const mods = allMods.filter((m) => m && m.enabled !== false);
  if (mods.length === 0) return null;

  const updateResultModuleAt = (i, patch) => {
    if (!onModuleChange) return;
    const target = mods[i];
    const realIdx = allMods.findIndex((m) => m === target);
    if (realIdx === -1) return;
    const nextAll = allMods.map((m, idx) => (idx === realIdx ? { ...m, ...patch } : m));
    onModuleChange({ ...module, result: { ...(result || {}), modules: nextAll } });
  };
  const propagateResultModuleChange = (i, nextValue) => {
    if (!onModuleChange) return;
    const target = mods[i];
    const realIdx = allMods.findIndex((m) => m === target);
    if (realIdx === -1) return;
    const nextAll = allMods.map((m, idx) => (idx === realIdx ? { ...nextValue, id: m.id ?? nextValue.id } : m));
    onModuleChange({ ...module, result: { ...(result || {}), modules: nextAll } });
  };

  return (
    <div className="mt-4 border-t border-dashed border-slate-300 pt-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">채점 후</p>
      <div className="flex flex-col gap-3">
        {mods.map((m, i) => {
          const def = getModuleDefinition(m.type);
          const Sub = def?.PreviewView;
          if (!Sub) return null;
          return (
            <div key={m.id ?? i} className="relative w-full">
              <Sub
                module={m}
                onModuleChange={(next) => propagateResultModuleChange(i, next)}
              />
              <div
                className="absolute left-full top-1 z-20 ml-6 flex flex-col gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <ConditionBadge
                  value={m.condition}
                  onChange={(v) => updateResultModuleAt(i, { condition: v })}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ResultModulesPreview;
