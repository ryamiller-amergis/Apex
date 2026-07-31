/**
 * ApryseWebViewerPoc integration tests.
 * Hook logic is covered in useApryseWorkbench.test.ts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockLoadDocuments = jest.fn();
const mockSetTool = jest.fn();
const mockExportWord = jest.fn();
const mockDownloadPdf = jest.fn();
const mockMergeDocument = jest.fn();

let mockLicenseKey = 'webviewer-demo-key';
let mockState = {
  isLoaded: false,
  fileName: null as string | null,
  documentKind: 'pdf' as 'pdf' | 'xlsx',
  isDirty: false,
  activeTool: null as string | null,
  currentPage: 1,
  totalPages: 0,
  status: 'Open a PDF or XLSX to begin editing.',
  error: null as string | null,
};

jest.mock('../../config/env', () => ({
  env: {
    get VITE_APRYSE_WEBVIEWER_LICENSE_KEY() {
      return mockLicenseKey;
    },
  },
}));

jest.mock('../../hooks/useApryseWorkbench', () => ({
  useApryseWorkbench: () => ({
    state: mockState,
    actions: {
      loadDocuments: mockLoadDocuments,
      loadDocument: jest.fn(),
      setTool: mockSetTool,
      goToPage: jest.fn(),
      prevPage: jest.fn(),
      nextPage: jest.fn(),
      zoomIn: jest.fn(),
      zoomOut: jest.fn(),
      fitPage: jest.fn(),
      saveContentEdits: jest.fn(),
      discardContentEdits: jest.fn(),
      downloadPdf: mockDownloadPdf,
      exportWord: mockExportWord,
      undo: jest.fn(),
      redo: jest.fn(),
      openSearch: jest.fn(),
      setHighlightColor: jest.fn(),
      setInkStrokeWidth: jest.fn(),
      rotateCurrentPageCw: jest.fn(),
      rotateCurrentPageCcw: jest.fn(),
      mergeDocument: mockMergeDocument,
      deleteCurrentPage: jest.fn(),
      applyRedactions: jest.fn(),
      searchAndRedact: jest.fn(),
    },
  }),
}));

import { ApryseWebViewerPoc } from '../ApryseWebViewerPoc';

describe('ApryseWebViewerPoc workbench', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLicenseKey = 'webviewer-demo-key';
    mockState = {
      isLoaded: false,
      fileName: null,
      documentKind: 'pdf',
      isDirty: false,
      activeTool: null,
      currentPage: 1,
      totalPages: 0,
      status: 'Open a PDF or XLSX to begin editing.',
      error: null,
    };
    mockLoadDocuments.mockResolvedValue(undefined);
    mockExportWord.mockResolvedValue(undefined);
    mockDownloadPdf.mockResolvedValue(undefined);
    mockMergeDocument.mockResolvedValue(undefined);
  });

  it('renders Apex chrome and empty canvas when licensed', () => {
    render(<ApryseWebViewerPoc />);
    expect(screen.getByTestId('apryse-webviewer-poc')).toBeInTheDocument();
    expect(screen.getByTestId('nutrient-workbench-header')).toBeInTheDocument();
    expect(screen.getByTestId('apryse-tool-rail')).toBeInTheDocument();
    expect(screen.getByTestId('tool-btn-redact')).toBeInTheDocument();
    expect(screen.getByTestId('apryse-webviewer-container')).toBeInTheDocument();
    expect(screen.getByText('No document open')).toBeInTheDocument();
  });

  it('shows setup guidance when the WebViewer key is missing', () => {
    mockLicenseKey = '';
    render(<ApryseWebViewerPoc />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'VITE_APRYSE_WEBVIEWER_LICENSE_KEY is not configured.'
    );
  });

  it('loads files through the shared header Open PDF control', async () => {
    render(<ApryseWebViewerPoc />);
    const file = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('header-file-input'), {
      target: { files: [file] },
    });
    await waitFor(() => expect(mockLoadDocuments).toHaveBeenCalledTimes(1));
    expect(mockLoadDocuments.mock.calls[0][0][0]).toBe(file);
  });

  it('shows the floating toolbar once a document is loaded', () => {
    mockState = {
      ...mockState,
      isLoaded: true,
      fileName: 'invoice.pdf',
      totalPages: 2,
      status: 'invoice.pdf loaded (2 pages).',
    };
    render(<ApryseWebViewerPoc />);
    expect(screen.getByTestId('nutrient-floating-toolbar')).toBeInTheDocument();
  });

  it('wires Export Word to the Apryse workbench action', async () => {
    mockState = {
      ...mockState,
      isLoaded: true,
      fileName: 'invoice.pdf',
      totalPages: 1,
    };
    render(<ApryseWebViewerPoc />);
    fireEvent.click(screen.getByTestId('header-export-word'));
    await waitFor(() => expect(mockExportWord).toHaveBeenCalledTimes(1));
  });
});
