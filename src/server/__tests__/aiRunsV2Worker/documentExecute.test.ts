import { createHash } from 'node:crypto';
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
    capacityClass: 'batch',
    specRef: {
      container: 'ai-run-artifacts',
      key: 'runs/run-1/attempts/1/spec.json',
    },
  };
}

function specification(
  overrides: Partial<AiRunV2DocumentSpecification> = {},
): AiRunV2DocumentSpecification {
  const skillContent = '# Frozen document skill\nFollow exact frozen rules.';
  return {
    workloadLane: 'document',
    prompt: 'Generate the PRD',
    model: 'claude-4',
    effort: null,
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillContent,
    skillSha256: createHash('sha256').update(skillContent).digest('hex'),
    workflowClass: 'prd',
    projectId: 'Apex',
    threadId: 'thread-1',
    deadlineMs: 60 * 60_000,
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
      expect(checkout).toBe(repoReader);
      expect(snapshot).toMatchObject({
        model: 'claude-4',
        skillPath: '.cursor/skills/to-prd/SKILL.md',
      });
      expect(snapshot.prompt).toContain('Generate the PRD');
      expect(snapshot.effort).toBeUndefined();
      expect(snapshot.prompt).toContain('# Frozen execution skill');
      expect(snapshot.prompt).toContain('# Frozen document skill');
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

    expect(openRepository.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        groundedSha: 'abc123',
        repository: 'apex',
      }),
    );
    expect(openRepository.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
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

  it('aborts a repository reader that hangs during startup', async () => {
    let receivedSignal: AbortSignal | undefined;
    let reportOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      reportOpened = resolve;
    });
    const openRepository = jest.fn(
      async (
        _specification: AiRunV2DocumentSpecification,
        signal?: AbortSignal,
      ): Promise<RepoReader> => {
        receivedSignal = signal;
        reportOpened();
        if (!signal) throw new Error('repository startup has no abort signal');
        return new Promise<RepoReader>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('repository startup aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const execute = createDocumentExecute({
      openRepository,
      createExecution: jest.fn(),
    } as Parameters<typeof createDocumentExecute>[0]);
    const controller = new AbortController();
    const running = execute({
      specification: specification(),
      command: command(),
      checkpoints: checkpoints(),
      signal: controller.signal,
    });
    await opened;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('aborts Cursor startup before Agent.create/send completes', async () => {
    let receivedSignal: AbortSignal | undefined;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const createExecution = jest.fn(
      async (
        _snapshot: unknown,
        _checkout?: RepoReader,
        signal?: AbortSignal,
      ) => {
        receivedSignal = signal;
        reportStarted();
        if (!signal) throw new Error('Cursor startup has no abort signal');
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('Cursor startup aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const execute = createDocumentExecute({
      openRepository: jest.fn().mockResolvedValue(repoReader),
      createExecution,
    } as Parameters<typeof createDocumentExecute>[0]);
    const controller = new AbortController();
    const running = execute({
      specification: specification(),
      command: command(),
      checkpoints: checkpoints(),
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal).toBe(controller.signal);
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

  it.each([
    {
      workflowClass: 'prd' as const,
      scratchInputs: [
        {
          path: '.ai-pilot/kickoff-transcript.md',
          content: '# Interview',
        },
      ],
      outputs: ['feature.prd.md', 'feature.backlog.json'],
    },
    {
      workflowClass: 'design-doc' as const,
      scratchInputs: [
        { path: '.ai-pilot/kickoff-context.md', content: '# Context' },
      ],
      outputs: [
        'feature-design.md',
        'feature-tech-spec.md',
        'feature-assumptions.md',
      ],
    },
    {
      workflowClass: 'validation' as const,
      scratchInputs: [
        { path: '.ai-pilot/kickoff-context.md', content: '# Context' },
      ],
      outputs: ['review-scorecard.json', 'review-scorecard.md'],
    },
    {
      workflowClass: 'test-cases' as const,
      scratchInputs: [
        { path: '.ai-pilot/kickoff-context.md', content: '# Context' },
        { path: '.ai-pilot/output/feature.prd.md', content: '# PRD' },
        { path: '.ai-pilot/output/feature.backlog.json', content: '{}' },
      ],
      outputs: [
        'feature.test-cases.json',
        'feature.test-cases.md',
        'feature.backlog.json',
      ],
    },
    {
      workflowClass: 'walkthrough-smart-tagging' as const,
      scratchInputs: [
        { path: '.ai-pilot/kickoff-context.md', content: '# Context' },
      ],
      outputs: ['walkthrough-anchor-smart-tagging.json'],
    },
  ])(
    'invokes $workflowClass with the frozen skill bytes',
    async ({ workflowClass, scratchInputs, outputs }) => {
      const createExecution = jest.fn(async (snapshot) => {
        expect(snapshot.prompt).toContain('# Frozen execution skill');
        expect(snapshot.prompt).toContain('Follow exact frozen rules.');
        return {
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
              for (const file of outputs) {
                await fs.writeFile(path.join(output, file), '{}');
              }
              return { status: 'finished' };
            },
          },
          dispose: jest.fn().mockResolvedValue(undefined),
        };
      });
      const execute = createDocumentExecute({
        openRepository: jest.fn().mockResolvedValue(repoReader),
        createExecution,
      });

      await execute({
        specification: specification({
          workflowClass,
          scratchInputs,
          ...(workflowClass === 'validation'
          || workflowClass === 'walkthrough-smart-tagging'
            ? {
                groundedSha: undefined,
                repository: undefined,
                provider: undefined,
              }
            : {}),
        }),
        command: command(),
        checkpoints: checkpoints(),
        signal: new AbortController().signal,
      });

      expect(createExecution).toHaveBeenCalledTimes(1);
    },
  );

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
  it('collects documented nested design-spec output', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'document-nested-output-'),
    );
    const nested = path.join(
      root,
      '.ai-pilot',
      'output',
      'billing-design-spec',
    );
    await fs.mkdir(nested, { recursive: true });
    for (const file of [
      'invoice-design.md',
      'invoice-tech-spec.md',
      'invoice-assumptions.md',
    ]) {
      await fs.writeFile(path.join(nested, file), file);
    }

    try {
      await expect(
        collectDocumentArtifacts(root, 'design-doc'),
      ).resolves.toEqual([
        expect.objectContaining({
          path: 'output/billing-design-spec/invoice-assumptions.md',
        }),
        expect.objectContaining({
          path: 'output/billing-design-spec/invoice-design.md',
        }),
        expect.objectContaining({
          path: 'output/billing-design-spec/invoice-tech-spec.md',
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects hard-linked files inside nested design-spec output', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'document-hostile-output-'),
    );
    const output = path.join(root, '.ai-pilot', 'output');
    const nested = path.join(output, 'billing-design-spec');
    const outside = path.join(root, 'outside-secret.md');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(outside, 'secret');
    await fs.link(outside, path.join(nested, 'invoice-design.md'));
    await fs.writeFile(
      path.join(nested, 'invoice-tech-spec.md'),
      'tech',
    );
    await fs.writeFile(
      path.join(nested, 'invoice-assumptions.md'),
      'assumptions',
    );

    try {
      await expect(
        collectDocumentArtifacts(root, 'design-doc'),
      ).rejects.toThrow('non-regular document output');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
