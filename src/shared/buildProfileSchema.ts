/**
 * One Build profile schema for the settings form and the save route, so the
 * limits are stated once.
 */
import { z } from 'zod';
import { BUILD_PROFILE_ROLES, type BuildProfile } from './types/build';
import { BUILD_CAP_LIMITS } from './types/buildPreflight';
import { isSupportedAgentSkillPath, normalizeRepoRelativePath } from './skillPaths';

export const SUPPORT_CONTACT_REQUIRED_MESSAGE = 'At least one support contact is required.';
export const PARALLELISM_MAX_MESSAGE = `The maximum is ${BUILD_CAP_LIMITS.maxParallelism.max}.`;

function wholeNumberCap(limits: { min: number; max: number }, maxMessage?: string) {
  return z
    .number({ error: 'Enter a whole number.' })
    .int({ error: 'Enter a whole number.' })
    .min(limits.min, { error: `The minimum is ${limits.min}.` })
    .max(limits.max, { error: maxMessage ?? `The maximum is ${limits.max}.` })
    .nullable();
}

const skillPathSchema = z
  .string()
  .nullable()
  .transform((value) => (value && value.trim() ? normalizeRepoRelativePath(value) : null))
  .refine((value) => value === null || isSupportedAgentSkillPath(value), {
    error: 'Choose a skill file such as .cursor/skills/{name}/SKILL.md.',
  });

const modelSchema = z
  .string()
  .nullable()
  .transform((value) => (value && value.trim() ? value.trim() : null))
  .refine((value) => value === null || (value.length <= 200 && !/\s/.test(value)), {
    error: 'A model name has at most 200 characters and no spaces.',
  });

const roleSchema = z.strictObject({ skillPath: skillPathSchema, model: modelSchema });

const rolesShape = Object.fromEntries(BUILD_PROFILE_ROLES.map((role) => [role, roleSchema])) as Record<
  (typeof BUILD_PROFILE_ROLES)[number],
  typeof roleSchema
>;

const qualityManifestPathSchema = z
  .string()
  .nullable()
  .transform((value) => (value && value.trim() ? value.trim().replace(/\\/g, '/').replace(/^\/+/, '') : null))
  .refine((value) => value === null || !value.split('/').includes('..'), {
    error: 'Use a path inside the repository, without "..".',
  });

export const buildProfileSchema = z.strictObject({
  roles: z.strictObject(rolesShape),
  caps: z.strictObject({
    costUsd: z
      .number({ error: 'Enter an amount in dollars.' })
      .positive({ error: 'The cost cap must be more than 0.' })
      .nullable(),
    elapsedMinutesPerRevision: wholeNumberCap(BUILD_CAP_LIMITS.elapsedMinutesPerRevision),
    maxRevisions: wholeNumberCap(BUILD_CAP_LIMITS.maxRevisions),
    maxParallelism: wholeNumberCap(BUILD_CAP_LIMITS.maxParallelism, PARALLELISM_MAX_MESSAGE),
  }),
  qualityManifestPath: qualityManifestPathSchema,
  deployPipelineId: z
    .number({ error: 'Enter a pipeline ID.' })
    .int({ error: 'Enter a whole number.' })
    .positive({ error: 'Enter a pipeline ID.' })
    .nullable(),
  supportContactUserIds: z
    .array(z.string().trim().min(1))
    .transform((ids) => [...new Set(ids)])
    .refine((ids) => ids.length > 0, { error: SUPPORT_CONTACT_REQUIRED_MESSAGE }),
});

export type BuildProfileParseResult =
  | { ok: true; profile: BuildProfile }
  | { ok: false; fieldErrors: Record<string, string> };

/** Field errors keyed by dotted path (`caps.maxParallelism`, `supportContactUserIds`). */
export function parseBuildProfile(input: unknown): BuildProfileParseResult {
  const result = buildProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'profile';
    if (issue.code === 'unrecognized_keys') {
      const prefix = key === 'profile' ? '' : `${key}.`;
      for (const unknownKey of issue.keys) fieldErrors[`${prefix}${unknownKey}`] ??= 'This field is not allowed.';
      continue;
    }
    fieldErrors[key] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}
