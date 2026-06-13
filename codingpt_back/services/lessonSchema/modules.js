const { z } = require('zod');
const {
  visibilitySchema,
  ttsSchema,
  iconSchema,
  characterRefSchema,
  cachedResultSchema,
  executionModeSchema,
  ideConfigSchema,
} = require('./common');

// 모듈 등장 트리거 — 퀴즈 채점 후 또는 actionButton 클릭 시 등장.
// sourceModuleId 는 같은 슬라이드 내 퀴즈 모듈(afterGrading) 또는 actionButton 모듈(afterButtonClick) id.
// branch 는 afterGrading 일 때만 의미 — 'all' 은 정/오답 무관, 미지정 시 'all' 로 간주.
const triggerSchema = z.object({
  type: z.enum(['afterGrading', 'afterButtonClick']),
  sourceModuleId: z.union([z.string(), z.number()]),
  branch: z.enum(['all', 'correct', 'wrong']).optional(),
}).passthrough();

const baseModuleFields = {
  id: z.union([z.string(), z.number()]),
  visibility: visibilitySchema.optional(),
  // 등장 트리거 — afterGrading/afterButtonClick. 이전의 condition 필드는 trigger.branch 로 흡수.
  trigger: triggerSchema.optional(),
};

const paragraphModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('paragraph'),
  content: z.string(),
  icon: iconSchema.optional(),
  iconHidden: z.boolean().optional(),
  tts: ttsSchema.optional(),
}).passthrough();

const quoteModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('quote'),
  content: z.string(),
}).passthrough();

const imageModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('image'),
  src: z.string().optional(),
  icon: z.string().optional(),
  size: z.union([
    z.enum(['sm', 'md', 'lg', 'xl']),
    z.object({ width: z.number(), height: z.number() }),
  ]).optional(),
  fit: z.enum(['contain', 'cover']).optional(),
  alignX: z.enum(['left', 'center', 'right']).optional(),
  aspectRatio: z.number().optional(),
  svgSize: z.number().optional(),
  svgFill: z.string().optional(),
  backgroundColor: z.string().optional(),
  backgroundShape: z.enum(['circle', 'square']).optional(),
  backgroundSize: z.number().optional(),
  containerHeightRatio: z.number().optional(),
  containerBackground: z.string().optional(),
  containerPadding: z.number().optional(),
  containerBorderRadius: z.number().optional(),
  containerShadow: z.boolean().optional(),
}).passthrough();

const webviewTabSchema = z.object({
  type: z.enum(['html', 'url']),
  content: z.string(),
});

const webviewModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('webview'),
  tabs: z.array(webviewTabSchema).min(1),
}).passthrough();

const codeFileSchema = z.object({
  language: z.enum(['html', 'css', 'javascript', 'java', 'python']),
  content: z.string(),
});

const codeModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('code'),
  files: z.array(codeFileSchema).min(1),
  height: z.number().optional(),
  ide: ideConfigSchema.optional(), // 모바일 IDE 연동
}).passthrough();

const speechSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.object({
    text: z.string(),
    color: z.string().optional(),
    marginBottom: z.number().optional(),
  }).optional(),
  content: z.string().optional(),
  image: z.string().optional(),
  showCharacter: z.boolean().optional(),
  tts: ttsSchema.optional(),
  visibility: visibilitySchema.optional(),
}).passthrough();

const characterSpeechBubbleModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('characterSpeechBubble'),
  displayType: z.enum(['full', 'profile']).optional(),
  position: z.enum(['left', 'right']).optional(),
  showCharacter: z.boolean().optional(),
  character: characterRefSchema.optional(),
  speeches: z.array(speechSchema).optional(),
  speech: speechSchema.optional(),
  tts: ttsSchema.optional(),
}).passthrough();

const missionListItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  text: z.string(),
  visibility: visibilitySchema.optional(),
});

const missionListModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('missionList'),
  title: z.string().optional(),
  items: z.array(missionListItemSchema),
  completed: z.boolean().optional(),
}).passthrough();

const tagDescriptionItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  tag: z.string(),
  title: z.string().optional(),
  description: z.string(),
}).passthrough();

const tagDescriptionListModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('tagDescriptionList'),
  items: z.array(tagDescriptionItemSchema),
}).passthrough();

const lottieModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('lottie'),
  src: z.string(),
  size: z.enum(['sm', 'md', 'lg', 'xl', 'xxl']).optional(),
}).passthrough();

// 어드민 에디터는 단일 탭(script[])/다중 탭(files[])/언어/높이/showInput 등
// 데이터 구조가 점진적으로 확장되므로 type 만 강제하고 나머지는 passthrough.
//
// 캐싱:
//   - cachedResult (또는 files[].cachedResult) — 일반 터미널 모듈의 1회성 결과
//   - cachedResults — codeFillTheGapV2 의 결과 영역(allResult/correctResult/incorrectResult.modules) 안에 있는
//                     터미널의 옵션 순열별 결과. answerKey → cachedResult dict
const terminalModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('terminal'),
  cachedResult: cachedResultSchema.optional(),
  cachedResults: z.record(cachedResultSchema).optional(),
  executionMode: executionModeSchema.optional(),
  ide: ideConfigSchema.optional(), // 모바일 IDE 연동
}).passthrough();

// 코드 또는 빈칸채우기 모듈의 실행 결과를 보여주는 통합 결과 모듈.
// linkedModuleId 가 'code'   → cachedResult (단일)
// linkedModuleId 가 'codeFillTheGapV2' → cachedResults dict (옵션 순열별, key=answerKey)
// initialCommand 는 출력 첫 줄 prompt 텍스트 (예: 'python index.py'), {{userAnswer_N}} 토큰 치환 지원.
const simpleTerminalModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('simpleTerminal'),
  linkedModuleId: z.union([z.string(), z.number()]).nullable().optional(),
  initialCommand: z.string().optional(),
  height: z.number().optional(),
  cachedResult: cachedResultSchema.optional(),
  cachedResults: z.record(cachedResultSchema).optional(),
  executionMode: executionModeSchema.optional(),
}).passthrough();

const multipleChoiceQuestionSchema = z.object({
  title: z.string().optional(),
  interactionOptions: z.array(z.object({ label: z.string() })),
  answer: z.object({
    answer: z.number().int(),
    userAnswer: z.number().int().nullable().optional(),
    isCorrect: z.boolean().nullable().optional(),
  }),
}).passthrough();

const multipleChoiceModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('multipleChoice'),
  questions: z.array(multipleChoiceQuestionSchema),
}).passthrough();

const trueFalseChoiceModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('trueFalseChoice'),
  questions: z.array(multipleChoiceQuestionSchema),
}).passthrough();

// codeFillTheGapV2 자체엔 캐싱 데이터가 없음 — 옵션 순열 결과는 결과 영역(allResult/correctResult/incorrectResult)에
// 들어간 terminal 모듈의 cachedResults 에 저장됨.
const codeFillTheGapV2ModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('codeFillTheGapV2'),
  ide: ideConfigSchema.optional(), // 모바일 IDE 연동
}).passthrough();

// 버튼 액션 — known type 은 executeCode / navigate_next_lesson / end_lesson.
// 모르는 type 도 passthrough 로 통과시켜 하위 호환 유지.
const actionSchema = z.object({
  type: z.string(),
}).passthrough();

const actionButtonItemSchema = z.object({
  text: z.string().optional(),
  role: z.enum(['gate', 'default']).optional(),
  icon: z.string().optional(),
  style: z.record(z.any()).optional(),
  action: actionSchema.optional(),
}).passthrough();

const actionButtonModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('actionButton'),
  action: actionSchema.optional(),
}).passthrough();

const actionButtonsModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('actionButtons'),
  buttons: z.array(actionButtonItemSchema),
}).passthrough();

const moduleSchema = z.discriminatedUnion('type', [
  paragraphModuleSchema,
  quoteModuleSchema,
  imageModuleSchema,
  webviewModuleSchema,
  codeModuleSchema,
  characterSpeechBubbleModuleSchema,
  missionListModuleSchema,
  tagDescriptionListModuleSchema,
  lottieModuleSchema,
  terminalModuleSchema,
  simpleTerminalModuleSchema,
  multipleChoiceModuleSchema,
  trueFalseChoiceModuleSchema,
  codeFillTheGapV2ModuleSchema,
  actionButtonModuleSchema,
  actionButtonsModuleSchema,
]);

const MODULE_TYPES = [
  'paragraph',
  'quote',
  'image',
  'webview',
  'code',
  'characterSpeechBubble',
  'missionList',
  'tagDescriptionList',
  'lottie',
  'terminal',
  'simpleTerminal',
  'multipleChoice',
  'trueFalseChoice',
  'codeFillTheGapV2',
  'actionButton',
  'actionButtons',
];

module.exports = {
  moduleSchema,
  MODULE_TYPES,
  triggerSchema,
  paragraphModuleSchema,
  quoteModuleSchema,
  imageModuleSchema,
  webviewModuleSchema,
  codeModuleSchema,
  characterSpeechBubbleModuleSchema,
  missionListModuleSchema,
  tagDescriptionListModuleSchema,
  lottieModuleSchema,
  terminalModuleSchema,
  simpleTerminalModuleSchema,
  multipleChoiceModuleSchema,
  trueFalseChoiceModuleSchema,
  codeFillTheGapV2ModuleSchema,
  actionButtonModuleSchema,
  actionButtonsModuleSchema,
};
