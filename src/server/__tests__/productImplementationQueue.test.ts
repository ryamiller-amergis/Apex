import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import {
  PRODUCT_MARKDOWN_PATH,
  BUILD_BRIEF_MARKDOWN_PATH,
  BUILD_MANIFEST_PATH,
  parseProductBuildBrief,
  type ProductBuildBrief,
} from '../../shared/types/productBuild';
import { PRODUCT_PROTOTYPE_HTML_PATH } from '../services/productBuildService';
import {
  buildFeatureIdempotencyTagWiql,
  buildProductFeatureSpec,
  buildProductImplementationPrompt,
  findOrCreateProductFeature,
  productBuildFeatureIdempotencyTag,
  productBuildImplementationLockKey,
  queueProductImplementation,
  type ProductImplementationQueueDeps,
} from '../services/productImplementationQueue';
import type { ProductImplementationReceipt, ProductImplementationRequest } from '../services/productBuildService';

function brief(): ProductBuildBrief {
  return parseProductBuildBrief({
    version: 1,
    kind: 'initial',
    product: {
      name: 'Benefits Tracker',
      audience: 'Employees',
      problem: 'People cannot tell which benefits they can use.',
      scopeSummary: 'Enrollment, claims, and dependents come later.',
      successCriteria: ['An employee can see enrolled benefits.'],
    },
    initialBuild: {
      summary: 'An employee can sign in and see enrolled benefits.',
      coreWorkflow: 'Sign in and read current enrollments.',
      personas: [{ name: 'Employee', goal: 'See active benefits.' }],
      screens: [{ name: 'My Benefits', purpose: 'List enrollments.' }],
      data: [{ name: 'Enrollment', fields: ['plan name'] }],
      integrations: [],
      auth: 'Company sign-in.',
      visualDirection: 'Calm and readable.',
      nonFunctionalRequirements: ['The list loads with the page.'],
      acceptanceCriteria: [{ id: 'AC-1', statement: 'A signed-in employee sees each enrolled plan name.' }],
      outOfScope: ['Editing enrollments'],
      deferred: ['Claims status'],
    },
    stack: {
      client: 'React + TypeScript + Vite',
      server: 'Express',
      database: 'PostgreSQL',
      overrideReason: null,
    },
    deployment: {
      localSetup: 'npm install, then npm run dev',
      migrations: 'node-pg-migrate',
      ci: 'lint, typecheck, test, and build',
      hosting: 'Document the deploy path.',
    },
    singlePr: {
      fitsSinglePr: true,
      rationale: 'One screen fits in one pull request.',
    },
    confirmedBy: 'Ada Lovelace',
    confirmedAt: '2026-10-05T16:00:00.000Z',
  });
}

function request(): ProductImplementationRequest {
  return {
    buildId: 'build-1',
    project: 'Benefits Tracker',
    repoName: 'benefits-tracker',
    rfpRequestId: 'rfp-1',
    requesterId: 'user-1',
    reviewerId: 'ryan-oid',
    brief: brief(),
  };
}

function harness(store: ProductImplementationReceipt = {
  adoWorkItemId: null,
  devSessionId: null,
  agentRunId: null,
}) {
  const findFeatureByIdempotencyTag = jest.fn(async (): Promise<number | null> => null);
  const createFeature = jest.fn(async () => 77);
  const startRun = jest.fn(async (_input: { promptOverride?: string }) => ({
    sessionId: 'session-1',
    runId: 'run-1',
  }));
  let tail = Promise.resolve();
  const deps: ProductImplementationQueueDeps = {
    withLock: jest.fn(<T,>(_buildId: string, work: () => Promise<T>) => {
      const run = tail.then(() => work());
      tail = run.then(() => undefined, () => undefined);
      return run;
    }),
    readIds: jest.fn(async () => ({ ...store })),
    saveIds: jest.fn(async (_buildId: string, ids: ProductImplementationReceipt) => {
      store.adoWorkItemId = ids.adoWorkItemId;
      store.devSessionId = ids.devSessionId;
      store.agentRunId = ids.agentRunId;
    }),
    findFeatureByIdempotencyTag,
    createFeature,
    startRun,
  };
  return { deps, findFeatureByIdempotencyTag, createFeature, startRun, store };
}

describe('product implementation queue', () => {
  it('creates the feature in Apex - Apps and assigns it to Ryan Miller', () => {
    const spec = buildProductFeatureSpec(request());

    expect(productBuildFeatureIdempotencyTag('build-1')).toBe('apex-product-build-build-1');
    expect(productBuildFeatureIdempotencyTag('550e8400-e29b-41d4-a716-446655440000')).toBe(
      'apex-product-build-550e8400-e29b-41d4-a716-446655440000',
    );
    expect(spec.idempotencyTag).toBe('apex-product-build-build-1');
    expect(spec.tags).toEqual(['apex', 'product-build', 'apex-product-build-build-1']);
    expect(buildFeatureIdempotencyTagWiql(RFP_APPS_ADO_PROJECT, spec.idempotencyTag)).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Apex - Apps' "
      + "AND [System.WorkItemType] = 'Issue' "
      + "AND [System.Tags] CONTAINS 'apex-product-build-build-1'",
    );
    expect(buildFeatureIdempotencyTagWiql('Apex - Apps', "tag'; DROP")).toContain("tag''; DROP");
    expect(spec.adoProject).toBe(RFP_APPS_ADO_PROJECT);
    expect(spec.adoProject).not.toBe('Benefits Tracker');
    expect(spec.type).toBe('Issue');
    expect(spec.title).toBe('An employee can sign in and see enrolled benefits.');
    expect(spec.assignedTo).toBe('Ryan Miller');
    expect(spec.description).toContain(PRODUCT_MARKDOWN_PATH);
    expect(spec.description).toContain(BUILD_BRIEF_MARKDOWN_PATH);
    expect(spec.description).toContain(PRODUCT_PROTOTYPE_HTML_PATH);
    expect(spec.description).toContain(BUILD_MANIFEST_PATH);
    expect(spec.description).toContain('main');
    expect(spec.description).toContain('benefits-tracker');
    expect(spec.description).toContain(RFP_APPS_ADO_PROJECT);
    expect(spec.acceptanceCriteriaHtml).toContain('AC-1');
    expect(spec.acceptanceCriteriaHtml).toContain('A signed-in employee sees each enrolled plan name.');
  });

  it('tells the worker to read the committed artifacts and invoke product-implementation', () => {
    const prompt = buildProductImplementationPrompt(request());

    expect(prompt).toContain(PRODUCT_MARKDOWN_PATH);
    expect(prompt).toContain(BUILD_BRIEF_MARKDOWN_PATH);
    expect(prompt).toContain(PRODUCT_PROTOTYPE_HTML_PATH);
    expect(prompt).toContain(BUILD_MANIFEST_PATH);
    expect(prompt).toContain('product-implementation');
    expect(prompt).toContain('main');
    expect(prompt.length).toBeLessThan(2000);
  });

  it('starts the cloud agent on the virtual project as Ryan without a delegated token', async () => {
    const { deps, createFeature, startRun } = harness();

    const receipt = await queueProductImplementation(request(), deps);

    expect(createFeature).toHaveBeenCalledWith(expect.objectContaining({
      adoProject: 'Apex - Apps',
      assignedTo: 'Ryan Miller',
    }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'ryan-oid',
      project: 'Benefits Tracker',
      workItemId: 77,
      workItemTitle: 'An employee can sign in and see enrolled benefits.',
      adoUserToken: null,
      isSuperAdmin: false,
      systemTriggered: true,
      workItemProject: 'Apex - Apps',
      draftPullRequest: true,
      requiredReviewerId: 'ryan-oid',
      allowServiceAccountPullRequest: true,
      enforceChecks: true,
      promptOverride: expect.stringContaining('product-implementation'),
      item: expect.objectContaining({
        workItemType: 'Issue',
        tags: expect.stringMatching(/apex/),
      }),
    }));
    const started = startRun.mock.calls[0]?.[0] as unknown as { promptOverride: string };
    expect(started.promptOverride).not.toMatch(/buildLocalDevContext|local dev context/i);
    expect(receipt).toEqual({
      adoWorkItemId: 77,
      devSessionId: 'session-1',
      agentRunId: 'run-1',
    });
    expect(deps.withLock).toHaveBeenCalledWith('build-1', expect.any(Function));
    expect(productBuildImplementationLockKey('build-1')).toBe('product-build:build-1');
  });

  it('reuses stored work item, session, and run ids on an approval retry', async () => {
    const { deps, createFeature, startRun } = harness({
      adoWorkItemId: 77,
      devSessionId: 'session-1',
      agentRunId: 'run-1',
    });

    const receipt = await queueProductImplementation(request(), deps);

    expect(receipt).toEqual({
      adoWorkItemId: 77,
      devSessionId: 'session-1',
      agentRunId: 'run-1',
    });
    expect(createFeature).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it('reuses an existing feature found by the deterministic idempotency tag', async () => {
    const { deps, findFeatureByIdempotencyTag, createFeature } = harness();
    findFeatureByIdempotencyTag.mockResolvedValue(88);

    const receipt = await queueProductImplementation(request(), deps);

    expect(findFeatureByIdempotencyTag).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyTag: 'apex-product-build-build-1',
      type: 'Issue',
      adoProject: 'Apex - Apps',
    }));
    expect(createFeature).not.toHaveBeenCalled();
    expect(receipt.adoWorkItemId).toBe(88);
  });

  it('findOrCreateProductFeature creates only when the tag lookup misses', async () => {
    const spec = buildProductFeatureSpec(request());
    const findByTag = jest.fn(async (): Promise<number | null> => null);
    const create = jest.fn(async () => 91);

    await expect(findOrCreateProductFeature(spec, { findByTag, create })).resolves.toBe(91);
    expect(findByTag).toHaveBeenCalledWith(spec);
    expect(create).toHaveBeenCalledWith(spec);

    findByTag.mockResolvedValueOnce(92);
    await expect(findOrCreateProductFeature(spec, { findByTag, create })).resolves.toBe(92);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps the work item when the cloud start fails, then does not create a second feature', async () => {
    const { deps, createFeature, startRun, store } = harness();
    startRun.mockRejectedValueOnce(new Error('launch failed'));

    await expect(queueProductImplementation(request(), deps)).rejects.toThrow('launch failed');
    expect(store.adoWorkItemId).toBe(77);
    expect(store.agentRunId).toBeNull();

    startRun.mockResolvedValueOnce({ sessionId: 'session-1', runId: 'run-1' });
    const receipt = await queueProductImplementation(request(), deps);

    expect(createFeature).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(receipt.agentRunId).toBe('run-1');
  });

  it('serializes overlapping approvals so only one feature and one run are created', async () => {
    const { deps, createFeature, startRun } = harness();
    let resolveCreate: (id: number) => void = () => undefined;
    const gate = new Promise<number>((resolve) => {
      resolveCreate = resolve;
    });
    createFeature.mockImplementation(() => gate);

    const first = queueProductImplementation(request(), deps);
    const second = queueProductImplementation(request(), deps);
    for (let attempt = 0; attempt < 20 && createFeature.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(createFeature).toHaveBeenCalledTimes(1);
    resolveCreate(77);
    const [a, b] = await Promise.all([first, second]);

    expect(createFeature).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});
