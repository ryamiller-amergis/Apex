import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssemblyLane } from '../AssemblyLane';
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

jest.mock('../ManipulationToolbar', () => ({
  ManipulationToolbar: (props: Record<string, unknown>) => (
    <div
      data-testid="manipulation-toolbar"
      data-selected-count={props.selectedCount}
      data-can-move-up={String(props.canMoveUp)}
      data-can-move-down={String(props.canMoveDown)}
      data-has-unsaved={String(props.hasUnsavedChanges)}
    />
  ),
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

function makePages(count: number, fileId = 'file-1'): PageManifestEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    pageId: `p${i + 1}`,
    fileId,
    sourcePageIndex: i,
    rotation: 0 as const,
    deleted: false,
  }));
}

const defaultColors = new Map([
  ['file-1', { bg: '#e3f2fd', border: '#1976d2', text: '#0d47a1', label: 'report.pdf' }],
  ['file-2', { bg: '#fce4ec', border: '#c62828', text: '#b71c1c', label: 'invoice.pdf' }],
]);

const defaultProps = {
  sessionId: 'sess-1',
  localManifest: makePages(3),
  visiblePages: makePages(3),
  fileMetadata: mockFileMetadata,
  documentColors: defaultColors,
  isSelected: () => false,
  selectedCount: 0,
  onSelect: jest.fn(),
  onReorder: jest.fn(),
  onRotate: jest.fn(),
  onDelete: jest.fn(),
  onMoveUp: jest.fn(),
  onMoveDown: jest.fn(),
  canMoveUp: false,
  canMoveDown: false,
  onSave: jest.fn(),
  hasUnsavedChanges: false,
  activePageId: null,
  onActivePage: jest.fn(),
  onPreview: jest.fn(),
  justMovedPageId: null,
};

beforeAll(() => {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('AssemblyLane', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders empty state when visiblePages is empty', () => {
    render(<AssemblyLane {...defaultProps} visiblePages={[]} />);

    expect(screen.getByText(/drag pages from the source panel/i)).toBeInTheDocument();
    expect(screen.getByText(/or upload documents to get started/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mock-grid')).not.toBeInTheDocument();
  });

  it('renders correct number of thumbnails when visiblePages has items', () => {
    render(<AssemblyLane {...defaultProps} />);

    expect(screen.getByTestId('mock-grid')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-1')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-2')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-thumbnail-3')).toBeInTheDocument();
  });

  it('ManipulationToolbar receives correct props', () => {
    render(
      <AssemblyLane
        {...defaultProps}
        selectedCount={2}
        canMoveUp={true}
        canMoveDown={false}
        hasUnsavedChanges={true}
      />,
    );

    const toolbar = screen.getByTestId('manipulation-toolbar');
    expect(toolbar).toHaveAttribute('data-selected-count', '2');
    expect(toolbar).toHaveAttribute('data-can-move-up', 'true');
    expect(toolbar).toHaveAttribute('data-can-move-down', 'false');
    expect(toolbar).toHaveAttribute('data-has-unsaved', 'true');
  });

  it('document color border is applied via colorIndicator on thumbnails', () => {
    render(<AssemblyLane {...defaultProps} />);

    const thumbnail = screen.getByTestId('pdf-thumbnail-1');
    expect(thumbnail.style.borderLeftColor).toBe('#1976d2');
  });

  it('has correct accessibility attributes on container', () => {
    render(<AssemblyLane {...defaultProps} />);

    const main = screen.getByRole('main', { name: /page assembly/i });
    expect(main).toBeInTheDocument();
  });

  describe('cross-panel drag from SourceBrowser', () => {
    it('calls onAddFromSource with correct pageId and insertIndex on external drop', () => {
      const onAddFromSource = jest.fn();
      render(
        <AssemblyLane {...defaultProps} onAddFromSource={onAddFromSource} />,
      );

      const firstThumbnail = screen.getByTestId('pdf-thumbnail-1');
      const wrapper = firstThumbnail.closest('[class*="gridCell"]')!;

      fireEvent.dragOver(wrapper, {
        dataTransfer: {
          types: ['application/x-pdf-page'],
          getData: () => 'external-page-1',
        },
      });

      fireEvent.drop(wrapper, {
        dataTransfer: {
          types: ['application/x-pdf-page'],
          getData: () => 'external-page-1',
        },
      });

      expect(onAddFromSource).toHaveBeenCalledWith('external-page-1', expect.any(Number));
    });

    it('accepts external drop on empty state and inserts at index 0', () => {
      const onAddFromSource = jest.fn();
      render(
        <AssemblyLane
          {...defaultProps}
          visiblePages={[]}
          onAddFromSource={onAddFromSource}
        />,
      );

      const emptyState = screen.getByTestId('assembly-lane-empty');

      fireEvent.dragOver(emptyState, {
        dataTransfer: {
          types: ['application/x-pdf-page'],
          getData: () => 'external-page-1',
        },
      });

      fireEvent.drop(emptyState, {
        dataTransfer: {
          types: ['application/x-pdf-page'],
          getData: () => 'external-page-1',
        },
      });

      expect(onAddFromSource).toHaveBeenCalledWith('external-page-1', 0);
    });
  });
});
