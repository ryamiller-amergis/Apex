/**
 * SC-7 — a custom connector needs an operation definition, a restricted https URL,
 * and a read-only mark. A base URL and key alone cannot be saved.
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
  integrationConnections: new Proxy(
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
      where: async () => undefined,
    }),
  },
}));

import {
  createIntegrationConnection,
  testIntegrationConnection,
} from '../services/integrationConnectionService';
import { importOpenApiOperations } from '../services/integrationOpenApi';

const SECRET = 'integration-custom-test-secret';

describe('custom integration connectors', () => {
  beforeEach(() => {
    memory.length = 0;
    process.env.SESSION_SECRET = SECRET;
  });

  it('SC-7 rejects a custom connector saved from only a base URL and key', async () => {
    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Tickets',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://api.example.com',
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'OPERATIONS_REQUIRED' });
    expect(memory).toHaveLength(0);
  });

  it('SC-7 requires read-only https operations and stores a tested manual definition', async () => {
    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Tickets',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'http://api.example.com',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Tickets',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://user:pass@api.example.com',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Local',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://localhost/api',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Writes',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://api.example.com',
        operations: [
          {
            id: 'createTicket',
            method: 'POST' as 'GET',
            path: '/tickets',
            summary: 'Create a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'READ_ONLY_REQUIRED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Writes',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://api.example.com',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/../admin',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    const created = await createIntegrationConnection({
      project: 'MaxView',
      name: 'Tickets',
      provider: 'custom',
      credential: 'custom-key',
      baseUrl: 'https://api.example.com',
      operations: [
        {
          id: 'getTicket',
          method: 'GET',
          path: '/tickets/{id}',
          summary: 'Get a ticket',
          readOnly: true,
        },
      ],
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    expect(created.provider).toBe('custom');
    expect(created.operations).toEqual([
      {
        id: 'getTicket',
        method: 'GET',
        path: '/tickets/{id}',
        summary: 'Get a ticket',
        readOnly: true,
      },
    ]);
    expect(JSON.stringify(created)).not.toContain('custom-key');

    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '{"id":"sample"}',
    }));
    const tested = await testIntegrationConnection(
      'MaxView',
      created.id,
      fetchImpl
    );
    expect(tested.status).toBe('usable');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/tickets/sample',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer custom-key' },
      }
    );
  });

  it('keeps a versioned base path when testing a custom connector', async () => {
    const created = await createIntegrationConnection({
      project: 'MaxView',
      name: 'Tickets v1',
      provider: 'custom',
      credential: 'custom-key',
      baseUrl: 'https://api.example.com/v1',
      operations: [
        {
          id: 'getTicket',
          method: 'GET',
          path: '/tickets/{id}',
          summary: 'Get a ticket',
          readOnly: true,
        },
      ],
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });

    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '{"id":"sample"}',
    }));
    await testIntegrationConnection('MaxView', created.id, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/tickets/sample',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer custom-key' },
      }
    );
  });

  it('rejects protocol-relative custom operation paths', async () => {
    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Escape',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://api.example.com',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '//attacker.example/x',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });
  });

  it('rejects IPv6 unique-local and link-local custom hosts', async () => {
    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'ULA',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://[fd12:3456::1]/api',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Link local',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://[fe80::1]/api',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });

    await expect(
      createIntegrationConnection({
        project: 'MaxView',
        name: 'Mapped loopback',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://[::ffff:127.0.0.1]/api',
        operations: [
          {
            id: 'getTicket',
            method: 'GET',
            path: '/tickets/{id}',
            summary: 'Get a ticket',
            readOnly: true,
          },
        ],
        allowedUserIds: ['user-1'],
        createdBy: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'URL_RESTRICTED' });
  });

  it('SC-7 imports GET operations from OpenAPI and ignores writes', () => {
    const imported = importOpenApiOperations(
      {
        openapi: '3.0.0',
        paths: {
          '/tickets/{id}': {
            get: { operationId: 'getTicket', summary: 'Get a ticket' },
            post: { operationId: 'createTicket', summary: 'Create a ticket' },
          },
        },
      },
      'https://api.example.com'
    );

    expect(imported).toEqual([
      {
        id: 'getTicket',
        method: 'GET',
        path: '/tickets/{id}',
        summary: 'Get a ticket',
        readOnly: true,
      },
    ]);

    expect(() =>
      importOpenApiOperations(
        {
          openapi: '3.0.0',
          paths: { '/tickets': { post: { operationId: 'createTicket' } } },
        },
        'https://api.example.com'
      )
    ).toThrow(expect.objectContaining({ code: 'OPERATIONS_REQUIRED' }));

    expect(() =>
      importOpenApiOperations(
        {
          openapi: '3.0.0',
          servers: [{ url: 'https://evil.example' }],
          paths: {
            '/tickets/{id}': {
              get: { operationId: 'getTicket', summary: 'Get a ticket' },
            },
          },
        },
        'https://api.example.com'
      )
    ).toThrow(expect.objectContaining({ code: 'URL_RESTRICTED' }));
  });
});
