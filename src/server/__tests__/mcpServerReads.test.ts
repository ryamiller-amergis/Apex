/**
 * SC-5 / SC-6 — prebuilt read allow-lists, connection tests, and grounded chat.
 * One connection cannot call another provider. The answer includes the provider body.
 */

const memory: Array<Record<string, unknown>> = [];
const upsertThread = jest.fn();
const insertMessage = jest.fn();

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

jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: (...args: unknown[]) => upsertThread(...args),
  insertMessage: (...args: unknown[]) => insertMessage(...args),
}));

import {
  createMcpServer,
  testMcpServer,
} from '../services/mcpServerConnectionService';
import {
  buildMcpServerReadUrl,
  executeMcpServerRead,
  executeMountedMcpServerRead,
  executeMountedMcpTool,
  supportsTimestampBoundarySearch,
} from '../services/mcpServerReadService';
import {
  buildMcpToolZodInputSchema,
  createMcpServerRuntime,
  resetMcpTurnCallBudget,
} from '../mcp/mcpServers/server';
import { askMcpServer } from '../services/mcpServerAskService';
import { McpServerError } from '../services/mcpServerErrors';
import * as mcpServerDiscovery from '../services/mcpServerDiscovery';

const SECRET = 'integration-read-test-secret';
const QUESTION =
  'What do we know about user jane@example.com from ticket 4421?';

async function usableConnection(
  provider: 'clerk' | 'pendo' | 'sendgrid',
  name: string
) {
  const created = await createMcpServer({
    project: 'MaxView',
    name,
    provider,
    credential:
      provider === 'pendo' ? 'pendo-secret-key' : 'sk_live_supersecret',
    allowedUserIds: ['user-1'],
    createdBy: 'user-1',
  });
  return testMcpServer('MaxView', created.id, async () => ({
    status: 200,
    body: '{"ok":true}',
  }));
}

describe('integration reads', () => {
  beforeEach(() => {
    memory.length = 0;
    upsertThread.mockReset();
    insertMessage.mockReset();
    process.env.SESSION_SECRET = SECRET;
  });

  it('SC-3 tests Clerk, Pendo, and SendGrid against their catalog URLs', async () => {
    const clerk = await createMcpServer({
      project: 'MaxView',
      name: 'Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });
    const pendo = await createMcpServer({
      project: 'MaxView',
      name: 'Pendo',
      provider: 'pendo',
      credential: 'pendo-secret-key',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });
    const sendgrid = await createMcpServer({
      project: 'MaxView',
      name: 'SendGrid',
      provider: 'sendgrid',
      credential: 'sg-secret-key',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    const clerkFetch = jest.fn(async () => ({ status: 200, body: '{}' }));
    const pendoFetch = jest.fn(async () => ({ status: 200, body: '{}' }));
    const sendgridFetch = jest.fn(async () => ({ status: 200, body: '{}' }));

    await testMcpServer('MaxView', clerk.id, clerkFetch);
    await testMcpServer('MaxView', pendo.id, pendoFetch);
    await testMcpServer('MaxView', sendgrid.id, sendgridFetch);

    expect(clerkFetch).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/users?limit=1',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer sk_live_supersecret' },
      }
    );
    expect(pendoFetch).toHaveBeenCalledWith(
      'https://app.pendo.io/api/v1/metadata/schema/visitor',
      {
        method: 'GET',
        headers: { 'x-pendo-integration-key': 'pendo-secret-key' },
      }
    );
    expect(sendgridFetch).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/scopes',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer sg-secret-key' },
      }
    );
  });

  it('SC-5 lets a Clerk connection call only Clerk read operations', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '{"id":"user_1"}',
    }));

    const result = await executeMcpServerRead({
      project: 'MaxView',
      connectionId: clerk.id,
      userId: 'user-1',
      operationId: 'getUser',
      params: { userId: 'user_1' },
      fetchImpl,
    });

    expect(result.body).toContain('user_1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/users/user_1',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer sk_live_supersecret' },
      }
    );

    fetchImpl.mockClear();
    await expect(
      executeMcpServerRead({
        project: 'MaxView',
        connectionId: clerk.id,
        userId: 'user-1',
        operationId: 'getBounces',
        params: { email: 'jane@example.com' },
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SC-5 grounds a ticket question in the Clerk result and records the connection', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '[{"id":"user_9","email":"jane@example.com","name":"Jane Ticket"}]',
    }));

    const answer = await askMcpServer({
      project: 'MaxView',
      connectionId: clerk.id,
      userId: 'user-1',
      question: QUESTION,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/users?email_address=jane%40example.com',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk_live_supersecret' },
      })
    );
    expect(answer.operationId).toBe('listUsers');
    expect(answer.answer).toContain('Jane Ticket');
    expect(JSON.stringify(answer)).not.toContain('sk_live_supersecret');
    expect(upsertThread).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        kickoff: expect.objectContaining({
          assistantType: 'mcp-server',
          mcpServerId: clerk.id,
          project: 'MaxView',
          pillLabel: 'MaxView Clerk',
        }),
      })
    );
    expect(insertMessage).toHaveBeenCalledWith(
      answer.threadId,
      expect.objectContaining({
        role: 'agent',
        text: expect.stringContaining('Jane Ticket'),
      })
    );
  });

  it('SC-4 refuses a connection that belongs to another project', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: 'Jane Ticket',
    }));

    await expect(
      askMcpServer({
        project: 'MatterWorx',
        connectionId: clerk.id,
        userId: 'user-1',
        question: QUESTION,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(McpServerError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SC-6 asks Pendo and SendGrid as separate connections', async () => {
    const pendo = await usableConnection('pendo', 'MaxView Pendo');
    const sendgrid = await usableConnection('sendgrid', 'MaxView SendGrid');
    const fetchImpl = jest.fn(async (url: string) => ({
      status: 200,
      body: url.includes('pendo')
        ? '{"name":"Jane Ticket"}'
        : '{"email":"jane@example.com"}',
    }));

    const pendoAnswer = await askMcpServer({
      project: 'MaxView',
      connectionId: pendo.id,
      userId: 'user-1',
      question: QUESTION,
      fetchImpl,
    });
    const sendgridAnswer = await askMcpServer({
      project: 'MaxView',
      connectionId: sendgrid.id,
      userId: 'user-1',
      question: QUESTION,
      fetchImpl,
    });

    expect(pendoAnswer.operationId).toBe('getVisitor');
    expect(sendgridAnswer.operationId).toBe('getBounces');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://app.pendo.io/api/v1/visitor/jane%40example.com',
      expect.objectContaining({
        headers: { 'x-pendo-integration-key': 'pendo-secret-key' },
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.sendgrid.com/v3/suppression/bounces/jane%40example.com',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk_live_supersecret' },
      })
    );
    await expect(
      executeMcpServerRead({
        project: 'MaxView',
        connectionId: pendo.id,
        userId: 'user-1',
        operationId: 'getBounces',
        params: { email: 'jane@example.com' },
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
  });

  it('keeps the connection base path when joining an absolute operation path', () => {
    expect(
      buildMcpServerReadUrl('https://api.example.com/v1', '/tickets/{id}', {
        id: '4421',
      })
    ).toBe('https://api.example.com/v1/tickets/4421');
  });

  it('rejects protocol-relative operation paths', () => {
    expect(() =>
      buildMcpServerReadUrl(
        'https://api.example.com',
        '//attacker.example/x',
        {}
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATION_NOT_ALLOWED' }));
  });

  it('lets any signed-in project user read a connection', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '{"id":"user_1"}',
    }));

    await expect(
      executeMountedMcpServerRead(
        clerk.id,
        '',
        'getUser',
        { userId: 'user_1' },
        fetchImpl
      )
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const result = await executeMountedMcpServerRead(
      clerk.id,
      'user-2',
      'getUser',
      { userId: 'user_1' },
      fetchImpl
    );
    expect(result.body).toContain('user_1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exposes the full tool inputSchema and timestamp boundary parameters for sortable paginated MCP tools', () => {
    const listUsersOp = {
      id: 'list_users',
      method: 'GET' as const,
      path: '/mcp-tool',
      summary: 'List users',
      readOnly: true as const,
      source: 'mcp' as const,
      inputSchema: {
        type: 'object',
        required: ['application_id', 'instance', 'context'],
        properties: {
          application_id: { type: 'string', description: 'Clerk application ID' },
          instance: { type: 'string', description: 'Environment instance' },
          limit: { type: 'integer', minimum: 1, maximum: 250 },
          offset: { type: 'integer', minimum: 0 },
          order_by: { type: 'string', description: 'Sort order, e.g. -last_sign_in_at' },
          context: { type: 'string', description: 'Analytics context' },
        },
      },
    };

    expect(supportsTimestampBoundarySearch(listUsersOp)).toBe(true);
    const zodSchema = buildMcpToolZodInputSchema(listUsersOp);
    const parsed = zodSchema.parse({
      application_id: 'app_123',
      instance: 'production',
      since_timestamp_ms: 1792728000000,
    });
    expect(parsed).toEqual({
      application_id: 'app_123',
      instance: 'production',
      context: 'Answer user question in Apex',
      since_timestamp_ms: 1792728000000,
    });
  });

  it('counts records across pages in one tool call when since_timestamp_ms is provided', async () => {
    const cutoffMs = Date.parse('2026-10-23T04:00:00.000Z');
    const totalUsers = 1000;
    const matchingUsers = 420;

    const callRemoteSpy = jest
      .spyOn(mcpServerDiscovery, 'callRemoteMcpTool')
      .mockImplementation(async ({ args }) => {
        const offset = typeof args.offset === 'number' ? args.offset : 0;
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const data = [];
        for (let idx = offset; idx < Math.min(totalUsers, offset + limit); idx += 1) {
          const ts =
            idx < matchingUsers
              ? cutoffMs + (matchingUsers - idx) * 1000
              : cutoffMs - (idx - matchingUsers + 1) * 1000;
          data.push({
            id: `user_${idx}`,
            last_sign_in_at: ts,
            image_url: 'https://img.clerk.com/avatar',
            phone_numbers: [],
          });
        }
        return JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ data, total_count: totalUsers }),
            },
            {
              type: 'text',
              text: JSON.stringify({ conversation_id: 'conv_test_1' }),
            },
          ],
        });
      });

    try {
      const created = await createMcpServer({
        project: 'MaxView',
        name: 'Clerk MCP',
        provider: 'custom',
        credential: '',
        mcpUrl: 'https://mcp.clerk.com/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        secrets: [{ name: 'TOKEN', value: 'sk_test_123' }],
        toolNames: ['list_users'],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      });
      memory[0].operations = [
        {
          id: 'list_users',
          method: 'GET',
          path: '/mcp-tool',
          summary: 'List users',
          readOnly: true,
          source: 'mcp',
          inputSchema: {
            type: 'object',
            required: ['application_id', 'instance', 'context'],
            properties: {
              application_id: { type: 'string' },
              instance: { type: 'string' },
              limit: { type: 'integer' },
              offset: { type: 'integer' },
              order_by: { type: 'string' },
              context: { type: 'string' },
            },
          },
        },
      ];

      resetMcpTurnCallBudget(created.id, 'user-1');
      const raw = await executeMountedMcpTool(created.id, 'user-1', 'list_users', {
        application_id: 'app_1',
        instance: 'production',
        order_by: '-last_sign_in_at',
        since_timestamp_ms: cutoffMs,
      });

      const outer = JSON.parse(raw);
      const summary = JSON.parse(outer.content[0].text);
      expect(summary.matching_count).toBe(matchingUsers);
      expect(summary.total_count).toBe(totalUsers);
      expect(summary.timestamp_field).toBe('last_sign_in_at');
      expect(summary.sample_records).toHaveLength(5);
      expect(summary.sample_records[0]).not.toHaveProperty('image_url');

      const runtime = await createMcpServerRuntime(created.id, 'user-1');
      expect(runtime).toBeDefined();
    } finally {
      callRemoteSpy.mockRestore();
    }
  });
});
