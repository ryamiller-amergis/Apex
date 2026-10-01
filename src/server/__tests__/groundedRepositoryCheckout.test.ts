import { execFileSync } from 'child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ContainerClient } from '@azure/storage-blob';
import {
  bundleIdentityForGrounding,
  createGroundedRepositoryCheckout,
} from '../services/interactiveActorHost/groundedRepositoryCheckout';
import { bundleKey } from '../services/grounding/bundleCheckout';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('grounded repository checkout for durable interactive turns', () => {
  let root: string;
  let sha: string;
  let bundlePath: string;
  let nextSha: string;
  let nextBundlePath: string;
  const grounding = (pinned: string = sha) => ({
    provider: 'github' as const,
    project: 'Apex',
    repository: 'owner/Apex',
    sha: pinned,
    profileId: 'profile-1',
  });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'apex-grounded-checkout-'));
    const source = path.join(root, 'source');
    execFileSync('git', ['init', '-q', source]);
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    await writeFile(path.join(source, 'AgentHome.tsx'), 'export {};\n');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'init');
    sha = git(source, 'rev-parse', 'HEAD');
    bundlePath = path.join(root, 'snapshot.bundle');
    git(source, 'bundle', 'create', bundlePath, 'HEAD');
    await writeFile(path.join(source, 'Next.tsx'), 'export {};\n');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'next');
    nextSha = git(source, 'rev-parse', 'HEAD');
    nextBundlePath = path.join(root, 'next.bundle');
    git(source, 'bundle', 'create', nextBundlePath, 'HEAD');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function containerServing(
    keys: string[],
    bundleFor: (key: string) => string = () => bundlePath,
  ): {
    container: ContainerClient;
    downloads: string[];
  } {
    const downloads: string[] = [];
    const container = {
      getBlockBlobClient: (key: string) => ({
        getProperties: async () => {
          if (!keys.includes(key)) {
            throw Object.assign(new Error('missing'), { statusCode: 404 });
          }
          return { contentLength: (await stat(bundleFor(key))).size };
        },
        downloadToFile: async (target: string) => {
          downloads.push(key);
          if (!keys.includes(key)) {
            throw Object.assign(new Error('missing'), { statusCode: 404 });
          }
          await copyFile(bundleFor(key), target);
        },
      }),
    } as unknown as ContainerClient;
    return { container, downloads };
  }

  async function twoCommitSetup(cacheName: string) {
    const firstKey = bundleKey(bundleIdentityForGrounding(grounding()));
    const nextKey = bundleKey(bundleIdentityForGrounding(grounding(nextSha)));
    const { container } = containerServing(
      [firstKey, nextKey],
      (key) => (key === nextKey ? nextBundlePath : bundlePath),
    );
    const firstSize = (await stat(bundlePath)).size;
    const nextSize = (await stat(nextBundlePath)).size;
    const cacheRoot = path.join(root, cacheName);
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot,
      // Room for the next commit's restore, but not while the first base is kept.
      diskBudgetBytes: firstSize + 2 * nextSize - 1,
    });
    const firstBase = path.join(
      cacheRoot,
      'apex-interactive-repo',
      `${firstKey.replace(/\.bundle$/, '')}.git`,
    );
    return { checkout, firstBase };
  }

  it('keys GitHub bundles by repository name without the owner', () => {
    expect(bundleIdentityForGrounding(grounding())).toEqual({
      provider: 'github',
      project: 'Apex',
      repo: 'Apex',
      sha,
    });
  });

  it('restores one base per SHA and gives each thread its own worktree', async () => {
    const identity = bundleIdentityForGrounding(grounding());
    const { container, downloads } = containerServing([bundleKey(identity)]);
    const cacheRoot = path.join(root, 'cache-a');
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot,
    });
    const signal = new AbortController().signal;
    const threadA = path.join(root, 'threads', 'a');
    const threadB = path.join(root, 'threads', 'b');

    const first = await checkout.checkout(grounding(), threadA, signal);
    const again = await checkout.checkout(grounding(), threadA, signal);
    const second = await checkout.checkout(grounding(), threadB, signal);

    expect(first).toMatchObject({ status: 'ready', source: 'bundle' });
    expect(again).toMatchObject({ status: 'ready', source: 'worktree' });
    expect(second).toMatchObject({ status: 'ready', source: 'base' });
    expect(downloads).toHaveLength(1);
    const content = await readFile(path.join(threadB, 'AgentHome.tsx'), 'utf8');
    expect(content.trim()).toBe('export {};');
    expect(git(threadA, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('reports a missing bundle so the turn keeps the remote reader', async () => {
    const { container } = containerServing([]);
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot: path.join(root, 'cache-b'),
    });

    await expect(
      checkout.checkout(grounding(), path.join(root, 'threads', 'c'), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'bundle-missing' });
  });

  it('skips a bundle larger than the limit without downloading it', async () => {
    const identity = bundleIdentityForGrounding(grounding());
    const { container, downloads } = containerServing([bundleKey(identity)]);
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot: path.join(root, 'cache-large'),
      maxBundleBytes: 1,
    });

    await expect(
      checkout.checkout(grounding(), path.join(root, 'threads', 'large'), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'bundle-too-large' });
    expect(downloads).toHaveLength(0);
  });

  it('refuses worktrees past the disk budget until one is released', async () => {
    const identity = bundleIdentityForGrounding(grounding());
    const { container } = containerServing([bundleKey(identity)]);
    const size = (await stat(bundlePath)).size;
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot: path.join(root, 'cache-budget'),
      diskBudgetBytes: 2 * size,
    });
    const signal = new AbortController().signal;
    const first = path.join(root, 'threads', 'budget-1');
    const second = path.join(root, 'threads', 'budget-2');

    await expect(checkout.checkout(grounding(), first, signal)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(checkout.checkout(grounding(), second, signal)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'disk-budget',
    });

    await checkout.release(first);
    await expect(checkout.checkout(grounding(), second, signal)).resolves.toMatchObject({
      status: 'ready',
      source: 'base',
    });
  });

  it('removes an unused older commit to make room for a new one', async () => {
    const { checkout, firstBase } = await twoCommitSetup('cache-evict');
    const signal = new AbortController().signal;
    const threadA = path.join(root, 'threads', 'evict-a');
    const threadB = path.join(root, 'threads', 'evict-b');

    await expect(checkout.checkout(grounding(), threadA, signal)).resolves.toMatchObject({
      status: 'ready',
    });
    await checkout.release(threadA);

    await expect(checkout.checkout(grounding(nextSha), threadB, signal)).resolves.toMatchObject({
      status: 'ready',
      source: 'bundle',
    });
    await expect(stat(firstBase)).rejects.toThrow();
    expect(git(threadB, 'rev-parse', 'HEAD')).toBe(nextSha);
  });

  it('keeps an older commit that a thread still uses', async () => {
    const { checkout, firstBase } = await twoCommitSetup('cache-in-use');
    const signal = new AbortController().signal;
    const threadA = path.join(root, 'threads', 'in-use-a');

    await expect(checkout.checkout(grounding(), threadA, signal)).resolves.toMatchObject({
      status: 'ready',
    });

    await expect(
      checkout.checkout(grounding(nextSha), path.join(root, 'threads', 'in-use-b'), signal),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'disk-budget' });
    await expect(stat(firstBase)).resolves.toBeTruthy();
    expect(git(threadA, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('budgets a working copy at its real file size, not the compressed bundle size', async () => {
    const source = path.join(root, 'compressible-source');
    execFileSync('git', ['init', '-q', source]);
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    await writeFile(path.join(source, 'large.txt'), 'a'.repeat(1024 * 1024));
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'large');
    const largeSha = git(source, 'rev-parse', 'HEAD');
    const largeBundle = path.join(root, 'compressible.bundle');
    git(source, 'bundle', 'create', largeBundle, 'HEAD');
    const bundleSize = (await stat(largeBundle)).size;
    const key = bundleKey(bundleIdentityForGrounding(grounding(largeSha)));
    const { container } = containerServing([key], () => largeBundle);
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => container,
      cacheRoot: path.join(root, 'cache-real-size'),
      // Enough for the restore and a worktree estimated at the bundle size.
      diskBudgetBytes: 4 * bundleSize,
    });

    await expect(
      checkout.checkout(
        grounding(largeSha),
        path.join(root, 'threads', 'real-size'),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'disk-budget' });
  }, 30_000);

  it('reports not-configured when no grounding storage is set', async () => {
    const checkout = createGroundedRepositoryCheckout({
      getContainerClient: () => null,
      cacheRoot: path.join(root, 'cache-c'),
    });

    await expect(
      checkout.checkout(grounding(), path.join(root, 'threads', 'd'), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'not-configured' });
  });
});
