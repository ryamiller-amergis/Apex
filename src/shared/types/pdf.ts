// ── PDF Assembly — Shared Types ────────────────────────────────────────────────

export type PdfSessionStatus = 'active' | 'exported' | 'expired';
export type PdfConversionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';
export type PdfJobType = 'docx_convert' | 'export';
export const PDF_OVERLAY_FONT_FAMILIES = [
  'Helvetica',
  'Times-Roman',
  'Courier',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Merriweather',
  'Noto Sans',
] as const;

export type OverlayFontFamily = (typeof PDF_OVERLAY_FONT_FAMILIES)[number];
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
  underline?: boolean;
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
  /** Cover activates after text edit or removal. Defaults true for backward compat. */
  coverActive?: boolean;
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
    (PDF_OVERLAY_FONT_FAMILIES as readonly string[]).includes(
      overlay.fontFamily as string
    ) &&
    isNumber('fontSize') &&
    typeof overlay.bold === 'boolean' &&
    typeof overlay.italic === 'boolean' &&
    (overlay.underline === undefined || typeof overlay.underline === 'boolean') &&
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
  /** Internal artifact filename stored in the artifact store (e.g. `{jobId}.pdf` or `{jobId}.docx`). */
  resultFileName?: string | null;
  /** Output format of this job's result artifact. */
  resultFormat?: PdfExportFormat | null;
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
  /** Catalogued AcroForm text fields for this source file; absent when the file has none. */
  textFormFields?: PdfTextFormFieldDefinition[];
}

// ── AcroForm Text Field Types ─────────────────────────────────────────────────

/**
 * Describes one AcroForm text-input widget as catalogued on the server.
 * Read-only and XFA fields are excluded from the catalog.
 */
export interface PdfTextFormFieldDefinition {
  /** Fully qualified PDF field name (unique within the source file). */
  fieldName: string;
  /** True when the widget allows multi-line entry. */
  multiline: boolean;
  /** Maximum character count enforced by the field, or null if unconstrained. */
  maxLength: number | null;
  /** Zero-based page index in the source PDF where the primary widget appears. */
  pageIndex: number;
  /** Additional page indices for repeated widgets sharing this field name. */
  additionalPageIndices: number[];
}

/**
 * A single user-entered value for one AcroForm text field.
 * Identified by source file and field name so repeated widgets share one value.
 */
export interface PdfTextFormValue {
  fileId: string;
  fieldName: string;
  value: string;
}

// ── Electronic Signature Types ─────────────────────────────────────────────────

/** How the signature image was created. */
export type PdfSignatureSource = 'typed' | 'drawn' | 'uploaded';

/**
 * Metadata for a session-scoped PNG signature asset stored via pdfArtifactStore.
 * The actual image bytes never appear in JSON — only the assetId for retrieval.
 */
export interface PdfSignatureAsset {
  /** UUID assigned at upload time; used as the artifact file name. */
  assetId: string;
  source: PdfSignatureSource;
  /** Pixel dimensions of the normalised PNG. */
  widthPx: number;
  heightPx: number;
  uploadedAt: string;
}

/**
 * One instance of a signature image placed on a specific page.
 * Geometry uses the same top-left percentage origin as OverlayTextBox.
 */
export interface PdfSignatureOverlay {
  id: string;
  pageId: string;
  assetId: string;
  /** Percentage geometry (top-left origin, 0–100). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise rotation in degrees (0 | 90 | 180 | 270). */
  rotation: 0 | 90 | 180 | 270;
  /** Opacity 0–100. */
  opacity: number;
  /** Stacking order; higher values appear on top. */
  zIndex: number;
}

/**
 * Complete signature state persisted in pdf_sessions.signature_state.
 */
export interface PdfSignatureState {
  assets: PdfSignatureAsset[];
  overlays: PdfSignatureOverlay[];
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
  /** Persisted AcroForm text-field values, keyed by fileId+fieldName. */
  formFieldValues: PdfTextFormValue[];
  /** Session-scoped signature assets and their page placements. */
  signatureState: PdfSignatureState;
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

/** Supported output formats for the PDF assembly export endpoint. */
export type PdfExportFormat = 'pdf' | 'docx';

export interface ExportRequest {
  filename?: string;
  /** Output format; defaults to 'pdf' when omitted. */
  format?: PdfExportFormat;
  pages?: number[];
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
  /** Validated AcroForm text-field values to fill before assembly. */
  formFieldValues?: PdfTextFormValue[];
  /** Signature overlays and artifact references to burn in after assembly. */
  signatureOverlays?: PdfSignatureOverlay[];
  /** Maps assetId → ExportArtifactRef so the worker can retrieve PNG bytes. */
  signatureArtifacts?: Record<string, ExportArtifactRef>;
}

export interface ExportWorkerOutput {
  success: boolean;
  pdfBytes?: Uint8Array;
  error?: string;
}

// ── Form Values API ────────────────────────────────────────────────────────────

export interface ReplaceFormValuesRequest {
  values: PdfTextFormValue[];
}

export interface ReplaceFormValuesResponse {
  values: PdfTextFormValue[];
  updatedAt: string;
}

// ── Signature API ──────────────────────────────────────────────────────────────

export interface UploadSignatureResponse {
  assetId: string;
  widthPx: number;
  heightPx: number;
  uploadedAt: string;
}

export interface ReplaceSignatureOverlaysRequest {
  overlays: PdfSignatureOverlay[];
}

export interface ReplaceSignatureOverlaysResponse {
  overlays: PdfSignatureOverlay[];
  updatedAt: string;
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
  FORM_FIELD_UNKNOWN: 'FORM_FIELD_UNKNOWN',
  FORM_FIELD_READ_ONLY: 'FORM_FIELD_READ_ONLY',
  FORM_FIELD_VALUE_TOO_LONG: 'FORM_FIELD_VALUE_TOO_LONG',
  FORM_VALUES_INVALID: 'FORM_VALUES_INVALID',
  SIGNATURE_ASSET_NOT_FOUND: 'SIGNATURE_ASSET_NOT_FOUND',
  SIGNATURE_ASSET_INVALID: 'SIGNATURE_ASSET_INVALID',
  SIGNATURE_ASSET_TOO_LARGE: 'SIGNATURE_ASSET_TOO_LARGE',
  SIGNATURE_ASSET_LIMIT_EXCEEDED: 'SIGNATURE_ASSET_LIMIT_EXCEEDED',
  SIGNATURE_OVERLAY_INVALID: 'SIGNATURE_OVERLAY_INVALID',
  SIGNATURE_OVERLAY_LIMIT_EXCEEDED: 'SIGNATURE_OVERLAY_LIMIT_EXCEEDED',
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
