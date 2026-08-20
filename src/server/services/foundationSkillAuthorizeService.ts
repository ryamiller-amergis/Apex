/**
 * Foundation Skill install authorization.
 *
 * Answers one question for the `@apex/skills` CLI: "is this repo entitled to
 * install foundation skills, and if so, which ones?"
 *
 * The CLI cannot use the Platform Admin endpoints (they require Super Admin), so
 * this service backs a narrow unauthenticated read-only endpoint. The response
 * carries no secrets — only an Apex project name, a release version, and the
 * skill names that release ships to that project.
 *
 * Entitlement is derived, never stored: a repo is authorized when
 *   1. its git remote maps to a repo registered in `project_skill_settings`, and
 *   2. that project has a published release visible to it.
 *
 * Because it is derived, revoking access is just deprecating the release or
 * removing the repo registration — there is no separate grant to clean up.
 */

import { listSkillConfigs } from './projectSettingsService';
import {
  getLatestPublishedRelease,
  getPublishedReleaseByArtifactVersion,
  getVisibleSkillsForProject,
} from './foundationSkillReleaseService';
import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';

export type FoundationSkillAuthorizeReason =
  | 'authorized'
  | 'remote-unparsable'
  | 'repo-not-registered'
  | 'no-release'
  | 'release-not-entitled'
  | 'release-unverified'
  | 'no-skills';

export interface FoundationSkillAuthorizeResult {
  authorized: boolean;
  reason: FoundationSkillAuthorizeReason;
  /** Repo name parsed out of the supplied git remote. */
  repo: string | null;
  apexProject: string | null;
  /** Release version the caller is entitled to, when authorized. */
  version: string | null;
  /**
   * The `@apex/skills` semver this release shipped. The CLI refuses to install
   * when the package it is running does not match, so a project cannot pull
   * content from a release it was not granted.
   */
  artifactVersion: string | null;
  /**
   * Whether `artifactVersion` was ever checked against the feed. False when the
   * release was published with Azure Artifacts unconfigured, in which case the
   * version was typed by hand and nothing confirmed it exists. The CLI softens
   * its version check to a warning in that case, so an unverified value cannot
   * lock a team out of an install it is genuinely entitled to.
   */
  artifactVersionVerified: boolean;
  /** Skill names this project may install from that release. */
  skills: string[];
  /** Operator-facing explanation, surfaced verbatim by the CLI. */
  message: string;
}

export interface RepositoryIdentity {
  provider: 'ado' | 'github';
  organization: string;
  project: string | null;
  repo: string;
}

/** Parse the hosted repository coordinates needed for collision-safe matching. */
export function parseRepositoryIdentity(
  remoteUrl: string,
): RepositoryIdentity | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;

  const adoSshUri = raw.match(
    /^ssh:\/\/(?:[^@/]+@)?ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/(.+)$/i,
  );
  if (adoSshUri) {
    return identity('ado', adoSshUri[1], adoSshUri[2], adoSshUri[3]);
  }

  const adoSsh = raw.match(
    /^(?:[^@]+@)?ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/i,
  );
  if (adoSsh) {
    return identity('ado', adoSsh[1], adoSsh[2], adoSsh[3]);
  }

  const cleaned = raw
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1')
    .replace(/^[^@]+@([^:]+):/, '$1/')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');

  const modernAdo = cleaned.match(
    /^dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/i,
  );
  if (modernAdo) {
    return identity('ado', modernAdo[1], modernAdo[2], modernAdo[3]);
  }

  const legacyAdo = cleaned.match(
    /^([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/i,
  );
  if (legacyAdo) {
    return identity('ado', legacyAdo[1], legacyAdo[2], legacyAdo[3]);
  }

  const github = cleaned.match(
    /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (github) {
    return identity('github', github[1], null, github[2]);
  }

  return null;
}

/** Backward-compatible repo-name parser used by existing diagnostics/tests. */
export function parseRepoFromRemote(remoteUrl: string): string | null {
  return parseRepositoryIdentity(remoteUrl)?.repo ?? null;
}

function identity(
  provider: RepositoryIdentity['provider'],
  organization: string,
  project: string | null,
  repo: string,
): RepositoryIdentity | null {
  try {
    return {
      provider,
      organization: decodeURIComponent(organization),
      project: project ? decodeURIComponent(project) : null,
      repo: decodeURIComponent(repo.replace(/\.git$/i, '')),
    };
  } catch {
    return null;
  }
}

function identityMatchesConfig(
  wanted: RepositoryIdentity,
  config: {
    project: string;
    skillProvider?: 'ado' | 'github';
    skillRepo: string;
  },
): boolean {
  const provider = config.skillProvider ?? 'ado';
  if (provider !== wanted.provider) return false;

  const configured = config.skillRepo
    .trim()
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  const configuredRepo = configured[configured.length - 1];
  if (!configuredRepo || configuredRepo.toLowerCase() !== wanted.repo.toLowerCase()) {
    return false;
  }

  if (wanted.provider === 'github') {
    const configuredOrg =
      configured.length >= 2 ? configured[configured.length - 2] : null;
    return configuredOrg?.toLowerCase() === wanted.organization.toLowerCase();
  }

  const configuredOrganization = configuredAdoOrganization();
  if (
    !configuredOrganization ||
    configuredOrganization.toLowerCase() !== wanted.organization.toLowerCase()
  ) {
    return false;
  }
  const configuredProject =
    configured.length >= 2
      ? configured[configured.length - 2]
      : config.project;
  return configuredProject.toLowerCase() === wanted.project?.toLowerCase();
}

function configuredAdoOrganization(): string | null {
  const configured = process.env.ADO_ORG?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.hostname === 'dev.azure.com') {
      return url.pathname.split('/').filter(Boolean)[0] ?? null;
    }
    const legacy = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
    return legacy?.[1] ?? null;
  } catch {
    return configured.replace(/^\/+|\/+$/g, '') || null;
  }
}

export function normalizeConfiguredRepository(
  provider: 'ado' | 'github' | undefined,
  skillRepo: string,
  githubOrg = process.env.GITHUB_ORG ?? '',
): string {
  const trimmed = skillRepo.trim().replace(/\.git$/i, '');
  if ((provider ?? 'ado') !== 'github') return trimmed;
  const parts = trimmed.split('/').filter(Boolean);
  const org = githubOrg.trim().replace(/^\/+|\/+$/g, '');
  if (parts.length === 1 && org) return `${org}/${parts[0]}`;
  return trimmed;
}

export function validateConfiguredRepository(
  provider: 'ado' | 'github' | undefined,
  skillRepo: string,
): string | null {
  if (provider !== undefined && provider !== 'ado' && provider !== 'github') {
    return `Unsupported skill provider: ${String(provider)}`;
  }
  const parts = skillRepo
    .trim()
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if ((provider ?? 'ado') === 'github' && parts.length !== 2) {
    return 'GitHub skillRepo must use organization/repo format';
  }
  if ((provider ?? 'ado') === 'ado' && (parts.length < 1 || parts.length > 2)) {
    return 'Azure DevOps skillRepo must use repo or project/repo format';
  }
  return null;
}

/**
 * Resolve a git remote to its entitlement. Always resolves — an unauthorized
 * caller gets `authorized: false` plus a reason, never a thrown error, so the
 * CLI can tell "APEX said no" apart from "APEX was unreachable".
 */
export async function authorizeSkillInstall(
  remoteUrl: string,
  requestedArtifactVersion?: string | null,
): Promise<FoundationSkillAuthorizeResult> {
  const repository = parseRepositoryIdentity(remoteUrl);
  const repo = repository?.repo ?? null;

  if (!repository || !repo) {
    return {
      authorized: false,
      reason: 'remote-unparsable',
      repo: null,
      apexProject: null,
      version: null,
      artifactVersion: null,
      artifactVersionVerified: false,
      skills: [],
      message:
        'Could not determine a repository name from the supplied git remote. ' +
        'Confirm this clone has an "origin" remote pointing at the hosted repo ' +
        '(git remote -v).',
    };
  }

  const configs = await listSkillConfigs();
  const match = configs.find(
    (config) =>
      config.skillRepo?.trim() &&
      identityMatchesConfig(repository, config),
  );

  if (!match) {
    return {
      authorized: false,
      reason: 'repo-not-registered',
      repo,
      apexProject: null,
      version: null,
      artifactVersion: null,
      artifactVersionVerified: false,
      skills: [],
      message:
        `Repository "${repo}" is not registered with any Apex project. ` +
        'An Apex admin must add it under Project Admin → Project Settings ' +
        'before foundation skills can be installed.',
    };
  }

  const apexProject = match.project;
  const release = requestedArtifactVersion
    ? await getPublishedReleaseByArtifactVersion(
        requestedArtifactVersion,
        apexProject,
      )
    : await getLatestPublishedRelease(apexProject);

  if (!release) {
    if (requestedArtifactVersion) {
      return {
        authorized: false,
        reason: 'release-not-entitled',
        repo,
        apexProject,
        version: null,
        artifactVersion: requestedArtifactVersion,
        artifactVersionVerified: false,
        skills: [],
        message:
          `No published APEX release grants @apex/skills@${requestedArtifactVersion} ` +
          `to project "${apexProject}". Use the package version shown in APEX.`,
      };
    }
    return {
      authorized: false,
      reason: 'no-release',
      repo,
      apexProject,
      version: null,
      artifactVersion: null,
      artifactVersionVerified: false,
      skills: [],
      message:
        `No published APEX release targets project "${apexProject}". ` +
        'An Apex admin must publish a release for this project under ' +
        'Platform Admin → Foundation Skills → Releases.',
    };
  }

  if (!release.integritySha256 || !release.manifestSnapshot) {
    return {
      authorized: false,
      reason: 'release-unverified',
      repo,
      apexProject,
      version: release.version,
      artifactVersion: release.artifactVersion ?? null,
      artifactVersionVerified: false,
      skills: [],
      message:
        `Release ${release.version} has no server-verified artifact manifest and ` +
        `cannot authorize installs. Publish a verified replacement release.`,
    };
  }

  const releaseSkills = getVisibleSkillsForProject(release, apexProject);
  const skills = withReleaseAlwaysInstallSkills(release, releaseSkills);

  if (skills.length === 0) {
    return {
      authorized: false,
      reason: 'no-skills',
      repo,
      apexProject,
      version: release.version,
      artifactVersion: release.artifactVersion ?? null,
      artifactVersionVerified: Boolean(release.integritySha256),
      skills: [],
      message:
        `Release ${release.version} is visible to "${apexProject}" but ships no ` +
        'skills to it. Ask an Apex admin to add skills to the release or adjust ' +
        'per-skill targeting.',
    };
  }

  return {
    authorized: true,
    reason: 'authorized',
    repo,
    apexProject,
    version: release.version,
    artifactVersion: release.artifactVersion ?? null,
    artifactVersionVerified: Boolean(release.integritySha256),
    skills,
    message:
      `Authorized for "${apexProject}" via release ${release.version} ` +
      `(${skills.length} skill${skills.length === 1 ? '' : 's'}).`,
  };
}

function withReleaseAlwaysInstallSkills(
  release: FoundationSkillRelease,
  skills: string[],
): string[] {
  const snapshotSkills = (
    release.manifestSnapshot as { skills?: Array<{ name?: string; alwaysInstall?: boolean }> } | null
  )?.skills;
  if (!Array.isArray(snapshotSkills)) return [...skills];

  const out = [...skills];
  const seen = new Set(out);
  for (const entry of snapshotSkills) {
    if (
      entry?.alwaysInstall === true &&
      typeof entry.name === 'string' &&
      !seen.has(entry.name)
    ) {
      out.push(entry.name);
      seen.add(entry.name);
    }
  }
  return out;
}
