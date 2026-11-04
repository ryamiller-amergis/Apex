import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../../shared/types/chat';
import { friendlyChatProgressLabel } from '../../shared/utils/chatProgressCopy';
import { useAgentChatSession } from './useAgentChatSession';
import { RUN_STALLED_NOTICE, useRunStalled } from './useRunStalled';
import {
  openInteractiveStream,
  type ThreadStreamHandle,
} from '../utils/threadEventStream';

export interface AskApexMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

type SessionStatus = 'idle' | 'preparing' | 'streaming' | 'error';

interface AskApexSseEvent {
  type: 'token' | 'message' | 'status' | 'error' | 'done';
  text?: string;
  message?: AskApexMessage;
  status?: SessionStatus;
  error?: string;
}

function toAskApexMessage(message: ChatMessage): AskApexMessage {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    text: message.text,
    ts: message.ts,
  };
}

function isConversationMessage(message: ChatMessage): boolean {
  return !message.hidden && message.role !== 'tool';
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useAskApex() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AskApexMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [isConnected, setIsConnected] = useState(false);
  /** Set when the session is a chat thread on the V2 host. */
  const [threadId, setThreadId] = useState<string | null>(null);
  // Ask Apex threads wait for the user's first message, so an empty thread is
  // not a thread that is still preparing.
  const chat = useAgentChatSession(threadId);
  const chatStalled = useRunStalled(
    Boolean(threadId) && chat.isRunning && !chat.isRetrying,
    chat.lastProgressAt,
  );

  const streamRef = useRef<ThreadStreamHandle | null>(null);
  const streamBufferRef = useRef('');

  // FEAT-007: route through the shared interactive stream transport. Ask Apex
  // is not thread-actor backed, so it stays on SSE (no `wsUrlFor`) until a
  // session-actor backing exists; the transport centralizes the future cutover.
  const connectSse = useCallback((sid: string) => {
    if (streamRef.current) {
      streamRef.current.close();
    }

    const stream = openInteractiveStream(
      {
        onOpen: () => setIsConnected(true),
        onError: () => setIsConnected(false),
        onMessage: (data: string) => handleAskApexEvent(data),
      },
      { sseUrl: `/api/ask-apex/sessions/${sid}/stream`, transport: 'sse' }
    );

    streamRef.current = stream;

    function handleAskApexEvent(data: string) {
      let event: AskApexSseEvent;
      try {
        event = JSON.parse(data) as AskApexSseEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'token': {
          streamBufferRef.current += event.text ?? '';
          setStreamingText(streamBufferRef.current);
          break;
        }
        case 'message': {
          if (event.message) {
            streamBufferRef.current = '';
            setStreamingText('');
            setMessages((prev) => {
              const exists = prev.some((m) => m.id === event.message!.id);
              return exists ? prev : [...prev, event.message!];
            });
          }
          break;
        }
        case 'status': {
          if (event.status) setStatus(event.status);
          break;
        }
        case 'error': {
          setStatus('error');
          break;
        }
        case 'done': {
          streamBufferRef.current = '';
          setStreamingText('');
          break;
        }
      }
    }

    return stream;
  }, []);

  const startSession = useCallback(async () => {
    try {
      const { sessionId: sid, threadId: tid } = await apiFetch<{
        sessionId: string;
        threadId?: string;
      }>(
        '/api/ask-apex/sessions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      setSessionId(sid);
      setThreadId(tid ?? null);
      setMessages([]);
      setStreamingText('');
      setStatus('idle');
      streamBufferRef.current = '';
      if (!tid) connectSse(sid);
      return sid;
    } catch (err) {
      console.error('[useAskApex] startSession error:', err);
      return null;
    }
  }, [connectSse]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return;
      if (threadId) {
        await chat.send(text.trim());
        return;
      }
      setStatus('streaming');
      try {
        await apiFetch(`/api/ask-apex/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        console.error('[useAskApex] sendMessage error:', err);
        setStatus('error');
      }
    },
    [sessionId, threadId, chat]
  );

  const closeSession = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    if (sessionId && !threadId) {
      fetch(`/api/ask-apex/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => {});
    }
    setSessionId(null);
    setThreadId(null);
    setMessages([]);
    setStreamingText('');
    setStatus('idle');
    setIsConnected(false);
    streamBufferRef.current = '';
  }, [sessionId, threadId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  if (threadId) {
    const chatStatus: SessionStatus = chat.isPreparing
      ? 'preparing'
      : chat.isInteractionBusy
        ? 'streaming'
        : chat.status === 'error'
          ? 'error'
          : 'idle';
    return {
      sessionId,
      messages: chat.visibleMessages.filter(isConversationMessage).map(toAskApexMessage),
      streamingText: chat.streamingText,
      status: chatStatus,
      preparationMessage: chat.isPreparing ? chat.preparationMessage : null,
      notice: chat.isRetrying
        ? chat.retryReason
        : chatStalled
          ? RUN_STALLED_NOTICE
          : null,
      retryFailedRun:
        chat.retryableRunId && !chat.isInteractionBusy
          ? () => { void chat.retryFailedRun(); }
          : null,
      isConnected: chat.isConnected,
      startSession,
      sendMessage,
      closeSession,
    };
  }

  return {
    sessionId,
    messages,
    streamingText,
    status,
    preparationMessage:
      status === 'preparing'
        ? friendlyChatProgressLabel('Preparing project repository…', 'setup')
        : null,
    notice: null,
    retryFailedRun: null,
    isConnected,
    startSession,
    sendMessage,
    closeSession,
  };
}
