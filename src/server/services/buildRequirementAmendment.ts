/**
 * Pure requirement amendment, classification, and verification carry-over logic (FEAT-014, TBI-026 / S2).
 */
import { z } from 'zod';
import {
  BUILD_REQUIREMENT_PREFIXES,
  type BuildClassification,
  type BuildRequirement,
  type BuildRequirementKind,
  type BuildRiskDecision,
  type BuildVerificationRow,
} from '../../shared/types/build';

export interface AmendedRequirement extends BuildRequirement {
  retiredInRevision?: number;
  retiredReason?: string;
}

export interface AmendedRiskDecision extends BuildRiskDecision {
  retired?: boolean;
  retiredInRevision?: number;
}

export const requirementAmendmentSchema = z
  .object({
    changed: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
      }),
    ),
    added: z.array(
      z.object({
        kind: z.enum(['ac', 'dod', 'br', 'nfr']),
        text: z.string().min(1),
      }),
    ),
    dropped: z.array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
    assumptions: z.array(z.string()),
    exclusions: z.array(z.string()),
    riskDecisionChanges: z
      .array(
        z.object({
          id: z.string().optional(),
          category: z.enum(['data', 'access', 'integration', 'destructive']),
          rating: z.enum(['low', 'medium', 'high']),
          decision: z.string().min(1),
          rationale: z.string().min(1),
          retired: z.boolean().optional(),
        }),
      )
      .default([]),
    classification: z.enum(['small', 'full']).default('small'),
    touchesMigration: z.boolean().default(false),
  })
  .strict();

export type RequirementAmendmentInput = z.infer<typeof requirementAmendmentSchema>;

export interface ApplyRequirementAmendmentResult {
  requirements: AmendedRequirement[];
  riskDecisions: AmendedRiskDecision[];
  changedIds: string[];
  addedIds: string[];
  droppedIds: string[];
  newOrChangedRiskDecisions: AmendedRiskDecision[];
}

function parseNumericId(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export function applyRequirementAmendment(
  previousRequirements: readonly BuildRequirement[],
  previousRiskDecisions: readonly BuildRiskDecision[],
  amendment: RequirementAmendmentInput,
  revisionNumber: number,
): ApplyRequirementAmendmentResult {
  const parsed = requirementAmendmentSchema.parse(amendment);

  if (
    parsed.changed.length === 0
    && parsed.added.length === 0
    && parsed.dropped.length === 0
    && parsed.riskDecisionChanges.length === 0
  ) {
    throw new Error('EMPTY_AMENDMENT: Amendment must change, add, or drop at least one item.');
  }

  // Deep clone so input is never mutated
  const requirements: AmendedRequirement[] = previousRequirements.map((r) => ({ ...r }));
  const byId = new Map<string, AmendedRequirement>(requirements.map((r) => [r.id, r]));

  const changedIds: string[] = [];
  for (const ch of parsed.changed) {
    const target = byId.get(ch.id);
    if (!target) {
      throw new Error(`UNKNOWN_REQUIREMENT_ID: Requirement ${ch.id} does not exist.`);
    }
    if (target.retired) {
      throw new Error(`RETIRED_REQUIREMENT_EDIT: Cannot edit retired requirement ${ch.id}.`);
    }
    target.text = ch.text.trim();
    changedIds.push(ch.id);
  }

  const droppedIds: string[] = [];
  for (const dr of parsed.dropped) {
    const target = byId.get(dr.id);
    if (!target) {
      throw new Error(`UNKNOWN_REQUIREMENT_ID: Requirement ${dr.id} does not exist.`);
    }
    if (target.retired) {
      throw new Error(`RETIRED_REQUIREMENT_EDIT: Requirement ${dr.id} is already retired.`);
    }
    target.retired = true;
    target.retiredInRevision = revisionNumber;
    target.retiredReason = dr.reason.trim();
    droppedIds.push(dr.id);
  }

  // Compute highest existing number per kind (counting retired items too)
  const counters: Record<BuildRequirementKind, number> = {
    ac: 0,
    dod: 0,
    br: 0,
    nfr: 0,
  };
  for (const r of requirements) {
    const n = parseNumericId(r.id);
    if (n > counters[r.kind]) {
      counters[r.kind] = n;
    }
  }

  const addedIds: string[] = [];
  for (const add of parsed.added) {
    counters[add.kind] += 1;
    const prefix = BUILD_REQUIREMENT_PREFIXES[add.kind];
    const nextId = `${prefix}-${counters[add.kind]}`;
    const created: AmendedRequirement = {
      id: nextId,
      kind: add.kind,
      text: add.text.trim(),
      retired: false,
    };
    requirements.push(created);
    byId.set(nextId, created);
    addedIds.push(nextId);
  }

  // Risk decisions
  const riskDecisions: AmendedRiskDecision[] = previousRiskDecisions.map((rd) => ({ ...rd }));
  let maxRd = 0;
  for (const rd of riskDecisions) {
    const n = parseNumericId(rd.id);
    if (n > maxRd) maxRd = n;
  }

  const newOrChangedRiskDecisions: AmendedRiskDecision[] = [];
  for (const rdc of parsed.riskDecisionChanges) {
    if (rdc.id) {
      const existing = riskDecisions.find((r) => r.id === rdc.id);
      if (!existing) {
        throw new Error(`UNKNOWN_RISK_DECISION_ID: Risk decision ${rdc.id} does not exist.`);
      }
      existing.category = rdc.category;
      existing.rating = rdc.rating;
      existing.decision = rdc.decision.trim();
      existing.rationale = rdc.rationale.trim();
      if (rdc.retired) {
        existing.retired = true;
        existing.retiredInRevision = revisionNumber;
      }
      newOrChangedRiskDecisions.push({ ...existing });
    } else {
      maxRd += 1;
      const created: AmendedRiskDecision = {
        id: `RD-${maxRd}`,
        category: rdc.category,
        rating: rdc.rating,
        decision: rdc.decision.trim(),
        rationale: rdc.rationale.trim(),
      };
      riskDecisions.push(created);
      newOrChangedRiskDecisions.push({ ...created });
    }
  }

  return {
    requirements,
    riskDecisions,
    changedIds,
    addedIds,
    droppedIds,
    newOrChangedRiskDecisions,
  };
}

export function classifyRevisionChange(input: {
  agentClassification?: BuildClassification;
  touchesMigration: boolean;
  newOrChangedRiskDecisions: readonly AmendedRiskDecision[];
}): BuildClassification {
  if (input.touchesMigration) {
    return 'full';
  }
  const hasNewHighRisk = input.newOrChangedRiskDecisions.some(
    (rd) => !rd.retired && rd.rating === 'high',
  );
  if (hasNewHighRisk) {
    return 'full';
  }
  return input.agentClassification ?? 'small';
}

export type VerificationRowInput = Pick<
  BuildVerificationRow,
  | 'requirementId'
  | 'kind'
  | 'testTier'
  | 'testRefs'
  | 'redEvidence'
  | 'greenEvidence'
  | 'evidenceBlobRef'
  | 'status'
  | 'deferralReason'
  | 'carriedFromRevisionNumber'
>;

export interface PlannedVerificationRows {
  copy: VerificationRowInput[];
  createPending: VerificationRowInput[];
  closeRetired: VerificationRowInput[];
}

export function planVerificationRows(input: {
  previousRevisionNumber: number;
  previousRows: readonly VerificationRowInput[];
  changedIds: readonly string[];
  addedIds: readonly string[];
  droppedIds: readonly string[];
  nextRequirements: readonly BuildRequirement[];
  nextRiskDecisions: readonly AmendedRiskDecision[];
}): PlannedVerificationRows {
  const changedSet = new Set(input.changedIds);
  const addedSet = new Set(input.addedIds);
  const droppedSet = new Set(input.droppedIds);
  const prevByReqId = new Map(input.previousRows.map((r) => [r.requirementId, r]));

  const copy: VerificationRowInput[] = [];
  const createPending: VerificationRowInput[] = [];
  const closeRetired: VerificationRowInput[] = [];

  for (const req of input.nextRequirements) {
    const prev = prevByReqId.get(req.id);
    if (req.retired || droppedSet.has(req.id)) {
      closeRetired.push({
        requirementId: req.id,
        kind: req.kind,
        testTier: prev?.testTier ?? null,
        testRefs: prev?.testRefs ?? [],
        redEvidence: prev?.redEvidence ?? null,
        greenEvidence: prev?.greenEvidence ?? null,
        evidenceBlobRef: prev?.evidenceBlobRef ?? null,
        status: 'retired',
        deferralReason: null,
        carriedFromRevisionNumber: prev?.carriedFromRevisionNumber ?? null,
      });
    } else if (changedSet.has(req.id) || addedSet.has(req.id) || !prev) {
      createPending.push({
        requirementId: req.id,
        kind: req.kind,
        testTier: prev?.testTier ?? null,
        testRefs: [],
        redEvidence: null,
        greenEvidence: null,
        evidenceBlobRef: null,
        status: 'pending',
        deferralReason: null,
        carriedFromRevisionNumber: null,
      });
    } else {
      copy.push({
        ...prev,
        carriedFromRevisionNumber:
          prev.carriedFromRevisionNumber ?? input.previousRevisionNumber,
      });
    }
  }

  for (const rd of input.nextRiskDecisions) {
    const prev = prevByReqId.get(rd.id);
    if (rd.retired) {
      closeRetired.push({
        requirementId: rd.id,
        kind: 'risk_decision',
        testTier: prev?.testTier ?? null,
        testRefs: prev?.testRefs ?? [],
        redEvidence: prev?.redEvidence ?? null,
        greenEvidence: prev?.greenEvidence ?? null,
        evidenceBlobRef: prev?.evidenceBlobRef ?? null,
        status: 'retired',
        deferralReason: null,
        carriedFromRevisionNumber: prev?.carriedFromRevisionNumber ?? null,
      });
    } else if (changedSet.has(rd.id) || addedSet.has(rd.id) || !prev) {
      createPending.push({
        requirementId: rd.id,
        kind: 'risk_decision',
        testTier: null,
        testRefs: [],
        redEvidence: null,
        greenEvidence: null,
        evidenceBlobRef: null,
        status: 'pending',
        deferralReason: null,
        carriedFromRevisionNumber: null,
      });
    } else {
      copy.push({
        ...prev,
        carriedFromRevisionNumber:
          prev.carriedFromRevisionNumber ?? input.previousRevisionNumber,
      });
    }
  }

  return { copy, createPending, closeRetired };
}
