/**
 * Incident triage sweep. Every App Service instance runs the scheduler; a Postgres lease lets one
 * instance poll ServiceNow per interval. `collectIncidents` pulls changed incidents, stores them
 * redacted, and queues one pending analysis per content hash. `sweepProject` (the on-demand route)
 * then admits that project's queued analyses and retries its failed Teams posts. The scheduler does
 * both once per tick, for the projects that are enabled and have the flag on, after it fails stale
 * running analyses.
 */
import { createHash } from 'crypto';
import { INCIDENT_TRIAGE_FLAG } from '../../shared/types/featureFlags';
import { isFeatureOperational, isFlagEnabledForWholeProject } from './featureFlagService';
import { describeErrorForLog, redactIncidentText } from './incidentRedaction';
import {
  failStaleRunningAnalyses,
  getSettings,
  insertPendingAnalysis,
  listEnabledSettings,
  recordSweepResult,
  upsertIncident,
  type IncidentRowInput,
} from './incidentTriageStore';
import { retryFailedIncidentTriagePosts } from './incidentTriageTeams';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  withRepoCacheLease,
} from './repoCacheLeaseService';
import {
  isServiceNowConfigured,
  listAllIncidentsUpdatedSince,
  ServiceNowRequestError,
  type ServiceNowIncidentRow,
} from './serviceNowClient';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

const LEASE_KEY = 'incident-triage:sweep';
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;
/** A run's deadline plus its queue allowance; a running row older than this with no active agent run is stuck. */
const STALE_RUNNING_AFTER_MS = 45 * 60 * 1000;
const STALE_RUNNING_REASON = 'Analysis did not finish';

/** Upper bound of pending analyses a sweep asks the AI admission to start. */
export const MAX_ANALYSES_PER_SWEEP = 5;
const MAX_TEAMS_RETRIES_PER_SWEEP = 5;

export interface SweepCounts {
  fetched: number;
  upserted: number;
  newAnalyses: number;
}

export interface SweepOptions {
  requestedBy: string | null;
}

export type AdmitPending = (limit: number, projects: readonly string[]) => Promise<void>;

let admitPending: AdmitPending | null = null;

/** The AI admission calls this to start queued analyses after a sweep. */
export function setIncidentTriageAdmission(admit: AdmitPending | null): void {
  admitPending = admit;
}

export class IncidentTriageSweepUnavailableError extends Error {
  readonly reason: 'not_enabled' | 'not_configured';

  constructor(reason: 'not_enabled' | 'not_configured') {
    super(
      reason === 'not_enabled'
        ? 'Incident triage is not enabled for this project'
        : 'ServiceNow is not configured',
    );
    this.name = 'IncidentTriageSweepUnavailableError';
    this.reason = reason;
  }
}

function blankToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/** ServiceNow returns UTC as `YYYY-MM-DD HH:MM:SS`. */
function parseServiceNowUtc(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Hashes the raw signal fields. The raw text is never stored. */
export function computeContentHash(row: ServiceNowIncidentRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.shortDescription,
        row.description,
        row.state,
        row.priority,
        row.category,
        row.subcategory,
        row.closeCode,
        row.closeNotes,
      ]),
    )
    .digest('hex');
}

function toStoredRow(row: ServiceNowIncidentRow): IncidentRowInput {
  return {
    sysId: row.sysId,
    number: row.number,
    shortDescription: blankToNull(redactIncidentText(row.shortDescription)),
    description: blankToNull(redactIncidentText(row.description)),
    closeNotes: blankToNull(redactIncidentText(row.closeNotes)),
    state: blankToNull(row.state),
    priority: blankToNull(row.priority),
    impact: blankToNull(row.impact),
    urgency: blankToNull(row.urgency),
    category: blankToNull(row.category),
    subcategory: blankToNull(row.subcategory),
    assignmentGroupName: blankToNull(row.assignmentGroupName),
    closeCode: blankToNull(row.closeCode),
    openedAt: toIsoOrNull(parseServiceNowUtc(row.openedAt)),
    resolvedAt: toIsoOrNull(parseServiceNowUtc(row.resolvedAt)),
    sysUpdatedOn: toIsoOrNull(parseServiceNowUtc(row.sysUpdatedOn)),
  };
}

/** ServiceNow client messages are already free of secrets; any other error gets a fixed message. */
function safeErrorMessage(error: unknown): string {
  if (error instanceof ServiceNowRequestError) return error.message.slice(0, MAX_ERROR_LENGTH);
  return 'Incident sweep failed';
}

function logFailure(project: string, error: unknown): void {
  const message = error instanceof ServiceNowRequestError ? error.message : describeErrorForLog(error);
  console.error(`[IncidentTriageSweep] Sweep failed for ${project}: ${message.slice(0, MAX_ERROR_LENGTH)}`);
}

async function recordFailure(project: string, error: unknown): Promise<void> {
  try {
    await recordSweepResult(project, {
      lastSweepAt: new Date(Date.now()).toISOString(),
      lastSweepError: safeErrorMessage(error),
    });
  } catch (recordError) {
    logFailure(project, recordError);
  }
}

async function admitQueuedAnalyses(projects: readonly string[]): Promise<void> {
  if (!admitPending || projects.length === 0) return;
  try {
    await admitPending(MAX_ANALYSES_PER_SWEEP, projects);
  } catch (error) {
    console.error(
      `[IncidentTriageSweep] Analysis admission failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function retryTeamsPosts(projects: readonly string[]): Promise<void> {
  if (projects.length === 0) return;
  try {
    await retryFailedIncidentTriagePosts(MAX_TEAMS_RETRIES_PER_SWEEP, projects);
  } catch (error) {
    console.error(
      `[IncidentTriageSweep] Teams retry failed: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
}

async function failStaleRunningRows(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
    const failed = await failStaleRunningAnalyses(cutoff, STALE_RUNNING_REASON);
    if (failed > 0) console.warn(`[IncidentTriageSweep] Failed ${failed} stale running ${failed === 1 ? 'analysis' : 'analyses'}`);
  } catch (error) {
    console.error(`[IncidentTriageSweep] Could not fail stale running analyses: ${describeErrorForLog(error)}`);
  }
}

/** Pulls the project's changed incidents and queues their analyses. Admission and retries are the caller's. */
async function collectIncidents(project: string, options: SweepOptions): Promise<SweepCounts> {
  const settings = await getSettings(project);
  if (!settings || !settings.enabled) throw new IncidentTriageSweepUnavailableError('not_enabled');
  if (!isServiceNowConfigured()) throw new IncidentTriageSweepUnavailableError('not_configured');

  const startedAtMs = Date.now();
  const storedWatermarkMs = settings.watermark ? Date.parse(settings.watermark) : null;
  const since = new Date(
    storedWatermarkMs !== null
      ? storedWatermarkMs - WATERMARK_OVERLAP_MS
      : startedAtMs - settings.backfillDays * DAY_MS,
  );
  const counts: SweepCounts = { fetched: 0, upserted: 0, newAnalyses: 0 };
  let watermarkMs = storedWatermarkMs;

  console.log(
    `[IncidentTriageSweep] Sweeping ${project} (${options.requestedBy ? 'on demand' : 'scheduled'}) since ${since.toISOString()}`,
  );

  try {
    for await (const page of listAllIncidentsUpdatedSince({ groupIds: settings.assignmentGroupIds, since })) {
      let pageMaxMs: number | null = null;
      for (const row of page) {
        const stored = toStoredRow(row);
        const { id, contentHash, changed } = await upsertIncident(project, stored, computeContentHash(row));
        if (await insertPendingAnalysis(id, contentHash, stored.sysUpdatedOn, null)) counts.newAnalyses += 1;
        if (changed) counts.upserted += 1;
        const updatedMs = stored.sysUpdatedOn ? Date.parse(stored.sysUpdatedOn) : null;
        if (updatedMs !== null && (pageMaxMs === null || updatedMs > pageMaxMs)) pageMaxMs = updatedMs;
      }
      counts.fetched += page.length;

      const advances = pageMaxMs !== null && (watermarkMs === null || pageMaxMs > watermarkMs);
      if (advances) watermarkMs = pageMaxMs;
      await recordSweepResult(project, {
        ...(advances && { watermark: new Date(pageMaxMs as number).toISOString() }),
        lastSweepAt: new Date(Date.now()).toISOString(),
        lastSweepError: null,
      });
    }
    await recordSweepResult(project, {
      lastSweepAt: new Date(Date.now()).toISOString(),
      lastSweepError: null,
    });
  } catch (error) {
    await recordFailure(project, error);
    logFailure(project, error);
    throw error;
  }

  console.log(
    `[IncidentTriageSweep] ${project}: fetched ${counts.fetched}, changed ${counts.upserted}, queued ${counts.newAnalyses}`,
  );
  return counts;
}

/** The on-demand sweep: collects the project's incidents, then admits and retries only its own rows. */
export async function sweepProject(project: string, options: SweepOptions): Promise<SweepCounts> {
  const counts = await collectIncidents(project, options);
  await admitQueuedAnalyses([project]);
  await retryTeamsPosts([project]);
  return counts;
}

export class IncidentTriageSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimeoutId: NodeJS.Timeout | null = null;
  private readonly runGuard = createSingleFlight({
    name: 'IncidentTriageScheduler',
    stuckAfterMs: stuckAfterForInterval(SWEEP_INTERVAL_MS),
  });

  start(): void {
    if (this.intervalId) {
      console.log('[IncidentTriageScheduler] Service already running');
      return;
    }

    console.log('[IncidentTriageScheduler] Starting service - checking every 15 minutes');
    this.initialTimeoutId = setTimeout(() => {
      this.initialTimeoutId = null;
      void this.tick();
    }, INITIAL_DELAY_MS);
    this.intervalId = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[IncidentTriageScheduler] Service stopped');
    }
  }

  /**
   * One scheduled pass. The lease is not released on completion; it expires just before the next
   * interval. Failures are logged, never thrown.
   */
  async tick(): Promise<void> {
    try {
      await this.runIfOperational();
    } catch (error) {
      if (error instanceof NonblockingRepoCacheLeaseUnavailableError) {
        console.log('[IncidentTriageScheduler] Another instance holds the sweep lease, skipping...');
        return;
      }
      console.error(
        `[IncidentTriageScheduler] Could not run the sweep: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async runIfOperational(): Promise<void> {
    // @feature-flag:servicenow-incident-triage start winner=enabled
    if (!(await isFeatureOperational(INCIDENT_TRIAGE_FLAG))) {
      // @feature-flag:servicenow-incident-triage disabled-start
      return;
      // @feature-flag:servicenow-incident-triage disabled-end
    }
    // @feature-flag:servicenow-incident-triage enabled-start
    if (!isServiceNowConfigured()) return;
    const runToken = this.runGuard.tryEnter();
    if (runToken === null) return;
    try {
      await withRepoCacheLease(LEASE_KEY, () => this.sweepEnabledProjects(), {
        leaseMs: SWEEP_INTERVAL_MS - 5000,
        waitMs: 0,
        releaseOnComplete: false,
      });
    } finally {
      this.runGuard.exit(runToken);
    }
    // @feature-flag:servicenow-incident-triage enabled-end
    // @feature-flag:servicenow-incident-triage end
  }

  private async sweepEnabledProjects(): Promise<void> {
    const projects: string[] = [];
    for (const settings of await listEnabledSettings()) {
      if (!(await isFlagEnabledForWholeProject(INCIDENT_TRIAGE_FLAG, settings.project))) continue;
      projects.push(settings.project);
      try {
        await collectIncidents(settings.project, { requestedBy: null });
      } catch {
        // collectIncidents already recorded and logged the failure; the next project still runs.
      }
    }
    await failStaleRunningRows();
    await admitQueuedAnalyses(projects);
    await retryTeamsPosts(projects);
  }
}

export const incidentTriageScheduler = new IncidentTriageSchedulerService();
