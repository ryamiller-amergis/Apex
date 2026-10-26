import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatThread } from '../../shared/types/chat';
import type { McpServerProvider } from '../../shared/types/mcpServers';
import { insertMessage, upsertThread } from './chatThreadRepository';
import { McpServerError } from './mcpServerErrors';
import {
  defaultMcpServerFetch,
  type McpServerFetch,
} from './mcpServerConnectionService';
import { executeMcpServerRead } from './mcpServerReadService';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export interface AskMcpServerInput {
  project: string;
  connectionId: string;
  userId: string;
  question: string;
  fetchImpl?: McpServerFetch;
}

export interface AskMcpServerResult {
  threadId: string;
  connectionId: string;
  operationId: string;
  answer: string;
}

interface SelectedRead {
  operationId: string;
  params: Record<string, string>;
}

export function selectMcpServerRead(provider: McpServerProvider, question: string): SelectedRead {
  const email = question.match(EMAIL)?.[0];
  if (!email) {
    throw new McpServerError(
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
  throw new McpServerError(
    400,
    'This connector has no question mapping',
    'QUESTION_UNSUPPORTED',
  );
}

export async function askMcpServer(input: AskMcpServerInput): Promise<AskMcpServerResult> {
  const question = input.question?.trim() ?? '';
  if (!input.connectionId || !question) {
    throw new McpServerError(400, 'A connection and a question are required', 'QUESTION_REQUIRED');
  }

  const { listMcpServers } = await import('./mcpServerConnectionService');
  const connections = await listMcpServers(input.project);
  const connection = connections.find((item) => item.id === input.connectionId);
  if (!connection) {
    throw new McpServerError(404, 'Connection not found', 'NOT_FOUND');
  }

  const selected = selectMcpServerRead(connection.provider, question);
  const read = await executeMcpServerRead({
    project: input.project,
    connectionId: connection.id,
    userId: input.userId,
    operationId: selected.operationId,
    params: selected.params,
    fetchImpl: input.fetchImpl ?? defaultMcpServerFetch,
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
      assistantType: 'mcp-server',
      mcpServerId: connection.id,
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
