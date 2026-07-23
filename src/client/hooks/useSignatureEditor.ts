/**
 * useSignatureEditor — manages session-scoped signature overlay state.
 *
 * Responsibilities:
 * - Upload normalised PNGs via useUploadSignatureAsset and track assets.
 * - Maintain local overlay placements (add, move, resize, delete).
 * - Debounced autosave of the overlay array via useUpdateSignatureOverlays.
 * - Simple undo / redo for overlay array changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PdfSignatureAsset, PdfSignatureOverlay, PdfSignatureState } from '../../shared/types/pdf';
import type { SignatureSource } from '../components/SignatureToolPanel';
import {
  useUploadSignatureAsset,
  useUpdateSignatureOverlays,
} from './usePdfSession';

const AUTOSAVE_DELAY_MS = 500;

interface UseSignatureEditorOptions {
  sessionId: string | null;
  userId?: string;
  initialState: PdfSignatureState;
  /**
   * Persists any pending page-manifest changes. Overlay pageIds are validated
   * against the server's saved manifest, so this must run before an overlay
   * save — otherwise a freshly-placed signature is rejected with
   * SIGNATURE_OVERLAY_INVALID ("pageId not found in session manifest").
   */
  ensureManifestSaved?: () => Promise<void>;
}

export interface SignatureEditorState {
  assets: PdfSignatureAsset[];
  overlays: PdfSignatureOverlay[];
  selectedOverlayId: string | null;
  isDirty: boolean;
  isSaving: boolean;
  isUploading: boolean;
  uploadError: string | null;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface SignatureEditorActions {
  /** Upload a normalised PNG blob and immediately place it on the given page. */
  uploadAndPlace: (blob: Blob, source: SignatureSource, pageId: string) => Promise<void>;
  addOverlay: (overlay: PdfSignatureOverlay) => void;
  updateOverlay: (id: string, patch: Partial<PdfSignatureOverlay>) => void;
  deleteOverlay: (id: string) => void;
  selectOverlay: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
  flushNow: () => Promise<void>;
}

export function useSignatureEditor({
  sessionId,
  userId = '',
  initialState,
  ensureManifestSaved,
}: UseSignatureEditorOptions): SignatureEditorState & SignatureEditorActions {
  const [assets, setAssets] = useState<PdfSignatureAsset[]>(initialState.assets);
  const [overlays, setOverlays] = useState<PdfSignatureOverlay[]>(initialState.overlays);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Prevents the autosave effect from retrying infinitely after a failed save.
  // Cleared whenever the user makes a new overlay change.
  const saveFailedRef = useRef(false);

  // Undo/redo stacks — each entry is a snapshot of the overlays array.
  const undoStack = useRef<PdfSignatureOverlay[][]>([]);
  const redoStack = useRef<PdfSignatureOverlay[][]>([]);

  const uploadMutation = useUploadSignatureAsset(userId);
  const updateMutation = useUpdateSignatureOverlays(userId);

  // Sync from server when the session initialState changes (e.g., new session).
  useEffect(() => {
    if (!isDirty) {
      setAssets(initialState.assets);
      setOverlays(initialState.overlays);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState]);

  // ── Undo / redo ────────────────────────────────────────────────────────────

  const pushUndo = useCallback((previous: PdfSignatureOverlay[]) => {
    undoStack.current = [...undoStack.current, previous];
    redoStack.current = [];
  }, []);

  const undo = useCallback(() => {
    const stack = undoStack.current;
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    undoStack.current = stack.slice(0, -1);
    redoStack.current = [overlays, ...redoStack.current];
    saveFailedRef.current = false;
    setOverlays(previous);
    setIsDirty(true);
  }, [overlays]);

  const redo = useCallback(() => {
    const stack = redoStack.current;
    if (stack.length === 0) return;
    const next = stack[0];
    redoStack.current = stack.slice(1);
    undoStack.current = [...undoStack.current, overlays];
    saveFailedRef.current = false;
    setOverlays(next);
    setIsDirty(true);
  }, [overlays]);

  // ── Overlay mutations ──────────────────────────────────────────────────────

  const addOverlay = useCallback((overlay: PdfSignatureOverlay) => {
    saveFailedRef.current = false;
    setOverlays((current) => {
      pushUndo(current);
      return [...current, overlay];
    });
    setIsDirty(true);
  }, [pushUndo]);

  const updateOverlay = useCallback((id: string, patch: Partial<PdfSignatureOverlay>) => {
    saveFailedRef.current = false;
    setOverlays((current) => {
      pushUndo(current);
      return current.map((o) => (o.id === id ? { ...o, ...patch } : o));
    });
    setIsDirty(true);
  }, [pushUndo]);

  const deleteOverlay = useCallback((id: string) => {
    saveFailedRef.current = false;
    setOverlays((current) => {
      pushUndo(current);
      return current.filter((o) => o.id !== id);
    });
    setSelectedOverlayId((sel) => (sel === id ? null : sel));
    setIsDirty(true);
  }, [pushUndo]);

  const selectOverlay = useCallback((id: string | null) => {
    setSelectedOverlayId(id);
  }, []);

  // ── Upload + place ─────────────────────────────────────────────────────────

  const uploadAndPlace = useCallback(
    async (blob: Blob, source: SignatureSource, pageId: string) => {
      if (!sessionId) return;
      setUploadError(null);
      try {
        const result = await uploadMutation.mutateAsync({ sessionId, blob });
        const asset: PdfSignatureAsset = {
          assetId: result.assetId,
          source,
          widthPx: result.widthPx,
          heightPx: result.heightPx,
          uploadedAt: result.uploadedAt,
        };
        setAssets((current) => [...current, asset]);

        // Place the new signature centred at 20% from the top, spanning 40% width
        const aspectRatio = asset.widthPx / Math.max(asset.heightPx, 1);
        const width = 40;
        const height = Math.min(width / aspectRatio, 20);
        const overlay: PdfSignatureOverlay = {
          id: window.crypto.randomUUID(),
          pageId,
          assetId: result.assetId,
          x: 30,
          y: 20,
          width,
          height,
          rotation: 0,
          opacity: 100,
          zIndex: overlays.length + 1,
        };
        addOverlay(overlay);
        setSelectedOverlayId(overlay.id);
      } catch (err: unknown) {
        setUploadError(
          err instanceof Error ? err.message : 'Signature upload failed.'
        );
      }
    },
    [sessionId, uploadMutation, overlays.length, addOverlay]
  );

  // ── Autosave ───────────────────────────────────────────────────────────────

  const timerRef = useRef<number | null>(null);
  const latestOverlaysRef = useRef(overlays);
  const latestIsDirtyRef = useRef(isDirty);
  // Keep the latest ensureManifestSaved without making flushNow depend on it.
  const ensureManifestSavedRef = useRef(ensureManifestSaved);
  ensureManifestSavedRef.current = ensureManifestSaved;

  useEffect(() => {
    latestOverlaysRef.current = overlays;
    latestIsDirtyRef.current = isDirty;
  }, [overlays, isDirty]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!latestIsDirtyRef.current || !sessionId) return;
    try {
      // Persist the manifest first so overlay pageIds exist server-side.
      if (ensureManifestSavedRef.current) {
        await ensureManifestSavedRef.current();
      }
      await updateMutation.mutateAsync({
        sessionId,
        overlays: latestOverlaysRef.current,
      });
      setIsDirty(false);
      setSaveError(null);
      saveFailedRef.current = false;
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Signature save failed.');
      // Stop the autosave loop — it will only restart when the user makes a new change.
      saveFailedRef.current = true;
      throw err;
    }
  }, [sessionId, updateMutation]);

  useEffect(() => {
    if (!isDirty || !sessionId) return;
    // After a save failure, stop retrying until the user makes a new change.
    if (saveFailedRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushNow().catch(() => {});
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [isDirty, sessionId, overlays, flushNow]);

  return {
    assets,
    overlays,
    selectedOverlayId,
    isDirty,
    isSaving: updateMutation.isPending,
    isUploading: uploadMutation.isPending,
    uploadError,
    saveError,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    uploadAndPlace,
    addOverlay,
    updateOverlay,
    deleteOverlay,
    selectOverlay,
    undo,
    redo,
    flushNow,
  };
}
