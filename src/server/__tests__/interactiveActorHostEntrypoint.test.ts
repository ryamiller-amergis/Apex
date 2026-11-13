import { HttpMethod, type DaprInvokerCallbackContent } from '@dapr/dapr';
import { retriedCallbackBudgetMs } from '../services/aiRunsWorker/callbackClient';
import {
  INTERACTIVE_ACTOR_INVOKE_TIMEOUT_MS,
  parseInteractiveDispatchRequest,
  registerInteractiveDispatchHandler,
} from '../services/interactiveActorHost/entrypoint';
import { createInFlightCounter } from '../services/interactiveActorHost/shutdownDrain';

describe('interactive actor host dispatch endpoint', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses the Dapr-wrapped JSON request body', () => {
    expect(
      parseInteractiveDispatchRequest({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).toEqual({
      threadId: 'thread-1',
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  it('rejects invalid JSON and incomplete dispatch identifiers', () => {
    expect(() => parseInteractiveDispatchRequest({ body: '{' })).toThrow(
      'Interactive dispatch body must be valid JSON'
    );
    expect(() =>
      parseInteractiveDispatchRequest({
        body: JSON.stringify({ threadId: 'thread-1', runId: 'run-1' }),
      })
    ).toThrow(
      'Interactive dispatch requires threadId, runId, and dispatchMessageId'
    );
  });

  it('registers POST /dispatch and invokes the thread actor', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>,
        options: { method: HttpMethod }
      ) => {
        callback = handler;
        expect(methodName).toBe('dispatch');
        expect(options).toEqual({ method: HttpMethod.POST });
      }
    );
    const handleTurn = jest.fn().mockResolvedValue({
      status: 'completed',
      cursorAgentId: 'agent-1',
    });
    const resolveActor = jest.fn(() => ({ handleTurn }));
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await registerInteractiveDispatchHandler({ listen }, resolveActor);
    expect(callback).toBeDefined();

    const result = await callback!({
      body: JSON.stringify({
        threadId: 'thread-1',
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      }),
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveActor).toHaveBeenCalledWith('thread-1');
    expect(handleTurn).toHaveBeenCalledWith({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  it('rejects an invalid dispatch without crashing the host', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    const resolveActor = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await registerInteractiveDispatchHandler({ listen }, resolveActor);

    await expect(callback!({ body: '{}' })).resolves.toEqual({
      accepted: false,
    });
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it('refuses a dispatch while the host drains, so the orchestrator retries it elsewhere', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    const resolveActor = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await registerInteractiveDispatchHandler({ listen }, resolveActor, undefined, {
      isDraining: () => true,
      track: (work) => work(),
    });

    await expect(
      callback!({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).resolves.toEqual({ accepted: false });
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it('counts an accepted dispatch as in flight until the actor replies', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    let replyFromActor: (value: { status: 'accepted' }) => void = () => {};
    const handleTurn = jest.fn(
      () =>
        new Promise<{ status: 'accepted' }>((resolve) => {
          replyFromActor = resolve;
        })
    );
    const counter = createInFlightCounter();
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await registerInteractiveDispatchHandler(
      { listen },
      () => ({ handleTurn }),
      undefined,
      { isDraining: () => false, track: (work) => counter.track(work) }
    );

    await expect(
      callback!({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).resolves.toEqual({ accepted: true });
    expect(counter.count()).toBe(1);

    replyFromActor({ status: 'accepted' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(counter.count()).toBe(0);
  });

  it('acknowledges dispatch and durably recovers an actor invocation failure', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    const handleTurn = jest
      .fn()
      .mockRejectedValue(new Error('actor unavailable'));
    const recoverActorFailure = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await registerInteractiveDispatchHandler(
      { listen },
      () => ({ handleTurn }),
      recoverActorFailure
    );

    await expect(
      callback!({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).resolves.toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"InteractiveDispatchFailed"')
    );
    expect(recoverActorFailure).toHaveBeenCalledWith(
      {
        threadId: 'thread-1',
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      },
      expect.objectContaining({ message: 'actor unavailable' })
    );
  });

  it('recovers a stalled actor invocation after the invoke timeout', async () => {
    jest.useFakeTimers();
    try {
      let callback:
        | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
        | undefined;
      const listen = jest.fn(
        async (
          _methodName: string,
          handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
        ) => {
          callback = handler;
        }
      );
      const handleTurn = jest.fn(() => new Promise<never>(() => {}));
      const recoverActorFailure = jest.fn().mockResolvedValue(undefined);
      const invocationStall = { recordCompleted: jest.fn(), recordTimedOut: jest.fn() };
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await registerInteractiveDispatchHandler(
        { listen },
        () => ({ handleTurn }),
        recoverActorFailure,
        undefined,
        1_000,
        invocationStall
      );

      await expect(
        callback!({
          body: JSON.stringify({
            threadId: 'thread-1',
            runId: 'run-1',
            dispatchMessageId: 'dispatch-1',
          }),
        })
      ).resolves.toEqual({ accepted: true });
      await jest.advanceTimersByTimeAsync(999);
      expect(recoverActorFailure).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"InteractiveDispatchFailed"')
      );
      expect(recoverActorFailure).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1' }),
        expect.objectContaining({ message: expect.stringContaining('timed out after 1000ms') })
      );
      expect(invocationStall.recordTimedOut).toHaveBeenCalledTimes(1);
      expect(invocationStall.recordCompleted).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not count a timeout as a stall when recovery cannot reach App Service', async () => {
    jest.useFakeTimers();
    try {
      let callback: ((content: DaprInvokerCallbackContent) => Promise<unknown>) | undefined;
      const listen = jest.fn(
        async (
          _methodName: string,
          handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
        ) => {
          callback = handler;
        }
      );
      const handleTurn = jest.fn(() => new Promise<never>(() => {}));
      const recoverActorFailure = jest.fn().mockRejectedValue(new Error('App Service unavailable'));
      const invocationStall = { recordCompleted: jest.fn(), recordTimedOut: jest.fn() };
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await registerInteractiveDispatchHandler(
        { listen },
        () => ({ handleTurn }),
        recoverActorFailure,
        undefined,
        1_000,
        invocationStall
      );
      await callback!({
        body: JSON.stringify({ threadId: 'thread-1', runId: 'run-1', dispatchMessageId: 'dispatch-1' }),
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"InteractiveDispatchFailureRecoveryFailed"')
      );
      expect(invocationStall.recordTimedOut).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('outlasts the retried bootstrap read so a slow start is not failed early', () => {
    expect(INTERACTIVE_ACTOR_INVOKE_TIMEOUT_MS).toBeGreaterThan(retriedCallbackBudgetMs(12_000));
  });

  it('scopes createBrainstormWorkspaceReader.searchCode to a single mounted source when path is provided', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { execFileSync } = await import('child_process');
    const { createBrainstormWorkspaceReader } = await import(
      '../services/interactiveActorHost/entrypoint'
    );

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-brainstorm-ws-'));
    const initGitRepo = (dir: string, fileName: string, content: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fileName), content);
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    };

    try {
      initGitRepo(path.join(workspace, 'sources', 'src-amego'), 'amego.ts', 'export const targetToken = "amego";\n');
      initGitRepo(path.join(workspace, 'sources', 'src-maxview'), 'maxview.ts', 'export const targetToken = "maxview";\n');

      const primaryReader = {
        identity: { provider: 'github' as const, project: 'Apex', repo: 'Apex', sha: 'a'.repeat(40) },
        readFile: jest.fn(),
        listDir: jest.fn(),
        searchCode: jest.fn().mockResolvedValue([
          {
            path: '/primary.ts',
            fileName: 'primary.ts',
            repository: 'Apex',
            project: 'Apex',
            matches: [{ lineNumber: 1, snippet: 'targetToken' }],
          },
        ]),
      };

      const reader = createBrainstormWorkspaceReader({
        destination: workspace,
        primaryReader,
        remotePrimaryReader: null,
        bootstrap: {
          specification: {
            workflowClass: 'brainstorm',
            grounding: { provider: 'github', project: 'Apex', repository: 'Apex', sha: 'a'.repeat(40), profileId: 'p1' },
            brainstorm: {
              sources: {
                readRoots: [
                  {
                    kind: 'project-repository',
                    sourceId: 'src-amego',
                    displayName: 'Amego',
                    provider: 'ado',
                    project: 'Amego',
                    repository: 'Amego',
                    commitSha: 'b'.repeat(40),
                    workspacePath: path.join(workspace, 'sources', 'src-amego'),
                  },
                  {
                    kind: 'project-repository',
                    sourceId: 'src-maxview',
                    displayName: 'MaxView',
                    provider: 'ado',
                    project: 'MaxView',
                    repository: 'MaxView',
                    commitSha: 'c'.repeat(40),
                    workspacePath: path.join(workspace, 'sources', 'src-maxview'),
                  },
                ],
                mcpServers: [],
                unavailableSources: [],
                instructions: '',
              },
            },
          },
        } as unknown as import('../../shared/types/aiRunIngest').InteractiveActorBootstrap,
      });

      const scoped = await reader.searchCode('targetToken', 10, 'sources/src-amego');
      expect(primaryReader.searchCode).not.toHaveBeenCalled();
      expect(scoped).toEqual([
        expect.objectContaining({
          path: '/sources/src-amego/amego.ts',
        }),
      ]);

      // Also scopes when the model passes the source displayName or repository name
      const scopedByName = await reader.searchCode('targetToken', 10, 'Amego');
      expect(scopedByName).toEqual([
        expect.objectContaining({
          path: '/sources/src-amego/amego.ts',
        }),
      ]);

      // Infers the target source when scopedPath is omitted but the query names one source
      const inferredFromQuery = await reader.searchCode('MaxView applicant tracking targetToken', 10);
      expect(primaryReader.searchCode).not.toHaveBeenCalled();
      expect(inferredFromQuery).toEqual([
        expect.objectContaining({
          path: '/sources/src-maxview/maxview.ts',
        }),
      ]);

      const unscoped = await reader.searchCode('targetToken', 2);
      expect(primaryReader.searchCode).toHaveBeenCalledWith('targetToken', 2);
      expect(unscoped).toHaveLength(2);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('reads Interview reference repositories under sources/<id> and leaves other paths on the primary reader', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { execFileSync } = await import('child_process');
    const { createBrainstormWorkspaceReader } = await import(
      '../services/interactiveActorHost/entrypoint'
    );

    const sourceId = '10000000-0000-4000-8000-00000000000a';
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-interview-ws-'));
    const sourceDir = path.join(workspace, 'sources', sourceId);
    try {
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'placement.ts'), 'export const placement = "maxview";\n');
      execFileSync('git', ['init'], { cwd: sourceDir });

      const primaryReader = {
        identity: { provider: 'ado' as const, project: 'ATS', repo: 'ats', sha: 'a'.repeat(40) },
        readFile: jest.fn().mockResolvedValue('primary'),
        listDir: jest.fn(),
        searchCode: jest.fn(),
      };
      const reader = createBrainstormWorkspaceReader({
        destination: workspace,
        primaryReader,
        remotePrimaryReader: null,
        bootstrap: {
          specification: {
            workflowClass: 'interview',
            grounding: { provider: 'ado', project: 'ATS', repository: 'ats', sha: 'a'.repeat(40), profileId: 'p1' },
            referenceSources: {
              readRoots: [{
                kind: 'project-repository',
                sourceId,
                displayName: 'MaxView',
                provider: 'ado',
                project: 'MaxView',
                repository: 'maxview-api',
                commitSha: 'b'.repeat(40),
                workspacePath: sourceDir,
              }],
              mcpServers: [],
              unavailableSources: [],
              instructions: '# Reference repositories',
            },
          },
        } as unknown as import('../../shared/types/aiRunIngest').InteractiveActorBootstrap,
      });

      await expect(reader.readFile(`sources/${sourceId}/placement.ts`)).resolves.toContain('maxview');
      expect(primaryReader.readFile).not.toHaveBeenCalled();
      await expect(reader.readFile('src/app.ts')).resolves.toBe('primary');
      expect(primaryReader.readFile).toHaveBeenCalledWith('src/app.ts');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
