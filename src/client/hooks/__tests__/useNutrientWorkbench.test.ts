import { act, renderHook, waitFor } from '@testing-library/react';

const mockSetViewState = jest.fn();
const mockSetAnnotationPresets = jest.fn();
const mockSetCurrentAnnotationPreset = jest.fn();
const mockSaveContentEditingSession = jest.fn();
const mockDiscardContentEditingSession = jest.fn();
const mockExportPDF = jest.fn();
const mockExportOffice = jest.fn();
const mockHistoryUndo = jest.fn();
const mockHistoryRedo = jest.fn();
const mockHasUnsavedChanges = jest.fn(() => false);
const mockAddEventListener = jest.fn();
const mockLoad = jest.fn();
const mockUnload = jest.fn();
const mockPreloadWorker = jest.fn();
const mockCreateObjectURL = jest.fn(() => 'blob:fake');
const mockRevokeObjectURL = jest.fn();
const mockAnchorClick = jest.fn();
const mockFromHex = jest.fn((hex: string) => ({ hex }));

Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
  configurable: true,
  value: mockAnchorClick,
});

function makeSdk() {
  return {
    InteractionMode: {
      PAN: 'PAN',
      CONTENT_EDITOR: 'CONTENT_EDITOR',
      TEXT_HIGHLIGHTER: 'TEXT_HIGHLIGHTER',
      INK: 'INK',
      TEXT: 'TEXT',
      NOTE: 'NOTE',
      COMMENT_MARKER: 'COMMENT_MARKER',
      FORM_CREATOR: 'FORM_CREATOR',
      INK_SIGNATURE: 'INK_SIGNATURE',
      DOCUMENT_EDITOR: 'DOCUMENT_EDITOR',
      SEARCH: 'SEARCH',
    },
    Color: { fromHex: (hex: string) => mockFromHex(hex) },
    ZoomMode: { FIT_TO_WIDTH: 'FIT_TO_WIDTH' },
    EventName: {
      VIEW_STATE_CURRENT_PAGE_INDEX_CHANGE: 'viewState.currentPageIndex.change',
      VIEW_STATE_CHANGE: 'viewState.change',
    },
    Immutable: { List: (arr: number[]) => arr },
    load: (...args: unknown[]) => mockLoad(...args),
    unload: (...args: unknown[]) => mockUnload(...args),
    preloadWorker: (...args: unknown[]) => mockPreloadWorker(...args),
  };
}

let mockSdk = makeSdk();

jest.mock('../../lib/nutrientViewer', () => ({
  getNutrientViewer: jest.fn(async () => mockSdk),
  getNutrientViewerSync: jest.fn(() => mockSdk),
}));

import { useNutrientWorkbench } from '../useNutrientWorkbench';

function makeContainer(): HTMLDivElement {
  return document.createElement('div');
}

function makeFile(name = 'invoice.pdf'): File {
  const f = new File(['%PDF'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
    writable: true,
  });
  return f;
}

function makeInstance() {
  const instance = {
    viewState: { currentPageIndex: 0 },
    totalPageCount: 3,
    setViewState: mockSetViewState,
    setAnnotationPresets: mockSetAnnotationPresets,
    setCurrentAnnotationPreset: mockSetCurrentAnnotationPreset,
    saveContentEditingSession: mockSaveContentEditingSession,
    discardContentEditingSession: mockDiscardContentEditingSession,
    exportPDF: mockExportPDF,
    exportOffice: mockExportOffice,
    hasUnsavedContentEditingChanges: mockHasUnsavedChanges,
    history: { undo: mockHistoryUndo, redo: mockHistoryRedo },
    addEventListener: mockAddEventListener,
  };
  mockSetViewState.mockImplementation((updater: (v: unknown) => unknown) => {
    type FakeVS = { set: jest.Mock; zoomBy: jest.Mock };
    const fakeVS: FakeVS = {
      set: jest.fn((_k: string, _v: unknown): FakeVS => fakeVS),
      zoomBy: jest.fn((_f: number): FakeVS => fakeVS),
    };
    updater(fakeVS);
  });
  mockSetAnnotationPresets.mockImplementation(
    (updater: (presets: Record<string, Record<string, unknown>>) => unknown) => {
      updater({ 'text-highlighter': {}, ink: {} });
    }
  );
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSdk = makeSdk();
  const instance = makeInstance();
  mockLoad.mockResolvedValue(instance);
  mockPreloadWorker.mockResolvedValue(undefined);
  mockSaveContentEditingSession.mockResolvedValue(undefined);
  mockDiscardContentEditingSession.mockResolvedValue(undefined);
  mockExportPDF.mockResolvedValue(new ArrayBuffer(8));
  mockExportOffice.mockResolvedValue(new ArrayBuffer(8));
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: mockCreateObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: mockRevokeObjectURL,
  });
});

describe('useNutrientWorkbench', () => {
  it('loads a document and reports page count', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: 'key', containerElement: container })
    );

    await act(() => result.current.actions.loadDocument(makeFile()));
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    expect(result.current.state.fileName).toBe('invoice.pdf');
    expect(result.current.state.totalPages).toBe(3);
    expect(result.current.state.currentPage).toBe(1);
    expect(result.current.state.status).toContain('invoice.pdf');
  });

  it('preloads the worker exactly once across multiple loads', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: 'key', containerElement: container })
    );

    await act(() => result.current.actions.loadDocument(makeFile()));
    await act(() => result.current.actions.loadDocument(makeFile()));

    expect(mockPreloadWorker).toHaveBeenCalledTimes(1);
  });

  it('passes licenseKey when non-empty', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({
        licenseKey: 'my-key',
        containerElement: container,
      })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    expect(mockLoad.mock.calls[0][0]).toMatchObject({ licenseKey: 'my-key' });
  });

  it('omits licenseKey in evaluation mode', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    expect(mockLoad.mock.calls[0][0]).not.toHaveProperty('licenseKey');
  });

  it('hides the main and contextual toolbars on load', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    const config = mockLoad.mock.calls[0][0];
    expect(config.toolbarItems).toEqual([]);
    expect(config.ui?.tools?.main).toBeDefined();
    expect(config.ui?.tools?.contextual).toBeDefined();
  });

  it('sets CONTENT_EDITOR interaction mode for text-edit tool', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));

    act(() => result.current.actions.setTool('text-edit'));

    expect(mockSetViewState).toHaveBeenCalled();
    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', 'CONTENT_EDITOR');
    expect(result.current.state.activeTool).toBe('text-edit');
  });

  it('sets null interaction mode when tool is null', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.setTool(null));

    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', null);
    expect(result.current.state.activeTool).toBeNull();
  });

  it('shows exact error when setViewState throws', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));

    mockSetViewState.mockImplementation(() => {
      throw new Error('Feature not licensed');
    });
    act(() => result.current.actions.setTool('text-edit'));

    expect(result.current.state.error).toBe('Feature not licensed');
  });

  it('saves content edits and clears activeTool and CONTENT_EDITOR mode', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.setTool('text-edit'));

    await act(() => result.current.actions.saveContentEdits());

    expect(mockSaveContentEditingSession).toHaveBeenCalled();
    expect(result.current.state.activeTool).toBeNull();
    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', null);
  });

  it('discards content edits and clears activeTool and CONTENT_EDITOR mode', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.setTool('text-edit'));

    await act(() => result.current.actions.discardContentEdits());

    expect(mockDiscardContentEditingSession).toHaveBeenCalled();
    expect(result.current.state.activeTool).toBeNull();
    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', null);
  });

  it('applies default highlight color and current preset when activating highlight', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));

    act(() => result.current.actions.setTool('highlight'));

    expect(mockFromHex).toHaveBeenCalledWith('#FFE066');
    expect(mockSetAnnotationPresets).toHaveBeenCalled();
    expect(mockSetCurrentAnnotationPreset).toHaveBeenCalledWith('text-highlighter');
    expect(result.current.state.activeTool).toBe('highlight');
  });

  it('sets current text-highlighter preset when changing highlight color', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.setTool('highlight'));
    mockSetCurrentAnnotationPreset.mockClear();
    mockFromHex.mockClear();

    act(() => result.current.actions.setHighlightColor('#FF7EB3'));

    expect(mockFromHex).toHaveBeenCalledWith('#FF7EB3');
    expect(mockSetCurrentAnnotationPreset).toHaveBeenCalledWith('text-highlighter');
  });

  it('sets null interaction mode for fill-form (fill, not create)', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));

    act(() => result.current.actions.setTool('fill-form'));

    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', null);
    expect(result.current.state.activeTool).toBe('fill-form');
  });

  it('saves pending edits before downloading PDF', async () => {
    mockHasUnsavedChanges.mockReturnValue(true);
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    await act(() => result.current.actions.downloadPdf());

    expect(mockSaveContentEditingSession).toHaveBeenCalledTimes(1);
    expect(mockExportPDF).toHaveBeenCalled();
    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
  });

  it('saves pending edits before exporting Word', async () => {
    mockHasUnsavedChanges.mockReturnValue(true);
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    await act(() => result.current.actions.exportWord());

    expect(mockSaveContentEditingSession).toHaveBeenCalledTimes(1);
    expect(mockExportOffice).toHaveBeenCalledWith({ format: 'docx' });
    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
  });

  it('calls history.undo and history.redo', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.undo());
    act(() => result.current.actions.redo());

    expect(mockHistoryUndo).toHaveBeenCalledTimes(1);
    expect(mockHistoryRedo).toHaveBeenCalledTimes(1);
  });

  it('opens search mode', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.openSearch());

    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', 'SEARCH');
  });

  it('navigates pages by calling setViewState', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));

    act(() => result.current.actions.goToPage(2));
    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn((_k: string, v: unknown) => v) };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('currentPageIndex', 1);
  });

  it('zooms via zoomBy on fitPage call', async () => {
    const container = makeContainer();
    const { result } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    act(() => result.current.actions.fitPage());

    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = {
      set: jest.fn((_k: string, v: unknown) => v),
      zoomBy: jest.fn(),
    };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('zoom', 'FIT_TO_WIDTH');
  });

  it('unloads the viewer on unmount', async () => {
    const container = makeContainer();
    const { result, unmount } = renderHook(() =>
      useNutrientWorkbench({ licenseKey: '', containerElement: container })
    );
    await act(() => result.current.actions.loadDocument(makeFile()));
    unmount();
    expect(mockUnload).toHaveBeenCalledWith(container);
  });

  it('unloads using the latest container when it was null on first render', async () => {
    const container = makeContainer();
    const { result, rerender, unmount } = renderHook(
      ({ el }: { el: HTMLDivElement | null }) =>
        useNutrientWorkbench({ licenseKey: '', containerElement: el }),
      { initialProps: { el: null as HTMLDivElement | null } }
    );

    rerender({ el: container });
    await act(() => result.current.actions.loadDocument(makeFile()));
    unmount();

    expect(mockUnload).toHaveBeenCalledWith(container);
  });
});
