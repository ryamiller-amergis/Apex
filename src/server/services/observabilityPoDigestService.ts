/**
 * Product Owner Observability Digest Service & Twice-Daily Scheduler (06:00 AM & 06:00 PM).
 *
 * Queries PostgreSQL (`trace_events`, `trace_path_rollups`, `app_users`) via Drizzle
 * across Today, 1d, 7d, 14d, 30d, and 60d trend windows. The
 * `.cursor/skills/observability-po-digest/SKILL.md` synthesis runs on the V2 document
 * worker (see observabilityPoDigestRuns.ts); App Service never calls a model here. Until a
 * run finishes, the digest shows the telemetry-only synthesis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/drizzle';
import {
  appGroupMembers,
  appGroups,
  appRoles,
  appUserRoles,
  appUsers,
  traceEvents,
  tracePathRollups,
} from '../db/schema';
import type { EffortLevel } from '../../shared/types/effort';
import {
  OBSERVABILITY_PO_DEFAULT_EFFORT,
  OBSERVABILITY_PO_DEFAULT_MODEL,
  OBSERVABILITY_PO_SCHEDULE_HOURS,
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOW_LABELS,
  type GenerateObservabilityPoDigestRequest,
  type ObservabilityDigestSlot,
  type ObservabilityDynamicSkillSectionItem,
  type ObservabilityPoDigestResponse,
  type ObservabilityPoDigestSnapshot,
  type ObservabilityPoDigestSynthesisRun,
  type ObservabilityTrendWindow,
} from '../../shared/types/observability';
import {
  WINDOW_BASELINE_LABELS,
  aggregateTelemetryFromDatabaseRows,
  buildDefaultScheduleSummary,
  buildDefaultSeedTelemetryRows,
  buildDigestSnapshotFromAggregates,
  computeSlotTimestamps,
  isObservabilityTrendWindow,
  normalizeObservabilityEffort,
  normalizeObservabilityModel,
  parseSkillSectionsFromMarkdown,
  synthesizePoDigestSnapshot,
  type RawDigestRollupRow,
  type RawDigestTraceEventRow,
  type RawDigestUserRow,
} from '../../shared/utils/observabilityPoDigest';
import { OBSERVABILITY_RETENTION_DAYS } from './observabilityOperationsService';
import {
  createObservabilityPoDigestRunStore,
  ObservabilityPoDigestQueueError,
  trackedSuggestionsOf,
  type ObservabilityPoDigestRunStart,
  type ObservabilityPoDigestRunRecord,
  type ObservabilityPoDigestRunStore,
} from './observabilityPoDigestRuns';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

export { isObservabilityTrendWindow, synthesizePoDigestSnapshot };
export { ObservabilityPoDigestQueueError };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DIGEST_EVENT_ROWS = 10_000;

export interface ObservabilityPoTelemetrySource {
  loadTelemetry(
    project: string,
    now: Date,
  ): Promise<{
    events: RawDigestTraceEventRow[];
    rollups: RawDigestRollupRow[];
    users: RawDigestUserRow[];
    fromLiveDatabase: boolean;
  }>;
}

let runStoreOverride: ObservabilityPoDigestRunStore | null = null;
let defaultRunStore: ObservabilityPoDigestRunStore | null = null;
let telemetrySourceOverride: ObservabilityPoTelemetrySource | null = null;
let skillMarkdownOverride: string | null = null;

/** Unit tests and E2E have no Blob or Service Bus, so no synthesis run is started or read. */
const inactiveRunStore: ObservabilityPoDigestRunStore = {
  async start() {
    return { status: 'not_started', reason: 'No V2 transport in test or E2E mode' };
  },
  async latestRun() {
    return null;
  },
  async latestCompleted() {
    return null;
  },
};

function runStore(): ObservabilityPoDigestRunStore {
  if (runStoreOverride) return runStoreOverride;
  if (process.env.NODE_ENV === 'test' || process.env.E2E_MODE === 'true') {
    return inactiveRunStore;
  }
  defaultRunStore ??= createObservabilityPoDigestRunStore();
  return defaultRunStore;
}

export function setObservabilityPoDigestRunStoreForTests(
  store: ObservabilityPoDigestRunStore | null,
): void {
  runStoreOverride = store;
}

export function setObservabilityPoTelemetrySourceForTests(
  source: ObservabilityPoTelemetrySource | null,
): void {
  telemetrySourceOverride = source;
}

export function setObservabilityPoSkillMarkdownForTests(
  markdown: string | null,
): void {
  skillMarkdownOverride = markdown;
}

export function loadObservabilityPoSkillMarkdown(): string {
  if (skillMarkdownOverride !== null) {
    return skillMarkdownOverride;
  }
  const fullPath = path.join(process.cwd(), OBSERVABILITY_PO_SKILL_PATH);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    return `# Observability Product Owner Digest (${OBSERVABILITY_PO_SKILL_PATH})`;
  }
}

/**
 * The telemetry rollup the worker reads beside the frozen skill. The skill itself travels on
 * the specification, so it is only read here to list the extra sections to synthesize.
 */
export function buildObservabilityPoTelemetryInput(input: {
  skillMarkdown: string;
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  aggregated: ReturnType<typeof aggregateTelemetryFromDatabaseRows>;
  previousSuggestions?: ObservabilityDynamicSkillSectionItem[];
}): string {
  const { skillMarkdown, project, window, model, effort, slot, aggregated } = input;
  const previousSuggestions = input.previousSuggestions ?? [];
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const baselineLabel = WINDOW_BASELINE_LABELS[window];
  const parsedSections = parseSkillSectionsFromMarkdown(skillMarkdown);

  return [
    '## Live PostgreSQL Telemetry Rollup Input',
    '',
    `- **Project:** ${project}`,
    `- **Trend Window:** ${window} (${windowLabel} — ${baselineLabel})`,
    `- **Schedule Slot:** ${slot}`,
    `- **Model:** ${model}`,
    `- **Reasoning Effort:** ${effort}`,
    ...(parsedSections.customSignals.length > 0
      ? [
          '',
          '### Dynamic Additional Skill Sections to Synthesize (`customSections`)',
          ...parsedSections.customSignals.map(
            (sig) =>
              `- **#${sig.number} ${sig.title}** (\`id: "${sig.id}"\`): ${sig.instructions || 'Synthesize from telemetry rollup.'}`,
          ),
        ]
      : []),
    '',
    '### Aggregated Telemetry Signals from PostgreSQL (`trace_events`, `trace_path_rollups`, `app_users`)',
    '```json',
    JSON.stringify(
      {
        kpis: aggregated.kpis,
        topUsers: aggregated.topUsers,
        commonExceptions: aggregated.commonExceptions,
        moduleRetentionDrops: aggregated.moduleRetentionDrops,
        topModules: aggregated.topModules,
      },
      null,
      2,
    ),
    '```',
    ...(previousSuggestions.length > 0
      ? [
          '',
          '### Previously Tracked Suggestions (`suggestionTracker`)',
          'Keep each `id` unchanged. Update `stage` and `progressPct` only when the telemetry above supports it, and say why in `meta`. Add new suggestions with new ids.',
          '```json',
          JSON.stringify(
            previousSuggestions.map((item) => ({
              id: item.id,
              title: item.title,
              module: item.module,
              category: item.category,
              stage: item.stage,
              progressPct: item.progressPct,
              firstSuggestedAt: item.firstSuggestedAt,
              lastUpdatedAt: item.lastUpdatedAt,
            })),
            null,
            2,
          ),
          '```',
        ]
      : []),
    '',
    'Write `.ai-pilot/output/observability-po-digest.json` containing `headline`, `dropReasonsSummary` (`headline`, `narrative`, `findings`), `adoptionRecommendations` (`headline`, `narrative`, `recommendations`), and `customSections` (array of dynamic sections for any sections beyond the 6 core signals).',
  ].join('\n');
}

/**
 * Query PostgreSQL `trace_events`, `trace_path_rollups`, and `app_users` via Drizzle.
 * Never selects raw `trace_events.details` — only `details->>'message'` is projected.
 */
export async function queryDatabaseTelemetryForPoDigest(
  project: string,
  now = new Date(),
): Promise<{
  events: RawDigestTraceEventRow[];
  rollups: RawDigestRollupRow[];
  users: RawDigestUserRow[];
  fromLiveDatabase: boolean;
}> {
  if (telemetrySourceOverride) {
    return telemetrySourceOverride.loadTelemetry(project, now);
  }

  const hasDatabaseUrl = Boolean(
    process.env.DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim(),
  );
  if (!hasDatabaseUrl && process.env.NODE_ENV === 'test') {
    const seed = buildDefaultSeedTelemetryRows(now);
    return {
      ...seed,
      fromLiveDatabase: false,
    };
  }

  const cutoffMs = now.getTime() - OBSERVABILITY_RETENTION_DAYS * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const cutoffDay = cutoffIso.slice(0, 10);

  try {
    const [rawEvents, rawRollups, rawUsers, rawGroupMembers, rawUserRoles] = await Promise.all([
      defaultDb
        .select({
          id: traceEvents.id,
          eventType: traceEvents.eventType,
          occurredAt: traceEvents.occurredAt,
          actorUserId: traceEvents.actorUserId,
          projectId: traceEvents.projectId,
          sessionId: traceEvents.sessionId,
          routeTemplate: traceEvents.routeTemplate,
          httpMethod: traceEvents.httpMethod,
          statusCode: traceEvents.statusCode,
          durationMs: traceEvents.durationMs,
          severity: traceEvents.severity,
          message: sql<string | null>`(${traceEvents.details} ->> 'message')`,
        })
        .from(traceEvents)
        .where(gte(traceEvents.occurredAt, cutoffIso))
        .orderBy(desc(traceEvents.occurredAt))
        .limit(MAX_DIGEST_EVENT_ROWS),
      defaultDb
        .select({
          fromRoute: tracePathRollups.fromRoute,
          toRoute: tracePathRollups.toRoute,
          day: tracePathRollups.day,
          transitionCount: tracePathRollups.transitionCount,
          distinctActorCount: tracePathRollups.distinctActorCount,
        })
        .from(tracePathRollups)
        .where(gte(tracePathRollups.day, cutoffDay)),
      defaultDb
        .select({
          oid: appUsers.oid,
          displayName: appUsers.displayName,
          email: appUsers.email,
        })
        .from(appUsers),
      defaultDb
        .select({
          userId: appGroupMembers.userId,
          groupName: appGroups.name,
        })
        .from(appGroupMembers)
        .innerJoin(appGroups, eq(appGroupMembers.groupId, appGroups.id)),
      defaultDb
        .select({
          userId: appUserRoles.userId,
          roleName: appRoles.name,
        })
        .from(appUserRoles)
        .innerJoin(appRoles, eq(appUserRoles.roleId, appRoles.id)),
    ]);

    const roleByUserId = new Map<string, string>();
    for (const gm of rawGroupMembers) {
      if (gm.userId && gm.groupName && !roleByUserId.has(gm.userId)) {
        roleByUserId.set(gm.userId, gm.groupName.replace(/-/g, ' '));
      }
    }
    for (const ur of rawUserRoles) {
      if (ur.userId && ur.roleName && !roleByUserId.has(ur.userId)) {
        roleByUserId.set(ur.userId, ur.roleName);
      }
    }

    const users: RawDigestUserRow[] = rawUsers.map((u) => ({
      oid: u.oid,
      displayName: u.displayName,
      email: u.email,
      role: roleByUserId.get(u.oid) ?? null,
    }));

    // Filter to matching project or global/null projectId rows when present;
    // if none match the specific project string, use all platform trace_events rows.
    const projectScopedEvents = rawEvents.filter(
      (e) =>
        !e.projectId ||
        e.projectId.toLowerCase() === project.toLowerCase() ||
        project.toLowerCase() === 'apex',
    );
    const selectedEvents =
      projectScopedEvents.length > 0 ? projectScopedEvents : rawEvents;

    if (selectedEvents.length > 0 || rawRollups.length > 0) {
      return {
        events: selectedEvents.map((e) => ({
          id: String(e.id),
          eventType: String(e.eventType),
          occurredAt: String(e.occurredAt),
          actorUserId: e.actorUserId ?? null,
          projectId: e.projectId ?? null,
          sessionId: e.sessionId ?? null,
          routeTemplate: e.routeTemplate ?? null,
          httpMethod: e.httpMethod ?? null,
          statusCode: typeof e.statusCode === 'number' ? e.statusCode : null,
          durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
          severity: e.severity ?? null,
          message: e.message ?? null,
        })),
        rollups: rawRollups.map((r) => ({
          fromRoute: String(r.fromRoute),
          toRoute: String(r.toRoute),
          day: String(r.day),
          transitionCount: Number(r.transitionCount) || 0,
          distinctActorCount: Number(r.distinctActorCount) || 0,
        })),
        users,
        fromLiveDatabase: true,
      };
    }
  } catch {
    // Database connection unavailable in isolated unit tests without Postgres.
  }

  const seed = buildDefaultSeedTelemetryRows(now);
  return {
    ...seed,
    fromLiveDatabase: false,
  };
}

interface StoredProjectDigestState {
  configuredModel: string;
  configuredEffort: EffortLevel;
  morningLastRunAt: string | null;
  eveningLastRunAt: string | null;
  snapshotsByWindow: Map<ObservabilityTrendWindow, ObservabilityPoDigestSnapshot>;
  history: ObservabilityPoDigestSnapshot[];
}

const stateByProject = new Map<string, StoredProjectDigestState>();

function ensureProjectState(project: string, now = new Date()): StoredProjectDigestState {
  const existing = stateByProject.get(project);
  if (existing) return existing;

  const { lastMorningIso, lastEveningIso } = computeSlotTimestamps(now);
  const configuredModel = OBSERVABILITY_PO_DEFAULT_MODEL;
  const configuredEffort = OBSERVABILITY_PO_DEFAULT_EFFORT;

  const created: StoredProjectDigestState = {
    configuredModel,
    configuredEffort,
    morningLastRunAt: lastMorningIso,
    eveningLastRunAt: lastEveningIso,
    snapshotsByWindow: new Map(),
    history: [],
  };
  stateByProject.set(project, created);
  return created;
}

async function loadAggregates(
  project: string,
  window: ObservabilityTrendWindow,
  now: Date,
): Promise<ReturnType<typeof aggregateTelemetryFromDatabaseRows>> {
  const telemetry = await queryDatabaseTelemetryForPoDigest(project, now);
  return aggregateTelemetryFromDatabaseRows({
    events: telemetry.events,
    rollups: telemetry.rollups,
    users: telemetry.users,
    window,
    now,
  });
}

/** Today's telemetry with the latest finished AI synthesis for the window laid over it. */
function buildDigestSnapshot(options: {
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  aggregated: ReturnType<typeof aggregateTelemetryFromDatabaseRows>;
  skillMarkdown: string;
  completed: ObservabilityPoDigestRunRecord | null;
  now: Date;
}): ObservabilityPoDigestSnapshot {
  const { completed } = options;
  return buildDigestSnapshotFromAggregates({
    project: options.project,
    window: options.window,
    model: completed?.model ?? options.model,
    effort: completed?.effort ?? options.effort,
    slot: options.slot,
    aggregated: options.aggregated,
    skillMarkdown: options.skillMarkdown,
    aiSynthesis: completed?.synthesis ?? undefined,
    previousSuggestions: trackedSuggestionsOf(completed),
    now: options.now,
  });
}

function toSynthesisRun(
  run: ObservabilityPoDigestRunRecord | null,
): ObservabilityPoDigestSynthesisRun | null {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    model: run.model,
    effort: run.effort,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    failureDetail: run.failureDetail,
  };
}

function digestResponse(
  state: StoredProjectDigestState,
  digest: ObservabilityPoDigestSnapshot,
  latestRun: ObservabilityPoDigestRunRecord | null,
  now: Date,
): ObservabilityPoDigestResponse {
  return {
    digest,
    schedule: buildDefaultScheduleSummary(
      state.configuredModel,
      state.configuredEffort,
      state.morningLastRunAt,
      state.eveningLastRunAt,
      now,
    ),
    history: state.history.slice(0, 8).map((item) => ({
      id: item.id,
      slot: item.slot,
      window: item.window,
      model: item.model,
      effort: item.effort,
      generatedAt: item.generatedAt,
      headline: item.headline,
    })),
    synthesisRun: toSynthesisRun(latestRun),
  };
}

export async function getObservabilityPoDigest(options: {
  project: string;
  window?: ObservabilityTrendWindow;
  model?: string;
  effort?: EffortLevel;
  now?: Date;
}): Promise<ObservabilityPoDigestResponse> {
  const now = options.now ?? new Date();
  const project = options.project.trim() || 'Apex';
  const window: ObservabilityTrendWindow =
    options.window && isObservabilityTrendWindow(options.window) ? options.window : '7d';
  const state = ensureProjectState(project, now);

  const requestedModel = options.model
    ? normalizeObservabilityModel(options.model)
    : state.configuredModel;
  const requestedEffort = options.effort
    ? normalizeObservabilityEffort(options.effort)
    : state.configuredEffort;

  const lastSlot: ObservabilityDigestSlot =
    state.history[0]?.slot ??
    (new Date(state.eveningLastRunAt ?? 0) >= new Date(state.morningLastRunAt ?? 0)
      ? 'evening_6pm'
      : 'morning_6am');

  const store = runStore();
  const [aggregated, completed, latestRun] = await Promise.all([
    loadAggregates(project, window, now),
    store.latestCompleted(project, window),
    store.latestRun(project, window),
  ]);
  const digest = buildDigestSnapshot({
    project,
    window,
    model: requestedModel,
    effort: requestedEffort,
    slot: lastSlot,
    aggregated,
    skillMarkdown: loadObservabilityPoSkillMarkdown(),
    completed,
    now,
  });

  state.snapshotsByWindow.set(window, digest);
  if (state.history.length === 0) {
    state.history = [digest];
  }

  return digestResponse(state, digest, latestRun, now);
}

export async function generateObservabilityPoDigest(
  request: GenerateObservabilityPoDigestRequest,
  now = new Date(),
): Promise<ObservabilityPoDigestResponse> {
  const project = request.project?.trim() || 'Apex';
  const window: ObservabilityTrendWindow =
    request.window && isObservabilityTrendWindow(request.window) ? request.window : '7d';
  const state = ensureProjectState(project, now);

  const model = normalizeObservabilityModel(request.model ?? state.configuredModel);
  const effort = normalizeObservabilityEffort(request.effort ?? state.configuredEffort);
  const slot: ObservabilityDigestSlot =
    request.slot === 'morning_6am' || request.slot === 'evening_6pm'
      ? request.slot
      : 'on_demand';

  state.configuredModel = model;
  state.configuredEffort = effort;
  if (slot === 'morning_6am') {
    state.morningLastRunAt = now.toISOString();
  } else if (slot === 'evening_6pm') {
    state.eveningLastRunAt = now.toISOString();
  }

  const store = runStore();
  const [aggregated, completed] = await Promise.all([
    loadAggregates(project, window, now),
    store.latestCompleted(project, window),
  ]);
  const skillMarkdown = loadObservabilityPoSkillMarkdown();
  const previousSuggestions = trackedSuggestionsOf(completed);
  let started: ObservabilityPoDigestRunStart;
  try {
    started = await store.start({
      project,
      window,
      slot,
      model,
      effort,
      skillMarkdown,
      telemetryInput: buildObservabilityPoTelemetryInput({
        skillMarkdown,
        project,
        window,
        model,
        effort,
        slot,
        aggregated,
        previousSuggestions,
      }),
      previousSuggestions,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[observabilityPoDigest] could not queue the document run:', detail);
    const missingStorage = detail.includes('AI_PLATFORM_V2_BLOB_ACCOUNT_NAME');
    throw new ObservabilityPoDigestQueueError(
      missingStorage
        ? 'The digest could not be queued. This server has no V2 artifact storage configured, so the document worker never receives the run.'
        : `The digest could not be queued. ${detail}`,
    );
  }
  if (started.status === 'already_running') {
    console.log(
      `[observabilityPoDigest] ${project} ${window} synthesis already running (runId=${started.runId})`,
    );
  }

  const activeDigest = buildDigestSnapshot({
    project,
    window,
    model,
    effort,
    slot,
    aggregated,
    skillMarkdown,
    completed,
    now,
  });

  state.snapshotsByWindow.set(window, activeDigest);
  state.history = [activeDigest, ...state.history].slice(0, 12);

  return digestResponse(state, activeDigest, await store.latestRun(project, window), now);
}

export function resetObservabilityPoDigestForTests(): void {
  stateByProject.clear();
  runStoreOverride = null;
  telemetrySourceOverride = null;
  skillMarkdownOverride = null;
}

/**
 * Twice-Daily Product Owner Observability Digest Scheduler (6:00 AM and 6:00 PM).
 * Mirrors AiCostSchedulerService and StandupSchedulerService patterns.
 */
export class ObservabilityPoDigestSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private lastMorningRunDate: string | null = null;
  private lastEveningRunDate: string | null = null;
  private readonly CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
  private readonly runGuard = createSingleFlight({
    name: 'ObservabilityPoDigestScheduler',
    stuckAfterMs: stuckAfterForInterval(this.CHECK_INTERVAL),
  });

  start(options?: { e2eMode?: boolean }): void {
    const e2eMode = options?.e2eMode ?? process.env.E2E_MODE === 'true';
    if (e2eMode) return;
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.CHECK_INTERVAL);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(now = new Date()): Promise<void> {
    const runToken = this.runGuard.tryEnter();
    if (runToken === null) return;

    try {
      const hour = now.getUTCHours();
      const dateKey = now.toISOString().slice(0, 10);
      const projects = stateByProject.size > 0 ? [...stateByProject.keys()] : ['Apex'];

      if (hour === OBSERVABILITY_PO_SCHEDULE_HOURS[0] && this.lastMorningRunDate !== dateKey) {
        for (const project of projects) {
          await generateObservabilityPoDigest(
            { project, slot: 'morning_6am', window: '7d' },
            now,
          );
        }
        this.lastMorningRunDate = dateKey;
      }

      if (hour === OBSERVABILITY_PO_SCHEDULE_HOURS[1] && this.lastEveningRunDate !== dateKey) {
        for (const project of projects) {
          await generateObservabilityPoDigest(
            { project, slot: 'evening_6pm', window: '7d' },
            now,
          );
        }
        this.lastEveningRunDate = dateKey;
      }
    } catch (err) {
      console.error(
        '[ObservabilityPoDigestScheduler] cycle failed:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.runGuard.exit(runToken);
    }
  }
}

export const observabilityPoDigestScheduler = new ObservabilityPoDigestSchedulerService();
