import { getModuleDefinition } from '../_registry';
import {
  collectBranch,
  replaceModuleAt,
  moveBranch,
  updateModuleAt,
} from './resultBranches';
import ConditionVisibilityBadge from './ConditionVisibilityBadge';
import VisibilityBadge from './VisibilityBadge';

// 퀴즈 모듈(객관식/OX/빈칸채우기) PreviewView 하단에 "채점 후" 결과 모듈을 모두/정답/오답 세 분기로 미리보기.
// 그룹 헤더("채점 후", "모두(n)" 등) 텍스트는 표시하지 않는다 — 분기 정보는 각 모듈 우측 외부에 통합 뱃지로만.
// 데이터: value.result.modules + 모듈별 condition, 또는 value.allResult / correctResult / incorrectResult 별도 키.

const BRANCH_LIST = ['all', 'correct', 'wrong'];

const ResultModulesPreview = ({ module, onModuleChange }) => {
  // 분기별로 항목을 모은 뒤 [모두 → 정답 → 오답] 순서로 평탄화. 각 항목은 자신의 branch 정보를 들고 다님.
  const branched = BRANCH_LIST.flatMap((branch) =>
    collectBranch(module, branch).map((it) => ({ ...it, branch })),
  );
  if (branched.length === 0) return null;

  return (
    <div className="mt-4 border-t border-dashed border-slate-300 pt-3">
      <div className="flex flex-col gap-3">
        {branched.map((it, i) => {
          const m = it.module;
          if (!m || m.enabled === false) return null;
          const def = getModuleDefinition(m.type);
          const Sub = def?.PreviewView;
          if (!Sub) {
            return (
              <div key={`${it.source}-${it.sourceIndex}-${i}`} className="rounded bg-amber-50 p-2 text-[11px] text-amber-700">
                알 수 없는 모듈: {m.type}
              </div>
            );
          }
          return (
            <div key={`${it.source}-${it.sourceIndex}-${i}`} className="relative w-full">
              <Sub
                module={m}
                onModuleChange={(next) => {
                  if (!onModuleChange) return;
                  onModuleChange(replaceModuleAt(module, it.source, it.sourceIndex, next));
                }}
              />
              {/* 일반 모듈의 VisibilityBadge 와 동일한 패턴으로 캔버스 우측 외부에 leak.
                  hasItemVisibility 모듈(말풍선 등)은 자체 PreviewView 에서 항목별 visibility 를 노출하므로 모듈 레벨 뱃지는 생략. */}
              <div
                className="absolute left-full top-1 z-20 ml-6 flex flex-col items-start gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <ConditionVisibilityBadge
                  branch={it.branch}
                  onBranchChange={(nextBranch) => {
                    if (!onModuleChange) return;
                    onModuleChange(moveBranch(module, it.source, it.sourceIndex, nextBranch));
                  }}
                />
                {!def?.hasItemVisibility && (
                  <VisibilityBadge
                    value={m.visibility}
                    onChange={(nextVisibility) => {
                      if (!onModuleChange) return;
                      onModuleChange(updateModuleAt(module, it.source, it.sourceIndex, { visibility: nextVisibility }));
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ResultModulesPreview;
