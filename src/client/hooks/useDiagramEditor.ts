import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DIAGRAM_DEFAULT_TITLE,
  type DiagramDetail,
  type ExcalidrawScene,
} from '../../shared/types/diagram';
import {
  createDiagram,
  getDiagram,
  isDiagramAccessDenied,
  isSceneTooLarge,
  isVersionConflict,
  updateDiagram,
  DiagramApiError,
} from '../services/diagramApi';
import {
  EMPTY_DIAGRAM_SCENE,
  EMPTY_DIAGRAM_THUMBNAIL,
  cloneDiagramScene,
  isSceneWithinLimit,
  persistableScenesEqual,
  scenesEqual,
  toDiagramScene,
} from '../utils/diagramScene';
import { generateDiagramThumbnail, type ThumbnailSource } from '../utils/diagramThumbnail';

export type DiagramEditorMode = 'new' | 'existing';

export type DiagramSaveErrorKind = 'conflict' | 'validation' | 'forbidden' | 'generic' | null;

export interface UseDiagramEditorOptions {
  projectId: string;
  diagramId: string | null;
  mode: DiagramEditorMode;
  canCreate: boolean;
  canEdit: boolean;
  /** Optional thumbnail exporter; when omitted, empty placeholder is used. */
  getThumbnailSource?: () => ThumbnailSource | null;
  /** Prefer live canvas scene on save so persistence matches the thumbnail source. */
  getLiveScene?: () => ExcalidrawScene | null;
}

export interface UseDiagramEditorResult {
  title: string;
  setTitle: (title: string) => void;
  scene: ExcalidrawScene;
  version: number | null;
  diagramId: string | null;
  isDirty: boolean;
  isLoading: boolean;
  loadError: string | null;
  isAccessDenied: boolean;
  isSaving: boolean;
  saveError: string | null;
  saveErrorKind: DiagramSaveErrorKind;
  effectiveAccess: DiagramDetail['effectiveAccess'] | null;
  onSceneChange: (scene: ExcalidrawScene) => void;
  /** Adopt Excalidraw's first live scene after mount so refresh defaults are not "dirty". */
  onCanvasHydrated: (scene: ExcalidrawScene) => void;
  save: () => Promise<DiagramDetail | null>;
  reload: () => Promise<void>;
  clearSaveError: () => void;
  markCleanFromDetail: (detail: DiagramDetail, savedScene?: ExcalidrawScene) => void;
}

function diagramQueryKey(projectId: string, diagramId: string) {
  return ['diagram', projectId, diagramId] as const;
}

export function useDiagramEditor(options: UseDiagramEditorOptions): UseDiagramEditorResult {
  const {
    projectId,
    diagramId: routeDiagramId,
    mode,
    canCreate,
    canEdit,
    getThumbnailSource,
    getLiveScene,
  } = options;
  const queryClient = useQueryClient();

  const [localDiagramId, setLocalDiagramId] = useState<string | null>(
    mode === 'existing' ? routeDiagramId : null,
  );
  const [title, setTitleState] = useState(DIAGRAM_DEFAULT_TITLE);
  const [scene, setScene] = useState<ExcalidrawScene>(() => cloneDiagramScene(EMPTY_DIAGRAM_SCENE));
  const [baselineScene, setBaselineScene] = useState<ExcalidrawScene>(() =>
    cloneDiagramScene(EMPTY_DIAGRAM_SCENE),
  );
  const [baselineTitle, setBaselineTitle] = useState(DIAGRAM_DEFAULT_TITLE);
  const [version, setVersion] = useState<number | null>(mode === 'new' ? null : null);
  const [effectiveAccess, setEffectiveAccess] = useState<DiagramDetail['effectiveAccess'] | null>(
    mode === 'new' ? 'owner' : null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorKind, setSaveErrorKind] = useState<DiagramSaveErrorKind>(null);

  const existingId = mode === 'existing' ? routeDiagramId : localDiagramId;
  const shouldLoad = mode === 'existing' && Boolean(routeDiagramId) && Boolean(projectId);

  const detailQuery = useQuery({
    queryKey: diagramQueryKey(projectId, routeDiagramId ?? ''),
    queryFn: () => getDiagram(projectId, routeDiagramId!),
    enabled: shouldLoad,
    staleTime: 0,
    retry: false,
  });

  const sceneRef = useRef(scene);
  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  /**
   * Excalidraw rewrites appState (and sometimes element defaults) on first paint.
   * Until that emission is adopted as baseline, refresh→Back falsely prompts discard.
   * Only armed after loading an existing diagram — not for /new (first stroke must dirty).
   */
  const adoptNextSceneAsBaselineRef = useRef(false);
  const loadedBaselineRef = useRef<ExcalidrawScene | null>(null);

  useEffect(() => {
    if (!detailQuery.data) return;
    const detail = detailQuery.data;
    // Skip re-hydration when cache updates after save — re-applying server scene
    // while Excalidraw still holds live appState immediately marks the editor dirty.
    if (
      localDiagramId === detail.id
      && version != null
      && version === detail.version
    ) {
      return;
    }
    setLocalDiagramId(detail.id);
    setTitleState(detail.title);
    setBaselineTitle(detail.title);
    const nextScene = cloneDiagramScene(detail.scene);
    setScene(nextScene);
    setBaselineScene(cloneDiagramScene(detail.scene));
    loadedBaselineRef.current = cloneDiagramScene(detail.scene);
    setVersion(detail.version);
    setEffectiveAccess(detail.effectiveAccess);
    adoptNextSceneAsBaselineRef.current = true;
  }, [detailQuery.data, localDiagramId, version]);

  const loadError = detailQuery.error
    ? (detailQuery.error instanceof Error
      ? detailQuery.error.message
      : 'Failed to load Diagram')
    : null;
  const isAccessDenied = isDiagramAccessDenied(detailQuery.error);

  const isDirty = !persistableScenesEqual(scene, baselineScene) || title !== baselineTitle;

  const markCleanFromDetail = useCallback((
    detail: DiagramDetail,
    /** Scene that was actually persisted — prefer over server echo for baseline sync. */
    savedScene?: ExcalidrawScene,
  ) => {
    const sceneToUse = savedScene ?? detail.scene;
    setLocalDiagramId(detail.id);
    setTitleState(detail.title);
    setBaselineTitle(detail.title);
    const next = cloneDiagramScene(sceneToUse);
    setScene(next);
    setBaselineScene(cloneDiagramScene(sceneToUse));
    sceneRef.current = cloneDiagramScene(sceneToUse);
    loadedBaselineRef.current = cloneDiagramScene(sceneToUse);
    setVersion(detail.version);
    setEffectiveAccess(detail.effectiveAccess);
    setSaveError(null);
    setSaveErrorKind(null);
    // Saved live scene already matches the canvas; do not re-adopt and clobber.
    adoptNextSceneAsBaselineRef.current = false;
  }, []);

  const createMutation = useMutation({
    mutationFn: (input: { scene: ExcalidrawScene; title: string; thumbnail: string }) =>
      createDiagram(projectId, {
        title: input.title,
        scene: input.scene,
        thumbnail: input.thumbnail,
      }),
  });

  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      scene: ExcalidrawScene;
      title: string;
      thumbnail: string;
      version: number;
    }) =>
      updateDiagram(projectId, input.id, {
        title: input.title,
        scene: input.scene,
        thumbnail: input.thumbnail,
        version: input.version,
      }),
  });

  const onSceneChange = useCallback((next: ExcalidrawScene) => {
    // Keep full persistable scene in React state (incl. size-relevant appState).
    // Dirty UX uses persistableScenesEqual (content-only) separately.
    setScene((prev) => {
      const normalizedPrev = toDiagramScene(
        prev.elements,
        prev.appState as Record<string, unknown>,
        prev.files,
      );
      const normalizedNext = toDiagramScene(
        next.elements,
        next.appState as Record<string, unknown>,
        next.files,
      );
      return scenesEqual(normalizedPrev, normalizedNext) ? prev : cloneDiagramScene(next);
    });
  }, []);

  const onCanvasHydrated = useCallback((live: ExcalidrawScene) => {
    if (!adoptNextSceneAsBaselineRef.current) return;
    const loaded = loadedBaselineRef.current;
    // Ignore empty transient paints before initialData lands.
    if (loaded && loaded.elements.length > 0 && live.elements.length === 0) {
      return;
    }
    adoptNextSceneAsBaselineRef.current = false;
    const cloned = cloneDiagramScene(live);
    setScene(cloned);
    setBaselineScene(cloneDiagramScene(live));
    sceneRef.current = cloned;
  }, []);

  const setTitle = useCallback((next: string) => {
    setTitleState(next);
  }, []);

  const clearSaveError = useCallback(() => {
    setSaveError(null);
    setSaveErrorKind(null);
  }, []);

  const save = useCallback(async (): Promise<DiagramDetail | null> => {
    const liveScene = getLiveScene?.() ?? null;
    const currentScene = liveScene ? cloneDiagramScene(liveScene) : cloneDiagramScene(sceneRef.current);
    const trimmedTitle = title.trim() || DIAGRAM_DEFAULT_TITLE;

    if (!isSceneWithinLimit(currentScene)) {
      setSaveError('Diagram scene exceeds the 5 MB limit');
      setSaveErrorKind('validation');
      return null;
    }

    const isCreate = !existingId;
    if (isCreate && !canCreate) {
      setSaveError('You do not have permission to create a Diagram');
      setSaveErrorKind('generic');
      return null;
    }
    if (!isCreate && !canEdit) {
      setSaveError('You do not have permission to save this Diagram');
      setSaveErrorKind('generic');
      return null;
    }

    let thumbnail = EMPTY_DIAGRAM_THUMBNAIL;
    const source = getThumbnailSource?.() ?? null;
    if (source) {
      thumbnail = await generateDiagramThumbnail(source);
    }

    try {
      setSaveError(null);
      setSaveErrorKind(null);
      let detail: DiagramDetail;
      if (isCreate) {
        detail = await createMutation.mutateAsync({
          scene: currentScene,
          title: trimmedTitle,
          thumbnail,
        });
      } else {
        if (version == null) {
          setSaveError('Missing Diagram version');
          setSaveErrorKind('generic');
          return null;
        }
        detail = await updateMutation.mutateAsync({
          id: existingId!,
          scene: currentScene,
          title: trimmedTitle,
          thumbnail,
          version,
        });
      }
      // Baseline must match the persisted live scene, not a divergent server round-trip.
      markCleanFromDetail(detail, currentScene);
      queryClient.setQueryData(diagramQueryKey(projectId, detail.id), {
        ...detail,
        scene: currentScene,
      });
      void queryClient.invalidateQueries({ queryKey: ['diagrams'] });
      return detail;
    } catch (error) {
      if (isVersionConflict(error)) {
        setSaveError(error.message || 'Diagram was updated by another editor');
        setSaveErrorKind('conflict');
        return null;
      }
      if (isDiagramAccessDenied(error)) {
        setSaveError(error.message || 'You no longer have access to this Diagram');
        setSaveErrorKind('forbidden');
        return null;
      }
      if (isSceneTooLarge(error) || (error instanceof DiagramApiError && error.status === 422)) {
        setSaveError(error instanceof Error ? error.message : 'Invalid Diagram');
        setSaveErrorKind('validation');
        return null;
      }
      setSaveError(error instanceof Error ? error.message : 'Failed to save Diagram');
      setSaveErrorKind('generic');
      return null;
    }
  }, [
    canCreate,
    canEdit,
    createMutation,
    existingId,
    getLiveScene,
    getThumbnailSource,
    markCleanFromDetail,
    projectId,
    queryClient,
    title,
    updateMutation,
    version,
  ]);

  const reload = useCallback(async () => {
    if (!existingId) return;
    setSaveError(null);
    setSaveErrorKind(null);
    const detail = await queryClient.fetchQuery({
      queryKey: diagramQueryKey(projectId, existingId),
      queryFn: () => getDiagram(projectId, existingId),
    });
    markCleanFromDetail(detail);
  }, [existingId, markCleanFromDetail, projectId, queryClient]);

  return {
    title,
    setTitle,
    scene,
    version,
    diagramId: existingId,
    isDirty,
    isLoading: Boolean(
      shouldLoad
      // Stay in loading until detail has been applied to local state. Cached
      // post-save query data otherwise mounts Excalidraw with an empty scene
      // (initialData is only read once).
      && (detailQuery.isLoading || (!detailQuery.isError && version == null))
    ),
    loadError,
    isAccessDenied,
    isSaving: createMutation.isPending || updateMutation.isPending,
    saveError,
    saveErrorKind,
    effectiveAccess,
    onSceneChange,
    onCanvasHydrated,
    save,
    reload,
    clearSaveError,
    markCleanFromDetail,
  };
}
