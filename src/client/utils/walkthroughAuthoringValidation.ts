import { z } from 'zod';
import { validateRegisteredAnchor } from '../../shared/walkthroughAnchors';
import type { WalkthroughAnchorPlacement } from '../../shared/types/walkthrough';

const IN_APP_ROUTE_RE = /^\/[A-Za-z0-9/_-]*$/;

export function isValidImageUrl(value: string): boolean {
  if (!value.trim()) return true;
  const lower = value.trim().toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('javascript:')) return false;
  return /^(\/|https:\/\/)/i.test(value.trim());
}

export function isValidInAppRoute(value: string): boolean {
  return IN_APP_ROUTE_RE.test(value);
}

const anchorFormSchema = z
  .object({
    key: z.string(),
    targetRoute: z.string(),
    placement: z.string(),
  })
  .superRefine((anchor, ctx) => {
    const hasAny = anchor.key || anchor.targetRoute || anchor.placement;
    if (!hasAny) return;
    const result = validateRegisteredAnchor({
      key: anchor.key || '',
      targetRoute: anchor.targetRoute || '',
      placement: (anchor.placement || 'bottom') as WalkthroughAnchorPlacement,
    });
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

export const walkthroughStepFormSchema = z
  .object({
    id: z.string(),
    heading: z.string(),
    bodyMarkdown: z.string(),
    imageUrl: z.string().nullable().optional(),
    imageAlt: z.string().optional(),
    ctaLabel: z.string().nullable().optional(),
    ctaRoute: z.string().nullable().optional(),
    anchorKey: z.string().optional(),
    anchorTargetRoute: z.string().optional(),
    anchorPlacement: z.string().optional(),
  })
  .superRefine((step, ctx) => {
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
        message: 'CTA route must be a root-relative in-app path',
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

export const walkthroughDraftFormSchema = z.object({
  internalName: z.string().min(1, 'Internal name is required'),
  userTitle: z.string().min(1, 'User title is required'),
  whyItMatters: z.string(),
  priority: z.number().int(),
  project: z.string().min(1, 'Project is required'),
  groupId: z.string().nullable().optional(),
  steps: z.array(walkthroughStepFormSchema).max(20, 'A Walkthrough may have at most 20 steps'),
});

export type WalkthroughStepFormValues = z.infer<typeof walkthroughStepFormSchema>;
export type WalkthroughDraftFormValues = z.infer<typeof walkthroughDraftFormSchema>;

export function createEmptyStep(ordinal: number): WalkthroughStepFormValues {
  return {
    id: `step-${Date.now()}-${ordinal}`,
    heading: '',
    bodyMarkdown: '',
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
    imageUrl: step.imageUrl?.trim() ? step.imageUrl.trim() : null,
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
    targeting: {
      project: form.project,
      groupId: form.groupId || null,
    },
    steps: form.steps.map((step, index) => stepFormToInput(step, index)),
  };
}
