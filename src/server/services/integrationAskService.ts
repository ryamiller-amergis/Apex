import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatThread } from '../../shared/types/chat';
import type { IntegrationProvider } from '../../shared/types/integrations';
import { insertMessage, upsertThread } from './chatThreadRepository';
import { IntegrationConnectionError } from './integrationErrors';
import {
  defaultIntegrationFetch,
  type IntegrationFetch,
} from './integrationConnectionService';
import { executeIntegrationRead } from './integrationReadService';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export interface AskIntegrationInput {
  project: string;
  connectionId: string;
  userId: string;
  question: string;
  fetchImpl?: IntegrationFetch;
}

export interface AskIntegrationResult {
  threadId: string;
  connectionId: string;
  operationId: string;
  answer: string;
}

interface SelectedRead {
  operationId: string;
  params: Record<string, string>;
}

export function selectIntegrationRead(provider: IntegrationProvider, question: string): SelectedRead {
  const email = question.match(EMAIL)?.[0];
  if (!email) {
    throw new IntegrationConnectionError(
      400,
      'Ask about a person using an email address from the ticket',
      'QUESTION_UNSUPPORTED',
    );
  }
  if (provider === 'clerk') {
    return { operationId: 'listUsers', params: { email_address: email } };
  }
  if (provider === 'pendo') {
    return { operationId: 'getVisitor', params: { visitorId: email } };
  }
  if (provider === 'sendgrid') {
    return { operationId: 'getBounces', params: { email } };
  }
  throw new IntegrationConnectionError(
    400,
    'This connector has no question mapping',
    'QUESTION_UNSUPPORTED',
  );
}

export async function askIntegration(input: AskIntegrationInput): Promise<AskIntegrationResult> {
  const question = input.question?.trim() ?? '';
  if (!input.connectionId || !question) {
    throw new IntegrationConnectionError(400, 'A connection and a question are required', 'QUESTION_REQUIRED');
  }

  const { listIntegrationConnections } = await import('./integrationConnectionService');
  const connections = await listIntegrationConnections(input.project);
  const connection = connections.find((item) => item.id === input.connectionId);
  if (!connection) {
    throw new IntegrationConnectionError(404, 'Connection not found', 'NOT_FOUND');
  }

  const selected = selectIntegrationRead(connection.provider, question);
  const read = await executeIntegrationRead({
    project: input.project,
    connectionId: connection.id,
    userId: input.userId,
    operationId: selected.operationId,
    params: selected.params,
    fetchImpl: input.fetchImpl ?? defaultIntegrationFetch,
  });

  const now = new Date().toISOString();
  const threadId = randomUUID();
  const answer = `${connection.name} (${connection.provider} ${read.operationId}): ${read.body}`;
  const thread: ChatThread = {
    id: threadId,
    userId: input.userId,
    kickoff: {
      project: input.project,
      repo: input.project,
      assistantType: 'integration',
      integrationConnectionId: connection.id,
      pillLabel: connection.name,
    },
    messages: [],
    status: 'idle',
    workspaceDir: '',
    flagged: false,
    createdAt: now,
    lastActivityAt: now,
  };
  await upsertThread(thread);

  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: question,
    ts: now,
  };
  const assistantMessage: ChatMessage = {
    id: randomUUID(),
    role: 'agent',
    text: answer,
    ts: now,
  };
  await insertMessage(threadId, userMessage);
  await insertMessage(threadId, assistantMessage);

  return {
    threadId,
    connectionId: connection.id,
    operationId: read.operationId,
    answer,
  };
}
