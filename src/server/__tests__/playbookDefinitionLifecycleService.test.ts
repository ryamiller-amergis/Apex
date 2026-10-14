/**
 * FEAT-007 Wave 2 Bundle B / S3 — retained-draft definition lifecycle.
 *
 * These tests use a stateful Drizzle transaction double: writes are staged while the callback
 * runs and become observable only when it resolves. That makes VT-07 prove the rollback contract,
 * rather than merely checking that `db.transaction` happened to be called.
 */
const selectResults: unknown[][] = [];
const insertResults: Array<unknown[] | Error> = [];
const updateResults: Array<unknown[] | Error> = [];
const committedWrites: Array<{ kind: 'insert' | 'update'; values: unknown }> =
  [];

const selectMock = jest.fn();
const insertMock = jest.fn();
const updateMock = jest.fn();
const transactionMock = jest.fn();

function nextResult(queue: Array<unknown[] | Error>): unknown[] {
  const result = queue.shift() ?? [];
  if (result instanceof Error) throw result;
  return result;
}

function selectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'from',
    'innerJoin',
    'where',
    'orderBy',
    'limit',
    'for',
  ]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (rows: unknown[]) => unknown,
    reject: (error: unknown) => unknown
  ) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
  return chain;
}

function makeTransactionDb(
  stagedWrites: Array<{ kind: 'insert' | 'update'; values: unknown }>
) {
  return {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => {
      insertMock(...args);
      return {
        values: (values: unknown) => ({
          returning: async () => {
            stagedWrites.push({ kind: 'insert' as const, values });
            return nextResult(insertResults);
          },
        }),
      };
    },
    update: (...args: unknown[]) => {
      updateMock(...args);
      return {
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              stagedWrites.push({ kind: 'update' as const, values });
              return nextResult(updateResults);
            },
          }),
        }),
      };
    },
  };
}

jest.mock('drizzle-orm', () => ({
  and: jest.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  desc: jest.fn((column: unknown) => ({ op: 'desc', column })),
  eq: jest.fn((column: unknown, value: unknown) => ({
    op: 'eq',
    column,
    value,
  })),
  inArray: jest.fn((column: unknown, values: unknown[]) => ({
    op: 'inArray',
    column,
    values,
  })),
  ne: jest.fn((column: unknown, value: unknown) => ({
    op: 'ne',
    column,
    value,
  })),
}));

jest.mock('../db/schema', () => ({
  playbookDefinitions: {
    id: 'definitions.id',
    project: 'definitions.project',
    name: 'definitions.name',
    createdAt: 'definitions.createdAt',
    updatedAt: 'definitions.updatedAt',
  },
  playbookDefinitionVersions: {
    id: 'versions.id',
    definitionId: 'versions.definitionId',
    versionNumber: 'versions.versionNumber',
    status: 'versions.status',
    updatedAt: 'versions.updatedAt',
  },
}));

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    query: { playbookDefinitionVersions: { findFirst: jest.fn() } },
    transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

const assertGraphWithinGuards = jest.fn();
jest.mock('../services/playbookGuardService', () => ({
  assertGraphWithinGuards: (...args: unknown[]) =>
    assertGraphWithinGuards(...args),
}));

import {
  createDefinition,
  deprecateVersion,
  getDefinitionDetail,
  PlaybookDraftConflictError,
  PlaybookVersionTransitionError,
  publishDraft,
  updateDraft,
} from '../services/playbookDefinitionService';

const PROJECT = 'Apex';
const DEFINITION_ID = 'def-1';
const DRAFT_ID = 'draft-1';
const EXPECTED_REVISION = '2026-09-22T12:00:00.000Z';
const NEXT_REVISION = '2026-09-22T12:01:00.000Z';
const GRAPH = {
  nodes: [{ id: 'notify', stepType: 'notify' }],
  edges: [],
};

const DEFINITION = {
  id: DEFINITION_ID,
  project: PROJECT,
  name: 'Design validation',
  description: null,
  createdBy: 'author-1',
  createdAt: EXPECTED_REVISION,
  updatedAt: EXPECTED_REVISION,
};

const DRAFT = {
  id: DRAFT_ID,
  definitionId: DEFINITION_ID,
  versionNumber: 1,
  graph: GRAPH,
  status: 'draft',
  publishedBy: null,
  publishedAt: null,
  createdAt: EXPECTED_REVISION,
  updatedAt: EXPECTED_REVISION,
};

beforeEach(() => {
  jest.clearAllMocks();
  selectResults.length = 0;
  insertResults.length = 0;
  updateResults.length = 0;
  committedWrites.length = 0;
  selectMock.mockImplementation(() => selectChain());
  transactionMock.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedWrites: Array<{
        kind: 'insert' | 'update';
        values: unknown;
      }> = [];
      const result = await callback(makeTransactionDb(stagedWrites));
      committedWrites.push(...stagedWrites);
      return result;
    }
  );
});

describe('TBI-030 DoD-1 / VT-01 — one retained draft', () => {
  it('creates a definition with exactly one draft candidate', async () => {
    insertResults.push([DEFINITION], [DRAFT]);

    const result = await createDefinition({
      project: PROJECT,
      name: DEFINITION.name,
      description: null,
      graph: GRAPH,
      createdByUserId: 'author-1',
    });

    expect(result.draft.nextVersionNumber).toBe(1);
    expect(
      committedWrites.filter((write) => write.kind === 'insert')
    ).toHaveLength(2);
  });

  it('AC-0 saves graph and definition metadata without inserting another version row', async () => {
    const renamed = {
      ...DEFINITION,
      name: 'Renamed',
      updatedAt: NEXT_REVISION,
    };
    const savedDraft = {
      ...DRAFT,
      graph: { nodes: [], edges: [] },
      updatedAt: NEXT_REVISION,
    };
    selectResults.push([DEFINITION], [DRAFT]);
    updateResults.push([renamed], [savedDraft]);

    const result = await updateDraft({
      project: PROJECT,
      definitionId: DEFINITION_ID,
      name: 'Renamed',
      description: null,
      graph: savedDraft.graph,
      expectedDraftUpdatedAt: EXPECTED_REVISION,
    });

    expect(result.draft.graph).toEqual(savedDraft.graph);
    expect(insertMock).not.toHaveBeenCalled();
    expect(committedWrites).toHaveLength(2);
  });

  it('VT-01 rejects a stale draft save before metadata or graph changes', async () => {
    selectResults.push([DEFINITION], [{ ...DRAFT, updatedAt: NEXT_REVISION }]);

    await expect(
      updateDraft({
        project: PROJECT,
        definitionId: DEFINITION_ID,
        name: 'Stale rename',
        description: null,
        graph: { nodes: [], edges: [] },
        expectedDraftUpdatedAt: EXPECTED_REVISION,
      })
    ).rejects.toThrow(PlaybookDraftConflictError);

    expect(committedWrites).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('TBI-030 DoD-2 / PBI-006 AC-0 / VT-02 — copy-on-publish', () => {
  it('locks and advances candidate N, then inserts the exact immutable copy at N', async () => {
    const advancedDraft = {
      ...DRAFT,
      versionNumber: 2,
      updatedAt: NEXT_REVISION,
    };
    const published = {
      ...DRAFT,
      id: 'published-1',
      status: 'published',
      publishedBy: 'publisher-1',
      publishedAt: NEXT_REVISION,
    };
    selectResults.push([DRAFT]);
    updateResults.push([advancedDraft]);
    insertResults.push([published]);

    const result = await publishDraft({
      project: PROJECT,
      definitionId: DEFINITION_ID,
      publishedByUserId: 'publisher-1',
      expectedDraftUpdatedAt: EXPECTED_REVISION,
    });

    expect(assertGraphWithinGuards).toHaveBeenCalledWith(GRAPH);
    expect(result.publishedVersion).toEqual(
      expect.objectContaining({
        id: 'published-1',
        versionNumber: 1,
        status: 'published',
      })
    );
    expect(result.draft.nextVersionNumber).toBe(2);
    expect(committedWrites[0]).toEqual({
      kind: 'update',
      values: expect.objectContaining({ versionNumber: 2 }),
    });
    expect(committedWrites[1]).toEqual({
      kind: 'insert',
      values: expect.objectContaining({
        definitionId: DEFINITION_ID,
        versionNumber: 1,
        graph: GRAPH,
        status: 'published',
        publishedBy: 'publisher-1',
      }),
    });
  });

  it('VT-06 gives a stale concurrent publish a conflict and writes no duplicate', async () => {
    selectResults.push([{ ...DRAFT, updatedAt: NEXT_REVISION }]);

    await expect(
      publishDraft({
        project: PROJECT,
        definitionId: DEFINITION_ID,
        publishedByUserId: 'publisher-2',
        expectedDraftUpdatedAt: EXPECTED_REVISION,
      })
    ).rejects.toThrow(PlaybookDraftConflictError);

    expect(committedWrites).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('PBI-006 AC-1 / VT-03 returns the guard error and commits no writes', async () => {
    selectResults.push([DRAFT]);
    assertGraphWithinGuards.mockImplementationOnce(() => {
      throw new Error('graph contains a loop');
    });

    await expect(
      publishDraft({
        project: PROJECT,
        definitionId: DEFINITION_ID,
        publishedByUserId: 'publisher-1',
        expectedDraftUpdatedAt: EXPECTED_REVISION,
      })
    ).rejects.toThrow('graph contains a loop');

    expect(committedWrites).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('VT-07 rolls back the draft advance when the immutable-copy insert fails', async () => {
    selectResults.push([DRAFT]);
    updateResults.push([
      { ...DRAFT, versionNumber: 2, updatedAt: NEXT_REVISION },
    ]);
    insertResults.push(new Error('injected insert failure'));

    await expect(
      publishDraft({
        project: PROJECT,
        definitionId: DEFINITION_ID,
        publishedByUserId: 'publisher-1',
        expectedDraftUpdatedAt: EXPECTED_REVISION,
      })
    ).rejects.toThrow('injected insert failure');

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(committedWrites).toEqual([]);
  });
});

describe('PBI-006 AC-2 / BR-006 / VT-04 — immutable history', () => {
  it('lists the original published graph after the retained draft changes', async () => {
    const editedDraft = {
      ...DRAFT,
      versionNumber: 2,
      graph: { nodes: [], edges: [] },
    };
    const published = { ...DRAFT, id: 'published-1', status: 'published' };
    selectResults.push([DEFINITION], [editedDraft, published]);

    const detail = await getDefinitionDetail(PROJECT, DEFINITION_ID);

    expect(detail.draft.graph).toEqual(editedDraft.graph);
    expect(detail.versions).toEqual([
      expect.objectContaining({ id: 'published-1', versionNumber: 1 }),
    ]);
  });
});

describe('TBI-030 DoD-3 / VT-08 — scoped deprecation', () => {
  it('deprecates only the selected published version and preserves older published rows', async () => {
    const version2 = {
      ...DRAFT,
      id: 'published-2',
      versionNumber: 2,
      status: 'published',
    };
    const deprecated = { ...version2, status: 'deprecated' };
    selectResults.push([version2], [{ id: 'published-1' }]);
    updateResults.push([deprecated]);

    const result = await deprecateVersion({
      project: PROJECT,
      definitionId: DEFINITION_ID,
      versionId: 'published-2',
    });

    expect(result.version.status).toBe('deprecated');
    expect(result.currentPublishedVersionId).toBe('published-1');
    expect(committedWrites).toEqual([
      { kind: 'update', values: { status: 'deprecated' } },
    ]);
  });

  it('rejects draft deprecation and cross-project/missing versions without writing', async () => {
    selectResults.push([DRAFT]);
    await expect(
      deprecateVersion({
        project: PROJECT,
        definitionId: DEFINITION_ID,
        versionId: DRAFT_ID,
      })
    ).rejects.toThrow(PlaybookVersionTransitionError);

    selectResults.push([]);
    await expect(
      deprecateVersion({
        project: 'Other project',
        definitionId: DEFINITION_ID,
        versionId: 'published-1',
      })
    ).rejects.toThrow(/not found/i);

    expect(committedWrites).toEqual([]);
  });
});
