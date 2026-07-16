// ── AI Cost Analytics — shared types ────────────────────────────────────────

export type AiProvider = 'cursor' | 'bedrock';
export type AiTokenSource = 'exact' | 'estimated';
export type AiCostSource = 'computed' | 'estimated' | 'allocated';
export type AiUsageStatus = 'success' | 'error' | 'cancelled';

/** Apex feature names — each maps to one workflow. */
export type AiFeature =
  | 'interview'
  | 'prd'
  | 'prd-review'
  | 'design-doc'
  | 'design-doc-validation'
  | 'design-plan'
  | 'design-prototype'
  | 'my-work'
  | 'standup'
  | 'test-case'
  | 'feature-request'
  | 'ui-lab'
  | 'backlog-generate'
  | 'home-chat'
  | 'ai-cost-insights'
  | 'calendar-work-item-assistant'
  | 'other';

export interface RecordUsageInput {
  provider: AiProvider;
  modelId: string;
  feature: AiFeature;
  project: string;
  skillPath?: string;
  threadId?: string;
  runId?: string;
  entityType?: string;
  entityId?: string;
  workItemId?: string;
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokenSource: AiTokenSource;
  costUsd: number;
  costSource: AiCostSource;
  durationMs?: number;
  status: AiUsageStatus;
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface AiCostSummary {
  project: string;
  totalCostUsd: number;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalInteractions: number;
  periodFrom: string;
  periodTo: string;
}

export interface AiCostTimeseriesPoint {
  date: string;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  totalCostUsd: number;
  totalInteractions: number;
}

export interface AiCostByFeature {
  feature: AiFeature | string;
  costUsd: number;
  interactions: number;
  avgCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiCostByModel {
  modelId: string;
  provider: AiProvider;
  costUsd: number;
  interactions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiCostByUser {
  userId: string;
  displayName: string;
  email: string;
  costUsd: number;
  interactions: number;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  topFeature: string | null;
}

export interface AiCostByProject {
  project: string;
  costUsd: number;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  interactions: number;
}

export interface AiCostEvent {
  id: string;
  provider: AiProvider;
  modelId: string;
  feature: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokenSource: AiTokenSource;
  costUsd: number;
  costSource: AiCostSource;
  durationMs: number | null;
  status: AiUsageStatus;
  entityType: string | null;
  entityId: string | null;
  workItemId: string | null;
  createdAt: string;
}

export interface AiCostEventsResponse {
  events: AiCostEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AiCostReconciliation {
  project: string;
  periodFrom: string;
  periodTo: string;
  attributedCursorCostUsd: number;
  billedCursorCents: number;
  varianceCents: number;
  coveragePct: number;
  exactBedrock: boolean;
}

export interface AiPricingRow {
  id: string;
  provider: string;
  modelId: string;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  cacheReadPricePerMtok: number;
  cacheWritePricePerMtok: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// ── Forecast types ────────────────────────────────────────────────────────────

export interface AiForecastPoint {
  date: string;
  predictedCostUsd: number;
  lowerBoundUsd: number;
  upperBoundUsd: number;
}

export interface AiCostForecast {
  project: string;
  projectedEndOfMonthUsd: number;
  projectedNext7dUsd: number;
  projectedNext30dUsd: number;
  trendDirection: 'up' | 'down' | 'flat';
  trendPct: number;
  series: AiForecastPoint[];
  generatedAt: string;
}

// ── Daily Brief types ─────────────────────────────────────────────────────────

export interface AiCostDailyBrief {
  id: string;
  project: string;
  briefDate: string;
  briefType: 'morning' | 'afternoon';
  modelUsed: string;
  totalCostUsd: number;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  totalInteractions: number;
  mtdCostUsd: number;
  projectedEomUsd: number;
  trendDirection: 'up' | 'down' | 'flat';
  trendPct: number;
  headline: string | null;
  keyBullets: string[];
  alerts: string[];
  topFeatures: Array<{ feature: string; costUsd: number }>;
  generatedAt: string;
}

export interface AiCostInsightsResponse {
  project: string;
  periodFrom: string;
  periodTo: string;
  modelUsed: string;
  headline: string | null;
  insights: string[];
  recommendations: string[];
  riskFlags: string[];
  generatedAt: string;
}

// ── Project Comparison types ──────────────────────────────────────────────────

export interface ProjectComparisonProject {
  project: string;
  totalCostUsd: number;
  cursorCostUsd: number;
  bedrockCostUsd: number;
  interactions: number;
  features: AiCostByFeature[];
  topModel: string;
  rank: number;
}

export interface ProjectComparisonFeatureRanking {
  feature: string;
  totalCostUsd: number;
  projects: Array<{ project: string; costUsd: number }>;
}

export interface ProjectComparison {
  projects: ProjectComparisonProject[];
  featureRankings: ProjectComparisonFeatureRanking[];
  period: { from: string; to: string };
}
