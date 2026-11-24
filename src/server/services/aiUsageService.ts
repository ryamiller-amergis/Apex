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
import { adrs, aiPricing, aiUsageEvents, designDocs, interviews, prds } from '../db/schema';
import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  RecordUsageInput,
  AiFeature,
  AiTokenSource,
  AiUsageStatus,
} from '../../shared/types/aiCostAnalytics';
import type { EffortLevel } from '../../shared/types/effort';
import { parseWorkflowEvaluationRunThreadId } from '../../shared/types/aiRunV2EvaluationSpec';

// Estimate: ~4 chars per token (GPT-4 heuristic, good enough for allocation)
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Exact model id, then one hyphen-suffix strip (e.g. composer-2.5-fast → composer-2.5). */
export function modelIdPricingCandidates(modelId: string): string[] {
  const candidates = [modelId];
  const lastHyphen = modelId.lastIndexOf('-');
  if (lastHyphen > 0) candidates.push(modelId.slice(0, lastHyphen));
  return candidates;
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

  if (assistantType === 'adr') return 'adr';
  if (assistantType === 'prd') return 'prd';
  if (assistantType === 'design-doc') return 'design-doc';
  if (assistantType === 'calendar-work-item') return 'calendar-work-item-assistant';

  if (skillPath) {
    const lower = skillPath.toLowerCase();
    if (lower.includes('workflow-evaluation')) return 'workflow-evaluation';
    if (lower.includes('adr-interview') || lower.includes('adr-finalize') || lower.includes('adr-assistant')) {
      return 'adr';
    }
    if (lower.includes('to-prd')) return 'prd';
    if (lower.includes('prd-spec-review')) return 'prd-review';
    if (lower.includes('grill') || lower.includes('interview') || lower.includes('kick-off')) return 'interview';
    if (lower.includes('prd-design-spec') || lower.includes('design-spec-review')) return 'design-doc';
    if (lower.includes('design-doc-validation') || lower.includes('document-validation')) return 'design-doc-validation';
    if (lower.includes('create-test-case')) return 'test-case';
    if (lower.includes('feature-request')) return 'feature-request';
    if (lower.includes('daily-standup')) return 'standup';
  }

  return 'other';
}

export async function resolveUsageEntityFromThread(
  threadId: string,
): Promise<{ entityType: string; entityId: string } | null> {
  const evaluationRun = parseWorkflowEvaluationRunThreadId(threadId);
  if (evaluationRun) return { entityType: 'workflow-evaluation-event', entityId: evaluationRun.eventId };

  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  if (interview) return { entityType: 'interview', entityId: interview.id };

  const prd = await db.query.prds.findFirst({
    where: or(
      eq(prds.chatThreadId, threadId),
      eq(prds.prdAssistantThreadId, threadId),
      eq(prds.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (prd) return { entityType: 'prd', entityId: prd.id };

  const adr = await db.query.adrs.findFirst({
    where: or(eq(adrs.chatThreadId, threadId), eq(adrs.adrAssistantThreadId, threadId)),
    columns: { id: true },
  });
  if (adr) return { entityType: 'adr', entityId: adr.id };

  const doc = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (doc) return { entityType: 'design-doc', entityId: doc.id };

  return null;
}

/** Look up price for a model at a specific time (most recent effective row). */
export async function lookupPricing(provider: string, modelId: string, at: Date): Promise<{
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
} | null> {
  const atStr = at.toISOString();
  for (const candidate of modelIdPricingCandidates(modelId)) {
    const rows = await db
      .select()
      .from(aiPricing)
      .where(
        and(
          eq(aiPricing.provider, provider),
          eq(aiPricing.modelId, candidate),
          lte(aiPricing.effectiveFrom, atStr),
          or(isNull(aiPricing.effectiveTo), gt(aiPricing.effectiveTo, atStr)),
        ),
      )
      .orderBy(desc(aiPricing.effectiveFrom))
      .limit(1);

    if (rows[0]) {
      return {
        inputPerMtok: parseFloat(rows[0].inputPricePerMtok),
        outputPerMtok: parseFloat(rows[0].outputPricePerMtok),
        cacheReadPerMtok: parseFloat(rows[0].cacheReadPricePerMtok),
        cacheWritePerMtok: parseFloat(rows[0].cacheWritePricePerMtok),
      };
    }
  }
  return null;
}

const OBSERVED_RATE_TTL_MS = 5 * 60 * 1000;
const observedCursorRateCache = new Map<
  string,
  { ratePerTokenUsd: number | null; expiresAt: number }
>();

export function resetObservedCursorRateCacheForTests(): void {
  observedCursorRateCache.clear();
}

/**
 * Derives an observed USD-per-token rate for a Cursor model directly from
 * recent real `cursor_usage_events` telemetry (never hardcoded or seeded).
 * Returns `null` when no recent usage events with cost and tokens exist yet.
 */
export async function lookupObservedCursorRatePerTokenUsd(
  modelId: string,
): Promise<number | null> {
  const key = modelId.trim();
  if (!key) return null;
  const now = Date.now();
  const cached = observedCursorRateCache.get(key);
  if (cached && now < cached.expiresAt) return cached.ratePerTokenUsd;

  if (typeof db.execute !== 'function') return null;
  try {
    const candidates = modelIdPricingCandidates(key);
    const primary = candidates[0];
    const base = candidates[1] ?? primary;
    const result = await db.execute<{
      total_cents: string | null;
      total_tokens: string | null;
    }>(sql`
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(charged_cents::numeric, 0) > 0 THEN charged_cents::numeric
              ELSE COALESCE(total_model_cents::numeric, 0)
            END
          ),
          0
        ) AS total_cents,
        COALESCE(
          SUM(
            COALESCE(input_tokens, 0)
            + COALESCE(output_tokens, 0)
            + COALESCE(cache_read_tokens, 0)
            + COALESCE(cache_write_tokens, 0)
          ),
          0
        ) AS total_tokens
      FROM cursor_usage_events
      WHERE ts >= NOW() - INTERVAL '30 days'
        AND (
          model = ${primary}
          OR model = ${base}
          OR model LIKE ${`${base}-%`}
        )
    `);
    const row = result?.rows?.[0];
    const totalCents = parseFloat(row?.total_cents ?? '0');
    const totalTokens = parseFloat(row?.total_tokens ?? '0');
    const rate =
      Number.isFinite(totalCents) &&
      Number.isFinite(totalTokens) &&
      totalCents > 0 &&
      totalTokens > 0
        ? totalCents / 100 / totalTokens
        : null;
    observedCursorRateCache.set(key, {
      ratePerTokenUsd: rate,
      expiresAt: now + OBSERVED_RATE_TTL_MS,
    });
    return rate;
  } catch {
    return null;
  }
}

async function computeCatalogCost(opts: {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  at?: Date;
}): Promise<number | null> {
  const pricing = await lookupPricing(opts.provider, opts.modelId, opts.at ?? new Date());
  if (!pricing) return null;

  const M = 1_000_000;
  return (
    (opts.inputTokens / M) * pricing.inputPerMtok +
    (opts.outputTokens / M) * pricing.outputPerMtok +
    ((opts.cacheReadTokens ?? 0) / M) * pricing.cacheReadPerMtok +
    ((opts.cacheWriteTokens ?? 0) / M) * pricing.cacheWritePerMtok
  );
}

/**
 * Compute cost in USD from token counts. Uses `ai_pricing` when a catalog row
 * exists, and for Cursor models without a catalog row falls back to the live
 * observed per-token rate from recent `cursor_usage_events`.
 */
export async function computeCost(opts: {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  at?: Date;
}): Promise<number> {
  const catalogCost = await computeCatalogCost(opts);
  if (catalogCost !== null) return catalogCost;

  if (opts.provider === 'cursor') {
    const totalTokens =
      opts.inputTokens +
      opts.outputTokens +
      (opts.cacheReadTokens ?? 0) +
      (opts.cacheWriteTokens ?? 0);
    if (totalTokens > 0) {
      const observedRate = await lookupObservedCursorRatePerTokenUsd(opts.modelId);
      if (observedRate !== null && observedRate > 0) {
        return totalTokens * observedRate;
      }
    }
  }
  return 0;
}

function usageInsertValues(
  input: RecordUsageInput,
): typeof aiUsageEvents.$inferInsert {
  return {
    provider: input.provider,
    modelId: input.modelId,
    effort: input.effort ?? null,
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
  };
}

export async function recordAiUsageAwaited(
  input: RecordUsageInput,
  insertUsage: (
    values: typeof aiUsageEvents.$inferInsert,
  ) => PromiseLike<unknown> = (values) =>
    db.insert(aiUsageEvents).values(values),
): Promise<void> {
  await insertUsage(usageInsertValues(input));
}

/** Fire-and-forget insert — never throws. */
export function recordAiUsage(input: RecordUsageInput): void {
  void recordAiUsageAwaited(input).catch((err) => {
      console.error('[aiUsageService] Failed to record usage event:', err);
    });
}

export async function recordCursorChatUsage(opts: {
  kickoff: {
    mode?: string;
    assistantType?: string;
    skillPath?: string;
    standupSessionId?: string;
    pillLabel?: string;
    project?: string;
    effort?: EffortLevel;
  };
  modelId: string;
  threadId: string;
  runId?: string;
  userId?: string;
  workItemId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Runtime-reported cost in USD (e.g. from Cursor SDK `agent.getUsage().cost`). */
  reportedCostUsd?: number;
  /** 'exact' when the runtime reported usage; defaults to the chars/4 estimate. */
  tokenSource?: AiTokenSource;
  durationMs: number;
  status: AiUsageStatus;
}): Promise<void> {
  const entity = await resolveUsageEntityFromThread(opts.threadId);
  const tokenSource = opts.tokenSource ?? 'estimated';
  const hasReportedCost =
    opts.reportedCostUsd !== undefined &&
    Number.isFinite(opts.reportedCostUsd) &&
    opts.reportedCostUsd > 0;
  let costUsd = 0;
  let costSource: RecordUsageInput['costSource'] = 'estimated';
  if (hasReportedCost) {
    costUsd = opts.reportedCostUsd!;
    costSource = 'computed';
  } else {
    const catalogCost = await computeCatalogCost({
      provider: 'cursor',
      modelId: opts.modelId,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheReadTokens: opts.cacheReadTokens,
      cacheWriteTokens: opts.cacheWriteTokens,
    });
    if (catalogCost !== null && catalogCost > 0) {
      costUsd = catalogCost;
      costSource = tokenSource === 'exact' ? 'computed' : 'estimated';
    } else {
      const totalTokens =
        opts.inputTokens +
        opts.outputTokens +
        (opts.cacheReadTokens ?? 0) +
        (opts.cacheWriteTokens ?? 0);
      if (totalTokens > 0) {
        const observedRate = await lookupObservedCursorRatePerTokenUsd(opts.modelId);
        if (observedRate !== null && observedRate > 0) {
          costUsd = totalTokens * observedRate;
        }
      }
      costSource = 'estimated';
    }
  }
  recordAiUsage({
    provider: 'cursor',
    modelId: opts.modelId,
    effort: opts.kickoff.effort,
    feature: resolveFeatureFromKickoff(opts.kickoff),
    project: opts.kickoff.project ?? 'unknown',
    skillPath: opts.kickoff.skillPath,
    threadId: opts.threadId,
    runId: opts.runId,
    workItemId: opts.workItemId,
    userId: opts.userId,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cacheReadTokens: opts.cacheReadTokens,
    cacheWriteTokens: opts.cacheWriteTokens,
    tokenSource,
    costUsd,
    costSource,
    durationMs: opts.durationMs,
    status: opts.status,
  });
}
