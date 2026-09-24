import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import type { ExcalidrawScene } from '../../shared/types/diagram';
import { isDarkFamilyTheme } from '../../shared/walkthroughAssets';
import { useAppShell } from '../hooks/useAppShell';
import { cloneDiagramScene, fromDiagramScene, toDiagramScene } from '../utils/diagramScene';
import type { ThumbnailSource } from '../utils/diagramThumbnail';
import styles from './ExcalidrawAdapter.module.css';

/** Named browsing context so libraries.excalidraw.com returns to this tab (not _blank). */
const APEX_DIAGRAM_WINDOW_NAME = 'apex-diagram-editor';

export interface ExcalidrawAdapterHandle {
  getThumbnailSource: () => ThumbnailSource;
  /** Live canvas scene — preferred over React state when saving. */
  getLiveScene: () => ExcalidrawScene;
  /**
   * Replace the live canvas without remounting Excalidraw (Build with Apex).
   * No-op until the imperative API is ready.
   */
  applyScene: (scene: ExcalidrawScene) => void;
  exportPng: () => Promise<Blob>;
  exportSvg: () => Promise<SVGSVGElement>;
  exportNativeJson: () => Promise<string>;
}

interface ExcalidrawAdapterProps {
  scene: ExcalidrawScene;
  editable: boolean;
  onSceneChange: (scene: ExcalidrawScene) => void;
  /** Fired once when the Excalidraw imperative API is ready (post-initialData). */
  onCanvasHydrated?: (scene: ExcalidrawScene) => void;
  /** When true, canvas fills the host without decorative frame chrome. */
  fullscreen?: boolean;
  /**
   * Remounts only the canvas host (not the lazy package load). Use when a new
   * scene must replace initialData — e.g. Build with Apex — without re-importing
   * Excalidraw, which surfaces as "Canvas failed to load" in Vite.
   */
  sceneEpoch?: string;
}

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');
type ImperativeApi = {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  updateScene: (scene: {
    elements?: readonly unknown[];
    appState?: Record<string, unknown>;
  }) => void;
};

type ExcalidrawImperativeAPI = NonNullable<
  Parameters<NonNullable<ExcalidrawModule['useHandleLibrary']>>[0]['excalidrawAPI']
>;

interface ExcalidrawHostProps {
  mod: ExcalidrawModule;
  editable: boolean;
  /** Apex maps many themes; Excalidraw only supports light | dark. */
  theme: 'light' | 'dark';
  fullscreen?: boolean;
  initialScene: ExcalidrawScene;
  onApi: (api: ImperativeApi) => void;
  onSceneChange: (scene: ExcalidrawScene) => void;
}

/**
 * Mounted only after the Excalidraw package loads so we can call its hooks.
 * Handles library install return from libraries.excalidraw.com via #addLibrary.
 */
function ExcalidrawHost({
  mod,
  editable,
  theme,
  fullscreen = false,
  initialScene,
  onApi,
  onSceneChange,
}: ExcalidrawHostProps) {
  const { Excalidraw, useHandleLibrary } = mod;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const onSceneChangeRef = useRef(onSceneChange);
  onSceneChangeRef.current = onSceneChange;
  const initial = useMemo(() => fromDiagramScene(initialScene), [initialScene]);
  const initialElements = useMemo(
    () => mod.convertToExcalidrawElements(initial.elements as never[], { regenerateIds: false }),
    [mod, initial],
  );
  const libraryReturnUrl = `${window.location.origin}${window.location.pathname}`;

  useEffect(() => {
    // Excalidraw browse link uses target=${window.name || "_blank"} for install return.
    if (!window.name) {
      window.name = APEX_DIAGRAM_WINDOW_NAME;
    }
  }, []);

  useHandleLibrary({ excalidrawAPI: api });

  const handleApi = useCallback((next: unknown) => {
    const typed = next as ExcalidrawImperativeAPI;
    setApi(typed);
    onApiRef.current(typed as unknown as ImperativeApi);
  }, []);

  const handleChange = useCallback((
    elements: readonly unknown[],
    appState: unknown,
    files: unknown,
  ) => {
    onSceneChangeRef.current(
      toDiagramScene(
        elements as unknown[],
        appState as Record<string, unknown>,
        (files ?? {}) as Record<string, unknown>,
      ),
    );
  }, []);

  return (
    <div
      className={[styles.canvas, fullscreen && styles.canvasFullscreen].filter(Boolean).join(' ')}
      {...{ 'data-testid': 'diagram-editor-canvas' }}
    >
      {/* data-testid-exempt — third-party Excalidraw canvas; Apex mount uses diagram-editor-canvas */}
      <Excalidraw
        excalidrawAPI={handleApi}
        theme={theme}
        initialData={{
          elements: initialElements as never[],
          appState: {
            ...(initial.appState as Record<string, unknown>),
            theme,
          } as never,
          files: initial.files as never,
        }}
        viewModeEnabled={!editable}
        libraryReturnUrl={libraryReturnUrl}
        onChange={handleChange as never}
      />
    </div>
  );
}

/**
 * Lazy Excalidraw embed — the package and its CSS load only when this
 * component mounts (TBI-005 / initial-bundle NFR).
 */
export const ExcalidrawAdapter = React.forwardRef(function ExcalidrawAdapter(
  {
    scene,
    editable,
    onSceneChange,
    onCanvasHydrated,
    fullscreen = false,
    sceneEpoch,
  }: ExcalidrawAdapterProps,
  ref: React.ForwardedRef<ExcalidrawAdapterHandle>,
) {
  const { theme: apexTheme } = useAppShell();
  const excalidrawTheme = useMemo<'light' | 'dark'>(
    () => (isDarkFamilyTheme(apexTheme) ? 'dark' : 'light'),
    [apexTheme],
  );
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const apiRef = useRef<ImperativeApi | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const onCanvasHydratedRef = useRef(onCanvasHydrated);
  onCanvasHydratedRef.current = onCanvasHydrated;
  const didHydrateRef = useRef(false);
  const pendingSceneRef = useRef<ExcalidrawScene | null>(null);
  const hostEpoch = sceneEpoch ?? 'initial';

  const pushSceneToCanvas = useCallback((nextScene: ExcalidrawScene) => {
    const api = apiRef.current;
    if (!api || !mod) return false;
    const { elements, appState } = fromDiagramScene(nextScene);
    const converted = mod.convertToExcalidrawElements(elements as never[], { regenerateIds: false });
    api.updateScene({
      elements: converted as never[],
      appState: {
        ...appState,
        theme: excalidrawTheme,
      },
    });
    return true;
  }, [mod, excalidrawTheme]);

  const applyScene = useCallback((nextScene: ExcalidrawScene) => {
    if (!pushSceneToCanvas(nextScene)) {
      pendingSceneRef.current = cloneDiagramScene(nextScene);
    }
  }, [pushSceneToCanvas]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setMod(null);

    void (async () => {
      try {
        await import('@excalidraw/excalidraw/index.css');
        const loaded = await import('@excalidraw/excalidraw');
        if (!cancelled) setMod(loaded);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Canvas failed to load');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  const readLiveScene = useCallback((): ExcalidrawScene => {
    const api = apiRef.current;
    if (!api || !mod) return sceneRef.current;
    return toDiagramScene(
      api.getSceneElements() as unknown[],
      api.getAppState() as Record<string, unknown>,
      api.getFiles() as Record<string, unknown>,
    );
  }, [mod]);

  useImperativeHandle(ref, () => ({
    getThumbnailSource: () => ({
      exportPngBlob: async () => {
        if (!mod) throw new Error('Excalidraw is not loaded');
        const live = readLiveScene();
        return mod.exportToBlob({
          elements: live.elements as never[],
          appState: live.appState as never,
          files: live.files as never,
          mimeType: 'image/png',
        });
      },
    }),
    getLiveScene: () => readLiveScene(),
    applyScene,
    exportPng: async () => {
      if (!mod) throw new Error('Excalidraw is not loaded');
      const live = readLiveScene();
      return mod.exportToBlob({
        elements: live.elements as never[],
        appState: live.appState as never,
        files: live.files as never,
        mimeType: 'image/png',
      });
    },
    exportSvg: async () => {
      if (!mod) throw new Error('Excalidraw is not loaded');
      const live = readLiveScene();
      return mod.exportToSvg({
        elements: live.elements as never[],
        appState: live.appState as never,
        files: live.files as never,
      });
    },
    exportNativeJson: async () => {
      if (!mod) throw new Error('Excalidraw is not loaded');
      const live = readLiveScene();
      return mod.serializeAsJSON(
        live.elements as never[],
        live.appState as never,
        live.files as never,
        'local',
      );
    },
  }), [mod, readLiveScene, applyScene]);

  useEffect(() => {
    didHydrateRef.current = false;
    apiRef.current = null;
  }, [hostEpoch]);

  const handleApi = useCallback((api: ImperativeApi) => {
    apiRef.current = api;
    const pending = pendingSceneRef.current;
    if (pending) {
      pendingSceneRef.current = null;
      if (pushSceneToCanvas(pending)) {
        setTimeout(() => {
          const live = readLiveScene();
          onCanvasHydratedRef.current?.(live);
        }, 0);
        return;
      }
      pendingSceneRef.current = pending;
    }
    if (didHydrateRef.current) {
      return;
    }
    didHydrateRef.current = true;
    // Defer so Excalidraw can apply initialData before we snapshot the live scene.
    setTimeout(() => {
      const live = readLiveScene();
      const hydrate = onCanvasHydratedRef.current;
      if (hydrate) {
        hydrate(live);
      }
    }, 0);
  }, [readLiveScene, pushSceneToCanvas]);

  if (loadError) {
    return (
      <div
        className={styles.error}
        role="alert"
        {...{ 'data-testid': 'diagram-editor-canvas-error' }}
      >
        <p>Canvas failed to load.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => setRetryCount((n) => n + 1)}
          {...{ 'data-testid': 'diagram-editor-canvas-retry' }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!mod) {
    return (
      <div
        className={styles.loading}
        role="status"
        aria-live="polite"
        {...{ 'data-testid': 'diagram-editor-canvas-loading' }}
      >
        Loading canvas…
      </div>
    );
  }

  return (
    <ErrorBoundary
      resetKeys={[hostEpoch]}
      fallback={
        <div
          className={styles.error}
          role="alert"
          {...{ 'data-testid': 'diagram-editor-canvas-error' }}
        >
          <p>Canvas failed to load.</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => setRetryCount((n) => n + 1)}
            {...{ 'data-testid': 'diagram-editor-canvas-retry' }}
          >
            Retry
          </button>
        </div>
      }
    >
      <ExcalidrawHost
        key={hostEpoch}
        mod={mod}
        editable={editable}
        theme={excalidrawTheme}
        fullscreen={fullscreen}
        initialScene={scene}
        onApi={handleApi}
        onSceneChange={onSceneChange}
      />
    </ErrorBoundary>
  );
});

ExcalidrawAdapter.displayName = 'ExcalidrawAdapter';

export default ExcalidrawAdapter;
