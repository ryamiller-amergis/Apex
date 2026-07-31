import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverlayTextBox } from '../../shared/types/pdf';
import { useUpdateOverlays } from './usePdfSession';

export const OVERLAY_AUTOSAVE_DELAY_MS = 500;

export type OverlaySaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface UseOverlayAutosaveOptions {
  sessionId: string | null;
  userId?: string;
  overlays: OverlayTextBox[];
  isDirty: boolean;
  blocked?: boolean;
  onSaved: (overlays: OverlayTextBox[]) => void;
  onSaveSuccess?: (updatedAt: string) => boolean;
}

export function useOverlayAutosave({
  sessionId,
  userId = '',
  overlays,
  isDirty,
  blocked = false,
  onSaved,
  onSaveSuccess,
}: UseOverlayAutosaveOptions) {
  const updateOverlays = useUpdateOverlays(userId);
  const overlaysKey = JSON.stringify(overlays);
  const [saveState, setSaveState] = useState<{
    sessionId: string | null;
    status: Exclude<OverlaySaveStatus, 'dirty'>;
    errorMessage: string | null;
    syncedKey: string | null;
  }>({
    sessionId,
    status: 'idle',
    errorMessage: null,
    syncedKey: null,
  });
  const timerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const latestRef = useRef(overlays);
  const latestKeyRef = useRef(JSON.stringify(overlays));
  const dirtyRef = useRef(isDirty);
  const blockedRef = useRef(blocked);
  const sessionIdRef = useRef(sessionId);
  const onSavedRef = useRef(onSaved);
  const onSaveSuccessRef = useRef(onSaveSuccess);
  const mutateAsyncRef = useRef(updateOverlays.mutateAsync);

  useEffect(() => {
    latestRef.current = overlays;
    latestKeyRef.current = overlaysKey;
    dirtyRef.current = isDirty;
    blockedRef.current = blocked;
    sessionIdRef.current = sessionId;
    onSavedRef.current = onSaved;
    onSaveSuccessRef.current = onSaveSuccess;
    mutateAsyncRef.current = updateOverlays.mutateAsync;
  }, [
    blocked,
    isDirty,
    onSaved,
    onSaveSuccess,
    overlays,
    overlaysKey,
    sessionId,
    updateOverlays.mutateAsync,
  ]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushNow = useCallback((): Promise<void> => {
    clearTimer();

    if (flushPromiseRef.current) {
      return flushPromiseRef.current;
    }

    const run = async () => {
      while (dirtyRef.current) {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) return;
        if (blockedRef.current) {
          const error = new Error(
            'Fix the overlay formatting error before saving.'
          );
          setSaveState({
            sessionId: activeSessionId,
            status: 'error',
            errorMessage: error.message,
            syncedKey: null,
          });
          throw error;
        }

        const sentOverlays = latestRef.current.map((overlay) => ({
          ...overlay,
        }));
        const sentKey = latestKeyRef.current;
        setSaveState({
          sessionId: activeSessionId,
          status: 'saving',
          errorMessage: null,
          syncedKey: null,
        });

        try {
          const result = await mutateAsyncRef.current({
            sessionId: activeSessionId,
            overlays: sentOverlays,
          });

          // A session switch makes the completed response irrelevant. Continue
          // the loop so a waiting flush can save the new session if needed.
          if (sessionIdRef.current !== activeSessionId) continue;

          const accepted =
            onSaveSuccessRef.current?.(result.updatedAt) !== false;
          if (!accepted) {
            // A newer cross-tab write is already known. Do not re-apply this
            // delayed response; the conflict sync owns the authoritative reload.
            dirtyRef.current = false;
            setSaveState({
              sessionId: activeSessionId,
              status: 'idle',
              errorMessage: null,
              syncedKey: null,
            });
            return;
          }
          if (latestKeyRef.current === sentKey) {
            dirtyRef.current = false;
            onSavedRef.current(result.overlays);
            setSaveState({
              sessionId: activeSessionId,
              status: 'saved',
              errorMessage: null,
              syncedKey: sentKey,
            });
            return;
          }
          // The user edited while this request was in flight. Persist the
          // newest full list before resolving (important for Export).
        } catch (error) {
          setSaveState({
            sessionId: activeSessionId,
            status: 'error',
            errorMessage:
              error instanceof Error ? error.message : 'Overlay save failed.',
            syncedKey: null,
          });
          throw error;
        }
      }
    };

    const promise = run().finally(() => {
      if (flushPromiseRef.current === promise) {
        flushPromiseRef.current = null;
      }
    });
    flushPromiseRef.current = promise;
    return promise;
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!isDirty) return;

    if (!sessionId || blocked) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushNow().catch(() => {
        // Status and local dirty state are retained for retry.
      });
    }, OVERLAY_AUTOSAVE_DELAY_MS);

    return clearTimer;
  }, [blocked, clearTimer, flushNow, isDirty, overlaysKey, sessionId]);

  useEffect(() => clearTimer, [clearTimer]);

  const stateForSession =
    saveState.sessionId === sessionId
      ? saveState
      : { status: 'idle' as const, errorMessage: null, syncedKey: null };
  const status: OverlaySaveStatus =
    isDirty &&
    stateForSession.syncedKey !== overlaysKey &&
    (stateForSession.status === 'idle' || stateForSession.status === 'saved')
      ? 'dirty'
      : stateForSession.status;

  return {
    status,
    errorMessage: stateForSession.errorMessage,
    flushNow,
    retry: flushNow,
  };
}
