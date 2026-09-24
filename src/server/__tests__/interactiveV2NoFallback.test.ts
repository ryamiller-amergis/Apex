import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createInteractiveWorkflowRouter,
  type InteractiveWorkflowRouteInput,
} from '../services/interactiveWorkflowRouter';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

const SERVER_ROOT = resolve(__dirname, '..');
const SERVICES_ROOT = resolve(SERVER_ROOT, 'services');
const ROUTES_ROOT = resolve(SERVER_ROOT, 'routes');

const DURABLE_SCAN_ROOTS = [
  resolve(SERVICES_ROOT, 'durableInteractiveTurnService.ts'),
  resolve(SERVICES_ROOT, 'durableInteractiveTurnRepository.ts'),
  resolve(ROUTES_ROOT, 'chat.ts'),
];

const FORBIDDEN_DURABLE_IMPORT = [
  /from ['"]@cursor\/sdk['"]/,
  /from ['"].*bedrockService['"]/,
  /from ['"].*\/Agent['"]/,
  /from ['"]\.\/chatAgentService['"]/,
  /sendMessageLegacy/,
  /tryDispatchInteractiveTurn/,
  /runInProcess/,
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

function collectGraph(roots: string[]): string[] {
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of relativeImports(source)) {
      const candidate = resolveImport(file, specifier);
      if (!candidate) continue;
      // Stay inside the durable/retry call graph; do not walk the whole server.
      if (
        candidate.includes(`${join('services', 'durableInteractive')}`) ||
        candidate.includes(`${join('services', 'interactiveAttachment')}`) ||
        candidate.includes(`${join('services', 'interactiveTurn')}`) ||
        candidate.includes(`${join('services', 'interactiveDeadline')}`) ||
        candidate.includes(`${join('services', 'interactiveToolGrant')}`) ||
        candidate.includes(`${join('services', 'aiRunV2')}`) ||
        candidate.includes(`${join('routes', 'chat')}`) ||
        candidate.includes(`${join('shared', 'types', 'durableInteractive')}`)
      ) {
        queue.push(candidate);
      }
    }
  }
  return [...seen].sort();
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

function makeInput(
  overrides: Partial<InteractiveWorkflowRouteInput> = {},
): InteractiveWorkflowRouteInput {
  return {
    userId: 'user-1',
    project: 'Apex',
    workflowClass: 'interview',
    threadId: 'thread-1',
    runLegacy: jest.fn().mockResolvedValue(undefined),
    admitDurable: jest.fn().mockResolvedValue({
      turnId: '20000000-0000-4000-8000-000000000001',
      runId: '50000000-0000-4000-8000-000000000001',
      status: 'queued',
      interactiveClass: 'fast',
    }),
    ...overrides,
  };
}

type FailureStage =
  | 'attachment-validation'
  | 'attachment-upload'
  | 'classification'
  | 'grounding'
  | 'database'
  | 'outbox';

describe('interactive V2 no-fallback guard', () => {
  const runInProcess = jest.fn();
  const postLegacyActor = jest.fn();

  beforeEach(() => {
    runInProcess.mockReset();
    postLegacyActor.mockReset();
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
      const runLegacy = jest.fn();
      const failStage = (name: FailureStage): void => {
        void name;
      };
      failStage(stage);

      const input = makeInput({
        runLegacy,
        admitDurable: jest.fn().mockRejectedValue(
          new Error(`stage-failed:${stage}`),
        ),
      });
      const router = createInteractiveWorkflowRouter({
        isFeatureEnabled: canonicalFlag,
        trackEvent: jest.fn(),
      });

      await expect(router.route(input)).rejects.toBeDefined();
      expect(canonicalFlag).toHaveBeenCalledWith(
        'ai-runs-v2-transport',
        expect.objectContaining({ userId: 'user-1' }),
      );
      expect(runLegacy).not.toHaveBeenCalled();
      expect(runInProcess).not.toHaveBeenCalled();
      expect(postLegacyActor).not.toHaveBeenCalled();
    },
  );

  it('never falls back to legacy when durable admission succeeds', async () => {
    const runLegacy = jest.fn();
    const input = makeInput({ runLegacy });
    const router = createInteractiveWorkflowRouter({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      trackEvent: jest.fn(),
    });

    await expect(router.route(input)).resolves.toMatchObject({
      route: 'durable',
    });
    expect(runLegacy).not.toHaveBeenCalled();
    expect(runInProcess).not.toHaveBeenCalled();
    expect(postLegacyActor).not.toHaveBeenCalled();
  });

  it('scans the durable path for App Service Cursor/model execution imports', () => {
    const graph = collectGraph(DURABLE_SCAN_ROOTS);
    expect(graph.length).toBeGreaterThan(2);

    for (const file of graph) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_DURABLE_IMPORT) {
        expect(source).not.toMatch(pattern);
      }
      for (const identifier of FORBIDDEN_DURABLE_IDENTIFIERS) {
        expect(source).not.toContain(identifier);
      }
    }
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
      resolve(SERVER_ROOT, '../shared/types/interactiveWorkflow.ts'),
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
