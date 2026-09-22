/**
 * Differential test for the prototype visual lane.
 *
 * Three ported-path defects reached production and were each found by hand
 * weeks later: the lane ignored `subjectKind`, the reference screenshot was
 * never attached to the V2 call, and the project-specific prompt branch is
 * still not carried to the worker. All three are the same species — an input
 * channel the in-process path supplies that the V2 path drops — and unit
 * tests missed all three because they assert what the code does rather than
 * whether it matches the path it replaced.
 *
 * So this test asserts the match. One PRD fixture drives
 * `generatePrototypesForPrd` twice, once with the transport flag off and once
 * with it on, and both Bedrock requests are captured at the AWS SDK boundary —
 * the last place the two paths converge before the network. A channel either
 * path drops shows up as a difference in the request.
 *
 * The comparison is on the whole request, not a chosen subset: model id,
 * headers, every payload key, and every content block including images and
 * their order. Known-legitimate differences are named in `ALLOWANCES` and
 * applied to both sides, so an unexpected difference still fails.
 */

const mockBedrockRequests: Array<{ input: Record<string, unknown> }> = [];

/**
 * Both paths build a real `InvokeModelCommand` and hand it to a
 * `BedrockRuntimeClient`. `bedrockService` holds its client at module scope
 * and `bedrockVisualClient` constructs one when none is injected, so
 * replacing the client class — and only the client class — observes both
 * without either side knowing it is under test.
 */
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: class {
      async send(command: { input: Record<string, unknown> }): Promise<unknown> {
        mockBedrockRequests.push(command);
        return {
          body: new TextEncoder().encode(
            JSON.stringify({
              content: [{ type: 'text', text: MODEL_HTML }],
              usage: { input_tokens: 10, output_tokens: 20 },
            }),
          ),
        };
      }
    },
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: jest.fn() },
      designPlans: { findFirst: jest.fn() },
      designPrototypes: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    })),
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    })),
  },
}));

// No active target grounding, so no bare mirror and no repository source.
// Both paths then send the same context; see REPOSITORY_SOURCE_SECTION.
jest.mock('../services/runGroundingService', () => ({
  resolveRunGroundingSurface: jest.fn().mockResolvedValue(null),
  runGroundingService: { getGroundings: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/designSystemService', () => ({
  getDesignSystemCatalog: jest.fn(async () => CATALOG),
  getScreenInventory: jest.fn(async () => SCREEN_INVENTORY),
  componentIndexPaths: jest.fn(() => ['/src/client/components']),
  isComponentSourcePath: jest.fn(() => true),
  fetchExistingPageContext: jest.fn(async () => ''),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn(() => COLOR_TOKENS),
}));

jest.mock('../services/figmaReferenceService', () => ({
  getFigmaReference: jest.fn(() => FIGMA_REFERENCE),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
}));

// `resolvePrototypeExtendMode` is pure and both paths depend on it, so only
// the project lookup — which reads Azure DevOps — is replaced.
jest.mock('../services/prototypeContextService', () => ({
  ...jest.requireActual('../services/prototypeContextService'),
  resolvePrototypeContext: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn(),
  computeCost: jest.fn().mockResolvedValue(0),
}));

jest.mock('../services/aiCompletionNotifier', () => ({
  notifyAiCompletion: jest.fn().mockResolvedValue(undefined),
}));

import type { AdmitV2RunResult } from '../services/aiRunV2/v2AdmissionService';
import type { PrototypeContext } from '../services/prototypeContextService';
import type { AiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import { generatePrototypesForPrd } from '../services/designPrototypeService';
import { createVisualExecute } from '../services/aiRunsV2Worker/visualEntrypoint';
import { createBedrockVisualClient } from '../services/aiRunsV2Worker/bedrockVisualClient';

const MODEL_HTML = '<html><!-- NEW_FEATURE:START -->#a46bff NEW:<!-- NEW_FEATURE:END --></html>';

/* ── Domain fixture ──────────────────────────────────────────────────────── */

const CATALOG = {
  routes: [
    { path: '/timecards', title: 'Timecards' },
    { path: '/home', title: 'Home' },
  ],
  componentNames: ['DataGrid', 'StatusChip'],
  componentDescriptions: { DataGrid: 'Sortable table with column controls' },
  routeLayoutHints: { '/timecards': 'table page' },
  uiKnowledgeBase: 'Timecards lists one week of entries per worker.',
};

const SCREEN_INVENTORY = [
  {
    route: '/timecards',
    purpose: 'Review submitted hours',
    userTypes: ['S', 'I'],
    states: 'default, empty',
  },
];

const COLOR_TOKENS = 'primary.main: #323695\nerror.main: #e43443';

const FIGMA_REFERENCE = {
  updatedAt: '2026-09-01T00:00:00.000Z',
  navItems: [
    { label: 'Home', route: '/home' },
    { label: 'Timecards', route: '/timecards' },
  ],
  tablePageBase64: 'QUJD',
  tablePageWidth: 1024,
  tablePageHeight: 810,
  tablePageLabel: 'MaxView reference page',
};

/** One feature that needs a prototype, with no route so it stays a NEW page. */
const FEATURE = {
  title: 'Standup summary digest',
  description: 'Show the facilitator summary once every participant has posted.',
  items: [
    {
      type: 'PBI',
      title: 'Show the summary',
      description: 'The digest renders under the participant list.',
      acceptanceCriteria: 'Given every update is in, when the deadline passes, then the digest renders',
      userTypes: ['S', 'I'],
    },
  ],
};

const PROJECT_DESIGN_SYSTEM: PrototypeContext = {
  appName: 'Apex',
  designSystemMarkdown: '## Apex tokens\n\n:root { --apex-primary: #4f46e5; }',
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

/* ── Request capture ─────────────────────────────────────────────────────── */

type ContentBlock = Record<string, unknown>;

type BedrockRequest = Readonly<{
  modelId: unknown;
  accept: unknown;
  contentType: unknown;
  payload: Record<string, unknown>;
}>;

function takeCapturedRequest(label: string): BedrockRequest {
  const command = mockBedrockRequests.shift();
  if (!command) throw new Error(`The ${label} path never called Bedrock`);

  const { modelId, accept, contentType, body } = command.input as Record<string, unknown>;
  if (typeof body !== 'string') {
    throw new Error(`The ${label} path sent a non-string request body`);
  }
  return { modelId, accept, contentType, payload: JSON.parse(body) as Record<string, unknown> };
}

/* ── Named allowances ────────────────────────────────────────────────────── */

/**
 * Differences that are real but legitimate. Each is applied to both sides so
 * an unexpected difference still fails; loosening the comparison instead
 * would let the next dropped channel through.
 */
const ALLOWANCES = {
  /**
   * `bedrockService` always sends `content` as a one-element block array,
   * while `bedrockVisualClient` sends a bare string when there is no image.
   * The Bedrock Anthropic API treats the two as the same message, so both are
   * canonicalised to a block list — which also keeps image blocks, the thing
   * that actually differs when a channel is dropped, fully compared.
   */
  TEXT_ONLY_CONTENT_ENCODING: 'text-only content encoding',

  /**
   * The worker adds a repository-source section the in-process path has never
   * carried: App Service reads component source on the worker's behalf,
   * because a worker has no checkout. It is an intentional V2 enrichment, so
   * it is removed before the prompts are compared and everything around it
   * still has to match.
   */
  REPOSITORY_SOURCE_SECTION: 'worker-only repository source section',
} as const;

const REPOSITORY_SOURCE_HEADING = '### Repository source for the affected surface';
const SECTION_TERMINATOR = '\n\n---\n\n';

function stripRepositorySourceSection(text: string): string {
  const start = text.indexOf(REPOSITORY_SOURCE_HEADING);
  if (start === -1) return text;

  const end = text.indexOf(SECTION_TERMINATOR, start);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + SECTION_TERMINATOR.length);
}

function canonicalContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'unrecognised', value: content }];
  return content as ContentBlock[];
}

function canonicalBlock(block: ContentBlock): ContentBlock {
  if (block.type !== 'text' || typeof block.text !== 'string') return block;
  return { ...block, text: stripRepositorySourceSection(block.text) };
}

/* ── Comparison ──────────────────────────────────────────────────────────── */

/**
 * The first line where two prompts diverge, quoted on both sides. A whole-
 * prompt diff of a 5,000-word instruction block names nothing; one line does.
 */
function firstLineDifference(expected: string, actual: string): string | null {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');

  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
    if (expectedLines[i] === actualLines[i]) continue;
    return (
      `prompt text diverges at line ${i + 1}\n` +
      `    in-process: ${JSON.stringify(expectedLines[i] ?? '<end of prompt>')}\n` +
      `    v2:         ${JSON.stringify(actualLines[i] ?? '<end of prompt>')}`
    );
  }
  return null;
}

function compareScalar(
  differences: string[],
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  differences.push(
    `${field}: in-process sent ${JSON.stringify(expected)}, v2 sent ${JSON.stringify(actual)}`,
  );
}

function isTextBlock(block: ContentBlock): boolean {
  return block.type === 'text';
}

function typeSequence(blocks: ContentBlock[]): string {
  return blocks.map((block) => String(block.type)).join(', ') || '<empty>';
}

/**
 * Text blocks are lined up against text blocks and images against images,
 * rather than comparing the two lists slot by slot. A dropped image otherwise
 * shifts the prompt out of alignment and the comparison reports a block-type
 * mismatch while saying nothing about the prompt behind it — which is exactly
 * the case where both went wrong at once.
 */
function compareContent(
  differences: string[],
  label: string,
  expected: ContentBlock[],
  actual: ContentBlock[],
): void {
  if (typeSequence(expected) !== typeSequence(actual)) {
    differences.push(
      `${label}.content: in-process sent [${typeSequence(expected)}], ` +
        `v2 sent [${typeSequence(actual)}]`,
    );
  }

  const expectedText = expected.filter(isTextBlock);
  const actualText = actual.filter(isTextBlock);
  if (expectedText.length !== actualText.length) {
    differences.push(
      `${label}.content: in-process sent ${expectedText.length} text block(s), ` +
        `v2 sent ${actualText.length}`,
    );
  }
  for (let i = 0; i < Math.min(expectedText.length, actualText.length); i++) {
    const divergence = firstLineDifference(
      String(expectedText[i].text ?? ''),
      String(actualText[i].text ?? ''),
    );
    if (divergence) differences.push(`${label}.content text block ${i + 1}: ${divergence}`);
  }

  const expectedOther = expected.filter((block) => !isTextBlock(block));
  const actualOther = actual.filter((block) => !isTextBlock(block));
  if (expectedOther.length !== actualOther.length) {
    differences.push(
      `${label}.content: in-process sent ${expectedOther.length} non-text block(s) ` +
        `(${typeSequence(expectedOther)}), v2 sent ${actualOther.length} ` +
        `(${typeSequence(actualOther)})`,
    );
  }
  for (let i = 0; i < Math.min(expectedOther.length, actualOther.length); i++) {
    compareScalar(
      differences,
      `${label}.content non-text block ${i + 1}`,
      expectedOther[i],
      actualOther[i],
    );
  }
}

/**
 * Every way the two requests differ, in plain sentences, after the named
 * allowances are applied. An empty list means the V2 lane would send Bedrock
 * the request the in-process path sends.
 */
export function compareBedrockRequests(
  inProcess: BedrockRequest,
  v2: BedrockRequest,
): string[] {
  const differences: string[] = [];

  compareScalar(differences, 'modelId', inProcess.modelId, v2.modelId);
  compareScalar(differences, 'accept', inProcess.accept, v2.accept);
  compareScalar(differences, 'contentType', inProcess.contentType, v2.contentType);

  // Every payload key, so a field added to one path alone cannot slip past.
  const payloadKeys = new Set([
    ...Object.keys(inProcess.payload),
    ...Object.keys(v2.payload),
  ]);
  for (const key of [...payloadKeys].sort()) {
    if (key === 'messages') continue;
    compareScalar(differences, `payload.${key}`, inProcess.payload[key], v2.payload[key]);
  }

  const expectedMessages = (inProcess.payload.messages ?? []) as ContentBlock[];
  const actualMessages = (v2.payload.messages ?? []) as ContentBlock[];
  if (expectedMessages.length !== actualMessages.length) {
    differences.push(
      `payload.messages: in-process sent ${expectedMessages.length}, v2 sent ${actualMessages.length}`,
    );
  }

  for (let i = 0; i < Math.min(expectedMessages.length, actualMessages.length); i++) {
    compareScalar(
      differences,
      `messages[${i}].role`,
      expectedMessages[i].role,
      actualMessages[i].role,
    );
    compareContent(
      differences,
      `messages[${i}]`,
      canonicalContent(expectedMessages[i].content).map(canonicalBlock),
      canonicalContent(actualMessages[i].content).map(canonicalBlock),
    );
  }

  return differences;
}

/* ── Driving both transports from one domain input ───────────────────────── */

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      prds: { findFirst: jest.Mock };
      designPlans: { findFirst: jest.Mock };
      designPrototypes: { findFirst: jest.Mock };
    };
    insert: jest.Mock;
  };
};

const mockResolvePrototypeContext = (
  jest.requireMock('../services/prototypeContextService') as {
    resolvePrototypeContext: jest.Mock;
  }
).resolvePrototypeContext;

function arrangePrd(): void {
  mockDb.query.prds.findFirst.mockResolvedValue({
    id: 'prd-1',
    project: 'Apex',
    authorId: 'user-1',
    skillSettingsId: null,
    backlogJson: { features: [FEATURE] },
  });
  mockDb.query.designPlans.findFirst.mockResolvedValue(undefined);
  mockDb.query.designPrototypes.findFirst.mockResolvedValue(undefined);
  mockDb.insert.mockImplementation(() => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'prototype-1' }]),
  }));
}

/**
 * In-process generation is deliberately detached — the route returns and the
 * UI polls — so the request arrives after `generatePrototypesForPrd` resolves.
 */
async function waitForCapturedRequest(label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (mockBedrockRequests.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`The ${label} path never reached Bedrock`);
}

/** The request the proven in-process path sends for the fixture. */
async function captureInProcessRequest(): Promise<BedrockRequest> {
  arrangePrd();
  await generatePrototypesForPrd('prd-1', { isFeatureEnabled: async () => false });
  await waitForCapturedRequest('in-process');
  return takeCapturedRequest('in-process');
}

/**
 * The request the V2 lane sends for the same fixture: App Service assembles
 * and admits the specification, then the worker executes it through the same
 * Bedrock client binding `visualEntrypoint` uses in the worker image.
 */
async function captureV2Request(): Promise<BedrockRequest> {
  arrangePrd();

  let admitted: AiRunV2VisualSpecification | undefined;
  // Admission falls back in process rather than stranding a row, and swallows
  // the failure. Unnoticed, that would compare the in-process path to itself.
  let fellBack = false;
  await generatePrototypesForPrd('prd-1', {
    isFeatureEnabled: async () => true,
    admitV2Run: async (input) => {
      admitted = input.specification as unknown as AiRunV2VisualSpecification;
      return DISPATCHED;
    },
    generateInProcess: async () => {
      fellBack = true;
    },
  });
  if (fellBack) throw new Error('V2 admission fell back in process for the fixture');
  if (!admitted) throw new Error('The V2 lane never admitted a run for the fixture');

  const execute = createVisualExecute({
    invokeModel: (prompt, model, image) =>
      createBedrockVisualClient().invokeModel(prompt, model, image),
  });
  await execute({
    specification: admitted as never,
    command: {} as never,
    checkpoints: {
      publishStarted: async () => undefined,
      publishHeartbeat: async () => undefined,
      publishProgress: async () => undefined,
      lastSequence: () => 0,
    } as never,
    signal: new AbortController().signal,
  });

  return takeCapturedRequest('v2');
}

beforeEach(() => {
  mockBedrockRequests.length = 0;
  mockResolvePrototypeContext.mockResolvedValue(null);
});

/* ── The differential ────────────────────────────────────────────────────── */

describe('prototype Bedrock request parity between the in-process path and the V2 lane', () => {
  /**
   * An empty difference list is only meaningful if both transports actually
   * reached Bedrock with a real prototype prompt. Without this, a harness that
   * silently captured nothing would report perfect parity.
   */
  it('captures a real prototype request from each transport', async () => {
    const inProcess = await captureInProcessRequest();
    const v2 = await captureV2Request();

    for (const [label, captured] of [['in-process', inProcess], ['v2', v2]] as const) {
      const [message] = (captured.payload.messages ?? []) as ContentBlock[];
      const text = canonicalContent(message?.content).find(isTextBlock);
      expect(`${label} prompt: ${String(text?.text ?? '').slice(0, 60)}`).toContain(
        'You are a senior UI/UX designer',
      );
      expect(String(text?.text ?? '')).toContain('**Feature:** Standup summary digest');
      expect(typeof captured.payload.max_tokens).toBe('number');
    }
  });

  /**
   * This was red on a fourth channel of the same species: App Service left
   * `model.maxTokens` unset whenever a project configured no override, and
   * the worker answered with a 16k constant of its own while the in-process
   * path used `UI_MOCK_MAX_TOKENS` (32k) — so V2 truncated prototypes the
   * in-process path finished. Prototype HTML is what drove that ceiling to
   * 32k in the first place. The ceiling is now resolved on App Service and
   * carried on every specification; the worker holds no default to fall back
   * to, which is what closes the gap for good rather than for this number.
   */
  it('sends the same request for a project on the bundled MaxView design system', async () => {
    const inProcess = await captureInProcessRequest();
    const v2 = await captureV2Request();

    expect(compareBedrockRequests(inProcess, v2)).toEqual([]);
  });

  /**
   * Fails today because `buildProjectPrototypePrompt` is taken in process
   * whenever `prototypeContext` is set, but the specification has no channel
   * for it and `admitPendingPrototypesToV2` only falls back for EXTEND mode.
   * A project with its own design system is therefore admitted to V2 and
   * answered with the MaxView prompt — and, because that branch attaches no
   * Figma reference, with an image the in-process call never sends.
   *
   * Left red on purpose. Closing it needs a new field on the visual
   * specification, a project branch in the worker prompt builder, and an
   * admission fallback; a red test that names the defect is worth more than a
   * green one over an unreviewed change of that size.
   */
  it('sends the same request for a project that has its own design system', async () => {
    mockResolvePrototypeContext.mockResolvedValue(PROJECT_DESIGN_SYSTEM);

    const inProcess = await captureInProcessRequest();
    const v2 = await captureV2Request();

    expect(compareBedrockRequests(inProcess, v2)).toEqual([]);
  });
});

/* ── The comparison itself, against the three known gaps ─────────────────── */

function request(overrides: {
  modelId?: string;
  maxTokens?: number;
  content: unknown;
}): BedrockRequest {
  return {
    modelId: overrides.modelId ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    accept: 'application/json',
    contentType: 'application/json',
    payload: {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: overrides.maxTokens ?? 32_000,
      messages: [{ role: 'user', content: overrides.content }],
    },
  };
}

const IMAGE_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
};

describe('compareBedrockRequests against the three gaps that reached production', () => {
  it('catches a lane that answers one subject kind with another kind of prompt', () => {
    const differences = compareBedrockRequests(
      request({ content: 'You are generating a UI Lab screen.' }),
      request({ content: 'You are a senior UI/UX designer generating a prototype.' }),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain('prompt text diverges at line 1');
  });

  it('catches a reference screenshot the V2 call never attaches', () => {
    const differences = compareBedrockRequests(
      request({ content: [IMAGE_BLOCK, { type: 'text', text: 'match the screenshot' }] }),
      request({ content: 'match the screenshot' }),
    );

    expect(differences).toEqual([
      'messages[0].content: in-process sent [image, text], v2 sent [text]',
      'messages[0].content: in-process sent 1 non-text block(s) (image), v2 sent 0 (<empty>)',
    ]);
  });

  /**
   * The screenshot and the project design system were dropped together in the
   * fixture below, and a slot-by-slot comparison would report only the block
   * mismatch. Both have to be named or the second defect waits for the next
   * person to find it by hand.
   */
  it('names the prompt divergence behind a dropped image rather than stopping at the block mismatch', () => {
    const differences = compareBedrockRequests(
      request({ content: [IMAGE_BLOCK, { type: 'text', text: '## Apex Design System' }] }),
      request({ content: '## MaxView Application Context' }),
    );

    expect(differences).toHaveLength(3);
    expect(differences[1]).toContain('## Apex Design System');
    expect(differences[1]).toContain('## MaxView Application Context');
    expect(differences[2]).toContain('non-text block');
  });

  it('catches a project design system the worker was never told about', () => {
    const differences = compareBedrockRequests(
      request({ content: '## Apex Design System (AUTHORITATIVE)' }),
      request({ content: '## MaxView Application Context' }),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain('## Apex Design System (AUTHORITATIVE)');
    expect(differences[0]).toContain('## MaxView Application Context');
  });

  it('catches an image block whose bytes or media type changed, not just its absence', () => {
    const differences = compareBedrockRequests(
      request({ content: [IMAGE_BLOCK, { type: 'text', text: 'prompt' }] }),
      request({
        content: [
          { ...IMAGE_BLOCK, source: { ...IMAGE_BLOCK.source, media_type: 'image/jpeg' } },
          { type: 'text', text: 'prompt' },
        ],
      }),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain('image/jpeg');
  });

  it('catches an image and a prompt sent in the opposite order', () => {
    const differences = compareBedrockRequests(
      request({ content: [IMAGE_BLOCK, { type: 'text', text: 'prompt' }] }),
      request({ content: [{ type: 'text', text: 'prompt' }, IMAGE_BLOCK] }),
    );

    expect(differences).toEqual([
      'messages[0].content: in-process sent [image, text], v2 sent [text, image]',
    ]);
  });

  it('catches a token ceiling or model id that only one path applies', () => {
    const differences = compareBedrockRequests(
      request({ content: 'prompt', maxTokens: 32_000, modelId: 'opus' }),
      request({ content: 'prompt', maxTokens: 16_000, modelId: 'haiku' }),
    );

    expect(differences).toEqual([
      'modelId: in-process sent "opus", v2 sent "haiku"',
      'payload.max_tokens: in-process sent 32000, v2 sent 16000',
    ]);
  });

  it('catches a payload field that only one path sets', () => {
    const withTemperature = request({ content: 'prompt' });
    withTemperature.payload.temperature = 0.2;

    expect(compareBedrockRequests(withTemperature, request({ content: 'prompt' }))).toEqual([
      'payload.temperature: in-process sent 0.2, v2 sent undefined',
    ]);
  });
});

describe('the named allowances', () => {
  it(`${ALLOWANCES.TEXT_ONLY_CONTENT_ENCODING}: a bare string matches a one-block text array`, () => {
    const differences = compareBedrockRequests(
      request({ content: [{ type: 'text', text: 'the same prompt' }] }),
      request({ content: 'the same prompt' }),
    );

    expect(differences).toEqual([]);
  });

  it(`${ALLOWANCES.REPOSITORY_SOURCE_SECTION}: the worker may add repository source the in-process path never carried`, () => {
    const differences = compareBedrockRequests(
      request({ content: '## Context\n\n---\n\n## Feature to Design' }),
      request({
        content:
          '## Context\n\n---\n\n' +
          `${REPOSITORY_SOURCE_HEADING}\n\n#### App.tsx\n\nexport const App = 1;\n\n---\n\n` +
          '## Feature to Design',
      }),
    );

    expect(differences).toEqual([]);
  });

  it('still compares everything around a repository source section rather than masking the prompt', () => {
    const differences = compareBedrockRequests(
      request({ content: '## Context\n\n---\n\n## Feature to Design\n\n**Feature:** Digest' }),
      request({
        content:
          '## Context\n\n---\n\n' +
          `${REPOSITORY_SOURCE_HEADING}\n\nexport const App = 1;\n\n---\n\n` +
          '## Feature to Design\n\n**Feature:** Something else',
      }),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain('**Feature:** Digest');
    expect(differences[0]).toContain('**Feature:** Something else');
  });
});
