import {
  createLocalCursorRevisionEditAgentProvider,
  type RevisionEditAgentRuntime,
} from '../services/build/buildRevisionEditAgent';

const BASE_COMMIT = 'a'.repeat(40);

describe('local Cursor revision edit agent', () => {
  it('uses the deterministic lane before starting a model-backed agent', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(),
    };
    const tryDeterministicEdit = jest.fn().mockResolvedValue({
      kind: 'edited',
      changedPath: 'apps/web/src/features/profile/ProfileForm.tsx',
    });
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
      tryDeterministicEdit,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Change the Cancel button text to Dismiss.',
        revisionNumber: 2,
      })
    ).resolves.toEqual({
      kind: 'edited',
      agentCorrelationRef: 'deterministic:literal-copy',
    });
    expect(tryDeterministicEdit).toHaveBeenCalledWith({
      workspacePath: 'C:\\scratch\\revision-2',
      feedback: 'Change the Cancel button text to Dismiss.',
    });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('sends a recovered draft and its failing checks to the agent for repair', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async () => ({
        agentCorrelationRef: 'agent:cursor-local:repair',
        output: '{"outcome":"edited"}',
      })),
    };
    const tryDeterministicEdit = jest.fn();
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => true,
      tryDeterministicEdit,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'add icons to the menu pages',
        revisionNumber: 2,
        recoveredDraft: true,
        repairContext: "typecheck: Cannot find module '@mui/icons-material/Nope'",
      })
    ).resolves.toEqual({
      kind: 'edited',
      agentCorrelationRef: 'agent:cursor-local:repair',
    });
    expect(tryDeterministicEdit).not.toHaveBeenCalled();
    expect(jest.mocked(runtime.run).mock.calls[0][0].prompt).toContain(
      "Cannot find module '@mui/icons-material/Nope'"
    );
  });

  it('aborts a revision edit that exceeds its bounded runtime', async () => {
    let observedAbort = false;
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(
        (input) =>
          new Promise((_, reject) => {
            input.signal.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(input.signal.reason);
              },
              { once: true }
            );
          })
      ),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
      timeoutMs: 10,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Change the heading.',
        revisionNumber: 2,
      })
    ).rejects.toThrow('timed out');
    expect(observedAbort).toBe(true);
  });

  it('propagates build cancellation to the active revision edit', async () => {
    const controller = new AbortController();
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(
        (input) =>
          new Promise((_, reject) => {
            input.signal.addEventListener(
              'abort',
              () => reject(input.signal.reason),
              { once: true }
            );
          })
      ),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
      timeoutMs: 60_000,
    });
    const editing = provider.edit({
      workspacePath: 'C:\\scratch\\revision-2',
      baseCommit: BASE_COMMIT,
      feedback: 'Change the heading.',
      revisionNumber: 2,
      signal: controller.signal,
    });

    controller.abort(new Error('Fast revision cancelled.'));

    await expect(editing).rejects.toThrow('cancelled');
  });

  it('allows only file inspection and editing tools, loads project settingSources, and disables MCP servers', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          agentCorrelationRef: 'agent:cursor-local:run-1',
          output: JSON.stringify({ outcome: 'edited' }),
        };
      }),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Move the Cancel button to the right.',
        revisionNumber: 2,
      })
    ).resolves.toEqual({
      kind: 'edited',
      agentCorrelationRef: 'agent:cursor-local:run-1',
    });

    expect(calls[0]).toMatchObject({
      modelId: 'composer-2.5',
      tools: ['read', 'edit', 'grep', 'glob', 'ls'],
      settingSources: ['project'],
      mcpServers: {},
    });
    expect(calls[0]).not.toHaveProperty('shell');
    expect(calls[0].tools).not.toContain('task');
    expect(calls[0].tools).not.toContain('web');
  });

  it('automatically falls back to composer-2.5 when a requested modelOverride like grok-4.7 is blocked or unavailable', async () => {
    const modelsTried: string[] = [];
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async (input) => {
        modelsTried.push(input.modelId ?? '');
        if (input.modelId === 'grok-4.7') {
          throw new Error('Model grok-4.7 is blocked by team policy.');
        }
        return {
          agentCorrelationRef: 'agent:cursor-local:fallback',
          output: JSON.stringify({ outcome: 'edited' }),
        };
      }),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Center the dashboard layout.',
        revisionNumber: 2,
        modelId: 'grok-4.7',
      })
    ).resolves.toEqual({
      kind: 'edited',
      agentCorrelationRef: 'agent:cursor-local:fallback',
    });
    expect(modelsTried).toEqual(['grok-4.7', 'composer-2.5']);
  });

  it('rejects a scratch checkout that is not at the exact base commit', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => 'b'.repeat(40),
      hasWorkspaceChanges: async () => false,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Change the heading.',
        revisionNumber: 2,
      })
    ).rejects.toThrow('exact base commit');
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it('allows a persisted failed draft to be replayed before retrying the edit', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async () => ({
        agentCorrelationRef: 'agent:cursor-local:retry-1',
        output: JSON.stringify({ outcome: 'edited' }),
      })),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => true,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Fix the failed card spacing update.',
        revisionNumber: 2,
        recoveredDraft: true,
      })
    ).resolves.toMatchObject({ kind: 'edited' });
    expect(runtime.run).toHaveBeenCalledTimes(1);
  });

  it('escalates when repository inspection finds structural work', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async () => ({
        agentCorrelationRef: 'agent:cursor-local:run-2',
        output: JSON.stringify({
          outcome: 'escalate',
          reason: 'The label comes from a new API field.',
        }),
      })),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Add the status label.',
        revisionNumber: 2,
      })
    ).resolves.toEqual({
      kind: 'escalate',
      reason: 'The label comes from a new API field.',
      agentCorrelationRef: 'agent:cursor-local:run-2',
    });
  });

  it('escalates malformed agent output instead of guessing', async () => {
    const runtime: RevisionEditAgentRuntime = {
      run: jest.fn(async () => ({
        agentCorrelationRef: null,
        output: 'I think this should be fine.',
      })),
    };
    const provider = createLocalCursorRevisionEditAgentProvider({
      runtime,
      readHeadCommit: async () => BASE_COMMIT,
      hasWorkspaceChanges: async () => false,
    });

    await expect(
      provider.edit({
        workspacePath: 'C:\\scratch\\revision-2',
        baseCommit: BASE_COMMIT,
        feedback: 'Improve the cards.',
        revisionNumber: 2,
      })
    ).resolves.toMatchObject({
      kind: 'escalate',
      reason: 'The edit agent could not confirm a contained UI change.',
    });
  });
});
