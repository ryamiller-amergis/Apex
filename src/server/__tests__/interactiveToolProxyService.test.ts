import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encryptInteractiveToolGrant,
} from '../services/interactiveToolGrantCrypto';
import {
  InteractiveToolProxyError,
  invokeInteractiveToolProxy,
} from '../services/interactiveToolProxyService';
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import { DURABLE_INTERACTIVE_SPEC_VERSION } from '../../shared/types/durableInteractiveTurn';

const SECRET = 'unit-test-session-secret-with-sufficient-entropy';
const NOW = '2026-09-23T15:00:00.000Z';

function baseSpec(
  overrides: Partial<DurableInteractiveTurnSpecification> = {},
): DurableInteractiveTurnSpecification {
  return {
    schemaVersion: DURABLE_INTERACTIVE_SPEC_VERSION,
    kind: 'interactive-turn',
    turnId: '11111111-1111-4111-8111-111111111111',
    threadId: '22222222-2222-4222-8222-222222222222',
    userId: 'user-1',
    projectId: 'project-1',
    interactiveClass: 'fast',
    workflowClass: 'home-chat',
    model: 'auto',
    effort: null,
    skill: null,
    currentMessage: {
      id: '33333333-3333-4333-8333-333333333333',
      text: 'hi',
      hidden: false,
      attachments: [],
    },
    transcript: [],
    grounding: null,
    mcpServers: [
      {
        kind: 'internal-proxy',
        serverName: 'ado-skills',
        enableRepoBrowse: false,
      },
      {
        kind: 'external-http-proxy',
        serverName: 'ext-mcp',
        url: 'https://mcp.example/tools',
        headerEnvRefs: { Authorization: 'EXT_MCP_TOKEN' },
      },
    ],
    toolGrant: null,
    currentPrompt: 'current',
    recreationPrompt: 'recreation',
    deadlines: {
      absoluteTurnMs: 300_000,
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 15_000,
    },
    ...overrides,
  };
}

describe('interactiveToolProxyService', () => {
  it('routes internal-proxy descriptors through the injected Apex handler', async () => {
    const invokeInternal = jest.fn().mockResolvedValue({ ok: true });
    const result = await invokeInteractiveToolProxy({
      claims: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'fence-1',
        serverName: 'ado-skills',
        expiresAt: '2026-09-23T16:00:00.000Z',
      },
      specification: baseSpec(),
      body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      invokeInternal,
    });
    expect(result).toEqual({ ok: true });
    expect(invokeInternal).toHaveBeenCalledWith(
      'ado-skills',
      expect.objectContaining({ kind: 'internal-proxy', serverName: 'ado-skills' }),
      expect.objectContaining({ method: 'tools/list' }),
      expect.objectContaining({ delegatedAdoToken: null }),
    );
  });

  it('relays external-http-proxy only to the frozen HTTPS URL with resolved headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ result: 'pong' }),
    });
    const result = await invokeInteractiveToolProxy({
      claims: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'fence-1',
        serverName: 'ext-mcp',
        expiresAt: '2026-09-23T16:00:00.000Z',
      },
      specification: baseSpec(),
      body: { method: 'tools/call' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveHeaderEnv: (envRef) =>
        envRef === 'EXT_MCP_TOKEN' ? 'secret-token' : undefined,
    });
    expect(result).toEqual({ result: 'pong' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://mcp.example/tools',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'secret-token',
        }),
      }),
    );
  });

  it('rejects non-HTTPS external MCP URLs', async () => {
    await expect(
      invokeInteractiveToolProxy({
        claims: {
          runId: 'run-1',
          attemptId: 'attempt-1',
          dispatchMessageId: 'fence-1',
          serverName: 'ext-mcp',
          expiresAt: '2026-09-23T16:00:00.000Z',
        },
        specification: baseSpec({
          mcpServers: [
            {
              kind: 'external-http-proxy',
              serverName: 'ext-mcp',
              url: 'http://mcp.example/tools',
              headerEnvRefs: {},
            },
          ],
        }),
        body: {},
      }),
    ).rejects.toBeInstanceOf(InteractiveToolProxyError);
  });

  it('decrypts the run-bound ADO grant for internal handlers without exposing it', async () => {
    process.env.SESSION_SECRET = SECRET;
    const grant = encryptInteractiveToolGrant(
      {
        userId: 'user-1',
        projectId: 'project-1',
        allowedOperations: ['ado:write'],
        delegatedAdoToken: 'delegated-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      { secret: SECRET },
    );
    const invokeInternal = jest.fn().mockResolvedValue({ ok: true });
    await invokeInteractiveToolProxy({
      claims: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'fence-1',
        serverName: 'ado-skills',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      specification: baseSpec({ toolGrant: grant }),
      body: {},
      invokeInternal,
    });
    expect(invokeInternal.mock.calls[0][3].delegatedAdoToken).toBe(
      'delegated-token',
    );
    expect(JSON.stringify(grant)).not.toContain('delegated-token');
    delete process.env.SESSION_SECRET;
  });

  it('does not import Cursor or model modules', () => {
    const source = readFileSync(
      join(__dirname, '../services/interactiveToolProxyService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/@cursor\/sdk/);
    expect(source).not.toMatch(/agentEffortResolver|modelsService|Agent\.create/);
  });
});
