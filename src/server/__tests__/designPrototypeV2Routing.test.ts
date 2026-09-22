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
import { generatePrototypesForPrd } from '../services/designPrototypeService';

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
