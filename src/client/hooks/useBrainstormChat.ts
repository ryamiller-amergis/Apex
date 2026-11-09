import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrainstormSessionDetail } from '../../shared/types/brainstorm';
import { useAgentChatSession, type AgentChatSession } from './useAgentChatSession';
import { brainstormKeys, brainstormPath } from './useBrainstormSessions';

export interface BrainstormChatEndpoints {
  sendEndpoint: string;
  cancelEndpoint: string;
  retryEndpoint: (runId: string) => string;
}

export function brainstormChatEndpoints(project: string, sessionId: string): BrainstormChatEndpoints {
  const base = `/${encodeURIComponent(sessionId)}`;
  return {
    sendEndpoint: brainstormPath(project, `${base}/messages`),
    cancelEndpoint: brainstormPath(project, `${base}/cancel`),
    retryEndpoint: (runId) => brainstormPath(project, `${base}/runs/${encodeURIComponent(runId)}/retry`),
  };
}

/**
 * Brainstorm chat on the shared agent chat session. Sends, cancels and retries go to the
 * Brainstorm routes so the server can check the creator; the stream still comes from the thread.
 */
export function useBrainstormChat(
  project: string,
  session: BrainstormSessionDetail | null | undefined,
): AgentChatSession {
  const client = useQueryClient();
  const sessionId = session?.id ?? '';
  const endpoints = useMemo(
    () => brainstormChatEndpoints(project, sessionId),
    [project, sessionId],
  );

  const afterSend = useCallback(async () => {
    if (!sessionId) return;
    await Promise.all([
      client.invalidateQueries({ queryKey: brainstormKeys.messages(project, sessionId) }),
      client.invalidateQueries({ queryKey: brainstormKeys.session(project, sessionId) }),
    ]);
  }, [client, project, sessionId]);

  return useAgentChatSession(session?.threadId ?? null, {
    locked: !session?.canMutate,
    sendEndpoint: endpoints.sendEndpoint,
    cancelEndpoint: endpoints.cancelEndpoint,
    retryEndpoint: endpoints.retryEndpoint,
    afterSend,
    streamTransport: 'ws',
  });
}
