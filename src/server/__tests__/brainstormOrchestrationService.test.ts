jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn(), trackAgentError: jest.fn() }));

import {
  capBio,
  createBrainstormOrchestrationService,
  formatArtifactContext,
  formatCreatorContext,
  formatSourcesContext,
  resolveDefaultBrainstormSources,
  type BrainstormOrchestrationDeps,
} from '../services/brainstormOrchestrationService';
import { BrainstormError } from '../services/brainstormSessionService';
import {
  BrainstormLedgerConflict,
  buildBrainstormActivityFromEvents,
  orderMessagesChronologically,
  type BrainstormMessageRow,
} from '../services/brainstormTurnLedger';
import { DurableInteractiveTurnError } from '../services/durableInteractiveTurnService';
import { isDurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import { BRAINSTORM_SOURCE_BASE_INSTRUCTIONS } from '../../shared/types/brainstormSources';
import type { BrainstormSessionRow } from '../services/brainstormThread';

const SESSION_ID = '30000000-0000-4000-8000-000000000001';
const THREAD_ID = '30000000-0000-4000-8000-000000000002';
const TURN_ID = '30000000-0000-4000-8000-000000000003';
const RUN_ID = '30000000-0000-4000-8000-000000000004';
const RETRY_RUN_ID = '30000000-0000-4000-8000-000000000005';
const ARTIFACT_V3 = { type: 'adr', version: 3, markdown: '# Draft ADR\n\nBody' } as const;

const session: BrainstormSessionRow = {
  id: SESSION_ID,
  project: 'alpha',
  creatorId: 'creator',
  state: 'active',
  model: 'model-a',
  title: null,
  artifactType: null,
  chatThreadId: THREAD_ID,
  lastActivityAt: '2026-10-29T10:00:00.000Z',
  endedAt: null,
  failureReason: null,
  version: 1,
  createdBy: 'creator',
  updatedBy: 'creator',
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
};

function row(overrides: Partial<BrainstormMessageRow> = {}): BrainstormMessageRow {
  return {
    id: 'm-assistant',
    sessionId: SESSION_ID,
    project: 'alpha',
    role: 'assistant',
    content: '',
    status: 'streaming',
    turnId: TURN_ID,
    runId: null,
    failureCode: null,
    failureSummary: null,
    retryOfMessageId: null,
    supersededByMessageId: null,
    artifactFailureCode: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

const accepted = { turnId: TURN_ID, runId: RUN_ID, status: 'queued', interactiveClass: 'fast' } as const;

function baseDeps() {
  return {
    isV2TransportEnabled: jest.fn().mockResolvedValue(true),
    loadCreatorContext: jest.fn().mockResolvedValue({
      displayName: 'Ada',
      roles: ['member'],
      groups: ['Platform'],
      bio: 'Builds payment systems.',
    }),
    sendTurn: jest.fn().mockResolvedValue(accepted),
    retryRun: jest.fn().mockResolvedValue({ ...accepted, runId: RETRY_RUN_ID }),
    loadArtifact: jest.fn().mockResolvedValue(ARTIFACT_V3),
    cancelThreadRun: jest.fn().mockResolvedValue(undefined),
    ledger: {
      openTurn: jest.fn().mockResolvedValue({ assistant: row(), existing: false }),
      openRetryRow: jest.fn().mockResolvedValue(row({ id: 'm-retry', runId: RETRY_RUN_ID })),
      attachRun: jest.fn().mockResolvedValue(undefined),
      failOpenRow: jest.fn().mockResolvedValue(undefined),
      latestAssistantRow: jest.fn(),
      findMessage: jest.fn(),
      findAssistantByRun: jest.fn(),
      reconcileStreamingRows: jest.fn().mockResolvedValue(undefined),
    },
    setTitleIfEmpty: jest.fn().mockResolvedValue(undefined),
    prepareTurnContext: jest.fn().mockResolvedValue({
      sourceLimits: { workspaceMaxBytes: 5 * 1024 ** 3, maxConcurrentClones: 3, inactivityMs: 30 * 60_000 },
      sources: {
        readRoots: [],
        unavailableSources: [],
        mcpServers: [],
        instructions: BRAINSTORM_SOURCE_BASE_INSTRUCTIONS,
      },
    }),
  };
}

type MockDeps = ReturnType<typeof baseDeps>;

function makeDeps(overrides: Partial<MockDeps> = {}): MockDeps & BrainstormOrchestrationDeps {
  return { ...baseDeps(), ...overrides };
}

describe('brainstormOrchestrationService.runTurn', () => {
  it('admits a turn with a complete frozen Brainstorm block and records the run', async () => {
    const deps = makeDeps();
    const service = createBrainstormOrchestrationService(deps);
    const result = await service.runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'An idea' });

    expect(result).toEqual({ ...accepted, messageId: 'm-assistant' });
    const sent = deps.sendTurn.mock.calls[0][0];
    expect(sent.threadId).toBe(THREAD_ID);
    expect(sent.brainstorm).toEqual({
      sessionId: SESSION_ID,
      creatorContext: { displayName: 'Ada', roles: ['member'], groups: ['Platform'], bio: 'Builds payment systems.' },
      sourceLimits: { workspaceMaxBytes: 5 * 1024 ** 3, maxConcurrentClones: 3, inactivityMs: 30 * 60_000 },
      sources: {
        readRoots: [],
        unavailableSources: [],
        mcpServers: [],
        instructions: BRAINSTORM_SOURCE_BASE_INSTRUCTIONS,
      },
      artifact: ARTIFACT_V3,
      intent: { kind: 'chat' },
    });
    expect(sent.internalContext).toContain('# Creator context');
    expect(sent.internalContext).toContain('# Current artifact');
    expect(sent.internalContext).toContain('- Version: 3');
    expect(sent.internalContext).toContain('brainstorm_update_artifact');
    expect(sent.internalContext).toContain('# Draft ADR');
    expect(deps.ledger.attachRun).toHaveBeenCalledWith('m-assistant', RUN_ID);
    expect(deps.setTitleIfEmpty).toHaveBeenCalledWith(SESSION_ID, 'alpha', 'An idea', 'creator');
  });

  it('forwards model override and attachments into sendTurn', async () => {
    const deps = makeDeps();
    const service = createBrainstormOrchestrationService(deps);
    await service.runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'See screenshot',
      model: 'gemini-4-argon-medium',
      attachments: [
        {
          id: 'att-1',
          name: 'screenshot-1.png',
          type: 'image/png',
          size: 42,
          content: 'aGVsbG8=',
          encoding: 'base64',
        },
      ],
    });

    const sent = deps.sendTurn.mock.calls[0][0];
    expect(sent.model).toBe('gemini-4-argon-medium');
    expect(sent.attachments).toEqual([
      {
        id: 'att-1',
        name: 'screenshot-1.png',
        type: 'image/png',
        size: 42,
        content: 'aGVsbG8=',
        encoding: 'base64',
      },
    ]);
  });

  it('VT-08: freezes a type-switch intent and tells the collaborator to reshape', async () => {
    const deps = makeDeps();
    await createBrainstormOrchestrationService(deps).runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'Switch the artifact type to Technical design.',
      intent: { kind: 'type_switch', targetType: 'technical_design' },
    });
    const sent = deps.sendTurn.mock.calls[0][0];
    expect(sent.brainstorm.intent).toEqual({ kind: 'type_switch', targetType: 'technical_design' });
    expect(sent.brainstorm.artifact.version).toBe(3);
    expect(sent.internalContext).toContain('switched the artifact type to Technical design');
  });

  it('freezes a type-switch when composer mode differs from the current artifact type', async () => {
    const deps = makeDeps({
      loadArtifact: jest.fn().mockResolvedValue({ type: null, version: 0, markdown: '' }),
    });
    await createBrainstormOrchestrationService(deps).runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'Draft an ADR',
      mode: 'adr',
    });
    const sent = deps.sendTurn.mock.calls[0][0];
    expect(sent.brainstorm.intent).toEqual({ kind: 'type_switch', targetType: 'adr' });
    expect(sent.internalContext).toContain('switched the artifact type to ADR');
  });

  it('keeps chat intent when composer mode matches the current type or is Explore', async () => {
    const deps = makeDeps();
    const service = createBrainstormOrchestrationService(deps);
    await service.runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'Tighten the consequences',
      mode: 'adr',
    });
    expect(deps.sendTurn.mock.calls[0][0].brainstorm.intent).toEqual({ kind: 'chat' });

    deps.sendTurn.mockClear();
    await service.runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'What should we consider?',
      mode: 'explore',
    });
    expect(deps.sendTurn.mock.calls[0][0].brainstorm.intent).toEqual({ kind: 'chat' });
  });

  it('marks the open row failed when the artifact context cannot load', async () => {
    const deps = makeDeps({ loadArtifact: jest.fn().mockRejectedValue(new Error('db down')) });
    await expect(
      createBrainstormOrchestrationService(deps).runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'x' }),
    ).rejects.toThrow('db down');
    expect(deps.sendTurn).not.toHaveBeenCalled();
    expect(deps.ledger.failOpenRow).toHaveBeenCalledWith('m-assistant', 'run_not_started');
  });

  it('produces a block the specification guard accepts', async () => {
    const deps = makeDeps();
    await createBrainstormOrchestrationService(deps).runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'x' });
    const block = deps.sendTurn.mock.calls[0][0].brainstorm;
    expect(
      isDurableInteractiveTurnSpecification({
        schemaVersion: 1,
        kind: 'interactive-turn',
        turnId: TURN_ID,
        threadId: THREAD_ID,
        userId: 'creator',
        projectId: 'alpha',
        interactiveClass: 'fast',
        workflowClass: 'brainstorm',
        model: 'model-a',
        effort: null,
        skill: null,
        currentMessage: { id: TURN_ID, text: 'x', hidden: false, attachments: [] },
        transcript: [],
        grounding: null,
        mcpServers: [],
        toolGrant: null,
        currentPrompt: 'x',
        recreationPrompt: 'x',
        deadlines: { absoluteTurnMs: 300_000, repositoryPreparationMs: null, firstEventMs: 30_000, toolCallMs: 60_000 },
        brainstorm: block,
      }),
    ).toBe(true);
  });

  it('refuses with transport_unavailable before writing anything when V2 is off', async () => {
    const deps = makeDeps({ isV2TransportEnabled: jest.fn().mockResolvedValue(false) });
    await expect(
      createBrainstormOrchestrationService(deps).runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'x' }),
    ).rejects.toMatchObject({ code: 'transport_unavailable', status: 409 });
    expect(deps.ledger.openTurn).not.toHaveBeenCalled();
    expect(deps.sendTurn).not.toHaveBeenCalled();
  });

  it('maps the one-streaming-row conflict to turn_in_progress', async () => {
    const deps = makeDeps();
    deps.ledger.openTurn.mockRejectedValue(new BrainstormLedgerConflict('turn_in_progress'));
    await expect(
      createBrainstormOrchestrationService(deps).runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'x' }),
    ).rejects.toMatchObject({ code: 'turn_in_progress', status: 409 });
  });

  it('marks the open row failed with a fixed code when admission fails', async () => {
    const deps = makeDeps({ sendTurn: jest.fn().mockRejectedValue(new DurableInteractiveTurnError('THREAD_ACTIVE_TURN', 409)) });
    await expect(
      createBrainstormOrchestrationService(deps).runTurn({ session, userId: 'creator', turnId: TURN_ID, text: 'x' }),
    ).rejects.toMatchObject({ code: 'turn_in_progress' });
    expect(deps.ledger.failOpenRow).toHaveBeenCalledWith('m-assistant', 'run_not_started');
  });

  it('returns the first result for a repeated turn id without writing a title again', async () => {
    const deps = makeDeps();
    deps.ledger.openTurn.mockResolvedValue({ assistant: row({ runId: RUN_ID }), existing: true });
    const result = await createBrainstormOrchestrationService(deps).runTurn({
      session,
      userId: 'creator',
      turnId: TURN_ID,
      text: 'x',
    });
    expect(result.runId).toBe(RUN_ID);
    expect(deps.ledger.attachRun).not.toHaveBeenCalled();
    expect(deps.setTitleIfEmpty).not.toHaveBeenCalled();
  });
});

describe('brainstormOrchestrationService.retryFailedTurn', () => {
  const failed = row({ id: 'm-failed', status: 'failed', runId: RUN_ID, failureCode: 'model_error' });

  it('retries the latest failed row by run identity and links the replacement', async () => {
    const deps = makeDeps();
    deps.ledger.findAssistantByRun.mockResolvedValue(failed);
    deps.ledger.latestAssistantRow.mockResolvedValue(failed);
    const result = await createBrainstormOrchestrationService(deps).retryFailedTurn({
      session,
      userId: 'creator',
      runId: RUN_ID,
    });
    expect(deps.retryRun).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      runId: RUN_ID,
      userId: 'creator',
      refreshedBrainstormArtifact: ARTIFACT_V3,
    });
    expect(deps.ledger.openRetryRow).toHaveBeenCalledWith({ failed, runId: RETRY_RUN_ID });
    expect(result).toMatchObject({ runId: RETRY_RUN_ID, messageId: 'm-retry' });
  });

  it('returns the first retry when the same run is retried again', async () => {
    const deps = makeDeps();
    deps.ledger.findAssistantByRun.mockResolvedValue({ ...failed, supersededByMessageId: 'm-retry' });
    deps.ledger.findMessage.mockResolvedValue(row({ id: 'm-retry', runId: RETRY_RUN_ID, retryOfMessageId: 'm-failed' }));
    const result = await createBrainstormOrchestrationService(deps).retryFailedTurn({
      session,
      userId: 'creator',
      runId: RUN_ID,
    });
    expect(result).toMatchObject({ runId: RETRY_RUN_ID, messageId: 'm-retry' });
    expect(deps.retryRun).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown run', null, null],
    ['a completed row', row({ status: 'completed', runId: RUN_ID }), null],
    ['a failed row that is not the latest', failed, row({ id: 'm-later', status: 'completed' })],
  ])('refuses %s with not_retryable', async (_label, found, latest) => {
    const deps = makeDeps();
    deps.ledger.findAssistantByRun.mockResolvedValue(found);
    deps.ledger.latestAssistantRow.mockResolvedValue(latest);
    await expect(
      createBrainstormOrchestrationService(deps).retryFailedTurn({ session, userId: 'creator', runId: RUN_ID }),
    ).rejects.toBeInstanceOf(BrainstormError);
    expect(deps.retryRun).not.toHaveBeenCalled();
  });
});

describe('brainstormOrchestrationService.cancel', () => {
  it('cancels the thread run and closes rows whose run already ended', async () => {
    const deps = makeDeps();
    await createBrainstormOrchestrationService(deps).cancel({ session });
    expect(deps.cancelThreadRun).toHaveBeenCalledWith(THREAD_ID);
    expect(deps.ledger.reconcileStreamingRows).toHaveBeenCalledWith(SESSION_ID, THREAD_ID);
  });
});

describe('creator context', () => {
  it('caps the bio at 1,000 characters and drops an empty one', () => {
    expect(capBio('x'.repeat(1_200))).toHaveLength(1_000);
    expect(capBio('   ')).toBeNull();
    expect(capBio(null)).toBeNull();
  });

  it('names each MCP tool purpose so the collaborator can choose a source', () => {
    const text = formatSourcesContext({
      readRoots: [],
      unavailableSources: [],
      mcpServers: [{
        connectionId: '30000000-0000-4000-8000-000000000003',
        displayName: 'Clerk',
        toolPrefix: 'clerk-3000',
        tools: [
          { toolName: 'clerk-3000__list_users', toolId: 'list_users', summary: 'List users' },
          { toolName: 'clerk-3000__snippets', toolId: 'snippets' },
        ],
      }],
      instructions: 'Use a ready source.',
    });
    expect(text).toContain('Ready MCP server "Clerk"');
    expect(text).toContain('clerk-3000__list_users: List users');
    expect(text).toContain('clerk-3000__snippets');
    expect(text).toContain('Use a ready source.');
  });

  it('formats the context as plain text', () => {
    expect(formatCreatorContext({ displayName: 'Ada', roles: [], groups: ['G'], bio: null })).toBe(
      ['# Creator context', '- Name: Ada', '- Roles: none listed', '- Groups: G', '- Profile bio: none'].join('\n'),
    );
  });

  it('instructs the collaborator to infer artifact need and structure when no artifact type is selected', () => {
    const context = formatArtifactContext({ type: null, version: 0, markdown: '' }, { kind: 'chat' });
    expect(context).toContain('- Type: not chosen');
    expect(context).toContain('No artifact type is selected yet.');
    expect(context).toContain('Infer from the creator prompt');
  });

  it('resolves the default project repository and all available MCP servers when nothing is selected in sources', async () => {
    const repoSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const catalogId = '11111111-1111-4111-8111-111111111111';
    const skillId = '22222222-2222-4222-8222-222222222222';
    const mcpId = '33333333-3333-4333-8333-333333333333';

    const resolved = await resolveDefaultBrainstormSources({
      session,
      settled: { ready: [], unavailable: [] },
      explicitMcpTools: [],
      resolvers: {
        listCatalogRepos: async () => [
          {
            id: catalogId,
            displayName: 'MaxView',
            cloneUrl: 'https://dev.azure.com/org/MaxView/_git/MaxView',
            status: 'ready',
            commitSha: repoSha,
            workspacePath: '/data/brainstorm-repo-mirrors/maxview',
          },
        ],
        listProjectSkillRepos: async () => [
          {
            id: skillId,
            displayName: 'Apex',
            repository: 'AI-Pilot',
            provider: 'github',
            commitSha: repoSha,
            workspacePath: '/data/shared-checkout/apex',
          },
        ],
        isMcpEnabled: async () => true,
        listProjectMcpServers: async () => [
          {
            id: mcpId,
            name: 'Clerk',
            operations: [{ id: 'list_users', summary: 'List Clerk users' }],
          },
        ],
      },
    });

    expect(resolved.ready).toHaveLength(2);
    expect(resolved.ready[0]).toMatchObject({
      id: catalogId,
      displayName: 'MaxView',
      commitSha: repoSha,
      workspacePath: '/data/brainstorm-repo-mirrors/maxview',
    });
    expect(resolved.ready[1]).toMatchObject({
      id: skillId,
      displayName: 'Apex',
      commitSha: repoSha,
      workspacePath: '/data/shared-checkout/apex',
    });
    expect(resolved.mcpTools).toEqual([
      {
        toolName: 'clerk-3333__list_users',
        toolId: 'list_users',
        connectionId: mcpId,
        displayName: 'Clerk',
        toolPrefix: 'clerk-3333',
        summary: 'List Clerk users',
      },
    ]);
  });
});

describe('brainstormTurnLedger ordering and activity reconstruction', () => {
  it('orders the user message before the assistant reply when both rows share a transaction timestamp', () => {
    const sameTs = '2026-10-29T19:18:00.000Z';
    const assistant = row({
      id: 'a-1',
      role: 'assistant',
      turnId: TURN_ID,
      createdAt: sameTs,
      content: 'Agent reply',
      status: 'completed',
    });
    const user = row({
      id: 'u-1',
      role: 'user',
      turnId: TURN_ID,
      createdAt: sameTs,
      content: 'User question',
      status: 'completed',
    });

    const ordered = orderMessagesChronologically([assistant, user]);
    expect(ordered.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('reconstructs thinking and MCP inner tool names from durable run events', () => {
    const items = buildBrainstormActivityFromEvents([
      { eventId: 'e-1', event: { type: 'thinking', text: 'Checking home hero' } },
      { eventId: 'e-2', event: { type: 'thinking', text: 'and login flow.' } },
      {
        eventId: 'e-3',
        event: {
          type: 'tool_status',
          callId: 'call-1',
          toolName: 'mcp',
          status: 'running',
          args: { toolName: 'search_repo_code', args: { target: 'home-hero' } },
        },
      },
      {
        eventId: 'e-4',
        event: {
          type: 'tool_status',
          callId: 'call-1',
          toolName: 'mcp',
          status: 'completed',
          args: { toolName: 'search_repo_code' },
        },
      },
    ]);

    expect(items).toEqual([
      { id: 'e-1', kind: 'thinking', text: 'Checking home hero and login flow.' },
      {
        id: 'call-1',
        kind: 'tool',
        toolName: 'mcp:search_repo_code',
        status: 'completed',
        target: 'home-hero',
      },
    ]);
  });
});
