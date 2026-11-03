/**
 * @jest-environment node
 */

import type { GroundingProfileId } from '../../shared/types/repoReader';
import {
  GroundingProfileResolver,
  type GroundingProfileRegistration,
} from '../services/groundingProfileResolver';
import type {
  GroundingProfileStore,
  SharedGroundingProfile,
} from '../services/groundingProfileStore';

function memoryStore(): GroundingProfileStore & { rows: Map<string, SharedGroundingProfile> } {
  const rows = new Map<string, SharedGroundingProfile>();
  return {
    rows,
    save: jest.fn(async (id, profile) => { rows.set(id, profile); }),
    load: jest.fn(async (id) => rows.get(id) ?? null),
    remove: jest.fn(async (id) => { rows.delete(id); }),
  };
}

function instance(store: GroundingProfileStore, now: () => number = () => 1_000) {
  return new GroundingProfileResolver({
    authorization: {
      authorize: async (input) =>
        input.callerRunRef === input.ownerRunRef &&
        input.callerProject === input.ownerProject,
    },
    isRepoReadServiceEnabledForCaller: async () => false,
    now,
    store,
  });
}

const caller = { userId: 'user-1', runRef: 'chat:thread-1', project: 'Apex' };

function registration(share: boolean): GroundingProfileRegistration {
  return {
    runRef: 'chat:thread-1',
    provider: 'github',
    project: 'Apex',
    repo: 'Apex',
    sha: 'a'.repeat(40),
    checkoutPath: '/home/data/ai-pilot/workspaces/grounding-shared/apex',
    caller: 'durable-interactive',
    shareAcrossInstances: share,
  };
}

describe('grounding profiles across App Service instances', () => {
  it('resolves a shared profile on an instance that did not register it', async () => {
    const store = memoryStore();
    const registering = instance(store);
    const other = instance(store);

    const profile = registering.registerConnectionProfile(
      registration(true), caller, async () => true,
    );
    await registering.whenShared(profile.id);

    await expect(other.resolveConnectionProfile(profile.id)).resolves.toBeDefined();
    expect(store.rows.get(profile.id)?.owner).toEqual(caller);
  });

  it('keeps unshared profiles on the registering instance', async () => {
    const store = memoryStore();
    const registering = instance(store);
    const other = instance(store);

    const profile = registering.registerConnectionProfile(
      registration(false), caller, async () => true,
    );
    await registering.whenShared(profile.id);

    expect(store.save).not.toHaveBeenCalled();
    await expect(other.resolveConnectionProfile(profile.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('denies other instances once the registering instance revokes the profile', async () => {
    const store = memoryStore();
    const registering = instance(store);
    const other = instance(store);
    const profile = registering.registerConnectionProfile(
      registration(true), caller, async () => true,
    );
    await registering.whenShared(profile.id);
    await expect(other.resolveConnectionProfile(profile.id)).resolves.toBeDefined();

    registering.revokeProfile(profile.id);
    await Promise.resolve();

    expect(store.remove).toHaveBeenCalledWith(profile.id);
    await expect(other.resolveConnectionProfile(profile.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('denies an expired shared profile', async () => {
    const store = memoryStore();
    let now = 1_000;
    const registering = instance(store, () => now);
    const other = instance(store, () => now);
    const profile = registering.registerConnectionProfile(
      { ...registration(true), ttlMs: 10 }, caller, async () => true,
    );
    await registering.whenShared(profile.id);
    now += 11;

    await expect(other.resolveConnectionProfile(profile.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('still registers locally when saving the shared copy fails', async () => {
    const store = memoryStore();
    (store.save as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registering = instance(store);

    const profile = registering.registerConnectionProfile(
      registration(true), caller, async () => true,
    );
    await registering.whenShared(profile.id);

    await expect(registering.resolveConnectionProfile(profile.id)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[grounding-profile] share failed'),
      'db down',
    );
    warn.mockRestore();
  });

  it('does not query the store for an unknown ID when no store is configured', async () => {
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
    });
    await expect(
      resolver.resolveConnectionProfile('unknown' as GroundingProfileId),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
