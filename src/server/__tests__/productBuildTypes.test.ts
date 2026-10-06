import {
  BUILD_BRIEF_MARKDOWN_PATH,
  BUILD_MANIFEST_PATH,
  PRODUCT_BUILD_AGENT_OUTPUT_PATH,
  PRODUCT_BUILD_DEFAULT_STACK,
  PRODUCT_BUILD_KINDS,
  PRODUCT_BUILD_STATUSES,
  PRODUCT_MARKDOWN_PATH,
  ProductBuildBriefParseError,
  parseProductBuildBrief,
  renderBuildBriefMarkdown,
  renderBuildManifest,
  renderProductBuildArtifacts,
  renderProductMarkdown,
  productBuildStatusLabel,
  toProductBuildStatusResponse,
  type ProductBuild,
  type ProductBuildBrief,
} from '../../shared/types/productBuild';

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

function parsedBrief(): ProductBuildBrief {
  return parseProductBuildBrief(validInput());
}

describe('parseProductBuildBrief', () => {
  it('accepts a complete brief and a JSON string of the same brief', () => {
    const fromObject = parseProductBuildBrief(validInput());
    const fromString = parseProductBuildBrief(JSON.stringify(validInput()));
    expect(fromString).toEqual(fromObject);
    expect(fromObject.kind).toBe('initial');
    expect(fromObject.stack.overrideReason).toBeNull();
    expect(fromObject.initialBuild.acceptanceCriteria).toEqual([
      { id: 'AC-1', statement: 'A signed-in employee sees each enrolled plan name.' },
    ]);
  });

  it('trims text and drops an empty override reason when the stack is the default', () => {
    const input = validInput();
    const product = input.product as Record<string, unknown>;
    product.name = '  Benefits Tracker  ';
    const stack = input.stack as Record<string, unknown>;
    stack.overrideReason = '   ';
    expect(parseProductBuildBrief(input).product.name).toBe('Benefits Tracker');
    expect(parseProductBuildBrief(input).stack.overrideReason).toBeNull();
  });

  it('rejects unknown fields, missing fields, and empty required text', () => {
    const extra = validInput();
    extra.budget = 'later';
    expect(() => parseProductBuildBrief(extra)).toThrow(ProductBuildBriefParseError);
    expect(() => parseProductBuildBrief(extra)).toThrow(/unknown field "budget"/);

    const missing = validInput();
    delete (missing.initialBuild as Record<string, unknown>).coreWorkflow;
    expect(() => parseProductBuildBrief(missing)).toThrow(/coreWorkflow/);

    const blank = validInput();
    (blank.product as Record<string, unknown>).problem = '   ';
    expect(() => parseProductBuildBrief(blank)).toThrow(/problem/);
  });

  it('rejects a brief that does not fit one pull request', () => {
    const input = validInput();
    input.singlePr = { fitsSinglePr: false, rationale: 'Enrollment editing is still included.' };
    expect(() => parseProductBuildBrief(input)).toThrow(/one pull request/);
  });

  it('rejects a non-default stack that has no reason', () => {
    const input = validInput();
    (input.stack as Record<string, unknown>).client = 'Vue';
    expect(() => parseProductBuildBrief(input)).toThrow(/overrideReason/);
  });

  it('accepts a non-default stack when the reason is present', () => {
    const input = validInput();
    const stack = input.stack as Record<string, unknown>;
    stack.client = 'Vue';
    stack.overrideReason = 'The requester already has a Vue design system.';
    expect(parseProductBuildBrief(input).stack).toMatchObject({
      client: 'Vue',
      overrideReason: 'The requester already has a Vue design system.',
    });
  });

  it('rejects duplicate acceptance criteria and an initial build with no screen', () => {
    const duplicate = validInput();
    (duplicate.initialBuild as Record<string, unknown>).acceptanceCriteria = [
      { id: 'AC-1', statement: 'First check.' },
      { id: 'AC-1', statement: 'Same id.' },
    ];
    expect(() => parseProductBuildBrief(duplicate)).toThrow(/AC-1/);

    const noScreen = validInput();
    (noScreen.initialBuild as Record<string, unknown>).screens = [];
    expect(() => parseProductBuildBrief(noScreen)).toThrow(/screen/);
  });

  it('allows a bug brief with no screens when it still has an acceptance criterion', () => {
    const input = validInput();
    input.kind = 'bug';
    const slice = input.initialBuild as Record<string, unknown>;
    slice.personas = [];
    slice.screens = [];
    slice.summary = 'The benefits list shows the plan name that was saved.';
    expect(parseProductBuildBrief(input).kind).toBe('bug');
  });

  it('rejects invalid JSON text', () => {
    expect(() => parseProductBuildBrief('{')).toThrow(ProductBuildBriefParseError);
  });

  it('accepts a brief that starts with a UTF-8 byte-order mark', () => {
    const marked = `\uFEFF${JSON.stringify(validInput())}`;
    expect(parseProductBuildBrief(marked).kind).toBe('initial');
  });
});

describe('product build rendering', () => {
  it('writes PRODUCT.md as broad product context and points at the build brief', () => {
    const brief = parsedBrief();
    const markdown = renderProductMarkdown(brief);
    expect(markdown).toContain('Benefits Tracker');
    expect(markdown).toContain(brief.product.scopeSummary);
    expect(markdown).toContain(BUILD_BRIEF_MARKDOWN_PATH);
    expect(markdown).not.toContain('My Benefits');
    expect(markdown).not.toContain('AC-1');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('writes the build brief as the one-PR slice, including deferred work', () => {
    const brief = parsedBrief();
    const markdown = renderBuildBriefMarkdown(brief);
    expect(markdown).toContain('one pull request');
    expect(markdown).toContain('My Benefits');
    expect(markdown).toContain('AC-1');
    expect(markdown).toContain('Claims status');
    expect(markdown).toContain(PRODUCT_BUILD_DEFAULT_STACK.client);
    expect(markdown).not.toContain(brief.product.scopeSummary);
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('renders the manifest deterministically', () => {
    const brief = parsedBrief();
    const first = renderBuildManifest(brief);
    const second = renderBuildManifest(brief);
    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({
      version: 1,
      kind: 'initial',
      artifacts: {
        productMarkdown: PRODUCT_MARKDOWN_PATH,
        buildBriefMarkdown: BUILD_BRIEF_MARKDOWN_PATH,
      },
      singlePr: { fitsSinglePr: true },
    });
  });

  it('returns the three approval artifacts from one brief', () => {
    const artifacts = renderProductBuildArtifacts(parsedBrief());
    expect(artifacts).toEqual({
      [PRODUCT_MARKDOWN_PATH]: renderProductMarkdown(parsedBrief()),
      [BUILD_BRIEF_MARKDOWN_PATH]: renderBuildBriefMarkdown(parsedBrief()),
      [BUILD_MANIFEST_PATH]: renderBuildManifest(parsedBrief()),
    });
  });
});

describe('product build status', () => {
  const build: ProductBuild = {
    id: 'build-1',
    kind: 'initial',
    status: 'prototype',
    project: 'Benefits Tracker',
    rfpRequestId: 'rfp-1',
    chatThreadId: 'thread-1',
    uiLabDesignId: 'design-1',
    prototypeVersion: 2,
    devSessionId: null,
    agentRunId: null,
    brief: parsedBrief(),
    requesterId: 'user-1',
    reviewerId: null,
    adoWorkItemId: null,
    prUrl: null,
    errorMessage: null,
    approvedAt: null,
    prOpenedAt: null,
    mergedAt: null,
    createdAt: '2026-10-05T16:00:00.000Z',
    updatedAt: '2026-10-05T16:30:00.000Z',
  };

  it('reports brief and prototype readiness without treating discovery as approved', () => {
    expect(toProductBuildStatusResponse(build)).toEqual({
      id: 'build-1',
      project: 'Benefits Tracker',
      kind: 'initial',
      status: 'prototype',
      briefReady: true,
      prototypeReady: true,
      approved: false,
      adoWorkItemId: null,
      prUrl: null,
      errorMessage: null,
      updatedAt: '2026-10-05T16:30:00.000Z',
    });
  });

  it('keeps a saved brief visible after a failed run', () => {
    const failed: ProductBuild = {
      ...build,
      status: 'failed',
      errorMessage: 'The cloud run stopped.',
      approvedAt: '2026-10-05T17:00:00.000Z',
      prUrl: null,
    };
    expect(toProductBuildStatusResponse(failed)).toMatchObject({
      status: 'failed',
      briefReady: true,
      prototypeReady: true,
      approved: true,
      errorMessage: 'The cloud run stopped.',
    });
  });
});

describe('product build constants', () => {
  it('names the kinds, statuses, and agent output path used by the skills', () => {
    expect(PRODUCT_BUILD_KINDS).toEqual(['initial', 'feature', 'bug', 'refinement']);
    expect(PRODUCT_BUILD_STATUSES).toEqual([
      'discovery',
      'brief-confirmed',
      'prototype',
      'approved',
      'building',
      'pr-open',
      'merged',
      'failed',
    ]);
    expect(PRODUCT_BUILD_AGENT_OUTPUT_PATH).toBe('.ai-pilot/output/product-build-brief.json');
    expect(PRODUCT_MARKDOWN_PATH).toBe('PRODUCT.md');
    expect(BUILD_BRIEF_MARKDOWN_PATH).toBe('docs/product/BUILD_BRIEF.md');
    expect(BUILD_MANIFEST_PATH).toBe('docs/product/build-manifest.json');
  });

  it('uses plain status labels', () => {
    expect(productBuildStatusLabel('discovery')).toBe('Planning');
    expect(productBuildStatusLabel('brief-confirmed')).toBe('Planning');
    expect(productBuildStatusLabel('prototype')).toBe('Preview ready');
    expect(productBuildStatusLabel('approved')).toBe('Building');
    expect(productBuildStatusLabel('building')).toBe('Building');
    expect(productBuildStatusLabel('pr-open')).toBe('Ready for review');
    expect(productBuildStatusLabel('merged')).toBe('Live');
    expect(productBuildStatusLabel('failed')).toBe('Needs attention');
  });
});
