import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PageThumbnailGrid } from '../PageThumbnailGrid';
import type { PageManifestEntry, PdfFileMetadata } from '../../../shared/types/pdf';

jest.mock('../../hooks/usePdfDocument', () => ({
  usePdfDocument: jest.fn(() => ({
    document: { numPages: 1 },
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

jest.mock('../../hooks/usePageSelection', () => ({
  usePageSelection: jest.fn(() => ({
    selectedPageIds: new Set<string>(),
    toggleSelection: jest.fn(),
    rangeSelect: jest.fn(),
    clearSelection: jest.fn(),
    isSelected: jest.fn(() => false),
    selectedCount: 0,
  })),
}));

jest.mock('../../contexts/PdfWorkerContext', () => ({
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('react-window', () => ({
  Grid: ({
    cellComponent: CellComponent,
    cellProps,
    columnCount,
    rowCount,
  }: {
    cellComponent: React.ComponentType<{
      ariaAttributes: { 'aria-colindex': number; role: 'gridcell' };
      columnIndex: number;
      rowIndex: number;
      style: React.CSSProperties;
    }>;
    cellProps: Record<string, unknown>;
    columnCount: number;
    rowCount: number;
    columnWidth: number;
    rowHeight: number;
    defaultHeight?: number;
    defaultWidth?: number;
    role?: string;
  }) => {
    const cells: React.ReactNode[] = [];
    for (let row = 0; row < rowCount; row++) {
      for (let col = 0; col < columnCount; col++) {
        cells.push(
          <CellComponent
            key={`${row}-${col}`}
            ariaAttributes={{ 'aria-colindex': col + 1, role: 'gridcell' }}
            rowIndex={row}
            columnIndex={col}
            style={{}}
            {...cellProps}
          />,
        );
      }
    }
    return <div data-testid="mock-grid">{cells}</div>;
  },
}));

const mockFileMetadata: PdfFileMetadata[] = [
  {
    fileId: 'file-1',
    originalName: 'report.pdf',
    storedName: 'stored-1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    pageCount: 3,
    uploadedAt: '2025-01-01T00:00:00Z',
  },
  {
    fileId: 'file-2',
    originalName: 'invoice.pdf',
    storedName: 'stored-2.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    pageCount: 2,
    uploadedAt: '2025-01-02T00:00:00Z',
  },
];

function makeManifest(
  overrides: Partial<PageManifestEntry>[] = [],
): PageManifestEntry[] {
  const defaults: PageManifestEntry[] = [
    { pageId: 'p1', fileId: 'file-1', sourcePageIndex: 0, rotation: 0, deleted: false },
    { pageId: 'p2', fileId: 'file-1', sourcePageIndex: 1, rotation: 0, deleted: false },
    { pageId: 'p3', fileId: 'file-2', sourcePageIndex: 0, rotation: 90, deleted: false },
  ];
  return defaults.map((d, i) => ({ ...d, ...(overrides[i] ?? {}) }));
}

beforeAll(() => {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('PageThumbnailGrid', () => {
  const onPreview = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders correct number of thumbnails for a manifest', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    expect(screen.getByTestId('pdf-thumbnail-grid')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-1')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-2')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-3')).toBeInTheDocument();
  });

  it('filters out deleted pages', () => {
    const manifest = makeManifest([
      {},
      { deleted: true },
      {},
    ]);

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    expect(screen.getByTestId('pdf-thumbnail-1')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-2')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-thumbnail-3')).not.toBeInTheDocument();
  });

  it('constructs correct file URLs', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-42"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    const thumb1 = screen.getByTestId('pdf-thumbnail-source-1');
    expect(thumb1).toHaveTextContent('report.pdf');

    const thumb3 = screen.getByTestId('pdf-thumbnail-source-3');
    expect(thumb3).toHaveTextContent('invoice.pdf');
  });

  it('calls onPreview when a thumbnail is clicked', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    fireEvent.click(screen.getByTestId('pdf-thumbnail-1'));

    expect(onPreview).toHaveBeenCalledWith('p1');
  });

  it('calls onPreview when Enter is pressed on a focused thumbnail', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    const thumb = screen.getByTestId('pdf-thumbnail-2');
    fireEvent.keyDown(thumb, { key: 'Enter' });

    expect(onPreview).toHaveBeenCalledWith('p2');
  });

  it('calls onPreview when Space is pressed on a focused thumbnail', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    const thumb = screen.getByTestId('pdf-thumbnail-3');
    fireEvent.keyDown(thumb, { key: ' ' });

    expect(onPreview).toHaveBeenCalledWith('p3');
  });

  it('does not call onPreview on shift+click (selection mode)', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    fireEvent.click(screen.getByTestId('pdf-thumbnail-1'), { shiftKey: true });

    expect(onPreview).not.toHaveBeenCalled();
  });

  it('thumbnails are focusable via tabIndex', () => {
    const manifest = makeManifest();

    render(
      <PageThumbnailGrid
        sessionId="sess-1"
        pageManifest={manifest}
        fileMetadata={mockFileMetadata}
        onPreview={onPreview}
      />,
    );

    const thumb = screen.getByTestId('pdf-thumbnail-1');
    expect(thumb).toHaveAttribute('tabindex', '0');
  });
});
