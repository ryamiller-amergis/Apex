/**
 * Foundation Skill Repo Update Service — Wave 7
 *
 * Orchestrates the full lifecycle for delivering a foundation skills update
 * to a consumer repository via a pull request:
 *
 *   1. Clone the consumer repo at its default branch
 *   2. Create a unique `chore/apex-skills-<version>` update branch
 *   3. Run `npx @apex/skills install` inside the workspace to vendor foundations
 *      and scaffold absent adapters (the CLI writes .apex/foundation/ + lockfile)
 *   4. Validate the resulting diff — abort if:
 *        - no changes were written (nothing to PR)
 *        - foundation checksums drift (existing managed files were hand-edited)
 *        - the installed version is incompatible with adapters in this repo
 *   5. Commit with a structured message, push the branch
 *   6. Open a PR (ADO or GitHub) with release notes and compatibility summary
 *   7. Clean up the workspace regardless of outcome
 *
 * The service never writes to the default branch. On any validation failure it
 * returns a structured report and opens no PR.
 *
 * Reuses:
 *   - repoCheckoutService   — checkout, commit, push, cleanup
 *   - repoCacheService      — resolveGitRemote
 *   - AzureDevOpsService    — ADO PR creation
 *   - skillCatalogGitHub    — GitHub PR creation
 */

import fs from 'fs';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { execSync } from 'child_process';
import {
  checkoutDefaultBranch,
  checkoutNewBranch,
  pushBranch,
  cleanupWorkspace,
  getWorkspaceDir,
} from './repoCheckoutService';
import { resolveGitRemote } from './repoCacheService';
import { AzureDevOpsService } from './azureDevOps';
import * as githubCatalog from './skillCatalogGitHub';
import { getRelease, getLatestPublishedRelease, isReleaseVisibleToProject } from './foundationSkillReleaseService';
import { checkCompatibility } from './foundationSkillCompatibilityService';
import { git, safeArgs, LONG_TIMEOUT_MS } from '../utils/asyncGit';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpdateRepoOptions {
  /** ADO project or GitHub org */
  project: string;
  repo: string;
  /** Default branch to base the update branch from */
  defaultBranch?: string;
  provider?: SkillProvider;
  /** Specific release id to install; defaults to the latest published release */
  releaseId?: string;
  /** Override which skills to install; defaults to the release's selectedSkills */
  selectedSkills?: string[];
  /** Apex project name — used to filter releases by targetProjects allowlist */
  apexProject?: string | null;
  /** Actor for PR attribution */
  actor?: { id?: string | null; email?: string | null; displayName?: string | null };
}

export type UpdateRepoResultStatus =
  | 'pr_created'      // PR was opened successfully
  | 'no_changes'      // install produced no file changes
  | 'drift'           // existing managed foundation files have been hand-edited
  | 'incompatible'    // adapter contract range not satisfied by this release
  | 'error';          // unexpected failure

export interface UpdateRepoResult {
  status: UpdateRepoResultStatus;
  prUrl: string | null;
  branchName: string | null;
  changedFiles: string[];
  report: string;
  releaseVersion: string | null;
  errors: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Ephemeral session id scoped to this update run */
function makeSessionId(repoName: string, version: string): string {
  const rand = randomBytes(4).toString('hex');
  return `skill-update-${repoName.slice(0, 20)}-${version.replace(/\./g, '-')}-${rand}`;
}

/**
 * Run `npx @apex/skills install <skills...>` inside the workspace.
 * Returns stdout/stderr combined. Throws on non-zero exit.
 */
function runCliInstall(workspaceDir: string, skills: string[]): string {
  const skillArgs = skills.length > 0 ? skills.join(' ') : '';
  const cmd = `npx @apex/skills install ${skillArgs}`.trim();
  console.log(`[foundationSkillRepoUpdateService] Running: ${cmd}`);
  try {
    return execSync(cmd, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      timeout: 5 * 60_000, // 5 min cap for full install
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  } catch (e: unknown) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    throw new Error(`@apex/skills install failed:\n${output.slice(0, 2000)}`);
  }
}

/** Read changed files in the workspace relative to HEAD. */
async function changedFiles(workspaceDir: string): Promise<string[]> {
  await git(safeArgs(workspaceDir, ['add', '-A']), { cwd: workspaceDir });
  const out = await git(safeArgs(workspaceDir, ['diff', '--cached', '--name-only']), {
    cwd: workspaceDir,
  });
  return out.split('\n').filter(Boolean);
}

/** Check for drift (managed foundation files that differ from lockfile hashes). */
function detectDrift(workspaceDir: string): string[] {
  const lockPath = path.join(workspaceDir, 'apex-skills.lock.json');
  if (!fs.existsSync(lockPath)) return [];
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    const drifted: string[] = [];
    for (const [rel, expected] of Object.entries(lock.files ?? {})) {
      const abs = path.join(workspaceDir, ...rel.split('/'));
      if (!fs.existsSync(abs)) continue;
      const actual = createHash('sha256')
        .update(fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n'))
        .digest('hex');
      if (actual !== expected) drifted.push(rel);
    }
    return drifted;
  } catch {
    return [];
  }
}

/** Build a structured PR description from release notes and CLI output. */
function buildPrDescription(release: FoundationSkillRelease, cliOutput: string): string {
  const sections: string[] = [];

  sections.push(`## APEX Foundation Skills — Update to v${release.version}`);
  sections.push(
    `This PR was opened automatically by APEX. It updates the vendored foundation files ` +
    `under \`.apex/foundation/\` and refreshes \`apex-skills.lock.json\`.\n` +
    `Team-owned adapter files in \`.cursor/skills/\` are **never overwritten**.`,
  );

  if (release.releaseNotes?.trim()) {
    sections.push(`## Release notes\n\n${release.releaseNotes.trim()}`);
  }
  if (release.breakingChanges?.trim()) {
    sections.push(`## ⚠️ Breaking changes\n\n${release.breakingChanges.trim()}`);
  }

  const installed = release.selectedSkills?.length
    ? `Skills included: ${release.selectedSkills.join(', ')}`
    : '';
  if (installed) sections.push(`## Skills\n\n${installed}`);

  sections.push(`## Install output\n\n\`\`\`\n${cliOutput.slice(0, 3000).trim()}\n\`\`\``);

  sections.push(
    `## Checklist\n` +
    `- [ ] Review adapter files in \`.cursor/skills/\` for any TODO placeholders to fill\n` +
    `- [ ] Verify the foundation files in \`.apex/foundation/\` are not hand-edited\n` +
    `- [ ] Run \`npx @apex/skills validate\` locally to confirm clean state`,
  );

  return sections.join('\n\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Clone a consumer repo, install/update foundations, and open a PR.
 *
 * @param opts     - repo coordinates, release, and actor info
 * @param adoService - optional pre-authenticated ADO service for ADO repos
 */
export async function updateRepoWithFoundationSkills(
  opts: UpdateRepoOptions,
  adoService?: AzureDevOpsService | null,
): Promise<UpdateRepoResult> {
  const {
    project,
    repo,
    provider = 'ado',
    actor,
  } = opts;
  const errors: string[] = [];

  // Resolve the release to install
  let release: FoundationSkillRelease | null = null;
  try {
    release = opts.releaseId
      ? await getRelease(opts.releaseId)
      : await getLatestPublishedRelease(opts.apexProject ?? null);
  } catch (e: unknown) {
    errors.push(`Failed to resolve release: ${(e as Error).message}`);
  }
  if (!release) {
    errors.push('No published foundation skills release found');
    return { status: 'error', prUrl: null, branchName: null, changedFiles: [], report: errors.join('\n'), releaseVersion: null, errors };
  }
  if (release.status !== 'published') {
    errors.push(`Release ${release.id} is not published (status: ${release.status})`);
    return { status: 'error', prUrl: null, branchName: null, changedFiles: [], report: errors.join('\n'), releaseVersion: release.version, errors };
  }
  if (opts.apexProject && !isReleaseVisibleToProject(release, opts.apexProject)) {
    errors.push(`Release ${release.version} is not targeted at Apex project "${opts.apexProject}" — update the release targeting or use a different release`);
    return { status: 'error', prUrl: null, branchName: null, changedFiles: [], report: errors.join('\n'), releaseVersion: release.version, errors };
  }

  const version        = release.version;
  const skills         = opts.selectedSkills ?? release.selectedSkills ?? [];
  const defaultBranch  = opts.defaultBranch ?? 'main';
  const branchName     = `chore/apex-skills-${version.replace(/\./g, '-')}`;
  const sessionId      = makeSessionId(repo, version);
  const remote         = resolveGitRemote(provider, project, repo);

  let workspaceDir: string | null = null;
  let prUrl: string | null = null;

  try {
    // 1. Clone the repo
    console.log(`[foundationSkillRepoUpdateService] Cloning ${repo} (${project}, ${provider})`);
    workspaceDir = await checkoutDefaultBranch({
      project,
      repo,
      branch: defaultBranch,
      sessionId,
      provider,
    });

    // 2. Create update branch
    await checkoutNewBranch(workspaceDir, branchName);
    console.log(`[foundationSkillRepoUpdateService] On branch ${branchName}`);

    // 3. Run the CLI
    let cliOutput = '';
    try {
      cliOutput = runCliInstall(workspaceDir, skills);
      console.log(`[foundationSkillRepoUpdateService] CLI install complete`);
    } catch (e: unknown) {
      errors.push((e as Error).message);
      return { status: 'error', prUrl: null, branchName, changedFiles: [], report: errors.join('\n'), releaseVersion: version, errors };
    }

    // 4a. Check for drift in existing managed files
    const drifted = detectDrift(workspaceDir);
    if (drifted.length > 0) {
      errors.push(`Foundation drift detected — existing managed files modified: ${drifted.join(', ')}`);
      errors.push('Resolve drift by reverting hand-edits to .apex/foundation/ before updating.');
      return { status: 'drift', prUrl: null, branchName, changedFiles: drifted, report: errors.join('\n'), releaseVersion: version, errors };
    }

    // 4b. Check for actual changes
    const changed = await changedFiles(workspaceDir);
    if (changed.length === 0) {
      console.log(`[foundationSkillRepoUpdateService] No changes — repo already at v${version}`);
      return { status: 'no_changes', prUrl: null, branchName, changedFiles: [], report: `Already up to date with v${version}`, releaseVersion: version, errors };
    }

    // 4c. Compatibility check against the installed version
    try {
      const compatReport = await checkCompatibility(
        { provider, project, repo, branch: defaultBranch, candidateVersion: version },
        { id: actor?.id ?? null },
      );
      if (compatReport.status === 'incompatible') {
        errors.push(`Compatibility check failed: ${compatReport.errors.join('; ')}`);
        return { status: 'incompatible', prUrl: null, branchName, changedFiles: changed, report: errors.join('\n'), releaseVersion: version, errors };
      }
    } catch (e: unknown) {
      // Non-fatal — log and continue
      console.warn(`[foundationSkillRepoUpdateService] Compatibility check error (non-fatal): ${(e as Error).message}`);
    }

    // 5. Commit and push
    const commitMsg =
      `chore(apex-skills): update foundation skills to v${version}\n\n` +
      `Installed via APEX foundation skills distribution.\n` +
      `Selected skills: ${skills.join(', ') || '(all)'}\n` +
      (release.breakingChanges ? `\nBreaking changes: ${release.breakingChanges.slice(0, 200)}` : '');

    await git(safeArgs(workspaceDir, ['commit', '-m', commitMsg]), {
      cwd: workspaceDir,
      env: {
        GIT_AUTHOR_NAME:     actor?.displayName ?? 'APEX',
        GIT_AUTHOR_EMAIL:    actor?.email ?? 'apex@noreply',
        GIT_COMMITTER_NAME:  actor?.displayName ?? 'APEX',
        GIT_COMMITTER_EMAIL: actor?.email ?? 'apex@noreply',
      },
    });

    await pushBranch(workspaceDir, branchName, remote);
    console.log(`[foundationSkillRepoUpdateService] Pushed ${branchName}`);

    // 6. Open PR
    const prTitle = `chore: update APEX foundation skills to v${version}`;
    const prBody  = buildPrDescription(release, cliOutput);

    if (provider === 'github') {
      prUrl = await githubCatalog.createPullRequest({
        repo,
        sourceBranch: branchName,
        targetBranch: defaultBranch,
        title: prTitle,
        description: prBody,
      });
    } else if (adoService) {
      prUrl = await adoService.createPullRequest({
        repo,
        project,
        sourceBranch: branchName,
        targetBranch: defaultBranch,
        title: prTitle,
        description: prBody,
      });
    } else {
      // ADO service not provided — PR creation skipped, branch is available
      console.warn('[foundationSkillRepoUpdateService] No ADO service — branch pushed but PR not created');
      errors.push('Branch pushed but PR could not be opened — ADO service not available');
    }

    console.log(`[foundationSkillRepoUpdateService] Done: ${prUrl ?? '(no PR)'}`);
    return {
      status: 'pr_created',
      prUrl,
      branchName,
      changedFiles: changed,
      report: `Foundation skills updated to v${version}. PR: ${prUrl ?? 'pending'}`,
      releaseVersion: version,
      errors,
    };

  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    errors.push(msg);
    console.error(`[foundationSkillRepoUpdateService] Unexpected error:`, msg);
    return { status: 'error', prUrl: null, branchName, changedFiles: [], report: msg, releaseVersion: version, errors };

  } finally {
    // 7. Always clean up
    if (workspaceDir) {
      try { cleanupWorkspace(sessionId); } catch { /* non-fatal */ }
    }
  }
}
