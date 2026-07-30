/**
 * useNutrientWorkbench
 *
 * Manages the Nutrient SDK instance lifecycle and exposes a stable action API
 * that Apex-owned components use to drive all viewer interactions.
 *
 * Page-structure operations (rotate, merge, reorder) use Nutrient's native
 * applyOperations API now that the Document Editing add-on is licensed.
 * Multi-file open still pre-merges with pdf-lib before the initial load.
 *
 * The SDK itself is loaded via CDN UMD script (see lib/nutrientViewer.ts) —
 * Vite cannot ESM-import the published UMD entry reliably.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import {
  getNutrientViewer,
  getNutrientViewerSync,
  type NutrientViewerModule,
} from '../lib/nutrientViewer';

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
function immutableList(sdk: NutrientViewerModule, arr: number[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sdk.Immutable as any).List(arr);
}

/** null = Nutrient default interaction (required for filling existing AcroForm fields). */
const INTERACTION_MODES: Record<Exclude<WorkbenchTool, null>, string | null> = {
  pan: 'PAN',
  'text-edit': 'CONTENT_EDITOR',
  highlight: 'TEXT_HIGHLIGHTER',
  draw: 'INK',
  'add-text': 'TEXT',
  comment: 'NOTE',
  'fill-form': null,
  sign: 'INK_SIGNATURE',
  pages: 'DOCUMENT_EDITOR',
};

/** Matches NutrientFloatingToolbar yellow swatch — applied when Highlight is activated. */
const DEFAULT_HIGHLIGHT_HEX = '#FFE066';
/** Matches NutrientFloatingToolbar "Medium" ink width. */
const DEFAULT_INK_WIDTH = 3;

export function useNutrientWorkbench({
  licenseKey,
  containerElement,
}: UseNutrientWorkbenchOptions): {
  state: WorkbenchState;
  actions: WorkbenchActions;
} {
  type NutrientInstance = Awaited<ReturnType<NutrientViewerModule['load']>>;

  const instanceRef = useRef<NutrientInstance | null>(null);
  const sdkRef = useRef<NutrientViewerModule | null>(null);
  const workerPreloadedRef = useRef(false);
  const fileNameRef = useRef<string | null>(null);
  // Keep latest container for unload — callback-ref containers are null on first render.
  const containerRef = useRef<HTMLDivElement | null>(containerElement);
  containerRef.current = containerElement;

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
      const el = containerRef.current;
      const sdk = sdkRef.current ?? getNutrientViewerSync();
      if (el && sdk) sdk.unload(el);
      instanceRef.current = null;
    };
  }, []);

  const subscribeEvents = useCallback((
    sdk: NutrientViewerModule,
    instance: NutrientInstance
  ) => {
    instance.addEventListener(
      sdk.EventName.VIEW_STATE_CURRENT_PAGE_INDEX_CHANGE,
      () => {
        const page = instance.viewState.currentPageIndex;
        if (typeof page === 'number') setCurrentPage(page + 1);
      }
    );
    instance.addEventListener(
      sdk.EventName.VIEW_STATE_CHANGE,
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
        const sdk = await getNutrientViewer();
        sdkRef.current = sdk;

        const config = {
          document: docBytes,
          useCDN: true as const,
          ...(licenseKey ? { licenseKey } : {}),
        };
        if (!workerPreloadedRef.current) {
          await sdk.preloadWorker(config);
          workerPreloadedRef.current = true;
        }
        sdk.unload(containerElement);
        instanceRef.current = null;

        const instance = await sdk.load({
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
        subscribeEvents(sdk, instance);
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

  // ── Annotation presets (custom toolbar — must set current preset explicitly) ─

  const applyHighlightColor = useCallback((
    sdk: NutrientViewerModule,
    instance: NutrientInstance,
    hex: string
  ): void => {
    const color = sdk.Color.fromHex(hex);
    instance.setAnnotationPresets((presets) => ({
      ...presets,
      'text-highlighter': { ...(presets['text-highlighter'] ?? {}), color },
    }));
    instance.setCurrentAnnotationPreset('text-highlighter');
  }, []);

  const applyInkStrokeWidth = useCallback((
    instance: NutrientInstance,
    width: number
  ): void => {
    instance.setAnnotationPresets((presets) => ({
      ...presets,
      ink: { ...(presets['ink'] ?? {}), lineWidth: width },
    }));
    instance.setCurrentAnnotationPreset('ink');
  }, []);

  // ── Tool activation ───────────────────────────────────────────────────────

  const setTool = useCallback((tool: WorkbenchTool): void => {
    const instance = instanceRef.current;
    const sdk = sdkRef.current;
    if (!instance || !sdk) return;
    setError(null);
    try {
      const modeKey = tool ? INTERACTION_MODES[tool] : null;
      const modeValue = modeKey
        ? (sdk.InteractionMode as unknown as Record<string, string>)[modeKey] ?? null
        : null;
      // Vendor toolbar is hidden — activate the matching preset before the mode.
      if (tool === 'highlight') {
        applyHighlightColor(sdk, instance, DEFAULT_HIGHLIGHT_HEX);
      } else if (tool === 'draw') {
        applyInkStrokeWidth(instance, DEFAULT_INK_WIDTH);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.setViewState((vs) => vs.set('interactionMode', modeValue as any));
      setActiveTool(tool);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [applyHighlightColor, applyInkStrokeWidth]);

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
    const sdk = sdkRef.current;
    if (!sdk) return;
    instanceRef.current?.setViewState((vs) =>
      vs.set('zoom', sdk.ZoomMode.FIT_TO_WIDTH)
    );
  }, []);

  // ── Content editing ───────────────────────────────────────────────────────

  const exitContentEditor = useCallback((instance: NutrientInstance): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instance.setViewState((vs) => vs.set('interactionMode', null as any));
    setActiveTool(null);
  }, []);

  const saveContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.saveContentEditingSession();
      exitContentEditor(instance);
      setIsDirty(false);
      setStatus('Content edits saved.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [exitContentEditor]);

  const discardContentEdits = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    if (!instance) return;
    setError(null);
    try {
      await instance.discardContentEditingSession();
      exitContentEditor(instance);
      setIsDirty(false);
      setStatus('Content edits discarded.');
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [exitContentEditor]);

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
    const sdk = sdkRef.current;
    if (!instance || !sdk) return;
    instance.setViewState((vs) =>
      vs.set('interactionMode', sdk.InteractionMode.SEARCH)
    );
  }, []);

  // ── Annotation presets (toolbar swatches) ─────────────────────────────────

  const setHighlightColor = useCallback((hex: string): void => {
    const instance = instanceRef.current;
    const sdk = sdkRef.current;
    if (!instance || !sdk) return;
    try {
      applyHighlightColor(sdk, instance, hex);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [applyHighlightColor]);

  const setInkStrokeWidth = useCallback((width: number): void => {
    const instance = instanceRef.current;
    if (!instance) return;
    try {
      applyInkStrokeWidth(instance, width);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [applyInkStrokeWidth]);

  // ── Page operations (Document Editing license) ────────────────────────────

  const rotateCurrentPageCw = useCallback(async (): Promise<void> => {
    const instance = instanceRef.current;
    const sdk = sdkRef.current;
    if (!instance || !sdk) return;
    setError(null);
    try {
      await instance.applyOperations([
        {
          type: 'rotatePages',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pageIndexes: immutableList(sdk, [currentPageRef.current - 1]) as any,
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
    const sdk = sdkRef.current;
    if (!instance || !sdk) return;
    setError(null);
    try {
      await instance.applyOperations([
        {
          type: 'rotatePages',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pageIndexes: immutableList(sdk, [currentPageRef.current - 1]) as any,
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
