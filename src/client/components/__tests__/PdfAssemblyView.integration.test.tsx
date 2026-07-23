import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PdfAssemblyView } from '../PdfAssemblyView';
import type {
  PageManifestEntry,
  PdfFileMetadata,
  PdfSession,
} from '../../../shared/types/pdf';

jest.mock('../../contexts/PdfWorkerContext', () => ({
  usePdfWorker: () => ({ getDocument: jest.fn() }),
  PdfWorkerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock('../SourceBrowser', () => ({
  SourceBrowser: () => <div data-testid="mock-source-browser" />,
}));

jest.mock('../AssemblyLane', () => ({
  AssemblyLane: ({
    onEditPage,
    onSelect,
    visiblePages,
  }: {
    onEditPage: () => void;
    onSelect: (pageId: string, shiftKey: boolean, ctrlKey: boolean) => void;
    visiblePages: PageManifestEntry[];
  }) => (
    <div data-testid="mock-assembly-lane">
      {visiblePages[0] && (
        <button
          type="button"
          data-testid="mock-select-first"
          onClick={() => onSelect(visiblePages[0].pageId, false, false)}
        >
          Select first page
        </button>
      )}
      <button type="button" data-testid="mock-edit-page" onClick={onEditPage}>
        Edit page
      </button>
    </div>
  ),
}));

jest.mock('../PagePreviewModal', () => ({
  PagePreviewModal: () => null,
}));

jest.mock('../PdfInlinePreview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OverlayTextLayer } = require('../OverlayTextLayer');
  return {
    PdfInlinePreview: ({ overlay }: { overlay?: Record<string, unknown> }) => {
      if (!overlay) return <div data-testid="mock-inline-preview" />;
      return (
        <div data-testid="mock-inline-preview">
          <button
            type="button"
            data-testid="trigger-native-select"
            onClick={() => {
              const fn = overlay.onSetReplacementDraft as (
                item: unknown
              ) => void;
              fn?.({
                id: 'text-item-sales',
                text: 'Sales Assistant',
                geometry: { x: 10, y: 20, width: 12, height: 3 },
                fontFamily: 'Times-Roman',
                fontSize: 10,
                bold: false,
                italic: false,
                rotation: 90,
                color: '#17365D',
                backgroundColor: '#F2EDE6',
              });
            }}
          >
            Select native text
          </button>
          <div style={{ position: 'relative', width: 200, height: 200 }}>
            <OverlayTextLayer
              pageId={overlay.pageId}
              overlays={overlay.overlays}
              selectedOverlayId={overlay.selectedOverlayId}
              textToolActive={overlay.textToolActive}
              replacementMode={overlay.editorMode === 'replace'}
              replacementDraftGeometry={overlay.replacementDraftGeometry}
              createLimitMessage={overlay.createLimitMessage}
              announcement={overlay.announcement}
              canUndo={overlay.canUndo}
              canRedo={overlay.canRedo}
              onCreateAt={overlay.onCreateAt}
              onSetReplacementDraft={overlay.onSetReplacementDraft}
              onSelect={overlay.onSelectOverlay}
              onDeleteSelected={overlay.onDeleteSelectedOverlay}
              onUndo={overlay.onUndoOverlay}
              onRedo={overlay.onRedoOverlay}
              onBeginGeometryEdit={overlay.onBeginGeometryEdit}
              onUpdateGeometry={overlay.onUpdateOverlayGeometry}
              onCommitGeometryEdit={overlay.onCommitGeometryEdit}
            />
          </div>
        </div>
      );
    },
  };
});

jest.mock('../../hooks/useDocumentColors', () => ({
  useDocumentColors: () => new Map(),
}));

const mockCreateSession = jest.fn();
const mockUploadFiles = jest.fn();
const mockMutateManifest = jest.fn();
const mockMutateAsyncManifest = jest.fn();
const mockMutateAsyncOverlays = jest.fn();
const mockExportMutate = jest.fn();
let mockSessionData: PdfSession | null = null;

jest.mock('../../hooks/usePdfSession', () => ({
  useCreatePdfSession: () => ({
    mutateAsync: mockCreateSession,
    isPending: false,
    error: null,
  }),
  usePdfSession: (sessionId: string | null) => ({
    data: mockSessionData?.id === sessionId ? mockSessionData : null,
    error: null,
  }),
  useUploadPdfFiles: () => ({
    mutateAsync: mockUploadFiles,
    isPending: false,
  }),
  useActivePdfSessions: () => ({ data: [] }),
  useUpdateManifest: () => ({
    mutate: mockMutateManifest,
    mutateAsync: mockMutateAsyncManifest,
    isPending: false,
  }),
  useUpdateOverlays: () => ({
    mutate: jest.fn(),
    mutateAsync: mockMutateAsyncOverlays,
    isPending: false,
  }),
  useRemovePdfFile: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateFormValues: () => ({
    mutateAsync: jest.fn().mockResolvedValue({ values: [], updatedAt: new Date().toISOString() }),
    isPending: false,
  }),
  useUploadSignatureAsset: () => ({
    mutateAsync: jest.fn().mockResolvedValue({ assetId: 'asset-1', widthPx: 400, heightPx: 160, uploadedAt: new Date().toISOString() }),
    isPending: false,
  }),
  useUpdateSignatureOverlays: () => ({
    mutateAsync: jest.fn().mockResolvedValue({ overlays: [], updatedAt: new Date().toISOString() }),
    isPending: false,
  }),
}));

jest.mock('../../hooks/useExportSession', () => ({
  useExportSession: () => ({
    mutate: mockExportMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  }),
}));

function makeSession(): PdfSession {
  const file: PdfFileMetadata = {
    fileId: 'file-1',
    originalName: 'resume.pdf',
    storedName: 'file-1.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    pageCount: 1,
    uploadedAt: '2026-07-22T12:00:00.000Z',
  };
  const page: PageManifestEntry = {
    pageId: 'page-a',
    fileId: 'file-1',
    sourcePageIndex: 0,
    rotation: 0,
    deleted: false,
  };
  return {
    id: 'sess-integration',
    userId: 'user-1',
    status: 'active',
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    expiresAt: '2026-07-22T16:00:00.000Z',
    fileMetadata: [file],
    pageManifest: [page],
    textOverlays: [],
    conversionJobs: [],
    formFieldValues: [],
    signatureState: { assets: [], overlays: [] },
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

describe('PdfAssemblyView through-line draft integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    sessionStorage.setItem('pdf-active-session', 'sess-integration');
    mockSessionData = makeSession();
    mockMutateAsyncOverlays.mockImplementation(
      ({ overlays }: { overlays: unknown[] }) =>
        Promise.resolve({ overlays, updatedAt: '' })
    );
  });

  it('complete draft workflow: select → no persist → textarea → activate → undo → Done discards', async () => {
    renderWithQuery(<PdfAssemblyView />);

    fireEvent.click(screen.getByTestId('mock-select-first'));
    fireEvent.click(screen.getByTestId('mock-edit-page'));

    expect(screen.getByTestId('pdf-page-editor-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('page-editor-replace-text'));

    const modal = screen.getByTestId('pdf-page-editor-modal');
    const triggerBtn = modal.querySelector(
      '[data-testid="trigger-native-select"]'
    ) as HTMLElement;
    fireEvent.click(triggerBtn);

    expect(mockMutateAsyncOverlays).not.toHaveBeenCalled();

    const textarea = await screen.findByLabelText('Replacement text');
    expect(textarea).toHaveValue('Sales Assistant');
    expect(textarea).toHaveFocus();

    expect(
      modal.querySelector('[data-testid="pdf-tools-overlay-box"]')
    ).toBeNull();

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: 'Marketing Director' } });

    await waitFor(() => {
      expect(
        modal.querySelector('[data-testid="pdf-tools-overlay-box"]')
      ).not.toBeNull();
    });

    expect(
      modal.querySelector('[data-testid="pdf-tools-overlay-box"]')!.textContent
    ).toContain('Marketing Director');
    expect(textarea).toHaveValue('Marketing Director');

    const beforeBoxes = modal.querySelectorAll(
      '[data-testid="pdf-tools-overlay-box"]'
    ).length;
    fireEvent.change(textarea, { target: { value: 'VP Marketing' } });
    await waitFor(() => {
      expect(
        modal.querySelector('[data-testid="pdf-tools-overlay-box"]')!
          .textContent
      ).toContain('VP Marketing');
    });
    expect(
      modal.querySelectorAll('[data-testid="pdf-tools-overlay-box"]').length
    ).toBe(beforeBoxes);

    fireEvent.click(screen.getByTestId('page-editor-done'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('pdf-page-editor-modal')
      ).not.toBeInTheDocument();
    });
  });

  it('Done discards an untouched draft without persisting', async () => {
    renderWithQuery(<PdfAssemblyView />);
    fireEvent.click(screen.getByTestId('mock-select-first'));
    fireEvent.click(screen.getByTestId('mock-edit-page'));
    fireEvent.click(screen.getByTestId('page-editor-replace-text'));
    const modal2 = screen.getByTestId('pdf-page-editor-modal');
    const triggerBtn2 = modal2.querySelector(
      '[data-testid="trigger-native-select"]'
    ) as HTMLElement;
    fireEvent.click(triggerBtn2);

    await screen.findByLabelText('Replacement text');
    expect(mockMutateAsyncOverlays).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-editor-done'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('pdf-page-editor-modal')
      ).not.toBeInTheDocument();
    });
    expect(mockMutateAsyncOverlays).not.toHaveBeenCalled();
  });
});
