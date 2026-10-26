import { selectEnabledMcpOperations, toolArgumentTemplate, toolInputsFromSchema } from '../../shared/types/mcpServers';
import {
  applyRemoteMcpSecrets,
  buildRemoteMcpCredential,
  discoverMcpServerTools,
  discoverRemoteMcpTools,
  resolveRemoteMcpHeaders,
} from '../services/mcpServerDiscovery';

describe('integration MCP discovery', () => {
  it('keeps the tools the MCP server lists and drops write tools', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'token-1' }),
    })) as unknown as typeof fetch;
    const listTools = jest.fn(async () => [
      {
        name: 'entityUsage',
        description: 'Retrieve usage metrics',
        annotations: { readOnlyHint: true },
      },
      {
        name: 'createSegment',
        description: 'Create a segment',
        annotations: { readOnlyHint: false },
      },
      {
        name: 'deleteGuide',
        description: 'Delete a guide',
        annotations: { destructiveHint: true },
      },
    ]);

    const tools = await discoverMcpServerTools(
      { provider: 'pendo', clientId: 'client', clientSecret: 'secret' },
      { fetchImpl, listTools }
    );

    expect(tools.map((tool) => tool.name)).toEqual(['entityUsage']);
    expect(listTools).toHaveBeenCalledWith('https://app.pendo.io/mcp/v0/shttp', 'token-1');
  });

  it('does not call Clerk or SendGrid for a tool list', async () => {
    await expect(
      discoverMcpServerTools({ provider: 'clerk', clientSecret: 'secret' })
    ).rejects.toThrow('OAuth sign-in');
    await expect(
      discoverMcpServerTools({ provider: 'sendgrid', clientSecret: 'secret' })
    ).rejects.toThrow('does not publish an MCP tool list');
  });

  it('turns a tool schema into the required argument template', () => {
    const inputs = toolInputsFromSchema({
      type: 'object',
      required: ['application_id', 'instance'],
      properties: {
        application_id: { type: 'string', description: 'The application id.' },
        instance: { type: 'string', enum: ['development', 'production'] },
        limit: { type: 'integer' },
      },
    });
    expect(toolArgumentTemplate(inputs)).toBe('{\n  "application_id": "",\n  "instance": ""\n}');
  });

  it('keeps a secret name when the value is still empty', () => {
    const stored = buildRemoteMcpCredential({
      headers: { Authorization: 'Bearer ${CLERK_SECRET_KEY}' },
      secrets: [{ name: 'CLERK_SECRET_KEY', value: '' }],
    });
    expect(stored.secretNames).toEqual(['CLERK_SECRET_KEY']);
    expect(stored.secrets).toEqual({});
    expect(JSON.stringify(stored)).not.toContain('sk_');
    const filled = applyRemoteMcpSecrets(stored, [{ name: 'CLERK_SECRET_KEY', value: 'sk_test_value' }]);
    expect(resolveRemoteMcpHeaders(filled)).toEqual({ Authorization: 'Bearer sk_test_value' });
  });

  it('substitutes a secret into headers and drops write tools', async () => {
    const stored = buildRemoteMcpCredential({
      headers: { Authorization: 'Bearer ${TOKEN}' },
      secrets: [{ name: 'TOKEN', value: 'secret-value' }],
    });
    const listTools = jest.fn(async () => [
      { name: 'search', description: 'Search', annotations: { readOnlyHint: true } },
      { name: 'deleteDoc', description: 'Delete', annotations: { destructiveHint: true } },
    ]);
    const tools = await discoverRemoteMcpTools(
      { url: 'https://example.com/mcp', headers: resolveRemoteMcpHeaders(stored) },
      { listTools }
    );
    expect(tools.map((tool) => tool.name)).toEqual(['search']);
    expect(listTools).toHaveBeenCalledWith(
      'https://example.com/mcp',
      { Authorization: 'Bearer secret-value' }
    );
  });

  it('keeps an empty allow list as every read-only tool and honors an explicit list', () => {
    const operations = [
      { id: 'list_users', method: 'GET' as const, path: '/mcp-tool', summary: 'List users', readOnly: true as const, source: 'mcp' as const },
      { id: 'whoami', method: 'GET' as const, path: '/mcp-tool', summary: 'Who am I', readOnly: true as const, source: 'mcp' as const },
    ];
    expect(selectEnabledMcpOperations(operations, []).map((operation) => operation.id)).toEqual(['list_users', 'whoami']);
    expect(selectEnabledMcpOperations(operations, ['whoami']).map((operation) => operation.id)).toEqual(['whoami']);
  });
});
