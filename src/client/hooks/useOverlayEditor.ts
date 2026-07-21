import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverlayTextBox } from '../../shared/types/pdf';
import {
  MAX_SESSION_OVERLAYS,
  type OverlayBoxGeometry,
  defaultBoxAt,
  moveOverlayBox,
} from './overlayGeometry';

const MAX_UNDO_STEPS = 50;
const CREATE_LIMIT_MESSAGE =
  'This session already has 50 text boxes. Delete one before adding another.';

export type OverlayFormattingPatch = Partial<
  Pick<
    OverlayTextBox,
    | 'fontFamily'
    | 'fontSize'
    | 'bold'
    | 'italic'
    | 'color'
    | 'horizontalAlign'
    | 'verticalAlign'
    | 'opacity'
    | 'rotation'
    | 'listStyle'
    | 'linkUrl'
    | 'linkDisplayText'
  >
>;

export interface UseOverlayEditorOptions {
  /** Active Page Preview page id; null when no page is previewed. */
  pageId: string | null;
  /** Authoritative overlays from the session (hydrate when not dirty). */
  initialOverlays: OverlayTextBox[];
  /** Clears tab-local history when the active Assembly Session changes. */
  historyKey?: string | null;
}

interface UndoSnapshot {
  overlays: OverlayTextBox[];
  selectedOverlayId: string | null;
}

function makeOverlayId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneOverlays(overlays: OverlayTextBox[]): OverlayTextBox[] {
  return overlays.map((overlay) => ({ ...overlay }));
}

function maxZIndexForPage(overlays: OverlayTextBox[], pageId: string): number {
  let max = 0;
  for (const overlay of overlays) {
    if (overlay.pageId === pageId && overlay.zIndex > max) {
      max = overlay.zIndex;
    }
  }
  return max;
}

function createDefaultOverlay(
  pageId: string,
  xPct: number,
  yPct: number,
  overlays: OverlayTextBox[]
): OverlayTextBox {
  const geometry = defaultBoxAt(xPct, yPct);
  return {
    id: makeOverlayId(),
    pageId,
    ...geometry,
    text: 'Text',
    fontFamily: 'Helvetica',
    fontSize: 10,
    bold: false,
    italic: false,
    color: '#000000',
    horizontalAlign: 'left',
    verticalAlign: 'top',
    opacity: 100,
    rotation: 0,
    listStyle: 'none',
    linkUrl: null,
    linkDisplayText: null,
    zIndex: maxZIndexForPage(overlays, pageId) + 1,
  };
}

export function useOverlayEditor({
  pageId,
  initialOverlays,
  historyKey = null,
}: UseOverlayEditorOptions) {
  const [overlays, setOverlays] = useState<OverlayTextBox[]>(() =>
    cloneOverlays(initialOverlays)
  );
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(
    null
  );
  const [textToolActive, setTextToolActiveState] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [createLimitMessage, setCreateLimitMessage] = useState<string | null>(
    null
  );
  const [announcement, setAnnouncement] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const overlaysRef = useRef(overlays);
  const selectedRef = useRef(selectedOverlayId);
  const textToolActiveRef = useRef(textToolActive);
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  const geometryEditSnapshotRef = useRef<UndoSnapshot | null>(null);
  const textEditSnapshotRef = useRef<UndoSnapshot | null>(null);
  const lastHydratedKeyRef = useRef<string | null>(null);
  const historyKeyRef = useRef(historyKey);

  useEffect(() => {
    if (historyKeyRef.current === historyKey) return;
    historyKeyRef.current = historyKey;
    undoStackRef.current = [];
    redoStackRef.current = [];
    geometryEditSnapshotRef.current = null;
    textEditSnapshotRef.current = null;
    selectedRef.current = null;
    // Session identity is an external boundary: local history and selection
    // must reset before edits from the next session can be applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedOverlayId(null);
    setCanUndo(false);
    setCanRedo(false);
  }, [historyKey]);

  // Hydrate from server when not dirty (e.g. session load or orphan cleanup).
  useEffect(() => {
    if (isDirty) return;
    const hydrateKey = JSON.stringify(initialOverlays);
    if (lastHydratedKeyRef.current === hydrateKey) return;
    lastHydratedKeyRef.current = hydrateKey;
    overlaysRef.current = cloneOverlays(initialOverlays);
    setOverlays(overlaysRef.current);
  }, [initialOverlays, isDirty]);

  const pageIdsWithOverlays = useMemo(() => {
    const ids = new Set<string>();
    for (const overlay of overlays) {
      ids.add(overlay.pageId);
    }
    return ids;
  }, [overlays]);

  const pageOverlays = useMemo(() => {
    if (!pageId) return [];
    return overlays
      .filter((overlay) => overlay.pageId === pageId)
      .sort((a, b) => a.zIndex - b.zIndex);
  }, [overlays, pageId]);

  const selectedOverlay = useMemo(
    () => overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null,
    [overlays, selectedOverlayId]
  );

  const pushUndoSnapshot = useCallback(
    (next: UndoSnapshot, clearRedo = true) => {
      const stack = undoStackRef.current;
      undoStackRef.current =
        stack.length >= MAX_UNDO_STEPS
          ? [...stack.slice(stack.length - MAX_UNDO_STEPS + 1), next]
          : [...stack, next];
      setCanUndo(true);
      if (clearRedo) {
        redoStackRef.current = [];
        setCanRedo(false);
      }
    },
    []
  );

  const pushUndo = useCallback(() => {
    pushUndoSnapshot({
      overlays: cloneOverlays(overlaysRef.current),
      selectedOverlayId: selectedRef.current,
    });
  }, [pushUndoSnapshot]);

  const setTextToolActive = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const next =
        typeof value === 'function' ? value(textToolActiveRef.current) : value;
      textToolActiveRef.current = next;
      setTextToolActiveState(next);
    },
    []
  );

  const createAt = useCallback(
    (xPct: number, yPct: number): OverlayTextBox | null => {
      if (!textToolActiveRef.current || !pageId) return null;

      if (overlaysRef.current.length >= MAX_SESSION_OVERLAYS) {
        setCreateLimitMessage(CREATE_LIMIT_MESSAGE);
        setAnnouncement(CREATE_LIMIT_MESSAGE);
        return null;
      }

      setCreateLimitMessage(null);
      pushUndo();
      const next = createDefaultOverlay(
        pageId,
        xPct,
        yPct,
        overlaysRef.current
      );
      overlaysRef.current = [...overlaysRef.current, next];
      setOverlays(overlaysRef.current);
      selectedRef.current = next.id;
      setSelectedOverlayId(next.id);
      setIsDirty(true);
      setAnnouncement('Text box added');
      return next;
    },
    [pageId, pushUndo]
  );

  const deleteSelected = useCallback((): boolean => {
    const selectedId = selectedRef.current;
    if (!selectedId) return false;

    const exists = overlaysRef.current.some(
      (overlay) => overlay.id === selectedId
    );
    if (!exists) return false;

    pushUndo();
    textEditSnapshotRef.current = null;
    overlaysRef.current = overlaysRef.current.filter(
      (overlay) => overlay.id !== selectedId
    );
    setOverlays(overlaysRef.current);
    selectedRef.current = null;
    setSelectedOverlayId(null);
    setIsDirty(true);
    setCreateLimitMessage(null);
    setAnnouncement('Text box deleted');
    return true;
  }, [pushUndo]);

  const selectOverlay = useCallback((overlayId: string | null) => {
    selectedRef.current = overlayId;
    setSelectedOverlayId(overlayId);
    if (overlayId) setAnnouncement('Text box selected');
  }, []);

  const beginTextEdit = useCallback((overlayId: string): boolean => {
    if (
      selectedRef.current !== overlayId ||
      !overlaysRef.current.some((overlay) => overlay.id === overlayId)
    ) {
      return false;
    }
    textEditSnapshotRef.current = {
      overlays: cloneOverlays(overlaysRef.current),
      selectedOverlayId: selectedRef.current,
    };
    setAnnouncement('Editing text');
    return true;
  }, []);

  const updateSelectedText = useCallback((text: string): boolean => {
    const selectedId = selectedRef.current;
    const selected = overlaysRef.current.find(
      (overlay) => overlay.id === selectedId
    );
    if (!selected || !textEditSnapshotRef.current || selected.text === text) {
      return false;
    }

    overlaysRef.current = overlaysRef.current.map((overlay) =>
      overlay.id === selectedId ? { ...overlay, text } : overlay
    );
    setOverlays(overlaysRef.current);
    setIsDirty(true);
    return true;
  }, []);

  const commitTextEdit = useCallback((): boolean => {
    const snapshot = textEditSnapshotRef.current;
    textEditSnapshotRef.current = null;
    const selectedId = selectedRef.current;
    if (!snapshot || !selectedId) return false;

    const before = snapshot.overlays.find(
      (overlay) => overlay.id === selectedId
    );
    const after = overlaysRef.current.find(
      (overlay) => overlay.id === selectedId
    );
    if (!before || !after || before.text === after.text) {
      setAnnouncement('Editing finished');
      return false;
    }

    pushUndoSnapshot(snapshot);
    setAnnouncement('Editing finished');
    return true;
  }, [pushUndoSnapshot]);

  const beginGeometryEdit = useCallback((overlayId: string): boolean => {
    if (
      selectedRef.current !== overlayId ||
      !overlaysRef.current.some((overlay) => overlay.id === overlayId)
    ) {
      return false;
    }
    geometryEditSnapshotRef.current = {
      overlays: cloneOverlays(overlaysRef.current),
      selectedOverlayId: selectedRef.current,
    };
    return true;
  }, []);

  const updateSelectedGeometry = useCallback(
    (geometry: OverlayBoxGeometry): boolean => {
      const selectedId = selectedRef.current;
      if (!selectedId || !geometryEditSnapshotRef.current) return false;

      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId ? { ...overlay, ...geometry } : overlay
      );
      setOverlays(overlaysRef.current);
      return true;
    },
    []
  );

  const commitGeometryEdit = useCallback(
    (kind: 'move' | 'resize'): boolean => {
      const snapshot = geometryEditSnapshotRef.current;
      geometryEditSnapshotRef.current = null;
      const selectedId = selectedRef.current;
      if (!snapshot || !selectedId) return false;

      const before = snapshot.overlays.find(
        (overlay) => overlay.id === selectedId
      );
      const after = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (
        !before ||
        !after ||
        (before.x === after.x &&
          before.y === after.y &&
          before.width === after.width &&
          before.height === after.height)
      ) {
        return false;
      }

      pushUndoSnapshot(snapshot);
      setIsDirty(true);
      setAnnouncement(kind === 'move' ? 'Text box moved' : 'Text box resized');
      return true;
    },
    [pushUndoSnapshot]
  );

  const nudgeSelected = useCallback(
    (deltaXPct: number, deltaYPct: number): boolean => {
      const selectedId = selectedRef.current;
      const selected = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!selected) return false;

      const geometry = moveOverlayBox(selected, deltaXPct, deltaYPct);
      if (geometry.x === selected.x && geometry.y === selected.y) return false;

      pushUndo();
      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId ? { ...overlay, ...geometry } : overlay
      );
      setOverlays(overlaysRef.current);
      setIsDirty(true);
      setAnnouncement('Text box moved');
      return true;
    },
    [pushUndo]
  );

  const updateSelectedFormatting = useCallback(
    (patch: OverlayFormattingPatch): boolean => {
      const selectedId = selectedRef.current;
      const selected = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!selected) return false;

      const hasChange = Object.entries(patch).some(
        ([field, value]) => selected[field as keyof OverlayTextBox] !== value
      );
      if (!hasChange) return false;

      pushUndo();
      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId ? { ...overlay, ...patch } : overlay
      );
      setOverlays(overlaysRef.current);
      setIsDirty(true);
      setAnnouncement('Text formatting updated');
      return true;
    },
    [pushUndo]
  );

  const changeSelectedZOrder = useCallback(
    (direction: 'forward' | 'backward'): boolean => {
      const selectedId = selectedRef.current;
      const selected = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!selected) return false;

      const pageStack = overlaysRef.current
        .filter((overlay) => overlay.pageId === selected.pageId)
        .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
      const selectedIndex = pageStack.findIndex(
        (overlay) => overlay.id === selectedId
      );
      const neighborIndex =
        direction === 'forward' ? selectedIndex + 1 : selectedIndex - 1;
      const neighbor = pageStack[neighborIndex];
      if (!neighbor) {
        setAnnouncement(
          direction === 'forward' ? 'Already on top' : 'Already at bottom'
        );
        return false;
      }

      pushUndo();
      overlaysRef.current = overlaysRef.current.map((overlay) => {
        if (overlay.id === selected.id) {
          return { ...overlay, zIndex: neighbor.zIndex };
        }
        if (overlay.id === neighbor.id) {
          return { ...overlay, zIndex: selected.zIndex };
        }
        return overlay;
      });
      setOverlays(overlaysRef.current);
      setIsDirty(true);
      setAnnouncement(
        direction === 'forward' ? 'Moved forward' : 'Moved backward'
      );
      return true;
    },
    [pushUndo]
  );

  const undo = useCallback((): boolean => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return false;
    const snapshot = stack[stack.length - 1];
    redoStackRef.current = [
      ...redoStackRef.current.slice(-MAX_UNDO_STEPS + 1),
      {
        overlays: cloneOverlays(overlaysRef.current),
        selectedOverlayId: selectedRef.current,
      },
    ];
    undoStackRef.current = stack.slice(0, -1);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
    overlaysRef.current = cloneOverlays(snapshot.overlays);
    selectedRef.current = snapshot.selectedOverlayId;
    setOverlays(overlaysRef.current);
    setSelectedOverlayId(selectedRef.current);
    setIsDirty(true);
    setCreateLimitMessage(null);
    setAnnouncement('Undo');
    return true;
  }, []);

  const redo = useCallback((): boolean => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return false;
    const snapshot = stack[stack.length - 1];
    pushUndoSnapshot(
      {
        overlays: cloneOverlays(overlaysRef.current),
        selectedOverlayId: selectedRef.current,
      },
      false
    );
    redoStackRef.current = stack.slice(0, -1);
    setCanRedo(redoStackRef.current.length > 0);
    overlaysRef.current = cloneOverlays(snapshot.overlays);
    selectedRef.current = snapshot.selectedOverlayId;
    setOverlays(overlaysRef.current);
    setSelectedOverlayId(selectedRef.current);
    setIsDirty(true);
    setCreateLimitMessage(null);
    setAnnouncement('Redo');
    return true;
  }, [pushUndoSnapshot]);

  const clearDirty = useCallback(() => {
    setIsDirty(false);
  }, []);

  const markCleanWithOverlays = useCallback((next: OverlayTextBox[]) => {
    lastHydratedKeyRef.current = JSON.stringify(next);
    overlaysRef.current = cloneOverlays(next);
    setOverlays(overlaysRef.current);
    setIsDirty(false);
  }, []);

  const replaceFromServer = useCallback((next: OverlayTextBox[]) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    geometryEditSnapshotRef.current = null;
    textEditSnapshotRef.current = null;
    selectedRef.current = null;
    // Prevent the dirty -> clean transition from re-applying stale props
    // before the session query publishes the authoritative response.
    lastHydratedKeyRef.current = JSON.stringify(initialOverlays);
    overlaysRef.current = cloneOverlays(next);
    setOverlays(overlaysRef.current);
    setSelectedOverlayId(null);
    setIsDirty(false);
    setCanUndo(false);
    setCanRedo(false);
    setCreateLimitMessage(null);
    setAnnouncement('Text overlays updated from another tab');
  }, [initialOverlays]);

  return {
    overlays,
    pageOverlays,
    selectedOverlay,
    selectedOverlayId,
    textToolActive,
    setTextToolActive,
    isDirty,
    createLimitMessage,
    announcement,
    pageIdsWithOverlays,
    canUndo,
    canRedo,
    createAt,
    deleteSelected,
    selectOverlay,
    beginTextEdit,
    updateSelectedText,
    commitTextEdit,
    beginGeometryEdit,
    updateSelectedGeometry,
    commitGeometryEdit,
    nudgeSelected,
    updateSelectedFormatting,
    bringSelectedForward: () => changeSelectedZOrder('forward'),
    sendSelectedBackward: () => changeSelectedZOrder('backward'),
    undo,
    redo,
    clearDirty,
    markCleanWithOverlays,
    replaceFromServer,
  };
}
