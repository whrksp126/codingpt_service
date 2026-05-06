const { z } = require('zod');
const common = require('./common');
const modules = require('./modules');
const presets = require('./slidePresets');
const character = require('./character');

const slideContentsSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  role: common.slideRoleSchema.optional(),
  background: common.backgroundSchema.optional(),
  autoAdvance: common.autoAdvanceSchema.optional(),
  modules: z.array(modules.moduleSchema).default([]),
  schemaVersion: z.string().optional(),
}).passthrough();

const lessonMetaSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().optional(),
  description: z.string().nullable().optional(),
  default_character: z.string().nullable().optional(),
  characters: z.array(z.string()).optional(),
  meta: z.record(z.any()).optional(),
  published_at: z.union([z.string(), z.date(), z.null()]).optional(),
}).passthrough();

module.exports = {
  ...common,
  ...modules,
  ...presets,
  ...character,
  slideContentsSchema,
  lessonMetaSchema,
};
