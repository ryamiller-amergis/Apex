import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceBrowser, SourceBrowserProps } from '../SourceBrowser';
import type { PdfFileMetadata, PageManifestEntry } from '../../../shared/types/pdf';
import type { DocumentColor } from '../../hooks/useDocumentColors';

jest.mock('../../hooks/usePdfDocument', () => ({
  usePdfDocument: jest.fn(() => ({
    document: { numPages: 3 },
    isLoading: false,
    error: null,
  })),
}));

jest.mock('../../hooks/useThumbnailRenderer', () => ({
  useThumbnailRenderer: jest.fn(() => ({
    status: 'loaded',
    imageBitmap: null,
    error: null,
  })),
}));

jest.mock('../../contexts/PdfWorkerContext', () => ({
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePdfWorker: jest.fn(() => ({
    getDocument: jest.fn(),
  })),
}));

function makeFile(fileId: string, name: string, pageCount = 3): PdfFileMetadata {
  return {
    fileId,
    originalName: name,
    storedName: `${fileId}-stored.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    pageCount,
    uploadedAt: '2026-01-01T00:00:00Z',
  };
}

function makeManifest(fileId: string, pageCount: number): PageManifestEntry[] {
  return Array.from({ length: pageCount }, (_, i) => ({
    pageId: `${fileId}-page-${i}`,
    fileId,
    sourcePageIndex: i,
    rotation: 0 as const,
    deleted: false,
  }));
}

function makeColor(): DocumentColor {
  return { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.6)', text: 'rgba(59,130,246,0.9)', label: 'Blue' };
}

const defaultProps: SourceBrowserProps = {
  fileMetadata: [makeFile('file-a', 'Alpha.pdf', 2), makeFile('file-b', 'Beta.pdf', 3)],
  localManifest: [...makeManifest('file-a', 2), ...makeManifest('file-b', 3)],
  sessionId: 'sess-1',
  documentColors: new Map<string, DocumentColor>([
    ['file-a', makeColor()],
    ['file-b', { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.6)', text: 'rgba(16,185,129,0.9)', label: 'Emerald' }],
  ]),
  isPageInAssembly: () => true,
  onTogglePageInAssembly: jest.fn(),
  dragActive: false,
  onDrop: jest.fn(),
  onDragOver: jest.fn(),
  onDragLeave: jest.fn(),
  onDropzoneClick: jest.fn(),
  inputRef: React.createRef<HTMLInputElement>(),
  onInputChange: jest.fn(),
  isUploading: false,
  createSessionPending: false,
  errors: [],
  sessionLimitError: false,
};

function renderBrowser(overrides: Partial<SourceBrowserProps> = {}) {
  return render(<SourceBrowser {...defaultProps} {...overrides} />);
}

describe('SourceBrowser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders upload dropzone', () => {
    renderBrowser();
    expect(screen.getByTestId('pdf-dropzone')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-file-input')).toHaveAttribute(
      'accept',
      expect.stringContaining('.docx'),
    );
  });

  it('renders document list with correct file names sorted A-Z', () => {
    renderBrowser();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Alpha.pdf');
    expect(items[1]).toHaveTextContent('Beta.pdf');
  });

  it('expanding a document shows mini-thumbnails', () => {
    renderBrowser();
    const expandBtns = screen.getAllByLabelText('Expand pages');
    fireEvent.click(expandBtns[0]);
    const thumbnails = screen.getAllByTestId(/^mini-thumbnail-/);
    expect(thumbnails.length).toBe(2);
  });

  it('mini-thumbnail shows included indicator when in assembly', () => {
    renderBrowser({ isPageInAssembly: () => true });
    const expandBtns = screen.getAllByLabelText('Expand pages');
    fireEvent.click(expandBtns[0]);
    const indicators = screen.getAllByTestId(/^mini-thumb-indicator-/);
    expect(indicators[0]).toHaveAttribute('data-included', 'true');
  });

  it('mini-thumbnail shows excluded indicator when not in assembly', () => {
    renderBrowser({ isPageInAssembly: () => false });
    const expandBtns = screen.getAllByLabelText('Expand pages');
    fireEvent.click(expandBtns[0]);
    const indicators = screen.getAllByTestId(/^mini-thumb-indicator-/);
    expect(indicators[0]).toHaveAttribute('data-included', 'false');
  });

  it('clicking mini-thumbnail calls onTogglePageInAssembly', () => {
    const onToggle = jest.fn();
    renderBrowser({ onTogglePageInAssembly: onToggle });
    const expandBtns = screen.getAllByLabelText('Expand pages');
    fireEvent.click(expandBtns[0]);
    const thumbnails = screen.getAllByTestId(/^mini-thumbnail-/);
    fireEvent.click(thumbnails[0]);
    expect(onToggle).toHaveBeenCalledWith('file-a-page-0');
  });

  it('shows empty state message when no files', () => {
    renderBrowser({ fileMetadata: [], localManifest: [] });
    expect(screen.getByText('Upload PDF documents to begin assembly')).toBeInTheDocument();
  });

  it('shows uploading indicator', () => {
    renderBrowser({ isUploading: true });
    expect(screen.getByTestId('pdf-uploading')).toBeInTheDocument();
  });

  it('shows Converting... for a pending Word file', () => {
    renderBrowser({
      fileMetadata: [],
      localManifest: [],
      isUploading: true,
      convertingFiles: ['proposal.docx'],
    });

    expect(screen.getByText('proposal.docx')).toBeInTheDocument();
    expect(screen.getAllByText('Converting...').length).toBeGreaterThan(0);
  });

  it('shows converted Word provenance and page thumbnails after conversion', () => {
    const convertedFile = {
      ...makeFile('word-file', 'proposal.docx', 2),
      convertedFrom: 'proposal.docx',
    };

    renderBrowser({
      fileMetadata: [convertedFile],
      localManifest: makeManifest('word-file', 2),
      convertingFiles: [],
    });

    expect(screen.getByText('proposal.docx')).toBeInTheDocument();
    expect(screen.getByText('Converted from Word')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand pages'));
    expect(screen.getAllByTestId(/^mini-thumbnail-/)).toHaveLength(2);
  });

  it('shows error cards for validation failures', () => {
    renderBrowser({
      errors: [{
        originalName: 'bad.pdf',
        status: 'error',
        error: { code: 'FILE_CORRUPT', message: 'File is corrupt' },
      }],
    });
    expect(screen.getByTestId('pdf-upload-errors')).toBeInTheDocument();
    expect(screen.getByText('bad.pdf')).toBeInTheDocument();
  });

  it('calls onDismissError from an error card', () => {
    const error = {
      originalName: 'bad.docx',
      status: 'error' as const,
      error: { code: 'CONVERSION_FAILED', message: 'Conversion failed' },
    };
    const onDismissError = jest.fn();

    renderBrowser({ errors: [error], onDismissError });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error for bad.docx' }));

    expect(onDismissError).toHaveBeenCalledWith(error);
  });

  it('shows the required Word conversion failure message exactly once', () => {
    const message =
      'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.';

    renderBrowser({
      errors: [{
        originalName: 'broken.docx',
        status: 'error',
        error: { code: 'CONVERSION_FAILED', message },
      }],
    });

    const renderedError = screen.getByTestId('pdf-upload-errors').textContent ?? '';
    expect(renderedError).toContain(message);
    expect(renderedError.split(message)).toHaveLength(2);
  });

  it('calls onRemoveFile when delete button clicked', () => {
    const onRemoveFile = jest.fn();
    renderBrowser({ onRemoveFile });
    const deleteBtn = screen.getAllByTitle('Remove document')[0];
    fireEvent.click(deleteBtn);
    expect(onRemoveFile).toHaveBeenCalledWith('file-a');
  });
});
