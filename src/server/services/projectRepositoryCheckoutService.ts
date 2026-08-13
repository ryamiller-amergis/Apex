/**
 * Admin-managed cold clone / refresh for a Project Skill Settings repository
 * configuration. HTTP only enqueues; the Container Apps Job (or in-process
 * poller) executes git + materialize. User chat/generation paths must never
 * call executeRepositoryCheckout.
 */
import type {
  ProjectRepositoryReadiness,
  RepositoryCheckoutStatus,
  SkillProvider,
} from '../../shared/types/projectSettings';
import {
  cloneRepositoryForAdmin,
  type RepoCacheOptions,
} from './repoCacheService';
import {
  getSkillConfigById,
  updateRepositoryCheckoutState,
} from './projectSettingsService';
import { sharedReadCheckoutService } from './grounding/sharedReadCheckoutService';
import { trackEvent } from './telemetry';
import { runWithGitStderrSink } from '../utils/asyncGit';
import {
  formatGitProgressLabel,
  mapGitProgressToOverall,
  parseGitProgressChunk,
} from '../utils/gitCheckoutProgress';
import {
  claimNextCheckoutJob,
  completeCheckoutJob,
  insertCheckoutJob,
  isRepoCheckoutWorkerInProcess,
  recoverExpiredCheckoutJobs,
  startCheckoutJobHeartbeat,
  type RepositoryCheckoutJobRow,
} from './repositoryCheckoutJobService';
import { getRepoCheckoutWakeupPublisher } from './repoCheckoutWakeupPublisher';
import { getProjectRepositoryReadiness } from './projectRepositoryReadinessService';

const ADMIN_MESSAGE =
  'A project administrator must clone this repository before repository-dependent AI work can run.';

const PROGRESS_WRITE_INTERVAL_MS = 2_000;

function sanitizeCloneError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Authorization:\s*Basic\s+\S+/gi, 'Authorization: Basic [redacted]')
    .replace(/:[^/@\s]+@/g, ':[redacted]@')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+\b/g, '[redacted]')
    .slice(0, 500);
}

function toRepoCacheOptions(config: {
  skillProvider?: SkillProvider | string | null;
  project: string;
  skillRepo: string;
  skillBranch: string;
}): RepoCacheOptions {
  return {
    provider: (config.skillProvider ?? 'ado') === 'github' ? 'github' : 'ado',
    project: config.project,
    repo: config.skillRepo.trim(),
    branch: config.skillBranch.trim(),
  };
}

export function toReadinessDto(
  skillSettingsId: string,
  status: RepositoryCheckoutStatus,
  fields: {
    sha?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    filesystemReady?: boolean;
    progressPercent?: number | null;
    progressLabel?: string | null;
  },
): ProjectRepositoryReadiness {
  const cloning = status === 'cloning';
  return {
    skillSettingsId,
    status,
    sha: fields.sha ?? null,
    error: fields.error ?? null,
    startedAt: fields.startedAt ?? null,
    completedAt: fields.completedAt ?? null,
    filesystemReady: fields.filesystemReady ?? false,
    progressPercent: cloning ? (fields.progressPercent ?? 0) : null,
    progressLabel: cloning ? (fields.progressLabel ?? null) : null,
  };
}

async function publishWakeup(jobId: string): Promise<void> {
  if (isRepoCheckoutWorkerInProcess()) return;
  try {
    await getRepoCheckoutWakeupPublisher().publish(jobId);
  } catch (error) {
    console.error(
      '[repo-checkout] wakeup publish failed; job remains queued:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Enqueue a clone/refresh. Sets DB status to cloning and returns immediately.
 * Duplicate POSTs while cloning are idempotent (no second job).
 */
export async function enqueueRepositoryCheckout(
  skillSettingsId: string,
  options?: { refresh?: boolean },
): Promise<ProjectRepositoryReadiness> {
  const config = await getSkillConfigById(skillSettingsId);
  if (!config) {
    throw Object.assign(new Error('Skill settings not found'), { statusCode: 404 });
  }

  if (config.repositoryCheckoutStatus === 'cloning') {
    const current = await getProjectRepositoryReadiness(skillSettingsId);
    if (current) return current;
    return toReadinessDto(skillSettingsId, 'cloning', {
      startedAt: config.repositoryCheckoutStartedAt ?? new Date().toISOString(),
      progressPercent: config.repositoryCheckoutProgressPercent ?? 0,
      progressLabel: config.repositoryCheckoutProgressLabel ?? 'Queued',
    });
  }

  const startedAt = new Date().toISOString();
  await updateRepositoryCheckoutState(skillSettingsId, {
    status: 'cloning',
    error: null,
    startedAt,
    completedAt: null,
    progressPercent: 0,
    progressLabel: formatGitProgressLabel('queued'),
  });

  let job: RepositoryCheckoutJobRow;
  try {
    job = await insertCheckoutJob({
      skillSettingsId,
      refresh: Boolean(options?.refresh),
    });
  } catch (error) {
    const current = await getProjectRepositoryReadiness(skillSettingsId);
    if (current?.status === 'cloning') return current;
    throw error;
  }

  await publishWakeup(job.id);

  return toReadinessDto(skillSettingsId, 'cloning', {
    sha: config.repositoryCheckoutSha ?? null,
    startedAt,
    progressPercent: 0,
    progressLabel: formatGitProgressLabel('queued'),
  });
}

function createProgressReporter(skillSettingsId: string): {
  reportChunk: (chunk: string) => void;
  setPhase: (
    phase: 'starting' | 'checking-out' | 'ready',
    gitPercent?: number,
  ) => Promise<void>;
  flush: () => Promise<void>;
} {
  let lastWriteAt = 0;
  let lastPercent: number | null = null;
  let lastLabel: string | null = null;
  let pending: Promise<void> = Promise.resolve();

  const write = (percent: number, label: string, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) {
      lastPercent = percent;
      lastLabel = label;
      return;
    }
    lastWriteAt = now;
    lastPercent = percent;
    lastLabel = label;
    pending = pending.then(() =>
      updateRepositoryCheckoutState(skillSettingsId, {
        status: 'cloning',
        progressPercent: percent,
        progressLabel: label,
      }).then(() => undefined),
    );
  };

  return {
    reportChunk(chunk: string) {
      const parsed = parseGitProgressChunk(chunk, lastPercent);
      if (!parsed) return;
      write(parsed.percent, parsed.label, false);
    },
    async setPhase(phase, gitPercent = 100) {
      const percent = mapGitProgressToOverall(phase, gitPercent, lastPercent);
      const label = formatGitProgressLabel(phase, gitPercent);
      write(percent, label, true);
      await pending;
    },
    async flush() {
      if (lastPercent != null && lastLabel) {
        write(lastPercent, lastLabel, true);
      }
      await pending;
    },
  };
}

/**
 * Worker-only: clone/fetch the mirror, materialize the shared tree, persist
 * ready/failed. Must never be called from App Service HTTP handlers.
 */
export async function executeRepositoryCheckout(
  skillSettingsId: string,
  options?: { refresh?: boolean },
): Promise<ProjectRepositoryReadiness> {
  const config = await getSkillConfigById(skillSettingsId);
  if (!config) {
    throw Object.assign(new Error('Skill settings not found'), { statusCode: 404 });
  }

  const cacheOptions = toRepoCacheOptions(config);
  const startedAt = config.repositoryCheckoutStartedAt ?? new Date().toISOString();
  const t0 = Date.now();
  const progress = createProgressReporter(skillSettingsId);

  await updateRepositoryCheckoutState(skillSettingsId, {
    status: 'cloning',
    error: null,
    startedAt,
    completedAt: null,
  });
  await progress.setPhase('starting');

  try {
    const cache = await runWithGitStderrSink(progress.reportChunk, () =>
      cloneRepositoryForAdmin(cacheOptions),
    );
    const tipSha = cache.baseSha;

    await progress.setPhase('checking-out', 0);
    const materializeResult = await runWithGitStderrSink(progress.reportChunk, () =>
      sharedReadCheckoutService.materialize({
        provider: cacheOptions.provider,
        project: cacheOptions.project,
        repo: cacheOptions.repo,
        branch: cacheOptions.branch,
        sha: tipSha,
      }),
    );

    const readyProbe = sharedReadCheckoutService.getReady({
      provider: cacheOptions.provider,
      project: cacheOptions.project,
      repo: cacheOptions.repo,
      branch: cacheOptions.branch,
      sha: tipSha,
    });
    if (!readyProbe) {
      throw new Error(
        `Shared snapshot missing .apex-shared-ready after materialize (${materializeResult.outcome})`,
      );
    }

    const completedAt = new Date().toISOString();
    await progress.setPhase('ready');
    await progress.flush();
    await updateRepositoryCheckoutState(skillSettingsId, {
      status: 'ready',
      sha: tipSha,
      error: null,
      startedAt,
      completedAt,
      progressPercent: null,
      progressLabel: null,
    });

    trackEvent(
      'grounding.admin_clone',
      {
        outcome: 'success',
        skillSettingsId,
        project: config.project,
        refresh: String(Boolean(options?.refresh)),
      },
      { durationMs: Date.now() - t0 },
    );

    return toReadinessDto(skillSettingsId, 'ready', {
      sha: tipSha,
      error: null,
      startedAt,
      completedAt,
      filesystemReady: true,
    });
  } catch (error) {
    const sanitized = sanitizeCloneError(error);
    const completedAt = new Date().toISOString();
    await updateRepositoryCheckoutState(skillSettingsId, {
      status: 'failed',
      error: sanitized,
      startedAt,
      completedAt,
      progressPercent: null,
      progressLabel: null,
    });

    trackEvent(
      'grounding.admin_clone',
      {
        outcome: 'failed',
        skillSettingsId,
        project: config.project,
        refresh: String(Boolean(options?.refresh)),
      },
      { durationMs: Date.now() - t0 },
    );

    return toReadinessDto(skillSettingsId, 'failed', {
      sha: null,
      error: sanitized || ADMIN_MESSAGE,
      startedAt,
      completedAt,
      filesystemReady: false,
    });
  }
}

export async function executeClaimedCheckoutJob(
  job: RepositoryCheckoutJobRow,
): Promise<ProjectRepositoryReadiness> {
  const stopHeartbeat = startCheckoutJobHeartbeat(job.id);
  try {
    const result = await executeRepositoryCheckout(job.skillSettingsId, {
      refresh: job.refresh,
    });
    await completeCheckoutJob(
      job.id,
      result.status === 'ready' ? 'succeeded' : 'failed',
      result.status === 'failed' ? result.error : null,
    );
    return result;
  } catch (error) {
    await completeCheckoutJob(job.id, 'failed', sanitizeCloneError(error));
    throw error;
  } finally {
    stopHeartbeat();
  }
}

export async function processNextCheckoutJob(): Promise<ProjectRepositoryReadiness | null> {
  await recoverExpiredCheckoutJobs();
  const job = await claimNextCheckoutJob();
  if (!job) return null;
  return executeClaimedCheckoutJob(job);
}
