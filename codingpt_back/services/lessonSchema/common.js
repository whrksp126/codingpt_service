const { z } = require('zod');

const visibilitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duration'), time: z.number().nonnegative() }),
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
    timestamps: ttsTimestampsSchema.optional(),
    voiceId: z.string().optional(),
    modelId: z.string().optional(),
  }),
  // 인라인/파일참조: url 직접 보유 (objectstore 파일 + 사이드카 메타)
  z.object({
    url: z.string(),
    timestamps: ttsTimestampsSchema.optional(),
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
};
