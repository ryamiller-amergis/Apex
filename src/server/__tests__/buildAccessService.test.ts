jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigsForProject: jest.fn(),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
  isFeatureOperational: jest.fn(),
}));

import { db } from '../db/drizzle';
import { buildAllowlist, buildAllowlistAudit } from '../db/schema';
import { listSkillConfigsForProject } from '../services/projectSettingsService';
import { isFeatureEnabled, isFeatureOperational } from '../services/featureFlagService';
import * as buildAccessService from '../services/buildAccessService';
import {
  addBuildAllowlistEntry,
  BuildAccessError,
  isBuildFromPromptEnabled,
  isBuildFromPromptOperational,
  isBuildPairAllowed,
  listAllowedRepositoriesForProject,
  listBuildAllowlist,
  listCandidateRepositories,
  removeBuildAllowlistEntry,
} from '../services/buildAccessService';

const mockDb = db as jest.Mocked<typeof db>;
const mockListConfigs = listSkillConfigsForProject as jest.MockedFunction<typeof listSkillConfigsForProject>;
const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;
const mockIsFeatureOperational = isFeatureOperational as jest.MockedFunction<typeof isFeatureOperational>;

const actor = { id: 'oid-admin', label: 'Ada Admin' };
const entryId = '11111111-1111-1111-1111-111111111111';
const entryRow = {
  id: entryId,
  project: 'Apex',
  repository: 'Apex',
  createdBy: 'Ada Admin',
  createdAt: '2026-10-23T12:00:00.000Z',
};

function config(skillRepo: string, skillProvider: 'ado' | 'github' = 'ado') {
  return { id: `cfg-${skillRepo}`, project: 'Apex', friendlyName: skillRepo, isDefault: true, skillProvider, skillRepo, skillBranch: 'main' } as never;
}

/** Records every insert/delete made inside db.transaction. */
function mockTransaction(opts: { insertedEntry?: typeof entryRow; deleted?: { project: string; repository: string } | null; failOn?: 'entry' | 'audit'; error?: unknown } = {}) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const deletes: unknown[] = [];
  const tx = {
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((values: unknown) => {
        const isAudit = table === buildAllowlistAudit;
        if ((opts.failOn === 'entry' && !isAudit) || (opts.failOn === 'audit' && isAudit)) {
          const fail = () => Promise.reject(opts.error ?? new Error('insert failed'));
          return { returning: jest.fn(fail), then: (res: unknown, rej: (e: unknown) => void) => fail().then(res as never, rej) };
        }
        inserts.push({ table, values });
        const result = isAudit ? [] : [opts.insertedEntry ?? entryRow];
        return {
          returning: jest.fn().mockResolvedValue(result),
          then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
        };
      }),
    })),
    delete: jest.fn((table: unknown) => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => {
          deletes.push(table);
          return Promise.resolve(opts.deleted === null ? [] : [opts.deleted ?? { project: 'Apex', repository: 'Apex' }]);
        }),
      })),
    })),
  };
  mockDb.transaction.mockImplementation((async (fn: (t: typeof tx) => unknown) => fn(tx)) as never);
  return { inserts, deletes, tx };
}

function mockSelectRows(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  const resolved = Promise.resolve(rows);
  for (const key of ['from', 'where', 'orderBy', 'limit']) {
    chain[key] = jest.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  mockDb.select.mockReturnValue(Object.assign(resolved, chain) as never);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('flag helpers (TBI-004 DoD-2)', () => {
  it('isBuildFromPromptEnabled evaluates build-from-prompt for the user and project', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    await expect(isBuildFromPromptEnabled({ userId: 'u1', project: 'Apex' })).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('build-from-prompt', { userId: 'u1', project: 'Apex' });
  });

  it('isBuildFromPromptOperational uses the operational check', async () => {
    mockIsFeatureOperational.mockResolvedValue(false);
    await expect(isBuildFromPromptOperational()).resolves.toBe(false);
    expect(mockIsFeatureOperational).toHaveBeenCalledWith('build-from-prompt');
  });
});

describe('isBuildPairAllowed (TBI-004 DoD-3)', () => {
  it('returns true when a matching row exists and queries with a limit of one', async () => {
    const chain = mockSelectRows([{ id: entryId }]);
    await expect(isBuildPairAllowed('Apex', 'APEX')).resolves.toBe(true);
    expect(chain.from).toHaveBeenCalledWith(buildAllowlist);
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns false when no row matches', async () => {
    mockSelectRows([]);
    await expect(isBuildPairAllowed('Apex', 'other')).resolves.toBe(false);
  });

  it('returns false for blank input without querying', async () => {
    await expect(isBuildPairAllowed('Apex', '  ')).resolves.toBe(false);
    await expect(isBuildPairAllowed('', 'Apex')).resolves.toBe(false);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('reads the database on every call (no cache)', async () => {
    mockSelectRows([{ id: entryId }]);
    await isBuildPairAllowed('Apex', 'Apex');
    mockSelectRows([]);
    await expect(isBuildPairAllowed('Apex', 'Apex')).resolves.toBe(false);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });
});

describe('addBuildAllowlistEntry (PBI-002 AC-0, AC-1)', () => {
  it('VT-01 stores the canonical repository name and writes an added audit row in one transaction', async () => {
    mockListConfigs.mockResolvedValue([config('Apex')]);
    const { inserts } = mockTransaction();

    const entry = await addBuildAllowlistEntry({ project: 'Apex', repository: ' apex ', actor });

    expect(entry).toEqual(entryRow);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([
      { table: buildAllowlist, values: { project: 'Apex', repository: 'Apex', createdBy: 'Ada Admin' } },
      {
        table: buildAllowlistAudit,
        values: { action: 'added', project: 'Apex', repository: 'Apex', actorId: 'oid-admin', actorLabel: 'Ada Admin' },
      },
    ]);
  });

  it('accepts a GitHub repository configured for the project', async () => {
    mockListConfigs.mockResolvedValue([config('org/web', 'github')]);
    const { inserts } = mockTransaction({ insertedEntry: { ...entryRow, repository: 'org/web' } });
    await addBuildAllowlistEntry({ project: 'Apex', repository: 'ORG/web', actor });
    expect(inserts[0]).toEqual({ table: buildAllowlist, values: { project: 'Apex', repository: 'org/web', createdBy: 'Ada Admin' } });
  });

  it('VT-03 refuses a repository the project does not configure and saves nothing', async () => {
    mockListConfigs.mockResolvedValue([config('Apex')]);
    await expect(addBuildAllowlistEntry({ project: 'Apex', repository: 'Other', actor })).rejects.toMatchObject({
      name: 'BuildAccessError',
      kind: 'INVALID',
      message: 'That repository is not configured for this project.',
    });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('VT-03 refuses blank input and saves nothing', async () => {
    await expect(addBuildAllowlistEntry({ project: 'Apex', repository: ' ', actor })).rejects.toMatchObject({ kind: 'INVALID' });
    await expect(addBuildAllowlistEntry({ project: '', repository: 'Apex', actor })).rejects.toMatchObject({ kind: 'INVALID' });
    expect(mockListConfigs).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('VT-03 maps a unique violation to DUPLICATE', async () => {
    mockListConfigs.mockResolvedValue([config('Apex')]);
    mockTransaction({ failOn: 'entry', error: Object.assign(new Error('dup'), { code: '23505' }) });
    await expect(addBuildAllowlistEntry({ project: 'Apex', repository: 'Apex', actor })).rejects.toMatchObject({
      kind: 'DUPLICATE',
      message: 'That repository is already approved for builds in this project.',
    });
  });

  it('maps a unique violation wrapped in a cause to DUPLICATE', async () => {
    mockListConfigs.mockResolvedValue([config('Apex')]);
    mockTransaction({ failOn: 'entry', error: Object.assign(new Error('query failed'), { cause: { code: '23505' } }) });
    await expect(addBuildAllowlistEntry({ project: 'Apex', repository: 'Apex', actor })).rejects.toMatchObject({ kind: 'DUPLICATE' });
  });

  it('rethrows when the audit insert fails, so the transaction rolls back', async () => {
    mockListConfigs.mockResolvedValue([config('Apex')]);
    mockTransaction({ failOn: 'audit', error: new Error('audit down') });
    await expect(addBuildAllowlistEntry({ project: 'Apex', repository: 'Apex', actor })).rejects.toThrow('audit down');
  });
});

describe('removeBuildAllowlistEntry (PBI-002 AC-2)', () => {
  it('VT-04 deletes the entry and writes a removed audit row', async () => {
    const { inserts, deletes } = mockTransaction();
    await removeBuildAllowlistEntry(entryId, actor);
    expect(deletes).toEqual([buildAllowlist]);
    expect(inserts).toEqual([
      {
        table: buildAllowlistAudit,
        values: { action: 'removed', project: 'Apex', repository: 'Apex', actorId: 'oid-admin', actorLabel: 'Ada Admin' },
      },
    ]);
  });

  it('VT-04 the pair check refuses immediately after removal', async () => {
    mockTransaction();
    await removeBuildAllowlistEntry(entryId, actor);
    mockSelectRows([]);
    await expect(isBuildPairAllowed('Apex', 'Apex')).resolves.toBe(false);
  });

  it('throws NOT_FOUND when the entry does not exist and writes no audit row', async () => {
    const { inserts } = mockTransaction({ deleted: null });
    await expect(removeBuildAllowlistEntry(entryId, actor)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    expect(inserts).toEqual([]);
  });

  it('throws INVALID for a malformed id without touching the database', async () => {
    await expect(removeBuildAllowlistEntry('nope', actor)).rejects.toMatchObject({ kind: 'INVALID' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('listBuildAllowlist returns mapped entries', async () => {
    mockSelectRows([entryRow]);
    await expect(listBuildAllowlist()).resolves.toEqual([entryRow]);
  });

  it('listAllowedRepositoriesForProject returns repository names', async () => {
    mockSelectRows([{ repository: 'Apex' }, { repository: 'Web' }]);
    await expect(listAllowedRepositoriesForProject('Apex')).resolves.toEqual(['Apex', 'Web']);
  });

  it('listCandidateRepositories returns unique, sorted, non-blank repositories of any provider', async () => {
    mockListConfigs.mockResolvedValue([config('Web'), config('org/api', 'github'), config('Apex'), config('web'), config(' ')]);
    await expect(listCandidateRepositories('Apex')).resolves.toEqual(['Apex', 'org/api', 'Web']);
  });

  it('listCandidateRepositories returns nothing for a blank project', async () => {
    await expect(listCandidateRepositories(' ')).resolves.toEqual([]);
    expect(mockListConfigs).not.toHaveBeenCalled();
  });

  it('exposes no update or delete path for audit rows (VT-16)', () => {
    const exported = Object.keys(buildAccessService);
    expect(exported.filter((name) => /audit/i.test(name))).toEqual([]);
  });

  it('BuildAccessError carries its kind', () => {
    const err = new BuildAccessError('DUPLICATE', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('DUPLICATE');
  });
});
