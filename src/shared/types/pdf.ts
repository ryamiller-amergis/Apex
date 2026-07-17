// ── PDF Assembly — Shared Types ────────────────────────────────────────────────

export type PdfSessionStatus = 'active' | 'exported' | 'expired';
export type PdfConversionStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface PdfConversionJob {
  id: string;
  sessionId: string;
  originalName: string;
  status: PdfConversionStatus;
  fileId?: string | null;
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

export interface ExtractionRequest {
  filename?: string;
  pages?: number[];
}

export interface ExportWorkerInput {
  manifest: PageManifestEntry[];
  filePaths: Record<string, string>;
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
  SESSION_FORBIDDEN: 'SESSION_FORBIDDEN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_FILENAME: 'INVALID_FILENAME',
  NO_PAGES: 'NO_PAGES',
  EXPORT_FAILED: 'EXPORT_FAILED',
  INVALID_PAGE_INDICES: 'INVALID_PAGE_INDICES',
} as const;

export type PdfErrorCode = typeof PDF_ERROR_CODES[keyof typeof PDF_ERROR_CODES];

// ── Thumbnail Rendering ─────────────────────────────────────────────────────

export interface ThumbnailRenderState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  imageBitmap: ImageBitmap | null;
  hasTextContent?: boolean;
  error: string | null;
}
