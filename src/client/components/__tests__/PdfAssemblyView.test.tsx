import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PdfAssemblyView } from '../PdfAssemblyView';
import type { PageManifestEntry, PdfFileMetadata, PdfSession } from '../../../shared/types/pdf';

jest.mock('../../contexts/PdfWorkerContext', () => ({
  usePdfWorker: () => ({ getDocument: jest.fn() }),
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../SourceBrowser', () => ({
  SourceBrowser: () => <div data-testid="mock-source-browser" />,
}));

jest.mock('../AssemblyLane', () => ({
  AssemblyLane: ({
    onReorder,
    onSelectAll,
    onDeselectAll,
    selectedCount,
    visiblePages,
  }: {
    onReorder: (from: number, to: number) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    selectedCount: number;
    visiblePages: PageManifestEntry[];
  }) => (
    <div data-testid="mock-assembly-lane">
      <span data-testid="mock-selected-count">{selectedCount}</span>
      <button
        type="button"
        data-testid="mock-reorder-btn"
        onClick={() => onReorder(0, Math.max(visiblePages.length - 1, 0))}
      >
        Reorder
      </button>
      <button type="button" data-testid="mock-select-all" onClick={onSelectAll}>
        Select All
      </button>
      <button type="button" data-testid="mock-deselect-all" onClick={onDeselectAll}>
        Deselect All
      </button>
    </div>
  ),
}));

jest.mock('../PagePreviewModal', () => ({
  PagePreviewModal: () => <div data-testid="mock-preview-modal" />,
}));

jest.mock('../PdfInlinePreview', () => ({
  PdfInlinePreview: () => <div data-testid="mock-inline-preview" />,
}));

jest.mock('../../hooks/useDocumentColors', () => ({
  useDocumentColors: () => new Map(),
}));

const mockCreateSession = jest.fn();
const mockUploadFiles = jest.fn();
const mockMutateManifest = jest.fn();
const mockMutateAsyncManifest = jest.fn();
const mockExportMutate = jest.fn();
let mockSessionData: PdfSession | null = null;
let mockSessionError: (Error & { status?: number }) | null = null;
let mockExportMutationState = {
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null as (Error & { code?: string }) | null,
};

jest.mock('../../hooks/usePdfSession', () => ({
  useCreatePdfSession: () => ({
    mutateAsync: mockCreateSession,
    isPending: false,
    error: null,
  }),
  usePdfSession: (sessionId: string | null) => ({
    data: mockSessionData?.id === sessionId ? mockSessionData : null,
    error: mockSessionError,
  }),
  useUploadPdfFiles: () => ({
    mutateAsync: mockUploadFiles,
    isPending: false,
  }),
  useActivePdfSessions: () => ({
    data: [],
  }),
  useUpdateManifest: () => ({
    mutate: mockMutateManifest,
    mutateAsync: mockMutateAsyncManifest,
    isPending: false,
  }),
  useRemovePdfFile: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
}));

jest.mock('../../hooks/useExportSession', () => ({
  useExportSession: () => ({
    mutate: mockExportMutate,
    ...mockExportMutationState,
  }),
  generateDefaultFilename: () => 'merged-document-20260710-1200.pdf',
  ensurePdfExtension: (name: string) => {
    if (!name.trim()) return 'merged-document-20260710-1200.pdf';
    if (!name.toLowerCase().endsWith('.pdf')) return `${name.trim()}.pdf`;
    return name.trim();
  },
}));

function makePage(pageId: string, sourcePageIndex: number): PageManifestEntry {
  return {
    pageId,
    fileId: 'file-1',
    sourcePageIndex,
    rotation: 0,
    deleted: false,
  };
}

function makeSession(pages: PageManifestEntry[]): PdfSession {
  const file: PdfFileMetadata = {
    fileId: 'file-1',
    originalName: 'source.pdf',
    storedName: 'file-1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    pageCount: pages.length,
    uploadedAt: '2026-07-10T12:00:00.000Z',
  };

  return {
    id: 'sess-wired',
    userId: 'user-1',
    status: 'active',
    createdAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:00:00.000Z',
    expiresAt: '2026-07-10T16:00:00.000Z',
    fileMetadata: [file],
    pageManifest: pages,
    conversionJobs: [],
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('PdfAssemblyView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockSessionData = null;
    mockSessionError = null;
    mockExportMutationState = {
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
    };
    mockCreateSession.mockResolvedValue({
      sessionId: 'sess-1',
      status: 'active',
      createdAt: '',
      expiresAt: '',
    });
    mockUploadFiles.mockResolvedValue({
      files: [{
        fileId: 'f1',
        originalName: 'test.pdf',
        status: 'success',
        pageCount: 3,
        sizeBytes: 1024,
      }],
    });
    mockMutateAsyncManifest.mockResolvedValue({ pageCount: 3, updatedAt: '' });
  });

  it('renders the dropzone and heading', () => {
    renderWithQuery(<PdfAssemblyView />);
    expect(screen.getByTestId('pdf-assembly-view')).toBeInTheDocument();
    expect(screen.getByText('PDF Assembly Tool')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-dropzone')).toBeInTheDocument();
  });

  it('renders hero state when no files uploaded', () => {
    renderWithQuery(<PdfAssemblyView />);
    expect(screen.getByText(/Click to upload/)).toBeInTheDocument();
  });

  it('shows file input when dropzone is clicked', () => {
    renderWithQuery(<PdfAssemblyView />);
    const input = screen.getByTestId('pdf-file-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toContain('.pdf');
  });

  it('creates session and uploads files on file selection', async () => {
    renderWithQuery(<PdfAssemblyView />);
    const input = screen.getByTestId('pdf-file-input');
    const file = new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({});
    });

    await waitFor(() => {
      expect(mockUploadFiles).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        files: [file],
        onProgress: expect.any(Function),
      });
    });
  });

  it('replaces an expired stored session before uploading', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-expired');
    mockSessionError = Object.assign(new Error('Session has expired'), { status: 410 });

    renderWithQuery(<PdfAssemblyView />);

    await waitFor(() => {
      expect(sessionStorage.getItem('pdf-active-session')).toBeNull();
    });

    const file = new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('pdf-file-input'), { target: { files: [file] } });

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({});
      expect(mockUploadFiles).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        files: [file],
        onProgress: expect.any(Function),
      });
    });
  });

  it('retries an upload with a fresh session when the stored session returns 410', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-expired');
    mockUploadFiles
      .mockRejectedValueOnce(Object.assign(new Error('Session has expired'), { status: 410 }))
      .mockResolvedValueOnce({
        files: [{
          fileId: 'f1',
          originalName: 'test.pdf',
          status: 'success',
          pageCount: 3,
          sizeBytes: 1024,
        }],
      });

    renderWithQuery(<PdfAssemblyView />);
    const file = new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('pdf-file-input'), { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadFiles).toHaveBeenNthCalledWith(1, {
        sessionId: 'sess-expired',
        files: [file],
        onProgress: expect.any(Function),
      });
      expect(mockCreateSession).toHaveBeenCalledWith({});
      expect(mockUploadFiles).toHaveBeenNthCalledWith(2, {
        sessionId: 'sess-1',
        files: [file],
        onProgress: expect.any(Function),
      });
    });
    expect(sessionStorage.getItem('pdf-active-session')).toBe('sess-1');
  });

  it('displays validation errors from upload results', async () => {
    mockUploadFiles.mockResolvedValue({
      files: [{
        originalName: 'bad.pdf',
        status: 'error',
        error: { code: 'FILE_ENCRYPTED', message: 'This PDF is password-protected and cannot be processed.' },
      }],
    });

    renderWithQuery(<PdfAssemblyView />);
    const input = screen.getByTestId('pdf-file-input');
    const file = new File(['data'], 'bad.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId('pdf-upload-errors')).toBeInTheDocument();
    });
    expect(screen.getByText(/bad\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Password-protected/)).toBeInTheDocument();
  });

  it('dismisses an upload error without refreshing the page', async () => {
    mockUploadFiles.mockResolvedValue({
      files: [{
        originalName: 'broken.docx',
        status: 'error',
        error: {
          code: 'CONVERSION_FAILED',
          message: 'This Word document could not be converted.',
        },
      }],
    });

    renderWithQuery(<PdfAssemblyView />);
    const input = screen.getByTestId('pdf-file-input');
    const file = new File(['invalid'], 'broken.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    fireEvent.change(input, { target: { files: [file] } });

    const dismissButton = await screen.findByRole('button', {
      name: 'Dismiss error for broken.docx',
    });
    fireEvent.click(dismissButton);

    await waitFor(() => {
      expect(screen.queryByText('broken.docx')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pdf-upload-errors')).not.toBeInTheDocument();
    });
  });

  it('surfaces an asynchronous conversion failure from session polling', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-active');
    mockSessionData = {
      ...makeSession([]),
      id: 'sess-active',
      fileMetadata: [],
      pageManifest: [],
      conversionJobs: [{
        id: 'conversion-failed',
        sessionId: 'sess-active',
        originalName: 'large-report.docx',
        status: 'failed',
        error: {
          code: 'CONVERSION_FAILED',
          message: 'This Word document could not be converted.',
        },
        createdAt: '2026-07-11T05:00:00.000Z',
        completedAt: '2026-07-11T05:01:00.000Z',
      }],
    };

    renderWithQuery(<PdfAssemblyView />);

    expect(screen.getByText('large-report.docx')).toBeInTheDocument();
    expect(screen.getByText(/This Word document could not be converted/)).toBeInTheDocument();
  });

  it('handles drag and drop events on the dropzone', () => {
    renderWithQuery(<PdfAssemblyView />);
    const dropzone = screen.getByTestId('pdf-dropzone');

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    fireEvent.dragLeave(dropzone, { dataTransfer: { files: [] } });
    fireEvent.drop(dropzone, { dataTransfer: { files: [] } });
  });

  it('uploads a dropped .docx and shows its queued conversion state', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-active');
    mockSessionData = {
      ...makeSession([]),
      id: 'sess-active',
      fileMetadata: [],
      pageManifest: [],
    };

    mockUploadFiles.mockResolvedValue({
      files: [{
        conversionId: 'conversion-1',
        originalName: 'proposal.docx',
        status: 'queued',
      }],
    });

    renderWithQuery(<PdfAssemblyView />);
    const wordFile = new File(['docx-data'], 'proposal.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    fireEvent.drop(screen.getByTestId('pdf-dropzone'), {
      dataTransfer: { files: [wordFile] },
    });

    await waitFor(() => {
      expect(mockUploadFiles).toHaveBeenCalledWith({
        sessionId: 'sess-active',
        files: [wordFile],
        onProgress: expect.any(Function),
      });
      expect(screen.getByText('proposal.docx')).toBeInTheDocument();
      expect(screen.getByText('Waiting to convert…')).toBeInTheDocument();
    });
  });

  it('selects and deselects every visible assembly page', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-select-all');
    mockSessionData = {
      ...makeSession([
        makePage('page-a', 0),
        makePage('page-b', 1),
        makePage('page-c', 2),
      ]),
      id: 'sess-select-all',
    };

    renderWithQuery(<PdfAssemblyView />);
    expect(screen.getByTestId('mock-selected-count')).toHaveTextContent('0');

    fireEvent.click(screen.getByTestId('mock-select-all'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-selected-count')).toHaveTextContent('3');
    });

    fireEvent.click(screen.getByTestId('mock-deselect-all'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-selected-count')).toHaveTextContent('0');
    });
  });

  it('collapses and restores the source document column', () => {
    sessionStorage.setItem('pdf-active-session', 'sess-wired');
    mockSessionData = makeSession([makePage('page-a', 0)]);

    renderWithQuery(<PdfAssemblyView />);

    expect(screen.getByTestId('mock-source-browser')).toBeInTheDocument();
    const toggleButton = screen.getByTestId('pdf-toggle-source-browser');
    expect(toggleButton).toHaveAccessibleName('Hide source documents');
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggleButton);

    expect(screen.queryByTestId('mock-source-browser')).not.toBeInTheDocument();
    expect(toggleButton).toHaveAccessibleName('Show source documents');
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleButton);
    expect(screen.getByTestId('mock-source-browser')).toBeInTheDocument();
  });

  it('resizes the assembly and preview panes with keyboard controls', () => {
    sessionStorage.setItem('pdf-active-session', 'sess-wired');
    mockSessionData = makeSession([makePage('page-a', 0)]);

    renderWithQuery(<PdfAssemblyView />);

    const divider = screen.getByRole('separator', {
      name: 'Resize assembly and preview panels',
    });
    const assemblyPanel = screen.getByTestId('mock-assembly-lane').parentElement;

    expect(divider).toHaveAttribute('aria-valuenow', '50');
    expect(assemblyPanel).toHaveStyle({ flexBasis: '50%' });

    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider).toHaveAttribute('aria-valuenow', '55');
    expect(assemblyPanel).toHaveStyle({ flexBasis: '55%' });

    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider).toHaveAttribute('aria-valuenow', '30');

    fireEvent.doubleClick(divider);
    expect(divider).toHaveAttribute('aria-valuenow', '50');
  });

  it('starts a fresh session without deleting the current documents', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-wired');
    mockSessionData = makeSession([makePage('page-a', 0)]);
    mockCreateSession.mockResolvedValueOnce({
      sessionId: 'sess-fresh',
      status: 'active',
      createdAt: '',
      expiresAt: '',
    });

    renderWithQuery(<PdfAssemblyView />);
    fireEvent.click(screen.getByTestId('pdf-new-session'));

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({});
      expect(sessionStorage.getItem('pdf-active-session')).toBe('sess-fresh');
    });

    expect(screen.getByTestId('pdf-dropzone')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-source-browser')).not.toBeInTheDocument();
  });

  it('saves page changes before starting a fresh session', async () => {
    sessionStorage.setItem('pdf-active-session', 'sess-wired');
    mockSessionData = makeSession([
      makePage('page-a', 0),
      makePage('page-b', 1),
    ]);

    renderWithQuery(<PdfAssemblyView />);
    fireEvent.click(screen.getByTestId('mock-reorder-btn'));
    fireEvent.click(screen.getByTestId('pdf-new-session'));

    await waitFor(() => {
      expect(mockMutateAsyncManifest).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateAsyncManifest.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSession.mock.invocationCallOrder[0],
    );
  });

  describe('export bar wiring', () => {
    beforeEach(() => {
      sessionStorage.setItem('pdf-active-session', 'sess-wired');
      mockSessionData = makeSession([
        makePage('page-a', 0),
        makePage('page-b', 1),
        makePage('page-c', 2),
      ]);
    });

    it('renders filename, page range, and both export actions together', () => {
      renderWithQuery(<PdfAssemblyView />);

      expect(screen.getByTestId('pdf-export-bar')).toBeInTheDocument();
      expect(screen.getByTestId('pdf-export-filename-input')).toBeInTheDocument();
      expect(screen.getByTestId('pdf-range-input')).toBeInTheDocument();
      expect(screen.getByTestId('pdf-export-button')).toBeInTheDocument();
      expect(screen.getByTestId('pdf-export-selected-btn')).toBeInTheDocument();
    });

    it('exports all pages with the shared filename', async () => {
      renderWithQuery(<PdfAssemblyView />);

      const filenameInput = screen.getByTestId('pdf-export-filename-input');
      fireEvent.change(filenameInput, { target: { value: 'full-packet.pdf' } });
      fireEvent.click(screen.getByTestId('pdf-export-button'));

      await waitFor(() => {
        expect(mockExportMutate).toHaveBeenCalledWith({
          sessionId: 'sess-wired',
          filename: 'full-packet.pdf',
        });
      });
    });

    it('exports selected pages using the shared filename and range selection', async () => {
      renderWithQuery(<PdfAssemblyView />);

      fireEvent.change(screen.getByTestId('pdf-export-filename-input'), {
        target: { value: 'selected-pages.pdf' },
      });

      // RangeInput debounces 300ms before applying selection
      fireEvent.change(screen.getByTestId('pdf-range-input'), {
        target: { value: '1-2' },
      });

      await waitFor(() => {
        expect(screen.getByTestId('pdf-export-selected-btn')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTestId('pdf-export-selected-btn'));

      await waitFor(() => {
        expect(mockExportMutate).toHaveBeenCalledWith({
          sessionId: 'sess-wired',
          filename: 'selected-pages.pdf',
          pages: [0, 1],
        });
      });
    });

    it('persists unsaved reorder before export selected', async () => {
      renderWithQuery(<PdfAssemblyView />);

      fireEvent.click(screen.getByTestId('mock-reorder-btn'));

      fireEvent.change(screen.getByTestId('pdf-export-filename-input'), {
        target: { value: 'after-reorder.pdf' },
      });
      fireEvent.change(screen.getByTestId('pdf-range-input'), {
        target: { value: '1,3' },
      });

      await waitFor(() => {
        expect(screen.getByTestId('pdf-export-selected-btn')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTestId('pdf-export-selected-btn'));

      await waitFor(() => {
        expect(mockMutateAsyncManifest).toHaveBeenCalledWith({
          sessionId: 'sess-wired',
          manifest: [
            expect.objectContaining({ pageId: 'page-b' }),
            expect.objectContaining({ pageId: 'page-c' }),
            expect.objectContaining({ pageId: 'page-a' }),
          ],
        });
      });

      await waitFor(() => {
        expect(mockExportMutate).toHaveBeenCalledWith({
          sessionId: 'sess-wired',
          filename: 'after-reorder.pdf',
          pages: [0, 2],
        });
      });

      // Save must complete before export starts
      expect(mockMutateAsyncManifest.mock.invocationCallOrder[0]).toBeLessThan(
        mockExportMutate.mock.invocationCallOrder[0],
      );
    });

    it('does not call save when exporting with no unsaved changes', async () => {
      renderWithQuery(<PdfAssemblyView />);

      fireEvent.click(screen.getByTestId('pdf-export-button'));

      await waitFor(() => {
        expect(mockExportMutate).toHaveBeenCalledTimes(1);
      });
      expect(mockMutateAsyncManifest).not.toHaveBeenCalled();
    });
  });
});
