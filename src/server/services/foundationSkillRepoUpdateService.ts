/**
 * Foundation Skill Repo Update Service — Wave 7
 *
 * Orchestrates the full lifecycle for delivering a foundation skills update
 * to a consumer repository via a pull request:
 *
 *   1. Clone the consumer repo at its default branch
 *   2. Create a unique `chore/apex-skills-<version>` update branch
 *   3. Run `npx @apex/skills install` inside the workspace to refresh the
 *      fenced managed region inside .cursor/skills/<skill>/SKILL.md + companions
 *      (project notes below the fence are preserved; lockfile is refreshed)
 *   4. Validate the resulting diff — abort if:
 *        - no changes were written (nothing to PR)
 *        - post-install managed-file checksums drift (integrity failure)
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
import os from 'os';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  checkoutDefaultBranch,
  checkoutNewBranch,
  pushBranch,
  cleanupWorkspace,
} from './repoCheckoutService';
import { resolveGitRemote } from './repoCacheService';
import { AzureDevOpsService } from './azureDevOps';
import * as githubCatalog from './skillCatalogGitHub';
import {
  getRelease,
  getLatestPublishedRelease,
  isReleaseVisibleToProject,
  listRollbackTargets,
  semverGreaterThan,
  appendAudit,
} from './foundationSkillReleaseService';
import { downloadPackageArtifact } from './azureArtifactsSkillService';
import { extractNpmTarballSafely } from './foundationSkillArtifactManifest';
import { getRepoStatus } from './foundationSkillCompatibilityService';
import { git, safeArgs } from '../utils/asyncGit';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type {
  FoundationSkillRelease,
  RollbackFoundationSkillRepoResult,
} from '../../shared/types/foundationSkills';
import { getVisibleSkillsForProject } from '../../shared/types/foundationSkills';

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
  /** Apex project name — used to filter releases by targetProjects allowlist */
  apexProject: string;
  /** Canonical APEX origin supplied to the CLI authorization check. */
  apexUrl: string;
  /**
   * `update` (default) installs the latest / chosen release forward.
   * `rollback` installs a lower published version and uses rollback PR copy.
   */
  intent?: 'update' | 'rollback';
  /** When intent is rollback, the version currently installed (for PR messaging). */
  fromVersion?: string | null;
  /** Actor for PR attribution */
  actor?: { id?: string | null; email?: string | null; displayName?: string | null };
}

export interface RollbackRepoOptions {
  project: string;
  repo: string;
  defaultBranch?: string;
  provider?: SkillProvider;
  apexProject: string;
  apexUrl: string;
  /** Target published release id to roll back to. */
  releaseId: string;
  /** Optional override; defaults to last observed installed version. */
  fromVersion?: string | null;
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

export function resolveReleasedSkillsForProject(
  release: FoundationSkillRelease,
  apexProject: string,
): string[] {
  if (!release.integritySha256 || !release.manifestSnapshot) {
    throw new Error(`Release ${release.version} has no verified artifact manifest`);
  }
  const visible = getVisibleSkillsForProject(release, apexProject);
  const out = [...visible];
  const seen = new Set(out);
  for (const skill of release.manifestSnapshot.skills) {
    if (skill.alwaysInstall && !seen.has(skill.name)) {
      out.push(skill.name);
      seen.add(skill.name);
    }
  }
  return out;
}

export function buildArtifactCliArgs(
  artifactVersion: string,
  skills: string[],
  cliPath = 'bin/apex-skills.mjs',
): string[] {
  if (!parseSemver(artifactVersion)) {
    throw new Error(`Invalid artifact version: ${artifactVersion}`);
  }
  for (const skill of skills) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(skill)) {
      throw new Error(`Invalid skill name: ${skill}`);
    }
  }
  return [
    cliPath,
    'install',
    ...skills,
    '--skip-feed',
  ];
}

async function runCliInstall(
  workspaceDir: string,
  skills: string[],
  release: FoundationSkillRelease,
  apexUrl: string,
): Promise<string> {
  buildArtifactCliArgs(release.artifactVersion, skills);
  const downloaded = await downloadPackageArtifact(release.artifactVersion);
  if (downloaded.integritySha256 !== release.integritySha256) {
    throw new Error(
      `Downloaded artifact integrity mismatch for ${release.artifactVersion}`,
    );
  }
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-exec-'));
  try {
    const extractDir = path.join(artifactDir, 'extracted');
    fs.mkdirSync(extractDir);
    extractNpmTarballSafely(downloaded.tarball, extractDir);
    const cliPath = path.join(extractDir, 'package', 'bin', 'apex-skills.mjs');
    if (!fs.existsSync(cliPath)) {
      throw new Error('Verified artifact does not contain bin/apex-skills.mjs');
    }
    const cliArgs = buildArtifactCliArgs(
      release.artifactVersion,
      skills,
      cliPath,
    );
    const installOutput = execFileSync(process.execPath, cliArgs, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      timeout: 5 * 60_000,
      env: buildGeneratedCliEnv(apexUrl),
      shell: false,
    });
    const checkOutput = execFileSync(process.execPath, [cliPath, 'check'], {
      cwd: workspaceDir,
      encoding: 'utf-8',
      timeout: 2 * 60_000,
      env: buildGeneratedCliEnv(apexUrl),
      shell: false,
    });
    return `${installOutput}\n${checkOutput}`.trim();
  } catch (e: unknown) {
    const err = e as { message?: string; stdout?: string; stderr?: string };
    const output = redactSecrets(
      [err.stdout, err.stderr, err.message].filter(Boolean).join('\n'),
    );
    throw new Error(`@apex/skills install failed:\n${output.slice(0, 2000)}`);
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

export function buildGeneratedCliEnv(apexUrl: string): NodeJS.ProcessEnv {
  const parsed = new URL(apexUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('APEX URL cannot contain credentials, query, or fragment');
  }
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('APEX URL must use HTTPS outside local development');
  }
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE',
    'TEMP', 'TMP', 'TMPDIR', 'NODE_ENV',
  ];
  const env: NodeJS.ProcessEnv = {
    FORCE_COLOR: '0',
    APEX_URL: parsed.toString().replace(/\/$/, ''),
  };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function redactSecrets(text: string): string {
  const pat = process.env.AZURE_ARTIFACTS_PAT;
  return pat ? text.split(pat).join('[REDACTED]') : text;
}

/** Read changed files in the workspace relative to HEAD. */
async function changedFiles(workspaceDir: string): Promise<string[]> {
  await git(safeArgs(workspaceDir, ['add', '-A']), { cwd: workspaceDir });
  const out = await git(
    safeArgs(workspaceDir, [
      'diff',
      '--cached',
      '--name-status',
      '--find-renames',
      '-z',
    ]),
    { cwd: workspaceDir },
  );
  const tokens = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]/.test(status)) {
      if (tokens[index]) files.push(tokens[index++]);
      if (tokens[index]) files.push(tokens[index++]);
    } else if (tokens[index]) {
      files.push(tokens[index++]);
    }
  }
  return [...new Set(files)];
}

export function validateGeneratedDiff(
  changed: string[],
  managedSkills: string[],
  reconciliationVersion: string | null,
): void {
  const skillRoots = managedSkills.map((skill) => `.cursor/skills/${skill}/`);
  const backupRoots = managedSkills.map((skill) => `.apex/backups/${skill}/`);
  const unexpected = changed.filter((raw) => {
    const file = raw.replace(/\\/g, '/');
    if (
      file.includes('../') ||
      path.posix.basename(file).toLowerCase() === '.npmrc'
    ) return true;
    if (file === 'apex-skills.lock.json' || file === '.apex/config.json') {
      return false;
    }
    if (skillRoots.some((root) => file.startsWith(root))) return false;
    if (backupRoots.some((root) => file.startsWith(root))) return false;
    if (
      reconciliationVersion &&
      managedSkills.some((skill) =>
        file.startsWith(
          `.apex/rollback-backups/${reconciliationVersion}/${skill}/`,
        ),
      )
    ) return false;
    return true;
  });
  if (unexpected.length) {
    throw new Error(
      `Unexpected generated files outside the APEX skills allowlist: ` +
      `${unexpected.join(', ')}`,
    );
  }
}

export function reconcileRollbackWorkspace(
  workspaceDir: string,
  targetSkills: string[],
  targetVersion: string,
  direction: 'update' | 'rollback',
  expectedSourceVersion?: string | null,
  requireLock = true,
): { removedSkills: string[]; managedSkills: string[] } {
  buildArtifactCliArgs(targetVersion, targetSkills);
  const lockPath = path.join(workspaceDir, 'apex-skills.lock.json');
  if (!fs.existsSync(lockPath)) {
    if (requireLock) {
      throw new Error('Cannot reconcile release without apex-skills.lock.json');
    }
    return { removedSkills: [], managedSkills: [...targetSkills] };
  }
  const lock = readVerifiedConsumerLock(lockPath);
  if (lock.package !== '@apex/skills') {
    throw new Error(`Source lock package is not @apex/skills`);
  }
  if (
    expectedSourceVersion &&
    lock.suiteVersion !== expectedSourceVersion
  ) {
    throw new Error(
      `Source lock version ${lock.suiteVersion ?? 'missing'} does not match ` +
      `expected installed version ${expectedSourceVersion}`,
    );
  }
  if (direction === 'update' && lock.suiteVersion !== targetVersion) {
    if (!isGreaterVersion(targetVersion, lock.suiteVersion!)) {
      throw new Error(
        `Update target ${targetVersion} must be newer than source ` +
        `${lock.suiteVersion}`,
      );
    }
  }
  if (direction === 'rollback') {
    if (!isGreaterVersion(lock.suiteVersion!, targetVersion)) {
      throw new Error(
        `Rollback source ${lock.suiteVersion} must be newer than target ` +
        `${targetVersion}`,
      );
    }
  }
  const installed = Object.keys(lock.skills ?? {});
  for (const skill of installed) buildArtifactCliArgs(targetVersion, [skill]);
  const target = new Set(targetSkills);
  const removedSkills = installed.filter((skill) => !target.has(skill)).sort();

  for (const skill of removedSkills) {
    const source = path.join(workspaceDir, '.cursor', 'skills', skill);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(
      workspaceDir,
      '.apex',
      'rollback-backups',
      targetVersion,
      skill,
      `attempt-${Date.now()}-${randomBytes(3).toString('hex')}`,
    );
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  }
  fs.rmSync(lockPath, { force: true });
  return {
    removedSkills,
    managedSkills: [...new Set([...targetSkills, ...removedSkills])],
  };
}

function isGreaterVersion(a: string, b: string): boolean {
  const left = parseSemver(a)!;
  const right = parseSemver(b)!;
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericStrings(
      left.core[index],
      right.core[index],
    );
    if (comparison !== 0) return comparison > 0;
  }
  if (!left.prerelease.length && right.prerelease.length) return true;
  if (left.prerelease.length && !right.prerelease.length) return false;
  if (!left.prerelease.length && !right.prerelease.length) return false;

  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return false;
    if (rightId === undefined) return true;
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      return compareNumericStrings(leftId, rightId) > 0;
    }
    if (leftNumeric) return false;
    if (rightNumeric) return true;
    return leftId > rightId;
  }
  return false;
}

function parseSemver(
  version: string,
): { core: [string, string, string]; prerelease: string[] } | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match) return null;
  const core = [match[1], match[2], match[3]] as [string, string, string];
  if (core.some((part) => part.length > 1 && part.startsWith('0'))) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (
    prerelease.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'),
    )
  ) {
    return null;
  }
  return { core, prerelease };
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function validateInstalledLock(
  workspaceDir: string,
  release: FoundationSkillRelease,
  expectedSkills: string[],
): void {
  const lockPath = path.join(workspaceDir, 'apex-skills.lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error('Installer did not create apex-skills.lock.json');
  }
  const lock = readVerifiedConsumerLock(lockPath);
  if (lock.package !== '@apex/skills' || lock.suiteVersion !== release.version) {
    throw new Error(
      `Installed lock does not match release ${release.version}`,
    );
  }
  const actual = Object.keys(lock.skills ?? {}).sort();
  const expected = [...expectedSkills].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Installed lock skill set mismatch: expected ${expected.join(', ')}, ` +
      `got ${actual.join(', ')}`,
    );
  }
}

function readVerifiedConsumerLock(lockPath: string): {
  lockfileVersion?: number;
  suiteVersion?: string;
  package?: string;
  integrity?: string;
  generatedAt?: string;
  skills?: Record<string, unknown>;
  [key: string]: unknown;
} {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    throw new Error('apex-skills.lock.json is not valid JSON');
  }
  if (
    lock?.lockfileVersion !== 2 ||
    typeof lock.suiteVersion !== 'string' ||
    !parseSemver(lock.suiteVersion) ||
    typeof lock.integrity !== 'string' ||
    !lock.skills ||
    typeof lock.skills !== 'object' ||
    Array.isArray(lock.skills)
  ) {
    throw new Error('apex-skills.lock.json has an invalid v2 schema');
  }
  const { generatedAt: _generatedAt, integrity, ...rest } = lock;
  const expected = createHash('sha256')
    .update(stableJson(rest), 'utf8')
    .digest('hex');
  if (integrity !== expected) {
    throw new Error('apex-skills.lock.json integrity mismatch');
  }
  return lock;
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.keys(item as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((out, key) => {
          out[key] = sort((item as Record<string, unknown>)[key]);
          return out;
        }, {});
    }
    return item;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

/**
 * Post-install integrity check: managed companion files recorded in the
 * lockfile must still match their hashes. (Managed SKILL.md region drift is
 * handled by the CLI via backup-and-splice; companions are always overwritten.)
 */
function detectDrift(workspaceDir: string): string[] {
  const lockPath = path.join(workspaceDir, 'apex-skills.lock.json');
  if (!fs.existsSync(lockPath)) return ['apex-skills.lock.json (missing)'];
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    const drifted: string[] = [];
    for (const info of Object.values(lock.skills ?? {}) as Array<{ managedFiles?: Record<string, string>; vendored?: Record<string, string> }>) {
      const files = info?.managedFiles ?? info?.vendored ?? {};
      for (const [rel, expected] of Object.entries(files)) {
        const normalized = rel.replace(/\\/g, '/');
        if (
          normalized.includes('../') ||
          !normalized.startsWith('.cursor/skills/')
        ) {
          drifted.push(`${rel} (invalid path)`);
          continue;
        }
        const abs = path.join(workspaceDir, ...rel.split('/'));
        if (!fs.existsSync(abs)) {
          drifted.push(`${rel} (missing)`);
          continue;
        }
        const actual = createHash('sha256')
          .update(fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n'))
          .digest('hex');
        if (actual !== expected) drifted.push(rel);
      }
    }
    // Legacy top-level files map (pre-v1)
    for (const [rel, expected] of Object.entries(lock.files ?? {})) {
      const normalized = String(rel).replace(/\\/g, '/');
      if (normalized.includes('../')) {
        drifted.push(`${String(rel)} (invalid path)`);
        continue;
      }
      const abs = path.join(workspaceDir, ...String(rel).split('/'));
      if (!fs.existsSync(abs)) {
        drifted.push(`${String(rel)} (missing)`);
        continue;
      }
      const actual = createHash('sha256')
        .update(fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n'))
        .digest('hex');
      if (actual !== expected) drifted.push(String(rel));
    }
    return drifted;
  } catch {
    return ['apex-skills.lock.json (invalid)'];
  }
}

/** Build a structured PR description from release notes and CLI output. */
function buildPrDescription(
  release: FoundationSkillRelease,
  cliOutput: string,
  intent: 'update' | 'rollback' = 'update',
  fromVersion?: string | null,
): string {
  const sections: string[] = [];

  if (intent === 'rollback') {
    sections.push(`## APEX Foundation Skills — Rollback to v${release.version}`);
    sections.push(
      `This PR was opened automatically by APEX to **roll back** foundation skills` +
      (fromVersion ? ` from v${fromVersion}` : '') +
      ` to v${release.version}.\n\n` +
      `It refreshes the **fenced managed region** inside \`.cursor/skills/<skill>/SKILL.md\`, ` +
      `overwrites managed companion files, and refreshes \`apex-skills.lock.json\`.\n` +
      `Project notes below the \`<!-- APEX:END managed -->\` fence are **preserved**.`,
    );
  } else {
    sections.push(`## APEX Foundation Skills — Update to v${release.version}`);
    sections.push(
      `This PR was opened automatically by APEX. It updates the **fenced managed region** ` +
      `inside \`.cursor/skills/<skill>/SKILL.md\`, overwrites managed companion files, ` +
      `and refreshes \`apex-skills.lock.json\`.\n` +
      `Project notes below the \`<!-- APEX:END managed -->\` fence are **preserved**.`,
    );
  }

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
    `- [ ] Review the managed region diff inside \`.cursor/skills/**/SKILL.md\`\n` +
    `- [ ] Confirm project notes below \`<!-- APEX:END managed -->\` are unchanged\n` +
    `- [ ] Run \`npx @apex/skills check\` locally to confirm clean state`,
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
    intent = 'update',
    fromVersion = null,
    apexProject,
    apexUrl,
  } = opts;
  const errors: string[] = [];

  // Resolve the release to install
  let release: FoundationSkillRelease | null = null;
  try {
    release = opts.releaseId
      ? await getRelease(opts.releaseId)
      : await getLatestPublishedRelease(apexProject);
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
  if (!isReleaseVisibleToProject(release, apexProject)) {
    errors.push(`Release ${release.version} is not targeted at Apex project "${apexProject}" — update the release targeting or use a different release`);
    return { status: 'error', prUrl: null, branchName: null, changedFiles: [], report: errors.join('\n'), releaseVersion: release.version, errors };
  }

  const version        = release.version;
  let skills: string[];
  try {
    skills = resolveReleasedSkillsForProject(release, apexProject);
  } catch (error) {
    errors.push((error as Error).message);
    return { status: 'error', prUrl: null, branchName: null, changedFiles: [], report: errors.join('\n'), releaseVersion: release.version, errors };
  }
  const defaultBranch  = opts.defaultBranch ?? 'main';
  const branchName     = intent === 'rollback'
    ? `chore/apex-skills-rollback-${version.replace(/\./g, '-')}-${randomBytes(3).toString('hex')}`
    : `chore/apex-skills-${version.replace(/\./g, '-')}-${randomBytes(3).toString('hex')}`;
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
    let managedSkills = [...skills];
    let reconciliationVersion: string | null = null;
    try {
      const reconciliation = reconcileRollbackWorkspace(
        workspaceDir,
        skills,
        version,
        intent,
        intent === 'rollback' ? fromVersion : null,
        intent === 'rollback',
      );
      managedSkills = reconciliation.managedSkills;
      reconciliationVersion =
        reconciliation.removedSkills.length > 0 ? version : null;
      cliOutput = await runCliInstall(workspaceDir, skills, release, apexUrl);
      validateInstalledLock(workspaceDir, release, skills);
      console.log(`[foundationSkillRepoUpdateService] CLI install complete`);
    } catch (e: unknown) {
      errors.push((e as Error).message);
      return { status: 'error', prUrl: null, branchName, changedFiles: [], report: errors.join('\n'), releaseVersion: version, errors };
    }

    // 4a. Check for drift in existing managed files
    const drifted = detectDrift(workspaceDir);
    if (drifted.length > 0) {
      errors.push(`Managed file integrity check failed after install: ${drifted.join(', ')}`);
      errors.push('Re-run install locally, or restore drifted companion files under .cursor/skills/.');
      return { status: 'drift', prUrl: null, branchName, changedFiles: drifted, report: errors.join('\n'), releaseVersion: version, errors };
    }

    // 4b. Check for actual changes
    const changed = await changedFiles(workspaceDir);
    try {
      validateGeneratedDiff(
        changed,
        managedSkills,
        reconciliationVersion,
      );
    } catch (error) {
      errors.push((error as Error).message);
      return { status: 'error', prUrl: null, branchName, changedFiles: changed, report: errors.join('\n'), releaseVersion: version, errors };
    }
    if (changed.length === 0) {
      console.log(`[foundationSkillRepoUpdateService] No changes — repo already at v${version}`);
      return { status: 'no_changes', prUrl: null, branchName, changedFiles: [], report: `Already up to date with v${version}`, releaseVersion: version, errors };
    }

    // 5. Commit and push
    const commitMsg = intent === 'rollback'
      ? (
        `chore(apex-skills): rollback foundation skills to v${version}\n\n` +
        `Rollback via APEX foundation skills distribution` +
        (fromVersion ? ` from v${fromVersion}` : '') + `.\n` +
        `Selected skills: ${skills.join(', ') || '(all)'}\n` +
        `Only the fenced managed region in .cursor/skills/ and apex-skills.lock.json are changed; project notes below the fence are preserved.`
      )
      : (
        `chore(apex-skills): update foundation skills to v${version}\n\n` +
        `Installed via APEX foundation skills distribution.\n` +
        `Selected skills: ${skills.join(', ') || '(all)'}\n` +
        (release.breakingChanges ? `\nBreaking changes: ${release.breakingChanges.slice(0, 200)}` : '')
      );

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
    const prTitle = intent === 'rollback'
      ? `chore: rollback APEX foundation skills to v${version}`
      : `chore: update APEX foundation skills to v${version}`;
    const prBody  = buildPrDescription(release, cliOutput, intent, fromVersion);

    if (provider === 'github') {
      prUrl = await githubCatalog.createPullRequest({
        org: project,
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
      errors.push('Branch pushed but PR could not be opened — ADO service not available');
      return {
        status: 'error',
        prUrl: null,
        branchName,
        changedFiles: changed,
        report: errors.join('\n'),
        releaseVersion: version,
        errors,
      };
    }

    if (!prUrl) {
      errors.push('Pull request provider returned no PR URL');
      return {
        status: 'error',
        prUrl: null,
        branchName,
        changedFiles: changed,
        report: errors.join('\n'),
        releaseVersion: version,
        errors,
      };
    }
    console.log(`[foundationSkillRepoUpdateService] Done: ${prUrl ?? '(no PR)'}`);
    return {
      status: 'pr_created',
      prUrl,
      branchName,
      changedFiles: changed,
      report: intent === 'rollback'
        ? `Foundation skills rolled back to v${version}. PR: ${prUrl ?? 'pending'}`
        : `Foundation skills updated to v${version}. PR: ${prUrl ?? 'pending'}`,
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

/**
 * Roll a consumer repo back to a lower published release.
 *
 * Safety rules:
 *   - Target release must be published and visible to the Apex project
 *   - Target version must be strictly lower than the installed version
 *   - Only managed foundation files + lockfile are rewritten (via CLI install)
 *   - Drift / incompatible states abort with no PR (same gates as update)
 *   - Opens a PR; never merges to the default branch
 */
export async function rollbackRepoWithFoundationSkills(
  opts: RollbackRepoOptions,
  adoService?: AzureDevOpsService | null,
): Promise<RollbackFoundationSkillRepoResult> {
  const provider = opts.provider ?? 'ado';
  const branch   = opts.defaultBranch ?? 'main';
  const errors: string[] = [];

  const target = await getRelease(opts.releaseId);
  if (!target) {
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: `Release not found: ${opts.releaseId}`,
      fromVersion: opts.fromVersion ?? null, toVersion: null, errors: [`Release not found: ${opts.releaseId}`],
    };
  }
  if (target.status !== 'published') {
    const msg = `Rollback target v${target.version} is not published (status: ${target.status})`;
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: msg, fromVersion: opts.fromVersion ?? null, toVersion: target.version, errors: [msg],
    };
  }
  if (!isReleaseVisibleToProject(target, opts.apexProject)) {
    const msg = `Release v${target.version} is not targeted at Apex project "${opts.apexProject}"`;
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: msg, fromVersion: opts.fromVersion ?? null, toVersion: target.version, errors: [msg],
    };
  }

  // Resolve current installed version from status when not provided
  let fromVersion = opts.fromVersion ?? null;
  if (!fromVersion) {
    const status = await getRepoStatus(provider, opts.project, opts.repo, branch);
    fromVersion = status?.installedVersion ?? null;
  }
  if (!fromVersion) {
    const msg = 'Cannot rollback — installed version unknown. Run Refresh all / Check first.';
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: msg, fromVersion: null, toVersion: target.version, errors: [msg],
    };
  }
  if (!semverGreaterThan(fromVersion, target.version)) {
    const msg = `Rollback target v${target.version} is not older than installed v${fromVersion}`;
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: msg, fromVersion, toVersion: target.version, errors: [msg],
    };
  }

  // Confirm the target is still a valid rollback candidate for this project
  const candidates = await listRollbackTargets(opts.apexProject, fromVersion);
  if (!candidates.some((c) => c.id === target.id)) {
    const msg = `v${target.version} is not a valid rollback target for ${opts.apexProject} from v${fromVersion}`;
    return {
      status: 'error', prUrl: null, branchName: null, changedFiles: [],
      report: msg, fromVersion, toVersion: target.version, errors: [msg],
    };
  }

  const result = await updateRepoWithFoundationSkills(
    {
      project: opts.project,
      repo: opts.repo,
      provider,
      defaultBranch: branch,
      releaseId: target.id,
      apexProject: opts.apexProject,
      apexUrl: opts.apexUrl,
      intent: 'rollback',
      fromVersion,
      actor: opts.actor,
    },
    adoService,
  );

  // Audit against the target release (best-effort — never fail the rollback on audit)
  try {
    await appendAudit(
      target.id,
      target.version,
      'rollback',
      { id: opts.actor?.id ?? null, email: opts.actor?.email ?? null },
      {
        fromVersion,
        toVersion: target.version,
        project: opts.project,
        repo: opts.repo,
        apexProject: opts.apexProject,
        status: result.status,
        prUrl: result.prUrl,
      },
    );
  } catch (e: unknown) {
    console.warn(`[foundationSkillRepoUpdateService] Rollback audit failed: ${(e as Error).message}`);
  }

  return {
    status: result.status,
    prUrl: result.prUrl,
    branchName: result.branchName,
    changedFiles: result.changedFiles,
    report: result.report,
    fromVersion,
    toVersion: target.version,
    errors: [...errors, ...result.errors],
  };
}
