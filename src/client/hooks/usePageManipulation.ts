import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useUpdateManifest } from './usePdfSession';
import type { PageManifestEntry } from '../../shared/types/pdf';

interface UsePageManipulationArgs {
  sessionId: string;
  serverManifest: PageManifestEntry[];
}

interface UndoState {
  manifest: PageManifestEntry[];
  deletedCount: number;
}

interface UndoReorderState {
  manifest: PageManifestEntry[];
  movedPageId: string;
}

function manifestsEqual(a: PageManifestEntry[], b: PageManifestEntry[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].pageId !== b[i].pageId ||
      a[i].rotation !== b[i].rotation ||
      a[i].deleted !== b[i].deleted
    ) return true;
  }
  return false;
}

/**
 * Keep local order/edits for pages that still exist on the server, drop removed
 * pages, and append any newly uploaded pages at the end.
 */
function mergeServerIntoLocal(
  local: PageManifestEntry[],
  server: PageManifestEntry[],
): PageManifestEntry[] {
  const serverIds = new Set(server.map((p) => p.pageId));
  const localIds = new Set(local.map((p) => p.pageId));

  const kept = local.filter((p) => serverIds.has(p.pageId));
  const added = server.filter((p) => !localIds.has(p.pageId));

  return [...kept, ...added];
}

export function usePageManipulation({ sessionId, serverManifest }: UsePageManipulationArgs) {
  const [localManifest, setLocalManifest] = useState<PageManifestEntry[]>(serverManifest);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [undoReorderState, setUndoReorderState] = useState<UndoReorderState | null>(null);
  const [lastSynced, setLastSynced] = useState<PageManifestEntry[]>(serverManifest);
  const [reorderSyncError, setReorderSyncError] = useState<string | null>(null);
  const lastSyncedRef = useRef<PageManifestEntry[]>(serverManifest);
  const localManifestRef = useRef<PageManifestEntry[]>(serverManifest);
  const { mutate, mutateAsync } = useUpdateManifest();

  localManifestRef.current = localManifest;

  useEffect(() => {
    const prevLocal = localManifestRef.current;
    const prevSynced = lastSyncedRef.current;
    const hasLocalEdits = manifestsEqual(prevLocal, prevSynced);

    // No unsaved edits — take the server manifest as-is (refresh / post-save).
    if (!hasLocalEdits) {
      setLocalManifest(serverManifest);
      setLastSynced(serverManifest);
      lastSyncedRef.current = serverManifest;
      return;
    }

    // Preserve local reorder/rotations/deletes; append newly uploaded pages.
    const mergedLocal = mergeServerIntoLocal(prevLocal, serverManifest);
    const mergedSynced = mergeServerIntoLocal(prevSynced, serverManifest);
    setLocalManifest(mergedLocal);
    setLastSynced(mergedSynced);
    lastSyncedRef.current = mergedSynced;
  }, [serverManifest]);

  const hasUnsavedChanges = useMemo(
    () => manifestsEqual(localManifest, lastSynced),
    [localManifest, lastSynced],
  );

  const saveNow = useCallback(() => {
    mutate({ sessionId, manifest: localManifest });
    setLastSynced(localManifest);
    lastSyncedRef.current = localManifest;
    setUndoReorderState(null);
  }, [sessionId, mutate, localManifest]);

  /** Persist local manifest and wait for the server before continuing (e.g. export). */
  const saveNowAsync = useCallback(async () => {
    await mutateAsync({ sessionId, manifest: localManifest });
    setLastSynced(localManifest);
    lastSyncedRef.current = localManifest;
    setUndoReorderState(null);
  }, [sessionId, mutateAsync, localManifest]);

  const visiblePages = useMemo(
    () => localManifest.filter((p) => !p.deleted),
    [localManifest],
  );

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;

      const snapshot = localManifest;

      setLocalManifest((prev) => {
        const visible = prev.filter((p) => !p.deleted);
        const deleted = prev.filter((p) => p.deleted);

        const movedPage = visible[fromIndex];
        const [moved] = visible.splice(fromIndex, 1);
        visible.splice(toIndex, 0, moved);

        setUndoReorderState({ manifest: snapshot, movedPageId: movedPage?.pageId ?? '' });

        return [...visible, ...deleted];
      });
    },
    [localManifest],
  );

  const reorderAndSync = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;

      setReorderSyncError(null);

      const prev = localManifest;
      const visible = prev.filter((p) => !p.deleted);
      const deleted = prev.filter((p) => p.deleted);
      const [moved] = visible.splice(fromIndex, 1);
      visible.splice(toIndex, 0, moved);
      const newManifest = [...visible, ...deleted];

      setLocalManifest(newManifest);

      mutate(
        { sessionId, manifest: newManifest },
        {
          onSuccess: () => {
            setLastSynced(newManifest);
            lastSyncedRef.current = newManifest;
          },
          onError: () => {
            setLocalManifest(lastSyncedRef.current);
            setReorderSyncError('Failed to save page order. Reverted to last saved state.');
          },
        },
      );
    },
    [localManifest, sessionId, mutate],
  );

  const dismissReorderSyncError = useCallback(() => {
    setReorderSyncError(null);
  }, []);

  const rotate = useCallback(
    (selectedPageIds: Set<string>) => {
      setLocalManifest((prev) =>
        prev.map((p) => {
          if (!selectedPageIds.has(p.pageId)) return p;
          const newRotation = ((p.rotation + 90) % 360) as 0 | 90 | 180 | 270;
          return { ...p, rotation: newRotation };
        }),
      );
    },
    [],
  );

  const deletePages = useCallback(
    (selectedPageIds: Set<string>): { blocked: boolean; message?: string } => {
      const currentVisible = localManifest.filter((p) => !p.deleted);
      const remainingAfter = currentVisible.filter((p) => !selectedPageIds.has(p.pageId));

      if (remainingAfter.length === 0) {
        return {
          blocked: true,
          message: 'At least one page must remain in the document.',
        };
      }

      const snapshot = localManifest;
      const deletedCount = currentVisible.length - remainingAfter.length;

      setUndoState({ manifest: snapshot, deletedCount });

      const next = localManifest.map((p) => {
        if (selectedPageIds.has(p.pageId)) return { ...p, deleted: true };
        return p;
      });
      setLocalManifest(next);

      return { blocked: false };
    },
    [localManifest],
  );

  const undoDelete = useCallback(() => {
    if (!undoState) return;
    setLocalManifest(undoState.manifest);
    setUndoState(null);
  }, [undoState]);

  const undoReorder = useCallback(() => {
    if (!undoReorderState) return;
    setLocalManifest(undoReorderState.manifest);
    setUndoReorderState(null);
  }, [undoReorderState]);

  const dismissReorderUndo = useCallback(() => {
    setUndoReorderState(null);
  }, []);

  const syncDelete = useCallback(
    (manifest: PageManifestEntry[]) => {
      mutate({ sessionId, manifest });
      setLastSynced(manifest);
    },
    [sessionId, mutate],
  );

  const addToAssemblyAt = useCallback(
    (pageId: string, insertIndex: number) => {
      setLocalManifest((prev) => {
        const page = prev.find((p) => p.pageId === pageId);
        if (!page || !page.deleted) return prev;

        const without = prev.filter((p) => p.pageId !== pageId);
        const visible = without.filter((p) => !p.deleted);
        const deleted = without.filter((p) => p.deleted);

        const restored = { ...page, deleted: false };
        const clampedIndex = Math.min(insertIndex, visible.length);
        visible.splice(clampedIndex, 0, restored);

        return [...visible, ...deleted];
      });
    },
    [],
  );

  const togglePageInAssembly = useCallback(
    (pageId: string) => {
      setLocalManifest((prev) =>
        prev.map((p) =>
          p.pageId === pageId ? { ...p, deleted: !p.deleted } : p,
        ),
      );
    },
    [],
  );

  return {
    localManifest,
    visiblePages,
    reorder,
    reorderAndSync,
    dismissReorderSyncError,
    reorderSyncError,
    rotate,
    deletePages,
    undoDelete,
    undoState,
    undoReorder,
    undoReorderState,
    dismissReorderUndo,
    hasUnsavedChanges,
    saveNow,
    saveNowAsync,
    syncDelete,
    togglePageInAssembly,
    addToAssemblyAt,
  };
}
