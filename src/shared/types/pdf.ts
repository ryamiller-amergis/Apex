// ── PDF Assembly — Shared Types ────────────────────────────────────────────────

export type PdfSessionStatus = 'active' | 'exported' | 'expired';

export interface PdfFileMetadata {
  fileId: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  convertedFrom?: string;
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
  exportFilename?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

// ── API Shapes ─────────────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  projectId?: string;
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
  status: 'success' | 'error';
  pageCount?: number;
  sizeBytes?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface UploadFilesResponse {
  files: FileUploadResult[];
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
  SESSION_LIMIT_REACHED: 'SESSION_LIMIT_REACHED',
} as const;

export type PdfErrorCode = typeof PDF_ERROR_CODES[keyof typeof PDF_ERROR_CODES];
