import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverlayTextBox } from '../../shared/types/pdf';
import type { NativePdfTextItem } from '../utils/pdfNativeTextItems';
import {
  MAX_SESSION_OVERLAYS,
  type OverlayBoxGeometry,
  defaultBoxAt,
  moveOverlayBox,
} from './overlayGeometry';
import { fitReplacementGeometry } from '../utils/fitReplacementGeometry';

const MAX_UNDO_STEPS = 50;
const CREATE_LIMIT_MESSAGE =
  'This session already has 50 text boxes. Delete one before adding another.';

export type OverlayEditorMode = 'add' | 'replace';

export interface ReplacementDraft {
  item: NativePdfTextItem;
  text: string;
  fontFamily: OverlayTextBox['fontFamily'];
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  backgroundColor: string;
  rotation: number;
}

export type OverlayFormattingPatch = Partial<
  Pick<
    OverlayTextBox,
    | 'fontFamily'
    | 'fontSize'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'color'
    | 'horizontalAlign'
    | 'verticalAlign'
    | 'opacity'
    | 'rotation'
    | 'listStyle'
    | 'linkUrl'
    | 'linkDisplayText'
    | 'backgroundColor'
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

function sameGeometryAndBackground(
  before: OverlayTextBox,
  after: OverlayTextBox
): boolean {
  return (
    before.x === after.x &&
    before.y === after.y &&
    before.width === after.width &&
    before.height === after.height &&
    before.backgroundColor === after.backgroundColor
  );
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
  const [editorMode, setEditorModeState] = useState<OverlayEditorMode>('add');
  const [isDirty, setIsDirty] = useState(false);
  const [createLimitMessage, setCreateLimitMessage] = useState<string | null>(
    null
  );
  const [announcement, setAnnouncement] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [replacementDraft, setReplacementDraftState] =
    useState<ReplacementDraft | null>(null);

  const overlaysRef = useRef(overlays);
  const selectedRef = useRef(selectedOverlayId);
  const textToolActiveRef = useRef(textToolActive);
  const editorModeRef = useRef(editorMode);
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  const geometryEditSnapshotRef = useRef<UndoSnapshot | null>(null);
  const textEditSnapshotRef = useRef<UndoSnapshot | null>(null);
  const replacementActivationEditIdRef = useRef<string | null>(null);
  const replacementDraftRef = useRef<ReplacementDraft | null>(replacementDraft);
  const lastHydratedKeyRef = useRef<string | null>(null);
  const historyKeyRef = useRef(historyKey);

  useEffect(() => {
    if (historyKeyRef.current === historyKey) return;
    historyKeyRef.current = historyKey;
    undoStackRef.current = [];
    redoStackRef.current = [];
    geometryEditSnapshotRef.current = null;
    textEditSnapshotRef.current = null;
    replacementActivationEditIdRef.current = null;
    selectedRef.current = null;
    replacementDraftRef.current = null;
    // Session identity is an external boundary: local history and selection
    // must reset before edits from the next session can be applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedOverlayId(null);
    setReplacementDraftState(null);
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

  const selectedDisplayOverlay = useMemo<OverlayTextBox | null>(() => {
    if (replacementDraft && pageId) {
      return {
        id: `replacement-draft:${replacementDraft.item.id}`,
        pageId,
        ...replacementDraft.item.geometry,
        text: replacementDraft.text,
        fontFamily: replacementDraft.fontFamily,
        fontSize: replacementDraft.fontSize,
        bold: replacementDraft.bold,
        italic: replacementDraft.italic,
        color: replacementDraft.color,
        horizontalAlign: 'left',
        verticalAlign: 'top',
        opacity: 100,
        rotation: replacementDraft.rotation,
        listStyle: 'none',
        linkUrl: null,
        linkDisplayText: null,
        zIndex: maxZIndexForPage(overlays, pageId) + 1,
        kind: 'replace',
        backgroundColor: replacementDraft.backgroundColor,
        coverActive: false,
      };
    }
    return selectedOverlay;
  }, [overlays, pageId, replacementDraft, selectedOverlay]);

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
      if (next && editorModeRef.current === 'replace') {
        editorModeRef.current = 'add';
        setEditorModeState('add');
        replacementDraftRef.current = null;
        setReplacementDraftState(null);
      }
    },
    []
  );

  const setEditorMode = useCallback((mode: OverlayEditorMode) => {
    editorModeRef.current = mode;
    setEditorModeState(mode);
    if (mode !== 'replace') {
      replacementDraftRef.current = null;
      setReplacementDraftState(null);
    }
    if (mode === 'replace' && textToolActiveRef.current) {
      textToolActiveRef.current = false;
      setTextToolActiveState(false);
    }
  }, []);

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

  const activateReplacementDraftRef = useRef<
    (
      text: string,
      patch?: OverlayFormattingPatch,
      continueTextEdit?: boolean,
      pageWidthPx?: number,
      pageHeightPx?: number,
      displayScale?: number
    ) => OverlayTextBox | null
  >(() => null);

  const removeSelectedNativeText = useCallback((): boolean => {
    if (replacementDraftRef.current && pageId) {
      activateReplacementDraftRef.current('');
      return true;
    }
    const selectedId = selectedRef.current;
    const selected = overlaysRef.current.find(
      (overlay) => overlay.id === selectedId
    );
    if (!selected || selected.kind !== 'replace' || selected.text === '') {
      return false;
    }

    pushUndo();
    textEditSnapshotRef.current = null;
    overlaysRef.current = overlaysRef.current.map((overlay) =>
      overlay.id === selectedId
        ? { ...overlay, text: '', coverActive: true }
        : overlay
    );
    setOverlays(overlaysRef.current);
    setIsDirty(true);
    setAnnouncement('Original PDF text removed');
    return true;
  }, [pageId, pushUndo]);

  const selectOverlay = useCallback((overlayId: string | null) => {
    selectedRef.current = overlayId;
    setSelectedOverlayId(overlayId);
    if (overlayId) {
      replacementDraftRef.current = null;
      setReplacementDraftState(null);
      setAnnouncement('Text box selected');
    }
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

  const updateSelectedText = useCallback(
    (text: string, geometry?: OverlayBoxGeometry): boolean => {
      const selectedId = selectedRef.current;
      const selected = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!selected || !textEditSnapshotRef.current) {
        return false;
      }

      const geometryChanged =
        Boolean(geometry) &&
        (geometry!.x !== selected.x ||
          geometry!.y !== selected.y ||
          geometry!.width !== selected.width ||
          geometry!.height !== selected.height);
      if (selected.text === text && !geometryChanged) {
        return false;
      }

      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId
          ? { ...overlay, text, ...(geometry ?? {}) }
          : overlay
      );
      setOverlays(overlaysRef.current);
      setIsDirty(true);
      return true;
    },
    []
  );

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
    if (
      !before ||
      !after ||
      (before.text === after.text &&
        before.width === after.width &&
        before.height === after.height)
    ) {
      setAnnouncement('Editing finished');
      return false;
    }

    if (after.kind === 'replace' && after.coverActive === false) {
      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId ? { ...overlay, coverActive: true } : overlay
      );
      setOverlays(overlaysRef.current);
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
    (kind: 'move' | 'resize', backgroundColor?: string): boolean => {
      const snapshot = geometryEditSnapshotRef.current;
      geometryEditSnapshotRef.current = null;
      const selectedId = selectedRef.current;
      if (!snapshot || !selectedId) return false;

      if (kind === 'resize' && backgroundColor) {
        overlaysRef.current = overlaysRef.current.map((overlay) =>
          overlay.id === selectedId && overlay.kind === 'replace'
            ? { ...overlay, backgroundColor }
            : overlay
        );
        setOverlays(overlaysRef.current);
      }

      const before = snapshot.overlays.find(
        (overlay) => overlay.id === selectedId
      );
      const after = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!before || !after || sameGeometryAndBackground(before, after)) {
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
      const draft = replacementDraftRef.current;
      if (draft && pageId) {
        return Boolean(activateReplacementDraftRef.current(draft.text, patch));
      }

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
      const activate =
        selected.kind === 'replace' && selected.coverActive === false;
      overlaysRef.current = overlaysRef.current.map((overlay) =>
        overlay.id === selectedId
          ? { ...overlay, ...patch, ...(activate ? { coverActive: true } : {}) }
          : overlay
      );
      setOverlays(overlaysRef.current);
      setIsDirty(true);
      setAnnouncement('Text formatting updated');
      return true;
    },
    [pageId, pushUndo]
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
    replacementActivationEditIdRef.current = null;
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
    replacementActivationEditIdRef.current = null;
    selectedRef.current = snapshot.selectedOverlayId;
    setOverlays(overlaysRef.current);
    setSelectedOverlayId(selectedRef.current);
    setIsDirty(true);
    setCreateLimitMessage(null);
    setAnnouncement('Redo');
    return true;
  }, [pushUndoSnapshot]);

  const setReplacementDraft = useCallback((item: NativePdfTextItem) => {
    const nextDraft: ReplacementDraft = {
      item,
      text: item.text.replace(/\r\n?/g, '\n'),
      fontFamily: item.fontFamily,
      fontSize: Math.min(72, Math.max(8, Math.round(item.fontSize))),
      bold: item.bold,
      italic: item.italic,
      color: item.color ?? '#000000',
      backgroundColor: item.backgroundColor ?? '#FFFFFF',
      rotation: item.rotation,
    };
    replacementDraftRef.current = nextDraft;
    replacementActivationEditIdRef.current = null;
    selectedRef.current = null;
    setSelectedOverlayId(null);
    setReplacementDraftState(nextDraft);
    setAnnouncement(`Selected PDF text: ${item.text.slice(0, 60)}`);
  }, []);

  const discardReplacementDraft = useCallback(() => {
    replacementDraftRef.current = null;
    replacementActivationEditIdRef.current = null;
    setReplacementDraftState(null);
  }, []);

  const activateReplacementDraft = useCallback(
    (
      text: string,
      patch: OverlayFormattingPatch = {},
      continueTextEdit = false,
      pageWidthPx?: number,
      pageHeightPx?: number,
      displayScale?: number
    ): OverlayTextBox | null => {
      const draft = replacementDraftRef.current;
      if (!draft || !pageId) return null;
      if (overlaysRef.current.length >= MAX_SESSION_OVERLAYS) {
        setCreateLimitMessage(CREATE_LIMIT_MESSAGE);
        setAnnouncement(CREATE_LIMIT_MESSAGE);
        return null;
      }

      setCreateLimitMessage(null);
      pushUndo();

      const baseOverlay = {
        ...draft.item.geometry,
        fontFamily: draft.fontFamily,
        fontSize: draft.fontSize,
        bold: draft.bold,
        italic: draft.italic,
      };
      const geometry =
        pageWidthPx && pageHeightPx
          ? fitReplacementGeometry(
              baseOverlay,
              text,
              pageWidthPx,
              pageHeightPx,
              displayScale
            )
          : draft.item.geometry;

      const next: OverlayTextBox = {
        id: makeOverlayId(),
        pageId,
        ...geometry,
        text,
        fontFamily: draft.fontFamily,
        fontSize: draft.fontSize,
        bold: draft.bold,
        italic: draft.italic,
        color: draft.color,
        horizontalAlign: 'left',
        verticalAlign: 'top',
        opacity: 100,
        rotation: draft.rotation,
        listStyle: 'none',
        linkUrl: null,
        linkDisplayText: null,
        zIndex: maxZIndexForPage(overlaysRef.current, pageId) + 1,
        kind: 'replace',
        backgroundColor: draft.backgroundColor,
        ...patch,
        coverActive: true,
      };
      overlaysRef.current = [...overlaysRef.current, next];
      selectedRef.current = next.id;
      setOverlays(overlaysRef.current);
      setSelectedOverlayId(next.id);
      setIsDirty(true);
      replacementActivationEditIdRef.current = continueTextEdit
        ? next.id
        : null;
      replacementDraftRef.current = null;
      setReplacementDraftState(null);
      setAnnouncement(
        text
          ? `Replacement activated: ${text.slice(0, 60)}`
          : 'Original PDF text removed'
      );
      return next;
    },
    [pageId, pushUndo]
  );
  activateReplacementDraftRef.current = activateReplacementDraft;

  const beginReplacementTextEdit = useCallback((): boolean => {
    if (replacementDraftRef.current) return true;
    const selectedId = selectedRef.current;
    const selected = overlaysRef.current.find(
      (overlay) => overlay.id === selectedId
    );
    if (!selectedId || selected?.kind !== 'replace') return false;
    if (replacementActivationEditIdRef.current === selectedId) return true;
    return beginTextEdit(selectedId);
  }, [beginTextEdit]);

  const updateReplacementText = useCallback(
    (
      text: string,
      pageWidthPx?: number,
      pageHeightPx?: number,
      displayScale?: number
    ): boolean => {
      const normalizedText = text.replace(/\r\n?/g, '\n');
      const draft = replacementDraftRef.current;
      if (draft) {
        if (draft.text === normalizedText) return false;
        const activated = activateReplacementDraftRef.current(
          normalizedText,
          {},
          true,
          pageWidthPx,
          pageHeightPx,
          displayScale
        );
        if (!activated) return false;
        return true;
      }

      const selectedId = selectedRef.current;
      const selected = overlaysRef.current.find(
        (overlay) => overlay.id === selectedId
      );
      if (!selectedId || selected?.kind !== 'replace') return false;
      if (selected.text === normalizedText) return false;

      const geometry =
        pageWidthPx && pageHeightPx
          ? fitReplacementGeometry(
              selected,
              normalizedText,
              pageWidthPx,
              pageHeightPx,
              displayScale
            )
          : undefined;

      if (replacementActivationEditIdRef.current === selectedId) {
        overlaysRef.current = overlaysRef.current.map((overlay) =>
          overlay.id === selectedId
            ? { ...overlay, text: normalizedText, ...(geometry ?? {}) }
            : overlay
        );
        setOverlays(overlaysRef.current);
        setIsDirty(true);
        return true;
      }
      return updateSelectedText(normalizedText, geometry);
    },
    [updateSelectedText]
  );

  const commitReplacementTextEdit = useCallback((): boolean => {
    const selectedId = selectedRef.current;
    if (selectedId && replacementActivationEditIdRef.current === selectedId) {
      replacementActivationEditIdRef.current = null;
      return true;
    }
    return commitTextEdit();
  }, [commitTextEdit]);

  const clearDirty = useCallback(() => {
    setIsDirty(false);
  }, []);

  const markCleanWithOverlays = useCallback((next: OverlayTextBox[]) => {
    lastHydratedKeyRef.current = JSON.stringify(next);
    overlaysRef.current = cloneOverlays(next);
    setOverlays(overlaysRef.current);
    setIsDirty(false);
  }, []);

  const replaceFromServer = useCallback(
    (next: OverlayTextBox[]) => {
      undoStackRef.current = [];
      redoStackRef.current = [];
      geometryEditSnapshotRef.current = null;
      textEditSnapshotRef.current = null;
      replacementActivationEditIdRef.current = null;
      replacementDraftRef.current = null;
      selectedRef.current = null;
      // Prevent the dirty -> clean transition from re-applying stale props
      // before the session query publishes the authoritative response.
      lastHydratedKeyRef.current = JSON.stringify(initialOverlays);
      overlaysRef.current = cloneOverlays(next);
      setOverlays(overlaysRef.current);
      setSelectedOverlayId(null);
      setReplacementDraftState(null);
      setIsDirty(false);
      setCanUndo(false);
      setCanRedo(false);
      setCreateLimitMessage(null);
      setAnnouncement('Text overlays updated from another tab');
    },
    [initialOverlays]
  );

  return {
    overlays,
    pageOverlays,
    selectedOverlay,
    selectedOverlayId,
    textToolActive,
    setTextToolActive,
    editorMode,
    setEditorMode,
    isDirty,
    createLimitMessage,
    announcement,
    pageIdsWithOverlays,
    canUndo,
    canRedo,
    replacementDraft,
    setReplacementDraft,
    discardReplacementDraft,
    activateReplacementDraft,
    beginReplacementTextEdit,
    updateReplacementText,
    commitReplacementTextEdit,
    selectedDisplayOverlay,
    createAt,
    deleteSelected,
    removeSelectedNativeText,
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
