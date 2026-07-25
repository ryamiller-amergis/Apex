import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStream } from './useChatStream';
import type {
  DesignModuleScopingRequest,
  DesignModuleScopingResult,
  DesignModuleScopingResultResponse,
  DesignModuleScopingStartResponse,
} from '../../shared/types/designModuleScoping';

export type DesignModuleScopingStatus =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface UseDesignModuleScopingResult {
  start: (input: Omit<DesignModuleScopingRequest, 'project'>) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  status: DesignModuleScopingStatus;
  threadId: string | null;
  streamingText: string;
  progressLabel: string | null;
  result: DesignModuleScopingResult | null;
  error: string | null;
  isScoping: boolean;
}

const POLL_INTERVAL_MS = 1500;

function scopingUrl(suffix = ''): string {
  return `/api/design-modules/scoping${suffix}`;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed: ${res.status}`;
  } catch {
    return `Request failed: ${res.status}`;
  }
}

export function useDesignModuleScoping(
  projectId: string | null
): UseDesignModuleScopingResult {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [status, setStatus] = useState<DesignModuleScopingStatus>('idle');
  const [result, setResult] = useState<DesignModuleScopingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const chatStream = useChatStream(status === 'pending' ? threadId : null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchResult = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(
          scopingUrl(`/${encodeURIComponent(id)}/result`),
          { credentials: 'include' }
        );
        if (!res.ok) {
          const message = await parseErrorBody(res);
          clearPoll();
          setStatus('failed');
          setError(message);
          return;
        }
        const data = (await res.json()) as DesignModuleScopingResultResponse;
        if (data.status === 'ready' && data.result) {
          clearPoll();
          setResult(data.result);
          setStatus('ready');
        } else if (data.status === 'failed') {
          clearPoll();
          setError(data.error ?? 'Scoping failed.');
          setStatus('failed');
        } else if (data.status === 'cancelled') {
          clearPoll();
          setStatus('cancelled');
        }
      } catch {
        // Transient network hiccup — retry on next poll tick.
      }
    },
    [clearPoll]
  );

  const start = useCallback(
    async (input: Omit<DesignModuleScopingRequest, 'project'>) => {
      if (!projectId) return;
      clearPoll();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setResult(null);
      setError(null);
      setStatus('starting');

      const body: DesignModuleScopingRequest = {
        ...input,
        project: projectId,
        threadId: input.threadId ?? threadIdRef.current ?? undefined,
      };

      try {
        const res = await fetch(scopingUrl(), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const message = await parseErrorBody(res);
          setStatus('failed');
          setError(message);
          return;
        }
        const data = (await res.json()) as DesignModuleScopingStartResponse;
        setThreadId(data.threadId);
        setStatus('pending');
        pollTimerRef.current = window.setInterval(() => {
          void fetchResult(data.threadId);
        }, POLL_INTERVAL_MS);
        void fetchResult(data.threadId);
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus('failed');
        setError(
          err instanceof Error ? err.message : 'Failed to start scoping.'
        );
      }
    },
    [projectId, clearPoll, fetchResult]
  );

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    clearPoll();
    const idToCancel = threadId;
    if (!idToCancel) {
      setStatus('cancelled');
      return;
    }
    try {
      await fetch(scopingUrl(`/${encodeURIComponent(idToCancel)}/cancel`), {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best-effort — still reflect cancellation locally.
    }
    setStatus('cancelled');
  }, [threadId, clearPoll]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    clearPoll();
    setThreadId(null);
    setStatus('idle');
    setResult(null);
    setError(null);
  }, [clearPoll]);

  useEffect(() => {
    if (
      chatStream.status === 'error' &&
      statusRef.current === 'pending' &&
      threadId
    ) {
      void fetchResult(threadId);
    }
  }, [chatStream.status, threadId, fetchResult]);

  useEffect(
    () => () => {
      clearPoll();
      abortRef.current?.abort();
    },
    [clearPoll]
  );

  return {
    start,
    cancel,
    reset,
    status,
    threadId,
    streamingText: chatStream.streamingText,
    progressLabel: chatStream.progressLabel,
    result,
    error,
    isScoping: status === 'starting' || status === 'pending',
  };
}
