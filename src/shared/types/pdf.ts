// ── PDF Assembly — Shared Types ────────────────────────────────────────────────

export type PdfSessionStatus = 'active' | 'exported' | 'expired';
export type PdfConversionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';
export type PdfJobType = 'docx_convert' | 'export';
export type OverlayFontFamily = 'Helvetica' | 'Times-Roman' | 'Courier';
export type OverlayHorizontalAlign = 'left' | 'center' | 'right';
export type OverlayVerticalAlign = 'top' | 'middle' | 'bottom';
export type OverlayListStyle = 'none' | 'bullet' | 'numbered';
export type OverlayKind = 'add' | 'replace';

export interface OverlayTextBox {
  id: string;
  pageId: string;
  /** Page-relative percentage geometry using a top-left origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontFamily: OverlayFontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  horizontalAlign: OverlayHorizontalAlign;
  verticalAlign: OverlayVerticalAlign;
  opacity: number;
  rotation: number;
  listStyle: OverlayListStyle;
  linkUrl?: string | null;
  linkDisplayText?: string | null;
  zIndex: number;
  kind?: OverlayKind;
  /** Opaque visual cover used by native-text replacement overlays. */
  backgroundColor?: string | null;
}

/**
 * Checks the persisted overlay shape only. Business-rule validation (bounds,
 * allowlists, page identity, and URL schemes) belongs to the overlay sync API.
 */
export function isOverlayTextBox(value: unknown): value is OverlayTextBox {
  if (!value || typeof value !== 'object') return false;
  const overlay = value as Record<string, unknown>;
  const isNumber = (field: string) => typeof overlay[field] === 'number';
  const isOptionalString = (field: string) =>
    overlay[field] === undefined ||
    overlay[field] === null ||
    typeof overlay[field] === 'string';

  return (
    typeof overlay.id === 'string' &&
    typeof overlay.pageId === 'string' &&
    isNumber('x') &&
    isNumber('y') &&
    isNumber('width') &&
    isNumber('height') &&
    typeof overlay.text === 'string' &&
    ['Helvetica', 'Times-Roman', 'Courier'].includes(
      overlay.fontFamily as string
    ) &&
    isNumber('fontSize') &&
    typeof overlay.bold === 'boolean' &&
    typeof overlay.italic === 'boolean' &&
    typeof overlay.color === 'string' &&
    ['left', 'center', 'right'].includes(overlay.horizontalAlign as string) &&
    ['top', 'middle', 'bottom'].includes(overlay.verticalAlign as string) &&
    isNumber('opacity') &&
    isNumber('rotation') &&
    ['none', 'bullet', 'numbered'].includes(overlay.listStyle as string) &&
    isOptionalString('linkUrl') &&
    isOptionalString('linkDisplayText') &&
    isNumber('zIndex') &&
    (overlay.kind === undefined ||
      overlay.kind === 'add' ||
      overlay.kind === 'replace') &&
    isOptionalString('backgroundColor')
  );
}

export interface PdfConversionJob {
  id: string;
  sessionId: string;
  jobType?: PdfJobType;
  originalName: string;
  status: PdfConversionStatus;
  fileId?: string | null;
  queuePosition?: number | null;
  resultUrl?: string | null;
  resultFilename?: string | null;
  attempts?: number;
  maxAttempts?: number;
  error?: {
    code: string;
    message: string;
  } | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface PdfFileMetadata {
  fileId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  convertedFrom?: string;
  originalMimeType?: string;
  uploadedAt: string;
}

export interface PageManifestEntry {
  pageId: string;
  fileId: string;
  sourcePageIndex: number;
  rotation: 0 | 90 | 180 | 270;
  deleted: boolean;
}

export interface PdfSession {
  id: string;
  userId: string;
  projectId?: string | null;
  status: PdfSessionStatus;
  pageManifest: PageManifestEntry[];
  textOverlays: OverlayTextBox[];
  fileMetadata: PdfFileMetadata[];
  conversionJobs: PdfConversionJob[];
  exportFilename?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

// ── API Shapes ─────────────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  projectId?: string;
  /** When set, the server closes this session before creating the new one. */
  replaceSessionId?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: PdfSessionStatus;
  createdAt: string;
  expiresAt: string;
}

export interface ReplaceOverlaysRequest {
  overlays: OverlayTextBox[];
}

export interface ReplaceOverlaysResponse {
  overlays: OverlayTextBox[];
  updatedAt: string;
}

export interface UpdateManifestResponse {
  pageCount: number;
  updatedAt: string;
  /** Authoritative post-cleanup overlays for immediate client synchronization. */
  textOverlays: OverlayTextBox[];
}

export interface OverlayFieldError {
  overlayId: string | null;
  field: string;
  code: string;
  message: string;
}

export interface FileUploadResult {
  fileId?: string;
  originalName: string;
  status: 'success' | 'queued' | 'error';
  conversionId?: string;
  pageCount?: number;
  sizeBytes?: number;
  convertedFrom?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface UploadFilesResponse {
  files: FileUploadResult[];
}

/**
 * MVP performance objectives. These are soft targets because PDF complexity,
 * file size, network speed, and host capacity all affect wall-clock time.
 */
export const PDF_MVP_PERFORMANCE_TARGETS = {
  uploadPageCount: 50,
  uploadAndParseMs: 10_000,
  exportPageCount: 100,
  assembleAndExportMs: 15_000,
} as const;

// ── Export Types ───────────────────────────────────────────────────────────────

export interface ExportRequest {
  filename?: string;
}

export interface EnqueueExportResponse {
  jobId: string;
  status: PdfConversionStatus;
  queuePosition: number;
  statusUrl: string;
}

export interface ExtractionRequest {
  filename?: string;
  pages?: number[];
}

export interface ExportArtifactRef {
  userId: string;
  sessionId: string;
  fileName: string;
}

export interface ExportWorkerInput {
  manifest: PageManifestEntry[];
  /** Server-persisted, validated overlays for pages included in this export. */
  overlays?: OverlayTextBox[];
  filePaths?: Record<string, string>;
  fileBytes?: Record<string, Uint8Array>;
  artifactFiles?: Record<string, ExportArtifactRef>;
  outputRef?: ExportArtifactRef;
}

export interface ExportWorkerOutput {
  success: boolean;
  pdfBytes?: Uint8Array;
  error?: string;
}

// ── Error Codes ────────────────────────────────────────────────────────────────

export const PDF_ERROR_CODES = {
  FILE_ENCRYPTED: 'FILE_ENCRYPTED',
  FILE_CORRUPT: 'FILE_CORRUPT',
  FILE_NOT_PDF: 'FILE_NOT_PDF',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  SESSION_SIZE_EXCEEDED: 'SESSION_SIZE_EXCEEDED',
  SESSION_PAGES_EXCEEDED: 'SESSION_PAGES_EXCEEDED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  CONVERSION_FAILED: 'CONVERSION_FAILED',
  CONVERSION_TIMEOUT: 'CONVERSION_TIMEOUT',
  CONVERSION_UNAVAILABLE: 'CONVERSION_UNAVAILABLE',
  SESSION_LIMIT_REACHED: 'SESSION_LIMIT_REACHED',
  MANIFEST_INVALID_FILE_ID: 'MANIFEST_INVALID_FILE_ID',
  MANIFEST_INVALID_ROTATION: 'MANIFEST_INVALID_ROTATION',
  OVERLAY_VALIDATION_FAILED: 'OVERLAY_VALIDATION_FAILED',
  SESSION_FORBIDDEN: 'SESSION_FORBIDDEN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_FILENAME: 'INVALID_FILENAME',
  NO_PAGES: 'NO_PAGES',
  EXPORT_FAILED: 'EXPORT_FAILED',
  INVALID_PAGE_INDICES: 'INVALID_PAGE_INDICES',
} as const;

export type PdfErrorCode =
  (typeof PDF_ERROR_CODES)[keyof typeof PDF_ERROR_CODES];

// ── Thumbnail Rendering ─────────────────────────────────────────────────────

export interface ThumbnailRenderState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  imageBitmap: ImageBitmap | null;
  hasTextContent?: boolean;
  error: string | null;
}
