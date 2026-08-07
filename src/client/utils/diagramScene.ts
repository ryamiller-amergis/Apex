import {
  DIAGRAM_MAX_SCENE_BYTES,
  type ExcalidrawScene,
} from '../../shared/types/diagram';

export const EMPTY_DIAGRAM_SCENE: ExcalidrawScene = {
  elements: [],
  appState: {},
  files: {},
};

/** Minimal 1×1 transparent PNG used when thumbnail generation fails. */
export const EMPTY_DIAGRAM_THUMBNAIL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneDiagramScene(scene: ExcalidrawScene): ExcalidrawScene {
  return {
    elements: deepClone(scene.elements),
    appState: deepClone(scene.appState),
    files: deepClone(scene.files),
  };
}

/**
 * Normalize Excalidraw onChange payloads into the Apex DiagramScene contract.
 * Strips volatile UI-only appState fields that must not round-trip into persistence
 * and must not trigger React update loops on every pointer/selection tick.
 */
export function toDiagramScene(
  elements: readonly unknown[],
  appState: Record<string, unknown>,
  files: Record<string, unknown>,
): ExcalidrawScene {
  const {
    collaborators: _collaborators,
    selectedElementIds: _selectedElementIds,
    suggestedBindings: _suggestedBindings,
    isResizing: _isResizing,
    isRotating: _isRotating,
    isLoading: _isLoading,
    openMenu: _openMenu,
    openPopup: _openPopup,
    openSidebar: _openSidebar,
    editingElement: _editingElement,
    editingGroupId: _editingGroupId,
    editingLinearElement: _editingLinearElement,
    resizingElement: _resizingElement,
    draggingElement: _draggingElement,
    multiElement: _multiElement,
    selectionElement: _selectionElement,
    startBoundElement: _startBoundElement,
    newElement: _newElement,
    cursorButton: _cursorButton,
    scrolledOutside: _scrolledOutside,
    ...persistableAppState
  } = appState;
  return {
    elements: deepClone([...elements]),
    appState: deepClone(persistableAppState),
    files: deepClone(files ?? {}),
  };
}

export function fromDiagramScene(scene: ExcalidrawScene): {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
} {
  return {
    elements: deepClone(scene.elements ?? []),
    // Excalidraw requires collaborators to be a Map on restore (not JSON-serializable).
    appState: {
      ...deepClone(scene.appState ?? {}),
      collaborators: new Map(),
    },
    files: deepClone(scene.files ?? {}),
  };
}

/** UTF-8 byte length of the serialized scene JSON (BR-002 / PBI-002 AC-2). */
export function measureSceneBytes(scene: ExcalidrawScene): number {
  return new TextEncoder().encode(JSON.stringify(scene)).length;
}

export function isSceneWithinLimit(scene: ExcalidrawScene): boolean {
  return measureSceneBytes(scene) <= DIAGRAM_MAX_SCENE_BYTES;
}

export function scenesEqual(a: ExcalidrawScene, b: ExcalidrawScene): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare scenes for unsaved-edit detection.
 * Only diagram content counts: elements, files, and canvas background.
 * Excalidraw injects dozens of default appState keys on mount (tools, UI, viewport);
 * those must not mark the editor dirty after a refresh with no real edits.
 */
export function persistableScenesEqual(a: ExcalidrawScene, b: ExcalidrawScene): boolean {
  const normalize = (scene: ExcalidrawScene) => {
    const base = toDiagramScene(
      scene.elements,
      scene.appState as Record<string, unknown>,
      scene.files,
    );
    const appState = base.appState as Record<string, unknown>;
    return {
      elements: base.elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor ?? null,
      },
      files: base.files,
    };
  };
  return scenesEqual(normalize(a), normalize(b));
}
