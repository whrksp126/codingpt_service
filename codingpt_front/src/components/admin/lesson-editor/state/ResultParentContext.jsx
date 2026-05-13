import { createContext, useContext } from 'react';

// 결과 모듈(result.modules) 안의 SubForm 이 부모 모듈을 알아야 할 때 사용.
// 예: codeFillTheGapV2 의 채점 후 터미널에서 부모의 blanks 수만큼 {{userAnswer_N}} 칩을 노출.
// 일반 슬라이드의 터미널 모듈은 Provider 가 없으므로 parentType === null → 칩 UI 숨김.
const ResultParentContext = createContext({ parentType: null, parentValue: null });

export const useResultParent = () => useContext(ResultParentContext);
export const ResultParentProvider = ResultParentContext.Provider;
