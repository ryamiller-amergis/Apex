import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import { git } from '../../utils/asyncGit';
import { bundleRepositoryName } from '../grounding/bundleCheckout';
import { createGroundingBundleStore } from '../grounding/bundleStoreService';
import type { PublishBundleHttpRequest, PublishBundleHttpResponse } from '../repoRead/httpProtocol';
import { resolveRepoReadServiceToken, resolveRepoReadServiceUrl } from '../repoRead/repoServiceReader';
import { credentialsForCloneUrl } from './cloneCredentials';

export interface BrainstormBundleIdentity {
  provider: 'github' | 'ado';
  project: string;
  repository: string;
}

function isCloudBundleStorageConfigured(): boolean {
  return Boolean(process.env.GROUNDING_BLOB_ACCOUNT_NAME?.trim()) && !process.env.JEST_WORKER_ID;
}

export async function hasPublishedSourceBundle(
  input: BrainstormBundleIdentity & { sha: string },
): Promise<boolean> {
  if (!isCloudBundleStorageConfigured()) return false;
  const identity: RepositoryIdentity = {
    provider: input.provider,
    project: input.project,
    repo: bundleRepositoryName(input.provider, input.repository),
    sha: input.sha.toLowerCase(),
  };
  const store = createGroundingBundleStore({
    repairAndMaterialize: async () => false,
  });
  return store.bundleExists(identity).catch(() => false);
}

export async function publishSourceBundleIfConfigured(
  input: BrainstormBundleIdentity & {
    repoDir: string;
    sha: string;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  if (!isCloudBundleStorageConfigured()) return false;
  const identity: RepositoryIdentity = {
    provider: input.provider,
    project: input.project,
    repo: bundleRepositoryName(input.provider, input.repository),
    sha: input.sha.toLowerCase(),
  };
  const store = createGroundingBundleStore({
    repairAndMaterialize: async () => false,
  });
  if (await store.bundleExists(identity).catch(() => false)) return true;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstorm-bundle-'));
  const bundlePath = path.join(scratch, 'snapshot.bundle');
  try {
    await git(['-C', input.repoDir, 'bundle', 'create', bundlePath, 'HEAD'], {
      timeout: 180_000,
      abortSignal: input.signal,
    });
    await store.uploadBundle(identity, bundlePath);
    return true;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * True when V2 hosts fetch the source from its Blob bundle or repo-read, which
 * is every clone path while Blob bundles are configured, and catalog repos
 * when only repo-read is. Readiness then comes from the source row, and App
 * Service keeps no copy on disk.
 */
export function isSourceServedRemotely(source: {
  kind: string;
  commitSha: string | null;
  groundingRepository: string | null;
}): boolean {
  if (!source.commitSha || !source.groundingRepository) return false;
  if (isCloudBundleStorageConfigured()) return true;
  return source.kind === 'project-repository'
    && Boolean(process.env.REPO_READ_SERVICE_URL?.trim())
    && !process.env.JEST_WORKER_ID;
}

async function clearRemoteSourceDestination(destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
}

const LOCK = [
  '-c', 'core.symlinks=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false',
];

function shaFromLsRemote(output: string): string | null {
  for (const line of output.split('\n')) {
    const sha = line.split('\t')[0]?.trim().toLowerCase();
    if (sha && /^[a-f0-9]{40}$/.test(sha)) return sha;
  }
  return null;
}

export async function resolveTemporarySha(input: {
  url: string;
  revision: string;
  signal: AbortSignal;
}): Promise<{ sha: string } | { error: 'UNREACHABLE' | 'REVISION_NOT_FOUND' }> {
  try {
    const creds = credentialsForCloneUrl(new URL(input.url));
    const output = await git([
      ...LOCK,
      'ls-remote', '--', input.url, input.revision, `refs/heads/${input.revision}`, `refs/tags/${input.revision}`,
    ], { timeout: 15_000, abortSignal: input.signal, env: creds.env });
    const sha = shaFromLsRemote(output);
    if (!sha) return { error: 'REVISION_NOT_FOUND' };
    return { sha };
  } catch {
    return { error: 'UNREACHABLE' };
  }
}

export interface TemporaryBundleInput {
  url: string;
  sha: string;
  identity: BrainstormBundleIdentity;
  signal?: AbortSignal;
}

/**
 * Fetches one commit of a temporary repository into scratch space and
 * publishes it as the source's Blob bundle. Repo-read runs this so App Service
 * holds no clone; App Service runs it only when repo-read is not configured.
 */
export async function publishTemporaryCloneBundle(input: TemporaryBundleInput): Promise<'ok' | 'moved'> {
  const creds = credentialsForCloneUrl(new URL(input.url));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstorm-temp-clone-'));
  const repoDir = path.join(scratch, 'repo');
  try {
    await git(['init', repoDir], { abortSignal: input.signal });
    await git([
      ...LOCK, '-C', repoDir, 'fetch', '--no-tags', '--depth=1', '--', input.url, input.sha,
    ], { timeout: 120_000, abortSignal: input.signal, env: creds.env });
    await git(['-C', repoDir, 'checkout', '--detach', 'FETCH_HEAD'], { abortSignal: input.signal });
    const head = (await git(['-C', repoDir, 'rev-parse', 'HEAD'])).trim().toLowerCase();
    if (head !== input.sha.toLowerCase()) return 'moved';
    const published = await publishSourceBundleIfConfigured({
      ...input.identity,
      repoDir,
      sha: input.sha,
      signal: input.signal,
    });
    if (!published) throw new Error('Blob bundle storage is not configured.');
    return 'ok';
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function requestRepoReadBundlePublish(
  input: TemporaryBundleInput,
  options: { baseUrl?: string; authToken?: string; fetchImpl?: typeof fetch } = {},
): Promise<'ok' | 'moved'> {
  const baseUrl = (options.baseUrl ?? resolveRepoReadServiceUrl())?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('The repository read service is not configured.');
  const authToken = options.authToken ?? resolveRepoReadServiceToken();
  const body: PublishBundleHttpRequest = {
    provider: input.identity.provider,
    project: input.identity.project,
    repository: input.identity.repository,
    url: input.url,
    sha: input.sha,
  };
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/publish-bundle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    signal: input.signal,
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as PublishBundleHttpResponse | null;
  if (!parsed) throw new Error(`The repository read service returned ${response.status}.`);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.state;
}

export async function cloneTemporaryAtSha(input: {
  url: string;
  sha: string;
  destination: string;
  signal: AbortSignal;
  identity?: BrainstormBundleIdentity;
}): Promise<'ok' | 'moved'> {
  if (input.identity && await hasPublishedSourceBundle({ ...input.identity, sha: input.sha })) {
    await clearRemoteSourceDestination(input.destination);
    return 'ok';
  }
  if (input.identity && isCloudBundleStorageConfigured()) {
    const bundleInput = { url: input.url, sha: input.sha, identity: input.identity, signal: input.signal };
    const result = resolveRepoReadServiceUrl()
      ? await requestRepoReadBundlePublish(bundleInput)
      : await publishTemporaryCloneBundle(bundleInput);
    if (result === 'moved') return 'moved';
    await clearRemoteSourceDestination(input.destination);
    return 'ok';
  }
  const creds = credentialsForCloneUrl(new URL(input.url));
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  await fs.rm(input.destination, { recursive: true, force: true });
  await git(['init', input.destination], { abortSignal: input.signal });
  await git([
    ...LOCK, '-C', input.destination, 'fetch', '--no-tags', '--depth=1', '--', input.url, input.sha,
  ], { timeout: 120_000, abortSignal: input.signal, env: creds.env });
  await git(['-C', input.destination, 'checkout', '--detach', 'FETCH_HEAD'], { abortSignal: input.signal });
  const head = (await git(['-C', input.destination, 'rev-parse', 'HEAD'])).trim().toLowerCase();
  if (head !== input.sha.toLowerCase()) return 'moved';
  await fs.writeFile(path.join(input.destination, '.apex-brainstorm-ready'), `${input.sha}\n`);
  return 'ok';
}

async function clearReadOnlyTopLevel(destination: string): Promise<void> {
  const entries = await fs.readdir(destination, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) =>
    fs.chmod(path.join(destination, entry.name), 0o666).catch(() => {})));
}

export async function cloneCachedCommit(input: {
  cacheDir: string;
  destination: string;
  sha: string;
  signal: AbortSignal;
  identity?: BrainstormBundleIdentity;
}): Promise<void> {
  if (input.signal.aborted) throw new Error('The copy was cancelled.');
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  await clearReadOnlyTopLevel(input.destination);
  await fs.rm(input.destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  if (input.identity && await hasPublishedSourceBundle({ ...input.identity, sha: input.sha })) {
    await clearRemoteSourceDestination(input.destination);
    return;
  }
  const hasWorkingTreeGit = await fs.stat(path.join(input.cacheDir, '.git')).then(() => true, () => false);
  const isBareRepo = !hasWorkingTreeGit && await fs.stat(path.join(input.cacheDir, 'HEAD')).then(() => true, () => false);
  if (!hasWorkingTreeGit && !isBareRepo && input.identity && Boolean(process.env.REPO_READ_SERVICE_URL?.trim()) && !process.env.JEST_WORKER_ID) {
    await clearRemoteSourceDestination(input.destination);
    return;
  }
  try {
    if (isBareRepo) {
      if (input.identity && isCloudBundleStorageConfigured()) {
        const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'brainstorm-bare-clone-'));
        const repoDir = path.join(scratch, 'repo');
        try {
          await git(['clone', '--local', '--no-checkout', '--', input.cacheDir, repoDir], { abortSignal: input.signal });
          await git(['-C', repoDir, 'checkout', '--detach', input.sha], { abortSignal: input.signal });
          const head = (await git(['-C', repoDir, 'rev-parse', 'HEAD'], { abortSignal: input.signal })).trim().toLowerCase();
          if (head !== input.sha.toLowerCase()) {
            throw new Error('The saved clone changed. Attach the repository again.');
          }
          await publishSourceBundleIfConfigured({
            ...input.identity,
            repoDir,
            sha: input.sha,
            signal: input.signal,
          });
          await clearRemoteSourceDestination(input.destination);
          return;
        } finally {
          await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
      }
      await git(['clone', '--local', '--no-checkout', '--', input.cacheDir, input.destination], { abortSignal: input.signal });
      await git(['-C', input.destination, 'checkout', '--detach', input.sha], { abortSignal: input.signal });
    } else {
      const mirrorHead = (await git(['-C', input.cacheDir, 'rev-parse', 'HEAD'], { abortSignal: input.signal })).trim().toLowerCase();
      if (mirrorHead !== input.sha.toLowerCase()) {
        throw new Error('The saved clone changed. Attach the repository again.');
      }
      if (input.identity && isCloudBundleStorageConfigured()) {
        await publishSourceBundleIfConfigured({
          ...input.identity,
          repoDir: input.cacheDir,
          sha: input.sha,
          signal: input.signal,
        });
        await clearRemoteSourceDestination(input.destination);
        return;
      }
      // Link a depth-1 catalog mirror on the same machine via a directory
      // junction when possible so a multi-GB restore finishes in milliseconds
      // instead of blocking turn admission for two minutes.
      let linked = false;
      if (process.platform === 'win32' && !process.env.JEST_WORKER_ID) {
        try {
          await fs.symlink(input.cacheDir, input.destination, 'junction');
          linked = true;
        } catch {
          await fs.rm(input.destination, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (!linked) {
        await fs.cp(input.cacheDir, input.destination, { recursive: true });
        await git(['-C', input.destination, 'remote', 'remove', 'origin'], { abortSignal: input.signal }).catch(() => {});
        await fs.writeFile(path.join(input.destination, '.apex-brainstorm-ready'), `${input.sha}\n`);
      }
      return;
    }
  } catch (err) {
    await clearReadOnlyTopLevel(input.destination);
    await fs.rm(input.destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('The saved clone is missing. An administrator can clone the repository again.');
    }
    throw err;
  }
  if (input.signal.aborted) {
    await fs.rm(input.destination, { recursive: true, force: true });
    throw new Error('The copy was cancelled.');
  }
  const head = (await git(['-C', input.destination, 'rev-parse', 'HEAD'], { abortSignal: input.signal })).trim().toLowerCase();
  if (head !== input.sha.toLowerCase()) {
    await fs.rm(input.destination, { recursive: true, force: true });
    throw new Error('The saved clone changed. Attach the repository again.');
  }
  await git(['-C', input.destination, 'remote', 'remove', 'origin'], { abortSignal: input.signal }).catch(() => {});
  await fs.writeFile(path.join(input.destination, '.apex-brainstorm-ready'), `${input.sha}\n`);
}

export async function lockDownClone(destination: string): Promise<void> {
  const stat = await fs.lstat(destination).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  const hasGit = await fs.stat(path.join(destination, '.git')).then(() => true, () => false);
  if (hasGit) {
    await git(['-C', destination, 'remote', 'remove', 'origin']).catch(() => {});
  }
  const entries = await fs.readdir(destination, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) =>
    fs.chmod(path.join(destination, entry.name), 0o444).catch(() => {})));
}

export async function measureDirectory(dir: string): Promise<number> {
  let total = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(next);
      else {
        const stat = await fs.lstat(next).catch(() => null);
        if (stat && !stat.isSymbolicLink()) total += stat.size;
      }
    }
  }
  await walk(dir);
  return total;
}
