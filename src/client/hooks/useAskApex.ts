import { useState, useEffect, useRef, useCallback } from 'react';
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
      const { sessionId: sid } = await apiFetch<{ sessionId: string }>(
        '/api/ask-apex/sessions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      setSessionId(sid);
      setMessages([]);
      setStreamingText('');
      setStatus('idle');
      streamBufferRef.current = '';
      connectSse(sid);
      return sid;
    } catch (err) {
      console.error('[useAskApex] startSession error:', err);
      return null;
    }
  }, [connectSse]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return;
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
    [sessionId]
  );

  const closeSession = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    if (sessionId) {
      fetch(`/api/ask-apex/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => {});
    }
    setSessionId(null);
    setMessages([]);
    setStreamingText('');
    setStatus('idle');
    setIsConnected(false);
    streamBufferRef.current = '';
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, []);

  return {
    sessionId,
    messages,
    streamingText,
    status,
    preparationMessage:
      status === 'preparing' ? 'Preparing project repository…' : null,
    isConnected,
    startSession,
    sendMessage,
    closeSession,
  };
}
