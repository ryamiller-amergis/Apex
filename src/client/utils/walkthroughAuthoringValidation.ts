import { z } from 'zod';
import {
  validateRegisteredAnchor,
  type WalkthroughAnchorRegistryEntry,
} from '../../shared/walkthroughAnchors';
import { isWalkthroughRoute } from '../../shared/walkthroughRoutes';
import type { WalkthroughAnchorPlacement } from '../../shared/types/walkthrough';

export function isValidImageUrl(value: string): boolean {
  if (!value.trim()) return true;
  const lower = value.trim().toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('javascript:')) return false;
  return /^(\/|https:\/\/)/i.test(value.trim());
}

export function isValidInAppRoute(value: string): boolean {
  return isWalkthroughRoute(value);
}

function buildAnchorFormSchema(catalog: readonly WalkthroughAnchorRegistryEntry[]) {
  return z
    .object({
      key: z.string(),
      targetRoute: z.string(),
      placement: z.string(),
    })
    .superRefine((anchor, ctx) => {
      const hasAny = anchor.key || anchor.targetRoute || anchor.placement;
      if (!hasAny) return;
      const result = validateRegisteredAnchor(
        {
          key: anchor.key || '',
          targetRoute: anchor.targetRoute || '',
          placement: (anchor.placement || 'bottom') as WalkthroughAnchorPlacement,
        },
        catalog,
      );
      if (result.ok === false) {
        for (const err of result.errors) {
          const fieldName = err.field.split('.')[1] ?? 'key';
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err.message,
            path: [fieldName],
          });
        }
      }
    });
}

export function createWalkthroughStepFormSchema(
  catalog: readonly WalkthroughAnchorRegistryEntry[] = [],
) {
  const anchorFormSchema = buildAnchorFormSchema(catalog);
  return z
    .object({
      id: z.string(),
      heading: z.string(),
      bodyMarkdown: z.string(),
      route: z.string().nullable().optional(),
      imageUrl: z.string().nullable().optional(),
      imageAlt: z.string().optional(),
      ctaLabel: z.string().nullable().optional(),
      ctaRoute: z.string().nullable().optional(),
      anchorKey: z.string().optional(),
      anchorTargetRoute: z.string().optional(),
      anchorPlacement: z.string().optional(),
    })
    .superRefine((step, ctx) => {
      if (step.route && !isValidInAppRoute(step.route)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Step route must be selected from the Walkthrough route catalog',
          path: ['route'],
        });
      }
      if (step.imageUrl && step.imageUrl.trim()) {
        if (!isValidImageUrl(step.imageUrl)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Image URL must be HTTPS or a root-relative path',
            path: ['imageUrl'],
          });
        }
        if (!step.imageAlt?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Image alt text is required when an image URL is set',
            path: ['imageAlt'],
          });
        }
      }

      const hasCtaLabel = Boolean(step.ctaLabel?.trim());
      const hasCtaRoute = Boolean(step.ctaRoute?.trim());
      if (hasCtaLabel !== hasCtaRoute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CTA label and route must both be set or both empty',
          path: hasCtaLabel ? ['ctaRoute'] : ['ctaLabel'],
        });
      }
      if (hasCtaRoute && step.ctaRoute && !isValidInAppRoute(step.ctaRoute)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CTA route must be selected from the Walkthrough route catalog',
          path: ['ctaRoute'],
        });
      }

      const anchorResult = anchorFormSchema.safeParse({
        key: step.anchorKey ?? '',
        targetRoute: step.anchorTargetRoute ?? '',
        placement: step.anchorPlacement ?? '',
      });
      if (!anchorResult.success) {
        for (const issue of anchorResult.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: issue.message,
            path: issue.path,
          });
        }
      }
    });
}

export function createWalkthroughDraftFormSchema(
  catalog: readonly WalkthroughAnchorRegistryEntry[] = [],
) {
  return z
    .object({
      internalName: z.string().min(1, 'Internal name is required'),
      userTitle: z.string().min(1, 'User title is required'),
      whyItMatters: z.string(),
      priority: z.number().int(),
      isRequired: z.boolean(),
      projects: z.array(z.string().min(1)).min(1, 'Select at least one project'),
      groupId: z.string().nullable().optional(),
      steps: z
        .array(createWalkthroughStepFormSchema(catalog))
        .max(20, 'A Walkthrough may have at most 20 steps'),
    })
    .superRefine((values, ctx) => {
      if (values.groupId && values.projects.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A group filter is only available when exactly one project is selected',
          path: ['groupId'],
        });
      }
    });
}

/** Default schema (empty catalog) — prefer `createWalkthroughDraftFormSchema(catalog)`. */
export const walkthroughStepFormSchema = createWalkthroughStepFormSchema([]);
export const walkthroughDraftFormSchema = createWalkthroughDraftFormSchema([]);

export type WalkthroughStepFormValues = z.infer<ReturnType<typeof createWalkthroughStepFormSchema>>;
export type WalkthroughDraftFormValues = z.infer<ReturnType<typeof createWalkthroughDraftFormSchema>>;

export function createEmptyStep(ordinal: number): WalkthroughStepFormValues {
  return {
    id: `step-${Date.now()}-${ordinal}`,
    heading: '',
    bodyMarkdown: '',
    route: null,
    imageUrl: null,
    imageAlt: '',
    ctaLabel: null,
    ctaRoute: null,
    anchorKey: '',
    anchorTargetRoute: '',
    anchorPlacement: '',
  };
}

export function stepFormToInput(step: WalkthroughStepFormValues, ordinal: number) {
  const hasAnchor = Boolean(step.anchorKey?.trim());
  return {
    id: step.id,
    ordinal,
    heading: step.heading.trim() || `Step ${ordinal + 1}`,
    bodyMarkdown: step.bodyMarkdown,
    route: step.route?.trim() ? step.route.trim() : null,
    imageUrl: step.imageUrl?.trim() ? step.imageUrl.trim() : null,
    imageAlt: step.imageAlt?.trim() ? step.imageAlt.trim() : null,
    ctaLabel: step.ctaLabel?.trim() ? step.ctaLabel.trim() : null,
    ctaRoute: step.ctaRoute?.trim() ? step.ctaRoute.trim() : null,
    anchor: hasAnchor
      ? {
          key: step.anchorKey!.trim(),
          targetRoute: step.anchorTargetRoute!.trim(),
          placement: step.anchorPlacement as WalkthroughAnchorPlacement,
        }
      : null,
  };
}

export function draftFormToCreateCommand(form: WalkthroughDraftFormValues) {
  return {
    internalName: form.internalName.trim(),
    userTitle: form.userTitle.trim(),
    whyItMatters: form.whyItMatters,
    priority: form.priority,
    isRequired: form.isRequired,
    targeting: {
      projects: form.projects,
      groupId: form.projects.length === 1 ? form.groupId || null : null,
    },
    steps: form.steps.map((step, index) => stepFormToInput(step, index)),
  };
}

