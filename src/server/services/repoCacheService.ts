import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding } from '../../shared/types/runGrounding';
import { git, safeArgs } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';
import {
  USER_FACING_REPO_CACHE_LEASE_WAIT_MS,
  withRepoCacheLease,
  type RepoCacheLeaseContext,
  type RepoCacheLeaseOptions,
} from './repoCacheLeaseService';
import {
  CACHE_FETCH_IDLE_TIMEOUT_MS,
  CACHE_FETCH_TIMEOUT_MS,
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
} from './repoGitSettings';

export { COLD_CACHE_TIMEOUT_MS } from './repoGitSettings';
export { USER_FACING_REPO_CACHE_LEASE_WAIT_MS } from './repoCacheLeaseService';

const REPO_CACHE_BASE = path.join(resolveDataRoot(), 'repo-cache');
const inFlightRefreshes = new Map<string, Promise<RepoCacheResult>>();
const inFlightPinFetches = new Map<string, Promise<boolean>>();

export interface RepoCacheOptions {
  provider: SkillProvider;
  project: string;
  repo: string;
  branch: string;
}

export interface GitRemote {
  url: string;
  env: Record<string, string>;
  secret: string;
}

export interface RepoCacheResult {
  cacheDir: string;
  baseSha: string;
  stale: boolean;
  remote: GitRemote;
  /** True when a complete shared mirror existed before this ensure attempt. */
  mirrorHit?: boolean;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'repo';
}

const ALL_HEADS_REFSPEC = '+refs/heads/*:refs/heads/*';

function cacheIdentity(options: RepoCacheOptions): string {
  return [options.provider, options.project, options.repo].join('\0');
}

function legacyCacheIdentity(options: RepoCacheOptions): string {
  return [
    options.provider,
    options.project,
    options.repo,
    options.branch,
  ].join('\0');
}

function cacheDirForIdentity(
  identity: string,
  options: RepoCacheOptions,
  includeBranch: boolean,
): string {
  const readable = [
    options.provider,
    safeSlug(options.project),
    safeSlug(options.repo),
    ...(includeBranch ? [safeSlug(options.branch)] : []),
  ].join('-');
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return path.join(REPO_CACHE_BASE, `${readable}-${hash}.git`);
}

export function getRepoCacheLeaseKey(options: RepoCacheOptions): string {
  return `repo-cache:${crypto
    .createHash('sha256')
    .update(cacheIdentity(options))
    .digest('hex')}`;
}

export function getRepoCacheDir(options: RepoCacheOptions): string {
  const canonical = cacheDirForIdentity(cacheIdentity(options), options, false);
  if (cacheExists(canonical)) return canonical;
  const legacy = cacheDirForIdentity(legacyCacheIdentity(options), options, true);
  if (cacheExists(legacy)) return legacy;
  return canonical;
}

function authEnvironment(username: string, secret: string): Record<string, string> {
  const encoded = Buffer.from(`${username}:${secret}`, 'utf-8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
  };
}

export function resolveGitRemote(
  provider: SkillProvider,
  project: string,
  repo: string,
): GitRemote {
  if (provider === 'github') {
    const slash = repo.indexOf('/');
    const configuredOrg = process.env.GITHUB_ORG?.trim() || '';
    const org = slash > 0 ? repo.slice(0, slash).trim() : configuredOrg;
    const repository = slash > 0 ? repo.slice(slash + 1).trim() : repo.trim();
    const secret = process.env.GITHUB_TOKEN
      || process.env.GITHUB_PAT
      || process.env.GH_SKILL_TOKEN
      || '';
    if (!org) {
      throw new Error(
        'GitHub organization is required for repo checkout (set GITHUB_ORG or configure owner/repo)',
      );
    }
    if (!repository) throw new Error('GitHub repository is required for repo checkout');
    if (!secret) {
      throw new Error('GITHUB_TOKEN, GITHUB_PAT, or GH_SKILL_TOKEN must be set for GitHub repo checkout');
    }
    return {
      url: `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repository)}.git`,
      env: authEnvironment('x-access-token', secret),
      secret,
    };
  }

  const orgUrl = (process.env.ADO_ORG || '').replace(/\/+$/, '');
  const secret = process.env.ADO_PAT || '';
  if (!orgUrl || !secret) {
    throw new Error('ADO_ORG and ADO_PAT must be set for repo checkout');
  }
  return {
    url: `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`,
    env: authEnvironment('pat', secret),
    secret,
  };
}

function cacheExists(cacheDir: string): boolean {
  return fs.existsSync(path.join(cacheDir, 'HEAD'));
}

async function readBaseSha(
  cacheDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  return (await git(
    safeArgs(cacheDir, ['rev-parse', `refs/heads/${branch}`]),
    { cwd: cacheDir, abortSignal },
  )).trim();
}

/**
 * Reads the branch tip already present in the local bare cache. This function
 * intentionally never resolves credentials, fetches, or repairs the cache.
 */
export async function readCachedOriginSha(
  grounding: Pick<
    RunGrounding,
    'provider' | 'project' | 'repository' | 'branch'
  >,
): Promise<string | null> {
  const options: RepoCacheOptions = {
    provider: grounding.provider === 'azure_devops' ? 'ado' : 'github',
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
  };
  const cacheDir = getRepoCacheDir(options);
  if (!cacheExists(cacheDir)) return null;

  try {
    return await readBaseSha(cacheDir, grounding.branch);
  } catch {
    return null;
  }
}

const LS_REMOTE_TIMEOUT_MS = 15_000;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * One round-trip tip probe. Does not transfer objects. Returns null when the
 * remote has no such head or the response is unusable.
 */
export async function readRemoteBranchTip(
  options: RepoCacheOptions,
): Promise<string | null> {
  const remote = resolveGitRemote(options.provider, options.project, options.repo);
  const cacheDir = getRepoCacheDir(options);
  const workDir = cacheExists(cacheDir) ? cacheDir : os.tmpdir();
  const ref = `refs/heads/${options.branch}`;
  const output = await git(
    safeArgs(workDir, ['ls-remote', '--heads', remote.url, ref]),
    {
      cwd: workDir,
      timeout: LS_REMOTE_TIMEOUT_MS,
      env: remote.env,
    },
  );
  const line = output.split(/\r?\n/).find((row) => row.includes(`\t${ref}`));
  const sha = line?.split('\t', 1)[0]?.trim() ?? '';
  return COMMIT_SHA_RE.test(sha) ? sha.toLowerCase() : null;
}

/** Returns whether the exact pinned commit is present in the local bare cache. */
export async function hasCachedCommit(
  grounding: Pick<
    RunGrounding,
    'provider' | 'project' | 'repository' | 'branch' | 'groundedSha'
  >,
): Promise<boolean> {
  const options: RepoCacheOptions = {
    provider: grounding.provider === 'azure_devops' ? 'ado' : 'github',
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
  };
  const cacheDir = getRepoCacheDir(options);
  if (!cacheExists(cacheDir)) return false;

  try {
    await git(
      safeArgs(cacheDir, ['cat-file', '-e', `${grounding.groundedSha}^{commit}`]),
      { cwd: cacheDir },
    );
    return true;
  } catch {
    return false;
  }
}

async function verifyBaseCommitLightweight(
  cacheDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const baseSha = await readBaseSha(cacheDir, branch, abortSignal);
  await git(
    safeArgs(cacheDir, ['cat-file', '-e', `${baseSha}^{commit}`]),
    { cwd: cacheDir, abortSignal },
  );
  return baseSha;
}

async function verifyCacheConnectivity(
  cacheDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const baseSha = await readBaseSha(cacheDir, branch, abortSignal);
  await git(
    safeArgs(cacheDir, ['fsck', '--full', '--no-dangling', '--progress', baseSha]),
    {
      cwd: cacheDir,
      timeout: COLD_CACHE_TIMEOUT_MS,
      idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
      abortSignal,
    },
  );
  return baseSha;
}

function repairMarkerPath(cacheDir: string): string {
  return path.join(cacheDir, 'apex-repair-complete');
}

function refreshMarkerPath(cacheDir: string): string {
  return path.join(cacheDir, 'apex-refresh-complete');
}

function writeRefreshMarker(cacheDir: string): void {
  fs.writeFileSync(refreshMarkerPath(cacheDir), `${Date.now()}\n`, 'utf-8');
}

export function wasRepoCacheRefreshedSince(
  options: RepoCacheOptions,
  sinceMs: number,
): boolean {
  try {
    return fs.statSync(refreshMarkerPath(getRepoCacheDir(options))).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function writeRepairMarker(cacheDir: string, baseSha: string): void {
  fs.writeFileSync(
    repairMarkerPath(cacheDir),
    `${uuidv4()}:${baseSha}\n`,
    'utf-8',
  );
}

function readRepairMarker(cacheDir: string): string | null {
  try {
    return fs.readFileSync(repairMarkerPath(cacheDir), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function refetchAndVerifyCache(
  cacheDir: string,
  options: RepoCacheOptions,
  remote: GitRemote,
  abortSignal: AbortSignal,
  assertOwned: () => Promise<void>,
): Promise<string> {
  await git(
    safeArgs(cacheDir, [
      'fetch',
      '--refetch',
      '--prune',
      'origin',
      ALL_HEADS_REFSPEC,
    ]),
    {
      cwd: cacheDir,
      timeout: COLD_CACHE_TIMEOUT_MS,
      idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
      abortSignal,
      env: remote.env,
    },
  );
  await assertOwned();
  const baseSha = await verifyCacheConnectivity(cacheDir, options.branch, abortSignal);
  writeRepairMarker(cacheDir, baseSha);
  return baseSha;
}

function isTransientGitError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    'timed out',
    'made no progress',
    'network unavailable',
    'temporarily unavailable',
    'could not resolve host',
    'couldn\'t connect',
    'connection reset',
    'connection timed out',
    'http 502',
    'http 503',
    'http 504',
  ].some((fragment) => message.includes(fragment));
}

async function populateColdCache(
  cacheDir: string,
  options: RepoCacheOptions,
  remote: GitRemote,
  abortSignal: AbortSignal,
  assertLeaseOwned: () => Promise<void>,
): Promise<void> {
  const tempDir = `${cacheDir}.tmp-${uuidv4()}`;
  fs.mkdirSync(REPO_CACHE_BASE, { recursive: true });

  try {
    await git([
      'clone',
      '--bare',
      '--progress',
      remote.url,
      tempDir,
    ], {
      cwd: REPO_CACHE_BASE,
      timeout: COLD_CACHE_TIMEOUT_MS,
      idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
      abortSignal,
      env: remote.env,
    });
    await git(safeArgs(tempDir, ['config', 'gc.auto', '0']), { cwd: tempDir, abortSignal });
    await git(safeArgs(tempDir, ['config', 'maintenance.auto', 'false']), { cwd: tempDir, abortSignal });
    await git(
      safeArgs(tempDir, ['remote', 'set-url', 'origin', remote.url]),
      { cwd: tempDir, abortSignal },
    );
    const baseSha = await verifyCacheConnectivity(tempDir, options.branch, abortSignal);
    writeRepairMarker(tempDir, baseSha);
    await assertLeaseOwned();
    abortSignal.throwIfAborted();
    fs.renameSync(tempDir, cacheDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

async function populateColdCacheWithRetry(
  cacheDir: string,
  options: RepoCacheOptions,
  remote: GitRemote,
  abortSignal: AbortSignal,
  assertLeaseOwned: () => Promise<void>,
): Promise<void> {
  try {
    await populateColdCache(cacheDir, options, remote, abortSignal, assertLeaseOwned);
  } catch (firstError) {
    if (abortSignal.aborted) throw firstError;
    console.warn(
      `[repo-cache] cold initialization failed; retrying ${options.provider}/${options.repo}@${options.branch}:`,
      (firstError as Error).message,
    );
    await populateColdCache(cacheDir, options, remote, abortSignal, assertLeaseOwned);
  }
}

async function refreshWarmCache(
  cacheDir: string,
  options: RepoCacheOptions,
  remote: GitRemote,
  abortSignal: AbortSignal,
): Promise<void> {
  await git(
    safeArgs(cacheDir, [
      'fetch',
      '--prune',
      'origin',
      ALL_HEADS_REFSPEC,
    ]),
    {
      cwd: cacheDir,
      timeout: CACHE_FETCH_TIMEOUT_MS,
      idleTimeout: CACHE_FETCH_IDLE_TIMEOUT_MS,
      abortSignal,
      env: remote.env,
    },
  );
}

async function refreshWarmMirrorUnderLease(
  options: RepoCacheOptions,
  lease: RepoCacheLeaseContext,
): Promise<RepoCacheResult> {
  const { signal: abortSignal, assertOwned } = lease;
  const cacheDir = getRepoCacheDir(options);
  const remote = resolveGitRemote(options.provider, options.project, options.repo);
  const startedAt = Date.now();
  let stale = false;
  let baseSha: string;
  const repoLabel = `${options.provider}/${options.repo}@${options.branch}`;

  console.log(`[repo-cache] phase=incremental-fetch-start repo=${repoLabel}`);
  try {
    await refreshWarmCache(cacheDir, options, remote, abortSignal);
    console.log(`[repo-cache] phase=incremental-fetch-complete repo=${repoLabel}`);
    try {
      baseSha = await verifyBaseCommitLightweight(cacheDir, options.branch, abortSignal);
    } catch (verificationError) {
      if (abortSignal.aborted) throw verificationError;
      console.warn(`[repo-cache] phase=warm-repair-start repo=${repoLabel}`);
      baseSha = await refetchAndVerifyCache(
        cacheDir,
        options,
        remote,
        abortSignal,
        assertOwned,
      );
      console.log(`[repo-cache] phase=warm-repair-complete repo=${repoLabel}`);
    }
    console.log(`[repo-cache] phase=warm-commit-verified repo=${repoLabel}`);
  } catch (refreshError) {
    const message =
      refreshError instanceof Error ? refreshError.message : String(refreshError);
    console.warn(
      `[repo-cache] phase=incremental-fetch-failed repo=${repoLabel} ` +
        `aborted=${abortSignal.aborted} durationMs=${Date.now() - startedAt}: ` +
        message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300),
    );
    if (abortSignal.aborted) throw refreshError;
    if (!isTransientGitError(refreshError)) throw refreshError;
    try {
      baseSha = await verifyCacheConnectivity(cacheDir, options.branch, abortSignal);
      stale = true;
      console.warn(
        `[repo-cache] refresh unavailable; using verified cached ${options.provider}/${options.repo}@${options.branch}:`,
        (refreshError as Error).message,
      );
    } catch (verificationError) {
      if (abortSignal.aborted) throw verificationError;
      throw verificationError;
    }
  }

  await assertOwned();
  abortSignal.throwIfAborted();
  writeRefreshMarker(cacheDir);
  console.log(
    `[repo-cache] ${stale ? 'verified stale' : 'ready'} ${options.provider}/${options.repo}@${options.branch} ` +
    `sha=${baseSha.slice(0, 12)} durationMs=${Date.now() - startedAt}`,
  );
  return { cacheDir, baseSha, stale, remote, mirrorHit: true };
}

export async function refreshRepoCacheUnderLease(
  options: RepoCacheOptions,
  lease: RepoCacheLeaseContext,
): Promise<RepoCacheResult> {
  const { signal: abortSignal, assertOwned } = lease;
  const cacheDir = getRepoCacheDir(options);
  const remote = resolveGitRemote(options.provider, options.project, options.repo);
  const startedAt = Date.now();
  const repoLabel = `${options.provider}/${options.repo}@${options.branch}`;
  const mirrorHit = cacheExists(cacheDir);

  if (!mirrorHit) {
    if (fs.existsSync(cacheDir)) {
      throw new Error(
        'Repository cache is incomplete and was preserved because active workspaces may reference it',
      );
    }
    console.log(`[repo-cache] phase=cold-clone-start repo=${repoLabel}`);
    await populateColdCacheWithRetry(cacheDir, options, remote, abortSignal, assertOwned);
    console.log(`[repo-cache] phase=cold-clone-complete repo=${repoLabel}`);
    const baseSha = await verifyBaseCommitLightweight(cacheDir, options.branch, abortSignal);
    console.log(`[repo-cache] phase=cold-connectivity-verified repo=${repoLabel}`);
    await assertOwned();
    abortSignal.throwIfAborted();
    writeRefreshMarker(cacheDir);
    console.log(
      `[repo-cache] ready ${options.provider}/${options.repo}@${options.branch} ` +
      `sha=${baseSha.slice(0, 12)} durationMs=${Date.now() - startedAt}`,
    );
    return { cacheDir, baseSha, stale: false, remote, mirrorHit };
  }

  return refreshWarmMirrorUnderLease(options, lease);
}

/**
 * Admin-only cold clone (or refresh) entry point. May create a missing bare mirror.
 * Must never be called from user chat/generation paths.
 */
export function cloneRepositoryForAdmin(
  options: RepoCacheOptions,
): Promise<RepoCacheResult> {
  return ensureRepoCache(options);
}

/**
 * Incremental tip fetch against an existing valid mirror. Never cold-clones.
 * Throws when the mirror is missing — callers must require admin Clone first.
 */
export async function fetchRepositoryTip(
  options: RepoCacheOptions,
): Promise<RepoCacheResult> {
  const cacheDir = getRepoCacheDir(options);
  if (!cacheExists(cacheDir)) {
    return Promise.reject(
      new Error(
        'Repository mirror is not cloned; a project administrator must Clone the configured repository before fetch',
      ),
    );
  }

  const key = `fetch:${cacheIdentity(options)}`;
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = withRepoCacheLease(
    getRepoCacheLeaseKey(options),
    async (lease) => {
      if (!cacheExists(getRepoCacheDir(options))) {
        throw new Error(
          'Repository mirror is not cloned; a project administrator must Clone the configured repository before fetch',
        );
      }
      return refreshWarmMirrorUnderLease(options, lease);
    },
    { waitMs: USER_FACING_REPO_CACHE_LEASE_WAIT_MS },
  ).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, refresh);
  return refresh;
}

async function commitExistsInCache(
  cacheDir: string,
  sha: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  try {
    await git(
      safeArgs(cacheDir, ['cat-file', '-e', `${sha}^{commit}`]),
      { cwd: cacheDir, abortSignal, timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one pinned commit into an existing bare mirror. Does not clone, and
 * does not fetch every branch — MaxView's all-heads incremental fetch is what
 * hung home chat. Coalesces per SHA so overlapping chats share one git fetch.
 */
export async function fetchPinnedCommit(
  options: RepoCacheOptions,
  sha: string,
): Promise<boolean> {
  const normalized = sha.trim().toLowerCase();
  if (!COMMIT_SHA_RE.test(normalized)) return false;
  const cacheDir = getRepoCacheDir(options);
  if (!cacheExists(cacheDir)) return false;
  if (await commitExistsInCache(cacheDir, normalized)) return true;

  const key = `pin:${cacheIdentity(options)}:${normalized}`;
  const existing = inFlightPinFetches.get(key);
  if (existing) return existing;

  const work = withRepoCacheLease(
    getRepoCacheLeaseKey(options),
    async ({ signal, assertOwned }) => {
      if (await commitExistsInCache(cacheDir, normalized, signal)) return true;
      const remote = resolveGitRemote(
        options.provider,
        options.project,
        options.repo,
      );
      const repoLabel = `${options.provider}/${options.repo}@${options.branch}`;
      const startedAt = Date.now();
      console.log(
        `[repo-cache] phase=pin-fetch-start repo=${repoLabel} sha=${normalized.slice(0, 12)}`,
      );
      try {
        await git(
          safeArgs(cacheDir, ['fetch', 'origin', normalized]),
          {
            cwd: cacheDir,
            timeout: CACHE_FETCH_TIMEOUT_MS,
            idleTimeout: CACHE_FETCH_IDLE_TIMEOUT_MS,
            abortSignal: signal,
            env: remote.env,
          },
        );
        await assertOwned();
        const got = await commitExistsInCache(cacheDir, normalized, signal);
        console.log(
          `[repo-cache] phase=pin-fetch-${got ? 'complete' : 'miss'} repo=${repoLabel} ` +
            `sha=${normalized.slice(0, 12)} durationMs=${Date.now() - startedAt}`,
        );
        return got;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[repo-cache] phase=pin-fetch-failed repo=${repoLabel} ` +
            `sha=${normalized.slice(0, 12)} aborted=${signal.aborted} ` +
            `durationMs=${Date.now() - startedAt}: ` +
            message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300),
        );
        throw error;
      }
    },
  ).finally(() => {
    inFlightPinFetches.delete(key);
  });

  inFlightPinFetches.set(key, work);
  return work;
}

export function ensureRepoCache(
  options: RepoCacheOptions,
  leaseOptions?: Pick<RepoCacheLeaseOptions, 'waitMs'>,
): Promise<RepoCacheResult> {
  const key = cacheIdentity(options);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = withRepoCacheLease(
    getRepoCacheLeaseKey(options),
    (lease) => refreshRepoCacheUnderLease(options, lease),
    leaseOptions,
  ).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, refresh);
  return refresh;
}

export function repairRepoCache(options: RepoCacheOptions): Promise<RepoCacheResult> {
  const cacheDirAtRequest = getRepoCacheDir(options);
  const markerAtRequest = readRepairMarker(cacheDirAtRequest);
  return withRepoCacheLease(
    getRepoCacheLeaseKey(options),
    async ({ signal, assertOwned }) => {
      const cacheDir = getRepoCacheDir(options);
      if (!cacheExists(cacheDir)) {
        throw new Error('Repository cache is unavailable for in-place repair');
      }
      const remote = resolveGitRemote(options.provider, options.project, options.repo);
      const repoLabel = `${options.provider}/${options.repo}@${options.branch}`;
      const startedAt = Date.now();
      const currentMarker = readRepairMarker(cacheDir);
      if (currentMarker && currentMarker !== markerAtRequest) {
        const baseSha = await verifyBaseCommitLightweight(
          cacheDir,
          options.branch,
          signal,
        );
        console.log(`[repo-cache] phase=repair-coalesced repo=${repoLabel}`);
        return { cacheDir, baseSha, stale: false, remote };
      }
      console.warn(`[repo-cache] phase=repair-refetch-start repo=${repoLabel}`);
      const baseSha = await refetchAndVerifyCache(
        cacheDir,
        options,
        remote,
        signal,
        assertOwned,
      );
      console.log(
        `[repo-cache] phase=repair-complete repo=${repoLabel} ` +
        `sha=${baseSha.slice(0, 12)} durationMs=${Date.now() - startedAt}`,
      );
      return { cacheDir, baseSha, stale: false, remote };
    },
  );
}
