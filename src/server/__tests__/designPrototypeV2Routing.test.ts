/**
 * Routing tests for the `ai-runs-v2-transport` split in designPrototypeService.
 *
 * The three routing seams (flag evaluation, V2 admission, in-process
 * generation) are injected, so these tests exercise the real dispatch logic
 * rather than a mocked copy of it. The Drizzle `db` and the design-context
 * readers are mocked because they reach Azure DevOps and the filesystem.
 */

jest.mock('../db/drizzle', () => {
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        prds: { findFirst: jest.fn() },
        designPlans: { findFirst: jest.fn() },
        designPrototypes: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

// No active target grounding in a unit test, so no bare mirror and no
// repository source — the specification still carries everything else.
jest.mock('../services/runGroundingService', () => ({
  resolveRunGroundingSurface: jest.fn().mockResolvedValue(null),
  runGroundingService: { getGroundings: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/designSystemService', () => ({
  getDesignSystemCatalog: jest.fn().mockResolvedValue({ routes: [], componentNames: [] }),
  getScreenInventory: jest.fn().mockResolvedValue([]),
  componentIndexPaths: jest.fn().mockReturnValue(['/src/client/components']),
  isComponentSourcePath: jest.fn().mockReturnValue(true),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn().mockReturnValue('primary.main: #323695'),
}));

jest.mock('../services/figmaReferenceService', () => ({
  getFigmaReference: jest.fn().mockReturnValue({ navItems: [{ label: 'Home', route: '/' }] }),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
}));

import type { AdmitV2RunResult } from '../services/aiRunV2/v2AdmissionService';
import { generatePrototypesForPrd } from '../services/designPrototypeService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const DISPATCHED: AdmitV2RunResult = {
  status: 'dispatched',
  runId: 'run-1',
  attemptId: 'attempt-1',
  attemptNumber: 1,
  dispatchMessageId: 'dispatch-1',
  outboxId: 'outbox-1',
};

/** Two features that each need a prototype, plus the rows the insert returns. */
function arrangePrd(features: unknown[] = twoUiFeatures()): void {
  mockDb.query.prds.findFirst.mockResolvedValue({
    id: 'prd-1',
    project: 'Apex',
    authorId: 'user-1',
    skillSettingsId: null,
    backlogJson: { features },
  });
  mockDb.query.designPlans.findFirst.mockResolvedValue(undefined);
  mockDb.query.designPrototypes.findFirst.mockResolvedValue(undefined);

  let created = 0;
  mockDb.insert.mockImplementation(() => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockImplementation(async () => {
      created += 1;
      return [{ id: `prototype-${created}` }];
    }),
  }));
}

function twoUiFeatures(): unknown[] {
  return [
    { title: 'Standup summary', items: [{ type: 'PBI', title: 'Show the summary' }] },
    { title: 'Standup history', items: [{ type: 'PBI', title: 'List past standups' }] },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generatePrototypesForPrd V2 transport routing', () => {
  it('admits one visual-lane V2 run per pending prototype when the flag is on', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).toHaveBeenCalledTimes(2);
    expect(admitV2Run.mock.calls[0][0].workloadLane).toBe('visual');
    expect(admitV2Run.mock.calls[0][0].projectId).toBe('Apex');
    expect(generateInProcess).not.toHaveBeenCalled();
  });

  it('gives each pending prototype its own run thread', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls.map((call: any[]) => call[0].threadId)).toEqual([
      'prototype:prototype-1',
      'prototype:prototype-2',
    ]);
  });

  it('carries the prompt inputs the visual worker reads', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    const { specification } = admitV2Run.mock.calls[0][0];
    expect(specification.subjectId).toBe('prototype-1');
    expect(specification.promptInputs.featureName).toBe('Standup summary');
    expect(specification.promptInputs.pbiSection).toContain('### PBI 1: Show the summary');
    expect(specification.promptInputs.scopingSection).toContain('NEVER invent content');
    expect(typeof specification.promptInputs.planSection).toBe('string');
  });

  it('keeps in-process generation when the flag is off', async () => {
    arrangePrd();
    const admitV2Run = jest.fn();
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => false,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateInProcess).toHaveBeenCalledTimes(2);
  });

  it('falls back to in-process generation when admission throws', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockRejectedValue(new Error('blob unavailable'));
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(generateInProcess).toHaveBeenCalledTimes(2);
    expect(generateInProcess.mock.calls[0][0]).toBe('prototype-1');
  });

  it('falls back to in-process generation when the thread already has an active run', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue({
      status: 'active_run_conflict',
      existingRunId: 'run-0',
      existingTransportVersion: 'http-files-v1',
      existingStatus: 'running',
    });
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(generateInProcess).toHaveBeenCalledTimes(2);
  });

  it('falls back per prototype rather than abandoning the rest of the batch', async () => {
    arrangePrd();
    const admitV2Run = jest
      .fn()
      .mockRejectedValueOnce(new Error('blob unavailable'))
      .mockResolvedValue(DISPATCHED);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).toHaveBeenCalledTimes(2);
    expect(generateInProcess).toHaveBeenCalledTimes(1);
    expect(generateInProcess.mock.calls[0][0]).toBe('prototype-1');
  });

  it('keeps features that extend an existing page in process', async () => {
    // The specification has no EXTEND scoping section yet: building one needs
    // the existing page source, which only the in-process path fetches.
    arrangePrd([
      {
        title: 'Approval column',
        route: '/timecards',
        items: [{ type: 'PBI', title: 'Add an approval column' }],
      },
    ]);
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateInProcess).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable flag as off', async () => {
    arrangePrd();
    const admitV2Run = jest.fn();
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => {
        throw new Error('flag store unavailable');
      },
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateInProcess).toHaveBeenCalledTimes(2);
  });
});
