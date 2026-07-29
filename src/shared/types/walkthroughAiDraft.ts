/**
 * FEAT-004 — AI-assisted Walkthrough draft generation and review contracts.
 * Proposals are ephemeral; accepted units merge into the shared WalkthroughDraft model.
 */

import type { WalkthroughAnchor, WalkthroughStepInput } from './walkthrough';

// ── Policy presets (Platform Admin selectable; server is source of truth) ─────

export type WalkthroughAiPolicyPresetId = 'A' | 'B' | 'C';

export interface WalkthroughAiPolicyPreset {
  id: WalkthroughAiPolicyPresetId;
  label: string;
  description: string;
  maxIntentLength: number;
  maxRedoFeedbackLength: number;
  timeoutMs: number;
  /** Automatic provider retries on timeout only. UI always allows manual retry. */
  retries: number;
}

/** Preset A is the default when Platform Admin does not change the selector. */
export const WALKTHROUGH_AI_POLICY_PRESETS: Record<
  WalkthroughAiPolicyPresetId,
  WalkthroughAiPolicyPreset
> = {
  A: {
    id: 'A',
    label: 'Balanced (default)',
    description: '2k intent · 1k redo feedback · 60s timeout · no auto-retry',
    maxIntentLength: 2000,
    maxRedoFeedbackLength: 1000,
    timeoutMs: 60_000,
    retries: 0,
  },
  B: {
    id: 'B',
    label: 'Extended',
    description: '4k intent · 2k redo feedback · 90s timeout · 1 timeout retry',
    maxIntentLength: 4000,
    maxRedoFeedbackLength: 2000,
    timeoutMs: 90_000,
    retries: 1,
  },
  C: {
    id: 'C',
    label: 'Strict',
    description: '1k intent · 500 redo feedback · 30s timeout · no auto-retry',
    maxIntentLength: 1000,
    maxRedoFeedbackLength: 500,
    timeoutMs: 30_000,
    retries: 0,
  },
};

export const DEFAULT_WALKTHROUGH_AI_POLICY_PRESET: WalkthroughAiPolicyPresetId = 'A';

export function resolveWalkthroughAiPolicyPreset(
  id: unknown,
): WalkthroughAiPolicyPreset {
  if (id === 'A' || id === 'B' || id === 'C') {
    return WALKTHROUGH_AI_POLICY_PRESETS[id];
  }
  return WALKTHROUGH_AI_POLICY_PRESETS[DEFAULT_WALKTHROUGH_AI_POLICY_PRESET];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type WalkthroughAiErrorCode =
  | 'AI_GENERATION_FAILED'
  | 'AI_OUTPUT_INVALID'
  | 'AI_REDO_FAILED'
  | 'PROPOSAL_UNIT_INVALID'
  | 'REGISTRY_VALUE_STALE'
  | 'INTENT_INVALID'
  | 'FEEDBACK_INVALID';

export class WalkthroughAiError extends Error {
  readonly code: WalkthroughAiErrorCode;

  constructor(code: WalkthroughAiErrorCode, message: string) {
    super(message);
    this.name = 'WalkthroughAiError';
    this.code = code;
  }
}

// ── Proposal shapes ───────────────────────────────────────────────────────────

export interface WalkthroughAiWalkthroughFields {
  internalName: string;
  userTitle: string;
  whyItMatters: string;
}

export interface WalkthroughAiStepProposal {
  id: string;
  ordinal: number;
  heading: string;
  bodyMarkdown: string;
  imageUrl?: string | null;
  /** Same-origin allow-listed path suggested for confirmation (may equal imageUrl). */
  imageCandidatePath?: string | null;
  ctaLabel?: string | null;
  ctaRoute?: string | null;
  anchor?: WalkthroughAnchor;
}

export type WalkthroughAiProposalUnitKind = 'walkthrough-fields' | 'step';

export type WalkthroughAiProposalUnit =
  | {
      unitId: string;
      kind: 'walkthrough-fields';
      value: WalkthroughAiWalkthroughFields;
    }
  | {
      unitId: string;
      kind: 'step';
      value: WalkthroughAiStepProposal;
      imageCandidatePath?: string | null;
    };

export interface WalkthroughAiProposal {
  proposalId: string;
  walkthroughFields: WalkthroughAiWalkthroughFields;
  steps: WalkthroughAiStepProposal[];
  units: WalkthroughAiProposalUnit[];
  generatedAt: string;
  /** Opaque server context version for redo isolation. */
  generationContextVersion: string;
  policyPreset: WalkthroughAiPolicyPresetId;
}

export interface GenerateWalkthroughAiDraftRequest {
  projectId: string;
  intent: string;
  policyPreset?: WalkthroughAiPolicyPresetId;
  existingDraft?: {
    internalName?: string;
    userTitle?: string;
    whyItMatters?: string;
    steps?: WalkthroughStepInput[];
  };
}

export interface GenerateWalkthroughAiDraftResponse {
  proposal: WalkthroughAiProposal;
}

export interface RedoWalkthroughAiUnitRequest {
  projectId: string;
  proposalId: string;
  generationContextVersion: string;
  unit: WalkthroughAiProposalUnit;
  feedback?: string;
  policyPreset?: WalkthroughAiPolicyPresetId;
}

export interface ValidateWalkthroughAiUnitRequest {
  projectId: string;
  unit: WalkthroughAiProposalUnit;
  imageConfirmed: boolean;
}

export interface ValidateWalkthroughAiUnitSuccess {
  valid: true;
  normalizedUnit: WalkthroughAiProposalUnit;
}

export type WalkthroughAiUnitDecisionStatus = 'pending' | 'accepted' | 'rejected';

export interface WalkthroughAiUnitDecision {
  status: WalkthroughAiUnitDecisionStatus;
  imageConfirmed?: boolean;
}

/** Editable draft slice owned by manual authoring (FEAT-003 form). */
export interface WalkthroughAiEditableDraftSlice {
  internalName: string;
  userTitle: string;
  whyItMatters: string;
  steps: WalkthroughStepInput[];
}

/**
 * Merge only accepted, already-normalized units into an editable draft slice.
 * Rejected / pending units are ignored. Image paths merge only when confirmed.
 */
export function mergeAcceptedUnitsIntoDraft(
  base: WalkthroughAiEditableDraftSlice,
  decisions: Record<string, WalkthroughAiUnitDecision>,
  normalizedAcceptedUnits: WalkthroughAiProposalUnit[],
): WalkthroughAiEditableDraftSlice {
  let next: WalkthroughAiEditableDraftSlice = {
    internalName: base.internalName,
    userTitle: base.userTitle,
    whyItMatters: base.whyItMatters,
    steps: base.steps.map((s) => ({ ...s, anchor: s.anchor ?? null })),
  };

  const acceptedIds = new Set(
    Object.entries(decisions)
      .filter(([, d]) => d.status === 'accepted')
      .map(([id]) => id),
  );

  const fieldsUnit = normalizedAcceptedUnits.find(
    (u) => u.kind === 'walkthrough-fields' && acceptedIds.has(u.unitId),
  );
  if (fieldsUnit && fieldsUnit.kind === 'walkthrough-fields') {
    next = {
      ...next,
      internalName: fieldsUnit.value.internalName,
      userTitle: fieldsUnit.value.userTitle,
      whyItMatters: fieldsUnit.value.whyItMatters,
    };
  }

  const acceptedSteps = normalizedAcceptedUnits.filter(
    (u): u is Extract<WalkthroughAiProposalUnit, { kind: 'step' }> =>
      u.kind === 'step' && acceptedIds.has(u.unitId),
  );

  if (acceptedSteps.length === 0) {
    return next;
  }

  const byId = new Map(next.steps.map((s) => [s.id ?? '', s]));
  for (const unit of acceptedSteps) {
    const decision = decisions[unit.unitId];
    const imageConfirmed = decision?.imageConfirmed === true;
    const imageUrl =
      imageConfirmed && unit.value.imageCandidatePath
        ? unit.value.imageCandidatePath
        : imageConfirmed && unit.value.imageUrl
          ? unit.value.imageUrl
          : null;

    const step: WalkthroughStepInput = {
      id: unit.value.id,
      ordinal: unit.value.ordinal,
      heading: unit.value.heading,
      bodyMarkdown: unit.value.bodyMarkdown,
      imageUrl,
      ctaLabel: unit.value.ctaLabel ?? null,
      ctaRoute: unit.value.ctaRoute ?? null,
      anchor: unit.value.anchor ?? null,
    };
    byId.set(unit.value.id, step);
  }

  const mergedSteps = Array.from(byId.values())
    .filter((s) => s.id)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s, index) => ({ ...s, ordinal: index }));

  // Include newly accepted steps that were not in base
  for (const unit of acceptedSteps) {
    if (!mergedSteps.some((s) => s.id === unit.value.id)) {
      const decision = decisions[unit.unitId];
      const imageConfirmed = decision?.imageConfirmed === true;
      mergedSteps.push({
        id: unit.value.id,
        ordinal: mergedSteps.length,
        heading: unit.value.heading,
        bodyMarkdown: unit.value.bodyMarkdown,
        imageUrl:
          imageConfirmed && (unit.value.imageCandidatePath || unit.value.imageUrl)
            ? (unit.value.imageCandidatePath ?? unit.value.imageUrl ?? null)
            : null,
        ctaLabel: unit.value.ctaLabel ?? null,
        ctaRoute: unit.value.ctaRoute ?? null,
        anchor: unit.value.anchor ?? null,
      });
    }
  }

  mergedSteps.sort((a, b) => a.ordinal - b.ordinal);
  return {
    ...next,
    steps: mergedSteps.map((s, index) => ({ ...s, ordinal: index })),
  };
}

/**
 * Build the reviewable unit list from Walkthrough-level fields + ordered Steps.
 */
export function buildProposalUnits(
  walkthroughFields: WalkthroughAiWalkthroughFields,
  steps: WalkthroughAiStepProposal[],
): WalkthroughAiProposalUnit[] {
  const units: WalkthroughAiProposalUnit[] = [
    {
      unitId: 'walkthrough-fields',
      kind: 'walkthrough-fields',
      value: walkthroughFields,
    },
  ];
  for (const step of steps) {
    units.push({
      unitId: `step-${step.id}`,
      kind: 'step',
      value: step,
      imageCandidatePath: step.imageCandidatePath ?? step.imageUrl ?? null,
    });
  }
  return units;
}
