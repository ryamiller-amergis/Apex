/**
 * TBI-002 / PBI profileService unit tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
jest.mock('../db/drizzle', () => {
  return {
    db: {
      query: {
        userProfiles: { findFirst: jest.fn() },
        appUsers: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    },
  };
});

import {
  getCurrentProfile,
  getProfileCard,
  ProfileNotFoundError,
  ProfileValidationError,
  updateCurrentProfile,
} from '../services/profileService';

type MockDb = {
  query: {
    userProfiles: { findFirst: jest.Mock };
    appUsers: { findFirst: jest.Mock };
  };
  insert: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: MockDb };

const identity = { displayName: 'Ada Lovelace', email: 'ada@example.com' };

describe('profileService — TBI-002 DoD-0 / PBI-001 AC-0', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DoD-0: getCurrentProfile returns claim identity plus stored bio', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      userOid: 'oid-a',
      bio: 'Platform engineer',
      avatarBlobKey: 'secret-key',
      avatarUpdatedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const result = await getCurrentProfile('oid-a', identity);

    expect(result).toEqual({
      userOid: 'oid-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      bio: 'Platform engineer',
      avatar: { userOid: 'oid-a', version: '2026-07-01T00:00:00.000Z' },
      updatedAt: '2026-07-02T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('avatarBlobKey');
  });

  it('DoD-0 / VT-07: absent profile row defaults bio to null', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue(undefined);
    const result = await getCurrentProfile('oid-a', identity);
    expect(result.bio).toBeNull();
    expect(result.avatar.version).toBeNull();
    expect(result.displayName).toBe('Ada Lovelace');
  });

  it('DoD-0: getCurrentProfile clears avatar version when blob key is absent', async () => {
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      userOid: 'oid-a',
      bio: null,
      avatarBlobKey: null,
      avatarUpdatedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const result = await getCurrentProfile('oid-a', identity);
    expect(result.avatar.version).toBeNull();
  });
});

describe('profileService — TBI-002 DoD-1 / PBI-001 AC-2 AC-3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const returning = jest.fn().mockResolvedValue([
      {
        userOid: 'oid-a',
        bio: 'saved',
        avatarBlobKey: null,
        avatarUpdatedAt: null,
        updatedAt: '2026-07-28T00:00:00.000Z',
        createdAt: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
  });

  it('DoD-1 / AC-2: upserts valid bio and returns claim identity', async () => {
    const result = await updateCurrentProfile('oid-a', identity, { bio: 'saved' });
    expect(result.bio).toBe('saved');
    expect(result.displayName).toBe('Ada Lovelace');
    expect(result.email).toBe('ada@example.com');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('DoD-1 / AC-3: rejects oversized bio', async () => {
    await expect(
      updateCurrentProfile('oid-a', identity, { bio: 'x'.repeat(501) })
    ).rejects.toBeInstanceOf(ProfileValidationError);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('DoD-1 / AC-3: rejects HTML bio', async () => {
    await expect(
      updateCurrentProfile('oid-a', identity, { bio: '<b>hi</b>' })
    ).rejects.toBeInstanceOf(ProfileValidationError);
  });
});

describe('profileService — TBI-002 DoD-2 / PBI-002 AC-0 AC-2', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DoD-2 / AC-0: card returns only oid, displayName, bio, avatar subject', async () => {
    mockDb.query.appUsers.findFirst.mockResolvedValue({
      oid: 'oid-b',
      displayName: 'Colleague',
      email: 'private@example.com',
    });
    mockDb.query.userProfiles.findFirst.mockResolvedValue({
      userOid: 'oid-b',
      bio: 'Hello',
      avatarBlobKey: 'must-not-leak',
      avatarUpdatedAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const card = await getProfileCard('oid-b');
    expect(card).toEqual({
      userOid: 'oid-b',
      displayName: 'Colleague',
      bio: 'Hello',
      avatar: { userOid: 'oid-b', version: '2026-07-10T00:00:00.000Z' },
    });
    expect(card).not.toHaveProperty('email');
    expect(JSON.stringify(card)).not.toContain('must-not-leak');
  });

  it('AC-2 / VT-07: known user without profile row returns bio null', async () => {
    mockDb.query.appUsers.findFirst.mockResolvedValue({
      oid: 'oid-b',
      displayName: 'Colleague',
      email: 'private@example.com',
    });
    mockDb.query.userProfiles.findFirst.mockResolvedValue(undefined);

    const card = await getProfileCard('oid-b');
    expect(card.bio).toBeNull();
    expect(card.avatar.version).toBeNull();
  });

  it('DoD-2: unknown oid returns ProfileNotFoundError', async () => {
    mockDb.query.appUsers.findFirst.mockResolvedValue(undefined);
    await expect(getProfileCard('missing')).rejects.toBeInstanceOf(ProfileNotFoundError);
  });
});
