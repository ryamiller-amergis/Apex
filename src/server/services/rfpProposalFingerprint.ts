import crypto from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { rfpEvaluations, rfpRequests } from '../db/schema';
import {
  rfpDraftKindForVerdict,
  type RfpArchitecture,
  type RfpDraftKind,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';

export type RfpDbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RfpRequestRow = typeof rfpRequests.$inferSelect;

/** Hash of everything a generated draft depends on; audit fields are excluded so re-saves stay idempotent. */
export function rfpReviewFingerprint(
  kind: RfpDraftKind,
  verdict: RfpVerdict,
  architecture: RfpArchitecture | null,
): string {
  const sizing = architecture?.sizing ?? null;
  const canonical = {
    kind,
    verdict,
    architecture: architecture
      ? {
        appType: architecture.appType,
        resources: [...architecture.resources].sort(),
        requiresAi: architecture.requiresAi,
        domainName: architecture.domainName,
        sizing: sizing
          ? {
            region: sizing.region,
            sizingProfile: sizing.sizingProfile,
            environmentCount: sizing.environmentCount,
            uptimePattern: sizing.uptimePattern,
            storageGb: sizing.storageGb,
            aiUsage: sizing.aiUsage,
          }
          : null,
      }
      : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface RfpReviewState {
  row: RfpRequestRow;
  verdict: RfpVerdict | null;
  kind: RfpDraftKind | null;
  /** Null when the verdict does not produce a draft (missing or needs-clarification). */
  fingerprint: string | null;
}

export async function loadRfpReviewState(
  executor: RfpDbExecutor,
  rfpId: string,
  options: { lock?: boolean } = {},
): Promise<RfpReviewState | null> {
  if (options.lock) {
    await executor.execute(sql`SELECT id FROM rfp_requests WHERE id = ${rfpId} FOR UPDATE`);
  }
  const row = await executor.query.rfpRequests.findFirst({ where: eq(rfpRequests.id, rfpId) });
  if (!row) return null;
  let verdict: RfpVerdict | null = row.reviewerVerdict ?? null;
  if (!verdict && row.currentEvaluationId) {
    const evaluation = await executor.query.rfpEvaluations.findFirst({
      where: eq(rfpEvaluations.id, row.currentEvaluationId),
      columns: { verdict: true },
    });
    verdict = (evaluation?.verdict as RfpVerdict | undefined) ?? null;
  }
  const kind = verdict ? rfpDraftKindForVerdict(verdict) : null;
  return {
    row,
    verdict,
    kind,
    fingerprint: verdict && kind
      ? rfpReviewFingerprint(kind, verdict, kind === 'proposal' ? row.architecture : null)
      : null,
  };
}
