import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git } from '../../utils/asyncGit';
import { credentialsForCloneUrl } from './cloneCredentials';

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

export async function cloneTemporaryAtSha(input: {
  url: string;
  sha: string;
  destination: string;
  signal: AbortSignal;
}): Promise<'ok' | 'moved'> {
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
}): Promise<void> {
  if (input.signal.aborted) throw new Error('The copy was cancelled.');
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  await clearReadOnlyTopLevel(input.destination);
  await fs.rm(input.destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  const hasWorkingTreeGit = await fs.stat(path.join(input.cacheDir, '.git')).then(() => true, () => false);
  const isBareRepo = !hasWorkingTreeGit && await fs.stat(path.join(input.cacheDir, 'HEAD')).then(() => true, () => false);
  try {
    if (isBareRepo) {
      await git(['clone', '--local', '--no-checkout', '--', input.cacheDir, input.destination], { abortSignal: input.signal });
      await git(['-C', input.destination, 'checkout', '--detach', input.sha], { abortSignal: input.signal });
    } else {
      const mirrorHead = (await git(['-C', input.cacheDir, 'rev-parse', 'HEAD'], { abortSignal: input.signal })).trim().toLowerCase();
      if (mirrorHead !== input.sha.toLowerCase()) {
        throw new Error('The saved clone changed. Attach the repository again.');
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
  if (stat?.isSymbolicLink()) return;
  await git(['-C', destination, 'remote', 'remove', 'origin']).catch(() => {});
  const entries = await fs.readdir(destination, { withFileTypes: true });
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
