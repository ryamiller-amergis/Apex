/**
 * Product Owner Observability Digest Service & Twice-Daily Scheduler (06:00 AM & 06:00 PM).
 *
 * Queries PostgreSQL (`trace_events`, `trace_path_rollups`, `app_users`) via Drizzle
 * across Today, 1d, 7d, 14d, 30d, and 60d trend windows, and executes the
 * `.cursor/skills/observability-po-digest/SKILL.md` skill with the selected model
 * (e.g. `composer-2.5`) and reasoning effort (`low`, `medium`, `high`).
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
  type ObservabilityAdoptionSummary,
  type ObservabilityDigestSlot,
  type ObservabilityDropReasonsSummary,
  type ObservabilityDynamicSkillSection,
  type ObservabilityPoDigestResponse,
  type ObservabilityPoDigestSnapshot,
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
import { buildCursorModelSelection } from './agentEffortResolver';
import { OBSERVABILITY_RETENTION_DAYS } from './observabilityOperationsService';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

export { isObservabilityTrendWindow, synthesizePoDigestSnapshot };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DIGEST_EVENT_ROWS = 10_000;

export interface ObservabilityPoSkillAiSynthesisResult {
  headline?: string;
  dropReasonsSummary?: ObservabilityDropReasonsSummary;
  adoptionRecommendations?: ObservabilityAdoptionSummary;
  customSections?: ObservabilityDynamicSkillSection[];
  sections?: ObservabilityDynamicSkillSection[];
}

export interface ObservabilityPoAiProvider {
  synthesizeDigest(input: {
    skillMarkdown: string;
    prompt: string;
    model: string;
    effort: EffortLevel;
    project: string;
    window: ObservabilityTrendWindow;
  }): Promise<ObservabilityPoSkillAiSynthesisResult | null>;
}

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

let aiProviderOverride: ObservabilityPoAiProvider | null = null;
let telemetrySourceOverride: ObservabilityPoTelemetrySource | null = null;
let skillMarkdownOverride: string | null = null;

export function setObservabilityPoAiProviderForTests(
  provider: ObservabilityPoAiProvider | null,
): void {
  aiProviderOverride = provider;
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

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]!.trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function buildObservabilityPoSkillPrompt(input: {
  skillMarkdown: string;
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  aggregated: ReturnType<typeof aggregateTelemetryFromDatabaseRows>;
}): string {
  const { skillMarkdown, project, window, model, effort, slot, aggregated } = input;
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const baselineLabel = WINDOW_BASELINE_LABELS[window];
  const parsedSections = parseSkillSectionsFromMarkdown(skillMarkdown);

  return [
    skillMarkdown,
    '',
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
    '',
    'Return ONLY a valid JSON object containing `headline`, `dropReasonsSummary` (`headline`, `narrative`, `findings`), `adoptionRecommendations` (`headline`, `narrative`, `recommendations`), and `customSections` (array of dynamic sections for any sections beyond the 6 core signals).',
  ].join('\n');
}

function defaultCursorSkillAiProvider(): ObservabilityPoAiProvider {
  return {
    async synthesizeDigest({ prompt, model, effort }) {
      const apiKey = process.env.CURSOR_API_KEY?.trim();
      if (
        !apiKey ||
        process.env.NODE_ENV === 'test' ||
        process.env.E2E_MODE === 'true'
      ) {
        return null;
      }

      let agent: { [Symbol.asyncDispose]?: () => Promise<void> } | null = null;
      try {
        const { Agent } = await import('@cursor/sdk');
        const created = await Agent.create({
          apiKey,
          model: buildCursorModelSelection(model, effort),
        });
        agent = created;
        const run = await created.send(prompt);
        let text = '';
        if (run.supports('stream')) {
          for await (const event of run.stream()) {
            if (event.type === 'assistant') {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  text += block.text;
                }
              }
            }
          }
        } else {
          const finished = await run.wait();
          text = typeof finished === 'object' && finished ? JSON.stringify(finished) : '';
        }

        const parsed = extractJsonObject(text);
        if (!parsed) return null;

        const dropReasons = parsed.dropReasonsSummary as
          | ObservabilityDropReasonsSummary
          | undefined;
        const adoption = parsed.adoptionRecommendations as
          | ObservabilityAdoptionSummary
          | undefined;
        const rawCustomSections = Array.isArray(parsed.customSections)
          ? (parsed.customSections as ObservabilityDynamicSkillSection[])
          : Array.isArray(parsed.sections)
            ? (parsed.sections as ObservabilityDynamicSkillSection[])
            : undefined;

        return {
          headline: typeof parsed.headline === 'string' ? parsed.headline : undefined,
          dropReasonsSummary:
            dropReasons &&
            typeof dropReasons.headline === 'string' &&
            Array.isArray(dropReasons.findings)
              ? dropReasons
              : undefined,
          adoptionRecommendations:
            adoption &&
            typeof adoption.headline === 'string' &&
            Array.isArray(adoption.recommendations)
              ? adoption
              : undefined,
          customSections: rawCustomSections,
          sections: rawCustomSections,
        };
      } catch (err) {
        console.warn(
          '[observabilityPoDigest] live Cursor SDK skill synthesis fell back to deterministic telemetry synthesis:',
          err instanceof Error ? err.message : String(err),
        );
        return null;
      } finally {
        await agent?.[Symbol.asyncDispose]?.().catch(() => {});
      }
    },
  };
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

async function computeDigestSnapshotFromDatabaseAndSkill(options: {
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  now?: Date;
}): Promise<ObservabilityPoDigestSnapshot> {
  const now = options.now ?? new Date();
  const telemetry = await queryDatabaseTelemetryForPoDigest(options.project, now);

  const aggregated = aggregateTelemetryFromDatabaseRows({
    events: telemetry.events,
    rollups: telemetry.rollups,
    users: telemetry.users,
    window: options.window,
    now,
  });

  const skillMarkdown = loadObservabilityPoSkillMarkdown();
  const prompt = buildObservabilityPoSkillPrompt({
    skillMarkdown,
    project: options.project,
    window: options.window,
    model: options.model,
    effort: options.effort,
    slot: options.slot,
    aggregated,
  });

  const provider = aiProviderOverride ?? defaultCursorSkillAiProvider();
  const aiSynthesis = await provider.synthesizeDigest({
    skillMarkdown,
    prompt,
    model: options.model,
    effort: options.effort,
    project: options.project,
    window: options.window,
  });

  return buildDigestSnapshotFromAggregates({
    project: options.project,
    window: options.window,
    model: options.model,
    effort: options.effort,
    slot: options.slot,
    aggregated,
    skillMarkdown,
    aiSynthesis: aiSynthesis ?? undefined,
    now,
  });
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

  const digest = await computeDigestSnapshotFromDatabaseAndSkill({
    project,
    window,
    model: requestedModel,
    effort: requestedEffort,
    slot: lastSlot,
    now,
  });

  state.snapshotsByWindow.set(window, digest);
  if (state.history.length === 0) {
    state.history = [digest];
  }

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
  };
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

  const activeDigest = await computeDigestSnapshotFromDatabaseAndSkill({
    project,
    window,
    model,
    effort,
    slot,
    now,
  });

  state.snapshotsByWindow.set(window, activeDigest);
  state.history = [activeDigest, ...state.history].slice(0, 12);

  return {
    digest: activeDigest,
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
  };
}

export function resetObservabilityPoDigestForTests(): void {
  stateByProject.clear();
  aiProviderOverride = null;
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
