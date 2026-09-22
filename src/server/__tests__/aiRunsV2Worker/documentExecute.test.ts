import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2Command,
} from '../../../shared/types/aiRunV2';
import type { AiRunV2DocumentSpecification } from '../../../shared/types/aiRunV2DocumentSpec';
import type { RepoReader } from '../../../shared/types/repoReader';
import {
  collectDocumentArtifacts,
  createDocumentExecute,
} from '../../services/aiRunsV2Worker/documentExecution';

function command(): AiRunV2Command {
  return {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    eventId: 'event-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    dispatchMessageId: 'dispatch-1',
    timestamp: '2026-09-22T12:00:00.000Z',
    kind: 'dispatch_command',
    transport: 'servicebus-blob-v2',
    workloadLane: 'document',
    specRef: {
      container: 'ai-run-artifacts',
      key: 'runs/run-1/attempts/1/spec.json',
    },
  };
}

function specification(
  overrides: Partial<AiRunV2DocumentSpecification> = {},
): AiRunV2DocumentSpecification {
  return {
    workloadLane: 'document',
    prompt: 'Generate the PRD',
    model: 'claude-4',
    effort: null,
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    workflowClass: 'prd',
    projectId: 'Apex',
    threadId: 'thread-1',
    deadlineMs: 60 * 60_000,
    workspaceRef: 'C:\\app-service\\not-visible-to-worker',
    groundedSha: 'abc123',
    repository: 'apex',
    provider: 'ado',
    scratchInputs: [
      {
        path: '.ai-pilot/kickoff-transcript.md',
        content: '# Interview transcript',
      },
    ],
    ...overrides,
  };
}

function checkpoints() {
  return {
    publishStarted: jest.fn(),
    publishHeartbeat: jest.fn(),
    publishProgress: jest.fn().mockResolvedValue(undefined),
    lastSequence: jest.fn().mockReturnValue(0),
  };
}

const repoReader: RepoReader = {
  identity: {
    provider: 'ado',
    project: 'Apex',
    repo: 'apex',
    sha: 'abc123',
  },
  readFile: jest.fn(),
  listDir: jest.fn(),
  searchCode: jest.fn(),
};

describe('V2 document execution', () => {
  it('runs Cursor in an attempt workspace and returns only expected PRD outputs', async () => {
    let workspacePath = '';
    const dispose = jest.fn().mockResolvedValue(undefined);
    const openRepository = jest.fn().mockResolvedValue(repoReader);
    const createExecution = jest.fn(async (snapshot, checkout) => {
      workspacePath = snapshot.workspaceRef;
      expect(workspacePath).not.toBe(
        'C:\\app-service\\not-visible-to-worker',
      );
      expect(checkout).toBe(repoReader);
      expect(snapshot).toMatchObject({
        prompt: 'Generate the PRD',
        model: 'claude-4',
        skillPath: '.cursor/skills/to-prd/SKILL.md',
      });
      expect(snapshot.effort).toBeUndefined();
      await expect(
        fs.readFile(
          path.join(
            workspacePath,
            '.ai-pilot',
            'kickoff-transcript.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('# Interview transcript');

      return {
        run: {
          supports: () => false,
          async *stream() {
            return;
          },
          async wait() {
            const output = path.join(workspacePath, '.ai-pilot', 'output');
            await fs.mkdir(output, { recursive: true });
            await fs.writeFile(
              path.join(output, 'feature.prd.md'),
              '# Generated PRD',
            );
            await fs.writeFile(
              path.join(output, 'feature.backlog.json'),
              '{"epics":[]}',
            );
            await fs.writeFile(
              path.join(output, 'repository-secret.txt'),
              'do not upload',
            );
            await fs.mkdir(path.join(workspacePath, '.git'), {
              recursive: true,
            });
            await fs.writeFile(
              path.join(workspacePath, '.git', 'config'),
              'do not upload',
            );
            return {
              status: 'finished',
              usage: {
                inputTokens: 120,
                outputTokens: 340,
                cacheReadTokens: 10,
                cacheWriteTokens: 0,
              },
            };
          },
          cancel: jest.fn(),
        },
        dispose,
      };
    });
    const progress = checkpoints();
    const execute = createDocumentExecute({
      openRepository,
      createExecution,
    });

    const outcome = await execute({
      specification: specification(),
      command: command(),
      checkpoints: progress,
      signal: new AbortController().signal,
    });

    expect(openRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        groundedSha: 'abc123',
        repository: 'apex',
      }),
    );
    expect(outcome.files.map((file) => file.path)).toEqual([
      'output/feature.backlog.json',
      'output/feature.prd.md',
    ]);
    expect(outcome.usage).toEqual({
      inputTokens: 120,
      outputTokens: 340,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(fs.stat(workspacePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(progress.publishProgress).toHaveBeenCalledWith(
      'workspace',
      'preparing',
    );
    expect(progress.publishProgress).toHaveBeenCalledWith(
      'execution',
      'running',
    );
  });

  it('cleans the attempt workspace when Cursor execution fails', async () => {
    let workspacePath = '';
    const dispose = jest.fn().mockResolvedValue(undefined);
    const execute = createDocumentExecute({
      openRepository: jest.fn().mockResolvedValue(repoReader),
      createExecution: jest.fn(async (snapshot) => {
        workspacePath = snapshot.workspaceRef;
        return {
          run: {
            supports: () => false,
            async *stream() {
              return;
            },
            async wait() {
              throw new Error('Cursor failed');
            },
          },
          dispose,
        };
      }),
    });

    await expect(
      execute({
        specification: specification(),
        command: command(),
        checkpoints: checkpoints(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Cursor failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(fs.stat(workspacePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an incomplete specification before opening a provider', async () => {
    const openRepository = jest.fn();
    const createExecution = jest.fn();
    const execute = createDocumentExecute({
      openRepository,
      createExecution,
    });

    await expect(
      execute({
        specification: {
          ...specification(),
          model: undefined,
        } as never,
        command: command(),
        checkpoints: checkpoints(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid document specification');
    expect(openRepository).not.toHaveBeenCalled();
    expect(createExecution).not.toHaveBeenCalled();
  });

  it('runs scratch-only validation without opening a repository reader', async () => {
    const openRepository = jest.fn();
    const createExecution = jest.fn(async (snapshot, checkout) => ({
      run: {
        supports: () => false,
        async *stream() {
          return;
        },
        async wait() {
          const output = path.join(
            snapshot.workspaceRef,
            '.ai-pilot',
            'output',
          );
          await fs.writeFile(
            path.join(output, 'review-scorecard.json'),
            '{"overall_score":100}',
          );
          await fs.writeFile(
            path.join(output, 'review-scorecard.md'),
            '# Score',
          );
          expect(checkout).toBeUndefined();
          return { status: 'finished' };
        },
      },
      dispose: jest.fn().mockResolvedValue(undefined),
    }));
    const execute = createDocumentExecute({
      openRepository,
      createExecution,
    });

    await expect(
      execute({
        specification: specification({
          workflowClass: 'validation',
          skillPath: '.cursor/skills/prd-spec-review/SKILL.md',
          groundedSha: undefined,
          repository: undefined,
          provider: undefined,
          scratchInputs: [
            {
              path: '.ai-pilot/kickoff-context.md',
              content: '# Document',
            },
          ],
        }),
        command: command(),
        checkpoints: checkpoints(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      files: [
        expect.objectContaining({ path: 'output/review-scorecard.json' }),
        expect.objectContaining({ path: 'output/review-scorecard.md' }),
      ],
    });
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('cancels Cursor and cleans up when the attempt signal aborts', async () => {
    let workspacePath = '';
    const cancel = jest.fn().mockResolvedValue(undefined);
    const dispose = jest.fn().mockResolvedValue(undefined);
    let reportWaitStarted!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      reportWaitStarted = resolve;
    });
    const execute = createDocumentExecute({
      openRepository: jest.fn().mockResolvedValue(repoReader),
      createExecution: jest.fn(async (snapshot) => {
        workspacePath = snapshot.workspaceRef;
        return {
          run: {
            supports: () => false,
            async *stream() {
              return;
            },
            wait: () =>
              new Promise<never>(() => {
                reportWaitStarted();
              }),
            cancel,
          },
          dispose,
        };
      }),
    });
    const controller = new AbortController();
    const running = execute({
      specification: specification(),
      command: command(),
      checkpoints: checkpoints(),
      signal: controller.signal,
    });
    await waitStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    await expect(fs.stat(workspacePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('document artifact allowlists', () => {
  it.each([
    [
      'design-doc',
      [
        'feature-design.md',
        'feature-tech-spec.md',
        'feature-assumptions.md',
      ],
    ],
    ['validation', ['review-scorecard.json', 'review-scorecard.md']],
    [
      'test-cases',
      [
        'feature.backlog.json',
        'feature.test-cases.json',
        'feature.test-cases.md',
      ],
    ],
    [
      'walkthrough-smart-tagging',
      ['walkthrough-anchor-smart-tagging.json'],
    ],
  ] as const)(
    'collects only the expected %s output set',
    async (workflowClass, expected) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'document-output-test-'),
      );
      const output = path.join(root, '.ai-pilot', 'output');
      await fs.mkdir(output, { recursive: true });
      for (const file of expected) {
        await fs.writeFile(path.join(output, file), file);
      }
      await fs.writeFile(path.join(output, 'secret.env'), 'TOKEN=secret');
      if (workflowClass === 'test-cases') {
        await fs.writeFile(path.join(output, 'feature.prd.md'), '# input');
      }

      try {
        const files = await collectDocumentArtifacts(root, workflowClass);
        expect(files.map((file) => file.path)).toEqual(
          [...expected].sort().map((file) => `output/${file}`),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
