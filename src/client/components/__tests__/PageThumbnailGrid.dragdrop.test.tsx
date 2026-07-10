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
    pageCount: 5,
    uploadedAt: '2025-01-01T00:00:00Z',
  },
];

beforeAll(() => {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeManifest(count: number): PageManifestEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    pageId: `p${i + 1}`,
    fileId: 'file-1',
    sourcePageIndex: i,
    rotation: 0 as const,
    deleted: false,
  }));
}

describe('PageThumbnailGrid drag-and-drop', () => {
  const defaultProps = {
    sessionId: 'sess-1',
    fileMetadata: mockFileMetadata,
    onPreview: jest.fn(),
    isSelected: () => false,
    onSelect: jest.fn(),
  };

  it('thumbnails are draggable', () => {
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(3)}
      />,
    );

    const thumbnail = screen.getByTestId('pdf-thumbnail-1');
    expect(thumbnail).toHaveAttribute('draggable', 'true');
  });

  // AC#1: drag page 5 to position 2 calls onReorder(4, 1)
  it('calls onReorder with correct indices when dragging page 5 to position 2', () => {
    const onReorder = jest.fn();
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(5)}
        onReorder={onReorder}
      />,
    );

    const source = screen.getByTestId('pdf-thumbnail-5');
    const target = screen.getByTestId('pdf-thumbnail-2');

    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: '', setData: jest.fn() },
    });
    fireEvent.dragOver(target, {
      dataTransfer: { dropEffect: '' },
      preventDefault: jest.fn(),
    });
    fireEvent.drop(target, {
      dataTransfer: { getData: () => 'p5' },
      preventDefault: jest.fn(),
    });

    expect(onReorder).toHaveBeenCalledWith(4, 1);
  });

  // AC#3: single page — drag allowed but no reorder effect
  it('allows drag on single page but does not call onReorder', () => {
    const onReorder = jest.fn();
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(1)}
        onReorder={onReorder}
      />,
    );

    const thumbnail = screen.getByTestId('pdf-thumbnail-1');
    expect(thumbnail).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(thumbnail, {
      dataTransfer: { effectAllowed: '', setData: jest.fn() },
    });
    fireEvent.drop(thumbnail, {
      dataTransfer: { getData: () => 'p1' },
      preventDefault: jest.fn(),
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('dragging to same position does not call onReorder', () => {
    const onReorder = jest.fn();
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(3)}
        onReorder={onReorder}
      />,
    );

    const source = screen.getByTestId('pdf-thumbnail-2');

    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: '', setData: jest.fn() },
    });
    fireEvent.drop(source, {
      dataTransfer: { getData: () => 'p2' },
      preventDefault: jest.fn(),
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('does not call onReorder when onReorder prop is not provided', () => {
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(3)}
      />,
    );

    const source = screen.getByTestId('pdf-thumbnail-1');
    const target = screen.getByTestId('pdf-thumbnail-3');

    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: '', setData: jest.fn() },
    });
    fireEvent.drop(target, {
      dataTransfer: { getData: () => 'p1' },
      preventDefault: jest.fn(),
    });

    // No error thrown, no crash
  });

  it('clears drag state on dragEnd', () => {
    const onReorder = jest.fn();
    render(
      <PageThumbnailGrid
        {...defaultProps}
        pageManifest={makeManifest(3)}
        onReorder={onReorder}
      />,
    );

    const source = screen.getByTestId('pdf-thumbnail-1');

    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: '', setData: jest.fn() },
    });
    fireEvent.dragEnd(source);

    // After dragEnd without drop, onReorder should not be called
    expect(onReorder).not.toHaveBeenCalled();
  });
});
