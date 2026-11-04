import { z } from 'zod';
import {
  DESIGN_PREFERENCE_PROPOSAL_SOURCES,
  type DesignPreferenceProfile,
} from './types/designPreferenceProfile';

const nullableTrimmed = z
  .string()
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  });

const stringList = z
  .array(z.string().trim().min(1))
  .transform((items) => [...new Set(items)]);

export const designPreferenceProfileSchema = z.strictObject({
  appName: nullableTrimmed.refine((v) => v === null || v.length <= 120, {
    error: 'App name must be at most 120 characters.',
  }),
  productName: nullableTrimmed.refine((v) => v === null || v.length <= 120, {
    error: 'Product name must be at most 120 characters.',
  }),
  visualTone: z.enum(['professional', 'modern', 'compact']).nullable(),
  density: z.enum(['comfortable', 'compact']).nullable(),
  navigationPattern: z.enum(['sidebar', 'top']).nullable(),
  iconPreference: z.enum(['mui-outlined', 'custom']).nullable(),
  preferredPatterns: stringList,
  avoidedPatterns: stringList,
  logoPath: nullableTrimmed,
  faviconPath: nullableTrimmed,
});

export type DesignPreferenceProfileParseResult =
  | { ok: true; profile: DesignPreferenceProfile }
  | { ok: false; fieldErrors: Record<string, string> };

export function parseDesignPreferenceProfile(
  input: unknown,
): DesignPreferenceProfileParseResult {
  const result = designPreferenceProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'profile';
    fieldErrors[key] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}

export const designPreferenceProposalInputSchema = z.strictObject({
  proposedProfile: designPreferenceProfileSchema,
  source: z.enum(DESIGN_PREFERENCE_PROPOSAL_SOURCES),
  sourceRef: z.string().trim().min(1).nullable().optional(),
  feedbackExcerpt: z.string().trim().min(1).max(4000).nullable().optional(),
});
