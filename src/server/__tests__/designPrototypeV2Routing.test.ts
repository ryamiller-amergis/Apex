/**
 * Routing tests for the `ai-runs-v2-transport` split in designPrototypeService.
 *
 * The three routing seams (flag evaluation, V2 admission, in-process
 * generation) are injected, so these tests exercise the real dispatch logic
 * rather than a mocked copy of it. The Drizzle `db` and the design-context
 * readers are mocked because they reach Azure DevOps and the filesystem.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockPrototypeUpdateWhere = jest.fn();
const mockPrototypeUpdateReturning = jest.fn().mockResolvedValue([]);
const mockSelectWhere = jest.fn().mockResolvedValue([]);

jest.mock('../db/drizzle', () => {
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn((...args: unknown[]) => {
      mockPrototypeUpdateWhere(...args);
      return {
        returning: (...returningArgs: unknown[]) =>
          mockPrototypeUpdateReturning(...returningArgs),
      };
    }),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: (...args: unknown[]) => mockSelectWhere(...args),
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
  fetchExistingPageContext: jest
    .fn()
    .mockResolvedValue('export const Timecards = () => <TimecardGrid />;'),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn().mockReturnValue('primary.main: #323695'),
}));

jest.mock('../services/figmaReferenceService', () => ({
  getFigmaReference: jest.fn().mockReturnValue({ navItems: [{ label: 'Home', route: '/' }] }),
}));

jest.mock('../services/pageScreenshotService', () => ({
  getScreenshotByRoute: jest.fn().mockResolvedValue({
    imageBase64: 'REVG',
    mediaType: 'image/jpeg',
    width: 1280,
    height: 720,
  }),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
}));

// `resolvePrototypeExtendMode` is pure and the dispatch depends on it, so
// only the project lookup — which reads Azure DevOps — is replaced.
jest.mock('../services/prototypeContextService', () => ({
  ...jest.requireActual('../services/prototypeContextService'),
  resolvePrototypeContext: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/webDesignReferenceService', () => ({
  getDesignReferences: jest.fn().mockResolvedValue(''),
}));

import type { AdmitV2RunResult } from '../services/aiRunV2/v2AdmissionService';
import type { PrototypeContext } from '../services/prototypeContextService';
import {
  failStalePrototypes,
  generatePrototypesForPrd,
} from '../services/designPrototypeService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const { resolveSkillConfig: mockResolveSkillConfig } = jest.requireMock(
  '../services/projectSettingsService',
) as { resolveSkillConfig: jest.Mock };

const { resolvePrototypeContext: mockResolvePrototypeContext } = jest.requireMock(
  '../services/prototypeContextService',
) as { resolvePrototypeContext: jest.Mock };

const { getDesignReferences: mockGetDesignReferences } = jest.requireMock(
  '../services/webDesignReferenceService',
) as { getDesignReferences: jest.Mock };

const { getFigmaReference: mockGetFigmaReference } = jest.requireMock(
  '../services/figmaReferenceService',
) as { getFigmaReference: jest.Mock };

const PROJECT_DESIGN_SYSTEM: PrototypeContext = {
  appName: 'Apex',
  designSystemMarkdown: '## Apex tokens',
  isProjectSpecific: true,
};

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
  mockSelectWhere.mockResolvedValue([]);
  mockResolveSkillConfig.mockResolvedValue(null);
  mockResolvePrototypeContext.mockResolvedValue(null);
  mockGetDesignReferences.mockResolvedValue('');
  mockGetFigmaReference.mockReturnValue({ navItems: [{ label: 'Home', route: '/' }] });
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
    expect(admitV2Run.mock.calls[0][0].capacityClass).toBe('batch');
    expect(admitV2Run.mock.calls[0][0].projectId).toBe('Apex');
    expect(admitV2Run.mock.calls[0][0].executionSnapshot).toMatchObject({
      workflowClass: 'design-prototype',
      subjectKind: 'design-prototype',
      subjectId: 'prototype-1',
      generationStartedAt: expect.any(String),
    });
    expect(
      Number.isFinite(
        Date.parse(
          admitV2Run.mock.calls[0][0].executionSnapshot.generationStartedAt,
        ),
      ),
    ).toBe(true);
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

  /**
   * A worker has no database and no App Service environment, so a
   * specification that arrives without a ceiling has nothing to fall back on
   * that could agree with the in-process path. The resolution belongs here,
   * at the boundary, and the specification always carries a concrete number.
   */
  it('carries the resolved ceiling and timeout when the project overrides neither', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls[0][0].specification.model).toEqual({
      modelId: expect.any(String),
      maxTokens: 32_000,
      timeoutMs: 12 * 60_000,
      retry: {
        maxAttempts: 5,
        initialBackoffMs: 2_000,
        backoffMultiplier: 2,
        jitter: true,
      },
    });
  });

  it('carries the project override instead when there is one', async () => {
    arrangePrd();
    mockResolveSkillConfig.mockResolvedValue({
      designPrototypeBedrockMaxTokens: 9_000,
      designPrototypeBedrockTimeoutMs: 90_000,
    });
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls[0][0].specification.model).toMatchObject({
      maxTokens: 9_000,
      timeoutMs: 90_000,
    });
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

  it('falls back after an admission throw only when reconciliation proves rollback', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockRejectedValue(new Error('blob unavailable'));
    const reconcileV2Admission = jest.fn().mockResolvedValue('absent');
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      reconcileV2Admission,
      generateInProcess,
    });

    expect(reconcileV2Admission).toHaveBeenCalledTimes(2);
    expect(generateInProcess).toHaveBeenCalledTimes(2);
    expect(generateInProcess.mock.calls[0][0]).toBe('prototype-1');
  });

  it.each([
    new Error('response lost after commit'),
    Object.assign(new Error('admission timed out'), { code: 'ETIMEDOUT' }),
  ])('does not start V1 when reconciliation finds the committed V2 run', async (error) => {
    arrangePrd([twoUiFeatures()[0]]);
    const admitV2Run = jest.fn().mockRejectedValue(error);
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      reconcileV2Admission,
      generateInProcess,
    });

    expect(reconcileV2Admission).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: admitV2Run.mock.calls[0][0].runId,
        threadId: 'prototype:prototype-1',
        subjectId: 'prototype-1',
      }),
    );
    expect(generateInProcess).not.toHaveBeenCalled();
  });

  it('recognizes a committed intended run through the default database reconciliation', async () => {
    arrangePrd([twoUiFeatures()[0]]);
    let attempted: Record<string, any> | undefined;
    const admitV2Run = jest.fn(async (input) => {
      attempted = input;
      throw new Error('connection closed after commit');
    });
    mockSelectWhere.mockImplementation(async () => [{
      id: attempted?.runId,
      threadId: attempted?.threadId,
      transportVersion: 'servicebus-blob-v2',
      executionSnapshot: attempted?.executionSnapshot,
    }]);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(mockSelectWhere).toHaveBeenCalled();
    expect(generateInProcess).not.toHaveBeenCalled();
  });

  it('does not start V1 for an ambiguous response when the V2 run exists', async () => {
    arrangePrd([twoUiFeatures()[0]]);
    const admitV2Run = jest.fn().mockResolvedValue(undefined);
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      reconcileV2Admission,
      generateInProcess,
    });

    expect(reconcileV2Admission).toHaveBeenCalledTimes(1);
    expect(generateInProcess).not.toHaveBeenCalled();
  });

  it('treats a conflict with the intended deterministic run as admitted', async () => {
    arrangePrd([twoUiFeatures()[0]]);
    const admitV2Run = jest.fn(async (input) => ({
      status: 'active_run_conflict' as const,
      existingRunId: input.runId,
      existingTransportVersion: 'servicebus-blob-v2',
      existingStatus: 'dispatched',
    }));
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      reconcileV2Admission: jest.fn(),
      generateInProcess,
    });

    expect(generateInProcess).not.toHaveBeenCalled();
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

  it('admits an EXTEND feature with its resolved source and page image', async () => {
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

    expect(admitV2Run).toHaveBeenCalledTimes(1);
    expect(generateInProcess).not.toHaveBeenCalled();
    const { specification } = admitV2Run.mock.calls[0][0];
    expect(specification.promptInputs).toMatchObject({
      extendMode: true,
      targetRoute: '/timecards',
      existingPageContext: 'export const Timecards = () => <TimecardGrid />;',
    });
    expect(specification.promptInputs.scopingSection).toContain(
      'EXTEND an existing page',
    );
    expect(specification.designReference.images).toEqual([
      {
        kind: 'existing-page',
        base64: 'REVG',
        mediaType: 'image/jpeg',
        width: 1280,
        height: 720,
      },
    ]);
  });

  it('names the MaxView branch when the project resolves no design system', async () => {
    arrangePrd();
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls[0][0].specification.prototypePrompt).toEqual({
      branch: 'maxview',
    });
  });

  /**
   * `generateDesignPrototypeHtml` takes its project branch whenever
   * `resolvePrototypeContext` returns anything, so admission has to resolve
   * the same thing here — a worker cannot read the project's repository.
   */
  it('carries the design system a project resolved instead of the MaxView prompt', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    const { specification } = admitV2Run.mock.calls[0][0];
    expect(specification.prototypePrompt).toEqual({
      branch: 'project-design-system',
      appName: 'Apex',
      designSystemMarkdown: '## Apex tokens',
      extendMode: false,
    });
    expect(specification.promptInputs.scopingSection).toContain(
      'described in the Design System section below',
    );
  });

  /**
   * The project branch attaches no vision input in process. Carrying the
   * Figma screenshot anyway would put an image in front of the model that
   * the path being replaced never sends.
   */
  it('sends no reference screenshot for a project that has its own design system', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);
    mockGetFigmaReference.mockReturnValue({
      navItems: [{ label: 'Home', route: '/' }],
      tablePageBase64: 'QUJD',
      tablePageWidth: 1024,
      tablePageHeight: 810,
    });
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls[0][0].specification.designReference).toEqual({
      navItems: [],
      images: [],
    });
  });

  it('leaves the MaxView catalog and palette off a project specification', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(admitV2Run.mock.calls[0][0].specification.designSystem).toEqual({
      catalog: undefined,
      screenInventory: undefined,
      colorTokens: undefined,
    });
  });

  /** The search needs a key a worker has no way to hold. */
  it('searches web references on this side when the project turned them on', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);
    mockResolveSkillConfig.mockResolvedValue({ prototypeWebReferencesEnabled: true });
    mockGetDesignReferences.mockResolvedValue('- Linear uses a two-pane inbox.');
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(mockGetDesignReferences).toHaveBeenCalledWith(
      expect.objectContaining({ featureName: 'Standup summary', designSystemName: 'Apex' }),
    );
    expect(admitV2Run.mock.calls[0][0].specification.prototypePrompt).toMatchObject({
      webReferences: '- Linear uses a two-pane inbox.',
    });
  });

  it('carries no web references when the project left them off', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess: jest.fn(),
    });

    expect(mockGetDesignReferences).not.toHaveBeenCalled();
    expect(
      admitV2Run.mock.calls[0][0].specification.prototypePrompt,
    ).not.toHaveProperty('webReferences');
  });

  /**
   * The in-process path fails a prototype outright when a configured
   * design-system skill will not load, with a message the reviewer can act
   * on. There is no design system to freeze into a specification, so the
   * run goes back to the path that can write that error onto the row.
   */
  it('keeps generation in process when a configured design system will not load', async () => {
    arrangePrd();
    mockResolveSkillConfig.mockResolvedValue({ skillRepo: 'Apex/AI-Pilot' });
    mockResolvePrototypeContext.mockResolvedValue(null);
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateInProcess).toHaveBeenCalledTimes(2);
  });

  it('keeps generation in process when resolving the design system throws', async () => {
    arrangePrd();
    mockResolvePrototypeContext.mockRejectedValue(new Error('ADO unreachable'));
    const admitV2Run = jest.fn().mockResolvedValue(DISPATCHED);
    const generateInProcess = jest.fn().mockResolvedValue(undefined);

    await generatePrototypesForPrd('prd-1', {
      isFeatureEnabled: async () => true,
      admitV2Run,
      generateInProcess,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateInProcess).toHaveBeenCalledTimes(2);
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

describe('failStalePrototypes V2 deadline safety', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('protects only active V2 runs until their stored deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    mockPrototypeUpdateReturning.mockResolvedValueOnce([]);

    await expect(failStalePrototypes(25 * 60_000)).resolves.toBe(0);

    const predicate = mockPrototypeUpdateWhere.mock.calls[0]?.[0];
    expect(predicate).toBeDefined();
    if (!predicate) return;
    const compiled = new PgDialect().sqlToQuery(predicate as SQL);
    const sqlText = compiled.sql.toLowerCase();
    expect(sqlText).toContain('not exists');
    expect(compiled.sql).toContain('"agent_runs"."timeout_at"');
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        '2026-09-22T11:35:00.000Z',
        '2026-09-22T12:00:00.000Z',
        'servicebus-blob-v2',
        'prototype:',
      ]),
    );
    expect(sqlText).toContain("'queued'");
    expect(sqlText).toContain("'dispatched'");
    expect(sqlText).toContain("'running'");
    expect(sqlText).not.toContain("'completed'");
    expect(sqlText).not.toContain("'failed'");
    expect(sqlText).not.toContain("'cancelled'");
  });
});
