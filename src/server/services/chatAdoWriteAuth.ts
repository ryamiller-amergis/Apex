import type { AzureDevOpsService } from './azureDevOps';
import { adoWriteFromToken } from './adoFactory';
import { getUserPermissions } from './rbacService';
import { getAdoTokenForThread } from './standupTokenResolver';
import { canWriteThread, resolveThreadAccess } from './threadAccessService';

const TURN_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

interface ChatAdoWriteTurnContext {
  registrationId: symbol;
  userId: string;
  project: string;
  token: string | null;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

export class ChatAdoWriteAuthError extends Error {
  status = 403;

  constructor(message: string) {
    super(message);
    this.name = 'ChatAdoWriteAuthError';
  }
}

const turnContexts = new Map<string, ChatAdoWriteTurnContext>();

export async function registerChatAdoWriteTurn(input: {
  threadId: string;
  userId: string;
  project: string;
  token: string | null;
  isSuperAdmin?: boolean;
}): Promise<() => void> {
  const access = await resolveThreadAccess(input.userId, input.threadId);
  if (!access) {
    throw new ChatAdoWriteAuthError('Chat thread not found or not writable');
  }

  const mayWriteThread =
    access.access === 'owner' ||
    (await canWriteThread(input.userId, input.threadId));
  if (!mayWriteThread) {
    throw new ChatAdoWriteAuthError('Chat thread not found or not writable');
  }
  if (access.thread.kickoff.project !== input.project) {
    throw new ChatAdoWriteAuthError(
      'Azure DevOps project does not match the chat thread',
    );
  }

  const permissions = await getUserPermissions(input.userId, input.project);
  if (!input.isSuperAdmin && !permissions.has('workitems:write')) {
    throw new ChatAdoWriteAuthError(
      'You do not have permission to write Azure DevOps work items',
    );
  }

  const registrationId = Symbol(input.threadId);
  const previous = turnContexts.get(input.threadId);
  if (previous) clearTimeout(previous.timeout);

  const timeout = setTimeout(() => {
    const current = turnContexts.get(input.threadId);
    if (current?.registrationId === registrationId) {
      turnContexts.delete(input.threadId);
    }
  }, TURN_CONTEXT_TTL_MS);
  timeout.unref?.();

  turnContexts.set(input.threadId, {
    registrationId,
    userId: input.userId,
    project: input.project,
    token: input.token,
    expiresAt: Date.now() + TURN_CONTEXT_TTL_MS,
    timeout,
  });

  return () => {
    const current = turnContexts.get(input.threadId);
    if (current?.registrationId !== registrationId) return;
    clearTimeout(current.timeout);
    turnContexts.delete(input.threadId);
  };
}

export function adoServiceForChatThread(
  threadId: string,
  project: string,
  areaPath?: string,
): AzureDevOpsService {
  const context = turnContexts.get(threadId);
  if (!context || context.expiresAt <= Date.now()) {
    if (context) {
      clearTimeout(context.timeout);
      turnContexts.delete(threadId);
    }
    throw new ChatAdoWriteAuthError(
      'Azure DevOps writes require an explicit request in the current chat turn',
    );
  }
  if (context.project !== project) {
    throw new ChatAdoWriteAuthError(
      'Azure DevOps project does not match the authorized chat turn',
    );
  }
  return adoWriteFromToken(context.token, project, areaPath);
}

/**
 * Resolve credentials for MCP work-item writes. Prefer the current chat turn's
 * authorized user token; if that turn was never registered, use a standup
 * participant thread token when one exists. Home-chat writes without either
 * context stay denied.
 */
export async function adoServiceForChatOrStandupWrite(
  threadId: string,
  project: string,
  areaPath?: string,
): Promise<AzureDevOpsService> {
  try {
    return adoServiceForChatThread(threadId, project, areaPath);
  } catch (error) {
    if (!isChatAdoWriteAuthError(error)) throw error;
    const standupToken = await getAdoTokenForThread(threadId);
    if (!standupToken) throw error;
    return adoWriteFromToken(standupToken, project, areaPath);
  }
}

export function isChatAdoWriteAuthError(
  error: unknown,
): error is ChatAdoWriteAuthError {
  return error instanceof ChatAdoWriteAuthError;
}
