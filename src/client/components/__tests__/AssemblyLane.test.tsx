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
    gridRef,
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
    gridRef?: React.MutableRefObject<{
      element: HTMLDivElement;
      scrollToRow: jest.Mock;
    } | null>;
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
    return (
      <div
        data-testid="mock-grid"
        ref={(element) => {
          if (gridRef) {
            gridRef.current = element
              ? { element, scrollToRow: jest.fn() }
              : null;
          }
        }}
      >
        {cells}
      </div>
    );
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
    >
      <button
        type="button"
        data-testid="toolbar-select-all"
        onClick={
          Number(props.selectedCount) === Number(props.totalPages)
            ? props.onDeselectAll as () => void
            : props.onSelectAll as () => void
        }
      >
        Toggle all
      </button>
    </div>
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
  onSelectAll: jest.fn(),
  onDeselectAll: jest.fn(),
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

  it('forwards Select All and Deselect All actions from the toolbar', () => {
    const onSelectAll = jest.fn();
    const onDeselectAll = jest.fn();
    const view = render(
      <AssemblyLane
        {...defaultProps}
        onSelectAll={onSelectAll}
        onDeselectAll={onDeselectAll}
      />,
    );

    fireEvent.click(screen.getByTestId('toolbar-select-all'));
    expect(onSelectAll).toHaveBeenCalledTimes(1);

    view.rerender(
      <AssemblyLane
        {...defaultProps}
        selectedCount={3}
        onSelectAll={onSelectAll}
        onDeselectAll={onDeselectAll}
      />,
    );
    fireEvent.click(screen.getByTestId('toolbar-select-all'));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('renders every converted page when a multi-page Word upload is appended', () => {
    const convertedFile: PdfFileMetadata = {
      fileId: 'word-file',
      originalName: 'converted.docx',
      storedName: 'word-file.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4096,
      pageCount: 3,
      convertedFrom: 'converted.docx',
      uploadedAt: '2026-07-11T00:00:00Z',
    };
    const convertedPages = makePages(3, 'word-file').map((page, index) => ({
      ...page,
      pageId: `word-page-${index + 1}`,
    }));

    const { rerender } = render(
      <AssemblyLane {...defaultProps} visiblePages={[]} localManifest={[]} />,
    );

    rerender(
      <AssemblyLane
        {...defaultProps}
        visiblePages={convertedPages}
        localManifest={convertedPages}
        fileMetadata={[convertedFile]}
      />,
    );

    expect(screen.getByText('converted.docx p.1')).toBeInTheDocument();
    expect(screen.getByText('converted.docx p.2')).toBeInTheDocument();
    expect(screen.getByText('converted.docx p.3')).toBeInTheDocument();
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

  it('preserves the virtualized grid and scroll position after a large reorder', () => {
    const initialPages = makePages(100);
    const onReorder = jest.fn();

    const Harness = () => {
      const [pages, setPages] = React.useState(initialPages);
      const reorder = (fromIndex: number, toIndex: number) => {
        onReorder(fromIndex, toIndex);
        setPages((current) => {
          const next = [...current];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, moved);
          return next;
        });
      };

      return (
        <AssemblyLane
          {...defaultProps}
          localManifest={pages}
          visiblePages={pages}
          onReorder={reorder}
        />
      );
    };

    render(<Harness />);

    const gridBefore = screen.getByTestId('mock-grid');
    gridBefore.scrollTop = 2400;
    gridBefore.scrollLeft = 12;

    const source = screen.getByTestId('pdf-thumbnail-90');
    const target = screen.getByTestId('pdf-thumbnail-95');
    jest.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 200,
      width: 100,
      height: 200,
      toJSON: () => ({}),
    });

    const gridContainer = gridBefore.closest('[class*="gridContainer"]') as HTMLElement;
    jest.spyOn(gridContainer, 'getBoundingClientRect').mockReturnValue({
      x: -500,
      y: 0,
      top: 0,
      left: -500,
      right: 1500,
      bottom: 1000,
      width: 2000,
      height: 1000,
      toJSON: () => ({}),
    });

    const dataTransfer = {
      types: ['text/plain'],
      effectAllowed: 'move',
      dropEffect: 'move',
      setData: jest.fn(),
      getData: jest.fn(),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientX: 10, clientY: 500 });
    fireEvent.drop(target, { dataTransfer, clientX: 10, clientY: 500 });

    expect(onReorder).toHaveBeenCalledWith(89, 94);
    expect(screen.getByTestId('mock-grid')).toBe(gridBefore);
    expect(gridBefore.scrollTop).toBe(2400);
    expect(gridBefore.scrollLeft).toBe(12);
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
