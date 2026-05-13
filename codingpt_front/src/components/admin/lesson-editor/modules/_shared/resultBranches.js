// 결과 모듈을 모두/정답/오답 세 분기로 모아 다루는 헬퍼.
// 데이터에는 두 가지 모양이 공존한다:
//   1. value.result.modules — 단일 배열 + 각 모듈에 condition('all'|'correct'|'wrong')
//   2. value.allResult.modules / value.correctResult.modules / value.incorrectResult.modules — 분기 키로 구분
// RN 런타임은 두 모양 모두 지원.
// 어드민 UI 는 사용자가 어느 모양으로 만들든 동일하게 "모두/정답/오답 탭"으로 보고 편집한다.

const normalizeCondition = (m) => {
  const raw = (typeof m?.condition === 'object' && m?.condition !== null) ? m.condition?.type : m?.condition;
  if (raw === 'all' || raw === 'always') return 'all';
  if (raw === 'wrong') return 'wrong';
  return 'correct';
};

const BRANCH_TO_KEY = {
  all: 'allResult',
  correct: 'correctResult',
  wrong: 'incorrectResult',
};

// 한 분기(모두/정답/오답)에 등장할 모듈 목록을 출처와 함께 반환.
// 항목: { module, source: 'allResult'|'correctResult'|'incorrectResult'|'result', sourceIndex }
export const collectBranch = (value, branch) => {
  const explicitKey = BRANCH_TO_KEY[branch];
  const explicit = (value?.[explicitKey]?.modules || []).map((m, i) => ({
    module: m,
    source: explicitKey,
    sourceIndex: i,
  }));
  const fromResult = (value?.result?.modules || [])
    .map((m, i) => ({ module: m, source: 'result', sourceIndex: i }))
    .filter((it) => normalizeCondition(it.module) === branch);
  return [...explicit, ...fromResult];
};

// 출처 별 즉시 변경 헬퍼.
export const updateModuleAt = (value, source, sourceIndex, patch) => {
  if (source === 'result') {
    const mods = (value?.result?.modules || []).map((m, i) => (i === sourceIndex ? { ...m, ...patch } : m));
    return { ...(value || {}), result: { ...(value?.result || {}), modules: mods } };
  }
  const mods = (value?.[source]?.modules || []).map((m, i) => (i === sourceIndex ? { ...m, ...patch } : m));
  return { ...(value || {}), [source]: { ...(value?.[source] || {}), modules: mods } };
};

export const replaceModuleAt = (value, source, sourceIndex, nextModule) => {
  if (source === 'result') {
    const mods = (value?.result?.modules || []).map((m, i) => (i === sourceIndex ? { ...nextModule, id: m.id ?? nextModule.id } : m));
    return { ...(value || {}), result: { ...(value?.result || {}), modules: mods } };
  }
  const mods = (value?.[source]?.modules || []).map((m, i) => (i === sourceIndex ? { ...nextModule, id: m.id ?? nextModule.id } : m));
  return { ...(value || {}), [source]: { ...(value?.[source] || {}), modules: mods } };
};

export const removeModuleAt = (value, source, sourceIndex) => {
  if (source === 'result') {
    const mods = (value?.result?.modules || []).filter((_, i) => i !== sourceIndex);
    return { ...(value || {}), result: { ...(value?.result || {}), modules: mods } };
  }
  const mods = (value?.[source]?.modules || []).filter((_, i) => i !== sourceIndex);
  return { ...(value || {}), [source]: { ...(value?.[source] || {}), modules: mods } };
};

// "다른 분기로 이동" — condition 변경 시 사용.
// result 출처는 condition 만 바꾸고 자리는 그대로(필터링이 변경). 분기 키 출처는 반대편 키로 이동.
export const moveBranch = (value, source, sourceIndex, nextBranch) => {
  if (source === 'result') {
    return updateModuleAt(value, source, sourceIndex, { condition: nextBranch });
  }
  const target = BRANCH_TO_KEY[nextBranch];
  if (source === target) return value;
  const list = value?.[source]?.modules || [];
  const moved = list[sourceIndex];
  if (!moved) return value;
  const remaining = list.filter((_, i) => i !== sourceIndex);
  const targetList = [...(value?.[target]?.modules || []), moved];
  return {
    ...(value || {}),
    [source]: { ...(value?.[source] || {}), modules: remaining },
    [target]: { ...(value?.[target] || {}), modules: targetList },
  };
};

// 새 모듈을 해당 분기에 추가 (분기 키 사용).
export const appendToBranch = (value, branch, mod) => {
  const key = BRANCH_TO_KEY[branch];
  const list = value?.[key]?.modules || [];
  return {
    ...(value || {}),
    [key]: { ...(value?.[key] || {}), modules: [...list, mod] },
  };
};
