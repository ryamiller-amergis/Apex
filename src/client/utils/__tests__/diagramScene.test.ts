import {
  DIAGRAM_MAX_SCENE_BYTES,
  type ExcalidrawScene,
} from '../../../shared/types/diagram';
import {
  EMPTY_DIAGRAM_SCENE,
  fromDiagramScene,
  isSceneWithinLimit,
  measureSceneBytes,
  persistableScenesEqual,
  scenesEqual,
  toDiagramScene,
} from '../diagramScene';

describe('diagramScene — TBI-005 DoD-3 / VT-09 scene conversion', () => {
  it('DoD-3 / VT-09: round-trips elements, appState, and files losslessly', () => {
    const scene: ExcalidrawScene = {
      elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2 }],
      appState: { viewBackgroundColor: '#fff', zoom: { value: 1 } },
      files: { 'file-1': { id: 'file-1', dataURL: 'data:image/png;base64,abc', mimeType: 'image/png' } },
    };

    const imported = fromDiagramScene(scene);
    const exported = toDiagramScene(imported.elements, imported.appState, imported.files);

    expect(exported.elements).toEqual(scene.elements);
    expect(exported.appState).toEqual(scene.appState);
    expect(exported.files).toEqual(scene.files);
    expect(scenesEqual(exported, scene)).toBe(true);
  });

  it('DoD-3: strips collaborators from appState before persistence', () => {
    const result = toDiagramScene(
      [],
      { viewBackgroundColor: '#000', collaborators: new Map() } as Record<string, unknown>,
      {},
    );
    expect(result.appState).toEqual({ viewBackgroundColor: '#000' });
    expect(result.appState).not.toHaveProperty('collaborators');
  });

  it('DoD-3: restore injects collaborators Map required by Excalidraw', () => {
    const imported = fromDiagramScene({
      elements: [{ id: 'a' }],
      appState: { viewBackgroundColor: '#fff' },
      files: {},
    });
    expect(imported.appState.collaborators).toBeInstanceOf(Map);
  });

  it('starts from an empty scene contract', () => {
    expect(EMPTY_DIAGRAM_SCENE).toEqual({ elements: [], appState: {}, files: {} });
  });

  it('dirty compare ignores pan/zoom and Excalidraw default appState noise', () => {
    const baseline: ExcalidrawScene = {
      elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0 }],
      appState: { viewBackgroundColor: '#fff', scrollX: 0, scrollY: 0, zoom: { value: 1 } },
      files: {},
    };
    const panned: ExcalidrawScene = {
      ...baseline,
      appState: { viewBackgroundColor: '#fff', scrollX: -120, scrollY: 40, zoom: { value: 1.25 } },
    };
    const hydratedDefaults: ExcalidrawScene = {
      ...baseline,
      appState: {
        viewBackgroundColor: '#fff',
        currentItemStrokeColor: '#1e1e1e',
        currentItemBackgroundColor: 'transparent',
        currentItemFontFamily: 1,
        gridSize: null,
        theme: 'light',
        scrollX: 10,
        scrollY: 20,
        zoom: { value: 1 },
      },
    };
    const edited: ExcalidrawScene = {
      ...baseline,
      elements: [{ id: 'a', type: 'rectangle', x: 10, y: 0 }],
    };
    const backgroundChanged: ExcalidrawScene = {
      ...baseline,
      appState: { viewBackgroundColor: '#000' },
    };

    expect(persistableScenesEqual(baseline, panned)).toBe(true);
    expect(persistableScenesEqual(baseline, hydratedDefaults)).toBe(true);
    expect(persistableScenesEqual(baseline, edited)).toBe(false);
    expect(persistableScenesEqual(baseline, backgroundChanged)).toBe(false);
  });
});

describe('diagramScene — PBI-002 AC-2 / VT-03 scene byte boundary', () => {
  function sceneWithSerializedBytes(targetBytes: number): ExcalidrawScene {
    const empty: ExcalidrawScene = {
      elements: [],
      appState: { payload: '' },
      files: {},
    };
    const baseBytes = measureSceneBytes(empty);
    return {
      ...empty,
      appState: { payload: 'x'.repeat(targetBytes - baseBytes) },
    };
  }

  it('AC-2 / VT-03: accepts a scene of exactly 5 MB', () => {
    const exact = sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES);
    expect(measureSceneBytes(exact)).toBe(DIAGRAM_MAX_SCENE_BYTES);
    expect(isSceneWithinLimit(exact)).toBe(true);
  });

  it('AC-2 / VT-03: rejects a scene larger than 5 MB', () => {
    const oversized = sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES + 1);
    expect(measureSceneBytes(oversized)).toBe(DIAGRAM_MAX_SCENE_BYTES + 1);
    expect(isSceneWithinLimit(oversized)).toBe(false);
  });
});
