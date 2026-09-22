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
    update: () => ({ set: () => ({ where: jest.fn().mockResolvedValue(undefined) }) }),
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

beforeEach(() => {
  jest.clearAllMocks();
  findFirstDefinition.mockResolvedValue(DEFINITION);
  findFirstVersion.mockResolvedValue({ id: 'version-7', versionNumber: 7, graph: GRAPH });
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

    expect(result).toEqual({ runId: 'run-1', status: 'running' });
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
