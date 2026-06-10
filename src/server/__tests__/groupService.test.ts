/**
 * Unit tests for groupService.ts
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── DB mock helpers ────────────────────────────────────────────────────────────

/**
 * Creates a fluent select chain where every intermediate method returns `this`
 * and the chain itself is thenable (resolves to `defaultResult`).
 * This handles all query termination patterns:
 *   .from().orderBy()            → awaits chain
 *   .from().where().limit()      → awaits chain
 *   .from().innerJoin().where()  → awaits chain
 *   .from().innerJoin()          → awaits chain
 */
const makeSelectChain = (defaultResult: unknown[] = []) => {
  const chain: any = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  // Make the chain awaitable — resolves to defaultResult
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(defaultResult).then(resolve, reject);
  return chain;
};

const makeInsertChain = () => ({
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  returning: jest.fn().mockResolvedValue([]),
});

const makeUpdateChain = () => ({
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
});

const makeDeleteChain = () => ({
  where: jest.fn().mockResolvedValue(undefined),
});

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

import {
  listGroups,
  listGroupsWithMembers,
  getGroupWithMembers,
  createGroup,
  seedDefaultGroupsForProject,
  updateGroup,
  deleteGroup,
  setGroupMembers,
} from '../services/groupService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const projectGroup = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'group-1',
  name: 'Developer',
  description: 'Software development and engineering',
  project: 'MyProject',
  isDefault: true,
  createdBy: null,
  createdAt: '2026-06-10T12:00:00Z',
  ...overrides,
});

const memberFixture = (groupId = 'group-1') => ({
  groupId,
  userId: 'user-abc',
  displayName: 'Alice',
  email: 'alice@example.com',
  addedBy: null,
  addedAt: '2026-06-10T12:00:00Z',
});

// ── listGroups ─────────────────────────────────────────────────────────────────

describe('listGroups', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries all groups when no project is specified', async () => {
    const chain = makeSelectChain([projectGroup()]);
    mockDb.select.mockReturnValue(chain);

    const result = await listGroups();

    expect(mockDb.select).toHaveBeenCalled();
    expect(chain.where).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Developer');
  });

  it('filters by project when project is specified', async () => {
    const chain = makeSelectChain([projectGroup()]);
    mockDb.select.mockReturnValue(chain);

    const result = await listGroups('MyProject');

    expect(chain.where).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('MyProject');
  });

  it('returns an empty array when no groups exist', async () => {
    const chain = makeSelectChain([]);
    mockDb.select.mockReturnValue(chain);

    const result = await listGroups('EmptyProject');

    expect(result).toEqual([]);
  });
});

// ── listGroupsWithMembers ──────────────────────────────────────────────────────

describe('listGroupsWithMembers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns groups with empty member arrays when no members exist', async () => {
    const groupChain = makeSelectChain([projectGroup()]);
    const memberChain = makeSelectChain([]);
    mockDb.select.mockReturnValueOnce(groupChain).mockReturnValueOnce(memberChain);

    const result = await listGroupsWithMembers('MyProject');

    expect(result).toHaveLength(1);
    expect(result[0].members).toEqual([]);
  });

  it('returns an empty array and skips member fetch when the project has no groups', async () => {
    const groupChain = makeSelectChain([]);
    mockDb.select.mockReturnValue(groupChain);

    const result = await listGroupsWithMembers('EmptyProject');

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('attaches members to the correct group', async () => {
    const group = projectGroup({ id: 'g1' });
    const member = memberFixture('g1');

    const groupChain = makeSelectChain([group]);
    const memberChain = makeSelectChain([member]);
    mockDb.select.mockReturnValueOnce(groupChain).mockReturnValueOnce(memberChain);

    const result = await listGroupsWithMembers('MyProject');

    expect(result[0].members).toHaveLength(1);
    expect(result[0].members[0].userId).toBe('user-abc');
  });

  it('does not attach members from one group to another', async () => {
    const g1 = projectGroup({ id: 'g1', name: 'Developer' });
    const g2 = projectGroup({ id: 'g2', name: 'BA' });
    const member = memberFixture('g1');

    const groupChain = makeSelectChain([g1, g2]);
    const memberChain = makeSelectChain([member]);
    mockDb.select.mockReturnValueOnce(groupChain).mockReturnValueOnce(memberChain);

    const result = await listGroupsWithMembers('MyProject');

    const developer = result.find((g) => g.id === 'g1')!;
    const ba = result.find((g) => g.id === 'g2')!;
    expect(developer.members).toHaveLength(1);
    expect(ba.members).toHaveLength(0);
  });
});

// ── getGroupWithMembers ────────────────────────────────────────────────────────

describe('getGroupWithMembers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when the group is not found', async () => {
    const chain = makeSelectChain([]);
    mockDb.select.mockReturnValue(chain);

    const result = await getGroupWithMembers('missing-id');

    expect(result).toBeNull();
  });

  it('returns the group with its members', async () => {
    const group = projectGroup({ id: 'g1' });
    const member = memberFixture('g1');

    const groupChain = makeSelectChain([group]);
    const memberChain = makeSelectChain([member]);
    mockDb.select.mockReturnValueOnce(groupChain).mockReturnValueOnce(memberChain);

    const result = await getGroupWithMembers('g1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('g1');
    expect(result!.members).toHaveLength(1);
    expect(result!.members[0].displayName).toBe('Alice');
  });

  it('returns the group with empty members when no members exist', async () => {
    const group = projectGroup({ id: 'g1' });

    const groupChain = makeSelectChain([group]);
    const memberChain = makeSelectChain([]);
    mockDb.select.mockReturnValueOnce(groupChain).mockReturnValueOnce(memberChain);

    const result = await getGroupWithMembers('g1');

    expect(result!.members).toEqual([]);
  });
});

// ── createGroup ────────────────────────────────────────────────────────────────

describe('createGroup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a group with all provided fields and returns the created row', async () => {
    const created = projectGroup({ id: 'new-g', isDefault: false });
    const insertChain = makeInsertChain();
    insertChain.returning.mockResolvedValue([created]);
    mockDb.insert.mockReturnValue(insertChain);

    const result = await createGroup('Developer', 'desc', 'creator-oid', 'MyProject', false);

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Developer',
        description: 'desc',
        createdBy: 'creator-oid',
        project: 'MyProject',
        isDefault: false,
      }),
    );
    expect(result.id).toBe('new-g');
  });

  it('defaults project to null and isDefault to false when not supplied', async () => {
    const created = projectGroup({ project: null, isDefault: false });
    const insertChain = makeInsertChain();
    insertChain.returning.mockResolvedValue([created]);
    mockDb.insert.mockReturnValue(insertChain);

    await createGroup('Custom Group');

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ project: null, isDefault: false }),
    );
  });
});

// ── seedDefaultGroupsForProject ────────────────────────────────────────────────

describe('seedDefaultGroupsForProject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts exactly 5 default groups for the given project', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    await seedDefaultGroupsForProject('Alpha', 'seeder-oid');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const valuesArg: any[] = insertChain.values.mock.calls[0][0];
    expect(valuesArg).toHaveLength(5);
    expect(valuesArg.map((v: any) => v.name)).toEqual(
      expect.arrayContaining(['Product-Owner', 'BA', 'UI/UX', 'Manager', 'Developer']),
    );
  });

  it('sets isDefault to true on all seeded groups', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    await seedDefaultGroupsForProject('Alpha');

    const valuesArg: any[] = insertChain.values.mock.calls[0][0];
    expect(valuesArg.every((v: any) => v.isDefault === true)).toBe(true);
  });

  it('sets the correct project on all seeded groups', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    await seedDefaultGroupsForProject('BetaProject');

    const valuesArg: any[] = insertChain.values.mock.calls[0][0];
    expect(valuesArg.every((v: any) => v.project === 'BetaProject')).toBe(true);
  });

  it('uses onConflictDoNothing for idempotency', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    await seedDefaultGroupsForProject('Alpha');

    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
  });
});

// ── updateGroup ────────────────────────────────────────────────────────────────

describe('updateGroup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates and returns the group', async () => {
    const updated = projectGroup({ name: 'Lead Developer' });
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([updated]);
    mockDb.update.mockReturnValue(updateChain);

    const result = await updateGroup('g1', { name: 'Lead Developer' });

    expect(result.name).toBe('Lead Developer');
  });

  it('throws when the group is not found', async () => {
    const updateChain = makeUpdateChain();
    updateChain.returning.mockResolvedValue([]);
    mockDb.update.mockReturnValue(updateChain);

    await expect(updateGroup('missing', { name: 'x' })).rejects.toThrow('Group not found: missing');
  });
});

// ── deleteGroup ────────────────────────────────────────────────────────────────

describe('deleteGroup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls delete with the correct group id', async () => {
    const deleteChain = makeDeleteChain();
    mockDb.delete.mockReturnValue(deleteChain);

    await deleteGroup('g1');

    expect(mockDb.delete).toHaveBeenCalled();
    expect(deleteChain.where).toHaveBeenCalled();
  });
});

// ── setGroupMembers ────────────────────────────────────────────────────────────

describe('setGroupMembers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces all members in a transaction and returns updated members', async () => {
    const txDeleteChain = makeDeleteChain();
    const txInsertChain = makeInsertChain();
    mockDb.transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      await fn({
        delete: jest.fn().mockReturnValue(txDeleteChain),
        insert: jest.fn().mockReturnValue(txInsertChain),
      });
    });

    const memberChain = makeSelectChain([memberFixture('g1')]);
    mockDb.select.mockReturnValue(memberChain);

    const result = await setGroupMembers('g1', ['u1', 'u2'], 'admin-oid');

    expect(mockDb.transaction).toHaveBeenCalled();
    expect(txInsertChain.values).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'u1', groupId: 'g1' }),
        expect.objectContaining({ userId: 'u2', groupId: 'g1' }),
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it('skips the insert when userIds is empty', async () => {
    const txInsertMock = jest.fn();
    mockDb.transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      await fn({
        delete: jest.fn().mockReturnValue(makeDeleteChain()),
        insert: txInsertMock,
      });
    });

    const memberChain = makeSelectChain([]);
    mockDb.select.mockReturnValue(memberChain);

    await setGroupMembers('g1', []);

    expect(txInsertMock).not.toHaveBeenCalled();
  });
});
