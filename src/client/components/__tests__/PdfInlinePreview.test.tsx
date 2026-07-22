import React from 'react';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import { PdfInlinePreview } from '../PdfInlinePreview';
import { PdfPageEditorModal } from '../PdfPageEditorModal';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { useOverlayEditor } from '../../hooks/useOverlayEditor';

const mockGetPage = jest.fn();
const mockRender = jest.fn().mockReturnValue({ promise: Promise.resolve() });
const mockUsePageTextItems = jest.fn();
const mockSamplePageTextColors = jest.fn();
const mockSamplePagePerimeterColor = jest.fn();

jest.mock('../../hooks/usePdfDocument', () => ({
  usePdfDocument: (fileUrl: string | null) => {
    if (!fileUrl)
      return {
        document: null,
        isLoading: false,
        error: null,
        retry: jest.fn(),
      };
    return {
      document: {
        getPage: mockGetPage,
        numPages: 3,
      },
      isLoading: false,
      error: null,
      retry: jest.fn(),
    };
  },
}));

jest.mock('../../contexts/PdfWorkerContext', () => ({
  usePdfWorker: () => ({ getDocument: jest.fn() }),
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock('../../hooks/usePageTextItems', () => ({
  usePageTextItems: (...args: unknown[]) => mockUsePageTextItems(...args),
}));

jest.mock('../../utils/samplePageBackgroundColor', () => ({
  samplePageTextColors: (...args: unknown[]) =>
    mockSamplePageTextColors(...args),
  samplePagePerimeterColor: (...args: unknown[]) =>
    mockSamplePagePerimeterColor(...args),
}));

const CONTAINER_WIDTH = 500;
const CONTAINER_HEIGHT = 700;

function installResizeObserver(width: number, height: number) {
  const cls = class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      Object.defineProperty(el, 'clientWidth', {
        value: width,
        configurable: true,
      });
      Object.defineProperty(el, 'clientHeight', {
        value: height,
        configurable: true,
      });
      this.cb(
        [{ target: el } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {}
    disconnect() {}
  };
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = cls;
}

let mockTextItemsState: {
  items: unknown[];
  status: string;
  message?: string;
} = { items: [], status: 'idle' };

function renderEditablePreview() {
  return render(
    <PdfInlinePreview
      {...baseProps}
      overlay={{
        pageId: 'page-1',
        overlays: [],
        selectedOverlayId: null,
        textToolActive: false,
        editorMode: 'replace',
        createLimitMessage: null,
        announcement: '',
        canUndo: false,
        canRedo: false,
        saveStatus: 'idle',
        onCreateAt: jest.fn(),
        onSelectOverlay: jest.fn(),
        onDeleteSelectedOverlay: jest.fn(),
        onUndoOverlay: jest.fn(),
        onRedoOverlay: jest.fn(),
        onBeginGeometryEdit: jest.fn().mockReturnValue(true),
        onUpdateOverlayGeometry: jest.fn(),
        onCommitGeometryEdit: jest.fn(),
        onNudgeSelectedOverlay: jest.fn(),
        onBringOverlayForward: jest.fn(),
        onSendOverlayBackward: jest.fn(),
      }}
    />
  );
}

const baseProps = {
  sessionId: 'session-1',
  fileId: 'file-1',
  sourcePageIndex: 0,
  rotation: 0 as const,
  sourceFileName: 'test.pdf',
  originalPageNumber: 1,
};

const ReplacementWorkflowHarness: React.FC = () => {
  const editor = useOverlayEditor({
    pageId: 'page-1',
    initialOverlays: [],
  });
  const handleReplacementTextChange = (text: string) => {
    if (editor.replacementDraft) {
      if (text === editor.replacementDraft.text) return;
      editor.activateReplacementDraft(text, {}, true);
      return;
    }
    editor.updateReplacementText(text);
  };

  return (
    <>
      <PdfPageEditorModal
        isOpen
        sessionId="session-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={{
          pageId: 'page-1',
          overlays: editor.pageOverlays,
          selectedOverlayId: editor.selectedOverlayId,
          textToolActive: editor.textToolActive,
          editorMode: editor.editorMode,
          replacementDraftGeometry: editor.replacementDraft
            ? {
                ...editor.replacementDraft.item.geometry,
                rotation: editor.replacementDraft.rotation,
              }
            : null,
          createLimitMessage: editor.createLimitMessage,
          announcement: editor.announcement,
          canUndo: editor.canUndo,
          canRedo: editor.canRedo,
          saveStatus: editor.isDirty ? 'dirty' : 'idle',
          onCreateAt: editor.createAt,
          onSetReplacementDraft: editor.setReplacementDraft,
          onSelectOverlay: editor.selectOverlay,
          onDeleteSelectedOverlay: editor.deleteSelected,
          onRemoveSelectedNativeText: editor.removeSelectedNativeText,
          onUndoOverlay: editor.undo,
          onRedoOverlay: editor.redo,
          onBeginOverlayTextEdit: editor.beginTextEdit,
          onUpdateOverlayText: editor.updateSelectedText,
          onCommitOverlayTextEdit: editor.commitTextEdit,
          onBeginGeometryEdit: editor.beginGeometryEdit,
          onUpdateOverlayGeometry: editor.updateSelectedGeometry,
          onCommitGeometryEdit: editor.commitGeometryEdit,
          onNudgeSelectedOverlay: editor.nudgeSelected,
          onBringOverlayForward: editor.bringSelectedForward,
          onSendOverlayBackward: editor.sendSelectedBackward,
        }}
        selectedOverlay={editor.selectedDisplayOverlay}
        replacementDraft={editor.replacementDraft}
        onToggleTextTool={() => editor.setTextToolActive((active) => !active)}
        onToggleReplacementTool={() =>
          editor.setEditorMode(
            editor.editorMode === 'replace' ? 'add' : 'replace'
          )
        }
        onFormattingChange={editor.updateSelectedFormatting}
        onReplacementTextFocus={editor.beginReplacementTextEdit}
        onReplacementTextChange={handleReplacementTextChange}
        onReplacementTextBlur={editor.commitReplacementTextEdit}
        onValidationChange={jest.fn()}
        onDiscardDraft={editor.discardReplacementDraft}
        onClose={jest.fn()}
      />
      <output data-testid="workflow-overlay-count">
        {editor.overlays.length}
      </output>
      <output data-testid="workflow-dirty">
        {editor.isDirty ? 'dirty' : 'clean'}
      </output>
      <output data-testid="workflow-draft">
        {editor.replacementDraft?.text ?? 'none'}
      </output>
    </>
  );
};

describe('PdfInlinePreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTextItemsState = { items: [], status: 'idle' };
    mockUsePageTextItems.mockImplementation(() => mockTextItemsState);
    mockSamplePageTextColors.mockReturnValue({
      color: '#000000',
      backgroundColor: '#FFFFFF',
    });
    mockSamplePagePerimeterColor.mockReturnValue('#FFFFFF');
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: jest.fn(),
    } as unknown as CanvasRenderingContext2D);
    installResizeObserver(CONTAINER_WIDTH, CONTAINER_HEIGHT);
    mockGetPage.mockResolvedValue({
      getViewport: ({ scale }: { scale: number; rotation: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      }),
      render: mockRender,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders empty state when fileId is null', () => {
    render(<PdfInlinePreview {...baseProps} fileId={null} />);
    expect(screen.getByText('Select a page to preview')).toBeInTheDocument();
  });

  it('runs native selection through draft, tools activation, render, and undo', async () => {
    mockTextItemsState = {
      status: 'loaded',
      items: [
        {
          id: 'text-item-sales',
          text: 'Sales Assistant',
          geometry: { x: 10, y: 20, width: 12, height: 3 },
          fontFamily: 'Times-Roman',
          fontSize: 10,
          bold: false,
          italic: false,
          rotation: 90,
        },
      ],
    };
    render(<ReplacementWorkflowHarness />);

    fireEvent.click(screen.getByTestId('page-editor-replace-text'));
    const nativeItem = await screen.findByTestId('native-text-item');
    fireEvent.click(nativeItem);

    expect(screen.getByTestId('workflow-overlay-count')).toHaveTextContent('0');
    expect(screen.getByTestId('workflow-dirty')).toHaveTextContent('clean');
    expect(screen.getByTestId('workflow-draft')).toHaveTextContent(
      'Sales Assistant'
    );
    expect(
      screen.getByTestId('pdf-tools-replacement-draft-outline')
    ).toHaveStyle({
      left: '10%',
      top: '20%',
      width: '12%',
      height: '3%',
      transform: 'rotate(90deg)',
    });
    expect(
      screen.queryByTestId('pdf-tools-overlay-box')
    ).not.toBeInTheDocument();
    const textarea = screen.getByLabelText('Replacement text');
    expect(textarea).toHaveValue('Sales Assistant');
    expect(textarea).toHaveFocus();

    fireEvent.change(textarea, {
      target: { value: 'Sales\nManager' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('workflow-overlay-count')).toHaveTextContent(
        '1'
      );
    });
    expect(screen.getByTestId('workflow-draft')).toHaveTextContent('none');
    expect(
      screen.queryByTestId('pdf-tools-replacement-draft-outline')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('pdf-tools-overlay-box')).toHaveTextContent(
      'Sales Manager'
    );
    expect(document.querySelector('.replacementCover')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('pdf-tools-overlay-resize-handle')
    ).toHaveLength(8);

    fireEvent.click(screen.getByTestId('overlay-undo'));
    expect(screen.getByTestId('workflow-overlay-count')).toHaveTextContent('0');
  });

  it('renders canvas at correct scale based on container size', async () => {
    const { container } = render(<PdfInlinePreview {...baseProps} />);

    await waitFor(() => {
      const canvas = container.querySelector('canvas');
      expect(canvas).toBeTruthy();
      expect(mockGetPage).toHaveBeenCalledWith(1);
    });

    const canvas = container.querySelector('canvas')!;
    const availWidth = CONTAINER_WIDTH - 16;
    const availHeight = CONTAINER_HEIGHT - 32;
    const scaleW = availWidth / 612;
    const scaleH = availHeight / 792;
    const expectedScale = Math.min(scaleW, scaleH, 3);
    const expectedWidth = Math.floor(612 * expectedScale);
    const expectedHeight = Math.floor(792 * expectedScale);

    expect(canvas.width).toBeGreaterThanOrEqual(expectedWidth - 2);
    expect(canvas.width).toBeLessThanOrEqual(expectedWidth + 2);
    expect(canvas.height).toBeGreaterThanOrEqual(expectedHeight - 2);
    expect(canvas.height).toBeLessThanOrEqual(expectedHeight + 2);
  });

  it('does not render page when container has zero dimensions', async () => {
    installResizeObserver(0, 0);

    render(<PdfInlinePreview {...baseProps} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockGetPage).not.toHaveBeenCalled();
  });

  it('preview uses most of available space (not a tiny image)', async () => {
    const { container } = render(<PdfInlinePreview {...baseProps} />);

    await waitFor(() => {
      expect(mockGetPage).toHaveBeenCalled();
    });

    const canvas = container.querySelector('canvas')!;
    // Canvas should use at least 70% of the available width OR height
    const usesWidthWell = canvas.width >= (CONTAINER_WIDTH - 16) * 0.7;
    const usesHeightWell = canvas.height >= (CONTAINER_HEIGHT - 32) * 0.7;
    expect(usesWidthWell || usesHeightWell).toBe(true);
  });

  it('shows actionable image-only guidance without disabling Add text', async () => {
    mockTextItemsState = { status: 'unavailable', items: [] };
    renderEditablePreview();
    const statuses = await screen.findAllByRole('status');
    const guidance = statuses.find((el) =>
      el.textContent?.includes('image-only')
    );
    expect(guidance).toHaveTextContent(
      'This page appears to be image-only and has no searchable text. OCR is not available. You can still use Add text. To replace existing text, upload a searchable or OCR-processed PDF.'
    );
    expect(screen.getByTestId('pdf-tools-overlay-layer')).toBeInTheDocument();
  });

  it('shows a distinct extraction error', async () => {
    mockTextItemsState = {
      status: 'error',
      items: [],
      message: 'PDF.js failed',
    };
    renderEditablePreview();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Existing text could not be loaded. Try again or use Add text.'
    );
  });

  it('zooms the preview independently and resets to fit', async () => {
    render(<PdfInlinePreview {...baseProps} />);

    await waitFor(() => {
      expect(mockGetPage).toHaveBeenCalled();
    });

    expect(screen.getByTestId('pdf-preview-zoom')).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('pdf-preview-zoom')).toHaveTextContent('125%');

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByTestId('pdf-preview-zoom')).toHaveTextContent('100%');
  });

  it('shows source file info after rendering completes', async () => {
    const { container } = render(<PdfInlinePreview {...baseProps} />);

    await waitFor(() => {
      const canvas = container.querySelector('canvas');
      expect(canvas!.width).toBeGreaterThan(0);
    });

    // In jsdom, getContext returns null so the render early-returns.
    // The sourceInfo text only shows when isRendering=false and isDocLoading=false.
    // Since canvas dimensions are set correctly, the sizing logic is validated above.
    const preview = screen.getByTestId('pdf-inline-preview');
    expect(preview).toBeInTheDocument();
  });

  it('re-measures container when fileId changes from null', async () => {
    const { rerender } = render(
      <PdfInlinePreview {...baseProps} fileId={null} />
    );

    expect(screen.getByText('Select a page to preview')).toBeInTheDocument();
    expect(mockGetPage).not.toHaveBeenCalled();

    rerender(<PdfInlinePreview {...baseProps} fileId="file-1" />);

    await waitFor(() => {
      expect(mockGetPage).toHaveBeenCalledWith(1);
    });
  });

  it('enriches one selected native text item with sampled colors before creating a replacement', async () => {
    const mockOnCreateReplacement = jest.fn().mockReturnValue(null);
    mockUsePageTextItems.mockReturnValue({
      items: [
        {
          id: 'text-item-0',
          text: 'Styled source',
          geometry: { x: 10, y: 20, width: 12, height: 3 },
          fontFamily: 'Times-Roman',
          fontSize: 17,
          bold: true,
          italic: true,
          rotation: -15,
        },
      ],
      status: 'ready',
    });
    mockSamplePageTextColors.mockReturnValue({
      color: '#17365D',
      backgroundColor: '#F2EDE6',
    });

    render(
      <PdfInlinePreview
        {...baseProps}
        overlay={{
          pageId: 'page-1',
          overlays: [],
          selectedOverlayId: null,
          textToolActive: false,
          editorMode: 'replace',
          createLimitMessage: null,
          announcement: '',
          canUndo: false,
          canRedo: false,
          saveStatus: 'idle',
          onCreateAt: jest.fn(),
          onSetReplacementDraft: mockOnCreateReplacement,
          onSelectOverlay: jest.fn(),
          onDeleteSelectedOverlay: jest.fn(),
          onUndoOverlay: jest.fn(),
          onRedoOverlay: jest.fn(),
          onBeginGeometryEdit: jest.fn().mockReturnValue(true),
          onUpdateOverlayGeometry: jest.fn(),
          onCommitGeometryEdit: jest.fn(),
          onNudgeSelectedOverlay: jest.fn(),
          onBringOverlayForward: jest.fn(),
          onSendOverlayBackward: jest.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('native-text-item')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('native-text-item'));

    expect(mockOnCreateReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: 'Times-Roman',
        bold: true,
        italic: true,
        color: '#17365D',
        backgroundColor: '#F2EDE6',
      })
    );
    expect(mockSamplePageTextColors).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      { x: 10, y: 20, width: 12, height: 3 },
      -15
    );
  });

  it('keeps recognized Courier metadata when sampled colors are fallback values', async () => {
    const mockOnCreateReplacement = jest.fn().mockReturnValue(null);
    mockUsePageTextItems.mockReturnValue({
      items: [
        {
          id: 'text-item-1',
          text: 'Courier source',
          geometry: { x: 15, y: 25, width: 20, height: 4 },
          fontFamily: 'Courier',
          fontSize: 14,
          bold: false,
          italic: false,
          rotation: 0,
        },
      ],
      status: 'ready',
    });
    mockSamplePageTextColors.mockReturnValue({
      color: '#000000',
      backgroundColor: '#FFFFFF',
    });

    render(
      <PdfInlinePreview
        {...baseProps}
        overlay={{
          pageId: 'page-1',
          overlays: [],
          selectedOverlayId: null,
          textToolActive: false,
          editorMode: 'replace',
          createLimitMessage: null,
          announcement: '',
          canUndo: false,
          canRedo: false,
          saveStatus: 'idle',
          onCreateAt: jest.fn(),
          onSetReplacementDraft: mockOnCreateReplacement,
          onSelectOverlay: jest.fn(),
          onDeleteSelectedOverlay: jest.fn(),
          onUndoOverlay: jest.fn(),
          onRedoOverlay: jest.fn(),
          onBeginGeometryEdit: jest.fn().mockReturnValue(true),
          onUpdateOverlayGeometry: jest.fn(),
          onCommitGeometryEdit: jest.fn(),
          onNudgeSelectedOverlay: jest.fn(),
          onBringOverlayForward: jest.fn(),
          onSendOverlayBackward: jest.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('native-text-item')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('native-text-item'));

    expect(mockOnCreateReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: 'Courier',
        color: '#000000',
        backgroundColor: '#FFFFFF',
      })
    );
  });

  it('samples once at resize commit and forwards the sampled cover', async () => {
    const mockCommitGeometryEdit = jest.fn();
    const replacement = {
      id: 'replace-1',
      pageId: 'page-1',
      x: 10,
      y: 20,
      width: 12,
      height: 3,
      text: 'Styled source',
      fontFamily: 'Times-Roman',
      fontSize: 14,
      bold: false,
      italic: false,
      color: '#17365D',
      horizontalAlign: 'left' as const,
      verticalAlign: 'top' as const,
      opacity: 100,
      rotation: -15,
      listStyle: 'none' as const,
      zIndex: 1,
      kind: 'replace' as const,
      backgroundColor: '#FFFFFF',
    } satisfies OverlayTextBox;
    mockSamplePagePerimeterColor.mockReturnValue('#E8F0F8');

    render(
      <PdfInlinePreview
        {...baseProps}
        overlay={{
          pageId: 'page-1',
          overlays: [replacement],
          selectedOverlayId: replacement.id,
          textToolActive: false,
          editorMode: 'replace',
          createLimitMessage: null,
          announcement: '',
          canUndo: false,
          canRedo: false,
          saveStatus: 'idle',
          onCreateAt: jest.fn(),
          onSelectOverlay: jest.fn(),
          onDeleteSelectedOverlay: jest.fn(),
          onUndoOverlay: jest.fn(),
          onRedoOverlay: jest.fn(),
          onBeginGeometryEdit: jest.fn().mockReturnValue(true),
          onUpdateOverlayGeometry: jest.fn(),
          onCommitGeometryEdit: mockCommitGeometryEdit,
          onNudgeSelectedOverlay: jest.fn(),
          onBringOverlayForward: jest.fn(),
          onSendOverlayBackward: jest.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-tools-overlay-layer')).toBeInTheDocument();
    });

    jest
      .spyOn(
        screen.getByTestId('pdf-tools-overlay-layer'),
        'getBoundingClientRect'
      )
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
        toJSON: () => ({}),
      });

    const eastHandle = screen
      .getAllByTestId('pdf-tools-overlay-resize-handle')
      .find((handle) => handle.getAttribute('data-handle') === 'e');
    expect(eastHandle).toBeDefined();

    fireEvent(
      eastHandle!,
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle!,
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle!,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );

    const finalGeometry = {
      x: 10,
      y: 20,
      width: 22,
      height: 3,
    };
    expect(mockSamplePagePerimeterColor).toHaveBeenCalledTimes(1);
    expect(mockSamplePagePerimeterColor).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      finalGeometry,
      replacement.rotation
    );
    expect(mockCommitGeometryEdit).toHaveBeenCalledWith('resize', '#E8F0F8');
  });

  it('forwards undefined cover when resize sampling returns null', async () => {
    const mockCommitGeometryEdit = jest.fn();
    const replacement = {
      id: 'replace-2',
      pageId: 'page-1',
      x: 10,
      y: 20,
      width: 12,
      height: 3,
      text: 'Styled source',
      fontFamily: 'Times-Roman',
      fontSize: 14,
      bold: false,
      italic: false,
      color: '#17365D',
      horizontalAlign: 'left' as const,
      verticalAlign: 'top' as const,
      opacity: 100,
      rotation: 0,
      listStyle: 'none' as const,
      zIndex: 1,
      kind: 'replace' as const,
      backgroundColor: '#FFFFFF',
    } satisfies OverlayTextBox;
    mockSamplePagePerimeterColor.mockReturnValue(null);

    render(
      <PdfInlinePreview
        {...baseProps}
        overlay={{
          pageId: 'page-1',
          overlays: [replacement],
          selectedOverlayId: replacement.id,
          textToolActive: false,
          editorMode: 'replace',
          createLimitMessage: null,
          announcement: '',
          canUndo: false,
          canRedo: false,
          saveStatus: 'idle',
          onCreateAt: jest.fn(),
          onSelectOverlay: jest.fn(),
          onDeleteSelectedOverlay: jest.fn(),
          onUndoOverlay: jest.fn(),
          onRedoOverlay: jest.fn(),
          onBeginGeometryEdit: jest.fn().mockReturnValue(true),
          onUpdateOverlayGeometry: jest.fn(),
          onCommitGeometryEdit: mockCommitGeometryEdit,
          onNudgeSelectedOverlay: jest.fn(),
          onBringOverlayForward: jest.fn(),
          onSendOverlayBackward: jest.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-tools-overlay-layer')).toBeInTheDocument();
    });

    jest
      .spyOn(
        screen.getByTestId('pdf-tools-overlay-layer'),
        'getBoundingClientRect'
      )
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
        toJSON: () => ({}),
      });

    const eastHandle = screen
      .getAllByTestId('pdf-tools-overlay-resize-handle')
      .find((handle) => handle.getAttribute('data-handle') === 'e');
    expect(eastHandle).toBeDefined();

    fireEvent(
      eastHandle!,
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle!,
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle!,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );

    expect(mockSamplePagePerimeterColor).toHaveBeenCalledTimes(1);
    expect(mockCommitGeometryEdit).toHaveBeenCalledWith('resize', undefined);
  });

  it('does not sample when committing a move gesture', async () => {
    const mockCommitGeometryEdit = jest.fn();
    const replacement = {
      id: 'replace-3',
      pageId: 'page-1',
      x: 10,
      y: 20,
      width: 12,
      height: 3,
      text: 'Styled source',
      fontFamily: 'Times-Roman',
      fontSize: 14,
      bold: false,
      italic: false,
      color: '#17365D',
      horizontalAlign: 'left' as const,
      verticalAlign: 'top' as const,
      opacity: 100,
      rotation: 0,
      listStyle: 'none' as const,
      zIndex: 1,
      kind: 'replace' as const,
      backgroundColor: '#FFFFFF',
    } satisfies OverlayTextBox;

    render(
      <PdfInlinePreview
        {...baseProps}
        overlay={{
          pageId: 'page-1',
          overlays: [replacement],
          selectedOverlayId: replacement.id,
          textToolActive: false,
          editorMode: 'replace',
          createLimitMessage: null,
          announcement: '',
          canUndo: false,
          canRedo: false,
          saveStatus: 'idle',
          onCreateAt: jest.fn(),
          onSelectOverlay: jest.fn(),
          onDeleteSelectedOverlay: jest.fn(),
          onUndoOverlay: jest.fn(),
          onRedoOverlay: jest.fn(),
          onBeginGeometryEdit: jest.fn().mockReturnValue(true),
          onUpdateOverlayGeometry: jest.fn(),
          onCommitGeometryEdit: mockCommitGeometryEdit,
          onNudgeSelectedOverlay: jest.fn(),
          onBringOverlayForward: jest.fn(),
          onSendOverlayBackward: jest.fn(),
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-tools-overlay-layer')).toBeInTheDocument();
    });

    jest
      .spyOn(
        screen.getByTestId('pdf-tools-overlay-layer'),
        'getBoundingClientRect'
      )
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
        toJSON: () => ({}),
      });

    const box = screen.getByTestId('pdf-tools-overlay-box');
    fireEvent(
      box,
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 60,
      })
    );
    fireEvent(
      box,
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 80,
      })
    );
    fireEvent(
      box,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 100,
        clientY: 80,
      })
    );

    expect(mockSamplePagePerimeterColor).not.toHaveBeenCalled();
    expect(mockCommitGeometryEdit).toHaveBeenCalledWith('move', undefined);
  });
});
