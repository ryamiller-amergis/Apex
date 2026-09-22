/**
 * PBI-001 — starting a run.
 *
 * Covers VT-07 (no published version means no run row) and the dispatch table's agreement with the
 * registry. VT-05 and VT-08 exercise the route and its guard, and VT-06 needs the background lane
 * genuinely at its cap, so those live in the integration suite.
 *
 * VT-07 is the one with teeth. "Refused" is easy; "zero run rows written" is the part a plausible
 * implementation gets wrong, by inserting the run and then marking it failed.
 */
const insertValues = jest.fn();
const findFirstDefinition = jest.fn();
const findFirstVersion = jest.fn();
const updateTable = jest.fn();

// The real playbookSteps barrel is required below for the dispatch-table check, which reaches the
// cursor-agent adapter and through it chatAgentService. Stubbed so that pulls in no pool.
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      playbookDefinitions: { findFirst: (...a: unknown[]) => findFirstDefinition(...a) },
      playbookDefinitionVersions: { findFirst: (...a: unknown[]) => findFirstVersion(...a) },
    },
    insert: () => ({ values: (v: unknown) => ({ returning: () => insertValues(v) }) }),
    update: (table: unknown) => {
      updateTable(table);
      return { set: () => ({ where: jest.fn().mockResolvedValue(undefined) }) };
    },
  },
}));

const assertActiveRunCapacity = jest.fn().mockResolvedValue(undefined);

/*
 * The engine is stubbed. Which node runs first, what a step body does, and what happens when one
 * throws are all the engine's behaviour now, proven against a live store in
 * `playbook-run-start.integration.test.ts`. This file is about `startRun`'s own rules — finding the
 * definition, pinning the version, admission, and what is written before the engine is involved.
 */
const beginRun = jest.fn();
jest.mock('../services/playbookAdvanceService', () => ({
  beginRun: (...a: unknown[]) => beginRun(...a),
}));

/*
 * The admission guard counts rows, which this suite's hand-rolled `db` double does not model. Its
 * own behaviour is covered by playbookGuards.test.ts and the integration suite; what matters here
 * is only that `startRun` calls it, asserted below.
 */
jest.mock('../services/playbookGuardService', () => ({
  ...jest.requireActual('../services/playbookGuardService'),
  assertActiveRunCapacity: (...a: unknown[]) => assertActiveRunCapacity(...a),
}));

import {
  PlaybookDefinitionNotFoundError,
  PlaybookEmptyGraphError,
  PlaybookNoPublishedVersionError,
  PlaybookVersionPinNotFoundError,
  PlaybookVersionPinNotPublishedError,
  PlaybookVersionPinReasonRequiredError,
  resolveRunnableVersion,
  startRun,
} from '../services/playbookRunService';
import { adapterStepTypes, listStepTypeDescriptors } from '../services/playbookSteps';

const PROJECT = 'Apex';
const DEFINITION = { id: 'def-1', project: PROJECT, name: 'Draft and approve' };
const INITIATOR = 'initiator-oid';

const GRAPH = {
  nodes: [
    { id: 'draft', stepType: 'cursor-agent', config: { skillPath: 's', prompt: 'p' } },
    { id: 'approve', stepType: 'approval-gate' },
  ],
  edges: [{ from: 'draft', to: 'approve' }],
};

/** An older published version a caller may pin deliberately, per TBI-031 (c). */
const PINNED_VERSION = {
  id: 'version-3',
  definitionId: 'def-1',
  versionNumber: 3,
  status: 'published',
  graph: GRAPH,
};

/*
 * Flattens a Drizzle condition into the column names and bound values it mentions, which is how
 * the version-selection tests below assert *what was asked of the database* rather than only what
 * the double was told to answer. Without this, a resolver that ignored `status` entirely would
 * still pass, because the mock hands back whatever it was given.
 */
const sqlTerms = (node: unknown): string[] => {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap(sqlTerms);
  if (typeof node !== 'object') return [String(node)];
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return sqlTerms(record.queryChunks);
  if (typeof record.name === 'string') return [record.name];
  if ('value' in record) return sqlTerms(record.value);
  return [];
};

const versionQueryTerms = (): string[] => {
  const [args] = findFirstVersion.mock.calls[0] as [{ where?: unknown; orderBy?: unknown }];
  return [...sqlTerms(args.where), ...sqlTerms(args.orderBy)];
};

beforeEach(() => {
  jest.clearAllMocks();
  findFirstDefinition.mockResolvedValue(DEFINITION);
  findFirstVersion.mockResolvedValue({
    id: 'version-7',
    definitionId: 'def-1',
    versionNumber: 7,
    status: 'published',
    graph: GRAPH,
  });
  insertValues.mockResolvedValue([{ id: 'run-1' }]);
  beginRun.mockResolvedValue({ advanced: true, endedAs: 'suspended' });
  assertActiveRunCapacity.mockResolvedValue(undefined);
});

describe('VT-16 — the active-run cap is enforced at admission', () => {
  it('checks capacity for the run’s project before writing anything', async () => {
    await startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR });

    expect(assertActiveRunCapacity).toHaveBeenCalledWith(PROJECT);
  });

  it('writes no run row when the cap refuses', async () => {
    assertActiveRunCapacity.mockRejectedValue(new Error('at its cap of 5'));

    await expect(
      startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow(/cap of 5/);

    // Same reasoning as VT-07: a run that was refused admission should leave nothing to explain.
    expect(insertValues).not.toHaveBeenCalled();
    expect(beginRun).not.toHaveBeenCalled();
  });
});

describe('VT-07 — a definition with no published version', () => {
  it('refuses, naming the missing published version', async () => {
    findFirstVersion.mockResolvedValue(undefined);

    await expect(
      startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow(PlaybookNoPublishedVersionError);
  });

  it('writes zero run rows', async () => {
    findFirstVersion.mockResolvedValue(undefined);

    await startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
    }).catch(() => undefined);

    // Not "inserted then marked failed". A row that exists only to record its own rejection would
    // appear in the status view and count against the active-run cap FEAT-005 adds.
    expect(insertValues).not.toHaveBeenCalled();
    expect(beginRun).not.toHaveBeenCalled();
  });

  it('names the Playbook, so the message says what to publish', async () => {
    findFirstVersion.mockResolvedValue(undefined);

    await expect(
      startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow(/Draft and approve/);
  });
});

describe('starting a run', () => {
  it('pins the published version and records the initiator', async () => {
    const result = await startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
    });

    // TBI-031: the resolved version is part of the answer, so the caller knows what it started.
    expect(result).toEqual({
      runId: 'run-1',
      status: 'running',
      definitionVersionId: 'version-7',
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        project: PROJECT,
        // BR-006: editing the Playbook afterwards cannot change what this run does.
        definitionVersionId: 'version-7',
        initiatorUserId: INITIATOR,
        status: 'running',
      })
    );
  });

  /*
   * Which node runs first is the engine's decision now, so this asserts the handover instead: the
   * engine is given the pinned graph, the run's own id, and the initiator it must act as.
   *
   * The graph is passed rather than the version id deliberately. `startRun` has already read the
   * version row, and handing the engine an id to look up again would put Apex's schema inside the
   * one directory that exists to be free of it.
   */
  it('hands the engine the pinned graph, the run id and the initiator', async () => {
    await startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR });

    expect(beginRun).toHaveBeenCalledWith({
      runId: 'run-1',
      project: PROJECT,
      initiatorUserId: INITIATOR,
      definitionVersionId: 'version-7',
      graph: GRAPH,
    });
  });

  it('refuses a definition from another project', async () => {
    findFirstDefinition.mockResolvedValue(undefined);

    await expect(
      startRun({ project: 'SomeOtherProject', definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow(PlaybookDefinitionNotFoundError);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('refuses a published version with no steps', async () => {
    findFirstVersion.mockResolvedValue({ id: 'v', graph: { nodes: [], edges: [] } });

    await expect(
      startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow(PlaybookEmptyGraphError);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('keeps the run row when the first step fails, and surfaces why', async () => {
    beginRun.mockResolvedValue({
      advanced: true,
      endedAs: 'failed',
      error: new Error('admission refused'),
    });

    await expect(
      startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR })
    ).rejects.toThrow('admission refused');

    /*
     * Unlike the no-version case, this run really did start: it has a pinned version and a step
     * that failed, and the status view should be able to show why. Rethrowing is what turns a
     * first-step failure into a response the caller can act on rather than a 201 for a dead run —
     * the step and run rows are already marked failed by the time this is reached.
     */
    expect(insertValues).toHaveBeenCalledTimes(1);
  });
});

/*
 * TBI-031 — which version a new run gets, and what a caller must say to override it.
 *
 * The refusals are the load-bearing half. Every one of them has to happen before the capacity
 * check and the run insert, for the same reason VT-07 does: a run row that exists only to record
 * its own rejection counts against the project's active-run cap and has to be explained to whoever
 * reads the status view.
 */
describe('VT-12 — an unpinned start resolves the current published version', () => {
  it('asks for the highest-numbered published version of this definition (TBI-031 DoD-2)', async () => {
    await startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR });

    const terms = versionQueryTerms();
    // Deprecated, archived and draft rows are excluded by the status term, not by luck of ordering.
    expect(terms).toEqual(expect.arrayContaining(['definition_id', 'def-1', 'status', 'published']));
    expect(terms).toEqual(expect.arrayContaining(['version_number']));
    expect(terms.join(' ')).toMatch(/desc/i);
  });

  it('stores no pin reason (TBI-031 DoD-2)', async () => {
    await startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ definitionVersionId: 'version-7', versionPinReason: null })
    );
  });

  it('stores no pin reason when a reason arrives without a version (TBI-031 DoD-2)', async () => {
    await startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
      versionPinReason: 'stated, but nothing was pinned',
    });

    // A reason with no version pinned nothing, so there is nothing to document.
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ versionPinReason: null })
    );
  });

  it('resolves through the definition, returning both (TBI-031 (a))', async () => {
    const resolution = await resolveRunnableVersion({ project: PROJECT, definitionId: 'def-1' });

    expect(resolution.definition).toEqual(expect.objectContaining({ id: 'def-1', name: 'Draft and approve' }));
    expect(resolution.version).toEqual(expect.objectContaining({ id: 'version-7' }));
    expect(resolution.versionPinReason).toBeNull();
  });
});

describe('VT-13 — resolution never crosses a project boundary (TBI-031 DoD-1/3)', () => {
  it('refuses a pinned start against another project’s definition before reading any version', async () => {
    findFirstDefinition.mockResolvedValue(undefined);

    await expect(
      startRun({
        project: 'SomeOtherProject',
        definitionId: 'def-1',
        initiatorUserId: INITIATOR,
        definitionVersionId: 'version-3',
        versionPinReason: 'trigger subscription',
      })
    ).rejects.toThrow(PlaybookDefinitionNotFoundError);

    expect(findFirstVersion).not.toHaveBeenCalled();
    expect(assertActiveRunCapacity).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('looks a pinned version up through the project-scoped definition, not by id alone', async () => {
    findFirstVersion.mockResolvedValue(PINNED_VERSION);

    await startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
      definitionVersionId: 'version-3',
      versionPinReason: 'trigger subscription',
    });

    const terms = versionQueryTerms();
    expect(terms).toEqual(expect.arrayContaining(['id', 'version-3', 'definition_id', 'def-1']));
    /*
     * Deliberately not filtered to published: a deprecated pin has to come back so the caller is
     * told the version is deprecated rather than told it does not exist.
     */
    expect(terms).not.toContain('published');
  });
});

describe('VT-14 — an explicit pin with a documented reason (TBI-031 (c))', () => {
  beforeEach(() => {
    findFirstVersion.mockResolvedValue(PINNED_VERSION);
  });

  const pinnedStart = () =>
    startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
      definitionVersionId: 'version-3',
      versionPinReason: '  Trigger subscription still targets v3  ',
    });

  it('pins that exact version and returns it', async () => {
    await expect(pinnedStart()).resolves.toEqual({
      runId: 'run-1',
      status: 'running',
      definitionVersionId: 'version-3',
    });
  });

  it('stores the reason trimmed', async () => {
    await pinnedStart();

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionVersionId: 'version-3',
        versionPinReason: 'Trigger subscription still targets v3',
      })
    );
  });

  it('hands the engine the pinned version’s graph', async () => {
    await pinnedStart();

    expect(beginRun).toHaveBeenCalledWith(
      expect.objectContaining({ definitionVersionId: 'version-3', graph: GRAPH })
    );
  });
});

describe('VT-15 — a pin that cannot be honoured is refused before the run exists (TBI-031 (d))', () => {
  const pinnedStart = (overrides: { definitionVersionId?: string; versionPinReason?: string }) =>
    startRun({
      project: PROJECT,
      definitionId: 'def-1',
      initiatorUserId: INITIATOR,
      definitionVersionId: 'version-3',
      ...overrides,
    });

  const wroteNothing = () => {
    expect(assertActiveRunCapacity).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(beginRun).not.toHaveBeenCalled();
  };

  it.each([
    ['omitted', undefined],
    ['blank', '   '],
  ])('refuses a pin whose reason is %s', async (_label, versionPinReason) => {
    findFirstVersion.mockResolvedValue(PINNED_VERSION);

    await expect(pinnedStart({ versionPinReason })).rejects.toThrow(
      PlaybookVersionPinReasonRequiredError
    );
    wroteNothing();
  });

  it('says what to supply when the reason is missing', async () => {
    await expect(pinnedStart({ versionPinReason: undefined })).rejects.toThrow(
      /versionPinReason/
    );
  });

  it.each(['deprecated', 'archived', 'draft'])(
    'refuses a pin to a %s version, naming its status',
    async (status) => {
      findFirstVersion.mockResolvedValue({ ...PINNED_VERSION, status });

      const attempt = pinnedStart({ versionPinReason: 'trigger subscription' });
      await expect(attempt).rejects.toThrow(PlaybookVersionPinNotPublishedError);
      await expect(attempt).rejects.toThrow(new RegExp(status));
      wroteNothing();
    }
  );

  it('refuses a pin to a version of another definition or project', async () => {
    // The project-scoped, definition-scoped lookup simply does not find it.
    findFirstVersion.mockResolvedValue(undefined);

    const attempt = pinnedStart({ versionPinReason: 'trigger subscription' });
    await expect(attempt).rejects.toThrow(PlaybookVersionPinNotFoundError);
    await expect(attempt).rejects.toThrow(/Draft and approve/);
    wroteNothing();
  });

  it('refuses a pin to a version with an empty graph', async () => {
    findFirstVersion.mockResolvedValue({ ...PINNED_VERSION, graph: { nodes: [], edges: [] } });

    await expect(pinnedStart({ versionPinReason: 'trigger subscription' })).rejects.toThrow(
      PlaybookEmptyGraphError
    );
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe('VT-16 — starting a run leaves existing runs and their pins alone (BR-006)', () => {
  it('writes one new run row and updates nothing', async () => {
    await startRun({ project: PROJECT, definitionId: 'def-1', initiatorUserId: INITIATOR });

    expect(insertValues).toHaveBeenCalledTimes(1);
    // Resolution reads versions; it never rewrites a version another run is already pinned to.
    expect(updateTable).not.toHaveBeenCalled();
  });
});

describe('every registered step type can actually run', () => {
  it('has an adapter for each descriptor, and no adapter without one', () => {
    // A descriptor with no adapter fails the moment a run reaches it, which is the worst place to
    // find a wiring mistake.
    expect([...adapterStepTypes()].sort()).toEqual(
      listStepTypeDescriptors()
        .map((d) => d.stepType)
        .sort()
    );
  });
});
