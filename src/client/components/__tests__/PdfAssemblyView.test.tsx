import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PdfAssemblyView } from '../PdfAssemblyView';

jest.mock('../../contexts/PdfWorkerContext', () => ({
  usePdfWorker: () => ({ getDocument: jest.fn() }),
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../SourceBrowser', () => ({
  SourceBrowser: () => <div data-testid="mock-source-browser" />,
}));

jest.mock('../AssemblyLane', () => ({
  AssemblyLane: () => <div data-testid="mock-assembly-lane" />,
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

jest.mock('../../hooks/usePdfSession', () => ({
  useCreatePdfSession: () => ({
    mutateAsync: mockCreateSession,
    isPending: false,
    error: null,
  }),
  usePdfSession: () => ({
    data: null,
  }),
  useUploadPdfFiles: () => ({
    mutateAsync: mockUploadFiles,
    isPending: false,
  }),
  useActivePdfSessions: () => ({
    data: [],
  }),
  useUpdateManifest: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
  }),
  useRemovePdfFile: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
  }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('PdfAssemblyView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateSession.mockResolvedValue({ sessionId: 'sess-1', status: 'active', createdAt: '', expiresAt: '' });
    mockUploadFiles.mockResolvedValue({ files: [{ fileId: 'f1', originalName: 'test.pdf', status: 'success', pageCount: 3, sizeBytes: 1024 }] });
  });

  it('renders the dropzone and heading', () => {
    renderWithQuery(<PdfAssemblyView />);
    expect(screen.getByTestId('pdf-assembly-view')).toBeInTheDocument();
    expect(screen.getByText('PDF Tools')).toBeInTheDocument();
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
      expect(mockUploadFiles).toHaveBeenCalledWith({ sessionId: 'sess-1', files: [file] });
    });
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

  it('handles drag and drop events on the dropzone', () => {
    renderWithQuery(<PdfAssemblyView />);
    const dropzone = screen.getByTestId('pdf-dropzone');

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    fireEvent.dragLeave(dropzone, { dataTransfer: { files: [] } });
    fireEvent.drop(dropzone, { dataTransfer: { files: [] } });
  });
});
