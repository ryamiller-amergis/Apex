/**
 * FEAT-007 / TBI-009 — merge canonical agent-run history with Trace Event overlays.
 * Lifecycle rows stay in agent_runs / agent_run_events; they are never copied to trace_events.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AgentRunEventType, AgentRunHealth, AgentRunPhase } from '../../shared/types/chat';
import {
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_PAGE_SIZE,
  SESSION_TIMELINE_SOURCE_RANK,
  TRACE_REDACTED_MARKER,
  type AgentTimelineEntry,
  type SessionTimelineEntry,
  type SessionTimelineEntryStatus,
  type SessionTimelineKeyset,
  type SessionTimelineQuery,
  type SessionTimelineResponse,
  type SessionTimelineSource,
  type SessionTimelineSourceState,
  type SessionTimelineVerdict,
  type TraceEventView,
  type TraceTimelineEntry,
} from '../../shared/types/observability';
import { scrubSafeDisplayText } from '../../shared/utils/traceRedaction';
import { db as defaultDb } from '../db/drizzle';
import { agentRunEvents, agentRuns, chatThreads, interviews, traceEvents } from '../db/schema';
import {
  assessAgentRunHealth,
  resolveAgentRunHealthConfig,
  type AgentRunHealthConfig,
  type AgentRunHealthSnapshot,
} from './agentRunReaperService';
import {
  encodeSessionTimelineCursor,
  hashSessionTimelineFilters,
  observabilityNotFound,
  ObservabilityTimelineUnavailableError,
} from './observabilityQueryValidation';

const DETAIL_MAX = 500;
const SKIP_AGENT_EVENT_TYPES = new Set<string>(['token', 'message']);
const HEALTH_VALUES = new Set<AgentRunHealth>([
  'healthy',
  'progress_stale',
  'progress_timeout',
  'long_running',
  'worker_lost',
  'hard_timeout',
  'never_claimed',
]);

const VERDICT_COPY: Record<AgentRunHealth, { label: string; detail: string }> = {
  healthy: {
    label: 'Healthy',
    detail: 'The latest run is progressing within established limits.',
  },
  progress_stale: {
    label: 'Progress stale',
    detail: 'Meaningful progress has lagged past the warning threshold.',
  },
  progress_timeout: {
    label: 'Progress timeout',
    detail: 'The run exceeded the progress abort threshold.',
  },
  long_running: {
    label: 'Long running',
    detail: 'The run has exceeded the long-running warning threshold.',
  },
  worker_lost: {
    label: 'Worker lost',
    detail: 'The worker heartbeat stopped before the run completed.',
  },
  hard_timeout: {
    label: 'Hard timeout',
    detail: 'The run exceeded the configured hard limit.',
  },
  never_claimed: {
    label: 'Never claimed',
    detail: 'The queued run was never claimed by a worker.',
  },
};

const FAILURE_VERDICTS = new Set<AgentRunHealth>([
  'progress_timeout',
  'worker_lost',
  'hard_timeout',
  'never_claimed',
]);

export interface CanonicalRunRow extends AgentRunHealthSnapshot {
  id: string;
  lastError: string | null;
}

export interface CanonicalSessionIdentity {
  sessionId: string;
  interviewId?: string;
  startedAt?: string;
  completedAt?: string;
  runs: CanonicalRunRow[];
}

export interface DurableRunEventRow {
  eventId: string;
  runId: string;
  eventType: AgentRunEventType;
  phase: AgentRunPhase;
  status: SessionTimelineEntryStatus;
  detail: string | null;
  occurredAt: string;
  sequence: number;
  ordinal: number;
  toolName?: string;
  durationMs?: number;
  health?: AgentRunHealth;
}

export interface SessionTimelineLoaders {
  loadSessionIdentity(sessionId: string): Promise<CanonicalSessionIdentity | null>;
  loadDurableEvents(sessionId: string): Promise<DurableRunEventRow[]>;
  loadTraceOverlays(sessionId: string): Promise<TraceEventView[]>;
}

export interface SessionTimelineDeps {
  loaders?: SessionTimelineLoaders;
  now?: () => number;
  healthConfig?: AgentRunHealthConfig;
  assessHealth?: typeof assessAgentRunHealth;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scrubOptional(value: string | null | undefined, max = DETAIL_MAX): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const scrubbed = scrubSafeDisplayText(value.trim(), max)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, TRACE_REDACTED_MARKER)
    .replace(/https?:\/\/[^\s]+/gi, TRACE_REDACTED_MARKER)
    .replace(/\bstack\s*:[^\n]*(?:\n\s+at[^\n]*)*/gi, TRACE_REDACTED_MARKER)
    .trim();
  return scrubbed.length > 0 ? scrubbed : undefined;
}

function parseHealth(value: unknown): AgentRunHealth | undefined {
  return typeof value === 'string' && HEALTH_VALUES.has(value as AgentRunHealth)
    ? (value as AgentRunHealth)
    : undefined;
}

function parseDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapTerminalHealthFromLastError(lastError: string | null): AgentRunHealth | null {
  if (!lastError) return null;
  if (lastError.startsWith('Worker lost')) return 'worker_lost';
  if (lastError.startsWith('Run exceeded configured hard limit')) return 'hard_timeout';
  if (lastError.startsWith('Never claimed')) return 'never_claimed';
  if (lastError.includes('run aborted')) return 'progress_timeout';
  return null;
}

function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'dispatched';
}

function sourceRank(source: SessionTimelineSource): 0 | 1 {
  return SESSION_TIMELINE_SOURCE_RANK[source];
}

function sequenceOf(entry: SessionTimelineEntry): number {
  return entry.source === 'agent' ? entry.sequence : 0;
}

export function compareSessionTimelineEntries(a: SessionTimelineEntry, b: SessionTimelineEntry): number {
  const time = a.occurredAt.localeCompare(b.occurredAt);
  if (time !== 0) return time;
  const rank = sourceRank(a.source) - sourceRank(b.source);
  if (rank !== 0) return rank;
  const seq = sequenceOf(a) - sequenceOf(b);
  if (seq !== 0) return seq;
  return a.id.localeCompare(b.id);
}

function isAfterCursor(entry: SessionTimelineEntry, cursor: SessionTimelineKeyset): boolean {
  if (entry.occurredAt !== cursor.occurredAt) return entry.occurredAt > cursor.occurredAt;
  const rank = sourceRank(entry.source);
  if (rank !== cursor.sourceRank) return rank > cursor.sourceRank;
  const seq = sequenceOf(entry);
  if (seq !== cursor.sequence) return seq > cursor.sequence;
  return entry.id > cursor.id;
}

function keysetOf(entry: SessionTimelineEntry): SessionTimelineKeyset {
  return {
    occurredAt: entry.occurredAt,
    sourceRank: sourceRank(entry.source),
    sequence: sequenceOf(entry),
    id: entry.id,
  };
}

function addDetail(
  details: Array<{ label: string; value: string }>,
  label: string,
  value: string | number | undefined | null,
): void {
  if (value == null || value === '') return;
  details.push({ label, value: String(value) });
}

function mapAgentStatus(status: string): SessionTimelineEntryStatus {
  if (
    status === 'pending'
    || status === 'running'
    || status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
  ) {
    return status;
  }
  return 'info';
}

function agentTitle(row: DurableRunEventRow): string {
  if (row.eventType === 'health' && row.health) {
    return `Health: ${VERDICT_COPY[row.health].label}`;
  }
  if (row.eventType === 'tool' || row.toolName) {
    return row.toolName ? `Tool: ${row.toolName}` : 'Tool event';
  }
  if (row.eventType === 'phase') return `Phase: ${row.phase}`;
  if (row.eventType === 'error') return 'Run error';
  if (row.eventType === 'done') return 'Run completed';
  if (row.eventType === 'cancel') return 'Run cancelled';
  if (row.eventType === 'retrying') return 'Retrying';
  if (row.eventType === 'grounding') return 'Grounding';
  return 'Agent event';
}

export function projectAgentEntry(row: DurableRunEventRow): AgentTimelineEntry | null {
  if (SKIP_AGENT_EVENT_TYPES.has(row.eventType)) return null;
  const safeDetail = scrubOptional(row.detail);
  const toolName = scrubOptional(row.toolName, 80);
  const details: Array<{ label: string; value: string }> = [];
  addDetail(details, 'Run ID', row.runId);
  addDetail(details, 'Event type', row.eventType);
  addDetail(details, 'Phase', row.phase);
  addDetail(details, 'Status', row.status);
  addDetail(details, 'Sequence', row.sequence);
  addDetail(details, 'Tool', toolName);
  addDetail(details, 'Duration (ms)', row.durationMs);
  addDetail(details, 'Detail', safeDetail);
  return {
    id: row.eventId,
    source: 'agent',
    occurredAt: row.occurredAt,
    title: agentTitle({ ...row, toolName }),
    status: mapAgentStatus(row.status),
    safeDetail,
    details,
    runId: row.runId,
    eventType: row.eventType,
    phase: row.phase,
    sequence: row.sequence,
    toolName,
    durationMs: row.durationMs,
  };
}

function traceStatus(row: TraceEventView): SessionTimelineEntryStatus {
  if (row.eventType === 'error') return 'failed';
  if (row.statusCode != null && row.statusCode >= 400) return 'failed';
  return 'completed';
}

export function projectTraceEntry(row: TraceEventView): TraceTimelineEntry | null {
  if (row.eventType !== 'api_request' && row.eventType !== 'error') return null;
  const routeTemplate = row.routeTemplate ?? undefined;
  const method = row.method ?? undefined;
  const title = row.eventType === 'error'
    ? `Error ${row.statusCode ?? ''} ${routeTemplate ?? ''}`.trim()
    : `${method ?? 'API'} ${routeTemplate ?? ''}`.trim();
  const safeDetail = scrubOptional(row.diagnosticSummary);
  const details: Array<{ label: string; value: string }> = [];
  addDetail(details, 'Trace ID', row.traceId);
  addDetail(details, 'Method', method);
  addDetail(details, 'Route', routeTemplate);
  addDetail(details, 'Status code', row.statusCode);
  addDetail(details, 'Duration (ms)', row.durationMs);
  addDetail(details, 'Severity', row.severity);
  addDetail(details, 'Summary', safeDetail);
  return {
    id: row.id,
    source: 'trace',
    occurredAt: row.occurredAt,
    title,
    status: traceStatus(row),
    safeDetail,
    details,
    eventType: row.eventType,
    traceId: row.traceId,
    routeTemplate,
    method,
    statusCode: row.statusCode ?? undefined,
    durationMs: row.durationMs ?? undefined,
    severity: row.severity ?? undefined,
  };
}

function latestRun(runs: CanonicalRunRow[]): CanonicalRunRow | undefined {
  return [...runs].sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))[0];
}

export function selectHangPointEventId(
  health: AgentRunHealth | null,
  events: DurableRunEventRow[],
): string | null {
  if (!health || !FAILURE_VERDICTS.has(health) || events.length === 0) return null;
  const matchingHealth = [...events]
    .reverse()
    .find((event) => event.eventType === 'health' && event.health === health);
  if (matchingHealth) return matchingHealth.eventId;
  const evidence = [...events]
    .reverse()
    .find((event) => {
      const isToolOrPhase = event.eventType === 'tool' || event.eventType === 'phase' || event.eventType === 'error';
      return isToolOrPhase && (event.status === 'running' || event.status === 'failed');
    });
  return evidence?.eventId ?? null;
}

export function buildSessionTimelineVerdict(
  runs: CanonicalRunRow[],
  events: DurableRunEventRow[] | null,
  nowMs: number,
  config: AgentRunHealthConfig,
  assessHealth: typeof assessAgentRunHealth,
): SessionTimelineVerdict {
  const assessedAt = new Date(nowMs).toISOString();
  if (events == null) {
    return {
      health: null,
      label: 'Verdict unavailable',
      detail: 'Canonical lifecycle source failed; health was not guessed from remaining overlays.',
      hangPointEventId: null,
      assessedAt,
    };
  }
  const run = latestRun(runs);
  if (!run) {
    return {
      health: 'healthy',
      label: VERDICT_COPY.healthy.label,
      detail: 'No agent runs were recorded for this session.',
      hangPointEventId: null,
      assessedAt,
    };
  }

  let health: AgentRunHealth;
  if (!isActiveStatus(run.status)) {
    const persisted = [...events]
      .reverse()
      .find((event) => event.eventType === 'health' && event.health);
    health = persisted?.health ?? mapTerminalHealthFromLastError(run.lastError) ?? 'healthy';
  } else {
    health = assessHealth(run, nowMs, config);
  }

  const copy = VERDICT_COPY[health];
  return {
    health,
    label: copy.label,
    detail: copy.detail,
    hangPointEventId: selectHangPointEventId(health, events),
    assessedAt,
  };
}

function sourceStatus(
  state: SessionTimelineSourceState,
  message?: string,
): { state: SessionTimelineSourceState; message?: string } {
  return message ? { state, message } : { state };
}

function extractToolName(event: unknown): string | undefined {
  const rec = asRecord(event);
  return typeof rec.toolName === 'string' ? rec.toolName : undefined;
}

function extractEventHealth(event: unknown): AgentRunHealth | undefined {
  return parseHealth(asRecord(event).health);
}

function extractEventDuration(event: unknown): number | undefined {
  return parseDuration(asRecord(event).durationMs);
}

export function createDefaultSessionTimelineLoaders(): SessionTimelineLoaders {
  return {
    async loadSessionIdentity(sessionId) {
      const threads = await defaultDb
        .select({
          id: chatThreads.id,
          status: chatThreads.status,
          createdAt: chatThreads.createdAt,
          lastActivityAt: chatThreads.lastActivityAt,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, sessionId))
        .limit(1);
      const thread = threads[0];
      if (!thread) return null;

      const interviewRows = await defaultDb
        .select({ id: interviews.id })
        .from(interviews)
        .where(eq(interviews.chatThreadId, sessionId))
        .limit(1);

      const runRows = await defaultDb
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.startedAt,
          heartbeatAt: agentRuns.heartbeatAt,
          progressAt: agentRuns.progressAt,
          progressLabel: agentRuns.progressLabel,
          timeoutAt: agentRuns.timeoutAt,
          lastError: agentRuns.lastError,
        })
        .from(agentRuns)
        .where(eq(agentRuns.threadId, sessionId))
        .orderBy(asc(agentRuns.createdAt));

      const completedAt = runRows.some((run) => isActiveStatus(run.status))
        ? undefined
        : thread.lastActivityAt;

      return {
        sessionId: thread.id,
        interviewId: interviewRows[0]?.id,
        startedAt: thread.createdAt,
        completedAt,
        runs: runRows,
      };
    },
    async loadDurableEvents(sessionId) {
      const rows = await defaultDb
        .select({
          eventId: agentRunEvents.eventId,
          runId: agentRunEvents.runId,
          eventType: agentRunEvents.eventType,
          phase: agentRunEvents.phase,
          status: agentRunEvents.status,
          detail: agentRunEvents.detail,
          occurredAt: agentRunEvents.eventTimestamp,
          sequence: agentRunEvents.sequence,
          ordinal: agentRunEvents.ordinal,
          event: agentRunEvents.event,
        })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.threadId, sessionId))
        .orderBy(asc(agentRunEvents.eventTimestamp), asc(agentRunEvents.sequence), asc(agentRunEvents.eventId))
        .limit(OBSERVABILITY_MAX_ROWS + 1);

      return rows.map((row) => ({
        eventId: row.eventId,
        runId: row.runId,
        eventType: row.eventType,
        phase: row.phase,
        status: mapAgentStatus(row.status),
        detail: row.detail,
        occurredAt: row.occurredAt,
        sequence: row.sequence,
        ordinal: row.ordinal,
        toolName: extractToolName(row.event),
        durationMs: extractEventDuration(row.event),
        health: extractEventHealth(row.event),
      }));
    },
    async loadTraceOverlays(sessionId) {
      const rows = await defaultDb
        .select({
          id: traceEvents.id,
          eventType: traceEvents.eventType,
          occurredAt: traceEvents.occurredAt,
          actorUserId: traceEvents.actorUserId,
          projectId: traceEvents.projectId,
          traceId: traceEvents.traceId,
          sessionId: traceEvents.sessionId,
          routeTemplate: traceEvents.routeTemplate,
          httpMethod: traceEvents.httpMethod,
          statusCode: traceEvents.statusCode,
          durationMs: traceEvents.durationMs,
          severity: traceEvents.severity,
          diagnosticSummary: sql<string | null>`(${traceEvents.details} ->> 'message')`,
        })
        .from(traceEvents)
        .where(
          and(
            eq(traceEvents.sessionId, sessionId),
            inArray(traceEvents.eventType, ['api_request', 'error']),
          ),
        )
        .orderBy(asc(traceEvents.occurredAt), asc(traceEvents.id))
        .limit(OBSERVABILITY_MAX_ROWS + 1);
      return rows.map((row) => ({
        id: String(row.id),
        eventType: row.eventType as TraceEventView['eventType'],
        occurredAt: String(row.occurredAt),
        actorId: row.actorUserId ? String(row.actorUserId) : null,
        projectId: row.projectId ? String(row.projectId) : null,
        traceId: String(row.traceId),
        sessionId: row.sessionId ? String(row.sessionId) : null,
        routeTemplate: row.routeTemplate ? String(row.routeTemplate) : null,
        method: row.httpMethod ? String(row.httpMethod) : null,
        statusCode: typeof row.statusCode === 'number' ? row.statusCode : null,
        durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
        severity: row.severity ? String(row.severity) : null,
        trigger: null,
        diagnosticSummary: typeof row.diagnosticSummary === 'string' ? row.diagnosticSummary : null,
      }));
    },
  };
}

export async function getSessionTimeline(
  query: SessionTimelineQuery,
  deps: SessionTimelineDeps = {},
): Promise<SessionTimelineResponse> {
  const loaders = deps.loaders ?? createDefaultSessionTimelineLoaders();
  const nowMs = deps.now?.() ?? Date.now();
  const config = deps.healthConfig ?? resolveAgentRunHealthConfig();
  const assessHealth = deps.assessHealth ?? assessAgentRunHealth;

  let identity: CanonicalSessionIdentity | null;
  try {
    identity = await loaders.loadSessionIdentity(query.sessionId);
  } catch {
    throw new ObservabilityTimelineUnavailableError();
  }
  if (!identity) observabilityNotFound();

  const [agentSettled, traceSettled] = await Promise.allSettled([
    loaders.loadDurableEvents(query.sessionId),
    loaders.loadTraceOverlays(query.sessionId),
  ]);

  const agentFailed = agentSettled.status === 'rejected';
  const traceFailed = traceSettled.status === 'rejected';
  const agentRows = agentSettled.status === 'fulfilled' ? agentSettled.value : null;
  const traceRows = traceSettled.status === 'fulfilled' ? traceSettled.value : null;

  if (agentFailed && traceFailed) {
    throw new ObservabilityTimelineUnavailableError();
  }

  const agentEntries = (agentRows ?? []).map(projectAgentEntry).filter((row): row is AgentTimelineEntry => row != null);
  const traceEntries = (traceRows ?? []).map(projectTraceEntry).filter((row): row is TraceTimelineEntry => row != null);
  const merged = [...agentEntries, ...traceEntries].sort(compareSessionTimelineEntries);

  const emittedCount = query.cursor?.emittedCount ?? 0;
  const remaining = Math.max(0, OBSERVABILITY_MAX_ROWS - emittedCount);
  const afterCursor = query.cursor?.last
    ? merged.filter((entry) => isAfterCursor(entry, query.cursor!.last))
    : merged;
  const take = Math.min(OBSERVABILITY_PAGE_SIZE, remaining, afterCursor.length);
  const entries = afterCursor.slice(0, take);
  const loaded = emittedCount + entries.length;
  const capReached = loaded >= OBSERVABILITY_MAX_ROWS;
  const hasMore = afterCursor.length > entries.length;
  const last = entries[entries.length - 1];
  const nextCursor = !capReached && hasMore && last
    ? encodeSessionTimelineCursor(hashSessionTimelineFilters(query.sessionId), loaded, keysetOf(last))
    : null;

  const verdict = buildSessionTimelineVerdict(
    identity.runs,
    agentRows,
    nowMs,
    config,
    assessHealth,
  );

  const agentState: SessionTimelineSourceState = agentFailed
    ? 'failed'
    : agentEntries.length === 0
      ? 'empty'
      : 'complete';
  const traceState: SessionTimelineSourceState = traceFailed
    ? 'failed'
    : traceEntries.length === 0
      ? 'empty'
      : 'complete';
  const partial = agentFailed || traceFailed;

  return {
    session: {
      sessionId: identity.sessionId,
      interviewId: identity.interviewId,
      runIds: identity.runs.map((run) => run.id),
      startedAt: identity.startedAt,
      completedAt: identity.completedAt,
    },
    verdict,
    sourceStatus: {
      agent: sourceStatus(
        agentState,
        agentFailed ? 'Canonical agent lifecycle source failed.' : undefined,
      ),
      trace: sourceStatus(
        traceState,
        traceFailed ? 'Trace Event overlay source failed.' : undefined,
      ),
    },
    entries,
    page: {
      nextCursor,
      returned: entries.length,
      loaded,
      cap: OBSERVABILITY_MAX_ROWS,
      capReached,
    },
    partial,
  };
}
