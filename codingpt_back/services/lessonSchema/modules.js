const { z } = require('zod');
const {
  visibilitySchema,
  ttsSchema,
  iconSchema,
  characterRefSchema,
} = require('./common');

const baseModuleFields = {
  id: z.union([z.string(), z.number()]),
  visibility: visibilitySchema.optional(),
  condition: z.enum(['always', 'correct', 'wrong']).optional(),
};

const paragraphModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('paragraph'),
  content: z.string(),
  icon: iconSchema.optional(),
  iconHidden: z.boolean().optional(),
  tts: ttsSchema.optional(),
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

const cardModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('card'),
  variant: z.string().optional(),
  header: z.record(z.any()).optional(),
  content: z.record(z.any()).optional(),
}).passthrough();

const missionCardItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  icon: z.string().optional(),
  text: z.string(),
  badge: z.string().optional(),
  completed: z.boolean().optional(),
  checked: z.boolean().optional(),
});

const missionCardModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('missionCard'),
  title: z.string().optional(),
  rightText: z.string().optional(),
  missions: z.array(missionCardItemSchema).optional(),
  items: z.array(missionCardItemSchema).optional(),
  sparkle: z.boolean().optional(),
  completed: z.boolean().optional(),
}).passthrough();

const conceptCardItemSchema = z.object({
  code: z.string().optional(),
  codeStyle: z.object({
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
  }).optional(),
  description: z.string().optional(),
  chip: z.string().optional(),
  title: z.string().optional(),
}).passthrough();

const conceptCardModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('conceptCard'),
  items: z.array(conceptCardItemSchema),
}).passthrough();

const iconBadgeModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('iconBadge'),
  icon: z.string(),
  iconSize: z.number().optional(),
  iconColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  size: z.number().optional(),
}).passthrough();

const lottieModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('lottie'),
  src: z.string(),
  size: z.enum(['sm', 'md', 'lg', 'xl', 'xxl']).optional(),
}).passthrough();

const terminalEntrySchema = z.object({
  type: z.enum(['input', 'output', 'error']),
  content: z.string(),
});

const terminalModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('terminal'),
  script: z.array(terminalEntrySchema),
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

const codeFillTheGapV2ModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('codeFillTheGapV2'),
}).passthrough();

const dragAndDropQuizModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('dragAndDropQuiz'),
}).passthrough();

const clickSequenceQuizModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('clickSequenceQuiz'),
  question: z.string().optional(),
  slots: z.number().int().positive(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
  })),
  answer: z.array(z.string()),
  feedback: z.object({
    correct: z.object({ message: z.string() }).optional(),
    incorrect: z.object({ message: z.string() }).optional(),
  }).optional(),
  result: z.record(z.any()).optional(),
}).passthrough();

const actionButtonModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('actionButton'),
  action: z.record(z.any()).optional(),
}).passthrough();

const actionButtonsModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('actionButtons'),
  buttons: z.array(z.record(z.any())),
}).passthrough();

const highlightParagraphModuleSchema = z.object({
  ...baseModuleFields,
  type: z.literal('highlightParagraph'),
  content: z.string(),
  tts: ttsSchema.optional(),
}).passthrough();

const moduleSchema = z.discriminatedUnion('type', [
  paragraphModuleSchema,
  imageModuleSchema,
  webviewModuleSchema,
  codeModuleSchema,
  characterSpeechBubbleModuleSchema,
  missionListModuleSchema,
  tagDescriptionListModuleSchema,
  cardModuleSchema,
  missionCardModuleSchema,
  conceptCardModuleSchema,
  iconBadgeModuleSchema,
  lottieModuleSchema,
  terminalModuleSchema,
  multipleChoiceModuleSchema,
  trueFalseChoiceModuleSchema,
  codeFillTheGapV2ModuleSchema,
  dragAndDropQuizModuleSchema,
  clickSequenceQuizModuleSchema,
  actionButtonModuleSchema,
  actionButtonsModuleSchema,
  highlightParagraphModuleSchema,
]);

const MODULE_TYPES = [
  'paragraph',
  'image',
  'webview',
  'code',
  'characterSpeechBubble',
  'missionList',
  'tagDescriptionList',
  'card',
  'missionCard',
  'conceptCard',
  'iconBadge',
  'lottie',
  'terminal',
  'multipleChoice',
  'trueFalseChoice',
  'codeFillTheGapV2',
  'dragAndDropQuiz',
  'clickSequenceQuiz',
  'actionButton',
  'actionButtons',
  'highlightParagraph',
];

module.exports = {
  moduleSchema,
  MODULE_TYPES,
  paragraphModuleSchema,
  imageModuleSchema,
  webviewModuleSchema,
  codeModuleSchema,
  characterSpeechBubbleModuleSchema,
  missionListModuleSchema,
  tagDescriptionListModuleSchema,
  cardModuleSchema,
  missionCardModuleSchema,
  conceptCardModuleSchema,
  iconBadgeModuleSchema,
  lottieModuleSchema,
  terminalModuleSchema,
  multipleChoiceModuleSchema,
  trueFalseChoiceModuleSchema,
  codeFillTheGapV2ModuleSchema,
  dragAndDropQuizModuleSchema,
  clickSequenceQuizModuleSchema,
  actionButtonModuleSchema,
  actionButtonsModuleSchema,
  highlightParagraphModuleSchema,
};
