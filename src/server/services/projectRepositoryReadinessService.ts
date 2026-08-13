/**
 * Authoritative repository readiness for a Project Skill Settings configuration.
 * Filesystem readiness (mirror + `.apex-shared-ready`) wins over DB `ready`.
 */
import fs from 'fs';
import path from 'path';
import type {
  ProjectRepositoryNotReadyError,
  ProjectRepositoryReadiness,
  RepositoryCheckoutStatus,
  RepositoryReadinessStatus,
  SkillProvider,
} from '../../shared/types/projectSettings';
import { PROJECT_REPOSITORY_NOT_READY } from '../../shared/types/projectSettings';
import {
  getSkillConfigById,
  resolveSkillConfig,
} from './projectSettingsService';
import {
  getRepoCacheDir,
  type RepoCacheOptions,
} from './repoCacheService';
import {
  SHARED_READ_MARKER,
  sharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import { trackEvent } from './telemetry';

const ADMIN_MESSAGE =
  'A project administrator must clone this repository before repository-dependent AI work can run.';

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

function asCheckoutStatus(value: string | null | undefined): RepositoryCheckoutStatus {
  if (
    value === 'not_cloned' ||
    value === 'cloning' ||
    value === 'ready' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'not_cloned';
}

function mirrorExists(options: RepoCacheOptions): boolean {
  const cacheDir = getRepoCacheDir(options);
  return (
    fs.existsSync(cacheDir) &&
    fs.existsSync(path.join(cacheDir, 'HEAD'))
  );
}

/**
 * Resolve readiness for a skill-settings row. Cross-project ids are treated as
 * not-found by the caller (404); this function returns null when the row is missing.
 */
export async function getProjectRepositoryReadiness(
  skillSettingsId: string,
  options?: { project?: string },
): Promise<ProjectRepositoryReadiness | null> {
  const config = await getSkillConfigById(skillSettingsId);
  if (!config) return null;
  if (options?.project && config.project !== options.project) return null;

  const dbStatus = asCheckoutStatus(config.repositoryCheckoutStatus);
  const cacheOptions = toRepoCacheOptions(config);
  const sha = config.repositoryCheckoutSha ?? null;
  const hasMirror = mirrorExists(cacheOptions);

  let filesystemReady = false;
  if (sha && hasMirror) {
    const ready = sharedReadCheckoutService.getReady({
      provider: cacheOptions.provider,
      project: cacheOptions.project,
      repo: cacheOptions.repo,
      branch: cacheOptions.branch,
      sha,
    });
    filesystemReady = Boolean(ready);
    // Also accept a direct marker probe when getReady side-effects are undesirable —
    // getReady already checks the marker; keep filesystemReady aligned.
    if (!filesystemReady) {
      const destination = sharedReadCheckoutService.resolvePath({
        provider: cacheOptions.provider,
        project: cacheOptions.project,
        repo: cacheOptions.repo,
        branch: cacheOptions.branch,
        sha,
      });
      filesystemReady = fs.existsSync(path.join(destination, SHARED_READ_MARKER));
    }
  }

  let status: RepositoryReadinessStatus = dbStatus;
  if (dbStatus === 'ready' && !filesystemReady) {
    status = hasMirror ? 'snapshot_unavailable' : 'not_cloned';
  } else if (dbStatus === 'cloning') {
    status = 'cloning';
  } else if (dbStatus === 'failed') {
    status = 'failed';
  } else if (!hasMirror) {
    status = 'not_cloned';
  }

  return {
    skillSettingsId,
    status,
    sha: status === 'ready' ? sha : sha,
    error: config.repositoryCheckoutError ?? null,
    startedAt: config.repositoryCheckoutStartedAt ?? null,
    completedAt: config.repositoryCheckoutCompletedAt ?? null,
    filesystemReady: status === 'ready' && filesystemReady,
    progressPercent:
      status === 'cloning'
        ? (config.repositoryCheckoutProgressPercent ?? 0)
        : null,
    progressLabel:
      status === 'cloning'
        ? (config.repositoryCheckoutProgressLabel ?? 'Cloning')
        : null,
  };
}

export function isRepositoryReady(
  readiness: ProjectRepositoryReadiness | null | undefined,
): boolean {
  return Boolean(readiness?.filesystemReady && readiness.status === 'ready');
}

export class ProjectRepositoryNotReady extends Error {
  readonly code = PROJECT_REPOSITORY_NOT_READY;
  readonly httpStatus = 409;
  readonly readinessStatus: RepositoryReadinessStatus;

  constructor(readiness: ProjectRepositoryReadiness) {
    super(ADMIN_MESSAGE);
    this.name = 'ProjectRepositoryNotReady';
    this.readinessStatus = readiness.status;
  }

  toJSON(): ProjectRepositoryNotReadyError {
    return {
      code: PROJECT_REPOSITORY_NOT_READY,
      message: this.message,
      status: this.readinessStatus,
    };
  }
}

/**
 * Assert the selected skill settings repository is ready for repository-dependent work.
 * Throws ProjectRepositoryNotReady (map to HTTP 409) when blocked.
 * Emits grounding.readiness_blocked telemetry on block.
 */
export async function assertProjectRepositoryReady(opts: {
  skillSettingsId: string;
  project?: string;
  surface: string;
}): Promise<ProjectRepositoryReadiness> {
  const readiness = await getProjectRepositoryReadiness(opts.skillSettingsId, {
    project: opts.project,
  });
  if (!readiness) {
    const missing: ProjectRepositoryReadiness = {
      skillSettingsId: opts.skillSettingsId,
      status: 'not_cloned',
      sha: null,
      error: null,
      startedAt: null,
      completedAt: null,
      filesystemReady: false,
      progressPercent: null,
      progressLabel: null,
    };
    trackEvent('grounding.readiness_blocked', {
      surface: opts.surface,
      skillSettingsId: opts.skillSettingsId,
      status: missing.status,
    });
    throw new ProjectRepositoryNotReady(missing);
  }
  if (!isRepositoryReady(readiness)) {
    trackEvent('grounding.readiness_blocked', {
      surface: opts.surface,
      skillSettingsId: opts.skillSettingsId,
      status: readiness.status,
    });
    throw new ProjectRepositoryNotReady(readiness);
  }
  return readiness;
}

/**
 * Resolve skill settings the same way workflow routes do (`resolveSkillConfig`),
 * then assert readiness. Throws ProjectRepositoryNotReady when blocked.
 */
export async function assertResolvedProjectRepositoryReady(opts: {
  project: string;
  settingsId?: string | null;
  surface: string;
}): Promise<ProjectRepositoryReadiness> {
  const skillConfig = await resolveSkillConfig({
    project: opts.project,
    settingsId: opts.settingsId ?? undefined,
  });
  return assertProjectRepositoryReady({
    skillSettingsId: skillConfig?.id ?? opts.settingsId ?? '',
    project: opts.project,
    surface: opts.surface,
  });
}

