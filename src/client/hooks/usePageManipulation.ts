import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateManifest } from './usePdfSession';
import type { PageManifestEntry } from '../../shared/types/pdf';

const DEBOUNCE_MS = 500;
const UNDO_TIMEOUT_MS = 8000;

interface UsePageManipulationOptions {
  sessionId: string | null;
  serverManifest: PageManifestEntry[];
}

interface DeleteUndoState {
  previousManifest: PageManifestEntry[];
  deletedCount: number;
  timerId: number | null;
}

export function usePageManipulation({ sessionId, serverManifest }: UsePageManipulationOptions) {
  const [localManifest, setLocalManifest] = useState<PageManifestEntry[]>(serverManifest);
  const [undoState, setUndoState] = useState<DeleteUndoState | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const updateManifest = useUpdateManifest();
  const queryClient = useQueryClient();
  const debounceRef = useRef<number | null>(null);
  const latestManifestRef = useRef<PageManifestEntry[]>(localManifest);

  useEffect(() => {
    latestManifestRef.current = localManifest;
  }, [localManifest]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!undoState) {
      setLocalManifest(serverManifest);
    }
  }, [serverManifest]);

  const scheduleSync = useCallback((manifest: PageManifestEntry[]) => {
    if (!sessionId) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      updateManifest.mutate(
        { sessionId, manifest },
        {
          onError: (err) => {
            setSyncError(err.message || 'Failed to sync changes');
            queryClient.invalidateQueries({ queryKey: ['pdf-session', sessionId] });
          },
          onSuccess: () => {
            setSyncError(null);
          },
        },
      );
    }, DEBOUNCE_MS);
  }, [sessionId, updateManifest, queryClient]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (debounceRef.current !== null && sessionId) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        const body = JSON.stringify({ manifest: latestManifestRef.current });
        navigator.sendBeacon(
          `/api/pdf/sessions/${sessionId}/manifest`,
          new Blob([body], { type: 'application/json' }),
        );
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [sessionId]);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    setLocalManifest((prev) => {
      const visibleIndices: number[] = [];
      prev.forEach((entry, i) => {
        if (!entry.deleted) visibleIndices.push(i);
      });

      if (fromIndex < 0 || fromIndex >= visibleIndices.length) return prev;
      if (toIndex < 0 || toIndex >= visibleIndices.length) return prev;
      if (fromIndex === toIndex) return prev;

      const next = [...prev];
      const actualFrom = visibleIndices[fromIndex];
      const actualTo = visibleIndices[toIndex];
      const [moved] = next.splice(actualFrom, 1);
      const adjustedTo = actualTo > actualFrom ? actualTo - 1 : actualTo;
      next.splice(adjustedTo, 0, moved);

      scheduleSync(next);
      return next;
    });
  }, [scheduleSync]);

  const rotate = useCallback((pageIds: Set<string>) => {
    if (pageIds.size === 0) return;
    setLocalManifest((prev) => {
      const next = prev.map((entry) => {
        if (pageIds.has(entry.pageId)) {
          return {
            ...entry,
            rotation: ((entry.rotation + 90) % 360) as 0 | 90 | 180 | 270,
          };
        }
        return entry;
      });
      scheduleSync(next);
      return next;
    });
  }, [scheduleSync]);

  const deletePages = useCallback((pageIds: Set<string>): { blocked: boolean; message?: string } => {
    const currentNonDeleted = localManifest.filter((p) => !p.deleted);
    const remainingAfterDelete = currentNonDeleted.filter((p) => !pageIds.has(p.pageId));

    if (remainingAfterDelete.length === 0) {
      return { blocked: true, message: 'At least one page must remain for export.' };
    }

    const snapshot = [...localManifest];

    const next = localManifest.map((entry) => {
      if (pageIds.has(entry.pageId)) {
        return { ...entry, deleted: true };
      }
      return entry;
    });

    setLocalManifest(next);

    if (undoState?.timerId !== null && undoState?.timerId !== undefined) {
      window.clearTimeout(undoState.timerId);
    }

    const timerId = window.setTimeout(() => {
      setUndoState(null);
      scheduleSync(next);
    }, UNDO_TIMEOUT_MS);

    setUndoState({
      previousManifest: snapshot,
      deletedCount: pageIds.size,
      timerId,
    });

    return { blocked: false };
  }, [localManifest, undoState, scheduleSync]);

  const undoDelete = useCallback(() => {
    if (!undoState) return;
    if (undoState.timerId !== null) {
      window.clearTimeout(undoState.timerId);
    }
    setLocalManifest(undoState.previousManifest);
    setUndoState(null);
  }, [undoState]);

  const dismissUndo = useCallback(() => {
    if (!undoState) return;
    if (undoState.timerId !== null) {
      window.clearTimeout(undoState.timerId);
    }
    setUndoState(null);
    scheduleSync(localManifest);
  }, [undoState, localManifest, scheduleSync]);

  const visiblePages = localManifest.filter((p) => !p.deleted);

  return {
    localManifest,
    visiblePages,
    reorder,
    rotate,
    deletePages,
    undoDelete,
    dismissUndo,
    undoState,
    syncError,
    dismissSyncError: () => setSyncError(null),
  };
}
