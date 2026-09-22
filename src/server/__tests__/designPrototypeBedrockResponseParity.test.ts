/**
 * Differential test for the prototype visual lane, on the response half of
 * the call.
 *
 * `designPrototypeBedrockRequestParity` compares what each transport sends.
 * It cannot see what each transport does with the reply, and a channel can be
 * dropped in that direction too: `bedrockService.invokeModel` reads `content`,
 * `usage` and `stop_reason`, while `bedrockVisualClient` read the first two
 * and ignored the third — so a response Bedrock cut off at the token ceiling
 * was returned as HTML, uploaded, and finalized as a completed prototype.
 *
 * Same fixture and same seam as the request test: one PRD drives
 * `generatePrototypesForPrd` with the transport flag off and on, and the AWS
 * SDK client class is replaced so both paths are observed without either
 * knowing it is under test. Here the fake client is also the one choosing the
 * reply, so one response body reaches both transports and the verdicts —
 * accepted or refused, and with what message — are compared.
 */

let mockStopReason: string | undefined;

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: class {
      async send(): Promise<unknown> {
        return {
          body: new TextEncoder().encode(
            JSON.stringify({
              content: [{ type: 'text', text: MODEL_HTML }],
              usage: { input_tokens: 10, output_tokens: 20 },
              ...(mockStopReason === undefined ? {} : { stop_reason: mockStopReason }),
            }),
          ),
        };
      }
    },
  };
});

/** Every `set` payload the in-process path writes, in order. */
const mockRowWrites: Array<Record<string, unknown>> = [];

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: jest.fn() },
      designPlans: { findFirst: jest.fn() },
      designPrototypes: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        mockRowWrites.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    })),
  },
}));

jest.mock('../services/runGroundingService', () => ({
  resolveRunGroundingSurface: jest.fn().mockResolvedValue(null),
  runGroundingService: { getGroundings: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/designSystemService', () => ({
  getDesignSystemCatalog: jest.fn(async () => CATALOG),
  getScreenInventory: jest.fn(async () => []),
  componentIndexPaths: jest.fn(() => ['/src/client/components']),
  isComponentSourcePath: jest.fn(() => true),
  fetchExistingPageContext: jest.fn(async () => ''),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn(() => 'primary.main: #323695'),
}));

jest.mock('../services/figmaReferenceService', () => ({
  getFigmaReference: jest.fn(() => FIGMA_REFERENCE),
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
}));

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
import type { AiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import { generatePrototypesForPrd } from '../services/designPrototypeService';
import { createVisualExecute } from '../services/aiRunsV2Worker/visualEntrypoint';
import { createBedrockVisualClient } from '../services/aiRunsV2Worker/bedrockVisualClient';

const MODEL_HTML =
  '<html><!-- NEW_FEATURE:START -->#a46bff NEW:<!-- NEW_FEATURE:END --></html>';

const CATALOG = {
  routes: [{ path: '/timecards', title: 'Timecards' }],
  componentNames: ['DataGrid'],
  componentDescriptions: { DataGrid: 'Sortable table with column controls' },
  routeLayoutHints: { '/timecards': 'table page' },
  uiKnowledgeBase: 'Timecards lists one week of entries per worker.',
};

const FIGMA_REFERENCE = {
  updatedAt: '2026-09-01T00:00:00.000Z',
  navItems: [{ label: 'Timecards', route: '/timecards' }],
  tablePageBase64: 'QUJD',
  tablePageWidth: 1024,
  tablePageHeight: 810,
  tablePageLabel: 'MaxView reference page',
};

/** One feature with no route, so both paths take the NEW-page branch. */
const FEATURE = {
  title: 'Standup summary digest',
  description: 'Show the facilitator summary once every participant has posted.',
  items: [
    {
      type: 'PBI',
      title: 'Show the summary',
      description: 'The digest renders under the participant list.',
      acceptanceCriteria:
        'Given every update is in, when the deadline passes, then the digest renders',
      userTypes: ['S'],
    },
  ],
};

const DISPATCHED: AdmitV2RunResult = {
  status: 'dispatched',
  runId: 'run-1',
  attemptId: 'attempt-1',
  attemptNumber: 1,
  dispatchMessageId: 'dispatch-1',
  outboxId: 'outbox-1',
};

/* ── What each transport did with the reply ──────────────────────────────── */

/**
 * `accepted` means the transport treated the reply as a finished prototype;
 * `refused` means it stopped and said why. A truncated reply has to land on
 * the same verdict on both, with the same sentence — the harvest copies the
 * worker's detail onto the prototype row, where `generateSinglePrototype`
 * writes the in-process message.
 */
type Verdict = Readonly<{ verdict: 'accepted' | 'refused'; message?: string }>;

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
 * In-process generation is detached — the route returns and the UI polls — so
 * the row write lands after `generatePrototypesForPrd` resolves.
 */
async function waitForPrototypeRowWrite(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const written = mockRowWrites.find((values) => 'status' in values);
    if (written) return written;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('The in-process path never wrote the prototype row');
}

/**
 * The verdict the proven in-process path reaches, read off the row it writes:
 * `generateSinglePrototype` catches every generation error and turns it into
 * `generation_failed` plus the error message.
 */
async function inProcessVerdict(): Promise<Verdict> {
  arrangePrd();
  await generatePrototypesForPrd('prd-1', { isFeatureEnabled: async () => false });

  const written = await waitForPrototypeRowWrite();
  if (written.status === 'generation_failed') {
    return { verdict: 'refused', message: String(written.generationError) };
  }
  return { verdict: 'accepted' };
}

/**
 * The verdict the V2 lane reaches: App Service admits the specification and
 * the worker executes it through the same Bedrock client binding the worker
 * image uses. A thrown error here is the worker's terminal failure, and its
 * message is the detail the harvest writes onto the row.
 */
async function v2Verdict(): Promise<Verdict> {
  arrangePrd();

  let admitted: AiRunV2VisualSpecification | undefined;
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

  try {
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
    return { verdict: 'accepted' };
  } catch (error) {
    return {
      verdict: 'refused',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

beforeEach(() => {
  mockRowWrites.length = 0;
  mockStopReason = undefined;
});

describe('prototype Bedrock response parity between the in-process path and the V2 lane', () => {
  it('both refuse a response Bedrock cut off at the token ceiling, in the same words', async () => {
    mockStopReason = 'max_tokens';

    const inProcess = await inProcessVerdict();
    mockRowWrites.length = 0;
    const v2 = await v2Verdict();

    expect(inProcess.verdict).toBe('refused');
    expect(v2).toEqual(inProcess);
    expect(inProcess.message).toContain('truncated at 32000 output tokens');
  });

  it('both accept a response the model finished on its own', async () => {
    mockStopReason = 'end_turn';

    const inProcess = await inProcessVerdict();
    mockRowWrites.length = 0;
    const v2 = await v2Verdict();

    expect(inProcess).toEqual({ verdict: 'accepted' });
    expect(v2).toEqual(inProcess);
  });

  it('both accept a response that reports no stop reason', async () => {
    const inProcess = await inProcessVerdict();
    mockRowWrites.length = 0;
    const v2 = await v2Verdict();

    expect(inProcess).toEqual({ verdict: 'accepted' });
    expect(v2).toEqual(inProcess);
  });
});
