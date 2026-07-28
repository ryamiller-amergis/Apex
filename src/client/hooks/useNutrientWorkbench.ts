/**
 * useNutrientWorkbench
 *
 * Manages the Nutrient SDK instance lifecycle and exposes a stable action API
 * that Apex-owned components use to drive all viewer interactions.
 *
 * Page-structure operations (rotate, merge, reorder) use Nutrient's native
 * applyOperations API now that the Document Editing add-on is licensed.
 * Multi-file open still pre-merges with pdf-lib before the initial load.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import NutrientViewer from '@nutrient-sdk/viewer';
import { PDFDocument } from 'pdf-lib';

/** Each tool the Apex rail can activate. */
export type WorkbenchTool =
  | 'pan'
  | 'text-edit'
  | 'highlight'
  | 'draw'
  | 'add-text'
  | 'comment'
  | 'fill-form'
  | 'sign'
  | 'pages'
  | null;

export interface WorkbenchState {
  isLoaded: boolean;
  fileName: string | null;
  isDirty: boolean;
  activeTool: WorkbenchTool;
  currentPage: number;
  totalPages: number;
  status: string;
  error: string | null;
}

export interface WorkbenchActions {
  /** Load a single PDF File into the viewer. */
  loadDocument: (file: File) => Promise<void>;
  /**
   * Load one or more PDF Files. Multiple files are merged with pdf-lib
   * before loading — no extra round-trips after initial load.
   */
  loadDocuments: (files: File[]) => Promise<void>;
  setTool: (tool: WorkbenchTool) => void;
  goToPage: (page: number) => void;
  prevPage: () => void;
  nextPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitPage: () => void;
  saveContentEdits: () => Promise<void>;
  discardContentEdits: () => Promise<void>;
  downloadPdf: () => Promise<void>;
  exportWord: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  openSearch: () => void;
  /** Set the active highlight colour (hex string e.g. "#ffff00"). */
  setHighlightColor: (hex: string) => void;
  /** Set the ink/draw stroke width in points. */
  setInkStrokeWidth: (width: number) => void;
  /** Rotate the current page 90° clockwise (native applyOperations). */
  rotateCurrentPageCw: () => Promise<void>;
  /** Rotate the current page 90° counter-clockwise (native applyOperations). */
  rotateCurrentPageCcw: () => Promise<void>;
  /** Append all pages from another PDF (native importDocument — no reload). */
  mergeDocument: (file: File) => Promise<void>;
}

export interface UseNutrientWorkbenchOptions {
  licenseKey: string;
  containerElement: HTMLDivElement | null;
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Nutrient encountered an unexpected error.';
}

function downloadBuffer(
  buffer: ArrayBuffer,
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

/** Safely get Immutable.List from the Nutrient bundle. */
function immutableList(arr: number[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (NutrientViewer.Immutable as any).List(arr);
}

const INTERACTION_MODES: Record<Exclude<WorkbenchTool, null>, string> = {
  pan: 'PAN',
  'text-edit': 'CONTENT_EDITOR',
  highlight: 'TEXT_HIGHLIGHTER',
  draw: 'INK',
  'add-text': 'TEXT',
  comment: 'NOTE',
  'fill-form': 'FORM_CREATOR',
  sign: 'INK_SIGNATURE',
  pages: 'DOCUMENT_EDITOR',
};

export function useNutrientWorkbench({
  licenseKey,
  containerElement,
}: UseNutrientWorkbenchOptions): {
  state: WorkbenchState;
  actions: WorkbenchActions;
} {
  type NutrientInstance = Awaited<ReturnType<typeof NutrientViewer.load>>;

  const instanceRef = useRef<NutrientInstance | null>(null);
  const workerPreloadedRef = useRef(false);
  const fileNameRef = useRef<string | null>(null);

  const [isLoaded, setIsLoaded] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [activeTool, setActiveTool] = useState<WorkbenchTool>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [status, setStatus] = useState('Open a PDF to begin editing.');
  const [error, setError] = useState<string | null>(null);

  const currentPageRef = useRef(1);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);

  const totalPagesRef = useRef(0);
  useEffect(() => { totalPagesRef.current = totalPages; }, [totalPages]);

  useEffect(() => {
    return () => {
      if (containerElement) NutrientViewer.unload(containerElement);
      instanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribeEvents = useCallback((instance: NutrientInstance) => {
    instance.addEventListener(
      NutrientViewer.EventName.VIEW_STATE_CURRENT_PAGE_INDEX_CHANGE,
      () => {
        const page = instance.viewState.currentPageIndex;
        if (typeof page === 'number') setCurrentPage(page + 1);
      }
    );
    instance.addEventListener(
      NutrientViewer.EventName.VIEW_STATE_CHANGE,
      () => {
        const dirty = instance.hasUnsavedContentEditingChanges?.() ?? false;
        setIsDirty(dirty);
      }
    );
  }, []);

  // ── Core loader ───────────────────────────────────────────────────────────

  const loadBytes = useCallback(
    async (docBytes: ArrayBuffer, name: string): Promise<void> => {
      if (!containerElement) return;
      setError(null);
      setStatus(`Loading ${name}…`);
      setIsLoaded(false);
      setActiveTool(null);
      setIsDirty(false);
      try {
        const config = {
          document: docBytes,
          useCDN: true as const,
          ...(licenseKey ? { licenseKey } : {}),
        };
        if (!workerPreloadedRef.current) {
          await NutrientViewer.preloadWorker(config);
          workerPreloadedRef.current = true;
        }
        NutrientViewer.unload(containerElement);
        instanceRef.current = null;

        const instance = await NutrientViewer.load({
          container: containerElement,
          ...config,
          enableHistory: true,
          toolbarItems: [],
          ui: {
            tools: {
              main: () => ({ render: () => null }),
              contextual: () => ({ render: () => null }),
            },
          },
        });

        instanceRef.current = instance;
        fileNameRef.current = name;
        const pages = instance.totalPageCount ?? 0;

        setFileName(name);
        setTotalPages(pages);
        setCurrentPage(1);
        setIsLoaded(true);
        setStatus(`${name} loaded (${pages} page${pages === 1 ? '' : 's'}).`);
        subscribeEvents(instance);
      } catch (cause) {
        setError(toErrorMessage(cause));
        setStatus('Loading failed.');
      }
    },
    [containerElement, licenseKey, subscribeEvents]
  );

  const loadDocument = useCallback(
    async (file: File): Promise<void> => {
      await loadBytes(await file.arrayBuffer(), file.name);
    },
    [loadBytes]
  );

  /**
   * Open one or more PDFs. When multiple files are given they are merged with
   * pdf-lib before the initial Nutrient load (no document-editing call needed).
   */
  const loadDocuments = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      if (files.length === 1) { await loadDocument(files[0]); return; }

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
        await loadBytes(saved.buffer as ArrayBuffer, `merged-${files.length}-files.pdf`);
      } catch (cause) {
        setError(toErrorMessage(cause));
        setStatus('Merge failed.');
      }
    },
    [loadDocument, loadBytes]
  );

  // ── Tool activation ───────────────────────────────────────────────────────

  const setTool = useCallback((tool: WorkbenchTool): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      const modeKey = tool ? INTERACTION_MODES[tool] : null;
      const modeValue = modeKey
        ? (NutrientViewer.InteractionMode as unknown as Record<string, string>)[modeKey] ?? null
        : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.setViewState((vs) => vs.set('interactionMode', modeValue as any));
      setActiveTool(tool);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goToPage = useCallback((page: number): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    const clamped = Math.max(1, Math.min(page, totalPagesRef.current));
    instance.setViewState((vs) => vs.set('currentPageIndex', clamped - 1));
  }, []);

  const prevPage = useCallback(() => goToPage(currentPageRef.current - 1), [goToPage]);
  const nextPage = useCallback(() => goToPage(currentPageRef.current + 1), [goToPage]);

  // ── Zoom ──────────────────────────────────────────────────────────────────

  const zoomIn = useCallback((): void => {
    instanceRef.current?.setViewState((vs) => vs.zoomIn());
  }, []);

  const zoomOut = useCallback((): void => {
    instanceRef.current?.setViewState((vs) => vs.zoomOut());
  }, []);

  const fitPage = useCallback((): void => {
    instanceRef.current?.setViewState((vs) =>
      vs.set('zoom', NutrientViewer.ZoomMode.FIT_TO_WIDTH)
    );
  }, []);

  // ── Content editing ───────────────────────────────────────────────────────

  const saveContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.saveContentEditingSession();
      setActiveTool(null);
      setIsDirty(false);
      setStatus('Content edits saved.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const discardContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.discardContentEditingSession();
      setActiveTool(null);
      setIsDirty(false);
      setStatus('Content edits discarded.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  // ── Export ────────────────────────────────────────────────────────────────

  const downloadPdf = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    setStatus('Saving PDF…');
    try {
      if (instance.hasUnsavedContentEditingChanges?.()) {
        await instance.saveContentEditingSession();
      }
      const buffer = await instance.exportPDF();
      const baseName = (fileNameRef.current ?? 'document').replace(/\.pdf$/i, '');
      downloadBuffer(buffer, `${baseName}.pdf`, PDF_MIME);
      setStatus('PDF saved.');
      setIsDirty(false);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('PDF save failed.');
    }
  }, []);

  const exportWord = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    setStatus('Exporting to Word…');
    try {
      if (instance.hasUnsavedContentEditingChanges?.()) {
        await instance.saveContentEditingSession();
      }
      const buffer = await instance.exportOffice({ format: 'docx' });
      const baseName = (fileNameRef.current ?? 'document').replace(/\.pdf$/i, '');
      downloadBuffer(buffer, `${baseName}.docx`, DOCX_MIME);
      setStatus('Word export completed.');
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Word export failed.');
    }
  }, []);

  // ── History ───────────────────────────────────────────────────────────────

  const undo = useCallback((): void => { instanceRef.current?.history?.undo(); }, []);
  const redo = useCallback((): void => { instanceRef.current?.history?.redo(); }, []);

  // ── Search ────────────────────────────────────────────────────────────────

  const openSearch = useCallback((): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setViewState((vs) =>
      vs.set('interactionMode', NutrientViewer.InteractionMode.SEARCH)
    );
  }, []);

  // ── Annotation presets ────────────────────────────────────────────────────

  const setHighlightColor = useCallback((hex: string): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    try {
      const color = NutrientViewer.Color.fromHex(hex);
      instance.setAnnotationPresets((presets) => ({
        ...presets,
        'text-highlighter': { ...(presets['text-highlighter'] ?? {}), color },
      }));
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const setInkStrokeWidth = useCallback((width: number): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    try {
      instance.setAnnotationPresets((presets) => ({
        ...presets,
        ink: { ...(presets['ink'] ?? {}), lineWidth: width },
      }));
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  // ── Page operations (Document Editing license) ────────────────────────────

  const rotateCurrentPageCw = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.applyOperations([
        {
          type: 'rotatePages',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pageIndexes: immutableList([currentPageRef.current - 1]) as any,
          rotateBy: 90,
        },
      ]);
      setStatus('Page rotated clockwise.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  const rotateCurrentPageCcw = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.applyOperations([
        {
          type: 'rotatePages',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pageIndexes: immutableList([currentPageRef.current - 1]) as any,
          rotateBy: 270,
        },
      ]);
      setStatus('Page rotated counter-clockwise.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, []);

  /**
   * Append all pages from a PDF file into the current document.
   * Uses the native importDocument operation — no reload required, all
   * existing annotations are preserved.
   */
  const mergeDocument = useCallback(async (file: File): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    setStatus(`Merging ${file.name}…`);
    try {
      await instance.applyOperations([
        {
          type: 'importDocument',
          // Append after the last page of the current document.
          afterPageIndex: totalPagesRef.current - 1,
          document: file,
        },
      ]);
      const newTotal = instance.totalPageCount ?? totalPagesRef.current;
      setTotalPages(newTotal);
      setStatus(`Merged ${file.name} — document now has ${newTotal} pages.`);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setStatus('Merge failed.');
    }
  }, []);

  // ── State + actions surface ───────────────────────────────────────────────

  const state: WorkbenchState = {
    isLoaded, fileName, isDirty, activeTool,
    currentPage, totalPages, status, error,
  };

  const actions: WorkbenchActions = {
    loadDocument, loadDocuments, setTool,
    goToPage, prevPage, nextPage,
    zoomIn, zoomOut, fitPage,
    saveContentEdits, discardContentEdits,
    downloadPdf, exportWord,
    undo, redo, openSearch,
    setHighlightColor, setInkStrokeWidth,
    rotateCurrentPageCw, rotateCurrentPageCcw,
    mergeDocument,
  };

  return { state, actions };
}
