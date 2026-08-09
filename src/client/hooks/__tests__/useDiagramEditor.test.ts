import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DIAGRAM_DEFAULT_TITLE,
  DIAGRAM_MAX_SCENE_BYTES,
  type DiagramDetail,
  type ExcalidrawScene,
} from '../../../shared/types/diagram';
import { useDiagramEditor } from '../useDiagramEditor';
import { measureSceneBytes } from '../../utils/diagramScene';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function detail(overrides: Partial<DiagramDetail> = {}): DiagramDetail {
  return {
    id: 'diagram-1',
    projectId: 'project-a',
    ownerId: 'owner-1',
    ownerName: null,
    title: DIAGRAM_DEFAULT_TITLE,
    scene: { elements: [], appState: {}, files: {} },
    thumbnail: 'data:image/png;base64,aaa',
    version: 1,
    effectiveAccess: 'owner',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  } as DiagramDetail;
}

function sceneWithSerializedBytes(targetBytes: number): ExcalidrawScene {
  // Pad via elements (not appState) so dirty detection still sees a content change.
  const empty: ExcalidrawScene = {
    elements: [{ id: 'pad', data: '' }],
    appState: {},
    files: {},
  };
  const baseBytes = measureSceneBytes(empty);
  return {
    ...empty,
    elements: [{ id: 'pad', data: 'x'.repeat(Math.max(0, targetBytes - baseBytes)) }],
  };
}

describe('useDiagramEditor — PBI-002 / PBI-003', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('PBI-002 AC-0 / VT-01: first save POSTs Untitled diagram with scene and version 1', async () => {
    const created = detail({ version: 1 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'e1', type: 'rectangle' }],
        appState: {},
        files: {},
      });
    });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.diagramId).toBe('diagram-1');
    expect(result.current.version).toBe(1);
    expect(result.current.title).toBe(DIAGRAM_DEFAULT_TITLE);
    expect(result.current.isDirty).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/project-a/diagrams',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.title).toBe(DIAGRAM_DEFAULT_TITLE);
    expect(body.scene.elements).toHaveLength(1);
    expect(body.thumbnail).toMatch(/^data:image\/png;base64,/);
  });

  it('after create save, remount reshape / versionNonce churn does not stay dirty', async () => {
    const drawnScene = {
      elements: [{ id: 'e1', type: 'rectangle', x: 1, y: 2, version: 1, versionNonce: 11, updated: 100 }],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
    const created = detail({
      version: 1,
      scene: drawnScene,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    }) as jest.Mock;

    const { wrapper, queryClient } = createWrapper();
    const { result: createResult } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      createResult.current.onSceneChange(drawnScene);
    });
    await act(async () => {
      await createResult.current.save();
    });
    expect(createResult.current.isDirty).toBe(false);

    // Simulate /diagrams/new → /diagrams/:id remount (React Query cache already primed).
    const { result: editResult } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: 'diagram-1',
          mode: 'existing',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(editResult.current.version).toBe(1));
    expect(editResult.current.isDirty).toBe(false);

    act(() => {
      editResult.current.onCanvasHydrated({
        elements: [{ id: 'e1', type: 'rectangle', x: 1, y: 2, version: 3, versionNonce: 88, updated: 999 }],
        appState: {
          viewBackgroundColor: '#ffffff',
          currentItemStrokeColor: '#1e1e1e',
          scrollX: -20,
          zoom: { value: 1 },
        },
        files: {},
      });
    });
    expect(editResult.current.isDirty).toBe(false);

    act(() => {
      editResult.current.onSceneChange({
        elements: [{ id: 'e1', type: 'rectangle', x: 1, y: 2, version: 4, versionNonce: 101, updated: 1000 }],
        appState: { viewBackgroundColor: '#ffffff', scrollX: -25 },
        files: {},
      });
    });
    expect(editResult.current.isDirty).toBe(false);
    expect(queryClient.getQueryData(['diagram', 'project-a', 'diagram-1'])).toBeTruthy();
  });

  it('stays clean when route flips new → existing after create save', async () => {
    const drawnScene = {
      elements: [{ id: 'e1', type: 'rectangle', x: 1, y: 2, version: 1, versionNonce: 11, updated: 100 }],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
    const created = detail({ version: 1, scene: drawnScene });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    type EditorProps = { mode: 'new' | 'existing'; diagramId: string | null };
    const { result, rerender } = renderHook(
      ({ mode, diagramId }: EditorProps) =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId,
          mode,
          canCreate: true,
          canEdit: true,
        }),
      {
        wrapper,
        initialProps: { mode: 'new', diagramId: null } as EditorProps,
      },
    );

    act(() => {
      result.current.onSceneChange(drawnScene);
    });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });
    expect(result.current.isDirty).toBe(false);

    // Mimic App.tsx route replace /diagrams/new → /diagrams/:id without remounting the hook.
    rerender({ mode: 'existing', diagramId: 'diagram-1' });
    await waitFor(() => expect(result.current.version).toBe(1));
    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'e1', type: 'rectangle', x: 1, y: 2, version: 9, versionNonce: 999, updated: 2000 }],
        appState: { viewBackgroundColor: '#ffffff', scrollX: -40 },
        files: {},
      });
    });
    expect(result.current.isDirty).toBe(false);
  });

  it('PBI-002 AC-1 / VT-02: failed save keeps dirty state and surfaces error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server boom', code: 'INTERNAL' }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'e1' }],
        appState: {},
        files: {},
      });
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.isDirty).toBe(true);
    expect(result.current.saveError).toMatch(/Server boom|Failed/);
    expect(result.current.saveErrorKind).toBe('generic');
    expect(result.current.version).toBeNull();
  });

  it('PBI-002 AC-2 / VT-03: client pre-check rejects scene larger than 5 MB without calling API', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      result.current.onSceneChange(sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES + 1));
    });

    await act(async () => {
      await result.current.save();
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.saveErrorKind).toBe('validation');
    expect(result.current.isDirty).toBe(true);
  });

  it('PBI-002 AC-2 / VT-03: accepts a scene of exactly 5 MB', async () => {
    const created = detail();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      result.current.onSceneChange(sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES));
    });

    await act(async () => {
      await result.current.save();
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(result.current.saveError).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });

  it('PBI-002 AC-3: create is blocked when canCreate is false', async () => {
    global.fetch = jest.fn() as jest.Mock;
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: false,
          canEdit: false,
        }),
      { wrapper },
    );

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'e1' }],
        appState: {},
        files: {},
      });
    });

    await act(async () => {
      await result.current.save();
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.current.saveError).toMatch(/permission/i);
  });

  it('PBI-003 AC-0 / VT-05: version-checked update increments version and clears dirty', async () => {
    const loaded = detail({ version: 2, scene: { elements: [{ id: 'a' }], appState: {}, files: {} } });
    const updated = detail({
      version: 3,
      scene: { elements: [{ id: 'a' }, { id: 'b' }], appState: {}, files: {} },
    });

    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return { ok: true, status: 200, json: async () => loaded };
      }
      return { ok: true, status: 200, json: async () => updated };
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: 'diagram-1',
          mode: 'existing',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.version).toBe(2));
    expect(result.current.isDirty).toBe(false);

    // Canvas hydration reshape — must not count as an edit.
    act(() => {
      result.current.onCanvasHydrated({
        elements: [{ id: 'a' }],
        appState: { currentItemStrokeColor: '#1e1e1e', viewBackgroundColor: '#ffffff' },
        files: {},
      });
    });
    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'a' }, { id: 'b' }],
        appState: {},
        files: {},
      });
    });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.version).toBe(3);
    expect(result.current.isDirty).toBe(false);
    const putCall = (global.fetch as jest.Mock).mock.calls.find(
      (call) => call[1]?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body).version).toBe(2);
  });

  it('PBI-003 AC-1 / VT-06: stale version sets conflict without clearing dirty', async () => {
    const loaded = detail({ version: 1 });
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return { ok: true, status: 200, json: async () => loaded };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Diagram was updated by another editor',
          code: 'DIAGRAM_VERSION_CONFLICT',
        }),
      };
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: 'diagram-1',
          mode: 'existing',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.version).toBe(1));

    act(() => {
      result.current.onCanvasHydrated({
        elements: [],
        appState: { currentItemStrokeColor: '#1e1e1e' },
        files: {},
      });
    });
    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.onSceneChange({
        elements: [{ id: 'local' }],
        appState: {},
        files: {},
      });
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.saveErrorKind).toBe('conflict');
    expect(result.current.isDirty).toBe(true);
    expect(result.current.scene.elements).toEqual([{ id: 'local' }]);
    expect(result.current.version).toBe(1);
  });

  it('PBI-003: refresh hydration appState noise does not mark dirty', async () => {
    const loaded = detail({
      version: 4,
      scene: {
        elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2 }],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {},
      },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => loaded,
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: 'diagram-1',
          mode: 'existing',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.version).toBe(4));
    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.onCanvasHydrated({
        elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2 }],
        appState: {
          viewBackgroundColor: '#ffffff',
          currentItemStrokeColor: '#1e1e1e',
          currentItemBackgroundColor: 'transparent',
          scrollX: -40,
          scrollY: 12,
          zoom: { value: 1 },
          theme: 'light',
        },
        files: {},
      });
    });

    expect(result.current.isDirty).toBe(false);
  });

  it('PBI-005 AC-0: successful save invalidates Diagram list queries', async () => {
    const created = detail({ title: 'Renamed Diagram', version: 1 });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => created,
    }) as jest.Mock;

    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () =>
        useDiagramEditor({
          projectId: 'project-a',
          diagramId: null,
          mode: 'new',
          canCreate: true,
          canEdit: true,
        }),
      { wrapper },
    );

    act(() => {
      result.current.setTitle('Renamed Diagram');
      result.current.onSceneChange({
        elements: [{ id: 'e1' }],
        appState: {},
        files: {},
      });
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.isDirty).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['diagrams'] }),
    );
  });
});
