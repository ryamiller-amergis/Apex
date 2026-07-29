/**
 * FEAT-002 avatarService tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      userProfiles: { findFirst: jest.fn() },
      appUsers: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('../services/avatarProcessingService', () => {
  const actual = jest.requireActual('../services/avatarProcessingService');
  return {
    ...actual,
    processAvatarImage: jest.fn(),
  };
});

jest.mock('../services/avatarStore', () => ({
  buildAvatarObjectKey: jest.fn((oid: string) => `avatars/${oid}-hash.webp`),
  getAvatarStore: jest.fn(),
}));

import {
  AvatarDependencyError,
  AvatarValidationError,
  deleteOwnAvatar,
  replaceOwnAvatar,
} from '../services/avatarService';
import { processAvatarImage } from '../services/avatarProcessingService';
import { buildAvatarObjectKey, getAvatarStore } from '../services/avatarStore';

type MockDb = {
  query: {
    userProfiles: { findFirst: jest.Mock };
    appUsers: { findFirst: jest.Mock };
  };
  insert: jest.Mock;
  update: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: MockDb };
const mockProcessAvatarImage = processAvatarImage as jest.Mock;
const mockGetAvatarStore = getAvatarStore as jest.Mock;
const mockBuildAvatarObjectKey = buildAvatarObjectKey as jest.Mock;

function makeStore() {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(Buffer.from('bytes')),
    exists: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

describe('avatarService.replaceOwnAvatar — VT-01 / VT-02 / VT-05 self-only', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    jest.clearAllMocks();
    store = makeStore();
    mockGetAvatarStore.mockReturnValue(store);
    mockProcessAvatarImage.mockResolvedValue(Buffer.from('processed-webp'));
    const returning = jest.fn();
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
  });

  it('VT-01: signature takes only actorOid — no target user parameter exists', () => {
    expect(replaceOwnAvatar.length).toBe(4); // actorOid, fileBuffer, crop, displayName
  });

  it('VT-02 / VT-05: processes, stores under buildAvatarObjectKey(actorOid), and upserts avatar_blob_key', async () => {
    const crop = { x: 0, y: 0, width: 1, height: 1 };
    const result = await replaceOwnAvatar('oid-a', Buffer.from('raw'), crop, 'Ada Lovelace');

    expect(mockProcessAvatarImage).toHaveBeenCalledWith(Buffer.from('raw'), crop);
    expect(mockBuildAvatarObjectKey).toHaveBeenCalledWith('oid-a');
    expect(store.put).toHaveBeenCalledWith('avatars/oid-a-hash.webp', Buffer.from('processed-webp'), 'image/webp');
    expect(mockDb.insert).toHaveBeenCalled();

    expect(result.avatar.source).toBe('uploaded');
    expect(result.avatar.initials).toBeNull();
    expect(result.avatar.url).toContain('/api/profile/avatar/oid-a');
    expect(result.cacheVersion).toBe(result.avatar.cacheVersion);
  });

  it('VT-02: rejects an invalid crop before touching storage', async () => {
    await expect(
      replaceOwnAvatar('oid-a', Buffer.from('raw'), { x: 0, y: 0, width: 1 }, 'Ada')
    ).rejects.toBeInstanceOf(AvatarValidationError);
    expect(mockProcessAvatarImage).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('propagates processing validation errors (e.g. unsupported format) without storing', async () => {
    mockProcessAvatarImage.mockRejectedValue(new AvatarValidationError('bad format', 415));
    await expect(
      replaceOwnAvatar('oid-a', Buffer.from('raw'), { x: 0, y: 0, width: 1, height: 1 }, 'Ada')
    ).rejects.toMatchObject({ statusCode: 415 });
    expect(store.put).not.toHaveBeenCalled();
  });

  it('VT-05: throws AvatarDependencyError (503) when the store put fails', async () => {
    store.put.mockRejectedValue(new Error('blob outage'));
    await expect(
      replaceOwnAvatar('oid-a', Buffer.from('raw'), { x: 0, y: 0, width: 1, height: 1 }, 'Ada')
    ).rejects.toMatchObject({ name: 'AvatarDependencyError', statusCode: 503 });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('avatarService.deleteOwnAvatar — VT-06 / VT-08 self-only, honest failure', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    jest.clearAllMocks();
    store = makeStore();
    mockGetAvatarStore.mockReturnValue(store);
    const where = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn().mockReturnValue({ where });
    mockDb.update.mockReturnValue({ set });
  });

  it('VT-08: signature takes only actorOid — no target user parameter exists', () => {
    expect(deleteOwnAvatar.length).toBe(2); // actorOid, displayName
  });

  it('idempotent success with fallback descriptor when no blob key is on file', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({ avatarBlobKey: null });

    const result = await deleteOwnAvatar('oid-a', 'Ada Lovelace');

    expect(store.delete).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(result.avatar.source).toBe('initials');
    expect(result.avatar.initials).toBe('AL');
  });

  it('deletes the blob then clears avatar_blob_key and avatar_updated_at', async () => {
    // First lookup (inside deleteOwnAvatar) sees the existing blob key; the
    // second lookup (inside resolveAvatar's fallback build) reflects the
    // post-delete row so the returned descriptor is the real new state.
    mockDb.query.userProfiles.findFirst
      .mockResolvedValueOnce({ avatarBlobKey: 'avatars/oid-a-hash.webp' })
      .mockResolvedValueOnce({ avatarBlobKey: null, avatarUpdatedAt: null });

    const result = await deleteOwnAvatar('oid-a', 'Ada Lovelace');

    expect(store.delete).toHaveBeenCalledWith('avatars/oid-a-hash.webp');
    expect(mockDb.update).toHaveBeenCalled();
    expect(result.avatar.source).toBe('initials');
    expect(result.avatar.initials).toBe('AL');
  });

  it('VT-06: honest failure — blob delete error throws and leaves the DB row untouched', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({ avatarBlobKey: 'avatars/oid-a-hash.webp' });
    store.delete.mockRejectedValue(new Error('blob outage'));

    await expect(deleteOwnAvatar('oid-a', 'Ada Lovelace')).rejects.toMatchObject({
      name: 'AvatarDependencyError',
      statusCode: 503,
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('throws AvatarDependencyError when the profile lookup fails', async () => {
    mockDb.query.userProfiles.findFirst.mockRejectedValue(new Error('db down'));
    await expect(deleteOwnAvatar('oid-a', 'Ada Lovelace')).rejects.toBeInstanceOf(AvatarDependencyError);
  });
});
