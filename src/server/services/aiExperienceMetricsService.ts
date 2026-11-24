/**
 * Platform Admin → Observability → AI Experience metrics service.
 *
 * Queries PostgreSQL via Drizzle (`chat_messages`, `chat_threads`, `interviews`,
 * `brainstorm_sessions`, `ai_usage_events`, `agent_runs`, `ai_turn_stage_timings`,
 * `trace_events`, `skill_signals`) to produce executive-ready speed, reliability,
 * API responsiveness, cost/cache, and user sentiment metrics.
 */
import { sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  AI_EXPERIENCE_WINDOW_LABELS,
  type AiExperienceApiSummary,
  type AiExperienceConversationTrendPoint,
  type AiExperienceCostAndQualitySummary,
  type AiExperienceGenerationTrendPoint,
  type AiExperienceGranularity,
  type AiExperienceHomeChatSplitPoint,
  type AiExperienceModuleKey,
  type AiExperienceModuleSummary,
  type AiExperienceReliabilitySummary,
  type AiExperienceResponse,
  type AiExperienceStageTimingsSummary,
  type AiExperienceWindow,
} from '../../shared/types/aiExperience';

const WINDOW_DAYS: Record<AiExperienceWindow, number> = {
  '30d': 30,
  '90d': 90,
  '120d': 120,
  '180d': 180,
};

const MODULE_META: Record<
  AiExperienceModuleKey,
  { label: string; category: 'conversation' | 'generation' }
> = {
  'home-chat': { label: 'Home Chat', category: 'conversation' },
  interview: { label: 'Interview', category: 'conversation' },
  brainstorm: { label: 'Brainstorm', category: 'conversation' },
  adr: { label: 'ADR Interview', category: 'conversation' },
  'prd-generation': { label: 'PRD Generation', category: 'generation' },
  'design-doc-generation': { label: 'Design Doc Generation', category: 'generation' },
  'design-prototype': { label: 'Design Prototype', category: 'generation' },
  'test-case': { label: 'Test Case Generation', category: 'generation' },
};

const AREA_LABELS: Record<string, string> = {
  'agent-home': 'Home Chat',
  interview: 'Interview',
  brainstorm: 'Brainstorm',
  adr: 'ADR',
  'prd-assistant': 'PRD Assistant',
  'design-doc-assistant': 'Design Doc Assistant',
  'ask-apex': 'Ask Apex',
  'calendar-assistant': 'Calendar Assistant',
  'qa-lab': 'QA Lab',
  'ui-lab': 'UI Lab',
  'cab-release': 'CAB Release',
  'build-intake': 'Build Intake',
  'standup-participant': 'Standup',
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface AiExperienceQueryOptions {
  /** `null` or `'all'` means platform-wide across all projects. */
  project?: string | null;
  window?: AiExperienceWindow;
  granularity?: AiExperienceGranularity;
  now?: Date;
}

export interface AiExperienceDbExecutor {
  execute: (query: SQLWrapper) => Promise<unknown>;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toInt(value: unknown): number {
  const n = toNum(value);
  return n === null ? 0 : Math.round(n);
}

function round1(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function round2(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function round4(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

export function formatBucketLabel(bucket: string, granularity: AiExperienceGranularity): string {
  if (granularity === 'month') {
    const [yearStr, monthStr] = bucket.split('-');
    const monthIdx = Number(monthStr) - 1;
    if (Number.isInteger(monthIdx) && monthIdx >= 0 && monthIdx < 12) {
      return `${MONTH_SHORT[monthIdx]} ${yearStr?.slice(2) ?? ''}`.trim();
    }
    return bucket;
  }
  const parts = bucket.split('-');
  if (parts.length === 3) {
    const monthIdx = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (Number.isInteger(monthIdx) && monthIdx >= 0 && monthIdx < 12 && Number.isFinite(day)) {
      return `${MONTH_SHORT[monthIdx]} ${day}`;
    }
  }
  return bucket;
}

function normalizeProjectScope(project?: string | null): string | null {
  if (!project) return null;
  const trimmed = project.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return null;
  return trimmed;
}

function defaultGranularityForWindow(window: AiExperienceWindow): AiExperienceGranularity {
  return window === '30d' ? 'week' : 'month';
}

function computeDeltaPct(earliest: number | null, latest: number | null): number | null {
  if (earliest === null || latest === null || earliest <= 0) return null;
  return round1(((latest - earliest) / earliest) * 100);
}

function isMissingRelationError(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
  if (code === '42P01') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /relation .* does not exist/i.test(message);
}

function emptyStageTimings(): AiExperienceStageTimingsSummary {
  return {
    sampleCount: 0,
    ttftP50Ms: null,
    ttftP90Ms: null,
    firstEventP50Ms: null,
    workspaceP50Ms: null,
    acquireP50Ms: null,
    workerTurnP50Ms: null,
    warmCount: 0,
    resumedCount: 0,
    recreatedCount: 0,
    byArea: [],
    trend: [],
  };
}

interface ConvBucketRow {
  surface: string;
  bucket: string;
  turns: number;
  avg_sec: string | null;
  p50_sec: string | null;
  p90_sec: string | null;
}

interface ConvSummaryRow {
  surface: string;
  turns: number;
  avg_sec: string | null;
  p50_sec: string | null;
  p90_sec: string | null;
}

interface HomeSplitRow {
  bucket: string;
  kind: string;
  turns: number;
  p50_sec: string | null;
}

interface GenBucketRow {
  surface: string;
  bucket: string;
  total_runs: number;
  kept_runs: number;
  success_runs: number;
  avg_sec: string | null;
  p50_sec: string | null;
  p90_sec: string | null;
  avg_cost_usd: string | null;
}

interface GenSummaryRow {
  surface: string;
  total_runs: number;
  kept_runs: number;
  success_runs: number;
  avg_sec: string | null;
  p50_sec: string | null;
  p90_sec: string | null;
  avg_cost_usd: string | null;
}

interface StageOverallRow {
  samples: number;
  ttft_p50_ms: string | null;
  ttft_p90_ms: string | null;
  first_event_p50_ms: string | null;
  workspace_p50_ms: string | null;
  acquire_p50_ms: string | null;
  worker_turn_p50_ms: string | null;
  warm_count: number;
  resumed_count: number;
  recreated_count: number;
}

interface StageAreaRow {
  area: string;
  samples: number;
  ttft_p50_ms: string | null;
  ttft_p90_ms: string | null;
  first_event_p50_ms: string | null;
  worker_turn_p50_ms: string | null;
  warm_count: number;
}

interface StageTrendRow {
  bucket: string;
  samples: number;
  ttft_p50_ms: string | null;
  first_event_p50_ms: string | null;
  worker_turn_p50_ms: string | null;
}

interface ReliabilityOverallRow {
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  queue_wait_p50_sec: string | null;
  queue_wait_p90_sec: string | null;
}

interface ReliabilityTrendRow {
  bucket: string;
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  queue_wait_p50_sec: string | null;
}

interface TerminalReasonRow {
  reason: string;
  count: number;
}

interface ApiOverallRow {
  total_requests: number;
  error_requests: number;
  p50_ms: string | null;
  p95_ms: string | null;
  client_errors: number;
}

interface ApiTrendRow {
  bucket: string;
  requests: number;
  error_requests: number;
  p50_ms: string | null;
  p95_ms: string | null;
}

interface ApiRouteRow {
  route_template: string;
  requests: number;
  error_requests: number;
  p50_ms: string | null;
  p95_ms: string | null;
}

interface CostOverallRow {
  total_cost_usd: string | null;
  interactions: number;
  input_tokens: string | null;
  cache_read_tokens: string | null;
}

interface CostTrendRow {
  bucket: string;
  total_cost_usd: string | null;
  interactions: number;
  input_tokens: string | null;
  cache_read_tokens: string | null;
}

interface ModelRow {
  model_id: string;
  runs: number;
  avg_sec: string | null;
  p50_sec: string | null;
  total_cost_usd: string | null;
  input_tokens: string | null;
  cache_read_tokens: string | null;
}

interface RatingRow {
  good: number;
  needs_improvement: number;
  bad: number;
}

interface FlaggedRow {
  flagged: number;
  total: number;
}

interface ProjectRow {
  project: string;
}

export async function getAiExperienceMetrics(
  options: AiExperienceQueryOptions = {},
  executor: AiExperienceDbExecutor = db,
): Promise<AiExperienceResponse> {
  const window: AiExperienceWindow = options.window ?? '120d';
  const granularity: AiExperienceGranularity =
    options.granularity ?? defaultGranularityForWindow(window);
  const project = normalizeProjectScope(options.project);
  const now = options.now ?? new Date();
  const days = WINDOW_DAYS[window];
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fromIso = fromDate.toISOString();
  const toIso = now.toISOString();

  const truncUnit = granularity === 'week' ? 'week' : 'month';
  const bucketFmt = granularity === 'week' ? 'YYYY-MM-DD' : 'YYYY-MM';

  // Run independent read-only aggregations in parallel.
  const [
    projectsRes,
    convBucketsRes,
    convSummaryRes,
    homeSplitRes,
    genBucketsRes,
    genSummaryRes,
    stageTimings,
    reliabilityOverallRes,
    reliabilityTrendRes,
    terminalReasonsRes,
    apiOverallRes,
    apiTrendRes,
    apiRoutesRes,
    costOverallRes,
    costTrendRes,
    modelRes,
    ratingsRes,
    flaggedRes,
  ] = await Promise.all([
    executor.execute(sql`
      SELECT DISTINCT project
      FROM (
        SELECT project FROM ai_usage_events WHERE created_at >= ${fromIso}::timestamptz AND project IS NOT NULL AND project <> '' AND project <> 'unknown'
        UNION
        SELECT kickoff->>'project' AS project FROM chat_threads WHERE last_activity_at >= ${fromIso}::timestamptz AND kickoff->>'project' IS NOT NULL AND kickoff->>'project' <> ''
      ) p
      ORDER BY project ASC
      LIMIT 100
    `),

    // Conversational turn latency by bucket
    executor.execute(sql`
      WITH ordered AS (
        SELECT
          m.thread_id,
          m.role,
          m.ts,
          m.tool_name,
          m.id,
          sum(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
            OVER (PARTITION BY m.thread_id ORDER BY m.ts, m.id) AS turn_no
        FROM chat_messages m
        WHERE m.ts >= ${fromIso}::timestamptz
          AND m.ts <= ${toIso}::timestamptz
          AND m.hidden = false
      ),
      turns AS (
        SELECT
          thread_id,
          turn_no,
          min(ts) FILTER (WHERE role = 'user') AS user_ts,
          min(ts) FILTER (WHERE role = 'agent' AND tool_name IS NULL) AS first_text_ts
        FROM ordered
        GROUP BY 1, 2
      ),
      gaps AS (
        SELECT
          thread_id,
          user_ts,
          EXTRACT(EPOCH FROM (first_text_ts - user_ts)) AS sec
        FROM turns
        WHERE user_ts IS NOT NULL
          AND first_text_ts IS NOT NULL
          AND first_text_ts >= user_ts
      ),
      labeled AS (
        SELECT
          g.sec,
          g.user_ts,
          CASE
            WHEN bs.id IS NOT NULL THEN 'brainstorm'
            WHEN COALESCE(ct.kickoff->>'skillPath','') ILIKE '%adr-interview%'
              OR COALESCE(ct.kickoff->>'assistantType','') = 'adr' THEN 'adr'
            WHEN i.id IS NOT NULL AND (
              COALESCE(ct.kickoff->>'skillPath','') ILIKE '%grill-with-docs%'
              OR COALESCE(ct.kickoff->>'skillPath','') ILIKE '%grill-design%'
              OR COALESCE(ct.kickoff->>'skillPath','') ILIKE '%kick-off%'
            ) THEN 'interview'
            WHEN i.id IS NULL AND bs.id IS NULL
              AND COALESCE(ct.kickoff->>'assistantType','') = ''
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%adr%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%standup%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%design-doc%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%prd%'
              AND COALESCE(ct.kickoff->>'mode','') NOT IN ('standup-participant','standup-facilitator','development')
            THEN 'home-chat'
            ELSE 'skip'
          END AS surface
        FROM gaps g
        JOIN chat_threads ct ON ct.id = g.thread_id
        LEFT JOIN interviews i ON i.chat_thread_id = ct.id
        LEFT JOIN brainstorm_sessions bs ON bs.chat_thread_id = ct.id
        WHERE g.sec BETWEEN 0.5 AND 3600
          AND (${project}::text IS NULL OR COALESCE(bs.project, i.project, ct.kickoff->>'project') = ${project})
      )
      SELECT
        surface,
        to_char(date_trunc(${truncUnit}, user_ts), ${bucketFmt}) AS bucket,
        count(*)::int AS turns,
        round(avg(sec)::numeric, 1) AS avg_sec,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sec))::numeric, 1) AS p50_sec,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY sec))::numeric, 1) AS p90_sec
      FROM labeled
      WHERE surface <> 'skip'
      GROUP BY 1, 2
      ORDER BY 2 ASC, 1 ASC
    `),

    // Conversational turn latency summary across full window
    executor.execute(sql`
      WITH ordered AS (
        SELECT
          m.thread_id,
          m.role,
          m.ts,
          m.tool_name,
          m.id,
          sum(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
            OVER (PARTITION BY m.thread_id ORDER BY m.ts, m.id) AS turn_no
        FROM chat_messages m
        WHERE m.ts >= ${fromIso}::timestamptz
          AND m.ts <= ${toIso}::timestamptz
          AND m.hidden = false
      ),
      turns AS (
        SELECT
          thread_id,
          turn_no,
          min(ts) FILTER (WHERE role = 'user') AS user_ts,
          min(ts) FILTER (WHERE role = 'agent' AND tool_name IS NULL) AS first_text_ts
        FROM ordered
        GROUP BY 1, 2
      ),
      gaps AS (
        SELECT
          thread_id,
          EXTRACT(EPOCH FROM (first_text_ts - user_ts)) AS sec
        FROM turns
        WHERE user_ts IS NOT NULL
          AND first_text_ts IS NOT NULL
          AND first_text_ts >= user_ts
      ),
      labeled AS (
        SELECT
          g.sec,
          CASE
            WHEN bs.id IS NOT NULL THEN 'brainstorm'
            WHEN COALESCE(ct.kickoff->>'skillPath','') ILIKE '%adr-interview%'
              OR COALESCE(ct.kickoff->>'assistantType','') = 'adr' THEN 'adr'
            WHEN i.id IS NOT NULL AND (
              COALESCE(ct.kickoff->>'skillPath','') ILIKE '%grill-with-docs%'
              OR COALESCE(ct.kickoff->>'skillPath','') ILIKE '%grill-design%'
              OR COALESCE(ct.kickoff->>'skillPath','') ILIKE '%kick-off%'
            ) THEN 'interview'
            WHEN i.id IS NULL AND bs.id IS NULL
              AND COALESCE(ct.kickoff->>'assistantType','') = ''
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%adr%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%standup%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%design-doc%'
              AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%prd%'
              AND COALESCE(ct.kickoff->>'mode','') NOT IN ('standup-participant','standup-facilitator','development')
            THEN 'home-chat'
            ELSE 'skip'
          END AS surface
        FROM gaps g
        JOIN chat_threads ct ON ct.id = g.thread_id
        LEFT JOIN interviews i ON i.chat_thread_id = ct.id
        LEFT JOIN brainstorm_sessions bs ON bs.chat_thread_id = ct.id
        WHERE g.sec BETWEEN 0.5 AND 3600
          AND (${project}::text IS NULL OR COALESCE(bs.project, i.project, ct.kickoff->>'project') = ${project})
      )
      SELECT
        surface,
        count(*)::int AS turns,
        round(avg(sec)::numeric, 1) AS avg_sec,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sec))::numeric, 1) AS p50_sec,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY sec))::numeric, 1) AS p90_sec
      FROM labeled
      WHERE surface <> 'skip'
      GROUP BY 1
    `),

    // Home chat split by skill type
    executor.execute(sql`
      WITH ordered AS (
        SELECT
          m.thread_id,
          m.role,
          m.ts,
          m.tool_name,
          m.id,
          sum(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
            OVER (PARTITION BY m.thread_id ORDER BY m.ts, m.id) AS turn_no
        FROM chat_messages m
        WHERE m.ts >= ${fromIso}::timestamptz
          AND m.ts <= ${toIso}::timestamptz
          AND m.hidden = false
      ),
      turns AS (
        SELECT
          thread_id,
          turn_no,
          min(ts) FILTER (WHERE role = 'user') AS user_ts,
          min(ts) FILTER (WHERE role = 'agent' AND tool_name IS NULL) AS first_text_ts
        FROM ordered
        GROUP BY 1, 2
      ),
      gaps AS (
        SELECT thread_id, user_ts, EXTRACT(EPOCH FROM (first_text_ts - user_ts)) AS sec
        FROM turns
        WHERE user_ts IS NOT NULL AND first_text_ts >= user_ts
      )
      SELECT
        to_char(date_trunc(${truncUnit}, g.user_ts), ${bucketFmt}) AS bucket,
        CASE
          WHEN COALESCE(ct.kickoff->>'skillPath','') = '' THEN 'free-chat'
          WHEN ct.kickoff->>'skillPath' ILIKE '%app-knowledge%' THEN 'app-knowledge'
          ELSE 'other-skill'
        END AS kind,
        count(*)::int AS turns,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY g.sec))::numeric, 1) AS p50_sec
      FROM gaps g
      JOIN chat_threads ct ON ct.id = g.thread_id
      LEFT JOIN interviews i ON i.chat_thread_id = ct.id
      LEFT JOIN brainstorm_sessions bs ON bs.chat_thread_id = ct.id
      WHERE g.sec BETWEEN 0.5 AND 3600
        AND i.id IS NULL
        AND bs.id IS NULL
        AND COALESCE(ct.kickoff->>'assistantType','') = ''
        AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%adr%'
        AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%standup%'
        AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%design-doc%'
        AND COALESCE(ct.kickoff->>'skillPath','') NOT ILIKE '%prd%'
        AND COALESCE(ct.kickoff->>'mode','') NOT IN ('standup-participant','standup-facilitator','development')
        AND (${project}::text IS NULL OR ct.kickoff->>'project' = ${project})
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `),

    // Document / async generation speed by bucket (from ai_usage_events)
    executor.execute(sql`
      WITH classified AS (
        SELECT
          CASE
            WHEN skill_path ILIKE '%to-prd%' THEN 'prd-generation'
            WHEN skill_path ILIKE '%prd-design-spec%' THEN 'design-doc-generation'
            WHEN feature = 'design-prototype' THEN 'design-prototype'
            WHEN feature = 'test-case' THEN 'test-case'
            ELSE 'skip'
          END AS surface,
          created_at,
          duration_ms / 1000.0 AS sec,
          status,
          cost_usd::numeric AS cost_num
        FROM ai_usage_events
        WHERE created_at >= ${fromIso}::timestamptz
          AND created_at <= ${toIso}::timestamptz
          AND (${project}::text IS NULL OR project = ${project})
      )
      SELECT
        surface,
        to_char(date_trunc(${truncUnit}, created_at), ${bucketFmt}) AS bucket,
        count(*)::int AS total_runs,
        count(*) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600)::int AS kept_runs,
        count(*) FILTER (WHERE status = 'success')::int AS success_runs,
        round(avg(sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600)::numeric, 1) AS avg_sec,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600))::numeric, 1) AS p50_sec,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600))::numeric, 1) AS p90_sec,
        round(avg(cost_num)::numeric, 4) AS avg_cost_usd
      FROM classified
      WHERE surface <> 'skip'
      GROUP BY 1, 2
      ORDER BY 2 ASC, 1 ASC
    `),

    // Document generation summary across full window
    executor.execute(sql`
      WITH classified AS (
        SELECT
          CASE
            WHEN skill_path ILIKE '%to-prd%' THEN 'prd-generation'
            WHEN skill_path ILIKE '%prd-design-spec%' THEN 'design-doc-generation'
            WHEN feature = 'design-prototype' THEN 'design-prototype'
            WHEN feature = 'test-case' THEN 'test-case'
            ELSE 'skip'
          END AS surface,
          duration_ms / 1000.0 AS sec,
          status,
          cost_usd::numeric AS cost_num
        FROM ai_usage_events
        WHERE created_at >= ${fromIso}::timestamptz
          AND created_at <= ${toIso}::timestamptz
          AND (${project}::text IS NULL OR project = ${project})
      )
      SELECT
        surface,
        count(*)::int AS total_runs,
        count(*) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600)::int AS kept_runs,
        count(*) FILTER (WHERE status = 'success')::int AS success_runs,
        round(avg(sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600)::numeric, 1) AS avg_sec,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600))::numeric, 1) AS p50_sec,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY sec) FILTER (WHERE status = 'success' AND sec BETWEEN 1 AND 3600))::numeric, 1) AS p90_sec,
        round(avg(cost_num)::numeric, 4) AS avg_cost_usd
      FROM classified
      WHERE surface <> 'skip'
      GROUP BY 1
    `),

    // True TTFT & interactive stage timings (gracefully degrades if migration not yet applied)
    loadStageTimings(executor, fromIso, toIso, project, truncUnit, bucketFmt, granularity),

    // Agent run reliability & queue wait summary
    executor.execute(sql`
      SELECT
        count(*)::int AS total_runs,
        count(*) FILTER (WHERE status = 'completed')::int AS completed_runs,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_runs,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - queued_at)))
          FILTER (WHERE queued_at IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_at >= queued_at AND EXTRACT(EPOCH FROM (dispatched_at - queued_at)) <= 3600))::numeric, 2) AS queue_wait_p50_sec,
        round((percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - queued_at)))
          FILTER (WHERE queued_at IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_at >= queued_at AND EXTRACT(EPOCH FROM (dispatched_at - queued_at)) <= 3600))::numeric, 2) AS queue_wait_p90_sec
      FROM agent_runs
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND status IN ('completed', 'failed', 'cancelled')
        AND (${project}::text IS NULL OR project_id = ${project})
    `),

    // Agent run reliability trend
    executor.execute(sql`
      SELECT
        to_char(date_trunc(${truncUnit}, created_at), ${bucketFmt}) AS bucket,
        count(*)::int AS total_runs,
        count(*) FILTER (WHERE status = 'completed')::int AS completed_runs,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_runs,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (dispatched_at - queued_at)))
          FILTER (WHERE queued_at IS NOT NULL AND dispatched_at IS NOT NULL AND dispatched_at >= queued_at AND EXTRACT(EPOCH FROM (dispatched_at - queued_at)) <= 3600))::numeric, 2) AS queue_wait_p50_sec
      FROM agent_runs
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND status IN ('completed', 'failed', 'cancelled')
        AND (${project}::text IS NULL OR project_id = ${project})
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // Terminal failure reasons
    executor.execute(sql`
      SELECT
        COALESCE(terminal_reason, 'unspecified_failure') AS reason,
        count(*)::int AS count
      FROM agent_runs
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND status IN ('failed', 'cancelled')
        AND (${project}::text IS NULL OR project_id = ${project})
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 8
    `),

    // App & API latency overall (from trace_events)
    executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE event_type = 'api_request')::int AS total_requests,
        count(*) FILTER (WHERE event_type = 'api_request' AND status_code >= 500)::int AS error_requests,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE event_type = 'api_request' AND duration_ms IS NOT NULL))::numeric, 0) AS p50_ms,
        round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE event_type = 'api_request' AND duration_ms IS NOT NULL))::numeric, 0) AS p95_ms,
        count(*) FILTER (WHERE event_type = 'error')::int AS client_errors
      FROM trace_events
      WHERE occurred_at >= ${fromIso}::timestamptz
        AND occurred_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR project_id = ${project})
    `),

    // App & API latency trend
    executor.execute(sql`
      SELECT
        to_char(date_trunc(${truncUnit}, occurred_at), ${bucketFmt}) AS bucket,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status_code >= 500)::int AS error_requests,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::numeric, 0) AS p50_ms,
        round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::numeric, 0) AS p95_ms
      FROM trace_events
      WHERE occurred_at >= ${fromIso}::timestamptz
        AND occurred_at <= ${toIso}::timestamptz
        AND event_type = 'api_request'
        AND (${project}::text IS NULL OR project_id = ${project})
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // Slowest API routes
    executor.execute(sql`
      SELECT
        route_template,
        count(*)::int AS requests,
        count(*) FILTER (WHERE status_code >= 500)::int AS error_requests,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0) AS p50_ms,
        round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::numeric, 0) AS p95_ms
      FROM trace_events
      WHERE occurred_at >= ${fromIso}::timestamptz
        AND occurred_at <= ${toIso}::timestamptz
        AND event_type = 'api_request'
        AND route_template IS NOT NULL
        AND duration_ms IS NOT NULL
        AND (${project}::text IS NULL OR project_id = ${project})
      GROUP BY 1
      HAVING count(*) >= 5
      ORDER BY p95_ms DESC NULLS LAST
      LIMIT 10
    `),

    // Cost & cache overall
    executor.execute(sql`
      SELECT
        COALESCE(SUM(cost_usd::numeric), 0) AS total_cost_usd,
        count(*)::int AS interactions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM ai_usage_events
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR project = ${project})
    `),

    // Cost & cache trend
    executor.execute(sql`
      SELECT
        to_char(date_trunc(${truncUnit}, created_at), ${bucketFmt}) AS bucket,
        COALESCE(SUM(cost_usd::numeric), 0) AS total_cost_usd,
        count(*)::int AS interactions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM ai_usage_events
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR project = ${project})
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // Model performance & cost breakdown
    executor.execute(sql`
      SELECT
        model_id,
        count(*)::int AS runs,
        round(avg(duration_ms / 1000.0) FILTER (WHERE duration_ms > 0 AND duration_ms <= 3600000)::numeric, 1) AS avg_sec,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms / 1000.0) FILTER (WHERE duration_ms > 0 AND duration_ms <= 3600000))::numeric, 1) AS p50_sec,
        COALESCE(SUM(cost_usd::numeric), 0) AS total_cost_usd,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
      FROM ai_usage_events
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR project = ${project})
      GROUP BY 1
      ORDER BY runs DESC
      LIMIT 10
    `),

    // User ratings from skill_signals
    executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE value = 1)::int AS good,
        count(*) FILTER (WHERE value = 0)::int AS needs_improvement,
        count(*) FILTER (WHERE value = -1)::int AS bad
      FROM skill_signals
      WHERE kind = 'rating'
        AND created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR project = ${project})
    `).catch((err) => {
      if (isMissingRelationError(err)) return { rows: [{ good: 0, needs_improvement: 0, bad: 0 }] };
      throw err;
    }),

    // Flagged chat threads
    executor.execute(sql`
      SELECT
        count(*) FILTER (WHERE flagged = true)::int AS flagged,
        count(*)::int AS total
      FROM chat_threads
      WHERE created_at >= ${fromIso}::timestamptz
        AND created_at <= ${toIso}::timestamptz
        AND (${project}::text IS NULL OR kickoff->>'project' = ${project})
    `),
  ]);

  const availableProjects = rowsOf<ProjectRow>(projectsRes)
    .map((r) => r.project)
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  // Build conversational trend + module map
  const convBucketRows = rowsOf<ConvBucketRow>(convBucketsRes);
  const convSummaryRows = rowsOf<ConvSummaryRow>(convSummaryRes);
  const convTrendMap = new Map<string, AiExperienceConversationTrendPoint>();
  const earliestConvP50 = new Map<string, number>();
  const latestConvP50 = new Map<string, number>();

  for (const row of convBucketRows) {
    const p50 = toNum(row.p50_sec);
    const p90 = toNum(row.p90_sec);
    const turns = toInt(row.turns);
    if (p50 !== null) {
      if (!earliestConvP50.has(row.surface)) earliestConvP50.set(row.surface, p50);
      latestConvP50.set(row.surface, p50);
    }
    let pt = convTrendMap.get(row.bucket);
    if (!pt) {
      pt = {
        bucket: row.bucket,
        label: formatBucketLabel(row.bucket, granularity),
        homeChatP50Sec: null,
        homeChatP90Sec: null,
        interviewP50Sec: null,
        interviewP90Sec: null,
        brainstormP50Sec: null,
        brainstormP90Sec: null,
        adrP50Sec: null,
        adrP90Sec: null,
        totalTurns: 0,
      };
      convTrendMap.set(row.bucket, pt);
    }
    pt.totalTurns += turns;
    if (row.surface === 'home-chat') {
      pt.homeChatP50Sec = p50;
      pt.homeChatP90Sec = p90;
    } else if (row.surface === 'interview') {
      pt.interviewP50Sec = p50;
      pt.interviewP90Sec = p90;
    } else if (row.surface === 'brainstorm') {
      pt.brainstormP50Sec = p50;
      pt.brainstormP90Sec = p90;
    } else if (row.surface === 'adr') {
      pt.adrP50Sec = p50;
      pt.adrP90Sec = p90;
    }
  }

  const conversationTrend = Array.from(convTrendMap.values()).sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );

  // Build home chat skill split trend
  const homeSplitRows = rowsOf<HomeSplitRow>(homeSplitRes);
  const homeSplitMap = new Map<string, AiExperienceHomeChatSplitPoint>();
  for (const row of homeSplitRows) {
    let pt = homeSplitMap.get(row.bucket);
    if (!pt) {
      pt = {
        bucket: row.bucket,
        label: formatBucketLabel(row.bucket, granularity),
        appKnowledgeP50Sec: null,
        otherSkillP50Sec: null,
        freeChatP50Sec: null,
        turns: 0,
      };
      homeSplitMap.set(row.bucket, pt);
    }
    pt.turns += toInt(row.turns);
    const p50 = toNum(row.p50_sec);
    if (row.kind === 'app-knowledge') pt.appKnowledgeP50Sec = p50;
    else if (row.kind === 'other-skill') pt.otherSkillP50Sec = p50;
    else if (row.kind === 'free-chat') pt.freeChatP50Sec = p50;
  }
  const homeChatSplit = Array.from(homeSplitMap.values()).sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );

  // Build document generation trend + module map
  const genBucketRows = rowsOf<GenBucketRow>(genBucketsRes);
  const genSummaryRows = rowsOf<GenSummaryRow>(genSummaryRes);
  const genTrendMap = new Map<string, AiExperienceGenerationTrendPoint>();
  const earliestGenP50 = new Map<string, number>();
  const latestGenP50 = new Map<string, number>();

  for (const row of genBucketRows) {
    const p50Sec = toNum(row.p50_sec);
    const p90Sec = toNum(row.p90_sec);
    const kept = toInt(row.kept_runs);
    if (p50Sec !== null) {
      if (!earliestGenP50.has(row.surface)) earliestGenP50.set(row.surface, p50Sec);
      latestGenP50.set(row.surface, p50Sec);
    }
    let pt = genTrendMap.get(row.bucket);
    if (!pt) {
      pt = {
        bucket: row.bucket,
        label: formatBucketLabel(row.bucket, granularity),
        prdP50Min: null,
        prdP90Min: null,
        designDocP50Min: null,
        designDocP90Min: null,
        prototypeP50Min: null,
        testCaseP50Min: null,
        totalRuns: 0,
      };
      genTrendMap.set(row.bucket, pt);
    }
    pt.totalRuns += kept;
    const p50Min = p50Sec !== null ? round2(p50Sec / 60) : null;
    const p90Min = p90Sec !== null ? round2(p90Sec / 60) : null;
    if (row.surface === 'prd-generation') {
      pt.prdP50Min = p50Min;
      pt.prdP90Min = p90Min;
    } else if (row.surface === 'design-doc-generation') {
      pt.designDocP50Min = p50Min;
      pt.designDocP90Min = p90Min;
    } else if (row.surface === 'design-prototype') {
      pt.prototypeP50Min = p50Min;
    } else if (row.surface === 'test-case') {
      pt.testCaseP50Min = p50Min;
    }
  }

  const generationTrend = Array.from(genTrendMap.values()).sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );

  // Assemble unified module scoreboard
  const convBySurface = new Map(convSummaryRows.map((r) => [r.surface, r]));
  const genBySurface = new Map(genSummaryRows.map((r) => [r.surface, r]));

  const moduleOrder: AiExperienceModuleKey[] = [
    'home-chat',
    'interview',
    'brainstorm',
    'adr',
    'prd-generation',
    'design-doc-generation',
    'design-prototype',
    'test-case',
  ];

  const modules: AiExperienceModuleSummary[] = [];
  for (const key of moduleOrder) {
    const meta = MODULE_META[key];
    if (meta.category === 'conversation') {
      const row = convBySurface.get(key);
      if (!row && key === 'adr') continue;
      const earliest = earliestConvP50.get(key) ?? null;
      const latest = latestConvP50.get(key) ?? null;
      const hasMultiBucket =
        convBucketRows.filter((b) => b.surface === key && toNum(b.p50_sec) !== null).length >= 2;
      modules.push({
        key,
        label: meta.label,
        category: 'conversation',
        turns: row ? toInt(row.turns) : 0,
        p50Sec: row ? toNum(row.p50_sec) : null,
        avgSec: row ? toNum(row.avg_sec) : null,
        p90Sec: row ? toNum(row.p90_sec) : null,
        earliestP50Sec: earliest,
        latestP50Sec: latest,
        deltaPct: hasMultiBucket ? computeDeltaPct(earliest, latest) : null,
        successRatePct: null,
        avgCostUsd: null,
      });
    } else {
      const row = genBySurface.get(key);
      if (!row && (key === 'design-prototype' || key === 'test-case')) continue;
      const total = row ? toInt(row.total_runs) : 0;
      const success = row ? toInt(row.success_runs) : 0;
      const earliest = earliestGenP50.get(key) ?? null;
      const latest = latestGenP50.get(key) ?? null;
      const hasMultiBucket =
        genBucketRows.filter((b) => b.surface === key && toNum(b.p50_sec) !== null).length >= 2;
      modules.push({
        key,
        label: meta.label,
        category: 'generation',
        turns: row ? toInt(row.kept_runs) : 0,
        p50Sec: row ? toNum(row.p50_sec) : null,
        avgSec: row ? toNum(row.avg_sec) : null,
        p90Sec: row ? toNum(row.p90_sec) : null,
        earliestP50Sec: earliest,
        latestP50Sec: latest,
        deltaPct: hasMultiBucket ? computeDeltaPct(earliest, latest) : null,
        successRatePct: total > 0 ? round1((success / total) * 100) : null,
        avgCostUsd: row ? round4(toNum(row.avg_cost_usd)) : null,
      });
    }
  }

  // Reliability summary
  const relOverall = rowsOf<ReliabilityOverallRow>(reliabilityOverallRes)[0];
  const totalRuns = toInt(relOverall?.total_runs);
  const completedRuns = toInt(relOverall?.completed_runs);
  const failedRuns = toInt(relOverall?.failed_runs);
  const cancelledRuns = toInt(relOverall?.cancelled_runs);
  const reliability: AiExperienceReliabilitySummary = {
    totalRuns,
    completedRuns,
    failedRuns,
    cancelledRuns,
    successRatePct: totalRuns > 0 ? round1((completedRuns / totalRuns) * 100) : null,
    queueWaitP50Sec: toNum(relOverall?.queue_wait_p50_sec),
    queueWaitP90Sec: toNum(relOverall?.queue_wait_p90_sec),
    terminalReasons: rowsOf<TerminalReasonRow>(terminalReasonsRes).map((r) => ({
      reason: r.reason,
      count: toInt(r.count),
    })),
    trend: rowsOf<ReliabilityTrendRow>(reliabilityTrendRes).map((r) => {
      const total = toInt(r.total_runs);
      const completed = toInt(r.completed_runs);
      return {
        bucket: r.bucket,
        label: formatBucketLabel(r.bucket, granularity),
        successRatePct: total > 0 ? round1((completed / total) * 100) : null,
        totalRuns: total,
        failedRuns: toInt(r.failed_runs),
        cancelledRuns: toInt(r.cancelled_runs),
        queueWaitP50Sec: toNum(r.queue_wait_p50_sec),
      };
    }),
  };

  // API experience summary
  const apiOverall = rowsOf<ApiOverallRow>(apiOverallRes)[0];
  const apiTotalReqs = toInt(apiOverall?.total_requests);
  const apiErrorReqs = toInt(apiOverall?.error_requests);
  const apiExperience: AiExperienceApiSummary = {
    totalRequests: apiTotalReqs,
    p50Ms: toNum(apiOverall?.p50_ms),
    p95Ms: toNum(apiOverall?.p95_ms),
    errorRatePct: apiTotalReqs > 0 ? round2((apiErrorReqs / apiTotalReqs) * 100) : null,
    clientErrors: toInt(apiOverall?.client_errors),
    trend: rowsOf<ApiTrendRow>(apiTrendRes).map((r) => {
      const reqs = toInt(r.requests);
      const errs = toInt(r.error_requests);
      return {
        bucket: r.bucket,
        label: formatBucketLabel(r.bucket, granularity),
        p50Ms: toNum(r.p50_ms),
        p95Ms: toNum(r.p95_ms),
        errorRatePct: reqs > 0 ? round2((errs / reqs) * 100) : null,
        requests: reqs,
      };
    }),
    slowestRoutes: rowsOf<ApiRouteRow>(apiRoutesRes).map((r) => {
      const reqs = toInt(r.requests);
      const errs = toInt(r.error_requests);
      return {
        routeTemplate: r.route_template,
        requests: reqs,
        p50Ms: toNum(r.p50_ms) ?? 0,
        p95Ms: toNum(r.p95_ms) ?? 0,
        errorRatePct: reqs > 0 ? (round2((errs / reqs) * 100) ?? 0) : 0,
      };
    }),
  };

  // Cost, cache & user quality
  const costOverall = rowsOf<CostOverallRow>(costOverallRes)[0];
  const totalCostUsd = round2(toNum(costOverall?.total_cost_usd) ?? 0) ?? 0;
  const totalInteractions = toInt(costOverall?.interactions);
  const totalInput = toNum(costOverall?.input_tokens) ?? 0;
  const totalCacheRead = toNum(costOverall?.cache_read_tokens) ?? 0;
  const overallCacheHitPct =
    totalInput + totalCacheRead > 0
      ? round1((totalCacheRead / (totalInput + totalCacheRead)) * 100)
      : null;

  const ratingRow = rowsOf<RatingRow>(ratingsRes)[0];
  const good = toInt(ratingRow?.good);
  const needsImprovement = toInt(ratingRow?.needs_improvement);
  const bad = toInt(ratingRow?.bad);
  const ratingsTotal = good + needsImprovement + bad;

  const flaggedRow = rowsOf<FlaggedRow>(flaggedRes)[0];
  const flaggedCount = toInt(flaggedRow?.flagged);
  const threadsTotal = toInt(flaggedRow?.total);

  const costAndQuality: AiExperienceCostAndQualitySummary = {
    totalCostUsd,
    totalInteractions,
    cacheHitPct: overallCacheHitPct,
    trend: rowsOf<CostTrendRow>(costTrendRes).map((r) => {
      const cost = round2(toNum(r.total_cost_usd) ?? 0) ?? 0;
      const interactions = toInt(r.interactions);
      const inp = toNum(r.input_tokens) ?? 0;
      const cr = toNum(r.cache_read_tokens) ?? 0;
      return {
        bucket: r.bucket,
        label: formatBucketLabel(r.bucket, granularity),
        totalCostUsd: cost,
        avgCostPerRunUsd: interactions > 0 ? round4(cost / interactions) : null,
        cacheHitPct: inp + cr > 0 ? round1((cr / (inp + cr)) * 100) : null,
        interactions,
      };
    }),
    byModel: rowsOf<ModelRow>(modelRes).map((r) => {
      const runs = toInt(r.runs);
      const totalCost = round2(toNum(r.total_cost_usd) ?? 0) ?? 0;
      const inp = toNum(r.input_tokens) ?? 0;
      const cr = toNum(r.cache_read_tokens) ?? 0;
      return {
        modelId: r.model_id,
        runs,
        avgSec: toNum(r.avg_sec),
        p50Sec: toNum(r.p50_sec),
        avgCostUsd: runs > 0 ? (round4(totalCost / runs) ?? 0) : 0,
        totalCostUsd: totalCost,
        cacheHitPct: inp + cr > 0 ? round1((cr / (inp + cr)) * 100) : null,
      };
    }),
    ratings: {
      good,
      needsImprovement,
      bad,
      total: ratingsTotal,
      positiveRatePct: ratingsTotal > 0 ? round1((good / ratingsTotal) * 100) : null,
    },
    flaggedThreads: {
      flagged: flaggedCount,
      total: threadsTotal,
      ratePct: threadsTotal > 0 ? round2((flaggedCount / threadsTotal) * 100) : null,
    },
  };

  // Weighted headline medians across conversational & generation modules
  const convModules = modules.filter((m) => m.category === 'conversation' && m.turns > 0 && m.p50Sec !== null);
  const conversationalTurns = convModules.reduce((acc, m) => acc + m.turns, 0);
  const conversationalMedianSec =
    conversationalTurns > 0
      ? round1(
          convModules.reduce((acc, m) => acc + (m.p50Sec ?? 0) * m.turns, 0) / conversationalTurns,
        )
      : null;

  const genModules = modules.filter((m) => m.category === 'generation' && m.turns > 0 && m.p50Sec !== null);
  const generationRuns = genModules.reduce((acc, m) => acc + m.turns, 0);
  const generationMedianSec =
    generationRuns > 0
      ? round1(
          genModules.reduce((acc, m) => acc + (m.p50Sec ?? 0) * m.turns, 0) / generationRuns,
        )
      : null;

  return {
    window,
    windowLabel: AI_EXPERIENCE_WINDOW_LABELS[window],
    granularity,
    project,
    availableProjects,
    fromIso,
    toIso,
    generatedAt: now.toISOString(),
    headline: {
      conversationalMedianSec,
      conversationalTurns,
      generationMedianSec,
      generationRuns,
      successRatePct: reliability.successRatePct,
      totalRuns: reliability.totalRuns,
      firstTokenMedianMs: stageTimings.ttftP50Ms,
      firstTokenSamples: stageTimings.sampleCount,
      apiP95Ms: apiExperience.p95Ms,
      apiRequests: apiExperience.totalRequests,
      totalCostUsd,
      cacheHitPct: overallCacheHitPct,
    },
    modules,
    conversationTrend,
    generationTrend,
    homeChatSplit,
    stageTimings,
    reliability,
    apiExperience,
    costAndQuality,
  };
}

async function loadStageTimings(
  executor: AiExperienceDbExecutor,
  fromIso: string,
  toIso: string,
  project: string | null,
  truncUnit: string,
  bucketFmt: string,
  granularity: AiExperienceGranularity,
): Promise<AiExperienceStageTimingsSummary> {
  try {
    const [overallRes, areaRes, trendRes] = await Promise.all([
      executor.execute(sql`
        SELECT
          count(*)::int AS samples,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL))::numeric, 0) AS ttft_p50_ms,
          round((percentile_cont(0.9) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL))::numeric, 0) AS ttft_p90_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_event_ms) FILTER (WHERE first_event_ms IS NOT NULL))::numeric, 0) AS first_event_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY workspace_ms) FILTER (WHERE workspace_ms IS NOT NULL))::numeric, 0) AS workspace_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY agent_acquire_ms) FILTER (WHERE agent_acquire_ms IS NOT NULL))::numeric, 0) AS acquire_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY worker_turn_ms) FILTER (WHERE worker_turn_ms IS NOT NULL))::numeric, 0) AS worker_turn_p50_ms,
          count(*) FILTER (WHERE agent_mode = 'warm')::int AS warm_count,
          count(*) FILTER (WHERE agent_mode = 'resumed')::int AS resumed_count,
          count(*) FILTER (WHERE agent_mode = 'recreated')::int AS recreated_count
        FROM ai_turn_stage_timings
        WHERE recorded_at >= ${fromIso}::timestamptz
          AND recorded_at <= ${toIso}::timestamptz
          AND (${project}::text IS NULL OR project_id = ${project})
      `),
      executor.execute(sql`
        SELECT
          COALESCE(area, workflow_class, 'unknown') AS area,
          count(*)::int AS samples,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL))::numeric, 0) AS ttft_p50_ms,
          round((percentile_cont(0.9) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL))::numeric, 0) AS ttft_p90_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_event_ms) FILTER (WHERE first_event_ms IS NOT NULL))::numeric, 0) AS first_event_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY worker_turn_ms) FILTER (WHERE worker_turn_ms IS NOT NULL))::numeric, 0) AS worker_turn_p50_ms,
          count(*) FILTER (WHERE agent_mode = 'warm')::int AS warm_count
        FROM ai_turn_stage_timings
        WHERE recorded_at >= ${fromIso}::timestamptz
          AND recorded_at <= ${toIso}::timestamptz
          AND (${project}::text IS NULL OR project_id = ${project})
        GROUP BY 1
        ORDER BY samples DESC
      `),
      executor.execute(sql`
        SELECT
          to_char(date_trunc(${truncUnit}, recorded_at), ${bucketFmt}) AS bucket,
          count(*)::int AS samples,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL))::numeric, 0) AS ttft_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY first_event_ms) FILTER (WHERE first_event_ms IS NOT NULL))::numeric, 0) AS first_event_p50_ms,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY worker_turn_ms) FILTER (WHERE worker_turn_ms IS NOT NULL))::numeric, 0) AS worker_turn_p50_ms
        FROM ai_turn_stage_timings
        WHERE recorded_at >= ${fromIso}::timestamptz
          AND recorded_at <= ${toIso}::timestamptz
          AND (${project}::text IS NULL OR project_id = ${project})
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    const overall = rowsOf<StageOverallRow>(overallRes)[0];
    const sampleCount = toInt(overall?.samples);
    if (sampleCount === 0) return emptyStageTimings();

    return {
      sampleCount,
      ttftP50Ms: toNum(overall?.ttft_p50_ms),
      ttftP90Ms: toNum(overall?.ttft_p90_ms),
      firstEventP50Ms: toNum(overall?.first_event_p50_ms),
      workspaceP50Ms: toNum(overall?.workspace_p50_ms),
      acquireP50Ms: toNum(overall?.acquire_p50_ms),
      workerTurnP50Ms: toNum(overall?.worker_turn_p50_ms),
      warmCount: toInt(overall?.warm_count),
      resumedCount: toInt(overall?.resumed_count),
      recreatedCount: toInt(overall?.recreated_count),
      byArea: rowsOf<StageAreaRow>(areaRes).map((r) => {
        const samples = toInt(r.samples);
        const warm = toInt(r.warm_count);
        return {
          area: r.area,
          label: AREA_LABELS[r.area] ?? r.area,
          samples,
          ttftP50Ms: toNum(r.ttft_p50_ms),
          ttftP90Ms: toNum(r.ttft_p90_ms),
          firstEventP50Ms: toNum(r.first_event_p50_ms),
          workerTurnP50Ms: toNum(r.worker_turn_p50_ms),
          warmPct: samples > 0 ? round1((warm / samples) * 100) : null,
        };
      }),
      trend: rowsOf<StageTrendRow>(trendRes).map((r) => ({
        bucket: r.bucket,
        label: formatBucketLabel(r.bucket, granularity),
        ttftP50Ms: toNum(r.ttft_p50_ms),
        firstEventP50Ms: toNum(r.first_event_p50_ms),
        workerTurnP50Ms: toNum(r.worker_turn_p50_ms),
        samples: toInt(r.samples),
      })),
    };
  } catch (err) {
    if (isMissingRelationError(err)) return emptyStageTimings();
    throw err;
  }
}
