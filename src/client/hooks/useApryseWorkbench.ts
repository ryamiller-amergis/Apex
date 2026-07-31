/**
 * useApryseWorkbench
 *
 * Manages the Apryse WebViewer instance with Apex-owned chrome (vendor UI hidden).
 * Surface mirrors useNutrientWorkbench so Nutrient header / rail / floating toolbar
 * can drive both POCs for a fair side-by-side evaluation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import WebViewer from '@pdftron/webviewer';
import { PDFDocument } from 'pdf-lib';
import type {
  WorkbenchActions,
  WorkbenchState,
  WorkbenchTool,
} from './useNutrientWorkbench';

export type {
  WorkbenchActions,
  WorkbenchState,
  WorkbenchTool,
} from './useNutrientWorkbench';

export interface UseApryseWorkbenchOptions {
  licenseKey: string;
  containerElement: HTMLDivElement | null;
}

export interface ApryseWorkbenchState extends WorkbenchState {
  documentKind: 'pdf' | 'xlsx';
}

const PDF_MIME = 'application/pdf';
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEFAULT_HIGHLIGHT_HEX = '#FFE066';
const DEFAULT_INK_WIDTH = 3;

function isSpreadsheetFile(name: string): boolean {
  return name.toLowerCase().endsWith('.xlsx');
}

/** Apryse chrome elements to strip so Apex owns the UI. */
const DISABLED_NATIVE_ELEMENTS = [
  'header',
  'toolsHeader',
  'menuButton',
  'leftPanel',
  'leftPanelButton',
  'viewControlsButton',
  'viewControlsOverlay',
  'pageNavOverlay',
  'ribbons',
  'ribbonsDropdown',
  'toolbarGroup-View',
  'toolbarGroup-Annotate',
  'toolbarGroup-Shapes',
  'toolbarGroup-Insert',
  'toolbarGroup-Edit',
  'toolbarGroup-FillAndSign',
  'toolbarGroup-Forms',
  'toolbarGroup-EditText',
  'toolbarGroup-Redact',
  'notesPanel',
  'notesPanelButton',
  'textPopup',
  'contextMenuPopup',
  'toolStylePopup',
  'annotationStylePopup',
  'annotationCommentPopup',
  'richTextPopup',
  'printModal',
  'downloadButton',
  'saveAsButton',
  'toggleNotesButton',
];

type ApryseInstance = Awaited<ReturnType<typeof WebViewer.Iframe>>;

function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof (cause as { message: unknown }).message === 'string'
  ) {
    return (cause as { message: string }).message;
  }
  return 'Apryse encountered an unexpected error.';
}

function downloadBuffer(
  buffer: ArrayBuffer | Uint8Array,
  filename: string,
  mime: string
): void {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => `${c}${c}`)
          .join('')
      : normalized;
  const value = Number.parseInt(full, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function toolNameFor(
  instance: ApryseInstance,
  tool: Exclude<WorkbenchTool, null>
): (typeof instance.Core.Tools.ToolNames)[keyof typeof instance.Core.Tools.ToolNames] {
  const names = instance.Core.Tools.ToolNames;
  const map = {
    pan: names.EDIT,
    'text-edit': names.CONTENT_EDIT,
    highlight: names.HIGHLIGHT,
    draw: names.FREEHAND,
    'add-text': names.FREETEXT,
    comment: names.STICKY,
    'fill-form': names.TEXT_SELECT,
    sign: names.SIGNATURE,
    pages: names.EDIT,
    redact: names.REDACTION,
  } as const;
  return map[tool];
}

function toFileBuffer(data: unknown): ArrayBuffer | Uint8Array {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('Apryse did not return file bytes.');
}

export function useApryseWorkbench({
  licenseKey,
  containerElement,
}: UseApryseWorkbenchOptions): {
  state: ApryseWorkbenchState;
  actions: WorkbenchActions;
} {
  const instanceRef = useRef<ApryseInstance | null>(null);
  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const initPromiseRef = useRef<Promise<ApryseInstance> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(containerElement);
  containerRef.current = containerElement;

  const [isLoaded, setIsLoaded] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [documentKind, setDocumentKind] = useState<'pdf' | 'xlsx'>('pdf');
  const [isDirty, setIsDirty] = useState(false);
  const [activeTool, setActiveTool] = useState<WorkbenchTool>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [status, setStatus] = useState('Open a PDF or XLSX to begin editing.');
  const [error, setError] = useState<string | null>(null);

  const currentPageRef = useRef(1);
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  const totalPagesRef = useRef(0);
  useEffect(() => {
    totalPagesRef.current = totalPages;
  }, [totalPages]);

  const ensureInstance = useCallback(async (): Promise<ApryseInstance> => {
    if (instanceRef.current) return instanceRef.current;
    if (initPromiseRef.current) return initPromiseRef.current;
    const container = containerRef.current;
    if (!container) {
      throw new Error('Apryse viewer container is not ready.');
    }
    if (!licenseKey.trim()) {
      throw new Error('VITE_APRYSE_WEBVIEWER_LICENSE_KEY is not configured.');
    }

    const viewerHost = document.createElement('div');
    viewerHost.style.width = '100%';
    viewerHost.style.height = '100%';
    container.replaceChildren(viewerHost);
    viewerHostRef.current = viewerHost;

    initPromiseRef.current = WebViewer.Iframe(
      {
        path: '/apryse-webviewer/lib',
        licenseKey,
        fullAPI: true,
        enableRedaction: true,
        backendType: WebViewer.BackendTypes.WASM,
        disabledElements: DISABLED_NATIVE_ELEMENTS,
      },
      viewerHost
    ).then((instance) => {
      instance.UI.enableFeatures([
        instance.UI.Feature.ContentEdit,
        instance.UI.Feature.Redaction,
      ]);
      instance.UI.disableElements(DISABLED_NATIVE_ELEMENTS);

      const { documentViewer } = instance.Core;
      documentViewer.addEventListener('pageNumberUpdated', (pageNumber: number) => {
        if (typeof pageNumber === 'number') setCurrentPage(pageNumber);
      });
      documentViewer.addEventListener('pagesUpdated', () => {
        const count = documentViewer.getPageCount();
        if (typeof count === 'number') {
          setTotalPages(count);
          totalPagesRef.current = count;
        }
      });
      documentViewer.addEventListener('annotationsLoaded', () => {
        setIsDirty(false);
      });

      instanceRef.current = instance;
      return instance;
    });

    try {
      return await initPromiseRef.current;
    } catch (cause) {
      initPromiseRef.current = null;
      throw cause;
    }
  }, [licenseKey]);

  useEffect(() => {
    return () => {
      instanceRef.current?.UI.dispose();
      instanceRef.current = null;
      initPromiseRef.current = null;
      viewerHostRef.current?.remove();
      viewerHostRef.current = null;
    };
  }, []);

  const endContentEditIfNeeded = useCallback((instance: ApryseInstance) => {
    const manager = instance.Core.documentViewer.getContentEditManager?.();
    if (manager?.isInContentEditMode?.()) {
      manager.endContentEditMode();
    }
  }, []);

  const loadBlob = useCallback(
    async (
      blob: Blob,
      name: string,
      kind: 'pdf' | 'xlsx'
    ): Promise<void> => {
      setError(null);
      setStatus(`Loading ${name}…`);
      setIsLoaded(false);
      setActiveTool(null);
      setIsDirty(false);
      setDocumentKind(kind);
      try {
        const instance = await ensureInstance();
        endContentEditIfNeeded(instance);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const modes = (WebViewer as any).Modes as
          | { SPREADSHEET_EDITOR?: string }
          | undefined;

        await new Promise<void>((resolve, reject) => {
          const { documentViewer } = instance.Core;
          const onLoaded = () => {
            documentViewer.removeEventListener('documentLoaded', onLoaded);
            documentViewer.removeEventListener('loadError', onError);
            resolve();
          };
          const onError = (cause: unknown) => {
            documentViewer.removeEventListener('documentLoaded', onLoaded);
            documentViewer.removeEventListener('loadError', onError);
            reject(
              cause instanceof Error ? cause : new Error(toErrorMessage(cause))
            );
          };
          documentViewer.addEventListener('documentLoaded', onLoaded);
          documentViewer.addEventListener('loadError', onError);

          if (kind === 'xlsx') {
            instance.UI.loadDocument(blob, {
              filename: name,
              extension: 'xlsx',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...(modes?.SPREADSHEET_EDITOR
                ? { initialMode: modes.SPREADSHEET_EDITOR }
                : { enableOfficeEditing: true }),
            } as Parameters<typeof instance.UI.loadDocument>[1]);
          } else {
            instance.UI.loadDocument(blob, { filename: name });
          }
        });

        if (kind === 'xlsx') {
          try {
            const manager =
              instance.Core.documentViewer.getSpreadsheetEditorManager?.();
            const SpreadsheetEditor = instance.Core.SpreadsheetEditor;
            if (manager && SpreadsheetEditor) {
              const ready = SpreadsheetEditor.SpreadsheetEditorManager.Events
                .SPREADSHEET_EDITOR_READY;
              const enableEditing = async () => {
                await manager.setEditMode(
                  SpreadsheetEditor.SpreadsheetEditorEditMode.EDITING
                );
              };
              manager.addEventListener(ready, () => {
                void enableEditing();
              });
              // If already ready, enable immediately.
              void enableEditing().catch(() => undefined);
            }
          } catch {
            /* Spreadsheet Editor add-on may be unlicensed — still show the sheet. */
          }
        }

        fileNameRef.current = name;
        const pages = instance.Core.documentViewer.getPageCount() || 1;
        setFileName(name);
        setTotalPages(pages);
        setCurrentPage(1);
        setIsLoaded(true);
        if (kind === 'pdf') {
          instance.Core.documentViewer.setCurrentPage(1, false);
          instance.UI.setFitMode(instance.UI.FitMode.FitPage);
          setStatus(`${name} loaded (${pages} page${pages === 1 ? '' : 's'}).`);
        } else {
          setStatus(`${name} loaded in Spreadsheet Editor (editing mode).`);
        }
      } catch (cause) {
        setError(toErrorMessage(cause));
        setStatus('Loading failed.');
      }
    },
    [endContentEditIfNeeded, ensureInstance]
  );

  const loadDocument = useCallback(
    async (file: File): Promise<void> => {
      const kind = isSpreadsheetFile(file.name) ? 'xlsx' : 'pdf';
      if (kind === 'pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('Choose a PDF or XLSX file.');
      }
      await loadBlob(file, file.name, kind);
    },
    [loadBlob]
  );

  const loadDocuments = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      if (files.length === 1) {
        try {
          await loadDocument(files[0]);
        } catch (cause) {
          setError(toErrorMessage(cause));
          setStatus('Loading failed.');
        }
        return;
      }
      if (files.some((f) => isSpreadsheetFile(f.name))) {
        setError('Multi-file merge supports PDFs only. Open one XLSX at a time.');
        return;
      }
      setStatus(`Merging ${files.length} PDFs before loading…`);
      try {
        const merged = await PDFDocument.create();
        for (const file of files) {
          const doc = await PDFDocument.load(await file.arrayBuffer());
          const indices = Array.from({ length: doc.getPageCount() }, (_, i) => i);
          const copied = await merged.copyPages(doc, indices);
          copied.forEach((p) => merged.addPage(p));
        }
        const saved = await merged.save();
        const bytes = saved.buffer.slice(
          saved.byteOffset,
          saved.byteOffset + saved.byteLength
        ) as ArrayBuffer;
        await loadBlob(
          new Blob([bytes], { type: PDF_MIME }),
          `merged-${files.length}-files.pdf`,
          'pdf'
        );
      } catch (cause) {
        setError(toErrorMessage(cause));
        setStatus('Merge failed.');
      }
    },
    [loadDocument, loadBlob]
  );

  const applyHighlightColor = useCallback(
    (instance: ApryseInstance, hex: string): void => {
      const tool = instance.Core.documentViewer.getTool(
        instance.Core.Tools.ToolNames.HIGHLIGHT
      );
      const { r, g, b } = hexToRgb(hex);
      const color = new instance.Core.Annotations.Color(r, g, b);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tool as any).setStyles?.({ StrokeColor: color, FillColor: color });
    },
    []
  );

  const applyInkStrokeWidth = useCallback(
    (instance: ApryseInstance, width: number): void => {
      const tool = instance.Core.documentViewer.getTool(
        instance.Core.Tools.ToolNames.FREEHAND
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tool as any).setStyles?.({ StrokeThickness: width });
    },
    []
  );

  const closePagesPanel = useCallback((instance: ApryseInstance): void => {
    instance.UI.closeElements?.(['leftPanel']);
    instance.UI.disableElements([
      'leftPanel',
      'leftPanelButton',
      'thumbnailsPanel',
      'pageManipulationOverlay',
      'pageManipulationOverlayButton',
    ]);
  }, []);

  const openPagesPanel = useCallback((instance: ApryseInstance): void => {
    // Thumbnail / page-manipulation chrome only while Pages tool is active.
    instance.UI.enableElements([
      'leftPanel',
      'leftPanelButton',
      'thumbnailsPanel',
      'pageManipulationOverlay',
      'pageManipulationOverlayButton',
      'thumbRotateClockwise',
      'thumbRotateCounterClockwise',
      'thumbDelete',
    ]);
    instance.UI.openElements(['leftPanel']);
    setStatus(
      'Pages: drag thumbnails to reorder; use the toolbar to rotate, add a PDF, or delete.'
    );
  }, []);

  const setTool = useCallback(
    (tool: WorkbenchTool): void => {
      const instance = instanceRef.current;
      if (!instance) return;
      setError(null);
      void (async () => {
        try {
          if (tool !== 'text-edit') {
            endContentEditIfNeeded(instance);
          }
          if (tool !== 'pages') {
            closePagesPanel(instance);
          }
          if (!tool) {
            instance.UI.setToolMode(instance.Core.Tools.ToolNames.EDIT);
            setActiveTool(null);
            return;
          }
          if (tool === 'highlight') {
            applyHighlightColor(instance, DEFAULT_HIGHLIGHT_HEX);
          } else if (tool === 'draw') {
            applyInkStrokeWidth(instance, DEFAULT_INK_WIDTH);
          } else if (tool === 'text-edit') {
            instance.UI.enableFeatures([instance.UI.Feature.ContentEdit]);
            const manager = instance.Core.documentViewer.getContentEditManager();
            if (!manager.isInContentEditMode()) {
              await manager.startContentEditMode();
            }
            setIsDirty(true);
          } else if (tool === 'redact') {
            instance.UI.enableFeatures([instance.UI.Feature.Redaction]);
          } else if (tool === 'sign') {
            // Ink / appearance signature tool — certificate workflows use the same entry.
            setStatus('Sign: click the page to place a signature.');
          } else if (tool === 'pages') {
            openPagesPanel(instance);
          }
          instance.UI.setToolMode(toolNameFor(instance, tool));
          setActiveTool(tool);
        } catch (cause) {
          setError(toErrorMessage(cause));
        }
      })();
    },
    [
      applyHighlightColor,
      applyInkStrokeWidth,
      closePagesPanel,
      endContentEditIfNeeded,
      openPagesPanel,
    ]
  );

  const goToPage = useCallback((page: number): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    const clamped = Math.max(1, Math.min(page, totalPagesRef.current));
    instance.Core.documentViewer.setCurrentPage(clamped, true);
    setCurrentPage(clamped);
  }, []);

  const prevPage = useCallback(
    () => goToPage(currentPageRef.current - 1),
    [goToPage]
  );
  const nextPage = useCallback(
    () => goToPage(currentPageRef.current + 1),
    [goToPage]
  );

  const zoomIn = useCallback((): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    const zoom = instance.Core.documentViewer.getZoomLevel();
    instance.Core.documentViewer.zoomTo(zoom * 1.25);
  }, []);

  const zoomOut = useCallback((): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    const zoom = instance.Core.documentViewer.getZoomLevel();
    instance.Core.documentViewer.zoomTo(Math.max(0.1, zoom / 1.25));
  }, []);

  const fitPage = useCallback((): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.UI.setFitMode(instance.UI.FitMode.FitPage);
  }, []);

  const saveContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      endContentEditIfNeeded(instance);
      instance.UI.setToolMode(instance.Core.Tools.ToolNames.EDIT);
      setActiveTool(null);
      setIsDirty(false);
      setStatus('Content edits saved.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [endContentEditIfNeeded]);

  const discardContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      // Apryse commits content edits as they happen; exit mode and reload from last file bytes is heavy.
      // Best-effort: end mode and clear dirty; undo stack can reverse recent annotation/content ops.
      endContentEditIfNeeded(instance);
      const history = instance.Core.documentViewer.getAnnotationHistoryManager?.();
      history?.clear?.();
      instance.UI.setToolMode(instance.Core.Tools.ToolNames.EDIT);
      setActiveTool(null);
      setIsDirty(false);
      setStatus('Exited content edit mode. Use Undo for recent changes if needed.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [endContentEditIfNeeded]);

  const downloadPdf = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    const spreadsheet = isSpreadsheetFile(fileNameRef.current ?? '');
    setStatus(spreadsheet ? 'Saving spreadsheet…' : 'Saving PDF…');
    try {
      endContentEditIfNeeded(instance);
      const doc = instance.Core.documentViewer.getDocument();
      if (!doc) throw new Error('No document loaded.');
      const data: unknown = await doc.getFileData(
        spreadsheet
          ? { downloadType: 'xlsx' as 'pdf' }
          : { downloadType: 'pdf' }
      );
      const buffer = toFileBuffer(data);
      if (spreadsheet) {
        const baseName = (fileNameRef.current ?? 'workbook').replace(
          /\.xlsx$/i,
          ''
        );
        downloadBuffer(buffer, `${baseName}.xlsx`, XLSX_MIME);
        setStatus('Spreadsheet saved.');
      } else {
        const baseName = (fileNameRef.current ?? 'document').replace(
          /\.pdf$/i,
          ''
        );
        downloadBuffer(buffer, `${baseName}.pdf`, PDF_MIME);
        setStatus('PDF saved.');
      }
      setIsDirty(false);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus(spreadsheet ? 'Spreadsheet save failed.' : 'PDF save failed.');
    }
  }, [endContentEditIfNeeded]);

  const exportWord = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    if (isSpreadsheetFile(fileNameRef.current ?? '')) {
      setError('Word export is for PDFs. Save the spreadsheet as XLSX instead.');
      return;
    }
    setError(null);
    setStatus('Converting PDF to Word via Apryse server SDK…');
    try {
      endContentEditIfNeeded(instance);
      const doc = instance.Core.documentViewer.getDocument();
      if (!doc) throw new Error('Load a PDF before converting to Word.');
      const pdfBytes = toFileBuffer(
        await doc.getFileData({ downloadType: 'pdf' })
      );
      const fileNameValue = fileNameRef.current ?? 'document.pdf';
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([pdfBytes], { type: PDF_MIME }),
        fileNameValue
      );
      const response = await fetch('/api/pdf/apryse/convert-to-word', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!response.ok) {
        let message = `Conversion failed (${response.status}).`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* keep status message */
        }
        throw new Error(message);
      }
      const docxBlob = await response.blob();
      const baseName = fileNameValue.replace(/\.pdf$/i, '') || 'document';
      downloadBuffer(
        new Uint8Array(await docxBlob.arrayBuffer()),
        `${baseName}.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      setStatus(`Word export completed (${baseName}.docx).`);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Word export failed.');
    }
  }, [endContentEditIfNeeded]);

  const undo = useCallback((): void => {
    instanceRef.current?.Core.documentViewer
      .getAnnotationHistoryManager?.()
      ?.undo?.();
  }, []);

  const redo = useCallback((): void => {
    instanceRef.current?.Core.documentViewer
      .getAnnotationHistoryManager?.()
      ?.redo?.();
  }, []);

  const openSearch = useCallback((): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    // Transient Apryse search overlay only — primary chrome stays Apex-owned.
    instance.UI.enableElements(['searchPanel', 'searchButton']);
    instance.UI.openElements(['searchPanel']);
  }, []);

  const setHighlightColor = useCallback(
    (hex: string): void => {
      const instance = instanceRef.current;
      if (!instance) return;
      try {
        applyHighlightColor(instance, hex);
        instance.UI.setToolMode(instance.Core.Tools.ToolNames.HIGHLIGHT);
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    },
    [applyHighlightColor]
  );

  const setInkStrokeWidth = useCallback(
    (width: number): void => {
      const instance = instanceRef.current;
      if (!instance) return;
      try {
        applyInkStrokeWidth(instance, width);
        instance.UI.setToolMode(instance.Core.Tools.ToolNames.FREEHAND);
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    },
    [applyInkStrokeWidth]
  );

  const rotateCurrentPageCw = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      instance.Core.documentViewer.rotateClockwise(currentPageRef.current);
      setStatus('Page rotated clockwise.');
      setIsDirty(true);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const rotateCurrentPageCcw = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      instance.Core.documentViewer.rotateCounterClockwise(currentPageRef.current);
      setStatus('Page rotated counter-clockwise.');
      setIsDirty(true);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const mergeDocument = useCallback(async (file: File): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    if (isSpreadsheetFile(fileNameRef.current ?? '')) {
      setError('Merge is available for PDF documents only.');
      return;
    }
    setError(null);
    setStatus(`Merging ${file.name}…`);
    try {
      const current = instance.Core.documentViewer.getDocument();
      if (!current) throw new Error('No document loaded.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createDocument = (instance.Core as any).createDocument as
        | ((
            src: File | ArrayBuffer | Blob,
            opts?: { filename?: string; extension?: string }
          ) => Promise<{ getPageCount: () => number }>)
        | undefined;
      if (!createDocument) {
        throw new Error('Apryse createDocument API is unavailable in this build.');
      }
      const other = await createDocument(file, {
        filename: file.name,
        extension: 'pdf',
      });
      const otherCount = other.getPageCount();
      const pagesToInsert = Array.from({ length: otherCount }, (_, i) => i + 1);
      const insertAt = current.getPageCount() + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (current as any).insertPages(other, pagesToInsert, insertAt);
      const newTotal = instance.Core.documentViewer.getPageCount();
      setTotalPages(newTotal);
      totalPagesRef.current = newTotal;
      setStatus(`Merged ${file.name} — document now has ${newTotal} pages.`);
      setIsDirty(true);
      if (activeTool === 'pages') {
        openPagesPanel(instance);
      }
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Merge failed.');
    }
  }, [activeTool, openPagesPanel]);

  const deleteCurrentPage = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    if (isSpreadsheetFile(fileNameRef.current ?? '')) {
      setError('Delete page is available for PDF documents only.');
      return;
    }
    setError(null);
    const page = currentPageRef.current;
    const total = totalPagesRef.current;
    if (total <= 1) {
      setError('Cannot delete the only page in the document.');
      return;
    }
    try {
      const doc = instance.Core.documentViewer.getDocument();
      if (!doc) throw new Error('No document loaded.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const removePages = (doc as any).removePages as
        | ((pageNumbers: number[]) => Promise<void>)
        | undefined;
      if (typeof removePages !== 'function') {
        throw new Error('Apryse removePages API is unavailable in this build.');
      }
      await removePages.call(doc, [page]);
      const newTotal = instance.Core.documentViewer.getPageCount();
      setTotalPages(newTotal);
      totalPagesRef.current = newTotal;
      const nextPage = Math.min(page, newTotal);
      instance.Core.documentViewer.setCurrentPage(nextPage, true);
      setCurrentPage(nextPage);
      setStatus(`Deleted page ${page}. Document now has ${newTotal} page${newTotal === 1 ? '' : 's'}.`);
      setIsDirty(true);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Delete page failed.');
    }
  }, []);

  const applyRedactions = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    setStatus('Applying redactions…');
    try {
      instance.UI.enableFeatures([instance.UI.Feature.Redaction]);
      const { annotationManager, Annotations } = instance.Core;
      const marks = annotationManager
        .getAnnotationsList()
        .filter(
          (annot) => annot instanceof Annotations.RedactionAnnotation
        );
      if (marks.length === 0) {
        setStatus('No redaction marks to apply. Mark text/areas first.');
        return;
      }
      await annotationManager.applyRedactions(marks);
      setIsDirty(true);
      setStatus(`Applied ${marks.length} redaction(s). Download PDF to keep changes.`);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Apply redactions failed.');
    }
  }, []);

  const searchAndRedact = useCallback(
    async (query: string, useRegex = false): Promise<void> => {
      const instance = instanceRef.current;
      if (!instance) return;
      const trimmed = query.trim();
      if (!trimmed) {
        setError('Enter a search term to mark for redaction.');
        return;
      }
      setError(null);
      setStatus(`Searching and marking “${trimmed}” for redaction…`);
      try {
        instance.UI.enableFeatures([instance.UI.Feature.Redaction]);
        // Prefer Search API that creates redaction annotations when available.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const searchAndRedactFn = (instance.UI as any).searchAndRedact as
          | ((
              pattern: string | RegExp,
              options?: { caseSensitive?: boolean }
            ) => Promise<unknown>)
          | undefined;
        if (typeof searchAndRedactFn === 'function') {
          await searchAndRedactFn(useRegex ? new RegExp(trimmed, 'gi') : trimmed, {
            caseSensitive: false,
          });
        } else {
          // Fallback: open redaction search panel with the query prefilled via text search.
          instance.UI.openElements(['redactionPanel', 'searchPanel']);
          instance.UI.searchText(trimmed, {
            caseSensitive: false,
            wholeWord: false,
            wildcard: false,
            regex: useRegex,
          });
        }
        instance.UI.setToolMode(instance.Core.Tools.ToolNames.REDACTION);
        setActiveTool('redact');
        setIsDirty(true);
        setStatus(
          `Marked matches for “${trimmed}”. Review marks, then Apply all.`
        );
      } catch (cause) {
        setError(toErrorMessage(cause));
        setStatus('Search & redact failed.');
      }
    },
    []
  );

  const state: ApryseWorkbenchState = {
    isLoaded,
    fileName,
    documentKind,
    isDirty,
    activeTool,
    currentPage,
    totalPages,
    status,
    error,
  };

  const actions: WorkbenchActions = {
    loadDocument,
    loadDocuments,
    setTool,
    goToPage,
    prevPage,
    nextPage,
    zoomIn,
    zoomOut,
    fitPage,
    saveContentEdits,
    discardContentEdits,
    downloadPdf,
    exportWord,
    undo,
    redo,
    openSearch,
    setHighlightColor,
    setInkStrokeWidth,
    rotateCurrentPageCw,
    rotateCurrentPageCcw,
    mergeDocument,
    deleteCurrentPage,
    applyRedactions,
    searchAndRedact,
  };

  return { state, actions };
}
