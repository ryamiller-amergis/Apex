import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ExcalidrawScene } from '../../shared/types/diagram';
import { fromDiagramScene, toDiagramScene } from '../utils/diagramScene';
import type { ThumbnailSource } from '../utils/diagramThumbnail';
import styles from './ExcalidrawAdapter.module.css';

/** Named browsing context so libraries.excalidraw.com returns to this tab (not _blank). */
const APEX_DIAGRAM_WINDOW_NAME = 'apex-diagram-editor';

export interface ExcalidrawAdapterHandle {
  getThumbnailSource: () => ThumbnailSource;
  /** Live canvas scene — preferred over React state when saving. */
  getLiveScene: () => ExcalidrawScene;
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
}

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');
type ImperativeApi = {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

type ExcalidrawImperativeAPI = NonNullable<
  Parameters<NonNullable<ExcalidrawModule['useHandleLibrary']>>[0]['excalidrawAPI']
>;

interface ExcalidrawHostProps {
  mod: ExcalidrawModule;
  editable: boolean;
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
  const initial = fromDiagramScene(initialScene);
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
      className={styles.canvas}
      {...{ 'data-testid': 'diagram-editor-canvas' }}
    >
      {/* data-testid-exempt — third-party Excalidraw canvas; Apex mount uses diagram-editor-canvas */}
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={{
          elements: initial.elements as never[],
          appState: initial.appState as never,
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
  { scene, editable, onSceneChange, onCanvasHydrated }: ExcalidrawAdapterProps,
  ref: React.ForwardedRef<ExcalidrawAdapterHandle>,
) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const apiRef = useRef<ImperativeApi | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const initialSceneRef = useRef(scene);
  const onCanvasHydratedRef = useRef(onCanvasHydrated);
  onCanvasHydratedRef.current = onCanvasHydrated;
  const didHydrateRef = useRef(false);

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
  }), [mod, readLiveScene]);

  const handleApi = useCallback((api: ImperativeApi) => {
    apiRef.current = api;
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
  }, [readLiveScene]);

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
    <ExcalidrawHost
      mod={mod}
      editable={editable}
      initialScene={initialSceneRef.current}
      onApi={handleApi}
      onSceneChange={onSceneChange}
    />
  );
});

ExcalidrawAdapter.displayName = 'ExcalidrawAdapter';

export default ExcalidrawAdapter;
