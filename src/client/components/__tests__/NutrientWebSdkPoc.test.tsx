/**
 * NutrientWebSdkPoc integration tests.
 *
 * Covers the orchestrating component and its wiring to the workbench hook.
 * The hook's own logic is tested separately in useNutrientWorkbench.test.ts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockLicenseKey = 'nutrient-demo-key';

const mockLoad = jest.fn();
const mockUnload = jest.fn();
const mockPreloadWorker = jest.fn();
const mockExportOffice = jest.fn();
const mockExportPDF = jest.fn();
const mockHasUnsavedChanges = jest.fn(() => false);
const mockSaveContentEditingSession = jest.fn();
const mockDiscardContentEditingSession = jest.fn();
const mockSetViewState = jest.fn();
const mockHistoryUndo = jest.fn();
const mockHistoryRedo = jest.fn();
const mockAddEventListener = jest.fn();
const mockCreateObjectURL = jest.fn(() => 'blob:fake');
const mockRevokeObjectURL = jest.fn();
const mockAnchorClick = jest.fn();

Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
  configurable: true,
  value: mockAnchorClick,
});

jest.mock('../../config/env', () => ({
  env: {
    get VITE_NUTRIENT_LICENSE_KEY() {
      return mockLicenseKey;
    },
  },
}));

jest.mock('@nutrient-sdk/viewer', () => ({
  __esModule: true,
  default: {
    defaultToolbarItems: [{ type: 'pager' }],
    InteractionMode: {
      PAN: 'PAN',
      CONTENT_EDITOR: 'CONTENT_EDITOR',
      TEXT_HIGHLIGHTER: 'TEXT_HIGHLIGHTER',
      INK: 'INK',
      TEXT: 'TEXT',
      COMMENT_MARKER: 'COMMENT_MARKER',
      FORM_CREATOR: 'FORM_CREATOR',
      INK_SIGNATURE: 'INK_SIGNATURE',
      SEARCH: 'SEARCH',
    },
    ZoomMode: { FIT_TO_WIDTH: 'FIT_TO_WIDTH' },
    EventName: {
      VIEW_STATE_CURRENT_PAGE_INDEX_CHANGE: 'viewState.currentPageIndex.change',
      VIEW_STATE_CHANGE: 'viewState.change',
    },
    load: (...args: unknown[]) => mockLoad(...args),
    unload: (...args: unknown[]) => mockUnload(...args),
    preloadWorker: (...args: unknown[]) => mockPreloadWorker(...args),
  },
}));

import { NutrientWebSdkPoc } from '../NutrientWebSdkPoc';

function makeInstance() {
  return {
    viewState: { currentPageIndex: 0 },
    totalPageCount: 2,
    setViewState: mockSetViewState,
    saveContentEditingSession: mockSaveContentEditingSession,
    discardContentEditingSession: mockDiscardContentEditingSession,
    exportPDF: mockExportPDF,
    exportOffice: mockExportOffice,
    hasUnsavedContentEditingChanges: mockHasUnsavedChanges,
    history: { undo: mockHistoryUndo, redo: mockHistoryRedo },
    addEventListener: mockAddEventListener,
  };
}

function makeFile(name = 'invoice.pdf') {
  const f = new File(['%PDF'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'arrayBuffer', {
    value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
  });
  return f;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLicenseKey = 'nutrient-demo-key';
  mockSetViewState.mockImplementation(
    (updater: (vs: { set: jest.Mock; zoomBy: jest.Mock }) => unknown) => {
      const vs = { set: jest.fn(), zoomBy: jest.fn() };
      updater(vs);
    }
  );
  mockLoad.mockResolvedValue(makeInstance());
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

describe('NutrientWebSdkPoc workbench', () => {
  it('renders command bar, tool rail, and empty-state canvas', () => {
    render(<NutrientWebSdkPoc />);
    expect(screen.getByTestId('nutrient-workbench-header')).toBeInTheDocument();
    expect(screen.getByTestId('nutrient-tool-rail')).toBeInTheDocument();
    expect(screen.getByTestId('nutrient-viewer-container')).toBeInTheDocument();
  });

  it('loads a PDF when a file is selected via the header', async () => {
    render(<NutrientWebSdkPoc />);
    const input = screen.getByTestId('header-file-input');
    fireEvent.change(input, { target: { files: [makeFile()] } });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    expect(mockLoad.mock.calls[0][0]).toMatchObject({
      licenseKey: 'nutrient-demo-key',
      useCDN: true,
      // Vendor toolbar must be removed.
      toolbarItems: [],
    });
  });

  it('hides vendor main and contextual toolbars', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    const cfg = mockLoad.mock.calls[0][0];
    expect(cfg.ui?.tools?.main).toBeDefined();
    expect(cfg.ui?.tools?.contextual).toBeDefined();
    // Renderers must return null to hide vendor chrome.
    const fakeGetInstance = () => null;
    expect(cfg.ui.tools.main(fakeGetInstance, 'main-id')?.render()).toBeNull();
    expect(
      cfg.ui.tools.contextual(fakeGetInstance, 'ctx-id')?.render()
    ).toBeNull();
  });

  it('shows the floating toolbar after a PDF is loaded', async () => {
    render(<NutrientWebSdkPoc />);
    expect(
      screen.queryByTestId('nutrient-floating-toolbar')
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('nutrient-floating-toolbar')
      ).toBeInTheDocument()
    );
  });

  it('activates a tool via the rail', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('tool-btn-text-edit'));

    // The set call on viewState should target CONTENT_EDITOR.
    expect(mockSetViewState).toHaveBeenCalled();
    const updater =
      mockSetViewState.mock.calls[mockSetViewState.mock.calls.length - 1]?.[0];
    const vs = { set: jest.fn(), zoomBy: jest.fn() };
    updater(vs);
    expect(vs.set).toHaveBeenCalledWith('interactionMode', 'CONTENT_EDITOR');
  });

  it('floating toolbar shows save/discard sub-options for text-edit', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('tool-btn-text-edit'));

    expect(screen.getByTestId('sub-option-save')).toBeInTheDocument();
    expect(screen.getByTestId('sub-option-discard')).toBeInTheDocument();
  });

  it('floating toolbar can be minimized and restored', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('nutrient-floating-toolbar')
      ).toBeInTheDocument()
    );

    const minimize = screen.getByTestId('floating-toolbar-minimize');
    fireEvent.click(minimize);
    expect(screen.queryByTestId('sub-option-save')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('floating-toolbar-minimize'));
  });

  it('saves content edits via the floating toolbar save button', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('tool-btn-text-edit'));

    fireEvent.click(screen.getByTestId('sub-option-save'));
    expect(mockSaveContentEditingSession).toHaveBeenCalledTimes(1);
  });

  it('exports to Word via the header button', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('header-export-word'));
    await waitFor(() =>
      expect(mockExportOffice).toHaveBeenCalledWith({ format: 'docx' })
    );
    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
  });

  it('saves PDF via the header button', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('header-save-pdf'));
    await waitFor(() => expect(mockExportPDF).toHaveBeenCalled());
    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
  });

  it('calls undo/redo via header buttons', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('header-undo'));
    fireEvent.click(screen.getByTestId('header-redo'));
    expect(mockHistoryUndo).toHaveBeenCalledTimes(1);
    expect(mockHistoryRedo).toHaveBeenCalledTimes(1);
  });

  it('draggable toolbar resets position', async () => {
    render(<NutrientWebSdkPoc />);
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [makeFile()] },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('nutrient-floating-toolbar')
      ).toBeInTheDocument()
    );
    const resetBtn = screen.getByTestId('floating-toolbar-reset');
    fireEvent.click(resetBtn);
    expect(resetBtn).toBeInTheDocument();
  });
});
