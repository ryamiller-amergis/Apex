import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { git, safeArgs } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';
import {
  withRepoCacheLease,
  type RepoCacheLeaseContext,
} from './repoCacheLeaseService';
import {
  CACHE_FETCH_IDLE_TIMEOUT_MS,
  CACHE_FETCH_TIMEOUT_MS,
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
} from './repoGitSettings';

export { COLD_CACHE_TIMEOUT_MS } from './repoGitSettings';

const REPO_CACHE_BASE = path.join(resolveDataRoot(), 'repo-cache');
const inFlightRefreshes = new Map<string, Promise<RepoCacheResult>>();

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
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'repo';
}

function cacheIdentity(options: RepoCacheOptions): string {
  return [
    options.provider,
    options.project,
    options.repo,
    options.branch,
  ].join('\0');
}

export function getRepoCacheDir(options: RepoCacheOptions): string {
  const readable = [
    options.provider,
    safeSlug(options.project),
    safeSlug(options.repo),
    safeSlug(options.branch),
  ].join('-');
  const hash = crypto.createHash('sha256').update(cacheIdentity(options)).digest('hex').slice(0, 12);
  return path.join(REPO_CACHE_BASE, `${readable}-${hash}.git`);
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
    const org = process.env.GITHUB_ORG || '';
    const secret = process.env.GITHUB_TOKEN
      || process.env.GITHUB_PAT
      || process.env.GH_SKILL_TOKEN
      || '';
    if (!org) throw new Error('GITHUB_ORG must be set for GitHub repo checkout');
    if (!secret) {
      throw new Error('GITHUB_TOKEN, GITHUB_PAT, or GH_SKILL_TOKEN must be set for GitHub repo checkout');
    }
    return {
      url: `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}.git`,
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

async function verifyBaseCommit(
  cacheDir: string,
  branch: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const baseSha = await readBaseSha(cacheDir, branch, abortSignal);
  await git(
    safeArgs(cacheDir, ['fsck', '--connectivity-only', baseSha]),
    { cwd: cacheDir, abortSignal },
  );
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
      '--single-branch',
      '--branch',
      options.branch,
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
      `+refs/heads/${options.branch}:refs/heads/${options.branch}`,
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

async function refreshUnderLease(
  options: RepoCacheOptions,
  lease: RepoCacheLeaseContext,
): Promise<RepoCacheResult> {
  const { signal: abortSignal, assertOwned } = lease;
  const cacheDir = getRepoCacheDir(options);
  const remote = resolveGitRemote(options.provider, options.project, options.repo);
  const startedAt = Date.now();
  let stale = false;

  if (!cacheExists(cacheDir)) {
    if (fs.existsSync(cacheDir)) {
      throw new Error(
        `Repository cache is incomplete and was preserved because active workspaces may reference it: ${cacheDir}`,
      );
    }
    await populateColdCacheWithRetry(cacheDir, options, remote, abortSignal, assertOwned);
  } else {
    try {
      await refreshWarmCache(cacheDir, options, remote, abortSignal);
    } catch (refreshError) {
      if (abortSignal.aborted) throw refreshError;
      if (!isTransientGitError(refreshError)) throw refreshError;
      try {
        await verifyBaseCommit(cacheDir, options.branch, abortSignal);
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
  }

  const baseSha = await verifyBaseCommit(cacheDir, options.branch, abortSignal);
  console.log(
    `[repo-cache] ${stale ? 'verified stale' : 'ready'} ${options.provider}/${options.repo}@${options.branch} ` +
    `sha=${baseSha.slice(0, 12)} durationMs=${Date.now() - startedAt}`,
  );
  return { cacheDir, baseSha, stale, remote };
}

export function ensureRepoCache(options: RepoCacheOptions): Promise<RepoCacheResult> {
  const key = cacheIdentity(options);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refresh = withRepoCacheLease(
    `repo-cache:${crypto.createHash('sha256').update(key).digest('hex')}`,
    (lease) => refreshUnderLease(options, lease),
  ).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, refresh);
  return refresh;
}
