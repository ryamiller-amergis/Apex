import type { ChatThread, ChatThreadKickoff } from '../../shared/types/chat';
import {
  BUILD_BRIEF_MARKDOWN_PATH,
  BUILD_MANIFEST_PATH,
  PRODUCT_BUILD_DEFAULT_STACK,
  PRODUCT_MARKDOWN_PATH,
  parseProductBuildBrief,
  renderProductBuildArtifacts,
  type ProductBuild,
  type ProductBuildBrief,
} from '../../shared/types/productBuild';
import type { UiLabDesign } from '../../shared/types/uiLab';
import { CloudAgentEligibilityError } from '../services/cloudAgentService';
import { PRODUCT_DISCOVERY_SKILL_PATH } from '../services/newProjectSkillSeedService';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import {
  ProductBuildError,
  createProductBuildService,
  findProductBuildReviewer,
  pullRequestIdFromUrl,
  type ProductBuildDeps,
  type ProductBuildRfpContext,
  type ProductBuildService,
} from '../services/productBuildService';
const NOW = '2026-10-05T16:00:00.000Z';
const KICKOFF = "Let's get started. Read PRODUCT.md, summarize it, and propose the smallest usable initial build that fits one pull request.";

function validInput(): Record<string, unknown> {
  return {
    version: 1,
    kind: 'initial',
    product: {
      name: 'Benefits Tracker',
      audience: 'Employees',
      problem: 'People cannot tell which benefits they can use.',
      scopeSummary: 'The product will eventually cover enrollment, claims status, and dependent updates.',
      successCriteria: ['An employee can see the benefits they are enrolled in.'],
    },
    initialBuild: {
      summary: 'An employee can sign in and see enrolled benefits.',
      coreWorkflow: 'Sign in, open My Benefits, and read the current enrollments.',
      personas: [{ name: 'Employee', goal: 'See which benefits are active.' }],
      screens: [{ name: 'My Benefits', purpose: 'List current enrollments.' }],
      data: [{ name: 'Enrollment', fields: ['plan name', 'coverage start'] }],
      integrations: [],
      auth: 'Company sign-in. One employee role.',
      visualDirection: 'Calm, readable, and close to the company intranet.',
      nonFunctionalRequirements: ['The benefits list loads with the page.'],
      acceptanceCriteria: [{ id: 'AC-1', statement: 'A signed-in employee sees each enrolled plan name.' }],
      outOfScope: ['Editing enrollments'],
      deferred: ['Claims status'],
    },
    stack: {
      client: PRODUCT_BUILD_DEFAULT_STACK.client,
      server: PRODUCT_BUILD_DEFAULT_STACK.server,
      database: PRODUCT_BUILD_DEFAULT_STACK.database,
      overrideReason: null,
    },
    deployment: {
      localSetup: 'npm install, then npm run dev',
      migrations: 'node-pg-migrate',
      ci: 'lint, typecheck, unit tests, and build',
      hosting: 'Document the deploy path. A hosted preview comes later.',
    },
    singlePr: {
      fitsSinglePr: true,
      rationale: 'One screen, one table, and one acceptance criterion fit in one pull request.',
    },
    confirmedBy: null,
    confirmedAt: null,
  };
}

function approvedRfp(ownerId = 'user-1'): ProductBuildRfpContext {
  return {
    id: 'rfp-1',
    ownerId,
    title: 'Benefits Tracker',
    request: 'Help employees understand and use their benefits.',
    problem: 'Employees cannot find clear benefits information.',
    audience: 'internal',
    status: 'approved',
    approvedAt: '2026-09-30T00:00:00.000Z',
    approvedRepoName: 'benefits-tracker',
    apexProject: 'Benefits Tracker',
    proposal: {
      document: {
        kind: 'proposal',
        sections: {
          executiveSummary: 'Start with a benefits list.',
          scope: ['Show enrolled benefits'],
        },
      },
    },
  };
}

type MockedDeps = {
  [K in keyof Omit<ProductBuildDeps, 'now'>]: jest.MockedFunction<ProductBuildDeps[K]>;
};

interface Harness {
  service: ProductBuildService;
  deps: MockedDeps & { now: () => Date };
  store: Map<string, ProductBuild>;
  designs: Map<string, UiLabDesign>;
  releaseGeneration: () => void;
}

function createHarness(): Harness {
  const store = new Map<string, ProductBuild>();
  const designs = new Map<string, UiLabDesign>();
  let sequence = 0;
  let currentThread: ChatThread | null = null;
  let releaseGeneration = () => {};
  const deps: ProductBuildDeps = {
    now: () => new Date(NOW),
    getRoles: jest.fn(async () => ['admin']),
    findApprovedRfp: jest.fn(async () => approvedRfp()),
    readProductFile: jest.fn(async () => '# Product\n'),
    findInitialBuild: jest.fn(async (rfpRequestId: string) => (
      [...store.values()].find((build) => build.rfpRequestId === rfpRequestId && build.kind === 'initial') ?? null
    )),
    listBuilds: jest.fn(async (rfpRequestId: string) => (
      [...store.values()]
        .filter((build) => build.rfpRequestId === rfpRequestId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    )),
    findBuild: jest.fn(async (buildId: string) => store.get(buildId) ?? null),
    insertInitialBuild: jest.fn(async (input) => {
      const build: ProductBuild = {
        id: `build-${++sequence}`,
        kind: 'initial',
        status: 'discovery',
        project: input.project,
        rfpRequestId: input.rfpRequestId,
        chatThreadId: null,
        uiLabDesignId: null,
        prototypeVersion: null,
        devSessionId: null,
        agentRunId: null,
        brief: null,
        requesterId: input.requesterId,
        reviewerId: null,
        adoWorkItemId: null,
        prUrl: null,
        errorMessage: null,
        approvedAt: null,
        prOpenedAt: null,
        mergedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.set(build.id, build);
      return build;
    }),
    insertFollowUpBuild: jest.fn(async (input) => {
      const build: ProductBuild = {
        id: `build-${++sequence}`,
        kind: 'feature',
        status: 'discovery',
        project: input.project,
        rfpRequestId: input.rfpRequestId,
        chatThreadId: null,
        uiLabDesignId: null,
        prototypeVersion: null,
        devSessionId: null,
        agentRunId: null,
        brief: null,
        requesterId: input.requesterId,
        reviewerId: null,
        adoWorkItemId: null,
        prUrl: null,
        errorMessage: null,
        approvedAt: null,
        prOpenedAt: null,
        mergedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.set(build.id, build);
      return build;
    }),
    readPullRequestStatus: jest.fn(async () => 'open' as const),
    updateBuild: jest.fn(async (buildId, patch) => {
      const current = store.get(buildId);
      if (!current) throw new Error(`missing build ${buildId}`);
      const next = { ...current, ...patch, updatedAt: NOW };
      store.set(buildId, next);
      return next;
    }),
    listSkillConfigs: jest.fn(async () => [{
      id: 'cfg-1',
      skillRepo: 'Apex - Apps/benefits-tracker',
      skillBranch: 'main',
      skillProvider: 'ado' as const,
    }]),
    createThread: jest.fn(async (userId: string, kickoff: ChatThreadKickoff) => {
      currentThread = {
        id: 'thread-1',
        userId,
        kickoff,
        messages: [],
        status: 'idle',
        workspaceDir: '/tmp/product-build/thread-1',
        flagged: false,
        createdAt: NOW,
        lastActivityAt: NOW,
      };
      return currentThread;
    }),
    sendFirstMessage: jest.fn(async () => undefined),
    readRunChecks: jest.fn(async () => ({})),
    readFirstUserMessages: jest.fn(async () => ({})),
    getThread: jest.fn(async () => currentThread),
    readAgentBrief: jest.fn(async () => null),
    createDesign: jest.fn(async (project: string, authorId: string, req: { title: string; prompt: string }) => {
      const design: UiLabDesign = {
        id: 'design-1',
        project,
        authorId,
        title: req.title,
        prompt: req.prompt,
        status: 'generating',
        html: null,
        version: 1,
        history: [],
        createdAt: NOW,
        updatedAt: NOW,
      };
      designs.set(design.id, design);
      return design;
    }),
    getDesign: jest.fn(async (designId: string) => designs.get(designId) ?? null),
    runGeneration: jest.fn(() => new Promise<void>((resolve) => {
      releaseGeneration = () => resolve();
    })),
    runRegeneration: jest.fn(async () => undefined),
    findReviewer: jest.fn(async () => ({ oid: 'ryan-from-directory', displayName: 'Ryan Miller' })),
    getActorName: jest.fn(async () => 'Ada Lovelace'),
    readRepositoryFile: jest.fn(async () => null),
    pushFiles: jest.fn(async () => undefined),
    queueImplementation: jest.fn(async () => ({
      adoWorkItemId: 42,
      devSessionId: 'session-1',
      agentRunId: 'run-1',
    })),
    refreshImplementation: jest.fn(async () => null),
  };
  return {
    service: createProductBuildService(deps),
    deps: deps as Harness['deps'],
    store,
    designs,
    releaseGeneration: () => releaseGeneration(),
  };
}

function seedPrototype(harness: Harness, overrides: Partial<ProductBuild> = {}, html = '<main>Benefits</main>'): ProductBuild {
  const brief = parseProductBuildBrief(validInput());
  const build: ProductBuild = {
    id: 'build-1',
    kind: 'initial',
    status: 'prototype',
    project: 'Benefits Tracker',
    rfpRequestId: 'rfp-1',
    chatThreadId: 'thread-1',
    uiLabDesignId: 'design-1',
    prototypeVersion: 1,
    devSessionId: null,
    agentRunId: null,
    brief,
    requesterId: 'user-1',
    reviewerId: null,
    adoWorkItemId: null,
    prUrl: null,
    errorMessage: null,
    approvedAt: null,
    prOpenedAt: null,
    mergedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  harness.store.set(build.id, build);
  harness.designs.set('design-1', {
    id: 'design-1',
    project: 'Benefits Tracker',
    authorId: 'user-1',
    title: brief.initialBuild.summary,
    prompt: brief.initialBuild.visualDirection,
    status: 'ready',
    html,
    version: 1,
    history: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return build;
}

describe('product build setup', () => {
  it('refuses someone who is neither the approved requester nor a project admin', async () => {
    const { service, deps } = createHarness();
    deps.getRoles.mockResolvedValue([]);
    deps.findApprovedRfp.mockResolvedValue(approvedRfp('owner-9'));

    await expect(service.getSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(deps.insertInitialBuild).not.toHaveBeenCalled();
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('starts discovery for the approved requester and for a project admin', async () => {
    const owner = createHarness();
    owner.deps.getRoles.mockResolvedValue([]);
    await expect(owner.service.getSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ phase: 'build' });

    const admin = createHarness();
    admin.deps.getRoles.mockResolvedValue(['admin']);
    admin.deps.findApprovedRfp.mockResolvedValue(approvedRfp('owner-9'));
    await expect(admin.service.getSetup('Benefits Tracker', 'user-1')).resolves.toMatchObject({ phase: 'build' });
  });

  it('ignores an archived or unapproved request', async () => {
    const archived = createHarness();
    archived.deps.findApprovedRfp.mockResolvedValue({ ...approvedRfp(), status: 'archived' });
    await expect(archived.service.getSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 404,
      code: 'RFP_NOT_FOUND',
    });

    const unapproved = createHarness();
    unapproved.deps.findApprovedRfp.mockResolvedValue({ ...approvedRfp(), approvedAt: null });
    await expect(unapproved.service.getSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 404,
      code: 'RFP_NOT_FOUND',
    });
  });

  it('does not start discovery before PRODUCT.md exists', async () => {
    const { service, deps } = createHarness();
    deps.readProductFile.mockResolvedValue(null);

    await expect(service.getSetup('Benefits Tracker', 'user-1')).rejects.toMatchObject({
      status: 409,
      code: 'FOUNDATION_OPEN',
    });
    expect(deps.createThread).not.toHaveBeenCalled();
  });

  it('opens one discovery chat with the project skill and a grounded kickoff', async () => {
    const { service, deps } = createHarness();

    const first = await service.getSetup('Benefits Tracker', 'user-1');
    const second = await service.getSetup('Benefits Tracker', 'user-1');

    expect(deps.insertInitialBuild).toHaveBeenCalledTimes(1);
    expect(deps.createThread).toHaveBeenCalledTimes(1);
    expect(deps.createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        project: 'Benefits Tracker',
        repo: 'Apex - Apps/benefits-tracker',
        branch: 'main',
        skillBranch: 'main',
        skillProvider: 'ado',
        skillPath: PRODUCT_DISCOVERY_SKILL_PATH,
        model: 'gemini-3.8-flash',
      }),
      expect.objectContaining({ kickoffMessage: KICKOFF }),
    );
    const kickoff = deps.createThread.mock.calls[0][1] as ChatThreadKickoff;
    expect(kickoff.freeformContext).toContain('Help employees understand and use their benefits.');
    expect(kickoff.freeformContext).toContain('Start with a benefits list.');
    expect(kickoff.freeformContext).toContain('Show enrolled benefits');
    expect(kickoff.freeformContext).toContain('PRODUCT.md');
    expect(kickoff.freeformContext).toContain('one pull request');
    expect(first.phase).toBe('build');
    expect(first.chatThreadId).toBe('thread-1');
    expect(first.thread).toMatchObject({
      id: 'thread-1',
      kickoff: { skillPath: PRODUCT_DISCOVERY_SKILL_PATH, repo: 'Apex - Apps/benefits-tracker' },
    });
    expect(first.build.status).toBe('discovery');
    expect(first.build.approvedAt).toBeNull();
    expect(first.design).toBeNull();
    expect(second.build.id).toBe(first.build.id);
    expect(second.chatThreadId).toBe('thread-1');
  });

  it('reuses the initial build when a second insert hits the unique index', async () => {
    const { service, deps, store } = createHarness();
    const existing: ProductBuild = {
      id: 'build-existing',
      kind: 'initial',
      status: 'discovery',
      project: 'Benefits Tracker',
      rfpRequestId: 'rfp-1',
      chatThreadId: 'thread-1',
      uiLabDesignId: null,
      prototypeVersion: null,
      devSessionId: null,
      agentRunId: null,
      brief: null,
      requesterId: 'owner-9',
      reviewerId: null,
      adoWorkItemId: null,
      prUrl: null,
      errorMessage: null,
      approvedAt: null,
      prOpenedAt: null,
      mergedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    deps.findInitialBuild.mockResolvedValueOnce(null).mockImplementation(async () => existing);
    deps.insertInitialBuild.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    store.set(existing.id, existing);

    const status = await service.getSetup('Benefits Tracker', 'user-1');

    expect(status.build.id).toBe('build-existing');
    expect(deps.createThread).not.toHaveBeenCalled();
  });
});

describe('product build brief reconciliation', () => {
  it('confirms a valid brief once and starts one prototype', async () => {
    const harness = createHarness();
    harness.deps.readAgentBrief.mockResolvedValue(JSON.stringify(validInput()));

    const first = await harness.service.getSetup('Benefits Tracker', 'user-1');
    const second = await harness.service.getSetup('Benefits Tracker', 'user-1');
    harness.releaseGeneration();

    const confirmations = harness.deps.updateBuild.mock.calls.filter((call) => call[1].status === 'brief-confirmed');
    expect(confirmations).toHaveLength(1);
    expect(harness.deps.createDesign).toHaveBeenCalledTimes(1);
    expect(harness.deps.runGeneration).toHaveBeenCalledTimes(1);
    expect(harness.deps.runGeneration).toHaveBeenCalledWith('design-1', expect.any(Function), 'user-1');
    const prompt = harness.deps.createDesign.mock.calls[0][2].prompt as string;
    expect(prompt).toContain('This prototype is a new application named "Benefits Tracker".');
    expect(prompt).toContain('Do not copy another product\'s name, navigation, pages, or visual style.');
    expect(prompt).toContain('An employee can sign in and see enrolled benefits.');
    expect(prompt).toContain('Calm, readable, and close to the company intranet.');
    expect(prompt).toContain('Enrollment — plan name, coverage start');
    expect(prompt).toContain('Integrations: None.');
    expect(prompt).toContain('The benefits list loads with the page.');
    expect(prompt).toContain('AC-1 — A signed-in employee sees each enrolled plan name.');
    expect(prompt).toContain('Out of scope: Editing enrollments');
    expect(prompt).toContain('Deferred: Claims status');
    expect(prompt).not.toContain('claims status, and dependent updates');
    expect(prompt).not.toContain(PRODUCT_BUILD_DEFAULT_STACK.client);
    expect(first.build.status).toBe('prototype');
    expect(first.build.uiLabDesignId).toBe('design-1');
    expect(first.build.approvedAt).toBeNull();
    expect(first.design).toMatchObject({ id: 'design-1', status: 'generating' });
    expect(second.build.uiLabDesignId).toBe('design-1');
    expect(second.design?.id).toBe('design-1');
  });

  it('keeps a malformed brief in discovery and records the parse error', async () => {
    const { service, deps } = createHarness();
    deps.readAgentBrief.mockResolvedValue('{');

    const status = await service.getSetup('Benefits Tracker', 'user-1');

    expect(status.build.status).toBe('discovery');
    expect(status.build.brief).toBeNull();
    expect(status.build.approvedAt).toBeNull();
    expect(status.build.errorMessage).toMatch(/could not be read/i);
    expect(status.build.errorMessage).toMatch(/valid JSON/i);
    expect(deps.createDesign).not.toHaveBeenCalled();
    expect(deps.runGeneration).not.toHaveBeenCalled();
    expect(deps.queueImplementation).not.toHaveBeenCalled();
  });

  it('reconciles the brief file on sync without opening a second prototype', async () => {
    const harness = createHarness();
    harness.deps.readAgentBrief.mockResolvedValue(JSON.stringify(validInput()));
    await harness.service.getSetup('Benefits Tracker', 'user-1');
    const buildId = [...harness.store.keys()][0];

    await harness.service.sync(buildId, 'user-1');
    await harness.service.sync(buildId, 'user-1');

    expect(harness.deps.createDesign).toHaveBeenCalledTimes(1);
    expect(harness.store.get(buildId)?.status).toBe('prototype');
  });
});

describe('product prototype regeneration', () => {
  it('regenerates for an authorized person and refuses everyone else', async () => {
    const harness = createHarness();
    seedPrototype(harness);
    harness.deps.runRegeneration.mockImplementation(async () => {
      const design = harness.designs.get('design-1');
      if (!design) return;
      harness.designs.set('design-1', { ...design, version: 2, html: '<p>Updated</p>', status: 'ready' });
    });

    const updated = await harness.service.regenerate('build-1', 'user-1', '  Make the type larger  ');
    expect(harness.deps.runRegeneration).toHaveBeenCalledWith(
      'design-1',
      { feedback: 'Make the type larger' },
      expect.any(Function),
      'user-1',
    );
    expect(updated.build.prototypeVersion).toBe(2);
    expect(updated.design?.html).toBe('<p>Updated</p>');

    harness.deps.getRoles.mockResolvedValue([]);
    harness.deps.findApprovedRfp.mockResolvedValue(approvedRfp('owner-9'));
    await expect(harness.service.regenerate('build-1', 'stranger', 'Make the type larger')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(harness.deps.runRegeneration).toHaveBeenCalledTimes(1);
  });
});

describe('product build approval', () => {
  it('rejects approval until the brief, the ready prototype, and a single pull request are all true', async () => {
    const missingBrief = createHarness();
    seedPrototype(missingBrief, { brief: null, status: 'discovery', uiLabDesignId: null });
    await expect(missingBrief.service.approve('build-1', 'user-1')).rejects.toBeInstanceOf(ProductBuildError);
    expect(missingBrief.deps.pushFiles).not.toHaveBeenCalled();

    const generating = createHarness();
    seedPrototype(generating);
    const design = generating.designs.get('design-1');
    if (design) generating.designs.set('design-1', { ...design, status: 'generating', html: null });
    await expect(generating.service.approve('build-1', 'user-1')).rejects.toMatchObject({ code: 'PROTOTYPE_NOT_READY' });
    expect(generating.deps.pushFiles).not.toHaveBeenCalled();
    expect(generating.store.get('build-1')?.approvedAt).toBeNull();

    const tooBig = createHarness();
    const brief = parseProductBuildBrief(validInput());
    const oversized = {
      ...brief,
      singlePr: { fitsSinglePr: false, rationale: 'Enrollment editing is still included.' },
    } as unknown as ProductBuildBrief;
    seedPrototype(tooBig, { brief: oversized });
    await expect(tooBig.service.approve('build-1', 'user-1')).rejects.toMatchObject({ status: 409 });
    expect(tooBig.deps.pushFiles).not.toHaveBeenCalled();
    expect(tooBig.store.get('build-1')?.status).toBe('prototype');
  });

  it('does not push again when main already has the stamped artifacts after a failed save', async () => {
    const harness = createHarness();
    seedPrototype(harness);
    const stamped = parseProductBuildBrief({
      ...validInput(),
      confirmedBy: 'Ada Lovelace',
      confirmedAt: NOW,
    });
    const artifacts = renderProductBuildArtifacts(stamped);
    const onMain = new Map<string, string>();
    harness.deps.readRepositoryFile.mockImplementation(async (_repo, _branch, path) => onMain.get(path) ?? null);
    harness.deps.pushFiles.mockImplementation(async ({ changes }) => {
      for (const change of changes) onMain.set(change.path, change.content);
    });
    harness.deps.updateBuild.mockRejectedValueOnce(new Error('save failed'));

    await expect(harness.service.approve('build-1', 'user-1')).rejects.toThrow('save failed');
    expect(harness.deps.pushFiles).toHaveBeenCalledTimes(1);
    expect(harness.store.get('build-1')?.approvedAt).toBeNull();

    await harness.service.approve('build-1', 'user-1');
    expect(harness.deps.pushFiles).toHaveBeenCalledTimes(1);
    expect(harness.deps.queueImplementation).toHaveBeenCalledTimes(2);
    expect(harness.store.get('build-1')?.approvedAt).toBe(NOW);
  });

  it('reports a repository rejection and a cloud-agent refusal instead of hiding them', async () => {
    const pushFailed = createHarness();
    seedPrototype(pushFailed);
    pushFailed.deps.pushFiles.mockRejectedValue(new Error('TF401028: The path PRODUCT.md already exists.'));
    await expect(pushFailed.service.approve('build-1', 'user-1')).rejects.toMatchObject({
      status: 502,
      code: 'APPROVAL_FAILED',
      message: expect.stringContaining('could not be saved'),
    });
    expect(pushFailed.store.get('build-1')?.approvedAt).toBeNull();

    const blocked = createHarness();
    seedPrototype(blocked);
    blocked.deps.queueImplementation.mockRejectedValue(
      new CloudAgentEligibilityError('Cloud Development is not available for this product build.'),
    );
    await expect(blocked.service.approve('build-1', 'user-1')).rejects.toMatchObject({
      status: 403,
      code: 'IMPLEMENTATION_NOT_STARTED',
      message: 'Cloud Development is not available for this product build.',
    });
    expect(blocked.store.get('build-1')?.approvedAt).toBeNull();
  });

  it('stamps the brief, pushes the four artifacts, and stores the queue receipt once', async () => {
    const harness = createHarness();
    const dirty = '<a href="javascript:alert(1)">Open</a>';
    seedPrototype(harness, {}, dirty);

    const first = await harness.service.approve('build-1', 'user-1');
    const second = await harness.service.approve('build-1', 'user-1');

    const stamped = parseProductBuildBrief({
      ...validInput(),
      confirmedBy: 'Ada Lovelace',
      confirmedAt: NOW,
    });
    const artifacts = renderProductBuildArtifacts(stamped);
    expect(harness.deps.pushFiles).toHaveBeenCalledTimes(1);
    expect(harness.deps.pushFiles).toHaveBeenCalledWith({
      repoName: 'benefits-tracker',
      branch: 'main',
      changes: [
        { path: PRODUCT_MARKDOWN_PATH, content: artifacts[PRODUCT_MARKDOWN_PATH] },
        { path: BUILD_BRIEF_MARKDOWN_PATH, content: artifacts[BUILD_BRIEF_MARKDOWN_PATH] },
        { path: 'docs/product/prototype.html', content: sanitizeMockHtml(dirty) },
        { path: BUILD_MANIFEST_PATH, content: artifacts[BUILD_MANIFEST_PATH] },
      ],
    });
    expect(sanitizeMockHtml(dirty)).not.toContain('javascript:');
    expect(harness.deps.queueImplementation).toHaveBeenCalledTimes(1);
    expect(harness.deps.queueImplementation).toHaveBeenCalledWith(expect.objectContaining({
      buildId: 'build-1',
      project: 'Benefits Tracker',
      repoName: 'benefits-tracker',
      reviewerId: 'ryan-from-directory',
      brief: expect.objectContaining({ confirmedBy: 'Ada Lovelace', confirmedAt: NOW }),
    }));
    expect(first.build).toMatchObject({
      status: 'building',
      approvedAt: NOW,
      reviewerId: 'ryan-from-directory',
      adoWorkItemId: 42,
      devSessionId: 'session-1',
      agentRunId: 'run-1',
    });
    expect(second.build.approvedAt).toBe(first.build.approvedAt);
    expect(second.build.agentRunId).toBe('run-1');
  });

  it('records approval without a run when the queue has not started implementation', async () => {
    const harness = createHarness();
    seedPrototype(harness);
    harness.deps.queueImplementation.mockResolvedValue({
      adoWorkItemId: null,
      devSessionId: null,
      agentRunId: null,
    });

    const status = await harness.service.approve('build-1', 'user-1');

    expect(status.build.status).toBe('approved');
    expect(status.build.approvedAt).toBe(NOW);
    expect(status.build.agentRunId).toBeNull();
  });

  it('stops when Ryan Miller is not an Apex user and does not invent an id', async () => {
    const lookup = jest.fn(async (displayName: string) => (
      displayName === 'Ryan Miller' ? { oid: 'ryan-from-directory', displayName } : null
    ));
    await expect(findProductBuildReviewer(lookup)).resolves.toEqual({
      oid: 'ryan-from-directory',
      displayName: 'Ryan Miller',
    });
    expect(lookup).toHaveBeenCalledWith('Ryan Miller');
    await expect(findProductBuildReviewer(async () => null)).resolves.toBeNull();
    await expect(findProductBuildReviewer(async () => ({ oid: 'x', displayName: 'Ryan miller' }))).resolves.toBeNull();

    const harness = createHarness();
    seedPrototype(harness);
    harness.deps.findReviewer.mockResolvedValue(null);

    await expect(harness.service.approve('build-1', 'user-1')).rejects.toMatchObject({
      status: 409,
      code: 'REVIEWER_NOT_FOUND',
    });
    expect(harness.store.get('build-1')).toMatchObject({
      approvedAt: null,
      reviewerId: null,
      status: 'prototype',
    });
    expect(harness.store.get('build-1')?.errorMessage).toMatch(/Ryan Miller/);
    expect(harness.deps.pushFiles).not.toHaveBeenCalled();
    expect(harness.deps.queueImplementation).not.toHaveBeenCalled();
  });
});

describe('product build run reconciliation', () => {
  it('marks the build failed when the linked run failed or was cancelled', async () => {
    const failed = createHarness();
    seedPrototype(failed, {
      status: 'building',
      agentRunId: 'run-1',
      devSessionId: 'session-1',
      approvedAt: NOW,
    });
    failed.deps.refreshImplementation.mockResolvedValue({
      runStatus: 'failed',
      prUrl: null,
      errorMessage: 'Container CLI run failed.',
    });

    const failedStatus = await failed.service.sync('build-1', 'user-1');
    expect(failedStatus.build.status).toBe('failed');
    expect(failedStatus.build.errorMessage).toMatch(/failed/i);
    expect(failedStatus.build.errorMessage).toContain('Container CLI run failed.');

    const cancelled = createHarness();
    seedPrototype(cancelled, {
      status: 'building',
      agentRunId: 'run-1',
      devSessionId: 'session-1',
      approvedAt: NOW,
    });
    cancelled.deps.refreshImplementation.mockResolvedValue({
      runStatus: 'cancelled',
      prUrl: null,
      errorMessage: null,
    });
    const cancelledStatus = await cancelled.service.sync('build-1', 'user-1');
    expect(cancelledStatus.build.status).toBe('failed');
    expect(cancelledStatus.build.errorMessage).toMatch(/cancelled/i);
  });

  it('records the pull request and leaves a run without one as building', async () => {
    const opened = createHarness();
    seedPrototype(opened, {
      status: 'building',
      agentRunId: 'run-1',
      devSessionId: 'session-1',
      approvedAt: NOW,
    });
    const prUrl = 'https://dev.azure.com/amergis/Apex%20-%20Apps/_git/benefits-tracker/pullrequest/9';
    opened.deps.refreshImplementation.mockResolvedValue({
      runStatus: 'completed',
      prUrl,
      errorMessage: null,
    });

    const openStatus = await opened.service.sync('build-1', 'user-1');
    expect(openStatus.build).toMatchObject({
      status: 'pr-open',
      prUrl,
      prOpenedAt: NOW,
      errorMessage: null,
    });

    const stillBuilding = createHarness();
    seedPrototype(stillBuilding, {
      status: 'approved',
      agentRunId: 'run-1',
      devSessionId: 'session-1',
      approvedAt: NOW,
    });
    stillBuilding.deps.refreshImplementation.mockResolvedValue({
      runStatus: 'running',
      prUrl: null,
      errorMessage: null,
    });
    const buildingStatus = await stillBuilding.service.getSetup('Benefits Tracker', 'user-1');
    expect(buildingStatus.build.status).toBe('building');
    expect(buildingStatus.build.prUrl).toBeNull();
  });

  it('marks a merged pull request finished and opens the next feature prompt', async () => {
    const harness = createHarness();
    const prUrl = 'https://dev.azure.com/amergis/Apex%20-%20Apps/_git/benefits-tracker/pullrequest/11136';
    seedPrototype(harness, {
      status: 'pr-open',
      agentRunId: 'run-1',
      devSessionId: 'session-1',
      approvedAt: NOW,
      prUrl,
      prOpenedAt: NOW,
    });
    harness.deps.readPullRequestStatus.mockResolvedValue('merged');

    const merged = await harness.service.getSetup('Benefits Tracker', 'user-1');
    expect(merged.build.status).toBe('merged');
    expect(merged.build.mergedAt).toBe(NOW);
    expect(merged.build.prUrl).toBe(prUrl);
    expect(harness.deps.insertFollowUpBuild).not.toHaveBeenCalled();
    expect(harness.deps.createThread).not.toHaveBeenCalled();

    const next = await harness.service.startNext('Benefits Tracker', 'user-1', 'Add a reminder for tomorrow');
    expect(next.build).toMatchObject({ kind: 'feature', status: 'discovery', brief: null });
    expect(harness.deps.createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        skillPath: PRODUCT_DISCOVERY_SKILL_PATH,
        pillDescription: 'Choose the next feature that fits one pull request.',
      }),
      { skipAutoKickoff: true },
    );
    expect(harness.deps.sendFirstMessage).toHaveBeenCalledWith('thread-1', 'Add a reminder for tomorrow');
    expect(harness.deps.sendFirstMessage).toHaveBeenCalledTimes(1);

    const again = await harness.service.startNext('Benefits Tracker', 'user-1', 'Add a reminder for tomorrow');
    expect(again.build.id).toBe(next.build.id);
    expect(harness.deps.insertFollowUpBuild).toHaveBeenCalledTimes(1);
    expect(harness.deps.sendFirstMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty prompt and does not start a build', async () => {
    const harness = createHarness();
    seedPrototype(harness, { status: 'merged', mergedAt: NOW });

    await expect(harness.service.startNext('Benefits Tracker', 'user-1', '   ')).rejects.toMatchObject({
      status: 400,
      code: 'PROMPT_REQUIRED',
    });
    await expect(harness.service.startNext('Benefits Tracker', 'user-1', 'x'.repeat(4001))).rejects.toMatchObject({
      status: 400,
      code: 'PROMPT_REQUIRED',
    });
    expect(harness.deps.insertFollowUpBuild).not.toHaveBeenCalled();
    expect(harness.deps.createThread).not.toHaveBeenCalled();
    expect(harness.deps.sendFirstMessage).not.toHaveBeenCalled();
  });

  it('lists build history newest first with checks and the merge time', async () => {
    const harness = createHarness();
    seedPrototype(harness, {
      id: 'build-old',
      status: 'merged',
      createdAt: '2026-10-01T16:00:00.000Z',
      mergedAt: '2026-10-04T16:00:00.000Z',
      agentRunId: 'run-old',
      chatThreadId: 'thread-old',
      prUrl: 'https://dev.azure.com/org/project/_git/benefits/pullrequest/1',
    });
    seedPrototype(harness, {
      id: 'build-new',
      status: 'merged',
      createdAt: '2026-10-05T16:00:00.000Z',
      mergedAt: NOW,
      agentRunId: 'run-new',
      chatThreadId: 'thread-new',
    });
    harness.deps.readRunChecks.mockResolvedValue({
      'run-new': [{ kind: 'unit', outcome: 'passed' }],
      'run-old': [{ kind: 'lint', outcome: 'failed' }],
    });
    harness.deps.readFirstUserMessages.mockResolvedValue({
      'thread-new': 'Add a reminder for tomorrow',
    });

    const status = await harness.service.getSetup('Benefits Tracker', 'user-1');

    expect(status.history.map((item) => item.id)).toEqual(['build-new', 'build-old']);
    expect(status.history[0]).toMatchObject({
      request: 'Add a reminder for tomorrow',
      mergedAt: NOW,
      checks: [{ kind: 'unit', outcome: 'passed' }],
    });
    expect(status.history[1]).toMatchObject({
      request: 'An employee can sign in and see enrolled benefits.',
      mergedAt: '2026-10-04T16:00:00.000Z',
      checks: [{ kind: 'lint', outcome: 'failed' }],
    });
    expect(harness.deps.readRunChecks).toHaveBeenCalledWith(['run-new', 'run-old']);
  });

  it('refuses the next feature while the first pull request is still open', async () => {
    const harness = createHarness();
    seedPrototype(harness, {
      status: 'pr-open',
      prUrl: 'https://dev.azure.com/org/project/_git/benefits/pullrequest/9',
      approvedAt: NOW,
    });

    await expect(harness.service.startNext('Benefits Tracker', 'user-1', 'Add reminders')).rejects.toMatchObject({
      status: 409,
      code: 'BUILD_IN_PROGRESS',
    });
    expect(harness.deps.insertFollowUpBuild).not.toHaveBeenCalled();
  });

  it('reads the pull request id from an Azure Repos URL', () => {
    expect(pullRequestIdFromUrl(
      'https://dev.azure.com/Amergis/Apex%20-%20Apps/_git/to-do-list-p2/pullrequest/11136',
    )).toBe(11136);
    expect(pullRequestIdFromUrl('https://example.test/not-a-pr')).toBeNull();
  });

  it('does not refresh a build that is still in discovery', async () => {
    const harness = createHarness();
    seedPrototype(harness, { status: 'discovery', brief: null, uiLabDesignId: null });

    await harness.service.sync('build-1', 'user-1');

    expect(harness.deps.refreshImplementation).not.toHaveBeenCalled();
  });
});
