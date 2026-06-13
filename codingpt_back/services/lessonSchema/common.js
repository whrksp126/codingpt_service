const { z } = require('zod');

const visibilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duration'), time: z.number().nonnegative() }),
  // ttsHold: TTS 재생 종료(onEnd) 후 time(ms) 만큼 더 유지하고 다음으로 진행.
  // duration 과 달리 실제 재생 종료를 기다리므로 TTS 가 잘리지 않는다.
  z.object({ type: z.literal('ttsHold'), time: z.number().nonnegative() }),
  z.object({ type: z.literal('step'), value: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('time'),
    showDelay: z.number().nonnegative().optional(),
    hideDelay: z.number().nonnegative().optional(),
    shrinkDelay: z.number().nonnegative().optional(),
    shrinkTo: z.string().optional(),
    enterAnimation: z.string().optional(),
    exitAnimation: z.string().optional(),
  }),
]);

const ttsTimestampWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
});

const ttsTimestampCharSchema = z.object({
  char: z.string(),
  start: z.number(),
  end: z.number(),
});

const ttsTimestampsSchema = z.object({
  version: z.string().optional(),
  total_duration: z.number().optional(),
  alignment: z.object({
    words: z.array(ttsTimestampWordSchema).optional(),
    characters: z.array(ttsTimestampCharSchema).optional(),
  }).optional(),
  words: z.array(ttsTimestampWordSchema).optional(),
  characters: z.array(ttsTimestampCharSchema).optional(),
}).passthrough();

const ttsSchema = z.union([
  z.string(),
  // 중앙 라이브러리 참조: 저장 시 { assetId, enabled? } 만 보존(서버가 dehydrate).
  // 로드/런타임 시 url·timestamps 가 하이드레이션되어 함께 올 수 있으므로 optional 로 허용.
  z.object({
    assetId: z.number().int(),
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    // Gemini TTS 는 타임스탬프를 제공하지 않아 null 로 들어올 수 있음 → nullish 허용.
    timestamps: ttsTimestampsSchema.nullish(),
    voiceId: z.string().optional(),
    modelId: z.string().optional(),
  }),
  // 인라인/파일참조: url 직접 보유 (objectstore 파일 + 사이드카 메타)
  z.object({
    url: z.string(),
    timestamps: ttsTimestampsSchema.nullish(), // Gemini TTS → null 허용
    enabled: z.boolean().optional(), // false면 RN에서 비활성 (데이터는 보존)
    voiceId: z.string().optional(),
    modelId: z.string().optional(),
  }),
]);

const iconSchema = z.object({
  name: z.string(),
  size: z.number().optional(),
  fill: z.string().optional(),
  backgroundSize: z.number().optional(),
  backgroundColor: z.string().optional(),
});

const backgroundSchema = z.object({
  colors: z.array(z.string()).min(1),
  locations: z.array(z.number()).optional(),
  angle: z.number().optional(),
});

const autoAdvanceSchema = z.object({
  enabled: z.boolean(),
  trigger: z.enum(['tts', 'duration', 'step']).optional(),
  duration: z.number().optional(),
  minDuration: z.number().optional(),
  triggerAfterInteraction: z.boolean().optional(),
  triggerAfterCorrectAnswer: z.boolean().optional(),
});

const characterRefSchema = z.object({
  image: z.string(),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
});

const slideRoleSchema = z.enum(['intro', 'goal', 'concept', 'quiz', 'ending', 'custom']);

// 코드 실행 결과 캐시 — codeRunResult/terminal/codeFillTheGapV2 모듈에 인라인 저장됨.
// codeHash 가 현재 코드의 해시와 다르면 학생 RN 은 자동 live fallback.
const cachedResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().optional(),
  codeHash: z.string(),
  language: z.string(),
  executedAt: z.string(),
}).passthrough();

const executionModeSchema = z.enum(['cached', 'live']);

// 모바일 IDE 연동 설정 — code/terminal/codeFillTheGapV2 모듈에 인라인 저장됨.
// 실제 프로젝트 소스(폴더/파일/이미지)는 objectstore `codingpt/execute/ide/<projectId>/` 에 보관되고,
// 모듈은 이 메타(이름/식별자/진입파일)만 들고 있는다.
// 하이라이트 구간 — Monaco 선택영역(1-based line/column) 그대로 보존, 학습자 IDE 에서 동일 구간 강조.
const ideHighlightRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

const ideConfigSchema = z.object({
  enabled: z.boolean().optional(),
  projectName: z.string().optional(), // 탐색기 작업영역 루트 이름 (예: 'html 기초')
  projectId: z.string().optional(),   // 안정적 식별자 — basePath = ide/<projectId>
  entryFile: z.string().optional(),   // 브라우저 프리뷰 진입 파일 (기본 index.html)
  // IDE 소스 관리 모달에서 저장한 "보기 상태" — 학습자 IDE 가 그대로 재현.
  initialTabs: z.array(z.string()).optional(), // 열어둘 탭(순서 유지)
  activeTab: z.string().optional(),            // 활성 탭
  // 파일별 하이라이트 구간 목록 (git diff 처럼 핵심 영역 강조). { '경로': [range, ...] }
  highlights: z.record(z.string(), z.array(ideHighlightRangeSchema)).optional(),
}).passthrough();

module.exports = {
  visibilitySchema,
  ttsSchema,
  ttsTimestampsSchema,
  iconSchema,
  backgroundSchema,
  autoAdvanceSchema,
  characterRefSchema,
  slideRoleSchema,
  cachedResultSchema,
  executionModeSchema,
  ideConfigSchema,
};
