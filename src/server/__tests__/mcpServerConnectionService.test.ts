/**
 * SC-3 / SC-4 — encrypted connection storage, masking, and project isolation.
 * The Drizzle db instance is an in-memory stand-in so no database is required.
 */

const memory: Array<Record<string, unknown>> = [];

function applyWhere(
  rows: Array<Record<string, unknown>>,
  clause: any
): Array<Record<string, unknown>> {
  if (!clause) return rows;
  if (clause.type === 'and') {
    return clause.args.reduce(
      (acc: Array<Record<string, unknown>>, child: unknown) =>
        applyWhere(acc, child),
      rows
    );
  }
  if (clause.type === 'eq') {
    return rows.filter((row) => row[clause.field] === clause.val);
  }
  return rows;
}

jest.mock('drizzle-orm', () => ({
  eq: (column: { field: string }, val: unknown) => ({
    type: 'eq',
    field: column.field,
    val,
  }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
}));

jest.mock('../db/schema', () => ({
  mcpServers: new Proxy(
    {},
    { get: (_target, prop) => ({ field: String(prop) }) }
  ),
}));

jest.mock('../services/mcpServerDiscovery', () => {
  const actual = jest.requireActual('../services/mcpServerDiscovery');
  return {
    ...actual,
    discoverMcpServerTools: jest.fn(),
    discoverRemoteMcpTools: jest.fn(),
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          memory.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async (clause: unknown) => applyWhere(memory, clause),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (clause: unknown) => ({
          returning: async () => {
            const matches = applyWhere(memory, clause);
            for (const row of matches) Object.assign(row, patch);
            return matches;
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (clause: unknown) => {
        const matches = new Set(applyWhere(memory, clause));
        for (let index = memory.length - 1; index >= 0; index -= 1) {
          if (matches.has(memory[index])) memory.splice(index, 1);
        }
      },
    }),
  },
}));

import dns from 'node:dns';
import {
  createMcpServer,
  defaultMcpServerFetch,
  listMcpServers,
  testMcpServer,
} from '../services/mcpServerConnectionService';
import { selectEnabledMcpOperations } from '../../shared/types/mcpServers';
import { discoverMcpServerTools, discoverRemoteMcpTools } from '../services/mcpServerDiscovery';

const SECRET = 'integration-service-test-secret';

describe('integration connection service', () => {
  beforeEach(() => {
    memory.length = 0;
    process.env.SESSION_SECRET = SECRET;
  });

  it('SC-3 stores a Clerk credential encrypted and returns only a masked hint', async () => {
    const created = await createMcpServer({
      project: 'MaxView',
      name: 'MaxView Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    expect(created.credentialHint).toBe('••••cret');
    expect(JSON.stringify(created)).not.toContain('sk_live_supersecret');
    expect(created.status).toBe('untested');
    expect(memory[0].credentialCiphertext).not.toBe('sk_live_supersecret');
    expect(memory[0].credentialCiphertext).toEqual(expect.any(String));
  });

  it('SC-3 marks the connection usable after a stubbed successful test call', async () => {
    const created = await createMcpServer({
      project: 'MaxView',
      name: 'MaxView Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '{"ok":true}',
    }));
    const tested = await testMcpServer(
      'MaxView',
      created.id,
      fetchImpl
    );

    expect(tested.status).toBe('usable');
    expect(tested.lastTestedAt).toEqual(expect.any(String));
    expect(JSON.stringify(tested)).not.toContain('sk_live_supersecret');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stores only the prebuilt tools the installer enabled', async () => {
    const created = await createMcpServer({
      project: 'MaxView',
      name: 'MaxView Pendo',
      provider: 'pendo',
      credential: 'pendo-integration-key',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
      operations: [
        {
          id: 'getVisitor',
          method: 'GET',
          path: '/ignored',
          summary: 'Ignored',
          readOnly: true,
        },
        {
          id: 'deleteVisitor',
          method: 'GET',
          path: '/nope',
          summary: 'Not in the catalog',
          readOnly: true,
        },
      ],
    });

    expect(created.operations).toEqual([
      expect.objectContaining({
        id: 'getVisitor',
        path: '/api/v1/visitor/{visitorId}',
      }),
    ]);
  });

  it('saves only the official MCP tools the installer enabled', async () => {
    (discoverMcpServerTools as jest.Mock).mockResolvedValue([
      {
        name: 'entityUsage',
        description: 'Retrieve usage metrics',
        readOnly: true,
        inputSchema: { type: 'object' },
      },
      { name: 'appUsage', description: 'Retrieve app usage', readOnly: true },
    ]);

    const created = await createMcpServer({
      project: 'MaxView',
      name: 'MaxView Pendo',
      provider: 'pendo',
      credential: 'pendo-client-secret',
      clientId: 'pendo-client',
      toolNames: ['entityUsage', 'not-on-the-server'],
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    expect(created.operations).toEqual([
      expect.objectContaining({
        id: 'entityUsage',
        source: 'mcp',
        summary: 'Retrieve usage metrics',
      }),
    ]);
    expect(created.operations[0]).not.toHaveProperty('inputSchema');
    expect(JSON.stringify(created)).not.toContain('pendo-client-secret');
  });

  it('SC-4 hides Project A connections from Project B', async () => {
    await createMcpServer({
      project: 'MaxView',
      name: 'MaxView Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    const projectB = await listMcpServers('MatterWorx');
    const projectA = await listMcpServers('MaxView');

    expect(projectB).toEqual([]);
    expect(projectA).toHaveLength(1);
    expect(projectA[0].name).toBe('MaxView Clerk');
  });

  it('does not follow provider redirects', async () => {
    const previousE2e = process.env.E2E_MODE;
    process.env.E2E_MODE = 'false';
    const lookupSpy = jest
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '1.2.3.4', family: 4 }] as never);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      text: async () => '{}',
    } as Response);

    try {
      await defaultMcpServerFetch('https://api.example.com/v1/tickets', {
        method: 'GET',
        headers: { Authorization: 'Bearer custom-key' },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/v1/tickets',
        expect.objectContaining({ redirect: 'error' })
      );
    } finally {
      lookupSpy.mockRestore();
      fetchMock.mockRestore();
      process.env.E2E_MODE = previousE2e;
    }
  });

  it('stores a remote MCP server without the secret and loads read-only tools on test', async () => {
    (discoverRemoteMcpTools as jest.Mock).mockResolvedValue([
      { name: 'search', description: 'Search docs', readOnly: true },
      { name: 'writeDoc', description: 'Write a doc', readOnly: true },
    ]);
    const created = await createMcpServer({
      project: 'MaxView',
      name: 'Docs',
      provider: 'custom',
      credential: '',
      mcpUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
      secrets: [{ name: 'TOKEN', value: 'super-secret-value' }],
      toolNames: ['search'],
      allowedUserIds: [],
      createdBy: 'user-1',
    });

    expect(created.baseUrl).toBe('https://example.com/mcp');
    expect(created.operations).toEqual([]);
    expect(JSON.stringify(created)).not.toContain('super-secret-value');

    const tested = await testMcpServer('MaxView', created.id);
    expect(tested.status).toBe('usable');
    expect(tested.operations.map((operation) => operation.id)).toEqual(['search', 'writeDoc']);
    expect(tested.toolNames).toEqual(['search']);
    expect(selectEnabledMcpOperations(tested.operations, tested.toolNames).map((operation) => operation.id)).toEqual(['search']);
    expect(discoverRemoteMcpTools).toHaveBeenCalledWith({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer super-secret-value' },
    });
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const previousE2e = process.env.E2E_MODE;
    process.env.E2E_MODE = 'false';
    const lookupSpy = jest
      .spyOn(dns.promises, 'lookup')
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    const fetchMock = jest.spyOn(global, 'fetch');

    try {
      await expect(
        defaultMcpServerFetch('https://metadata.attacker.example/latest', {
          method: 'GET',
          headers: { Authorization: 'Bearer custom-key' },
        })
      ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      lookupSpy.mockRestore();
      fetchMock.mockRestore();
      process.env.E2E_MODE = previousE2e;
    }
  });
});
