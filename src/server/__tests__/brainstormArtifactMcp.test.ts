jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn(), trackAgentError: jest.fn() }));

import { createBrainstormArtifactMcp, type BrainstormArtifactMcpDeps } from '../services/brainstormArtifactMcp';
import { BrainstormArtifactError } from '../services/brainstormArtifactVersionStore';
import { cloneSpecificationForRetry } from '../services/durableInteractiveTurnRepository';
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';

const SESSION_ID = '40000000-0000-4000-8000-000000000001';
const THREAD_ID = '40000000-0000-4000-8000-000000000002';
const RUN_ID = '40000000-0000-4000-8000-000000000003';

function spec(overrides: Partial<NonNullable<DurableInteractiveTurnSpecification['brainstorm']>> = {}) {
  return {
    threadId: THREAD_ID,
    userId: 'creator',
    toolGrant: null,
    deadlines: { absoluteTurnMs: 1, repositoryPreparationMs: null, firstEventMs: 1, toolCallMs: 1 },
    brainstorm: {
      sessionId: SESSION_ID,
      creatorContext: { displayName: 'Ada', roles: [], groups: [], bio: null },
      sourceLimits: { workspaceMaxBytes: 1, maxConcurrentClones: 1, inactivityMs: 1 },
      sources: { readRoots: [], unavailableSources: [], mcpServers: [], instructions: '' },
      artifact: { type: 'adr', version: 3, markdown: '# ADR' },
      intent: { kind: 'chat' },
      ...overrides,
    },
  } as unknown as DurableInteractiveTurnSpecification;
}

const summary = {
  sequence: 4,
  origin: 'ai_change',
  checkpointName: null,
  artifactType: 'adr',
  authorId: 'creator',
  createdAt: '2026-10-29T10:00:00.000Z',
  sizeBytes: 5,
} as const;

function deps(overrides: Partial<BrainstormArtifactMcpDeps> = {}) {
  return {
    store: {
      applyAiChange: jest.fn().mockResolvedValue(summary),
      applyTypeSwitch: jest.fn().mockResolvedValue({ ...summary, origin: 'type_switch' }),
      getArtifact: jest.fn().mockResolvedValue({ type: 'adr' }),
    },
    findSession: jest.fn().mockResolvedValue({ id: SESSION_ID, project: 'alpha', creatorId: 'creator', state: 'active' }),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    clearFailure: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function call(markdown: unknown) {
  return { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'brainstorm_update_artifact', arguments: { markdown } } };
}

function payload(result: unknown): Record<string, unknown> {
  const text = (result as { result: { content: Array<{ text: string }> } }).result.content[0].text;
  return JSON.parse(text);
}

describe('brainstorm artifact MCP tool', () => {
  it('lists the single update tool', async () => {
    const mcp = createBrainstormArtifactMcp(deps());
    const result = await mcp.handle({ runId: RUN_ID, specification: spec(), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect((result as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toEqual([
      'brainstorm_update_artifact',
    ]);
  });

  it('VT-02: applies a chat change against the frozen base version, from the specification only', async () => {
    const d = deps();
    const result = await createBrainstormArtifactMcp(d).handle({ runId: RUN_ID, specification: spec(), body: call('# ADR v2') });
    expect(d.store.applyAiChange).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      project: 'alpha',
      authorId: 'creator',
      runId: RUN_ID,
      baseVersion: 3,
      markdown: '# ADR v2',
    });
    expect(payload(result)).toEqual({ ok: true, version: 4 });
    expect(d.clearFailure).toHaveBeenCalledWith(RUN_ID);
  });

  it('VT-08: a type-switch turn writes a type_switch version until the type changes', async () => {
    const d = deps();
    await createBrainstormArtifactMcp(d).handle({
      runId: RUN_ID,
      specification: spec({ intent: { kind: 'type_switch', targetType: 'technical_design' } }),
      body: call('# Design'),
    });
    expect(d.store.applyTypeSwitch).toHaveBeenCalledWith(expect.objectContaining({ newType: 'technical_design', baseVersion: 3 }));
    expect(d.store.applyAiChange).not.toHaveBeenCalled();
  });

  it('a second write in a type-switch turn is an ordinary change', async () => {
    const d = deps({
      store: {
        applyAiChange: jest.fn().mockResolvedValue(summary),
        applyTypeSwitch: jest.fn(),
        getArtifact: jest.fn().mockResolvedValue({ type: 'technical_design' }),
      } as unknown as BrainstormArtifactMcpDeps['store'],
    });
    await createBrainstormArtifactMcp(d).handle({
      runId: RUN_ID,
      specification: spec({ intent: { kind: 'type_switch', targetType: 'technical_design' } }),
      body: call('# Design v2'),
    });
    expect(d.store.applyAiChange).toHaveBeenCalled();
    expect(d.store.applyTypeSwitch).not.toHaveBeenCalled();
  });

  it('records a stale write on the run and reports it to the model', async () => {
    const d = deps({
      store: {
        applyAiChange: jest.fn().mockRejectedValue(
          new BrainstormArtifactError('ARTIFACT_VERSION_CONFLICT', 409, { currentVersion: 5 }),
        ),
        applyTypeSwitch: jest.fn(),
        getArtifact: jest.fn(),
      } as unknown as BrainstormArtifactMcpDeps['store'],
    });
    const result = await createBrainstormArtifactMcp(d).handle({ runId: RUN_ID, specification: spec(), body: call('# x') });
    expect(payload(result)).toMatchObject({ ok: false, code: 'ARTIFACT_VERSION_CONFLICT', currentVersion: 5 });
    expect((result as { result: { isError?: boolean } }).result.isError).toBe(true);
    expect(d.recordFailure).toHaveBeenCalledWith(RUN_ID, 'ARTIFACT_VERSION_CONFLICT');
  });

  it('refuses when the thread session does not match the frozen session or creator', async () => {
    const d = deps({
      findSession: jest.fn().mockResolvedValue({ id: SESSION_ID, project: 'alpha', creatorId: 'someone-else', state: 'active' }),
    });
    const result = await createBrainstormArtifactMcp(d).handle({ runId: RUN_ID, specification: spec(), body: call('# x') });
    expect(payload(result)).toMatchObject({ ok: false, code: 'INVALID_ARTIFACT_CHANGE' });
    expect(d.store.applyAiChange).not.toHaveBeenCalled();
  });

  it('refuses a call without Markdown', async () => {
    const d = deps();
    const result = await createBrainstormArtifactMcp(d).handle({ runId: RUN_ID, specification: spec(), body: call(42) });
    expect(payload(result)).toMatchObject({ ok: false });
    expect(d.store.applyAiChange).not.toHaveBeenCalled();
  });

  it('answers unknown tools and methods with JSON-RPC errors', async () => {
    const mcp = createBrainstormArtifactMcp(deps());
    const unknownTool = await mcp.handle({
      runId: RUN_ID,
      specification: spec(),
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_everything' } },
    });
    expect(unknownTool).toMatchObject({ error: { code: -32602 } });
    const unknownMethod = await mcp.handle({ runId: RUN_ID, specification: spec(), body: { jsonrpc: '2.0', id: 3, method: 'resources/list' } });
    expect(unknownMethod).toMatchObject({ error: { code: -32601 } });
  });
});

describe('VT-46: retry re-freezes the artifact', () => {
  it('replaces only the artifact and keeps the intent', () => {
    const previous = spec({ intent: { kind: 'type_switch', targetType: 'adr' } });
    const next = cloneSpecificationForRetry(previous, null, previous.deadlines, { type: 'adr', version: 9, markdown: '# Now' });
    expect(next.brainstorm?.artifact).toEqual({ type: 'adr', version: 9, markdown: '# Now' });
    expect(next.brainstorm?.intent).toEqual({ kind: 'type_switch', targetType: 'adr' });
    expect(next.brainstorm?.sessionId).toBe(SESSION_ID);
  });

  it('leaves a non-Brainstorm specification alone', () => {
    const previous = { ...spec(), brainstorm: undefined } as unknown as DurableInteractiveTurnSpecification;
    const next = cloneSpecificationForRetry(previous, null, previous.deadlines, { type: null, version: 0, markdown: '' });
    expect(next.brainstorm).toBeUndefined();
  });
});
