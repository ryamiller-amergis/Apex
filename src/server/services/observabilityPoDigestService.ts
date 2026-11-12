/**
 * Product Owner Observability Digest Service & Twice-Daily Scheduler (06:00 AM & 06:00 PM).
 *
 * Synthesizes platform telemetry across Today, 1d, 7d, 14d, 30d, and 60d windows
 * into the six Product Owner core signals defined in `.cursor/skills/observability-po-digest/SKILL.md`:
 *  1. Top users
 *  2. Most common exceptions
 *  3. Retention dropped per module
 *  4. AI summary of why there could be drops
 *  5. Top modules
 *  6. AI summary of how we can drive adoption
 */
import type { EffortLevel } from '../../shared/types/effort';
import {
  OBSERVABILITY_PO_DEFAULT_EFFORT,
  OBSERVABILITY_PO_DEFAULT_MODEL,
  OBSERVABILITY_PO_SCHEDULE_HOURS,
  OBSERVABILITY_TREND_WINDOWS,
  type GenerateObservabilityPoDigestRequest,
  type ObservabilityDigestSlot,
  type ObservabilityPoDigestResponse,
  type ObservabilityPoDigestSnapshot,
  type ObservabilityTrendWindow,
} from '../../shared/types/observability';
import {
  buildDefaultScheduleSummary,
  computeSlotTimestamps,
  isObservabilityTrendWindow,
  normalizeObservabilityEffort,
  normalizeObservabilityModel,
  synthesizePoDigestSnapshot,
} from '../../shared/utils/observabilityPoDigest';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

export { isObservabilityTrendWindow, synthesizePoDigestSnapshot };

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
  const snapshotsByWindow = new Map<ObservabilityTrendWindow, ObservabilityPoDigestSnapshot>();

  const morningSnap = synthesizePoDigestSnapshot({
    project,
    window: '7d',
    model: configuredModel,
    effort: configuredEffort,
    slot: 'morning_6am',
    now: new Date(lastMorningIso),
  });

  const eveningSnap = synthesizePoDigestSnapshot({
    project,
    window: '7d',
    model: configuredModel,
    effort: configuredEffort,
    slot: 'evening_6pm',
    now: new Date(lastEveningIso),
  });

  const latestSlot: ObservabilityDigestSlot =
    new Date(lastEveningIso) >= new Date(lastMorningIso) ? 'evening_6pm' : 'morning_6am';
  const latestNow =
    new Date(lastEveningIso) >= new Date(lastMorningIso)
      ? new Date(lastEveningIso)
      : new Date(lastMorningIso);

  for (const w of OBSERVABILITY_TREND_WINDOWS) {
    snapshotsByWindow.set(
      w,
      synthesizePoDigestSnapshot({
        project,
        window: w,
        model: configuredModel,
        effort: configuredEffort,
        slot: latestSlot,
        now: latestNow,
      }),
    );
  }

  const history = [eveningSnap, morningSnap].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
  );

  const created: StoredProjectDigestState = {
    configuredModel,
    configuredEffort,
    morningLastRunAt: lastMorningIso,
    eveningLastRunAt: lastEveningIso,
    snapshotsByWindow,
    history,
  };
  stateByProject.set(project, created);
  return created;
}

export async function getObservabilityPoDigest(options: {
  project: string;
  window?: ObservabilityTrendWindow;
  model?: string;
  effort?: EffortLevel;
}): Promise<ObservabilityPoDigestResponse> {
  const project = options.project.trim() || 'Apex';
  const window: ObservabilityTrendWindow =
    options.window && isObservabilityTrendWindow(options.window) ? options.window : '7d';
  const state = ensureProjectState(project);

  const requestedModel = options.model
    ? normalizeObservabilityModel(options.model)
    : state.configuredModel;
  const requestedEffort = options.effort
    ? normalizeObservabilityEffort(options.effort)
    : state.configuredEffort;

  let digest = state.snapshotsByWindow.get(window);
  if (
    !digest ||
    digest.model !== requestedModel ||
    digest.effort !== requestedEffort
  ) {
    digest = synthesizePoDigestSnapshot({
      project,
      window,
      model: requestedModel,
      effort: requestedEffort,
      slot: digest?.slot ?? 'morning_6am',
    });
    state.snapshotsByWindow.set(window, digest);
  }

  return {
    digest,
    schedule: buildDefaultScheduleSummary(
      state.configuredModel,
      state.configuredEffort,
      state.morningLastRunAt,
      state.eveningLastRunAt,
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

  for (const w of OBSERVABILITY_TREND_WINDOWS) {
    state.snapshotsByWindow.set(
      w,
      synthesizePoDigestSnapshot({
        project,
        window: w,
        model,
        effort,
        slot,
        now,
      }),
    );
  }

  const activeDigest = state.snapshotsByWindow.get(window)!;
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
