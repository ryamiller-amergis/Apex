/**
 * Shared types for Platform Admin → Observability → AI Experience dashboard.
 * Covers conversational reply speed, document generation speed, true TTFT /
 * stage timings, run reliability & queue wait, API responsiveness, cost/cache,
 * and user sentiment.
 */

export const AI_EXPERIENCE_WINDOWS = ['30d', '90d', '120d', '180d'] as const;
export type AiExperienceWindow = (typeof AI_EXPERIENCE_WINDOWS)[number];

export const AI_EXPERIENCE_WINDOW_LABELS: Record<AiExperienceWindow, string> = {
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '120d': 'Last 4 months',
  '180d': 'Last 6 months',
};

export const AI_EXPERIENCE_GRANULARITIES = ['week', 'month'] as const;
export type AiExperienceGranularity = (typeof AI_EXPERIENCE_GRANULARITIES)[number];

export function isAiExperienceWindow(value: unknown): value is AiExperienceWindow {
  return typeof value === 'string' && (AI_EXPERIENCE_WINDOWS as readonly string[]).includes(value);
}

export function isAiExperienceGranularity(value: unknown): value is AiExperienceGranularity {
  return (
    typeof value === 'string' &&
    (AI_EXPERIENCE_GRANULARITIES as readonly string[]).includes(value)
  );
}

export type AiExperienceModuleKey =
  | 'home-chat'
  | 'interview'
  | 'brainstorm'
  | 'adr'
  | 'prd-generation'
  | 'design-doc-generation'
  | 'design-prototype'
  | 'test-case';

export type AiExperienceModuleCategory = 'conversation' | 'generation';

export interface AiExperienceHeadline {
  conversationalMedianSec: number | null;
  conversationalTurns: number;
  generationMedianSec: number | null;
  generationRuns: number;
  successRatePct: number | null;
  totalRuns: number;
  firstTokenMedianMs: number | null;
  firstTokenSamples: number;
  apiP95Ms: number | null;
  apiRequests: number;
  totalCostUsd: number;
  cacheHitPct: number | null;
}

export interface AiExperienceModuleSummary {
  key: AiExperienceModuleKey;
  label: string;
  category: AiExperienceModuleCategory;
  turns: number;
  p50Sec: number | null;
  avgSec: number | null;
  p90Sec: number | null;
  earliestP50Sec: number | null;
  latestP50Sec: number | null;
  /** Percentage change from earliest active bucket to latest active bucket (negative = faster). */
  deltaPct: number | null;
  successRatePct: number | null;
  avgCostUsd: number | null;
}

export interface AiExperienceConversationTrendPoint {
  bucket: string;
  label: string;
  homeChatP50Sec: number | null;
  homeChatP90Sec: number | null;
  interviewP50Sec: number | null;
  interviewP90Sec: number | null;
  brainstormP50Sec: number | null;
  brainstormP90Sec: number | null;
  adrP50Sec: number | null;
  adrP90Sec: number | null;
  totalTurns: number;
}

export interface AiExperienceGenerationTrendPoint {
  bucket: string;
  label: string;
  prdP50Min: number | null;
  prdP90Min: number | null;
  designDocP50Min: number | null;
  designDocP90Min: number | null;
  prototypeP50Min: number | null;
  testCaseP50Min: number | null;
  totalRuns: number;
}

export interface AiExperienceHomeChatSplitPoint {
  bucket: string;
  label: string;
  appKnowledgeP50Sec: number | null;
  otherSkillP50Sec: number | null;
  freeChatP50Sec: number | null;
  turns: number;
}

export interface AiExperienceStageAreaRow {
  area: string;
  label: string;
  samples: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  firstEventP50Ms: number | null;
  workerTurnP50Ms: number | null;
  warmPct: number | null;
}

export interface AiExperienceStageTrendPoint {
  bucket: string;
  label: string;
  ttftP50Ms: number | null;
  firstEventP50Ms: number | null;
  workerTurnP50Ms: number | null;
  samples: number;
}

export interface AiExperienceStageTimingsSummary {
  sampleCount: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  firstEventP50Ms: number | null;
  workspaceP50Ms: number | null;
  acquireP50Ms: number | null;
  workerTurnP50Ms: number | null;
  warmCount: number;
  resumedCount: number;
  recreatedCount: number;
  byArea: AiExperienceStageAreaRow[];
  trend: AiExperienceStageTrendPoint[];
}

export interface AiExperienceReliabilityTrendPoint {
  bucket: string;
  label: string;
  successRatePct: number | null;
  totalRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  queueWaitP50Sec: number | null;
}

export interface AiExperienceReliabilitySummary {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  successRatePct: number | null;
  queueWaitP50Sec: number | null;
  queueWaitP90Sec: number | null;
  terminalReasons: Array<{ reason: string; count: number }>;
  trend: AiExperienceReliabilityTrendPoint[];
}

export interface AiExperienceApiTrendPoint {
  bucket: string;
  label: string;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRatePct: number | null;
  requests: number;
}

export interface AiExperienceSlowRouteRow {
  routeTemplate: string;
  requests: number;
  p50Ms: number;
  p95Ms: number;
  errorRatePct: number;
}

export interface AiExperienceApiSummary {
  totalRequests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRatePct: number | null;
  clientErrors: number;
  trend: AiExperienceApiTrendPoint[];
  slowestRoutes: AiExperienceSlowRouteRow[];
}

export interface AiExperienceCostTrendPoint {
  bucket: string;
  label: string;
  totalCostUsd: number;
  avgCostPerRunUsd: number | null;
  cacheHitPct: number | null;
  interactions: number;
}

export interface AiExperienceModelRow {
  modelId: string;
  runs: number;
  avgSec: number | null;
  p50Sec: number | null;
  avgCostUsd: number;
  totalCostUsd: number;
  cacheHitPct: number | null;
}

export interface AiExperienceCostAndQualitySummary {
  totalCostUsd: number;
  totalInteractions: number;
  cacheHitPct: number | null;
  trend: AiExperienceCostTrendPoint[];
  byModel: AiExperienceModelRow[];
  ratings: {
    good: number;
    needsImprovement: number;
    bad: number;
    total: number;
    positiveRatePct: number | null;
  };
  flaggedThreads: {
    flagged: number;
    total: number;
    ratePct: number | null;
  };
}

export interface AiExperienceResponse {
  window: AiExperienceWindow;
  windowLabel: string;
  granularity: AiExperienceGranularity;
  /** `null` means platform-wide across all projects. */
  project: string | null;
  availableProjects: string[];
  fromIso: string;
  toIso: string;
  generatedAt: string;
  headline: AiExperienceHeadline;
  modules: AiExperienceModuleSummary[];
  conversationTrend: AiExperienceConversationTrendPoint[];
  generationTrend: AiExperienceGenerationTrendPoint[];
  homeChatSplit: AiExperienceHomeChatSplitPoint[];
  stageTimings: AiExperienceStageTimingsSummary;
  reliability: AiExperienceReliabilitySummary;
  apiExperience: AiExperienceApiSummary;
  costAndQuality: AiExperienceCostAndQualitySummary;
}
