/**
 * AI Cost Analytics Service
 * Drizzle-based aggregations for the /api/ai-cost endpoints.
 */
import { db } from '../db/drizzle';
import { aiUsageEvents, cursorUsageEvents, aiPricing } from '../db/schema';
import { and, eq, gte, inArray, lte, or, sql, desc, asc } from 'drizzle-orm';
import type {
  AiCostSummary,
  AiCostTimeseriesPoint,
  AiCostByFeature,
  AiCostByModel,
  AiCostByProject,
  AiCostEventsResponse,
  AiCostReconciliation,
  AiPricingRow,
  ProjectComparison,
  EntityUsageRollup,
  AiCostSource,
} from '../../shared/types/aiCostAnalytics';
import { labelUsageRun } from './artifactUsageContext';

interface DateFilter {
  from: string;
  to: string;
  project?: string;
  feature?: string;
  model?: string;
  provider?: string;
}

function buildWhereClause(f: DateFilter) {
  const conditions = [
    gte(aiUsageEvents.createdAt, f.from),
    lte(aiUsageEvents.createdAt, f.to),
  ];
  if (f.project && f.project !== 'all') conditions.push(eq(aiUsageEvents.project, f.project));
  if (f.feature) conditions.push(eq(aiUsageEvents.feature, f.feature));
  if (f.model) conditions.push(eq(aiUsageEvents.modelId, f.model));
  if (f.provider) conditions.push(eq(aiUsageEvents.provider, f.provider));
  return and(...conditions);
}

export async function getSummary(f: DateFilter): Promise<AiCostSummary> {
  const rows = await db.execute<{
    total_cost: string;
    cursor_cost: string;
    bedrock_cost: string;
    total_input_tokens: string;
    total_output_tokens: string;
    total_interactions: string;
  }>(sql`
    SELECT
      COALESCE(SUM(cost_usd::numeric), 0) AS total_cost,
      COALESCE(SUM(CASE WHEN provider = 'cursor' THEN cost_usd::numeric ELSE 0 END), 0) AS cursor_cost,
      COALESCE(SUM(CASE WHEN provider = 'bedrock' THEN cost_usd::numeric ELSE 0 END), 0) AS bedrock_cost,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COUNT(*) AS total_interactions
    FROM ai_usage_events
    WHERE created_at >= ${f.from}
      AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
      ${f.feature ? sql`AND feature = ${f.feature}` : sql``}
      ${f.model ? sql`AND model_id = ${f.model}` : sql``}
      ${f.provider ? sql`AND provider = ${f.provider}` : sql``}
  `);

  const row = rows.rows[0] ?? {};
  return {
    project: f.project ?? 'all',
    totalCostUsd: parseFloat(row.total_cost ?? '0'),
    cursorCostUsd: parseFloat(row.cursor_cost ?? '0'),
    bedrockCostUsd: parseFloat(row.bedrock_cost ?? '0'),
    totalInputTokens: parseInt(row.total_input_tokens ?? '0', 10),
    totalOutputTokens: parseInt(row.total_output_tokens ?? '0', 10),
    totalInteractions: parseInt(row.total_interactions ?? '0', 10),
    periodFrom: f.from,
    periodTo: f.to,
  };
}

export async function getTimeseries(f: DateFilter): Promise<AiCostTimeseriesPoint[]> {
  const rows = await db.execute<{
    date: string;
    cursor_cost: string;
    bedrock_cost: string;
    total_cost: string;
    interactions: string;
  }>(sql`
    SELECT
      date_trunc('day', created_at)::date AS date,
      COALESCE(SUM(CASE WHEN provider = 'cursor' THEN cost_usd::numeric ELSE 0 END), 0) AS cursor_cost,
      COALESCE(SUM(CASE WHEN provider = 'bedrock' THEN cost_usd::numeric ELSE 0 END), 0) AS bedrock_cost,
      COALESCE(SUM(cost_usd::numeric), 0) AS total_cost,
      COUNT(*) AS interactions
    FROM ai_usage_events
    WHERE created_at >= ${f.from}
      AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
      ${f.feature ? sql`AND feature = ${f.feature}` : sql``}
      ${f.model ? sql`AND model_id = ${f.model}` : sql``}
      ${f.provider ? sql`AND provider = ${f.provider}` : sql``}
    GROUP BY date_trunc('day', created_at)::date
    ORDER BY date_trunc('day', created_at)::date ASC
  `);

  return rows.rows.map((r) => ({
    date: r.date,
    cursorCostUsd: parseFloat(r.cursor_cost ?? '0'),
    bedrockCostUsd: parseFloat(r.bedrock_cost ?? '0'),
    totalCostUsd: parseFloat(r.total_cost ?? '0'),
    totalInteractions: parseInt(r.interactions ?? '0', 10),
  }));
}

export async function getByFeature(f: DateFilter): Promise<AiCostByFeature[]> {
  const rows = await db.execute<{
    feature: string;
    cost: string;
    interactions: string;
    input_tokens: string;
    output_tokens: string;
  }>(sql`
    SELECT
      feature,
      COALESCE(SUM(cost_usd::numeric), 0) AS cost,
      COUNT(*) AS interactions,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM ai_usage_events
    WHERE created_at >= ${f.from}
      AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
      ${f.model ? sql`AND model_id = ${f.model}` : sql``}
      ${f.provider ? sql`AND provider = ${f.provider}` : sql``}
    GROUP BY feature
    ORDER BY cost DESC
  `);

  return rows.rows.map((r) => {
    const cost = parseFloat(r.cost ?? '0');
    const interactions = parseInt(r.interactions ?? '0', 10);
    return {
      feature: r.feature as any,
      costUsd: cost,
      interactions,
      avgCostUsd: interactions > 0 ? cost / interactions : 0,
      inputTokens: parseInt(r.input_tokens ?? '0', 10),
      outputTokens: parseInt(r.output_tokens ?? '0', 10),
    };
  });
}

export async function getByModel(f: DateFilter): Promise<AiCostByModel[]> {
  const rows = await db.execute<{
    model_id: string;
    provider: string;
    cost: string;
    interactions: string;
    input_tokens: string;
    output_tokens: string;
  }>(sql`
    SELECT
      model_id,
      provider,
      COALESCE(SUM(cost_usd::numeric), 0) AS cost,
      COUNT(*) AS interactions,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM ai_usage_events
    WHERE created_at >= ${f.from}
      AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
      ${f.feature ? sql`AND feature = ${f.feature}` : sql``}
    GROUP BY model_id, provider
    ORDER BY cost DESC
  `);

  return rows.rows.map((r) => ({
    modelId: r.model_id,
    provider: r.provider as any,
    costUsd: parseFloat(r.cost ?? '0'),
    interactions: parseInt(r.interactions ?? '0', 10),
    inputTokens: parseInt(r.input_tokens ?? '0', 10),
    outputTokens: parseInt(r.output_tokens ?? '0', 10),
  }));
}

export async function getByProject(f: Omit<DateFilter, 'project'>): Promise<AiCostByProject[]> {
  const rows = await db.execute<{
    project: string;
    cost: string;
    cursor_cost: string;
    bedrock_cost: string;
    interactions: string;
  }>(sql`
    SELECT
      project,
      COALESCE(SUM(cost_usd::numeric), 0) AS cost,
      COALESCE(SUM(CASE WHEN provider = 'cursor' THEN cost_usd::numeric ELSE 0 END), 0) AS cursor_cost,
      COALESCE(SUM(CASE WHEN provider = 'bedrock' THEN cost_usd::numeric ELSE 0 END), 0) AS bedrock_cost,
      COUNT(*) AS interactions
    FROM ai_usage_events
    WHERE created_at >= ${f.from} AND created_at <= ${f.to}
    GROUP BY project
    ORDER BY cost DESC
  `);

  return rows.rows.map((r) => ({
    project: r.project,
    costUsd: parseFloat(r.cost ?? '0'),
    cursorCostUsd: parseFloat(r.cursor_cost ?? '0'),
    bedrockCostUsd: parseFloat(r.bedrock_cost ?? '0'),
    interactions: parseInt(r.interactions ?? '0', 10),
  }));
}

export async function getEvents(
  f: DateFilter,
  page: number,
  pageSize: number,
): Promise<AiCostEventsResponse> {
  const offset = (page - 1) * pageSize;

  const where = buildWhereClause(f);

  const [events, countResult] = await Promise.all([
    db
      .select()
      .from(aiUsageEvents)
      .where(where)
      .orderBy(desc(aiUsageEvents.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM ai_usage_events
      WHERE created_at >= ${f.from} AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
      ${f.feature ? sql`AND feature = ${f.feature}` : sql``}
      ${f.model ? sql`AND model_id = ${f.model}` : sql``}
      ${f.provider ? sql`AND provider = ${f.provider}` : sql``}
    `),
  ]);

  return {
    events: events.map((e) => ({
      id: e.id,
      provider: e.provider as any,
      modelId: e.modelId,
      feature: e.feature,
      project: e.project,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      tokenSource: e.tokenSource as any,
      costUsd: parseFloat(e.costUsd),
      costSource: e.costSource as any,
      durationMs: e.durationMs,
      status: e.status as any,
      entityType: e.entityType,
      entityId: e.entityId,
      workItemId: e.workItemId,
      createdAt: e.createdAt,
    })),
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
    page,
    pageSize,
  };
}

export async function getReconciliation(f: DateFilter): Promise<AiCostReconciliation> {
  const billedRows = await db.execute<{ total_charged: string }>(sql`
    SELECT COALESCE(SUM(charged_cents::numeric), 0) AS total_charged
    FROM cursor_usage_events
    WHERE ts >= ${f.from} AND ts <= ${f.to}
    ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
  `);

  const attributedRows = await db.execute<{ total_attributed: string }>(sql`
    SELECT COALESCE(SUM(cost_usd::numeric), 0) AS total_attributed
    FROM ai_usage_events
    WHERE provider = 'cursor'
      AND created_at >= ${f.from} AND created_at <= ${f.to}
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
  `);

  const billedCents = parseFloat(billedRows.rows[0]?.total_charged ?? '0');
  const attributedUsd = parseFloat(attributedRows.rows[0]?.total_attributed ?? '0');
  const attributedCents = attributedUsd * 100;
  const varianceCents = billedCents - attributedCents;
  const coveragePct = billedCents > 0 ? Math.min(100, (attributedCents / billedCents) * 100) : 0;

  return {
    project: f.project ?? 'all',
    periodFrom: f.from,
    periodTo: f.to,
    attributedCursorCostUsd: attributedUsd,
    billedCursorCents: billedCents,
    varianceCents,
    coveragePct,
    exactBedrock: true,
  };
}

export async function getByUser(f: DateFilter): Promise<import('../../shared/types/aiCostAnalytics').AiCostByUser[]> {
  const rows = await db.execute<{
    user_id: string;
    cost: string;
    cursor_cost: string;
    bedrock_cost: string;
    interactions: string;
    top_feature: string;
  }>(sql`
    SELECT
      user_id,
      COALESCE(SUM(cost_usd::numeric), 0) AS cost,
      COALESCE(SUM(CASE WHEN provider = 'cursor' THEN cost_usd::numeric ELSE 0 END), 0) AS cursor_cost,
      COALESCE(SUM(CASE WHEN provider = 'bedrock' THEN cost_usd::numeric ELSE 0 END), 0) AS bedrock_cost,
      COUNT(*) AS interactions,
      (
        SELECT feature FROM ai_usage_events sub
        WHERE sub.user_id = ai_usage_events.user_id
          AND sub.created_at >= ${f.from} AND sub.created_at <= ${f.to}
          ${f.project && f.project !== 'all' ? sql`AND sub.project = ${f.project}` : sql``}
        GROUP BY feature ORDER BY COUNT(*) DESC LIMIT 1
      ) AS top_feature
    FROM ai_usage_events
    WHERE created_at >= ${f.from}
      AND created_at <= ${f.to}
      AND user_id IS NOT NULL
      ${f.project && f.project !== 'all' ? sql`AND project = ${f.project}` : sql``}
    GROUP BY user_id
    ORDER BY cost DESC
    LIMIT 20
  `);

  // Look up display names from app_users
  const { appUsers } = await import('../db/schema');
  const { inArray } = await import('drizzle-orm');
  const userIds = rows.rows.map(r => r.user_id).filter(Boolean);
  const users = userIds.length > 0
    ? await db.select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
        .from(appUsers)
        .where(inArray(appUsers.oid, userIds))
    : [];
  const userMap = new Map(users.map(u => [u.oid, u]));

  return rows.rows.map((r) => {
    const user = userMap.get(r.user_id);
    return {
      userId: r.user_id,
      displayName: user?.displayName ?? r.user_id,
      email: user?.email ?? '',
      costUsd: parseFloat(r.cost ?? '0'),
      interactions: parseInt(r.interactions ?? '0', 10),
      cursorCostUsd: parseFloat(r.cursor_cost ?? '0'),
      bedrockCostUsd: parseFloat(r.bedrock_cost ?? '0'),
      topFeature: r.top_feature ?? null,
    };
  });
}

export async function getPricing(): Promise<AiPricingRow[]> {
  const rows = await db.select().from(aiPricing).orderBy(asc(aiPricing.provider), asc(aiPricing.modelId));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    modelId: r.modelId,
    inputPricePerMtok: parseFloat(r.inputPricePerMtok),
    outputPricePerMtok: parseFloat(r.outputPricePerMtok),
    cacheReadPricePerMtok: parseFloat(r.cacheReadPricePerMtok),
    cacheWritePricePerMtok: parseFloat(r.cacheWritePricePerMtok),
    currency: r.currency,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
  }));
}

export async function getProjectComparison(f: Omit<DateFilter, 'project' | 'feature' | 'model' | 'provider'>): Promise<ProjectComparison> {
  // Project-level totals with top model
  const projectRows = await db.execute<{
    project: string;
    total_cost: string;
    cursor_cost: string;
    bedrock_cost: string;
    interactions: string;
    top_model: string;
  }>(sql`
    SELECT
      project,
      COALESCE(SUM(cost_usd::numeric), 0) AS total_cost,
      COALESCE(SUM(CASE WHEN provider = 'cursor' THEN cost_usd::numeric ELSE 0 END), 0) AS cursor_cost,
      COALESCE(SUM(CASE WHEN provider = 'bedrock' THEN cost_usd::numeric ELSE 0 END), 0) AS bedrock_cost,
      COUNT(*) AS interactions,
      (
        SELECT model_id FROM ai_usage_events sub
        WHERE sub.project = ai_usage_events.project
          AND sub.created_at >= ${f.from} AND sub.created_at <= ${f.to}
        GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1
      ) AS top_model
    FROM ai_usage_events
    WHERE created_at >= ${f.from} AND created_at <= ${f.to}
    GROUP BY project
    ORDER BY total_cost DESC
  `);

  // Per-project per-feature breakdown
  const featureRows = await db.execute<{
    project: string;
    feature: string;
    cost: string;
    interactions: string;
    input_tokens: string;
    output_tokens: string;
  }>(sql`
    SELECT
      project,
      feature,
      COALESCE(SUM(cost_usd::numeric), 0) AS cost,
      COUNT(*) AS interactions,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM ai_usage_events
    WHERE created_at >= ${f.from} AND created_at <= ${f.to}
    GROUP BY project, feature
    ORDER BY project, cost DESC
  `);

  // Group features by project
  const featuresByProject = new Map<string, AiCostByFeature[]>();
  for (const r of featureRows.rows) {
    const cost = parseFloat(r.cost ?? '0');
    const interactions = parseInt(r.interactions ?? '0', 10);
    const entry: AiCostByFeature = {
      feature: r.feature as any,
      costUsd: cost,
      interactions,
      avgCostUsd: interactions > 0 ? cost / interactions : 0,
      inputTokens: parseInt(r.input_tokens ?? '0', 10),
      outputTokens: parseInt(r.output_tokens ?? '0', 10),
    };
    const list = featuresByProject.get(r.project) ?? [];
    list.push(entry);
    featuresByProject.set(r.project, list);
  }

  // Build project list with rank
  const projects = projectRows.rows.map((r, i) => ({
    project: r.project,
    totalCostUsd: parseFloat(r.total_cost ?? '0'),
    cursorCostUsd: parseFloat(r.cursor_cost ?? '0'),
    bedrockCostUsd: parseFloat(r.bedrock_cost ?? '0'),
    interactions: parseInt(r.interactions ?? '0', 10),
    features: featuresByProject.get(r.project) ?? [],
    topModel: r.top_model ?? '',
    rank: i + 1,
  }));

  // Build cross-project feature rankings
  const featureCostMap = new Map<string, Map<string, number>>();
  for (const r of featureRows.rows) {
    const cost = parseFloat(r.cost ?? '0');
    if (!featureCostMap.has(r.feature)) featureCostMap.set(r.feature, new Map());
    featureCostMap.get(r.feature)!.set(r.project, cost);
  }

  const featureRankings = Array.from(featureCostMap.entries())
    .map(([feature, projectMap]) => ({
      feature,
      totalCostUsd: Array.from(projectMap.values()).reduce((s, v) => s + v, 0),
      projects: Array.from(projectMap.entries())
        .map(([project, costUsd]) => ({ project, costUsd }))
        .sort((a, b) => b.costUsd - a.costUsd),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return { projects, featureRankings, period: { from: f.from, to: f.to } };
}

const COST_SOURCE_RANK: Record<AiCostSource, number> = {
  allocated: 3,
  computed: 2,
  estimated: 1,
};

function bestCostSource(sources: string[]): AiCostSource {
  let best: AiCostSource = 'estimated';
  for (const source of sources) {
    if (source === 'allocated' || source === 'computed' || source === 'estimated') {
      if (COST_SOURCE_RANK[source] > COST_SOURCE_RANK[best]) best = source;
    }
  }
  return best;
}

export async function getEntityUsageRollup(opts: {
  entityType: string;
  entityId: string;
  threadIds?: string[];
  threadLabels?: Record<string, string>;
  pendingSteps?: string[];
}): Promise<EntityUsageRollup> {
  const pendingSteps = opts.pendingSteps ?? [];
  const empty: EntityUsageRollup = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costSource: 'estimated',
    durationMs: 0,
    interactions: 0,
    models: [],
    incomplete: false,
    pendingSteps,
    runs: [],
  };

  const threadIds = (opts.threadIds ?? []).filter(Boolean);
  const entityMatch = and(
    eq(aiUsageEvents.entityType, opts.entityType),
    eq(aiUsageEvents.entityId, opts.entityId),
  );
  const clause = threadIds.length > 0
    ? or(entityMatch, inArray(aiUsageEvents.threadId, threadIds))
    : entityMatch;

  const events = await db
    .select()
    .from(aiUsageEvents)
    .where(clause);

  if (events.length === 0) return empty;

  const inputTokens = events.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
  const outputTokens = events.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
  const cacheReadTokens = events.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0);
  const costUsd = events.reduce((sum, row) => sum + parseFloat(row.costUsd ?? '0'), 0);
  const recordedDuration = events.reduce((sum, row) => sum + (row.durationMs ?? 0), 0);
  const createdTimes = events
    .map((row) => Date.parse(row.createdAt))
    .filter((ms) => Number.isFinite(ms));
  const elapsedFallback =
    createdTimes.length >= 2 ? Math.max(0, Math.max(...createdTimes) - Math.min(...createdTimes)) : 0;
  const durationMs = recordedDuration > 0 ? recordedDuration : elapsedFallback;
  const models = [...new Set(events.map((row) => row.modelId).filter(Boolean))];
  const onlyEstimatedCost = events.every((row) => row.costSource === 'estimated');
  const ordered = [...events].sort((a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
    return 0;
  });

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    costUsd,
    costSource: bestCostSource(events.map((row) => row.costSource)),
    durationMs,
    interactions: events.length,
    models,
    incomplete: costUsd === 0 && onlyEstimatedCost && inputTokens + outputTokens + cacheReadTokens > 0,
    pendingSteps,
    runs: ordered.map((row) => ({
      label: labelUsageRun({
        threadId: row.threadId,
        feature: row.feature,
        skillPath: row.skillPath,
        threadLabels: opts.threadLabels,
      }),
      modelId: row.modelId,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      durationMs: row.durationMs ?? null,
      costUsd: parseFloat(row.costUsd ?? '0'),
      createdAt: row.createdAt,
    })),
  };
}

