import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PageThumbnail, PageThumbnailProps } from '../PageThumbnail';
import type { OverlayTextBox } from '../../../shared/types/pdf';

jest.mock('../../hooks/usePdfDocument', () => ({
  usePdfDocument: jest.fn(() => ({
    document: { numPages: 5 },
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

const { useThumbnailRenderer } = jest.requireMock('../../hooks/useThumbnailRenderer');

const defaultProps: PageThumbnailProps = {
  pageId: 'page-1',
  fileUrl: '/api/pdf/sessions/sess-1/files/file-1',
  sourcePageIndex: 2,
  rotation: 0,
  assemblyPosition: 1,
  sourceFileName: 'report.pdf',
  originalPageNumber: 3,
  isSelected: false,
  onSelect: jest.fn(),
  onPreview: jest.fn(),
};

const overlay: OverlayTextBox = {
  id: 'overlay-1',
  pageId: 'page-1',
  x: 10,
  y: 10,
  width: 30,
  height: 10,
  text: 'Text',
  fontFamily: 'Helvetica',
  fontSize: 14,
  bold: false,
  italic: false,
  color: '#000000',
  horizontalAlign: 'left',
  verticalAlign: 'top',
  opacity: 100,
  rotation: 0,
  listStyle: 'none',
  zIndex: 1,
};

function renderThumbnail(overrides: Partial<PageThumbnailProps> = {}) {
  return render(<PageThumbnail {...defaultProps} {...overrides} />);
}

describe('PageThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useThumbnailRenderer as jest.Mock).mockReturnValue({
      status: 'loaded',
      imageBitmap: null,
      error: null,
    });
  });

  it('renders assembly position badge', () => {
    renderThumbnail();
    const badge = screen.getByTestId('pdf-thumbnail-position-1');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('1');
  });

  it('renders source info label', () => {
    renderThumbnail();
    const label = screen.getByTestId('pdf-thumbnail-source-1');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('report.pdf p.3');
  });

  it('shows an accessible presence badge when the page has overlays', () => {
    renderThumbnail({ overlays: [overlay] });

    const badge = screen.getByTestId('pdf-tools-overlay-badge');
    expect(badge).toHaveAttribute('data-page-id', 'page-1');
    expect(badge).toHaveAccessibleName('Page has text overlays');
  });

  it('does not show the overlay badge when the page has no overlays', () => {
    renderThumbnail({ overlays: [] });

    expect(
      screen.queryByTestId('pdf-tools-overlay-badge')
    ).not.toBeInTheDocument();
  });

  it('keeps a badged thumbnail as page selection rather than an edit surface', () => {
    const onSelect = jest.fn();
    renderThumbnail({ overlays: [overlay], onSelect });

    fireEvent.click(screen.getByTestId('pdf-tools-overlay-badge'));

    expect(onSelect).toHaveBeenCalledWith('page-1', false, false);
  });

  it('calls onSelect with pageId on single click', () => {
    const onSelect = jest.fn();
    renderThumbnail({ onSelect });
    const card = screen.getByTestId('pdf-thumbnail-1');

    fireEvent.click(card);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('page-1', false, false);
  });

  it('calls onPreview with pageId when double-clicked', () => {
    const onPreview = jest.fn();
    renderThumbnail({ onPreview });
    const card = screen.getByTestId('pdf-thumbnail-1');

    fireEvent.dblClick(card);

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith('page-1');
  });

  it('calls onSelect with shiftKey=true on shift+click', () => {
    const onSelect = jest.fn();
    renderThumbnail({ onSelect });
    const card = screen.getByTestId('pdf-thumbnail-1');

    fireEvent.click(card, { shiftKey: true });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('page-1', true, false);
  });

  it('calls onPreview when Enter key pressed', () => {
    const onPreview = jest.fn();
    renderThumbnail({ onPreview });
    const card = screen.getByTestId('pdf-thumbnail-1');

    fireEvent.keyDown(card, { key: 'Enter' });

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith('page-1');
  });

  it('shows loading skeleton when thumbnail is loading', () => {
    (useThumbnailRenderer as jest.Mock).mockReturnValue({
      status: 'loading',
      imageBitmap: null,
      error: null,
    });

    renderThumbnail();

    expect(screen.getByTestId('thumbnail-skeleton')).toBeInTheDocument();
  });

  it('shows selected state via aria-selected', () => {
    renderThumbnail({ isSelected: true });
    const card = screen.getByTestId('pdf-thumbnail-1');
    expect(card).toHaveAttribute('aria-selected', 'true');
  });

  it('has correct aria-label', () => {
    renderThumbnail();
    const card = screen.getByTestId('pdf-thumbnail-1');
    expect(card).toHaveAttribute(
      'aria-label',
      '1 — report.pdf page 3. Click to select, double-click to preview.',
    );
  });

  it('detects a blank page after drawing the rendered bitmap', async () => {
    const pixels = new Uint8ClampedArray(180 * 233 * 4);
    const context = {
      drawImage: jest.fn(() => {
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = 255;
          pixels[i + 1] = 255;
          pixels[i + 2] = 255;
          pixels[i + 3] = 255;
        }
      }),
      getImageData: jest.fn(() => ({
        data: pixels,
        width: 180,
        height: 233,
      })),
    };
    const getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const imageBitmap = {
      width: 180,
      height: 233,
      close: jest.fn(),
    } as unknown as ImageBitmap;

    try {
      const view = renderThumbnail();
      (useThumbnailRenderer as jest.Mock).mockReturnValue({
        status: 'loaded',
        imageBitmap,
        error: null,
      });

      view.rerender(<PageThumbnail {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('blank-page-badge-0')).toBeInTheDocument();
      });
      expect(context.drawImage).toHaveBeenCalled();
    } finally {
      getContextSpy.mockRestore();
    }
  });

  it('does not show a blank badge when the PDF page contains text', async () => {
    const pixels = new Uint8ClampedArray(180 * 233 * 4).fill(255);
    const context = {
      drawImage: jest.fn(),
      getImageData: jest.fn(() => ({
        data: pixels,
        width: 180,
        height: 233,
      })),
    };
    const getContextSpy = jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const imageBitmap = {
      width: 180,
      height: 233,
      close: jest.fn(),
    } as unknown as ImageBitmap;

    try {
      (useThumbnailRenderer as jest.Mock).mockReturnValue({
        status: 'loaded',
        imageBitmap,
        hasTextContent: true,
        error: null,
      });

      renderThumbnail();

      await waitFor(() => {
        expect(context.drawImage).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('blank-page-badge-0')).not.toBeInTheDocument();
    } finally {
      getContextSpy.mockRestore();
    }
  });

  it('shows error state when rendering fails', () => {
    (useThumbnailRenderer as jest.Mock).mockReturnValue({
      status: 'error',
      imageBitmap: null,
      error: new Error('render failed'),
    });

    renderThumbnail();

    expect(screen.getByTestId('thumbnail-error')).toBeInTheDocument();
  });

  it('sets aria-selected to false when not selected', () => {
    renderThumbnail({ isSelected: false });
    const card = screen.getByTestId('pdf-thumbnail-1');
    expect(card).toHaveAttribute('aria-selected', 'false');
  });
});
