// codeRunResult / terminal 모듈에서 캐시 우선 vs 항상 라이브 실행 토글.
// ModuleInspector 본 인스펙터 + ResultModulesField 안의 SubForm 양쪽에서 동일하게 사용.

const CACHEABLE_TYPES = new Set(['codeRunResult', 'terminal']);

const ExecutionModeToggle = ({ module, onChange }) => {
  if (!module || !CACHEABLE_TYPES.has(module.type)) return null;
  const mode = module.executionMode || 'cached';
  const set = (next) => onChange({ ...module, executionMode: next });

  return (
    <div className="mb-3 flex items-center justify-between rounded bg-slate-50 px-2 py-1.5 text-[11px]">
      <span className="text-slate-600">실행 모드</span>
      <div className="flex rounded border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => set('cached')}
          className={
            'px-2 py-0.5 ' + (mode === 'cached' ? 'bg-emerald-500 text-white' : 'text-slate-500 hover:bg-slate-100')
          }
          title="저장된 결과 즉시 표시 (캐시 미스 시 자동 라이브 실행)"
        >
          캐시 우선
        </button>
        <button
          type="button"
          onClick={() => set('live')}
          className={
            'px-2 py-0.5 ' + (mode === 'live' ? 'bg-amber-500 text-white' : 'text-slate-500 hover:bg-slate-100')
          }
          title="항상 실시간 실행 (캐시 무시)"
        >
          항상 라이브
        </button>
      </div>
    </div>
  );
};

export default ExecutionModeToggle;
export { CACHEABLE_TYPES };
