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
  getVisibleSkillsForProject,
} from './foundationSkillReleaseService';

export type FoundationSkillAuthorizeReason =
  | 'authorized'
  | 'remote-unparsable'
  | 'repo-not-registered'
  | 'no-release'
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

/**
 * Reduce a git remote URL to a bare repo name.
 *
 * Handles the forms teams actually have configured:
 *   https://org@dev.azure.com/org/Project/_git/Repo
 *   https://org.visualstudio.com/Project/_git/Repo
 *   git@ssh.dev.azure.com:v3/org/Project/Repo
 *   https://github.com/org/Repo.git
 *   git@github.com:org/Repo.git
 *
 * Returns null when nothing repo-shaped can be extracted.
 */
export function parseRepoFromRemote(remoteUrl: string): string | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;

  // Drop any embedded credentials before parsing so tokens never reach the logs.
  let cleaned = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');

  // scp-style SSH (git@host:path) has no scheme — normalize the colon to a slash.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^[^@]*@/, '').replace(':', '/');
  } else {
    cleaned = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  }

  cleaned = cleaned.replace(/\.git$/i, '').replace(/\/+$/, '');

  // Azure DevOps puts the repo after the /_git/ marker, which is authoritative.
  const gitMarker = cleaned.match(/\/_git\/([^/]+)$/i);
  if (gitMarker?.[1]) return decodeURIComponent(gitMarker[1]);

  const segments = cleaned.split('/').filter(Boolean);
  // segments[0] is the host; a bare host carries no repo.
  if (segments.length < 2) return null;

  const last = segments[segments.length - 1];
  return last ? decodeURIComponent(last) : null;
}

/** Comparison key for repo names — ADO is case-insensitive and `.git` is noise. */
function repoMatchKey(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/i, '');
  // GitHub configs may store `org/name`; compare on the name only.
  const slash = trimmed.lastIndexOf('/');
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return name.toLowerCase();
}

/**
 * Resolve a git remote to its entitlement. Always resolves — an unauthorized
 * caller gets `authorized: false` plus a reason, never a thrown error, so the
 * CLI can tell "APEX said no" apart from "APEX was unreachable".
 */
export async function authorizeSkillInstall(
  remoteUrl: string,
): Promise<FoundationSkillAuthorizeResult> {
  const repo = parseRepoFromRemote(remoteUrl);

  if (!repo) {
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
  const wanted = repoMatchKey(repo);
  const match = configs.find(
    (c) => c.skillRepo?.trim() && repoMatchKey(c.skillRepo) === wanted,
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
  const release = await getLatestPublishedRelease(apexProject);

  if (!release) {
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

  const skills = getVisibleSkillsForProject(release, apexProject);

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
