import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunGrounding } from '../../../../shared/types/runGrounding';
import type { RepoCacheLeaseContext } from '../../repoCacheLeaseService';
import {
  createSharedReadCheckoutService,
  sharedReadCheckoutIdentityFromGrounding,
  SHARED_READ_MARKER,
  SHARED_READ_IDLE_TTL_MS,
  type SharedReadCheckoutDependencies,
  type SharedReadCheckoutIdentity,
} from '../sharedReadCheckoutService';

const IDENTITY: SharedReadCheckoutIdentity = {
  provider: 'ado',
  project: 'Apex',
  repo: 'apex-repo',
  branch: 'main',
  sha: 'a'.repeat(40),
};

function makeLease(): (cacheKey: string, op: (lease: RepoCacheLeaseContext) => Promise<unknown>) => Promise<unknown> {
  const lease: RepoCacheLeaseContext = {
    signal: new AbortController().signal,
    assertOwned: async () => undefined,
  };
  return (_cacheKey, op) => op(lease) as Promise<unknown>;
}

function makeService(
  dataRoot: string,
  overrides: Partial<SharedReadCheckoutDependencies> = {},
) {
  const materializeToPath = jest.fn(async (_id: SharedReadCheckoutIdentity, dest: string) => {
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'README.md'), '# repo', 'utf-8');
  });
  const service = createSharedReadCheckoutService({
    dataRoot,
    materializeToPath,
    withLease: makeLease() as SharedReadCheckoutDependencies['withLease'],
    listActiveGroundings: async () => [],
    telemetry: () => undefined,
    ...overrides,
  });
  return { service, materializeToPath };
}

describe('sharedReadCheckoutService', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-read-'));
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('resolves a stable SHA-keyed path under workspaces/grounding-shared', () => {
    const { service } = makeService(dataRoot);
    const a = service.resolvePath(IDENTITY);
    const b = service.resolvePath({ ...IDENTITY });
    const other = service.resolvePath({ ...IDENTITY, sha: 'b'.repeat(40) });

    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a.replace(/\\/g, '/')).toContain('workspaces/grounding-shared/');
  });

  it('materializes cold, then serves a warm hit without re-materializing', async () => {
    const { service, materializeToPath } = makeService(dataRoot);

    const cold = await service.materialize(IDENTITY);
    expect(cold.outcome).toBe('materialized');
    expect(fs.existsSync(path.join(cold.workspacePath, SHARED_READ_MARKER))).toBe(true);
    expect(materializeToPath).toHaveBeenCalledTimes(1);

    const warm = await service.materialize(IDENTITY);
    expect(warm.outcome).toBe('hit');
    expect(warm.workspacePath).toBe(cold.workspacePath);
    expect(materializeToPath).toHaveBeenCalledTimes(1);
  });

  it('returns "wait" when another materializer wins the lease race', async () => {
    const { service, materializeToPath } = makeService(dataRoot, {
      // Simulate a peer completing the checkout while we hold the lease.
      withLease: (async (_key: string, op: (lease: RepoCacheLeaseContext) => Promise<unknown>) => {
        const dest = service.resolvePath(IDENTITY);
        await fsp.mkdir(dest, { recursive: true });
        await fsp.writeFile(path.join(dest, SHARED_READ_MARKER), '{}', 'utf-8');
        return op({
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
        });
      }) as SharedReadCheckoutDependencies['withLease'],
    });

    const result = await service.materialize(IDENTITY);
    expect(result.outcome).toBe('wait');
    expect(materializeToPath).not.toHaveBeenCalled();
  });

  it('adopts a concurrently-created ready tree instead of clobbering it', async () => {
    // Simulate the multi-instance / SMB-cache race: the warm-path marker check
    // misses, so we enter the lease and stage our own tree — but a peer promotes
    // the real destination (with marker + content) before our rename. The staged
    // rename must NOT wipe the peer's ready tree; we adopt it and return 'wait'.
    // Deterministic destination path (resolvePath is pure given dataRoot+identity).
    const finalDest = makeService(dataRoot).service.resolvePath(IDENTITY);
    const materializeToPath = jest.fn(async (_id: SharedReadCheckoutIdentity, dest: string) => {
      await fsp.mkdir(dest, { recursive: true });
      await fsp.writeFile(path.join(dest, 'README.md'), '# ours', 'utf-8');
      // Peer finishes the real destination while we were staging.
      await fsp.mkdir(finalDest, { recursive: true });
      await fsp.writeFile(path.join(finalDest, 'PEER.md'), '# peer', 'utf-8');
      await fsp.writeFile(path.join(finalDest, SHARED_READ_MARKER), '{"peer":true}', 'utf-8');
    });
    const service = createSharedReadCheckoutService({
      dataRoot,
      materializeToPath,
      withLease: makeLease() as SharedReadCheckoutDependencies['withLease'],
      listActiveGroundings: async () => [],
      telemetry: () => undefined,
    });

    const result = await service.materialize(IDENTITY);

    expect(result.outcome).toBe('wait');
    expect(result.workspacePath).toBe(finalDest);
    // The peer's tree is preserved intact — never clobbered by our staged rename.
    expect(fs.existsSync(path.join(result.workspacePath, 'PEER.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath, SHARED_READ_MARKER))).toBe(true);
    // Our staging dir is cleaned up (no `.tmp-` siblings left behind).
    const siblings = fs.readdirSync(path.dirname(result.workspacePath));
    expect(siblings.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('tracks ref counts for retain/releaseRef', () => {
    const { service } = makeService(dataRoot);
    expect(service.getRefCount(IDENTITY)).toBe(0);
    service.retain(IDENTITY);
    service.retain(IDENTITY);
    expect(service.getRefCount(IDENTITY)).toBe(2);
    service.releaseRef(IDENTITY);
    expect(service.getRefCount(IDENTITY)).toBe(1);
    service.releaseRef(IDENTITY);
    service.releaseRef(IDENTITY);
    expect(service.getRefCount(IDENTITY)).toBe(0);
  });

  it('evicts idle unreferenced trees but protects active SHAs and ref-counted trees', async () => {
    const activeGrounding = {
      provider: 'azure_devops',
      project: 'Apex',
      repository: 'apex-repo',
      branch: 'main',
      groundedSha: 'c'.repeat(40),
    } as RunGrounding;
    const activeIdentity = sharedReadCheckoutIdentityFromGrounding(activeGrounding);
    const referencedIdentity: SharedReadCheckoutIdentity = {
      ...IDENTITY,
      sha: 'd'.repeat(40),
    };

    const { service } = makeService(dataRoot, {
      listActiveGroundings: async () => [activeGrounding],
    });

    // Materialize three trees: idle, active-protected, ref-held.
    const idle = await service.materialize(IDENTITY);
    const activeTree = await service.materialize(activeIdentity);
    const held = await service.materialize(referencedIdentity);
    service.retain(referencedIdentity);

    // Age all three past the idle TTL via their last-use sidecars.
    const old = Date.now() - SHARED_READ_IDLE_TTL_MS - 60_000;
    for (const tree of [idle, activeTree, held]) {
      await fsp.writeFile(`${tree.workspacePath}.lastused`, String(old), 'utf-8');
    }

    const result = await service.evictIdle();

    expect(result.scanned).toBe(3);
    expect(result.evicted).toBe(1);
    expect(fs.existsSync(idle.workspacePath)).toBe(false);
    // The evicted tree's sidecar is cleaned up too.
    expect(fs.existsSync(`${idle.workspacePath}.lastused`)).toBe(false);
    expect(fs.existsSync(activeTree.workspacePath)).toBe(true);
    expect(fs.existsSync(held.workspacePath)).toBe(true);
  });

  it('refreshes last-use on a warm hit so an unreferenced tree survives', async () => {
    const { service } = makeService(dataRoot);
    const tree = await service.materialize(IDENTITY);

    // Age it past the TTL, then take a warm hit which must refresh last-use.
    const old = Date.now() - SHARED_READ_IDLE_TTL_MS - 60_000;
    await fsp.writeFile(`${tree.workspacePath}.lastused`, String(old), 'utf-8');
    const warm = await service.materialize(IDENTITY);
    expect(warm.outcome).toBe('hit');

    const result = await service.evictIdle();
    expect(result.evicted).toBe(0);
    expect(fs.existsSync(tree.workspacePath)).toBe(true);
  });

  it('falls back to directory mtime when the last-use sidecar is missing', async () => {
    const { service } = makeService(dataRoot);
    const tree = await service.materialize(IDENTITY);

    // Remove the sidecar and age the directory itself past the TTL.
    await fsp.rm(`${tree.workspacePath}.lastused`, { force: true });
    const old = new Date(Date.now() - SHARED_READ_IDLE_TTL_MS - 60_000);
    await fsp.utimes(tree.workspacePath, old, old);

    const result = await service.evictIdle();
    expect(result.evicted).toBe(1);
    expect(fs.existsSync(tree.workspacePath)).toBe(false);
  });

  it('keeps freshly used trees even when unreferenced', async () => {
    const { service } = makeService(dataRoot);
    const fresh = await service.materialize(IDENTITY);

    const result = await service.evictIdle();

    expect(result.evicted).toBe(0);
    expect(fs.existsSync(fresh.workspacePath)).toBe(true);
  });

  it('returns an empty result when the shared root does not exist', async () => {
    const { service } = makeService(dataRoot);
    const result = await service.evictIdle();
    expect(result).toEqual({ scanned: 0, evicted: 0, protected: 0 });
  });
});
