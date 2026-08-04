import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverlayTextBox } from '../../shared/types/pdf';

const CHANNEL_PREFIX = 'pdf-overlays:';
const STORAGE_PREFIX = 'pdf-overlays-sync:';

interface OverlayTabMessage {
  type: 'overlays-saved';
  tabId: string;
  updatedAt: string;
}

export interface AuthoritativeOverlayState {
  overlays: OverlayTextBox[];
  updatedAt: string;
}

interface UseOverlayMultiTabSyncOptions {
  sessionId: string | null;
  initialUpdatedAt?: string | null;
  currentOverlays: OverlayTextBox[];
  hasLocalChanges?: boolean;
  loadAuthoritativeState: () => Promise<AuthoritativeOverlayState>;
  onAuthoritativeState: (state: AuthoritativeOverlayState) => void;
}

function makeTabId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isNewer(candidate: string, baseline: string | null): boolean {
  if (!baseline) return true;
  const candidateTime = Date.parse(candidate);
  const baselineTime = Date.parse(baseline);
  if (!Number.isNaN(candidateTime) && !Number.isNaN(baselineTime)) {
    return candidateTime > baselineTime;
  }
  return candidate > baseline;
}

function isOverlayTabMessage(value: unknown): value is OverlayTabMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<OverlayTabMessage>;
  return (
    message.type === 'overlays-saved' &&
    typeof message.tabId === 'string' &&
    typeof message.updatedAt === 'string'
  );
}

export function useOverlayMultiTabSync({
  sessionId,
  initialUpdatedAt = null,
  currentOverlays,
  hasLocalChanges = false,
  loadAuthoritativeState,
  onAuthoritativeState,
}: UseOverlayMultiTabSyncOptions) {
  const tabIdRef = useRef(makeTabId());
  const sessionIdRef = useRef(sessionId);
  const baseUpdatedAtRef = useRef<string | null>(initialUpdatedAt);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const usesStorageFallbackRef = useRef(false);
  const reloadPromiseRef = useRef<Promise<void> | null>(null);
  const loadStateRef = useRef(loadAuthoritativeState);
  const applyStateRef = useRef(onAuthoritativeState);
  const currentOverlaysRef = useRef(currentOverlays);
  const hasLocalChangesRef = useRef(hasLocalChanges);
  const [conflictVisible, setConflictVisible] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    loadStateRef.current = loadAuthoritativeState;
    applyStateRef.current = onAuthoritativeState;
    currentOverlaysRef.current = currentOverlays;
    hasLocalChangesRef.current = hasLocalChanges;
  }, [
    currentOverlays,
    hasLocalChanges,
    loadAuthoritativeState,
    onAuthoritativeState,
  ]);

  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      sessionIdRef.current = sessionId;
      baseUpdatedAtRef.current = initialUpdatedAt;
      reloadPromiseRef.current = null;
      setConflictVisible(false);
      setIsReloading(false);
      setErrorMessage(null);
      return;
    }
    if (!baseUpdatedAtRef.current && initialUpdatedAt) {
      baseUpdatedAtRef.current = initialUpdatedAt;
    }
  }, [initialUpdatedAt, sessionId]);

  const reloadIfNewer = useCallback(
    (expectedUpdatedAt?: string, force = false): Promise<void> => {
      if (!sessionIdRef.current) return Promise.resolve();
      if (
        !force &&
        expectedUpdatedAt &&
        !isNewer(expectedUpdatedAt, baseUpdatedAtRef.current)
      ) {
        return Promise.resolve();
      }
      if (reloadPromiseRef.current) return reloadPromiseRef.current;

      const announceReload = Boolean(expectedUpdatedAt) || force;
      if (announceReload) {
        setIsReloading(true);
        setErrorMessage(null);
      }
      const baseline = baseUpdatedAtRef.current;
      const promise = loadStateRef
        .current()
        .then((state) => {
          if (!force && !isNewer(state.updatedAt, baseline)) return;
          baseUpdatedAtRef.current = state.updatedAt;
          if (
            JSON.stringify(state.overlays) ===
            JSON.stringify(currentOverlaysRef.current)
          ) {
            return;
          }
          applyStateRef.current(state);
          setConflictVisible(true);
        })
        .catch((error) => {
          if (!announceReload) return;
          setConflictVisible(true);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Could not reload the current text overlays.'
          );
        })
        .finally(() => {
          if (announceReload) setIsReloading(false);
          reloadPromiseRef.current = null;
        });
      reloadPromiseRef.current = promise;
      return promise;
    },
    []
  );

  const handleForeignMessage = useCallback(
    (message: OverlayTabMessage) => {
      if (message.tabId === tabIdRef.current) return;
      void reloadIfNewer(message.updatedAt);
    },
    [reloadIfNewer]
  );

  useEffect(() => {
    if (!sessionId || typeof window === 'undefined') return;

    const channelName = `${CHANNEL_PREFIX}${sessionId}`;
    const storageKey = `${STORAGE_PREFIX}${sessionId}`;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) return;
      try {
        const message = JSON.parse(event.newValue);
        if (isOverlayTabMessage(message)) handleForeignMessage(message);
      } catch {
        // Ignore malformed or unrelated storage events.
      }
    };

    if (typeof globalThis.BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(channelName);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (isOverlayTabMessage(event.data)) handleForeignMessage(event.data);
      };
      channelRef.current = channel;
      usesStorageFallbackRef.current = false;
    } else {
      window.addEventListener('storage', handleStorage);
      usesStorageFallbackRef.current = true;
    }

    return () => {
      channelRef.current?.close();
      channelRef.current = null;
      window.removeEventListener('storage', handleStorage);
      usesStorageFallbackRef.current = false;
    };
  }, [handleForeignMessage, sessionId]);

  useEffect(() => {
    if (!sessionId || typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        !hasLocalChangesRef.current
      ) {
        void reloadIfNewer();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [reloadIfNewer, sessionId]);

  const onLocalSave = useCallback(
    (updatedAt: string): boolean => {
      if (!sessionIdRef.current) return true;
      if (
        baseUpdatedAtRef.current &&
        isNewer(baseUpdatedAtRef.current, updatedAt)
      ) {
        void reloadIfNewer(baseUpdatedAtRef.current ?? undefined, true);
        return false;
      }
      baseUpdatedAtRef.current = updatedAt;
      const message: OverlayTabMessage = {
        type: 'overlays-saved',
        tabId: tabIdRef.current,
        updatedAt,
      };
      if (usesStorageFallbackRef.current) {
        try {
          localStorage.setItem(
            `${STORAGE_PREFIX}${sessionIdRef.current}`,
            JSON.stringify(message)
          );
        } catch {
          // Persistence can be unavailable in privacy modes; saving still won.
        }
      } else {
        channelRef.current?.postMessage(message);
      }
      return true;
    },
    [reloadIfNewer]
  );

  const acknowledge = useCallback(() => {
    if (isReloading || errorMessage) return;
    setConflictVisible(false);
  }, [errorMessage, isReloading]);

  const retry = useCallback(
    () => reloadIfNewer(undefined, true),
    [reloadIfNewer]
  );

  return {
    conflictVisible,
    isReloading,
    errorMessage,
    onLocalSave,
    acknowledge,
    retry,
  };
}
