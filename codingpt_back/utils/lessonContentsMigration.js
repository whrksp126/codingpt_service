// 슬라이드 contents 의 결과영역/legacy 모듈 구조를 평면 modules + trigger 메타로 변환.
//
// 변환 규칙:
//   1. codeRunResult → simpleTerminal (linkedModuleId = sourceCodeModuleId)
//   2. 퀴즈 모듈(codeFillTheGapV2/multipleChoice/trueFalseChoice) 의
//      allResult / correctResult / incorrectResult / legacy result.modules 안의 자식 모듈을
//      슬라이드 modules 평면 배열 끝으로 이동 + trigger.afterGrading 부여.
//      - 자식이 terminal 이면 simpleTerminal 로 변환 (linkedModuleId = 부모 퀴즈 id)
//      - 그 외 모듈은 그대로 유지하면서 trigger 만 부여
//   3. 변환 완료 후 퀴즈 모듈의 allResult/correctResult/incorrectResult/result 필드 삭제
//
// idempotent — 이미 변환된 contents 는 그대로 반환 (변환 대상 표지자가 없으면 no-op).

const hasLegacyStructure = (contents) => {
  if (!contents || !Array.isArray(contents.modules)) return false;
  return contents.modules.some((m) => {
    if (!m) return false;
    if (m.type === 'codeRunResult') return true;
    return !!(m.allResult || m.correctResult || m.incorrectResult || m.result);
  });
};

// 결과 영역 안에 있던 모듈을 평면 modules 로 옮기면서 trigger.afterGrading 부여.
const flattenResultModule = (sub, parentQuizId, branch) => {
  if (!sub || typeof sub !== 'object') return null;
  const triggerMeta = {
    type: 'afterGrading',
    sourceModuleId: parentQuizId,
    branch,
  };

  if (sub.type === 'terminal') {
    // terminal 결과 영역 모듈 → simpleTerminal (linkedModuleId = 부모 퀴즈)
    // 다중 탭(files[]) 의 첫 탭 또는 단일 탭(script[]) 의 코드는 부모 plainCode 와 다를 수 있으나,
    // 결과 영역 안의 terminal 은 항상 부모의 빈칸을 채워 실행하는 용도였으므로
    // 자체 script/files 는 버리고 linkedModuleId 만 부여.
    const next = {
      id: sub.id,
      type: 'simpleTerminal',
      linkedModuleId: parentQuizId,
      initialCommand: '',
      trigger: triggerMeta,
    };
    if (sub.height != null) next.height = sub.height;
    if (sub.executionMode) next.executionMode = sub.executionMode;
    if (sub.cachedResult) next.cachedResult = sub.cachedResult;
    if (sub.cachedResults) next.cachedResults = sub.cachedResults;
    if (sub.visibility) next.visibility = sub.visibility;
    return next;
  }

  // 그 외 모듈은 그대로 + trigger 부여. condition 은 trigger 로 흡수했으므로 제거.
  const { condition: _c, ...rest } = sub;
  return { ...rest, trigger: triggerMeta };
};

// 평면 modules 의 id 정규화:
//   1. id 가 numeric integer 가 아닌 경우 (string nanoid 등) → 새 numeric id 부여
//   2. id 가 중복된 경우 → 두 번째 등장부터 새 numeric id 부여
//   3. id 가 정상 numeric + 처음 등장이면 유지
// 결과영역 안 모듈 평면화 시 별개 카운터로 string id 가 끼어들거나 numeric id 가 충돌하던 케이스 보호.
// 어드민 SortableContext key prop 충돌(React 경고) 방지 + 학습/어드민 시각 일관성 (#0, #1, ...).
// trigger.sourceModuleId 가 가리키는 부모 퀴즈는 첫 등장 + numeric 인 경우가 일반적이라 안전.
const isCleanNumericId = (v) => {
  if (v == null) return false;
  const s = String(v);
  if (!/^-?\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n);
};

const ensureUniqueModuleIds = (contents) => {
  if (!contents || !Array.isArray(contents.modules)) return contents;
  const modules = contents.modules;
  const seen = new Set();
  const allIds = new Set();
  let nextId = 0;
  for (const m of modules) {
    if (m?.id == null) continue;
    if (isCleanNumericId(m.id)) {
      allIds.add(String(m.id));
      const n = Number(m.id);
      if (n >= nextId) nextId = n + 1;
    }
  }
  for (const m of modules) {
    if (m?.id == null) continue;
    const idStr = String(m.id);
    const needsNewId = !isCleanNumericId(m.id) || seen.has(idStr);
    if (needsNewId) {
      while (allIds.has(String(nextId))) nextId++;
      m.id = nextId;
      allIds.add(String(nextId));
      seen.add(String(nextId));
      nextId++;
    } else {
      seen.add(idStr);
    }
  }
  return contents;
};

const transformContents = (contents) => {
  // legacy 변환이 필요 없어도 id 충돌은 마이그된/원본 데이터에서 발생할 수 있으므로 ensureUniqueModuleIds 는 항상 적용.
  if (!hasLegacyStructure(contents)) return ensureUniqueModuleIds(contents);

  const oldModules = contents.modules;
  const newModules = [];

  for (const mod of oldModules) {
    if (!mod || typeof mod !== 'object') {
      newModules.push(mod);
      continue;
    }

    // codeRunResult → simpleTerminal
    if (mod.type === 'codeRunResult') {
      const next = {
        ...mod,
        type: 'simpleTerminal',
        linkedModuleId: mod.sourceCodeModuleId ?? null,
        initialCommand: mod.initialCommand || '',
      };
      delete next.sourceCodeModuleId;
      newModules.push(next);
      continue;
    }

    // 퀴즈 모듈 결과 영역 평면화
    const isQuiz = ['codeFillTheGapV2', 'multipleChoice', 'trueFalseChoice'].includes(mod.type);
    if (isQuiz && (mod.allResult || mod.correctResult || mod.incorrectResult || mod.result)) {
      const { allResult, correctResult, incorrectResult, result: legacyResult, ...quizClean } = mod;
      newModules.push(quizClean);

      const pushBranch = (arr, branch) => {
        if (!Array.isArray(arr)) return;
        for (const sub of arr) {
          const flattened = flattenResultModule(sub, mod.id, branch);
          if (flattened) newModules.push(flattened);
        }
      };
      pushBranch(allResult?.modules, 'all');
      pushBranch(correctResult?.modules, 'correct');
      pushBranch(incorrectResult?.modules, 'wrong');

      // legacy result.modules — 각 모듈의 condition 으로 branch 결정
      if (Array.isArray(legacyResult?.modules)) {
        for (const sub of legacyResult.modules) {
          const rawCond = typeof sub?.condition === 'object' ? sub?.condition?.type : sub?.condition;
          const branch = rawCond === 'correct' ? 'correct' : rawCond === 'wrong' ? 'wrong' : 'all';
          const flattened = flattenResultModule(sub, mod.id, branch);
          if (flattened) newModules.push(flattened);
        }
      }
      continue;
    }

    newModules.push(mod);
  }

  return ensureUniqueModuleIds({ ...contents, modules: newModules });
};

// 구 스키마(contents.sliders[]) 와 신 스키마(contents.modules) 모두 처리.
// 응답 직전 안전망에서 사용 — 마이그가 누락된 슬라이드도 응답 시점에 자동 변환.
const transformContentsDeep = (contents) => {
  if (!contents) return contents;
  if (Array.isArray(contents.sliders)) {
    return {
      ...contents,
      sliders: contents.sliders.map((s) => transformContents(s)),
    };
  }
  return transformContents(contents);
};

module.exports = {
  transformContents,
  transformContentsDeep,
  hasLegacyStructure,
  flattenResultModule,
  ensureUniqueModuleIds,
};
