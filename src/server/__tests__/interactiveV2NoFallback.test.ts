import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ChatAttachment, ChatThread } from '../../shared/types/chat';
import {
  createInteractiveWorkflowRouter,
  type InteractiveWorkflowRouteInput,
} from '../services/interactiveWorkflowRouter';
import { InteractiveAttachmentError } from '../services/interactiveAttachmentStore';
import { createDurableInteractiveTurnService } from '../services/durableInteractiveTurnService';
import type { PreparedDurableInteractiveTurn } from '../services/durableInteractiveTurnRepository';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

type FailureStage =
  | 'attachment-validation'
  | 'attachment-upload'
  | 'classification'
  | 'grounding'
  | 'database'
  | 'outbox';

let activeFailureStage: FailureStage | null = null;
const injectedStageHits: FailureStage[] = [];

jest.mock('../services/interactiveTurnClassifier', () => {
  const actual = jest.requireActual(
    '../services/interactiveTurnClassifier',
  ) as typeof import('../services/interactiveTurnClassifier');
  return {
    ...actual,
    classifyInteractiveTurn: jest.fn(
      (input: Parameters<typeof actual.classifyInteractiveTurn>[0]) => {
        if (activeFailureStage === 'classification') {
          injectedStageHits.push('classification');
          throw new Error('stage-failed:classification');
        }
        return actual.classifyInteractiveTurn(input);
      },
    ),
  };
});

const SERVER_ROOT = resolve(__dirname, '..');
const SERVICES_ROOT = resolve(SERVER_ROOT, 'services');
const ROUTES_ROOT = resolve(SERVER_ROOT, 'routes');
const SHARED_ROOT = resolve(SERVER_ROOT, '../shared');

const THREAD_ID = '10000000-0000-4000-8000-000000000001';
const TURN_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '40000000-0000-4000-8000-000000000001';
const RUN_ID = '50000000-0000-4000-8000-000000000001';
const ATTACHMENT_ID = '60000000-0000-4000-8000-000000000001';

/**
 * Durable / retry admission graph roots. `chat.ts` also imports
 * `chatAgentService` for legacy flag-off send; that edge is documented and
 * excluded from the walk below. Retry itself only calls
 * `durableInteractiveTurnService.retry`.
 */
const DURABLE_SCAN_ROOTS = [
  resolve(SERVICES_ROOT, 'durableInteractiveTurnService.ts'),
  resolve(SERVICES_ROOT, 'durableInteractiveTurnRepository.ts'),
  resolve(SERVICES_ROOT, 'interactiveAttachmentStore.ts'),
  resolve(SERVICES_ROOT, 'interactiveTurnClassifier.ts'),
  resolve(SERVICES_ROOT, 'interactiveDeadlinePolicy.ts'),
  resolve(SERVICES_ROOT, 'interactiveToolGrantCrypto.ts'),
  resolve(SERVICES_ROOT, 'aiRunV2/outboxRepository.ts'),
];

const LEGACY_EXECUTION_STOP = resolve(SERVICES_ROOT, 'chatAgentService.ts');

const FORBIDDEN_DURABLE_IMPORT = [
  /from ['"]@cursor\/sdk['"]/,
  /require\(['"]@cursor\/sdk['"]\)/,
  /from ['"].*bedrockService['"]/,
  /require\(['"].*bedrockService['"]\)/,
  /from ['"].*\/Agent['"]/,
  /require\(['"].*\/Agent['"]\)/,
  /sendMessageLegacy/,
  /tryDispatchInteractiveTurn/,
  /\brunInProcess\b/,
];

const FORBIDDEN_DURABLE_IDENTIFIERS = [
  'Agent.create',
  'Agent.resume',
  'bedrockService',
  'sendMessageLegacy',
  'tryDispatchInteractiveTurn',
];

function relativeImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /from ['"](\.[^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match) {
    found.push(match[1]);
    match = pattern.exec(source);
  }
  return found;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isUnderScanTree(file: string): boolean {
  const normalized = file.split(sep).join('/');
  return (
    normalized.includes('/src/server/') || normalized.includes('/src/shared/')
  );
}

/**
 * Transitive relative-import closure for the durable admit/retry path.
 * Entering `chatAgentService.ts` is a hard failure (legacy execution).
 */
function collectDurableRetryGraph(roots: string[]): {
  files: string[];
  legacyEdges: string[];
} {
  const queue = [...roots];
  const seen = new Set<string>();
  const legacyEdges: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of relativeImports(source)) {
      const candidate = resolveImport(file, specifier);
      if (!candidate) continue;
      if (!isUnderScanTree(candidate)) continue;
      if (candidate.includes(`${sep}__tests__${sep}`)) continue;
      if (
        candidate === LEGACY_EXECUTION_STOP ||
        candidate.endsWith(`${sep}chatAgentService.ts`)
      ) {
        legacyEdges.push(`${file} -> ${candidate}`);
        continue;
      }
      queue.push(candidate);
    }
  }
  return { files: [...seen].sort(), legacyEdges };
}

function listServerTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '__tests__' ||
          entry.name === 'dist'
        ) {
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function authoritativeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    kickoff: {
      project: 'project-1',
      repo: 'repo-1',
      skillProvider: 'github',
      model: 'model-a',
      effort: 'low',
    },
    messages: [],
    status: 'idle',
    workspaceDir: '/tmp/thread',
    flagged: false,
    createdAt: '2026-09-23T14:00:00.000Z',
    lastActivityAt: '2026-09-23T15:00:02.000Z',
    ...overrides,
  };
}

function sampleAttachment(
  overrides: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    id: ATTACHMENT_ID,
    name: 'notes.txt',
    type: 'text/plain',
    size: 1,
    content: 'a',
    ...overrides,
  };
}

/**
 * Inject a real per-stage failure into durable admit, and wire the same
 * callback shape chatAgentService uses for the enabled path: `runLegacy`
 * wraps `sendMessageLegacy`, which would then post the legacy actor / run
 * in-process. Those spies are part of the SUT input so `.not.toHaveBeenCalled()`
 * is meaningful.
 */
function failStage(stage: FailureStage): {
  service: ReturnType<typeof createDurableInteractiveTurnService>;
  admitInput: Parameters<
    ReturnType<typeof createDurableInteractiveTurnService>['admit']
  >[0];
  reached: FailureStage[];
  sendMessageLegacy: jest.Mock;
  runLegacy: jest.Mock;
  runInProcess: jest.Mock;
  postLegacyActor: jest.Mock;
  repositoryAdmit: jest.Mock;
  attachmentUpload: jest.Mock;
} {
  activeFailureStage = stage;
  injectedStageHits.length = 0;
  const reached: FailureStage[] = [];

  const needsAttachment =
    stage === 'attachment-validation' || stage === 'attachment-upload';
  const needsGroundingSkill = stage === 'grounding';

  const thread = authoritativeThread(
    needsGroundingSkill
      ? {
          kickoff: {
            project: 'project-1',
            repo: 'repo-1',
            skillProvider: 'github',
            skillPath: '.cursor/skills/app-knowledge/SKILL.md',
            model: 'model-a',
            effort: 'low',
          },
        }
      : {},
  );

  const attachmentUpload = jest.fn(
    async (input: {
      attachment: ChatAttachment;
    }): Promise<{
      attachmentId: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      blobRef: { container: string; key: string };
      materializedPath: string;
    }> => {
      if (stage === 'attachment-validation') {
        reached.push('attachment-validation');
        throw new InteractiveAttachmentError(
          'INTERACTIVE_V2_ATTACHMENT_UNSUPPORTED',
          415,
        );
      }
      if (stage === 'attachment-upload') {
        reached.push('attachment-upload');
        throw new Error('stage-failed:attachment-upload');
      }
      return {
        attachmentId: input.attachment.id,
        name: input.attachment.name,
        contentType: input.attachment.type,
        sizeBytes: input.attachment.size,
        sha256: 'a'.repeat(64),
        blobRef: {
          container: 'ai-run-artifacts',
          key: `interactive/${input.attachment.id}`,
        },
        materializedPath: `.ai-pilot/attachments/${TURN_ID}/${input.attachment.name}`,
      };
    },
  );

  const repositoryAdmit = jest.fn(
    async (input: PreparedDurableInteractiveTurn) => {
      reached.push('database');
      if (stage === 'database') {
        throw new Error('stage-failed:database');
      }
      reached.push('outbox');
      if (stage === 'outbox') {
        throw new Error('stage-failed:outbox');
      }
      return {
        turnId: input.turnId,
        runId: RUN_ID,
        status: 'queued' as const,
        interactiveClass: input.interactiveClass,
        idempotent: false,
      };
    },
  );

  const resolveGrounding = jest.fn(async () => {
    if (stage === 'grounding') {
      reached.push('grounding');
      throw new Error('stage-failed:grounding');
    }
    return {
      provider: 'github' as const,
      project: 'project-1',
      repository: 'repo-1',
      sha: 'abc123',
      profileId: 'profile-1',
    };
  });

  const service = createDurableInteractiveTurnService({
    repository: {
      admit: repositoryAdmit,
      retry: jest.fn(),
    },
    attachmentStore: { upload: attachmentUpload },
    resolveThreadAccess: jest.fn().mockResolvedValue({
      access: 'owner',
      thread,
    }),
    resolveSkillConfig: jest.fn().mockResolvedValue({
      quickSkillPills: [
        {
          label: 'App Knowledge',
          skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        },
      ],
    }),
    loadSkill: jest.fn().mockResolvedValue({
      path: '.cursor/skills/app-knowledge/SKILL.md',
      content: '# App Knowledge\nAnswer from the repository.',
    }),
    resolveGrounding,
    resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
    resolveDeadlines: jest.fn(
      ({
        interactiveClass,
        requiresRepositoryPreparation,
      }: {
        interactiveClass: 'fast' | 'agentic';
        requiresRepositoryPreparation: boolean;
      }) => ({
        absoluteTurnMs: interactiveClass === 'fast' ? 300_000 : 1_200_000,
        repositoryPreparationMs: requiresRepositoryPreparation ? 120_000 : null,
        firstEventMs: 45_000,
        toolCallMs: 60_000,
      }),
    ),
    encryptToolGrant: jest.fn((input) => ({
      userId: input.userId,
      projectId: input.projectId,
      allowedOperations: input.allowedOperations,
      expiresAt: input.expiresAt,
      encryptedAdoToken: null,
    })),
    now: () => new Date('2026-09-23T16:00:00.000Z'),
  });

  const sendMessageLegacy = jest.fn().mockResolvedValue(undefined);
  const runInProcess = jest.fn().mockResolvedValue(undefined);
  const postLegacyActor = jest.fn().mockResolvedValue(undefined);
  // Mirrors chatAgentService enabled-path callback: legacy send wraps
  // sendMessageLegacy, which admits via the legacy router (actor / in-process).
  const runLegacy = jest.fn(async () => {
    await sendMessageLegacy();
    await postLegacyActor();
    await runInProcess();
  });

  return {
    service,
    admitInput: {
      threadId: THREAD_ID,
      userId: USER_ID,
      workflowClass: 'interview',
      turnId: TURN_ID,
      text: 'Hello durable world',
      attachments: needsAttachment ? [sampleAttachment()] : [],
    },
    get reached(): FailureStage[] {
      return [...reached, ...injectedStageHits];
    },
    sendMessageLegacy,
    runLegacy,
    runInProcess,
    postLegacyActor,
    repositoryAdmit,
    attachmentUpload,
  };
}

function makeRouterInput(
  overrides: Partial<InteractiveWorkflowRouteInput> &
    Pick<InteractiveWorkflowRouteInput, 'runLegacy' | 'admitDurable'>,
): InteractiveWorkflowRouteInput {
  return {
    userId: USER_ID,
    project: 'project-1',
    workflowClass: 'interview',
    threadId: THREAD_ID,
    ...overrides,
  };
}

describe('interactive V2 no-fallback guard', () => {
  afterEach(() => {
    activeFailureStage = null;
  });

  it.each([
    'attachment-validation',
    'attachment-upload',
    'classification',
    'grounding',
    'database',
    'outbox',
  ] as const)(
    'does not execute current path after %s failure',
    async (stage: FailureStage) => {
      const canonicalFlag = jest.fn().mockResolvedValue(true);
      const harness = failStage(stage);
      const router = createInteractiveWorkflowRouter({
        isFeatureEnabled: canonicalFlag,
        trackEvent: jest.fn(),
      });

      await expect(
        router.route(
          makeRouterInput({
            runLegacy: harness.runLegacy,
            admitDurable: () => harness.service.admit(harness.admitInput),
          }),
        ),
      ).rejects.toBeDefined();

      expect(canonicalFlag).toHaveBeenCalledWith(
        'ai-runs-v2-transport',
        expect.objectContaining({ userId: USER_ID }),
      );
      expect(harness.reached).toContain(stage);
      expect(harness.runLegacy).not.toHaveBeenCalled();
      expect(harness.sendMessageLegacy).not.toHaveBeenCalled();
      expect(harness.runInProcess).not.toHaveBeenCalled();
      expect(harness.postLegacyActor).not.toHaveBeenCalled();

      switch (stage) {
        case 'attachment-validation':
        case 'attachment-upload':
          expect(harness.attachmentUpload).toHaveBeenCalled();
          expect(harness.repositoryAdmit).not.toHaveBeenCalled();
          break;
        case 'classification':
          expect(harness.attachmentUpload).not.toHaveBeenCalled();
          expect(harness.repositoryAdmit).not.toHaveBeenCalled();
          break;
        case 'grounding':
          expect(harness.repositoryAdmit).not.toHaveBeenCalled();
          break;
        case 'database':
          expect(harness.repositoryAdmit).toHaveBeenCalled();
          expect(harness.reached).not.toContain('outbox');
          break;
        case 'outbox':
          expect(harness.repositoryAdmit).toHaveBeenCalled();
          expect(harness.reached).toEqual(
            expect.arrayContaining(['database', 'outbox']),
          );
          break;
        default: {
          const unhandled: never = stage;
          throw new Error(`Unhandled failure stage: ${String(unhandled)}`);
        }
      }
    },
  );

  it('never falls back to legacy when durable admission succeeds', async () => {
    activeFailureStage = null;
    const sendMessageLegacy = jest.fn().mockResolvedValue(undefined);
    const runInProcess = jest.fn().mockResolvedValue(undefined);
    const postLegacyActor = jest.fn().mockResolvedValue(undefined);
    const runLegacy = jest.fn(async () => {
      await sendMessageLegacy();
      await postLegacyActor();
      await runInProcess();
    });
    const service = createDurableInteractiveTurnService({
      repository: {
        admit: jest.fn(async (input: PreparedDurableInteractiveTurn) => ({
          turnId: input.turnId,
          runId: RUN_ID,
          status: 'queued' as const,
          interactiveClass: input.interactiveClass,
          idempotent: false,
        })),
        retry: jest.fn(),
      },
      attachmentStore: {
        upload: jest.fn(),
      },
      resolveThreadAccess: jest.fn().mockResolvedValue({
        access: 'owner',
        thread: authoritativeThread(),
      }),
      resolveSkillConfig: jest.fn().mockResolvedValue({ quickSkillPills: [] }),
      loadSkill: jest.fn().mockResolvedValue(null),
      resolveGrounding: jest.fn().mockResolvedValue(null),
      resolveMaxviewCapability: jest.fn().mockResolvedValue('disabled'),
      resolveDeadlines: jest.fn(() => ({
        absoluteTurnMs: 300_000,
        repositoryPreparationMs: null,
        firstEventMs: 45_000,
        toolCallMs: 60_000,
      })),
      encryptToolGrant: jest.fn((input) => ({
        userId: input.userId,
        projectId: input.projectId,
        allowedOperations: input.allowedOperations,
        expiresAt: input.expiresAt,
        encryptedAdoToken: null,
      })),
      now: () => new Date('2026-09-23T16:00:00.000Z'),
    });
    const router = createInteractiveWorkflowRouter({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      trackEvent: jest.fn(),
    });

    await expect(
      router.route(
        makeRouterInput({
          runLegacy,
          admitDurable: () =>
            service.admit({
              threadId: THREAD_ID,
              userId: USER_ID,
              workflowClass: 'interview',
              turnId: TURN_ID,
              text: 'Hello durable world',
              attachments: [],
            }),
        }),
      ),
    ).resolves.toMatchObject({
      route: 'durable',
    });
    expect(runLegacy).not.toHaveBeenCalled();
    expect(sendMessageLegacy).not.toHaveBeenCalled();
    expect(runInProcess).not.toHaveBeenCalled();
    expect(postLegacyActor).not.toHaveBeenCalled();
  });

  it('chatAgentService-shaped enabled callbacks never call sendMessageLegacy when stages fail', async () => {
    const stages: FailureStage[] = [
      'attachment-validation',
      'attachment-upload',
      'classification',
      'grounding',
      'database',
      'outbox',
    ];
    const router = createInteractiveWorkflowRouter({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      trackEvent: jest.fn(),
    });

    for (const stage of stages) {
      const harness = failStage(stage);
      await expect(
        router.route(
          makeRouterInput({
            runLegacy: harness.runLegacy,
            admitDurable: () => harness.service.admit(harness.admitInput),
          }),
        ),
      ).rejects.toBeDefined();
      expect(harness.sendMessageLegacy).not.toHaveBeenCalled();
      expect(harness.runLegacy).not.toHaveBeenCalled();
      expect(harness.runInProcess).not.toHaveBeenCalled();
      expect(harness.postLegacyActor).not.toHaveBeenCalled();
    }
  });

  it('scans the durable retry call graph for App Service Cursor/model execution imports', () => {
    const { files, legacyEdges } = collectDurableRetryGraph(DURABLE_SCAN_ROOTS);
    expect(files.length).toBeGreaterThan(5);

    // Documented boundaries: durable admit resolves thread access / linked ADR
    // and design-module helpers that import `getThread` from chatAgentService.
    // The walk stops at chatAgentService and never treats it as durable code.
    // Core durable modules must not import it directly.
    const normalizedEdges = legacyEdges
      .map((edge) => {
        const [from, to] = edge.replace(/\\/g, '/').split(' -> ');
        const base = (filePath: string) =>
          filePath.split('/').pop()!.replace(/\.ts$/, '');
        return `${base(from)} -> ${base(to)}`;
      })
      .sort();
    const allowedLegacyEdges = [
      'adrService -> chatAgentService',
      'designModuleService -> chatAgentService',
      'threadAccessService -> chatAgentService',
    ];
    expect(normalizedEdges).toEqual(allowedLegacyEdges);

    for (const root of [
      resolve(SERVICES_ROOT, 'durableInteractiveTurnService.ts'),
      resolve(SERVICES_ROOT, 'durableInteractiveTurnRepository.ts'),
      resolve(SERVICES_ROOT, 'interactiveAttachmentStore.ts'),
    ]) {
      const source = readFileSync(root, 'utf8');
      expect(source).not.toMatch(/chatAgentService/);
    }

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_DURABLE_IMPORT) {
        expect(source).not.toMatch(pattern);
      }
      for (const identifier of FORBIDDEN_DURABLE_IDENTIFIERS) {
        expect(source).not.toContain(identifier);
      }
    }

    // chat.ts wires legacy sendMessage for flag-off; durable retry must still
    // go through durableInteractiveTurnService.retry only.
    const chatRoute = readFileSync(resolve(ROUTES_ROOT, 'chat.ts'), 'utf8');
    expect(chatRoute).toMatch(/durableInteractiveTurnService\.retry\s*\(/);
    expect(chatRoute).toMatch(/from ['"]\.\.\/services\/chatAgentService['"]/);
    const retryHandler = chatRoute.slice(
      chatRoute.indexOf('/threads/:id/runs/:runId/retry'),
      chatRoute.indexOf('/threads/:id/runs/:runId/retry') + 2500,
    );
    expect(retryHandler).toMatch(/durableInteractiveTurnService\.retry/);
    expect(retryHandler).not.toMatch(/sendMessage\s*\(/);
    expect(retryHandler).not.toMatch(/sendMessageLegacy/);
    expect(retryHandler).not.toMatch(/tryDispatchInteractiveTurn/);
    expect(retryHandler).not.toMatch(/runInProcess/);
  });

  it('allows sendMessageLegacy only inside chatAgentService.ts', () => {
    const offenders: string[] = [];
    for (const file of listServerTsFiles(SERVER_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('sendMessageLegacy')) continue;
      const normalized = file.replace(/\\/g, '/');
      if (!normalized.endsWith('/services/chatAgentService.ts')) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('marks BR-014 and BR-017 as legacy-only under canonical flag-off', () => {
    const admission = readFileSync(
      resolve(SERVICES_ROOT, 'interactiveActorAdmissionService.ts'),
      'utf8',
    );
    const workflowTypes = readFileSync(
      resolve(SHARED_ROOT, 'types/interactiveWorkflow.ts'),
      'utf8',
    );
    const router = readFileSync(
      resolve(SERVICES_ROOT, 'interactiveWorkflowRouter.ts'),
      'utf8',
    );
    const chatAgent = readFileSync(
      resolve(SERVICES_ROOT, 'chatAgentService.ts'),
      'utf8',
    );

    expect(admission).toMatch(/legacy-only/i);
    expect(workflowTypes).toMatch(/legacy-only/i);
    expect(router).toMatch(/legacy-only/i);
    expect(chatAgent).toMatch(/legacy-only/i);

    // Canonical enabled path must not still describe shed/race as its contract.
    const enabledBranch = router.slice(
      router.indexOf('@feature-flag:ai-runs-v2-transport enabled-start'),
      router.indexOf('@feature-flag:ai-runs-v2-transport enabled-end'),
    );
    expect(enabledBranch).not.toMatch(/shed|race-lost|runInProcess|runLegacy/);
  });
});
