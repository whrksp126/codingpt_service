// 빈칸채우기(codeFillTheGapV2) 모듈의 plainCode + blanks + 특정 학생 답 → 실행 가능한 코드 합성.
// composeContent(codeFillUtils.js, 프론트) 는 HTML 합성(Prism 토큰 + input 마커)이라 별개 함수.
//
// answerKey 규칙: JSON.stringify(answers.map((a, i) => [i, a.userAnswer]))
// → 학생 RN/관리자/백엔드 모두 동일하게 생성해야 lookup 가능.

const EXECUTABLE_LANGUAGES = new Set(['javascript', 'python']);

const isExecutableLanguage = (language) => EXECUTABLE_LANGUAGES.has(String(language || '').toLowerCase());

// blanks: [{ start, end, correctAnswer, _key? }, ...]  (좌→우 정렬 가정 — reorderBlanks 결과)
// answers: [{ userAnswer }, ...]  (blanks 와 같은 인덱스)
// → plainCode 의 [start, end) 범위에 정확히 userAnswer 텍스트를 끼워넣은 문자열 반환.
const synthesizeCodeForAnswers = (plainCode, blanks, answers) => {
  if (typeof plainCode !== 'string') return '';
  if (!Array.isArray(blanks) || !Array.isArray(answers)) return plainCode;

  // offset 보존을 위해 뒤에서 앞으로 치환
  const ordered = blanks
    .map((b, i) => ({ b, i }))
    .sort((a, x) => x.b.start - a.b.start);

  let out = plainCode;
  for (const { b, i } of ordered) {
    const replacement = answers[i]?.userAnswer ?? '';
    out = out.slice(0, b.start) + String(replacement) + out.slice(b.end);
  }
  return out;
};

const buildAnswerKey = (answers) => JSON.stringify(
  (answers || []).map((a, i) => [i, a?.userAnswer ?? null]),
);

// 옵션 수 N, 빈칸 수 M 일 때 순열 P(N, M).
// 옵션 7개 이상이면 빈 배열 반환 — 호출 측에서 정답 1개만 실행하는 분기로 전환.
const generatePermutations = (interactionOptions, blanksLen) => {
  const options = (interactionOptions || []).map((o, idx) => ({ idx, value: o?.value ?? '' }));
  if (options.length === 0 || blanksLen === 0) return [];
  if (options.length > 6) return [];

  const results = [];
  const used = new Array(options.length).fill(false);
  const current = [];

  const dfs = () => {
    if (current.length === blanksLen) {
      results.push(current.map((opt) => ({ userAnswer: opt.value })));
      return;
    }
    for (let i = 0; i < options.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(options[i]);
      dfs();
      current.pop();
      used[i] = false;
    }
  };
  dfs();
  return results;
};

// 정답 1개 조합 (옵션 7개 이상이거나 fallback 용)
const buildCorrectAnswers = (blanks) => (blanks || []).map((b) => ({ userAnswer: b?.correctAnswer ?? '' }));

// terminal 모듈의 코드 템플릿(예: `console.log({{userAnswer_0}} + 1);`) 에서 토큰을
// 특정 answers 의 userAnswer 로 치환해 실행 가능한 코드 생성.
//
// RN LessonLearningScreenV5.tsx 의 replacePlaceholders 와 동일 알고리즘.
const substituteTerminalTokens = (codeTemplate, answers) => {
  if (typeof codeTemplate !== 'string') return '';
  return codeTemplate.replace(/\{\{userAnswer_(\d+)\}\}/g, (match, idx) => {
    const i = parseInt(idx, 10);
    if (Number.isNaN(i) || !answers || !answers[i]) return match;
    return String(answers[i].userAnswer ?? '');
  });
};

// simpleTerminal.linkedModuleId 가 가리키는 같은 슬라이드의 codeFillTheGapV2 모듈을 찾는다.
// terminal 모듈의 자동 탐색(findCodeFillParentForTerminal)과 달리 명시적 참조 — 결과 영역 중첩과 무관.
const findLinkedCodeFillForSimpleTerminal = (contents, linkedModuleId) => {
  const modules = Array.isArray(contents?.modules) ? contents.modules : [];
  return modules.find(
    (m) => m?.type === 'codeFillTheGapV2' && String(m.id) === String(linkedModuleId),
  ) || null;
};

// 같은 슬라이드 안에서 terminal 모듈의 부모 codeFillTheGapV2 자동 탐색.
// codeFillTheGapV2 의 result/allResult/correctResult/incorrectResult.modules 안에 들어있는 경우 매치.
const findCodeFillParentForTerminal = (contents, terminalModuleId) => {
  const modules = Array.isArray(contents?.modules) ? contents.modules : [];
  for (const m of modules) {
    if (m?.type !== 'codeFillTheGapV2') continue;
    for (const bucket of ['allResult', 'correctResult', 'incorrectResult', 'result']) {
      const arr = m?.[bucket]?.modules;
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (String(t?.id) === String(terminalModuleId)) {
            return { parent: m, branch: bucket };
          }
        }
      }
    }
  }
  return null;
};

// terminal 모듈의 script[] / files[i].script[] 에서 실행할 코드 문자열을 모음.
// 단일 탭: script[] 의 input 라인. 다중 탭: 활성 탭 또는 지정 탭(tabIndex)의 script[].
const buildCodeTemplateFromTerminal = (terminalModule, tabIndex) => {
  if (!terminalModule) return { code: '', language: 'javascript' };
  if (Array.isArray(terminalModule.files) && terminalModule.files.length > 0) {
    const i = Number.isInteger(tabIndex) ? tabIndex : 0;
    const tab = terminalModule.files[i] || terminalModule.files[0];
    const code = (tab?.script || []).filter((s) => !s?.type || s.type === 'input').map((s) => s?.text ?? '').join('\n');
    return { code, language: tab?.language || terminalModule.language || 'js' };
  }
  const code = (terminalModule.script || []).filter((s) => !s?.type || s.type === 'input').map((s) => s?.text ?? '').join('\n');
  return { code, language: terminalModule.language || 'js' };
};

module.exports = {
  isExecutableLanguage,
  synthesizeCodeForAnswers,
  buildAnswerKey,
  generatePermutations,
  buildCorrectAnswers,
  substituteTerminalTokens,
  findCodeFillParentForTerminal,
  findLinkedCodeFillForSimpleTerminal,
  buildCodeTemplateFromTerminal,
};
