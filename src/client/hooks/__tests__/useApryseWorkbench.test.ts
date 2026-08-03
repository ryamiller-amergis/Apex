import { act, renderHook, waitFor } from '@testing-library/react';
import { useApryseWorkbench } from '../useApryseWorkbench';

const mockDispose = jest.fn();
const mockDisableElements = jest.fn();
const mockEnableElements = jest.fn();
const mockEnableFeatures = jest.fn();
const mockOpenElements = jest.fn();
const mockCloseElements = jest.fn();
const mockSetToolMode = jest.fn();
const mockRemovePages = jest.fn();
const mockSetFitMode = jest.fn();
const mockLoadDocument = jest.fn();
const mockAddEventListener = jest.fn();
const mockRemoveEventListener = jest.fn();
const mockGetPageCount = jest.fn(() => 2);
const mockSetCurrentPage = jest.fn();
const mockGetZoomLevel = jest.fn(() => 1);
const mockZoomTo = jest.fn();
const mockRotateClockwise = jest.fn();
const mockRotateCounterClockwise = jest.fn();
const mockGetTool = jest.fn();
const mockGetFileData = jest.fn();
const mockGetDocument = jest.fn();
const mockStartContentEditMode = jest.fn();
const mockEndContentEditMode = jest.fn();
const mockIsInContentEditMode = jest.fn(() => false);
const mockUndo = jest.fn();
const mockRedo = jest.fn();
const mockIframe = jest.fn();
const mockCreateDocument = jest.fn();
const mockInsertPages = jest.fn();

jest.mock('@pdftron/webviewer', () => ({
  __esModule: true,
  default: Object.assign(jest.fn(), {
    BackendTypes: { WASM: 'ems' },
    Iframe: (...args: unknown[]) => mockIframe(...args),
  }),
}));

function makeInstance() {
  const tool = { setStyles: jest.fn() };
  mockGetTool.mockReturnValue(tool);
  mockGetDocument.mockReturnValue({
    getFileData: mockGetFileData,
    getPageCount: mockGetPageCount,
    insertPages: mockInsertPages,
    removePages: mockRemovePages,
  });
  mockGetFileData.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mockCreateDocument.mockResolvedValue({ getPageCount: () => 1 });
  mockInsertPages.mockResolvedValue(undefined);
  mockRemovePages.mockResolvedValue(undefined);
  mockStartContentEditMode.mockResolvedValue(undefined);

  return {
    Core: {
      Tools: {
        ToolNames: {
          EDIT: 'AnnotationEdit',
          CONTENT_EDIT: 'ContentEditTool',
          HIGHLIGHT: 'AnnotationCreateTextHighlight',
          FREEHAND: 'AnnotationCreateFreeHand',
          FREETEXT: 'AnnotationCreateFreeText',
          STICKY: 'AnnotationCreateSticky',
          TEXT_SELECT: 'TextSelect',
          SIGNATURE: 'AnnotationCreateSignature',
          PAN: 'Pan',
          REDACTION: 'AnnotationCreateRedaction',
        },
      },
      Annotations: {
        Color: class {
          constructor(
            public r: number,
            public g: number,
            public b: number
          ) {}
        },
        RedactionAnnotation: class RedactionAnnotation {},
      },
      SpreadsheetEditor: {
        SpreadsheetEditorEditMode: { EDITING: 'editing' },
        SpreadsheetEditorManager: {
          Events: { SPREADSHEET_EDITOR_READY: 'spreadsheetEditorReady' },
        },
      },
      createDocument: mockCreateDocument,
      documentViewer: {
        addEventListener: mockAddEventListener,
        removeEventListener: mockRemoveEventListener,
        getPageCount: mockGetPageCount,
        setCurrentPage: mockSetCurrentPage,
        getZoomLevel: mockGetZoomLevel,
        zoomTo: mockZoomTo,
        rotateClockwise: mockRotateClockwise,
        rotateCounterClockwise: mockRotateCounterClockwise,
        getTool: mockGetTool,
        getDocument: mockGetDocument,
        getContentEditManager: () => ({
          startContentEditMode: mockStartContentEditMode,
          endContentEditMode: mockEndContentEditMode,
          isInContentEditMode: mockIsInContentEditMode,
        }),
        getAnnotationHistoryManager: () => ({
          undo: mockUndo,
          redo: mockRedo,
          clear: jest.fn(),
        }),
      },
    },
    UI: {
      Feature: { ContentEdit: 'ContentEdit', Redaction: 'Redaction' },
      FitMode: { FitPage: 'FitPage' },
      enableFeatures: mockEnableFeatures,
      disableElements: mockDisableElements,
      enableElements: mockEnableElements,
      openElements: mockOpenElements,
      closeElements: mockCloseElements,
      setToolMode: mockSetToolMode,
      setFitMode: mockSetFitMode,
      loadDocument: mockLoadDocument,
      searchText: jest.fn(),
      dispose: mockDispose,
    },
  };
}

function makeFile(name = 'invoice.pdf') {
  const file = new File(['%PDF'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
  });
  return file;
}

describe('useApryseWorkbench', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsInContentEditMode.mockReturnValue(false);
    const instance = makeInstance();
    mockIframe.mockImplementation(async () => {
      // Simulate documentLoaded when loadDocument is called.
      mockLoadDocument.mockImplementation(() => {
        const loaded = mockAddEventListener.mock.calls.find(
          (call) => call[0] === 'documentLoaded'
        )?.[1] as (() => void) | undefined;
        loaded?.();
      });
      return instance;
    });
  });

  it('loads a PDF with native chrome disabled', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });

    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));
    expect(mockIframe).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/apryse-webviewer/lib',
        licenseKey: 'webviewer-key',
        fullAPI: true,
        enableRedaction: true,
        disabledElements: expect.arrayContaining(['header', 'toolsHeader']),
      }),
      expect.any(HTMLDivElement)
    );
    expect(mockEnableFeatures).toHaveBeenCalledWith([
      'ContentEdit',
      'Redaction',
    ]);
    expect(result.current.state.fileName).toBe('invoice.pdf');
    expect(result.current.state.documentKind).toBe('pdf');
    expect(result.current.state.totalPages).toBe(2);
  });

  it('activates the redaction tool', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      result.current.actions.setTool('redact');
    });

    await waitFor(() => expect(result.current.state.activeTool).toBe('redact'));
    expect(mockSetToolMode).toHaveBeenCalledWith('AnnotationCreateRedaction');
  });

  it('activates highlight tool through Core setToolMode', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      result.current.actions.setTool('highlight');
    });

    await waitFor(() =>
      expect(result.current.state.activeTool).toBe('highlight')
    );
    expect(mockSetToolMode).toHaveBeenCalledWith(
      'AnnotationCreateTextHighlight'
    );
  });

  it('starts content edit mode for text-edit tool', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      result.current.actions.setTool('text-edit');
    });

    await waitFor(() =>
      expect(mockStartContentEditMode).toHaveBeenCalledTimes(1)
    );
    expect(mockSetToolMode).toHaveBeenCalledWith('ContentEditTool');
  });

  it('rotates the current page via DocumentViewer', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      await result.current.actions.rotateCurrentPageCw();
    });

    expect(mockRotateClockwise).toHaveBeenCalledWith(1);
  });

  it('opens the thumbnail pages panel when Pages tool is selected', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      result.current.actions.setTool('pages');
    });

    await waitFor(() => expect(result.current.state.activeTool).toBe('pages'));
    expect(mockEnableElements).toHaveBeenCalledWith(
      expect.arrayContaining(['leftPanel', 'thumbnailsPanel'])
    );
    expect(mockOpenElements).toHaveBeenCalledWith(['leftPanel']);
  });

  it('deletes the current page via Document.removePages', async () => {
    const container = document.createElement('div');
    const { result } = renderHook(() =>
      useApryseWorkbench({
        licenseKey: 'webviewer-key',
        containerElement: container,
      })
    );

    await act(async () => {
      await result.current.actions.loadDocuments([makeFile()]);
    });
    await waitFor(() => expect(result.current.state.isLoaded).toBe(true));

    await act(async () => {
      await result.current.actions.deleteCurrentPage?.();
    });

    expect(mockRemovePages).toHaveBeenCalledWith([1]);
  });
});
