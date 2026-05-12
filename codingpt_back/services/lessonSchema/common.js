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
  z.object({
    url: z.string(),
    timestamps: ttsTimestampsSchema.optional(),
    enabled: z.boolean().optional(), // false면 RN에서 비활성 (데이터는 보존)
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

module.exports = {
  visibilitySchema,
  ttsSchema,
  ttsTimestampsSchema,
  iconSchema,
  backgroundSchema,
  autoAdvanceSchema,
  characterRefSchema,
  slideRoleSchema,
};
