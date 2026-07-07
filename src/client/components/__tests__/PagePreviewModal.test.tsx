import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PagePreviewModal, PagePreviewModalProps } from '../PagePreviewModal';

const mockGetPage = jest.fn();

jest.mock('../../hooks/usePdfDocument', () => ({
  usePdfDocument: jest.fn(() => ({
    document: null,
    isLoading: false,
    error: null,
  })),
}));

jest.mock('../../contexts/PdfWorkerContext', () => ({
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { usePdfDocument } = jest.requireMock('../../hooks/usePdfDocument');

const defaultProps: PagePreviewModalProps = {
  isOpen: true,
  pageId: 'page-1',
  fileUrl: '/api/pdf/sessions/sess-1/files/file-1',
  sourcePageIndex: 2,
  rotation: 0,
  sourceFileName: 'report.pdf',
  originalPageNumber: 3,
  onClose: jest.fn(),
};

function renderModal(overrides: Partial<PagePreviewModalProps> = {}) {
  return render(<PagePreviewModal {...defaultProps} {...overrides} />);
}

function mockDocumentLoaded() {
  const mockViewport = { width: 612, height: 792 };
  const mockRender = { promise: Promise.resolve() };
  mockGetPage.mockResolvedValue({
    getViewport: jest.fn(() => mockViewport),
    render: jest.fn(() => mockRender),
  });

  (usePdfDocument as jest.Mock).mockReturnValue({
    document: { getPage: mockGetPage, numPages: 5 },
    isLoading: false,
    error: null,
  });
}

describe('PagePreviewModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (usePdfDocument as jest.Mock).mockReturnValue({
      document: null,
      isLoading: false,
      error: null,
    });
  });

  it('renders modal when isOpen=true with correct data-testid', () => {
    renderModal();

    expect(screen.getByTestId('pdf-preview-modal')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-preview-modal-close')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-preview-canvas')).toBeInTheDocument();
  });

  it('does NOT render when isOpen=false', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByTestId('pdf-preview-modal')).not.toBeInTheDocument();
  });

  it('calls onClose when Escape pressed', () => {
    const onClose = jest.fn();
    renderModal({ onClose });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = jest.fn();
    renderModal({ onClose });

    const backdrop = screen.getByTestId('pdf-preview-modal');
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when modal content clicked', () => {
    const onClose = jest.fn();
    renderModal({ onClose });

    const closeBtn = screen.getByTestId('pdf-preview-modal-close');
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows source info text', () => {
    renderModal();

    const sourceInfo = screen.getByTestId('pdf-preview-source-info');
    expect(sourceInfo).toHaveTextContent('report.pdf — Page 3');
  });

  it('has correct ARIA attributes', () => {
    renderModal();

    const modal = screen.getByTestId('pdf-preview-modal');
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(modal).toHaveAttribute('aria-label', 'Page preview');
  });

  it('shows loading spinner while document is loading', () => {
    (usePdfDocument as jest.Mock).mockReturnValue({
      document: null,
      isLoading: true,
      error: null,
    });

    renderModal();

    expect(screen.getByTestId('pdf-preview-loading')).toBeInTheDocument();
  });

  it('shows loading spinner while page is rendering', () => {
    mockDocumentLoaded();
    renderModal();

    expect(screen.getByTestId('pdf-preview-loading')).toBeInTheDocument();
  });

  it('hides spinner after render completes', async () => {
    mockDocumentLoaded();
    renderModal();

    await waitFor(() => {
      expect(screen.queryByTestId('pdf-preview-loading')).not.toBeInTheDocument();
    });
  });

  it('close button has correct aria-label', () => {
    renderModal();

    const closeBtn = screen.getByTestId('pdf-preview-modal-close');
    expect(closeBtn).toHaveAttribute('aria-label', 'Close preview');
  });
});
