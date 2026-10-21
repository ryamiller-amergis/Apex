/**
 * SC-5 / SC-6 — prebuilt read allow-lists, connection tests, and grounded chat.
 * One connection cannot call another provider. The answer includes the provider body.
 */

const memory: Array<Record<string, unknown>> = [];
const upsertThread = jest.fn();
const insertMessage = jest.fn();

function applyWhere(rows: Array<Record<string, unknown>>, clause: any): Array<Record<string, unknown>> {
  if (!clause) return rows;
  if (clause.type === 'and') {
    return clause.args.reduce(
      (acc: Array<Record<string, unknown>>, child: unknown) => applyWhere(acc, child),
      rows,
    );
  }
  if (clause.type === 'eq') {
    return rows.filter((row) => row[clause.field] === clause.val);
  }
  return rows;
}

jest.mock('drizzle-orm', () => ({
  eq: (column: { field: string }, val: unknown) => ({ type: 'eq', field: column.field, val }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
}));

jest.mock('../db/schema', () => ({
  integrationConnections: new Proxy(
    {},
    { get: (_target, prop) => ({ field: String(prop) }) },
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

import { createIntegrationConnection, testIntegrationConnection } from '../services/integrationConnectionService';
import { executeIntegrationRead } from '../services/integrationReadService';
import { askIntegration } from '../services/integrationAskService';
import { IntegrationConnectionError } from '../services/integrationErrors';

const SECRET = 'integration-read-test-secret';
const QUESTION = 'What do we know about user jane@example.com from ticket 4421?';

async function usableConnection(
  provider: 'clerk' | 'pendo' | 'sendgrid',
  name: string,
) {
  const created = await createIntegrationConnection({
    project: 'MaxView',
    name,
    provider,
    credential: provider === 'pendo' ? 'pendo-secret-key' : 'sk_live_supersecret',
    allowedUserIds: ['user-1'],
    createdBy: 'user-1',
  });
  return testIntegrationConnection('MaxView', created.id, async () => ({ status: 200, body: '{"ok":true}' }));
}

describe('integration reads', () => {
  beforeEach(() => {
    memory.length = 0;
    upsertThread.mockReset();
    insertMessage.mockReset();
    process.env.SESSION_SECRET = SECRET;
  });

  it('SC-3 tests Clerk, Pendo, and SendGrid against their catalog URLs', async () => {
    const clerk = await createIntegrationConnection({
      project: 'MaxView',
      name: 'Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });
    const pendo = await createIntegrationConnection({
      project: 'MaxView',
      name: 'Pendo',
      provider: 'pendo',
      credential: 'pendo-secret-key',
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
    });
    const sendgrid = await createIntegrationConnection({
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

    await testIntegrationConnection('MaxView', clerk.id, clerkFetch);
    await testIntegrationConnection('MaxView', pendo.id, pendoFetch);
    await testIntegrationConnection('MaxView', sendgrid.id, sendgridFetch);

    expect(clerkFetch).toHaveBeenCalledWith('https://api.clerk.com/v1/users?limit=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer sk_live_supersecret' },
    });
    expect(pendoFetch).toHaveBeenCalledWith('https://app.pendo.io/api/v1/metadata/schema/visitor', {
      method: 'GET',
      headers: { 'x-pendo-integration-key': 'pendo-secret-key' },
    });
    expect(sendgridFetch).toHaveBeenCalledWith('https://api.sendgrid.com/v3/scopes', {
      method: 'GET',
      headers: { Authorization: 'Bearer sg-secret-key' },
    });
  });

  it('SC-5 lets a Clerk connection call only Clerk read operations', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({ status: 200, body: '{"id":"user_1"}' }));

    const result = await executeIntegrationRead({
      project: 'MaxView',
      connectionId: clerk.id,
      userId: 'user-1',
      operationId: 'getUser',
      params: { userId: 'user_1' },
      fetchImpl,
    });

    expect(result.body).toContain('user_1');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.clerk.com/v1/users/user_1', {
      method: 'GET',
      headers: { Authorization: 'Bearer sk_live_supersecret' },
    });

    fetchImpl.mockClear();
    await expect(executeIntegrationRead({
      project: 'MaxView',
      connectionId: clerk.id,
      userId: 'user-1',
      operationId: 'getBounces',
      params: { email: 'jane@example.com' },
      fetchImpl,
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SC-5 grounds a ticket question in the Clerk result and records the connection', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      body: '[{"id":"user_9","email":"jane@example.com","name":"Jane Ticket"}]',
    }));

    const answer = await askIntegration({
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
      }),
    );
    expect(answer.operationId).toBe('listUsers');
    expect(answer.answer).toContain('Jane Ticket');
    expect(JSON.stringify(answer)).not.toContain('sk_live_supersecret');
    expect(upsertThread).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      kickoff: expect.objectContaining({
        assistantType: 'integration',
        integrationConnectionId: clerk.id,
        project: 'MaxView',
        pillLabel: 'MaxView Clerk',
      }),
    }));
    expect(insertMessage).toHaveBeenCalledWith(
      answer.threadId,
      expect.objectContaining({ role: 'agent', text: expect.stringContaining('Jane Ticket') }),
    );
  });

  it('SC-4 refuses a connection that belongs to another project', async () => {
    const clerk = await usableConnection('clerk', 'MaxView Clerk');
    const fetchImpl = jest.fn(async () => ({ status: 200, body: 'Jane Ticket' }));

    await expect(askIntegration({
      project: 'MatterWorx',
      connectionId: clerk.id,
      userId: 'user-1',
      question: QUESTION,
      fetchImpl,
    })).rejects.toBeInstanceOf(IntegrationConnectionError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SC-6 asks Pendo and SendGrid as separate connections', async () => {
    const pendo = await usableConnection('pendo', 'MaxView Pendo');
    const sendgrid = await usableConnection('sendgrid', 'MaxView SendGrid');
    const fetchImpl = jest.fn(async (url: string) => ({
      status: 200,
      body: url.includes('pendo') ? '{"name":"Jane Ticket"}' : '{"email":"jane@example.com"}',
    }));

    const pendoAnswer = await askIntegration({
      project: 'MaxView',
      connectionId: pendo.id,
      userId: 'user-1',
      question: QUESTION,
      fetchImpl,
    });
    const sendgridAnswer = await askIntegration({
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
      expect.objectContaining({ headers: { 'x-pendo-integration-key': 'pendo-secret-key' } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.sendgrid.com/v3/suppression/bounces/jane%40example.com',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk_live_supersecret' } }),
    );
    await expect(executeIntegrationRead({
      project: 'MaxView',
      connectionId: pendo.id,
      userId: 'user-1',
      operationId: 'getBounces',
      params: { email: 'jane@example.com' },
      fetchImpl,
    })).rejects.toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
  });
});
