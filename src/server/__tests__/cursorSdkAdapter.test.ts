/**
 * TBI-002 (DoD-1, DoD-2, NFR no policy), TBI-001 (VT-06), TBI-003 (DoD-3 / VT-27):
 * RED -> GREEN unit and parity suite for `cursorSdkAdapter`.
 */
const mockCreateAgent = jest.fn();
const mockResumeAgent = jest.fn();
const mockPrewarmWorkspace = jest.fn();
const mockCreateAgentPlatform = jest.fn();

jest.mock('@cursor/sdk', () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreateAgent(...args),
    resume: (...args: unknown[]) => mockResumeAgent(...args),
  },
  createAgentPlatform: (...args: unknown[]) => mockCreateAgentPlatform(...args),
}));

import {
  AdapterResumeStalledError,
  AdapterSpecificationError,
  createCursorSdkAdapter,
  deriveInteractiveCursorExecutionFields,
  deriveWorkerCursorExecutionFields,
  type AdapterSpecification,
} from '../services/cursorSdkAdapter';
import {
  hasExplicitCursorExecutionFields,
  type ExecutionSnapshot,
} from '../../shared/types/agentRunLifecycle';
import { isInteractiveActorBootstrap } from '../../shared/types/aiRunIngest';
import { acquireInteractiveCursorAgent } from '../services/interactiveActorHost/interactiveCursorExecution';
import { createLocalCursorExecution } from '../services/aiRunsWorker/cursorExecution';
import { createNativeReadTools } from '../services/nativeReadToolAdapter';
import { guidedInterviewRepositoryTools } from '../services/interviewGroundingPolicy';
import type { RepoReader } from '../../shared/types/repoReader';
import type { PlaybookAgentRunPolicy } from '../../shared/types/playbookExecutionCapability';
import { createHash } from 'node:crypto';

function baseSpec(overrides: Partial<AdapterSpecification> = {}): AdapterSpecification {
  return {
    sessionKey: 'thread-1',
    compatibilityKey: 'composer-2.5|/ws/thread-1|none|',
    model: { id: 'composer-2.5' },
    workspaceRef: '/ws/thread-1',
    skillContent: null,
    toolAllowlist: null,
    disallowedTools: [],
    settingSources: [],
    sandbox: { enabled: false },
    mcpServers: {},
    priorAgentBinding: null,
    requestId: 'req-run-1',
    ...overrides,
  };
}

function makeMockRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sdk-run-1',
    agentId: 'agent-1',
    status: 'running',
    supports: jest.fn().mockReturnValue(true),
    unsupportedReason: jest.fn().mockReturnValue(undefined),
    stream: async function* () {
      yield {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'sdk-run-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      };
    },
    wait: jest.fn().mockResolvedValue({
      id: 'sdk-run-1',
      requestId: 'sdk-returned-req-1',
      status: 'finished',
      result: 'Done.',
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 180,
      },
    }),
    steer: jest.fn().mockResolvedValue('complete_delivered'),
    cancel: jest.fn().mockResolvedValue(undefined),
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 180,
    },
    ...overrides,
  };
}

function makeMockSdkAgent(id = 'agent-1', run = makeMockRun()) {
  const dispose = jest.fn().mockResolvedValue(undefined);
  const send = jest.fn().mockResolvedValue(run);
  const summarize = jest.fn().mockResolvedValue(
    makeMockRun({
      id: 'sdk-summary-run-1',
      wait: jest.fn().mockResolvedValue({
        id: 'sdk-summary-run-1',
        status: 'finished',
        result: 'Summary completed',
      }),
    }),
  );
  const getUsage = jest.fn().mockResolvedValue({
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 180,
    },
    cost: {
      rawCostCents: 3.4,
      chargedCents: 2.8,
    },
    runs: [],
  });
  return {
    id,
    agentId: id,
    send,
    summarize,
    getUsage,
    close: jest.fn(),
    reload: jest.fn().mockResolvedValue(undefined),
    listArtifacts: jest.fn().mockResolvedValue([]),
    downloadArtifact: jest.fn(),
    [Symbol.asyncDispose]: dispose,
    __run: run,
    __dispose: dispose,
  };
}

describe('cursorSdkAdapter acquisition ladder (TBI-002 DoD-1)', () => {
  const originalKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CURSOR_API_KEY = 'adapter-test-key';
    mockCreateAgentPlatform.mockResolvedValue({
      prewarmLocalWorkspace: (...args: unknown[]) => mockPrewarmWorkspace(...args),
    });
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalKey;
  });

  it('DoD-1 / VT-11: returns warm handle on a compatible cache hit with zero SDK calls', async () => {
    const sdkAgent = makeMockSdkAgent('agent-warm');
    mockCreateAgent.mockResolvedValueOnce(sdkAgent);
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const first = await adapter.acquire(baseSpec(), {});
    expect(first.mode).toBe('recreated');
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);

    const second = await adapter.acquire(baseSpec(), {});
    expect(second.mode).toBe('warm');
    expect(second.agentId).toBe('agent-warm');
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockResumeAgent).not.toHaveBeenCalled();
  });

  it('DoD-1 / VT-12: resumes a prior binding and emits onProgress before Agent.resume settles', async () => {
    const events: string[] = [];
    const sdkAgent = makeMockSdkAgent('agent-resumed');
    mockResumeAgent.mockImplementationOnce(async () => {
      events.push('sdk-resume-settled');
      return sdkAgent;
    });

    const adapter = createCursorSdkAdapter({ cacheMax: 4 });
    const acquired = await adapter.acquire(
      baseSpec({ priorAgentBinding: 'agent-resumed' }),
      {
        onProgress: (label) => {
          events.push(`progress:${label}`);
        },
      },
    );

    expect(acquired.mode).toBe('resumed');
    expect(acquired.agentId).toBe('agent-resumed');
    expect(events[0]).toMatch(/^progress:/);
    expect(events[1]).toBe('sdk-resume-settled');
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it('DoD-1 / VT-13: creates a new agent when no prior binding is set', async () => {
    mockCreateAgent.mockResolvedValueOnce(makeMockSdkAgent('agent-fresh'));
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const acquired = await adapter.acquire(baseSpec({ priorAgentBinding: null }), {});

    expect(acquired.mode).toBe('recreated');
    expect(acquired.agentId).toBe('agent-fresh');
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    expect(mockResumeAgent).not.toHaveBeenCalled();
  });

  it('DoD-1 / VT-14: recreates when Agent.resume throws structural agent_not_found and does not reuse the old id', async () => {
    mockResumeAgent.mockRejectedValueOnce(
      Object.assign(new Error('Agent gone'), { code: 'agent_not_found' }),
    );
    mockCreateAgent.mockResolvedValueOnce(makeMockSdkAgent('agent-recreated'));
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const acquired = await adapter.acquire(
      baseSpec({ priorAgentBinding: 'stale-agent-1037' }),
      {},
    );

    expect(acquired.mode).toBe('recreated');
    expect(acquired.agentId).toBe('agent-recreated');
    expect(mockResumeAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);

    await adapter.release('thread-1');
    mockCreateAgent.mockResolvedValueOnce(makeMockSdkAgent('agent-recreated-2'));
    const next = await adapter.acquire(
      baseSpec({ priorAgentBinding: 'stale-agent-1037' }),
      {},
    );
    expect(next.mode).toBe('recreated');
    expect(mockResumeAgent).toHaveBeenCalledTimes(1);
  });

  it('DoD-1 / VT-15: throws AdapterResumeStalledError on abort, disposes late agent, and marks the id unresumable', async () => {
    let resolveLateResume!: (agent: ReturnType<typeof makeMockSdkAgent>) => void;
    mockResumeAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLateResume = resolve;
        }),
    );
    const abort = new AbortController();
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const pending = adapter.acquire(
      baseSpec({ priorAgentBinding: 'hung-agent-1' }),
      { signal: abort.signal },
    );
    abort.abort(new Error('first_event_timeout'));

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: 'AdapterResumeStalledError',
        agentId: 'hung-agent-1',
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(AdapterResumeStalledError);

    const lateAgent = makeMockSdkAgent('hung-agent-1');
    resolveLateResume(lateAgent);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateAgent.__dispose).toHaveBeenCalledTimes(1);

    mockCreateAgent.mockResolvedValueOnce(makeMockSdkAgent('fresh-after-stall'));
    const second = await adapter.acquire(
      baseSpec({ priorAgentBinding: 'hung-agent-1' }),
      {},
    );
    expect(second.mode).toBe('recreated');
    expect(second.agentId).toBe('fresh-after-stall');
    expect(mockResumeAgent).toHaveBeenCalledTimes(1);
  });
});

describe('cursorSdkAdapter operations, requestId, prewarm, and max-mode (TBI-002 DoD-2, TBI-003 DoD-3, TBI-001 VT-06)', () => {
  const originalKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CURSOR_API_KEY = 'adapter-test-key';
    mockCreateAgentPlatform.mockResolvedValue({
      prewarmLocalWorkspace: (...args: unknown[]) => mockPrewarmWorkspace(...args),
    });
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalKey;
  });

  it('DoD-2 / VT-16: exposes steer, summarize, cancel, and readUsage (tokens plus optional SDK cost)', async () => {
    const run = makeMockRun();
    const sdkAgent = makeMockSdkAgent('agent-ops', run);
    mockCreateAgent.mockResolvedValueOnce(sdkAgent);
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const handle = await adapter.acquire(baseSpec(), {});
    const startedRun = await handle.send('Inspect the service');
    await startedRun.wait();

    const steerOutcome = await handle.steer('Focus on error handling');
    expect(steerOutcome).toBe('complete_delivered');
    expect(run.steer).toHaveBeenCalledWith('Focus on error handling');

    await handle.summarize();
    expect(sdkAgent.summarize).toHaveBeenCalledTimes(1);

    await handle.cancel();
    expect(run.cancel).toHaveBeenCalledTimes(1);

    const usage = await handle.readUsage();
    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 180,
      cost: {
        rawCostCents: 3.4,
        chargedCents: 2.8,
      },
    });
  });

  it('TBI-003 DoD-3 / VT-27: forwards specification requestId on every send', async () => {
    const sdkAgent = makeMockSdkAgent('agent-req');
    mockCreateAgent.mockResolvedValueOnce(sdkAgent);
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const handle = await adapter.acquire(
      baseSpec({ requestId: 'req-fixed-42' }),
      {},
    );
    await handle.send('First turn');
    await handle.send('Second turn', {
      mcpServers: { 'ado-skills': { url: 'https://apex.example/mcp' } },
    });

    expect(sdkAgent.send).toHaveBeenNthCalledWith(
      1,
      'First turn',
      expect.objectContaining({ idempotencyKey: 'req-fixed-42' }),
    );
    expect(sdkAgent.send).toHaveBeenNthCalledWith(
      2,
      'Second turn',
      expect.objectContaining({
        idempotencyKey: 'req-fixed-42',
        mcpServers: { 'ado-skills': { url: 'https://apex.example/mcp' } },
      }),
    );
  });

  it('exposes workspace prewarm and tears down the release handle on disposeAll', async () => {
    const releasePrewarm = jest.fn().mockResolvedValue(undefined);
    mockPrewarmWorkspace.mockResolvedValueOnce(releasePrewarm);
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    await adapter.prewarm(baseSpec({ workspaceRef: '/ws/prewarm' }));

    expect(mockPrewarmWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'adapter-test-key',
        model: { id: 'composer-2.5' },
        local: expect.objectContaining({
          cwd: '/ws/prewarm',
          settingSources: [],
          sandboxOptions: { enabled: false },
        }),
      }),
    );

    await adapter.disposeAll();
    expect(releasePrewarm).toHaveBeenCalledTimes(1);
  });

  it('TBI-001 NFR / VT-06: completes a turn for a max-mode model selection', async () => {
    const sdkAgent = makeMockSdkAgent('agent-max');
    mockCreateAgent.mockResolvedValueOnce(sdkAgent);
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    const handle = await adapter.acquire(
      baseSpec({
        model: {
          id: 'claude-sonnet-4-5-max',
          maxMode: true,
        },
      }),
      {},
    );
    const run = await handle.send('Summarize large repository context');
    const waited = await run.wait();

    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: 'claude-sonnet-4-5-max', maxMode: true },
      }),
    );
    expect(waited.status).toBe('finished');
  });
});

describe('cursorSdkAdapter no-policy validation and parity (TBI-002 NFR / VT-18)', () => {
  const originalKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CURSOR_API_KEY = 'parity-test-key';
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalKey;
  });

  it('VT-18: throws AdapterSpecificationError before any SDK call when model or required fields are missing', async () => {
    const adapter = createCursorSdkAdapter({ cacheMax: 4 });

    await expect(
      adapter.acquire(
        baseSpec({ model: { id: '   ' } }),
        {},
      ),
    ).rejects.toBeInstanceOf(AdapterSpecificationError);

    await expect(
      adapter.acquire(
        {
          ...baseSpec(),
          requestId: '',
        },
        {},
      ),
    ).rejects.toBeInstanceOf(AdapterSpecificationError);

    expect(mockCreateAgent).not.toHaveBeenCalled();
    expect(mockResumeAgent).not.toHaveBeenCalled();
  });

  it('validates explicit execution fields on ExecutionSnapshot and InteractiveActorBootstrap type guards', () => {
    const validSnapshot: ExecutionSnapshot = {
      prompt: 'Generate PRD',
      model: 'composer-2.5',
      workspaceRef: '/ws/doc',
      workflowClass: 'prd',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      projectId: 'Apex',
      threadId: 'thread-1',
      requestId: 'run-1',
      toolAllowlist: null,
      disallowedTools: [],
      settingSources: ['project'],
      sandbox: { enabled: false },
    };
    expect(hasExplicitCursorExecutionFields(validSnapshot)).toBe(true);
    expect(
      hasExplicitCursorExecutionFields({
        ...validSnapshot,
        requestId: '',
      }),
    ).toBe(false);

    expect(
      isInteractiveActorBootstrap({
        kind: 'interactive-actor-v2',
        requestId: 'run-1',
        toolAllowlist: null,
        disallowedTools: [],
        settingSources: [],
        sandbox: { enabled: false },
      }),
    ).toBe(true);
    expect(
      isInteractiveActorBootstrap({
        kind: 'interactive-actor-v2',
        requestId: '',
        toolAllowlist: null,
        disallowedTools: [],
        settingSources: [],
        sandbox: { enabled: false },
      }),
    ).toBe(false);
  });

  it('VT-18: matches Agent.create options across interactive, guided interview, MCP-only, enforced Playbook, and document worker lanes', async () => {
    const checkout = {
      readFile: jest.fn(),
      listDir: jest.fn(),
      searchCode: jest.fn(),
    } as unknown as RepoReader;
    const adapter = createCursorSdkAdapter({ cacheMax: 8 });

    // 1. Standard interactive turn
    mockCreateAgent.mockImplementation(async () => makeMockSdkAgent('parity-1'));
    await acquireInteractiveCursorAgent(
      {
        model: 'composer-2.5',
        effort: null,
        workspaceRef: '/ws/interactive',
        interviewPhase: null,
      },
      checkout,
      { mcpServers: { 'ado-skills': { url: 'https://apex.example/mcp' } } },
    );
    const legacyInteractiveOpts = mockCreateAgent.mock.calls[0][0];
    mockCreateAgent.mockClear();

    const derivedInteractive = deriveInteractiveCursorExecutionFields({
      mcpServerNames: ['ado-skills'],
      interviewPhase: null,
    });
    await adapter.acquire(
      baseSpec({
        sessionKey: 'p-1',
        workspaceRef: '/ws/interactive',
        mcpServers: { 'ado-skills': { url: 'https://apex.example/mcp' } },
        ...derivedInteractive,
        // Legacy interactive without interviewPhase omitted sandboxOptions; explicit derived keeps sandbox undefined/false parity via derived field.
      }),
      { customTools: createNativeReadTools(checkout) },
    );
    const adapterInteractiveOpts = mockCreateAgent.mock.calls[0][0];
    // Golden pre-adapter Agent.create contract for standard interactive turns:
    expect(adapterInteractiveOpts.apiKey).toBe('parity-test-key');
    expect(adapterInteractiveOpts.model).toEqual({ id: 'composer-2.5' });
    expect(adapterInteractiveOpts.mcpServers).toEqual({
      'ado-skills': { url: 'https://apex.example/mcp' },
    });
    expect(adapterInteractiveOpts.tools).toBeUndefined();
    expect(adapterInteractiveOpts.disallowedTools).toBeUndefined();
    expect(adapterInteractiveOpts.local.cwd).toBe('/ws/interactive');
    expect(adapterInteractiveOpts.local.settingSources).toEqual([]);
    expect(adapterInteractiveOpts.local).not.toHaveProperty('sandboxOptions');
    expect(Object.keys(adapterInteractiveOpts.local.customTools ?? {}).sort()).toEqual(
      Object.keys(createNativeReadTools(checkout)).sort(),
    );
    expect({
      apiKey: adapterInteractiveOpts.apiKey,
      model: adapterInteractiveOpts.model,
      mcpServers: adapterInteractiveOpts.mcpServers,
      tools: adapterInteractiveOpts.tools,
      disallowedTools: adapterInteractiveOpts.disallowedTools,
      cwd: adapterInteractiveOpts.local.cwd,
      settingSources: adapterInteractiveOpts.local.settingSources,
      customToolNames: Object.keys(adapterInteractiveOpts.local.customTools ?? {}).sort(),
    }).toEqual({
      apiKey: legacyInteractiveOpts.apiKey,
      model: legacyInteractiveOpts.model,
      mcpServers: legacyInteractiveOpts.mcpServers,
      tools: legacyInteractiveOpts.tools,
      disallowedTools: legacyInteractiveOpts.disallowedTools,
      cwd: legacyInteractiveOpts.local.cwd,
      settingSources: legacyInteractiveOpts.local.settingSources,
      customToolNames: Object.keys(legacyInteractiveOpts.local.customTools ?? {}).sort(),
    });
    mockCreateAgent.mockClear();

    // 2. Product-phase guided interview
    await acquireInteractiveCursorAgent(
      {
        model: 'composer-2.5',
        effort: null,
        workspaceRef: '/ws/interview',
        interviewPhase: 'product',
      },
      checkout,
      { mcpServers: {} },
    );
    const legacyInterviewOpts = mockCreateAgent.mock.calls[0][0];
    mockCreateAgent.mockClear();

    const derivedInterview = deriveInteractiveCursorExecutionFields({
      mcpServerNames: [],
      interviewPhase: 'product',
    });
    await adapter.acquire(
      baseSpec({
        sessionKey: 'p-2',
        workspaceRef: '/ws/interview',
        ...derivedInterview,
      }),
      { customTools: guidedInterviewRepositoryTools('product', checkout) },
    );
    const adapterInterviewOpts = mockCreateAgent.mock.calls[0][0];
    // Golden pre-adapter Agent.create contract for product-phase guided interviews:
    expect(adapterInterviewOpts.tools).toBeUndefined();
    expect(adapterInterviewOpts.disallowedTools).toEqual(['task']);
    expect(adapterInterviewOpts.local.cwd).toBe('/ws/interview');
    expect(adapterInterviewOpts.local.settingSources).toEqual([]);
    expect(adapterInterviewOpts.local.sandboxOptions).toEqual({ enabled: false });
    expect(Object.keys(adapterInterviewOpts.local.customTools ?? {}).sort()).toEqual(
      Object.keys(guidedInterviewRepositoryTools('product', checkout)).sort(),
    );
    expect(adapterInterviewOpts).toMatchObject({
      apiKey: legacyInterviewOpts.apiKey,
      model: legacyInterviewOpts.model,
      disallowedTools: legacyInterviewOpts.disallowedTools,
      local: expect.objectContaining({
        cwd: legacyInterviewOpts.local.cwd,
        settingSources: legacyInterviewOpts.local.settingSources,
        sandboxOptions: legacyInterviewOpts.local.sandboxOptions,
      }),
    });
    mockCreateAgent.mockClear();

    // 3. MCP-only connection chat
    await acquireInteractiveCursorAgent(
      {
        model: 'composer-2.5',
        effort: null,
        workspaceRef: '/ws/mcp',
        interviewPhase: null,
      },
      checkout,
      { mcpServers: { 'mcp-server': { url: 'http://localhost/mcp' } } },
    );
    const legacyMcpOpts = mockCreateAgent.mock.calls[0][0];
    mockCreateAgent.mockClear();

    const derivedMcp = deriveInteractiveCursorExecutionFields({
      mcpServerNames: ['mcp-server'],
      interviewPhase: null,
    });
    await adapter.acquire(
      baseSpec({
        sessionKey: 'p-3',
        workspaceRef: '/ws/mcp',
        mcpServers: { 'mcp-server': { url: 'http://localhost/mcp' } },
        ...derivedMcp,
      }),
      {},
    );
    const adapterMcpOpts = mockCreateAgent.mock.calls[0][0];
    // Golden pre-adapter Agent.create contract for MCP-only connection chats:
    expect(adapterMcpOpts.tools).toEqual(['mcp']);
    expect(adapterMcpOpts.disallowedTools).toEqual(['task']);
    expect(adapterMcpOpts.mcpServers).toEqual({
      'mcp-server': { url: 'http://localhost/mcp' },
    });
    expect(adapterMcpOpts.local).toEqual({
      cwd: '/ws/mcp',
      settingSources: [],
    });
    expect(adapterMcpOpts).toEqual(
      expect.objectContaining({
        tools: legacyMcpOpts.tools,
        disallowedTools: legacyMcpOpts.disallowedTools,
        mcpServers: legacyMcpOpts.mcpServers,
      }),
    );
    mockCreateAgent.mockClear();

    // 4. Enforced Playbook step + 5. Standard document worker
    const skillText = '# Enforced skill';
    const sha = createHash('sha256').update(skillText).digest('hex');
    const enforcedPolicy: PlaybookAgentRunPolicy = {
      schemaVersion: 1,
      resolverVersion: 1,
      executionProfile: 'repository-read-only',
      enforcement: 'enforce',
      skill: { path: '.cursor/skills/prd-spec-review/SKILL.md', sha256: sha },
      capabilities: ['repository-read'],
      mcpServers: [],
      localAgent: {
        cwdMode: 'scratch',
        customTools: 'native-read-only',
        allowBuiltinWrites: false,
      },
      resolvedAt: '2026-11-18T12:00:00.000Z',
    };
    const enforcedSnapshot: ExecutionSnapshot = {
      prompt: 'Review PRD',
      model: 'composer-2.5',
      workspaceRef: '/ws/playbook',
      workflowClass: 'playbook-step',
      skillPath: '.cursor/skills/prd-spec-review/SKILL.md',
      skillContent: skillText,
      skillSha256: sha,
      projectId: 'Apex',
      threadId: 'thread-pb',
      playbookAgentPolicy: enforcedPolicy,
    };
    await createLocalCursorExecution(enforcedSnapshot, checkout);
    const legacyEnforcedOpts = mockCreateAgent.mock.calls[0][0];
    mockCreateAgent.mockClear();

    const derivedEnforced = deriveWorkerCursorExecutionFields(enforcedSnapshot);
    await adapter.acquire(
      baseSpec({
        sessionKey: 'p-4',
        workspaceRef: '/ws/playbook',
        skillContent: skillText,
        ...derivedEnforced,
      }),
      { customTools: createNativeReadTools(checkout) },
    );
    const adapterEnforcedOpts = mockCreateAgent.mock.calls[0][0];
    // Golden pre-adapter Agent.create contract for enforced Playbook runs without azure-cli:
    expect(adapterEnforcedOpts.tools).toBeUndefined();
    expect(adapterEnforcedOpts.disallowedTools).toEqual(['shell']);
    expect(adapterEnforcedOpts.mcpServers).toEqual({});
    expect(adapterEnforcedOpts.local.cwd).toBe('/ws/playbook');
    expect(adapterEnforcedOpts.local.settingSources).toEqual([]);
    expect(adapterEnforcedOpts.local.sandboxOptions).toEqual({ enabled: false });
    expect(Object.keys(adapterEnforcedOpts.local.customTools ?? {}).sort()).toEqual(
      Object.keys(createNativeReadTools(checkout)).sort(),
    );
    expect(adapterEnforcedOpts).toMatchObject({
      disallowedTools: legacyEnforcedOpts.disallowedTools,
      local: expect.objectContaining({
        cwd: legacyEnforcedOpts.local.cwd,
        settingSources: legacyEnforcedOpts.local.settingSources,
        sandboxOptions: legacyEnforcedOpts.local.sandboxOptions,
      }),
    });
    mockCreateAgent.mockClear();

    const docSnapshot: ExecutionSnapshot = {
      prompt: 'Write PRD',
      model: 'composer-2.5',
      workspaceRef: '/ws/doc',
      workflowClass: 'prd',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      projectId: 'Apex',
      threadId: 'thread-doc',
    };
    await createLocalCursorExecution(docSnapshot, checkout);
    const legacyDocOpts = mockCreateAgent.mock.calls[0][0];
    mockCreateAgent.mockClear();

    const derivedDoc = deriveWorkerCursorExecutionFields(docSnapshot);
    await adapter.acquire(
      baseSpec({
        sessionKey: 'p-5',
        workspaceRef: '/ws/doc',
        ...derivedDoc,
      }),
      { customTools: createNativeReadTools(checkout) },
    );
    const adapterDocOpts = mockCreateAgent.mock.calls[0][0];
    // Golden pre-adapter Agent.create contract for standard document worker runs:
    expect(adapterDocOpts.tools).toBeUndefined();
    expect(adapterDocOpts.disallowedTools).toBeUndefined();
    expect(adapterDocOpts.mcpServers).toEqual({});
    expect(adapterDocOpts.local.cwd).toBe('/ws/doc');
    expect(adapterDocOpts.local.settingSources).toEqual(['project']);
    expect(adapterDocOpts.local.sandboxOptions).toEqual({ enabled: false });
    expect(Object.keys(adapterDocOpts.local.customTools ?? {}).sort()).toEqual(
      Object.keys(createNativeReadTools(checkout)).sort(),
    );
    expect(adapterDocOpts).toMatchObject({
      local: expect.objectContaining({
        cwd: legacyDocOpts.local.cwd,
        settingSources: legacyDocOpts.local.settingSources,
        sandboxOptions: legacyDocOpts.local.sandboxOptions,
      }),
    });
    expect(adapterDocOpts.disallowedTools).toBeUndefined();
  });
});
