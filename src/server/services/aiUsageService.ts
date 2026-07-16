/**
 * AI Usage recording service.
 *
 * recordAiUsage() is intentionally fire-and-forget — it never throws or
 * blocks the calling code, matching the pattern of pgInsertMessage().
 *
 * computeCost() reads the ai_pricing catalog to turn token counts into
 * a USD cost figure. Falls back to 0 when the model has no pricing entry.
 */
import { db } from '../db/drizzle';
import { aiPricing, aiUsageEvents } from '../db/schema';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { RecordUsageInput, AiFeature } from '../../shared/types/aiCostAnalytics';

// Estimate: ~4 chars per token (GPT-4 heuristic, good enough for allocation)
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Map kickoff mode/assistantType/skillPath to an AiFeature label. */
export function resolveFeatureFromKickoff(kickoff: {
  mode?: string;
  assistantType?: string;
  skillPath?: string;
  standupSessionId?: string;
  pillLabel?: string;
}): AiFeature {
  const { mode, assistantType, skillPath, standupSessionId } = kickoff;

  if (standupSessionId || mode === 'standup-participant' || mode === 'standup-facilitator') return 'standup';
  if (mode === 'development') return 'my-work';

  if (assistantType === 'prd') return 'prd';
  if (assistantType === 'design-doc') return 'design-doc';
  if (assistantType === 'calendar-work-item') return 'calendar-work-item-assistant';

  if (skillPath) {
    const lower = skillPath.toLowerCase();
    if (lower.includes('grill') || lower.includes('interview') || lower.includes('kick-off')) return 'interview';
    if (lower.includes('to-prd') || lower.includes('prd-spec-review')) return 'prd-review';
    if (lower.includes('prd-design-spec') || lower.includes('design-spec-review')) return 'design-doc';
    if (lower.includes('design-doc-validation') || lower.includes('document-validation')) return 'design-doc-validation';
    if (lower.includes('create-test-case')) return 'test-case';
    if (lower.includes('feature-request')) return 'feature-request';
    if (lower.includes('daily-standup')) return 'standup';
  }

  return 'other';
}

/** Look up price for a model at a specific time (most recent effective row). */
async function lookupPricing(provider: string, modelId: string, at: Date): Promise<{
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
} | null> {
  const atStr = at.toISOString();
  const rows = await db
    .select()
    .from(aiPricing)
    .where(
        and(
        eq(aiPricing.provider, provider),
        eq(aiPricing.modelId, modelId),
        lte(aiPricing.effectiveFrom, atStr),
        or(isNull(aiPricing.effectiveTo), lte(aiPricing.effectiveTo, atStr)),
      ),
    )
    .limit(1);

  if (!rows[0]) return null;
  return {
    inputPerMtok: parseFloat(rows[0].inputPricePerMtok),
    outputPerMtok: parseFloat(rows[0].outputPricePerMtok),
    cacheReadPerMtok: parseFloat(rows[0].cacheReadPricePerMtok),
    cacheWritePerMtok: parseFloat(rows[0].cacheWritePricePerMtok),
  };
}

/** Compute cost in USD from token counts and the pricing catalog. */
export async function computeCost(opts: {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  at?: Date;
}): Promise<number> {
  const pricing = await lookupPricing(opts.provider, opts.modelId, opts.at ?? new Date());
  if (!pricing) return 0;

  const M = 1_000_000;
  return (
    (opts.inputTokens / M) * pricing.inputPerMtok +
    (opts.outputTokens / M) * pricing.outputPerMtok +
    ((opts.cacheReadTokens ?? 0) / M) * pricing.cacheReadPerMtok +
    ((opts.cacheWriteTokens ?? 0) / M) * pricing.cacheWritePerMtok
  );
}

/** Fire-and-forget insert — never throws. */
export function recordAiUsage(input: RecordUsageInput): void {
  db.insert(aiUsageEvents)
    .values({
      provider: input.provider,
      modelId: input.modelId,
      feature: input.feature,
      project: input.project,
      skillPath: input.skillPath ?? null,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      workItemId: input.workItemId ?? null,
      userId: input.userId ?? null,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      tokenSource: input.tokenSource,
      costUsd: String(input.costUsd.toFixed(8)),
      costSource: input.costSource,
      durationMs: input.durationMs ?? null,
      status: input.status,
    })
    .catch((err) => {
      console.error('[aiUsageService] Failed to record usage event:', err);
    });
}
