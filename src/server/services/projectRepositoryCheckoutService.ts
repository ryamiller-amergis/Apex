/**
 * Admin-managed cold clone / refresh for a Project Skill Settings repository
 * configuration. User chat/generation paths must never call this — only the
 * Project Admin Clone/Refresh route.
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

const ADMIN_MESSAGE =
  'A project administrator must clone this repository before repository-dependent AI work can run.';

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

function toReadinessDto(
  skillSettingsId: string,
  status: RepositoryCheckoutStatus,
  fields: {
    sha?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    filesystemReady?: boolean;
  },
): ProjectRepositoryReadiness {
  return {
    skillSettingsId,
    status,
    sha: fields.sha ?? null,
    error: fields.error ?? null,
    startedAt: fields.startedAt ?? null,
    completedAt: fields.completedAt ?? null,
    filesystemReady: fields.filesystemReady ?? false,
  };
}

/**
 * Cold-clone (or refresh) the configured repository for `skillSettingsId`.
 * Duplicate Clone/Refresh coalesce via repoCacheService in-flight map + lease.
 * Never publishes a Blob grounding bundle.
 */
export async function cloneOrRefreshRepository(
  skillSettingsId: string,
  options?: { refresh?: boolean },
): Promise<ProjectRepositoryReadiness> {
  const config = await getSkillConfigById(skillSettingsId);
  if (!config) {
    throw Object.assign(new Error('Skill settings not found'), { statusCode: 404 });
  }

  const cacheOptions = toRepoCacheOptions(config);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  await updateRepositoryCheckoutState(skillSettingsId, {
    status: 'cloning',
    error: null,
    startedAt,
    completedAt: null,
  });

  try {
    // cloneRepositoryForAdmin owns the repo-cache lease (may cold-clone).
    // sharedReadCheckoutService.materialize uses a separate grounding-shared lease.
    const cache = await cloneRepositoryForAdmin(cacheOptions);
    const tipSha = cache.baseSha;

    const materializeResult = await sharedReadCheckoutService.materialize({
      provider: cacheOptions.provider,
      project: cacheOptions.project,
      repo: cacheOptions.repo,
      branch: cacheOptions.branch,
      sha: tipSha,
    });

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
    await updateRepositoryCheckoutState(skillSettingsId, {
      status: 'ready',
      sha: tipSha,
      error: null,
      startedAt,
      completedAt,
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
