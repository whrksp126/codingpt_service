const lessonEditorService = require('../services/lessonEditorService');
const codeExecutionCacheService = require('../services/codeExecutionCacheService');
const codeFillExecutionUtils = require('../services/codeFillExecutionUtils');
const { successResponse, errorResponse } = require('../utils/response');

const handleError = (res, error) => {
  if (res.headersSent) {
    try { res.end(); } catch (_) {}
    return;
  }
  const statusCode = error.statusCode || 500;
  if (error.name === 'ValidationError' && error.issues) {
    return res.status(statusCode).json({
      success: false,
      message: error.message,
      issues: error.issues,
      timestamp: new Date().toISOString(),
    });
  }
  console.error('[lessonPrecompute] error:', error);
  return errorResponse(res, error, statusCode);
};

// terminal 모듈의 script[] (단일 탭 또는 files[i].script[]) 를 실행 가능한 문자열로 join.
// script 항목 중 type === 'input' 만 모아서 줄바꿈 결합 — output/error 라인은 학생용 표시 데이터일 뿐.
const buildCodeFromTerminalScript = (script) => {
  if (!Array.isArray(script)) return '';
  return script
    .filter((s) => s && (s.type === 'input' || s.type === undefined))
    .map((s) => String(s.text ?? s.value ?? ''))
    .join('\n');
};

// POST /api/lesson/:lessonId/slides/:slideId/modules/:moduleId/precompute
// body: { tabIndex? }  — terminal 다중 탭일 때만 의미 있음.
const precomputeModuleResult = async (req, res) => {
  try {
    const lessonId = parseInt(req.params.lessonId, 10);
    const slideId = parseInt(req.params.slideId, 10);
    const moduleId = req.params.moduleId;
    const tabIndex = req.body?.tabIndex;

    const updated = await lessonEditorService.patchSlideModule(
      lessonId, slideId, moduleId,
      async (mod, contents) => {
        if (mod.type === 'code') {
          const err = new Error("code 모듈 자체는 캐싱 대상이 아닙니다. 같은 슬라이드의 codeRunResult 모듈로 호출하세요.");
          err.statusCode = 400;
          throw err;
        }
        if (mod.type === 'simpleTerminal') {
          // linkedModuleId 가 가리키는 모듈 타입에 따라 분기:
          //   code → 단일 cachedResult 저장
          //   codeFillTheGapV2 → 별도 엔드포인트(precomputePermutations) 사용 안내
          if (mod.linkedModuleId == null) {
            const err = new Error('simpleTerminal.linkedModuleId 가 설정되지 않았습니다.');
            err.statusCode = 400;
            throw err;
          }
          const linked = (contents.modules || []).find(
            (m) => String(m.id) === String(mod.linkedModuleId),
          );
          if (!linked) {
            const err = new Error('linkedModuleId 가 가리키는 모듈을 찾을 수 없습니다.');
            err.statusCode = 400;
            throw err;
          }
          if (linked.type === 'code') {
            const first = (linked.files || [])[0];
            if (!first) {
              const err = new Error('연결된 code 모듈의 files[] 가 비어있습니다.');
              err.statusCode = 400;
              throw err;
            }
            const lang = String(first.language || 'javascript').toLowerCase();
            const norm = lang === 'js' ? 'javascript' : lang === 'py' ? 'python' : lang;
            const cachedResult = await codeExecutionCacheService.runOnce(first.content || '', norm);
            mod.cachedResult = cachedResult;
            return mod;
          }
          if (linked.type === 'codeFillTheGapV2') {
            const err = new Error('codeFillTheGapV2 연결은 precompute-permutations 엔드포인트를 사용하세요.');
            err.statusCode = 400;
            throw err;
          }
          const err = new Error(`simpleTerminal.linkedModuleId 가 가리키는 모듈 타입 미지원: ${linked.type}`);
          err.statusCode = 400;
          throw err;
        }
        if (mod.type === 'terminal') {
          // 다중 탭 (files[]) 우선, 단일 탭 (script[]) 그 다음.
          if (Array.isArray(mod.files) && mod.files.length > 0) {
            const i = Number.isInteger(tabIndex) ? tabIndex : 0;
            const tab = mod.files[i];
            if (!tab) {
              const err = new Error(`terminal.files[${i}] 가 없습니다.`);
              err.statusCode = 400;
              throw err;
            }
            const code = buildCodeFromTerminalScript(tab.script);
            const language = String(tab.language || mod.language || 'javascript').toLowerCase();
            const lang = language === 'js' ? 'javascript' : language === 'py' ? 'python' : language;
            const cachedResult = await codeExecutionCacheService.runOnce(code, lang);
            tab.cachedResult = cachedResult;
          } else {
            const code = buildCodeFromTerminalScript(mod.script);
            const language = String(mod.language || 'javascript').toLowerCase();
            const lang = language === 'js' ? 'javascript' : language === 'py' ? 'python' : language;
            const cachedResult = await codeExecutionCacheService.runOnce(code, lang);
            mod.cachedResult = cachedResult;
          }
          return mod;
        }
        const err = new Error(`이 모듈 타입은 단일 캐싱을 지원하지 않습니다: ${mod.type}`);
        err.statusCode = 400;
        throw err;
      },
    );

    successResponse(res, { contents: updated.contents, module: updated.module });
  } catch (error) {
    handleError(res, error);
  }
};

// POST /api/lesson/:lessonId/slides/:slideId/modules/:moduleId/precompute-permutations
// 호출 대상: 두 가지
//   1) simpleTerminal (평면 modules): linkedModuleId 가 codeFillTheGapV2 → plainCode 합성으로 실행
//   2) terminal (결과 영역): 부모 자동 탐색 + 토큰 치환 (기존 호환)
// 각 순열마다 실행 후 mod.cachedResults[answerKey] 에 누적.
//
// SSE 진행률 출력 후 마지막에 type:'done' 로 contents 전송.
// body: { tabIndex? } — 다중 탭 terminal 일 때 캐싱할 탭 인덱스 (기본 0)
const precomputePermutations = async (req, res) => {
  try {
    const lessonId = parseInt(req.params.lessonId, 10);
    const slideId = parseInt(req.params.slideId, 10);
    const moduleId = req.params.moduleId;
    const tabIndex = req.body?.tabIndex;

    // SSE 헤더
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sse = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };

    // 1) 슬라이드 로드 — 부모 자동 탐색 + 실행 코드 템플릿 추출에 필요
    const { Slide, LessonSlideMap } = require('../models');
    const map = await LessonSlideMap.findOne({ where: { lesson_id: lessonId, slide_id: slideId } });
    if (!map) { sse({ type: 'error', message: '슬라이드를 찾을 수 없습니다.' }); res.end(); return; }
    const slide = await Slide.findByPk(slideId);
    if (!slide?.contents) { sse({ type: 'error', message: '슬라이드 콘텐츠 없음' }); res.end(); return; }

    // 2) 호출된 모듈을 평면 modules 에서 먼저 찾아 simpleTerminal 분기 처리
    //    - simpleTerminal: linkedModuleId 가 가리키는 codeFillTheGapV2 의 plainCode 를 빈칸 답으로 합성해 실행
    //    - terminal (결과 영역 안): 기존대로 부모 자동 탐색 + 토큰 치환 (호환성)
    const flatModules = Array.isArray(slide.contents?.modules) ? slide.contents.modules : [];
    const callerMod = flatModules.find((m) => String(m.id) === String(moduleId));

    let parent;
    let blanks;
    let options;
    let execLang;
    let buildJobs; // (answers) => { key, code, language }

    if (callerMod && callerMod.type === 'simpleTerminal') {
      if (callerMod.linkedModuleId == null) {
        sse({ type: 'error', message: 'simpleTerminal.linkedModuleId 가 설정되지 않았습니다.' });
        res.end();
        return;
      }
      parent = codeFillExecutionUtils.findLinkedCodeFillForSimpleTerminal(slide.contents, callerMod.linkedModuleId);
      if (!parent) {
        sse({ type: 'error', message: 'linkedModuleId 가 가리키는 codeFillTheGapV2 모듈을 찾을 수 없습니다.' });
        res.end();
        return;
      }
      blanks = Array.isArray(parent.blanks) ? parent.blanks : [];
      options = Array.isArray(parent.interactionOptions) ? parent.interactionOptions : [];
      if (blanks.length === 0) {
        sse({ type: 'error', message: '연결된 빈칸 채우기 모듈에 빈칸이 없습니다.' });
        res.end();
        return;
      }
      const parentLang = String(parent.language || '').toLowerCase();
      execLang = parentLang === 'js' ? 'javascript' : parentLang === 'py' ? 'python' : parentLang;
      if (!codeFillExecutionUtils.isExecutableLanguage(execLang)) {
        sse({ type: 'error', message: `빈칸 채우기 언어는 실행 캐싱 불가: ${parent.language}` });
        res.end();
        return;
      }
      const plainCode = String(parent.plainCode || '');
      if (!plainCode.trim()) {
        sse({ type: 'error', message: '빈칸 채우기 plainCode 가 비어있습니다.' });
        res.end();
        return;
      }
      buildJobs = (answers) => ({
        key: codeFillExecutionUtils.buildAnswerKey(answers),
        code: codeFillExecutionUtils.synthesizeCodeForAnswers(plainCode, blanks, answers),
        language: execLang,
      });
    } else {
      // 결과 영역에 들어있는 terminal 모듈 — 기존 호환 경로
      const parentInfo = codeFillExecutionUtils.findCodeFillParentForTerminal(slide.contents, moduleId);
      if (!parentInfo) {
        sse({ type: 'error', message: '이 모듈은 codeFillTheGapV2 의 결과 영역에 속하지 않습니다.' });
        res.end();
        return;
      }
      parent = parentInfo.parent;
      blanks = Array.isArray(parent.blanks) ? parent.blanks : [];
      options = Array.isArray(parent.interactionOptions) ? parent.interactionOptions : [];
      if (blanks.length === 0) {
        sse({ type: 'error', message: '부모 빈칸 모듈에 빈칸이 없습니다.' });
        res.end();
        return;
      }
      const branchModules = parent[parentInfo.branch]?.modules || [];
      const terminalMod = branchModules.find((m) => String(m.id) === String(moduleId));
      if (!terminalMod || terminalMod.type !== 'terminal') {
        sse({ type: 'error', message: 'terminal 모듈을 찾을 수 없습니다.' });
        res.end();
        return;
      }
      const { code: codeTemplate, language: termLangRaw } = codeFillExecutionUtils.buildCodeTemplateFromTerminal(terminalMod, tabIndex);
      const termLang = String(termLangRaw || '').toLowerCase();
      execLang = termLang === 'js' ? 'javascript' : termLang === 'py' ? 'python' : termLang;
      if (!codeFillExecutionUtils.isExecutableLanguage(execLang)) {
        sse({ type: 'error', message: `터미널 실행 불가 언어입니다: ${termLangRaw}` });
        res.end();
        return;
      }
      if (!codeTemplate.trim()) {
        sse({ type: 'error', message: '터미널 스크립트가 비어있습니다.' });
        res.end();
        return;
      }
      buildJobs = (answers) => ({
        key: codeFillExecutionUtils.buildAnswerKey(answers),
        code: codeFillExecutionUtils.substituteTerminalTokens(codeTemplate, answers),
        language: execLang,
      });
    }

    // 4) 실행할 answers 목록 준비
    let answersList = codeFillExecutionUtils.generatePermutations(options, blanks.length);
    let mode = 'all';
    if (answersList.length === 0) {
      // 옵션 > 6 → 정답 1개만
      answersList = [codeFillExecutionUtils.buildCorrectAnswers(blanks)];
      mode = 'correct-only';
    }
    sse({ type: 'start', total: answersList.length, mode });

    // 5) 각 순열마다 코드 합성 → 실행
    const jobs = answersList.map((answers) => buildJobs(answers));
    const results = await codeExecutionCacheService.runMany(jobs, {
      concurrency: 2,
      onProgress: ({ done, total }) => sse({ type: 'progress', done, total }),
    });

    // 6) cachedResults patch — terminal 모듈에 저장 (중첩 검색은 patchSlideModule 이 자동 처리)
    const cachedResults = {};
    for (const r of results) {
      if (r?.result) cachedResults[r.key] = r.result;
    }
    const updated = await lessonEditorService.patchSlideModule(
      lessonId, slideId, moduleId,
      (m) => {
        m.cachedResults = { ...(m.cachedResults || {}), ...cachedResults };
        return m;
      },
    );

    sse({
      type: 'done',
      total: answersList.length,
      cachedCount: Object.keys(cachedResults).length,
      contents: updated.contents,
      module: updated.module,
    });
    res.end();
  } catch (error) {
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || String(error) })}\n\n`); } catch (_) {}
    try { res.end(); } catch (_) {}
    console.error('[lessonPrecompute] permutations error:', error);
  }
};

module.exports = {
  precomputeModuleResult,
  precomputePermutations,
};
