/**
 * FEAT-002 avatarResolverService tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      userProfiles: { findFirst: jest.fn() },
      appUsers: { findFirst: jest.fn() },
    },
  },
}));

import {
  AvatarDependencyError,
  resolveAvatar,
} from '../services/avatarResolverService';
import { setAvatarStoreForTests, type AvatarStore } from '../services/avatarStore';
import { setGraphAvatarSourceForTests, type GraphAvatarSource } from '../services/graphAvatarSource';

type MockDb = {
  query: {
    userProfiles: { findFirst: jest.Mock };
    appUsers: { findFirst: jest.Mock };
  };
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: MockDb };

function makeStore(overrides: Partial<AvatarStore> = {}): AvatarStore {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(Buffer.from('uploaded-bytes')),
    exists: jest.fn().mockResolvedValue(false),
    delete: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeGraphSource(overrides: Partial<GraphAvatarSource> = {}): GraphAvatarSource {
  return {
    getProfilePhoto: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('avatarResolverService — VT-10 precedence: uploaded > graph > initials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAvatarStoreForTests(undefined);
    setGraphAvatarSourceForTests(undefined);
  });

  it('VT-10: returns uploaded bytes when a blob key exists and the object is present', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      avatarBlobKey: 'avatars/deadbeef.webp',
      avatarUpdatedAt: '2026-07-20T00:00:00.000Z',
    });
    const store = makeStore({ exists: jest.fn().mockResolvedValue(true) });
    const graph = makeGraphSource();
    setAvatarStoreForTests(store);
    setGraphAvatarSourceForTests(graph);

    const result = await resolveAvatar('oid-a');
    expect(result).toEqual({
      kind: 'bytes',
      source: 'uploaded',
      bytes: Buffer.from('uploaded-bytes'),
      contentType: 'image/webp',
      cacheVersion: '2026-07-20T00:00:00.000Z',
      etag: '2026-07-20T00:00:00.000Z',
    });
    expect(graph.getProfilePhoto).not.toHaveBeenCalled();
  });

  it('VT-10: falls through to Graph when there is no blob key', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      avatarBlobKey: null,
      avatarUpdatedAt: null,
    });
    const store = makeStore();
    const graph = makeGraphSource({
      getProfilePhoto: jest.fn().mockResolvedValue({ bytes: Buffer.from('graph-bytes'), contentType: 'image/jpeg' }),
    });
    setAvatarStoreForTests(store);
    setGraphAvatarSourceForTests(graph);

    const result = await resolveAvatar('oid-a');
    expect(result).toEqual({
      kind: 'bytes',
      source: 'graph',
      bytes: Buffer.from('graph-bytes'),
      contentType: 'image/jpeg',
      cacheVersion: '0',
    });
  });

  it('VT-10: falls through to Graph when the recorded blob key is missing from storage', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      avatarBlobKey: 'avatars/missing.webp',
      avatarUpdatedAt: '2026-07-01T00:00:00.000Z',
    });
    const store = makeStore({ exists: jest.fn().mockResolvedValue(false) });
    const graph = makeGraphSource({
      getProfilePhoto: jest.fn().mockResolvedValue({ bytes: Buffer.from('graph-bytes'), contentType: 'image/jpeg' }),
    });
    setAvatarStoreForTests(store);
    setGraphAvatarSourceForTests(graph);

    const result = await resolveAvatar('oid-a');
    expect(result).toMatchObject({ kind: 'bytes', source: 'graph' });
  });

  it('VT-10: falls through to initials when there is no blob key and Graph is disabled', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue(undefined);
    mockDb.query.appUsers.findFirst.mockResolvedValue({ displayName: 'Ada Lovelace' });
    setAvatarStoreForTests(makeStore());
    setGraphAvatarSourceForTests(makeGraphSource());

    const result = await resolveAvatar('oid-a');
    expect(result).toEqual({ kind: 'initials', initials: 'AL', cacheVersion: '0' });
  });

  it('uses the displayNameOverride instead of querying app_users when provided', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue(undefined);
    setAvatarStoreForTests(makeStore());
    setGraphAvatarSourceForTests(makeGraphSource());

    const result = await resolveAvatar('oid-a', 'Grace Hopper');
    expect(result).toEqual({ kind: 'initials', initials: 'GH', cacheVersion: '0' });
    expect(mockDb.query.appUsers.findFirst).not.toHaveBeenCalled();
  });
});

describe('avatarResolverService — DoD-1 / BR-007: never leaks a blob URL or key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAvatarStoreForTests(undefined);
    setGraphAvatarSourceForTests(undefined);
  });

  it('bytes result never includes the blob key or a public URL', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      avatarBlobKey: 'avatars/deadbeef.webp',
      avatarUpdatedAt: '2026-07-20T00:00:00.000Z',
    });
    setAvatarStoreForTests(makeStore({ exists: jest.fn().mockResolvedValue(true) }));
    setGraphAvatarSourceForTests(makeGraphSource());

    const result = await resolveAvatar('oid-a');
    const serialized = JSON.stringify(result, (_key, value) =>
      Buffer.isBuffer(value) ? '<buffer>' : value
    );
    expect(serialized).not.toContain('avatars/deadbeef.webp');
    expect(serialized).not.toMatch(/blob\.core\.windows\.net/i);
  });

  it('initials result never includes a url field', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue(undefined);
    mockDb.query.appUsers.findFirst.mockResolvedValue({ displayName: 'Colleague' });
    setAvatarStoreForTests(makeStore());
    setGraphAvatarSourceForTests(makeGraphSource());

    const result = await resolveAvatar('oid-b');
    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('blobKey');
  });
});

describe('avatarResolverService — operational failures throw AvatarDependencyError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAvatarStoreForTests(undefined);
    setGraphAvatarSourceForTests(undefined);
  });

  it('502s when the profile lookup itself fails', async () => {
    mockDb.query.userProfiles.findFirst.mockRejectedValue(new Error('db down'));
    await expect(resolveAvatar('oid-a')).rejects.toMatchObject({
      name: 'AvatarDependencyError',
      statusCode: 502,
    });
  });

  it('503s when the store exists() check throws (not the same as not-found)', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      avatarBlobKey: 'avatars/deadbeef.webp',
      avatarUpdatedAt: '2026-07-20T00:00:00.000Z',
    });
    setAvatarStoreForTests(makeStore({ exists: jest.fn().mockRejectedValue(new Error('storage outage')) }));
    setGraphAvatarSourceForTests(makeGraphSource());

    await expect(resolveAvatar('oid-a')).rejects.toBeInstanceOf(AvatarDependencyError);
    await expect(resolveAvatar('oid-a')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('502s when Graph lookup throws', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({ avatarBlobKey: null, avatarUpdatedAt: null });
    setAvatarStoreForTests(makeStore());
    setGraphAvatarSourceForTests(
      makeGraphSource({ getProfilePhoto: jest.fn().mockRejectedValue(new Error('graph outage')) })
    );

    await expect(resolveAvatar('oid-a')).rejects.toMatchObject({
      name: 'AvatarDependencyError',
      statusCode: 502,
    });
  });
});
