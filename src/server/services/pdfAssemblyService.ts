import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pdfSessions } from '../db/schema';
import { Worker } from 'worker_threads';
import type {
  FileUploadResult,
  PageManifestEntry,
  PdfFileMetadata,
  OverlayTextBox,
  ExportWorkerInput,
  ExportWorkerOutput,
  OverlayFieldError,
  ReplaceOverlaysResponse,
  ReplaceFormValuesResponse,
  ReplaceSignatureOverlaysResponse,
  UploadSignatureResponse,
  UpdateManifestResponse,
  PdfTextFormValue,
  PdfSignatureOverlay,
  PdfSignatureAsset,
  PdfSignatureState,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import { catalogTextFields, validateFormValues } from './pdfFormService';
import {
  uploadSignatureAsset as storeSignatureAsset,
  validateSignatureOverlays,
  stripOrphanedOverlays,
  pruneUnreferencedSignatureAssets,
  buildSignatureArtifactRef,
  buildSignatureArtifactRefs,
} from './pdfSignatureService';
import { documentConversionService } from './documentConversionService';
import { convertPdfToDocx } from './pdfToDocxService';
import { stripOrphanOverlays, validateOverlays } from './overlayValidation';
import {
  enqueuePdfConversion,
  enqueuePdfExport,
  getPdfConversionJobs,
  processPendingPdfJobs,
  startPdfJobPoller,
  type PdfJobRow,
} from './pdfConversionJobService';
import {
  buildPdfArtifactKey,
  getPdfArtifactStore,
  readPdfArtifact,
  type PdfArtifactRef,
} from './pdfArtifactStore';

// ── Config ─────────────────────────────────────────────────────────────────────

const PDF_TEMP_DIR =
  process.env.PDF_TEMP_DIR ?? path.join(os.tmpdir(), 'apex-pdf-uploads');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_SESSION_BYTES = 250 * 1024 * 1024; // 250 MB
const MAX_SESSION_PAGES = 500;
const MAX_CONCURRENT_SESSIONS = 3;
const EXPORTED_SESSION_CLEANUP_GRACE_MS = 15 * 60 * 1000;

// PDF magic number: first 4 bytes are "%PDF"
const PDF_MAGIC = Buffer.from('%PDF');

export function getPdfTempDir(): string {
  return PDF_TEMP_DIR;
}

export function getSessionDir(sessionId: string): string {
  return path.join(PDF_TEMP_DIR, sessionId);
}

export async function cleanupSessionFiles(
  sessionId: string,
  userId?: string
): Promise<void> {
  const resolvedUserId =
    userId ??
    (
      await db.query.pdfSessions.findFirst({
        where: eq(pdfSessions.id, sessionId),
      })
    )?.userId;
  if (resolvedUserId) {
    await getPdfArtifactStore().deleteSessionPrefix(resolvedUserId, sessionId);
  }
  await fsPromises.rm(getSessionDir(sessionId), {
    recursive: true,
    force: true,
  });
}

// ── Session management ─────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  /** Close this session before creating a new one (e.g. "New session" in the UI). */
  replaceSessionId?: string;
}

/**
 * Mark a session expired and delete its temp files.
 * Returns false when the session is missing or owned by another user.
 */
export async function closeSession(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session || session.userId !== userId) return false;
  if (session.status === 'expired') return true;

  await cleanupSessionFiles(sessionId, userId);
  await db
    .update(pdfSessions)
    .set({ status: 'expired', updatedAt: new Date().toISOString() })
    .where(eq(pdfSessions.id, sessionId));
  return true;
}

export async function createSession(
  userId: string,
  projectId?: string,
  options?: CreateSessionOptions
): Promise<{ sessionId: string; createdAt: string; expiresAt: string }> {
  // Reclaim past-due sessions so they don't block the concurrent limit.
  await expireOldSessions(userId);

  if (options?.replaceSessionId) {
    await closeSession(options.replaceSessionId, userId);
  }

  // Evict oldest active sessions until there is room for one new workspace.
  // The UI only shows one session at a time; orphaned "New session" clicks
  // previously accumulated invisible actives and blocked the user.
  let activeSessions = await getActiveSessions(userId);
  while (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
    const oldest = activeSessions[activeSessions.length - 1];
    const closed = await closeSession(oldest.id, userId);
    if (!closed) {
      const err = new Error('Session limit reached') as Error & {
        code: string;
      };
      err.code = PDF_ERROR_CODES.SESSION_LIMIT_REACHED;
      throw err;
    }
    activeSessions = await getActiveSessions(userId);
  }

  const rows = await db
    .insert(pdfSessions)
    .values({
      userId,
      projectId: projectId ?? null,
      status: 'active',
      pageManifest: [],
      textOverlays: [],
      fileMetadata: [],
    })
    .returning();

  const row = rows[0];

  return {
    sessionId: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function getSession(sessionId: string) {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) return undefined;

  const manifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const activePageIds = new Set(
    manifest.filter((page) => !page.deleted).map((page) => page.pageId)
  );
  const signatureState = stripOrphanedOverlays(
    (session.signatureState ?? { assets: [], overlays: [] }) as PdfSignatureState,
    activePageIds
  );

  return {
    ...session,
    textOverlays: session.textOverlays ?? [],
    signatureState,
    conversionJobs: await getPdfConversionJobs(sessionId),
  };
}

/**
 * Persists the authoritative overlay collection as one JSONB value.
 * Request authorization and business-rule validation are owned by FEAT-002.
 */
export async function replaceTextOverlays(
  sessionId: string,
  textOverlays: OverlayTextBox[]
): Promise<OverlayTextBox[]> {
  const rows = await db
    .update(pdfSessions)
    .set({
      textOverlays,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(pdfSessions.id, sessionId))
    .returning({ textOverlays: pdfSessions.textOverlays });

  if (rows.length === 0) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  return rows[0].textOverlays ?? [];
}

/**
 * Persists validated form-field values for a session.
 * The caller (route handler) must verify ownership and session status before
 * calling this function.  Values for unknown fields are validated by the route
 * using the file-level textFormFields catalog in fileMetadata.
 */
export async function replaceFormValues(
  sessionId: string,
  userId: string,
  incomingValues: PdfTextFormValue[]
): Promise<ReplaceFormValuesResponse> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }
  if (session.userId !== userId) {
    const err = new Error('Forbidden') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }
  if (session.status === 'expired') {
    const err = new Error('Session expired') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  // Build a catalog from all files in the session for cross-file validation.
  const allFields = ((session.fileMetadata ?? []) as PdfFileMetadata[]).flatMap(
    (f) => f.textFormFields ?? []
  );

  // Filter values to only those referencing known files in this session.
  const knownFileIds = new Set(
    ((session.fileMetadata ?? []) as PdfFileMetadata[]).map((f) => f.fileId)
  );
  const validFileValues = incomingValues.filter((v) => knownFileIds.has(v.fileId));

  const validationErrors = validateFormValues(validFileValues, allFields);
  if (validationErrors.length > 0) {
    const err = Object.assign(new Error('Form value validation failed'), {
      code: PDF_ERROR_CODES.FORM_VALUES_INVALID,
      errors: validationErrors,
    });
    throw err;
  }

  const updatedAt = new Date().toISOString();
  const rows = await db
    .update(pdfSessions)
    .set({ formFieldValues: validFileValues, updatedAt })
    .where(eq(pdfSessions.id, sessionId))
    .returning({ formFieldValues: pdfSessions.formFieldValues });

  if (rows.length === 0) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  return {
    values: (rows[0].formFieldValues ?? []) as PdfTextFormValue[],
    updatedAt,
  };
}

/**
 * Validates and stores a signature PNG asset for a session.
 * Callers must have already verified ownership.
 */
export async function addSignatureAsset(
  sessionId: string,
  userId: string,
  buffer: Buffer
): Promise<UploadSignatureResponse> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) {
    throw Object.assign(new Error('Session not found'), {
      code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
    });
  }
  if (session.userId !== userId) {
    throw Object.assign(new Error('Forbidden'), {
      code: PDF_ERROR_CODES.SESSION_FORBIDDEN,
    });
  }
  if (session.status === 'expired') {
    throw Object.assign(new Error('Session expired'), {
      code: PDF_ERROR_CODES.SESSION_EXPIRED,
    });
  }

  const currentState = (session.signatureState ?? {
    assets: [],
    overlays: [],
  }) as PdfSignatureState;
  const cleanedCurrentState = pruneUnreferencedSignatureAssets(
    currentState,
    Date.now() - 60_000
  );
  const removedAssetIds = currentState.assets
    .filter(
      (asset) =>
        !cleanedCurrentState.assets.some(
          (retained) => retained.assetId === asset.assetId
        )
    )
    .map((asset) => asset.assetId);

  const asset: PdfSignatureAsset = await storeSignatureAsset(
    userId,
    sessionId,
    buffer,
    cleanedCurrentState.assets
  );

  const updatedAssets = [...cleanedCurrentState.assets, asset];
  const updatedState: PdfSignatureState = {
    assets: updatedAssets,
    overlays: cleanedCurrentState.overlays,
  };

  await db
    .update(pdfSessions)
    .set({ signatureState: updatedState, updatedAt: asset.uploadedAt })
    .where(eq(pdfSessions.id, sessionId));

  await Promise.allSettled(
    removedAssetIds.map((assetId) =>
      getPdfArtifactStore().deleteFile(
        buildSignatureArtifactRef(userId, sessionId, assetId)
      )
    )
  );

  return {
    assetId: asset.assetId,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    uploadedAt: asset.uploadedAt,
  };
}

/**
 * Replaces the session's signature overlay array after validating all entries.
 */
export async function replaceSignatureOverlays(
  sessionId: string,
  userId: string,
  incomingOverlays: unknown[]
): Promise<ReplaceSignatureOverlaysResponse> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) {
    throw Object.assign(new Error('Session not found'), {
      code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
    });
  }
  if (session.userId !== userId) {
    throw Object.assign(new Error('Forbidden'), {
      code: PDF_ERROR_CODES.SESSION_FORBIDDEN,
    });
  }
  if (session.status === 'expired') {
    throw Object.assign(new Error('Session expired'), {
      code: PDF_ERROR_CODES.SESSION_EXPIRED,
    });
  }

  const currentState = (session.signatureState ?? {
    assets: [],
    overlays: [],
  }) as PdfSignatureState;

  const knownAssetIds = new Set(currentState.assets.map((a) => a.assetId));
  const manifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const knownPageIds = new Set(
    manifest.filter((p) => !p.deleted).map((p) => p.pageId)
  );

  const errors = validateSignatureOverlays(
    incomingOverlays,
    knownAssetIds,
    knownPageIds
  );
  if (errors.length > 0) {
    throw Object.assign(new Error(errors.join('; ')), {
      code: PDF_ERROR_CODES.SIGNATURE_OVERLAY_INVALID,
      errors,
    });
  }

  let updatedState: PdfSignatureState = {
    assets: currentState.assets,
    overlays: incomingOverlays as PdfSignatureOverlay[],
  };
  updatedState = stripOrphanedOverlays(updatedState);
  updatedState = pruneUnreferencedSignatureAssets(updatedState);
  const removedAssetIds = currentState.assets
    .filter(
      (asset) =>
        !updatedState.assets.some(
          (retained) => retained.assetId === asset.assetId
        )
    )
    .map((asset) => asset.assetId);

  const updatedAt = new Date().toISOString();
  await db
    .update(pdfSessions)
    .set({ signatureState: updatedState, updatedAt })
    .where(eq(pdfSessions.id, sessionId));

  await Promise.allSettled(
    removedAssetIds.map((assetId) =>
      getPdfArtifactStore().deleteFile(
        buildSignatureArtifactRef(userId, sessionId, assetId)
      )
    )
  );

  return { overlays: updatedState.overlays, updatedAt };
}

type OverlayValidationError = Error & {
  code: string;
  errors: OverlayFieldError[];
};

export async function updateOverlays(
  sessionId: string,
  userId: string,
  overlays: unknown
): Promise<ReplaceOverlaysResponse> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  if (session.userId !== userId) {
    const err = new Error('Forbidden') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }

  if (session.status === 'expired') {
    const err = new Error('Session expired') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  const validPageIds = new Set(
    ((session.pageManifest ?? []) as PageManifestEntry[])
      .filter((page) => !page.deleted)
      .map((page) => page.pageId)
  );
  const validation = validateOverlays(overlays, validPageIds);
  if (validation.ok === false) {
    const err = new Error(
      'One or more overlays are invalid.'
    ) as OverlayValidationError;
    err.code = PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED;
    err.errors = validation.errors;
    throw err;
  }

  const updatedAt = new Date().toISOString();
  const rows = await db
    .update(pdfSessions)
    .set({ textOverlays: validation.overlays, updatedAt })
    .where(eq(pdfSessions.id, sessionId))
    .returning({ textOverlays: pdfSessions.textOverlays });

  if (rows.length === 0) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  return {
    overlays: rows[0].textOverlays ?? [],
    updatedAt,
  };
}

/** Active sessions for a user, newest first. */
export async function getActiveSessions(userId: string) {
  return db.query.pdfSessions.findMany({
    where: and(
      eq(pdfSessions.userId, userId),
      eq(pdfSessions.status, 'active')
    ),
    orderBy: [desc(pdfSessions.createdAt)],
  });
}

export async function touchSession(sessionId: string): Promise<void> {
  const newExpiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  await db
    .update(pdfSessions)
    .set({ updatedAt: new Date().toISOString(), expiresAt: newExpiresAt })
    .where(eq(pdfSessions.id, sessionId));
}

// ── File validation & ingestion ────────────────────────────────────────────────

/**
 * Validate a file buffer and, if valid, persist it to the session temp directory
 * and update the session's file_metadata and page_manifest in the database.
 *
 * Returns a FileUploadResult.  On failure the temp file is deleted.
 */
export async function validateAndIngest(
  sessionId: string,
  filePath: string,
  originalName: string,
  mimeType: string
): Promise<FileUploadResult> {
  const sanitizedOriginalName = sanitizeFilename(originalName);

  // ── MIME type check ──────────────────────────────────────────────────────────
  const isDocx =
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    path.extname(sanitizedOriginalName).toLowerCase() === '.docx';
  const isSupportedMime = mimeType === 'application/pdf' || isDocx;

  if (!isSupportedMime) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.UNSUPPORTED_FORMAT,
        message: 'Only PDF and Word (.docx) files are supported.',
      },
    };
  }

  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
        message: 'Session not found.',
      },
    };
  }

  // ── .docx → queue conversion and return immediately ──────────────────────────
  if (isDocx) {
    const result = await enqueuePdfConversion(
      sessionId,
      session.userId,
      filePath,
      sanitizedOriginalName,
      mimeType,
      MAX_FILE_BYTES
    );
    return result;
  }

  // ── File size check ──────────────────────────────────────────────────────────
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_CORRUPT,
        message: 'File could not be read.',
      },
    };
  }

  if (stat.size > MAX_FILE_BYTES) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message:
          'This file exceeds the 100 MB size limit. Please upload a smaller file.',
      },
    };
  }

  // ── Read buffer ──────────────────────────────────────────────────────────────
  let buffer: Buffer;
  try {
    buffer = await fsPromises.readFile(filePath);
  } catch {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_CORRUPT,
        message: 'File could not be read.',
      },
    };
  }

  // ── Magic number check (%PDF-) ───────────────────────────────────────────────
  if (buffer.length < 4 || !buffer.slice(0, 4).equals(PDF_MAGIC)) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_NOT_PDF,
        message: 'This file is damaged or not a valid PDF.',
      },
    };
  }

  // ── pdf-lib parse ────────────────────────────────────────────────────────────
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: false });
  } catch (err: unknown) {
    await safeDeleteFile(filePath);
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (
      message.includes('encrypt') ||
      message.includes('password') ||
      message.includes('encrypted')
    ) {
      return {
        originalName: sanitizedOriginalName,
        status: 'error',
        error: {
          code: PDF_ERROR_CODES.FILE_ENCRYPTED,
          message: 'This PDF is password-protected and cannot be processed.',
        },
      };
    }
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_CORRUPT,
        message: 'This file is damaged or not a valid PDF.',
      },
    };
  }

  // Check for encrypted doc (some versions set isEncrypted without throwing)
  if (doc.isEncrypted) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_ENCRYPTED,
        message: 'This PDF is password-protected and cannot be processed.',
      },
    };
  }

  const pageCount = doc.getPageCount();

  // ── Fetch current session state for aggregate limit checks ───────────────────
  const existingMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const currentTotalBytes = existingMetadata.reduce(
    (sum, f) => sum + (f.sizeBytes ?? 0),
    0
  );
  const currentTotalPages = (session.pageManifest ?? []).filter(
    (p) => !p.deleted
  ).length;

  if (currentTotalBytes + stat.size > MAX_SESSION_BYTES) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_SIZE_EXCEEDED,
        message:
          'Adding this file would exceed the 250 MB session limit. Remove files or start a new session.',
      },
    };
  }

  if (currentTotalPages + pageCount > MAX_SESSION_PAGES) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED,
        message: 'Adding this file would exceed the 500-page session limit.',
      },
    };
  }

  // ── Persist the file with a UUID storage name ────────────────────────────────
  const fileId = crypto.randomUUID();
  const storedName = `${fileId}.pdf`;
  await getPdfArtifactStore().putFile(
    { userId: session.userId, sessionId, fileName: storedName },
    buffer
  );
  await safeDeleteFile(filePath);

  // ── Build updated file_metadata and page_manifest ────────────────────────────
  const textFormFields = await catalogTextFields(buffer);
  const newFileMeta: PdfFileMetadata = {
    fileId,
    originalName: sanitizedOriginalName,
    storedName,
    mimeType: 'application/pdf',
    sizeBytes: stat.size,
    pageCount,
    uploadedAt: new Date().toISOString(),
    ...(textFormFields.length > 0 ? { textFormFields } : {}),
  };

  const existingManifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const newPages: PageManifestEntry[] = Array.from(
    { length: pageCount },
    (_, i) => ({
      pageId: crypto.randomUUID(),
      fileId,
      sourcePageIndex: i,
      rotation: 0 as const,
      deleted: false,
    })
  );

  await db
    .update(pdfSessions)
    .set({
      fileMetadata: [...existingMetadata, newFileMeta],
      pageManifest: [...existingManifest, ...newPages],
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })
    .where(eq(pdfSessions.id, sessionId));

  return {
    fileId,
    originalName: sanitizedOriginalName,
    status: 'success',
    pageCount,
    sizeBytes: stat.size,
  };
}

// ── File removal ───────────────────────────────────────────────────────────────

export async function removeFile(
  sessionId: string,
  userId: string,
  fileId: string
): Promise<void> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  if (session.userId !== userId) {
    const err = new Error('Forbidden') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }

  if (session.status === 'expired') {
    const err = new Error('Session expired') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  const existingMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const fileMeta = existingMetadata.find((f) => f.fileId === fileId);
  if (!fileMeta) {
    const err = new Error('File not found') as Error & { code: string };
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }

  const updatedMetadata = existingMetadata.filter((f) => f.fileId !== fileId);
  const existingManifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const updatedManifest = existingManifest.filter((p) => p.fileId !== fileId);
  const updatedOverlays = stripOrphanOverlays(
    updatedManifest,
    (session.textOverlays ?? []) as OverlayTextBox[]
  );
  // Discard form-field values for the removed source file.
  const updatedFormValues = ((session.formFieldValues ?? []) as PdfTextFormValue[]).filter(
    (v) => v.fileId !== fileId
  );
  const activePageIds = new Set(
    updatedManifest.filter((page) => !page.deleted).map((page) => page.pageId)
  );
  const updatedSignatureState = stripOrphanedOverlays(
    (session.signatureState ?? { assets: [], overlays: [] }) as PdfSignatureState,
    activePageIds
  );

  await db
    .update(pdfSessions)
    .set({
      fileMetadata: updatedMetadata,
      pageManifest: updatedManifest,
      textOverlays: updatedOverlays,
      formFieldValues: updatedFormValues,
      signatureState: updatedSignatureState,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(pdfSessions.id, sessionId));

  await getPdfArtifactStore().deleteFile({
    userId,
    sessionId,
    fileName: `${fileId}.pdf`,
  });
}

// ── Manifest update ────────────────────────────────────────────────────────────

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

export async function updateManifest(
  sessionId: string,
  userId: string,
  manifest: PageManifestEntry[]
): Promise<UpdateManifestResponse> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  if (session.userId !== userId) {
    const err = new Error('Forbidden') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }

  if (session.status === 'expired') {
    const err = new Error('Session expired') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  const knownFileIds = new Set(
    ((session.fileMetadata ?? []) as PdfFileMetadata[]).map((f) => f.fileId)
  );

  for (const entry of manifest) {
    if (!knownFileIds.has(entry.fileId)) {
      const err = new Error('Invalid file ID in manifest') as Error & {
        code: string;
      };
      err.code = PDF_ERROR_CODES.MANIFEST_INVALID_FILE_ID;
      throw err;
    }
    if (!VALID_ROTATIONS.has(entry.rotation)) {
      const err = new Error('Invalid rotation value') as Error & {
        code: string;
      };
      err.code = PDF_ERROR_CODES.MANIFEST_INVALID_ROTATION;
      throw err;
    }
  }

  const updatedAt = new Date().toISOString();
  const textOverlays = stripOrphanOverlays(
    manifest,
    (session.textOverlays ?? []) as OverlayTextBox[]
  );
  const activePageIds = new Set(
    manifest.filter((page) => !page.deleted).map((page) => page.pageId)
  );
  const signatureState = stripOrphanedOverlays(
    (session.signatureState ?? { assets: [], overlays: [] }) as PdfSignatureState,
    activePageIds
  );

  await db
    .update(pdfSessions)
    .set({ pageManifest: manifest, textOverlays, signatureState, updatedAt })
    .where(eq(pdfSessions.id, sessionId));

  const pageCount = manifest.filter((p) => !p.deleted).length;

  return { pageCount, updatedAt, textOverlays };
}

// ── File serving ───────────────────────────────────────────────────────────────

export async function getPdfFileStream(
  sessionId: string,
  userId: string,
  fileId: string
): Promise<NodeJS.ReadableStream | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      fileId
    )
  ) {
    return null;
  }
  const ref = { userId, sessionId, fileName: `${fileId}.pdf` };
  if (!(await getPdfArtifactStore().exists(ref))) return null;
  return getPdfArtifactStore().getStream(ref);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export async function expireOldSessions(
  userId?: string
): Promise<{ expired: number; errors: number }> {
  const now = new Date().toISOString();
  let expired = 0;
  let errors = 0;

  const expiredSessions = await db.query.pdfSessions.findMany({
    where: and(
      ...(userId ? [eq(pdfSessions.userId, userId)] : []),
      or(eq(pdfSessions.status, 'active'), eq(pdfSessions.status, 'exported')),
      lt(pdfSessions.expiresAt, now)
    ),
  });

  for (const session of expiredSessions) {
    try {
      await cleanupSessionFiles(session.id, session.userId);
      await db
        .update(pdfSessions)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(pdfSessions.id, session.id));
      expired++;
    } catch {
      errors++;
    }
  }

  return { expired, errors };
}

// ── Export ─────────────────────────────────────────────────────────────────────

const FILENAME_DISALLOWED = /[/\\:*?"<>|]/g;
const MAX_FILENAME_LENGTH = 255;

export function sanitizeExportFilename(raw?: string): string {
  if (!raw || raw.trim().length === 0) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
    return `merged-document-${stamp}.pdf`;
  }

  let name = raw.trim().replace(FILENAME_DISALLOWED, '');
  if (name.length === 0) {
    return sanitizeExportFilename(); // all chars were disallowed — fall back to default
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    name = name.slice(0, MAX_FILENAME_LENGTH);
  }
  if (!name.toLowerCase().endsWith('.pdf')) {
    name += '.pdf';
  }
  return name;
}

export function deriveExportFilename(
  pagesToExport: PageManifestEntry[],
  fileMetadata: PdfFileMetadata[],
  rawOverride?: string,
  isSelectedExport?: boolean
): string {
  if (rawOverride?.trim()) {
    return sanitizeExportFilename(rawOverride);
  }

  const metadataById = new Map(
    fileMetadata.map((metadata) => [metadata.fileId, metadata] as const)
  );
  const contributors: PdfFileMetadata[] = [];
  const seen = new Set<string>();

  for (const page of pagesToExport) {
    const metadata = metadataById.get(page.fileId);
    if (!metadata) {
      return sanitizeExportFilename();
    }
    if (!seen.has(page.fileId)) {
      seen.add(page.fileId);
      contributors.push(metadata);
    }
  }

  if (contributors.length === 1) {
    if (isSelectedExport) {
      const firstName = contributors[0].originalName;
      if (!firstName) return sanitizeExportFilename();
      const stem = firstName
        .replace(/\.[^.]*$/, '')
        .replace(FILENAME_DISALLOWED, '')
        .trim();
      if (!stem) {
        return sanitizeExportFilename();
      }
      return sanitizeExportFilename(`${stem}-selected.pdf`);
    }
    return sanitizeExportFilename(contributors[0].originalName);
  }

  if (contributors.length > 1) {
    const firstName = contributors[0].originalName;
    if (!firstName) return sanitizeExportFilename();
    const stem = firstName
      .replace(/\.[^.]*$/, '')
      .replace(FILENAME_DISALLOWED, '')
      .trim();
    if (!stem) {
      return sanitizeExportFilename();
    }
    return sanitizeExportFilename(`${stem}-combined.pdf`);
  }

  return sanitizeExportFilename();
}

export interface AssembleAndExportResult {
  pdfBytes: Uint8Array;
  filename: string;
  pageCount: number;
}

export async function assembleAndExport(
  sessionId: string,
  userId: string,
  rawFilename?: string,
  pages?: number[],
  workerOutputRef?: PdfArtifactRef
): Promise<AssembleAndExportResult> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    const err = new Error('Session not found') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_NOT_FOUND;
    throw err;
  }

  if (session.userId !== userId) {
    const err = new Error('You do not have access to this session') as Error & {
      code: string;
    };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }

  if (session.status === 'expired') {
    const err = new Error('This session has expired') as Error & {
      code: string;
    };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  const manifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const nonDeletedPages = manifest.filter((p) => !p.deleted);

  if (nonDeletedPages.length === 0) {
    const err = new Error('Session has no pages to export') as Error & {
      code: string;
    };
    err.code = PDF_ERROR_CODES.NO_PAGES;
    throw err;
  }

  // When pages filter is provided, validate indices and select subset
  let pagesToExport = nonDeletedPages;
  if (pages && pages.length > 0) {
    const maxIndex = nonDeletedPages.length - 1;
    const invalidIndices = pages.filter(
      (i) => i < 0 || i > maxIndex || !Number.isInteger(i)
    );
    if (invalidIndices.length > 0) {
      const err = new Error(
        `Page indices out of bounds. Valid range: 0-${maxIndex}`
      ) as Error & { code: string };
      err.code = PDF_ERROR_CODES.INVALID_PAGE_INDICES;
      throw err;
    }
    pagesToExport = pages.map((i) => nonDeletedPages[i]);
  }

  const overlayValidation = validateOverlays(
    session.textOverlays ?? [],
    new Set(nonDeletedPages.map((page) => page.pageId))
  );
  if (overlayValidation.ok === false) {
    const err = new Error(
      'Saved text overlays are invalid and cannot be exported.'
    ) as Error & { code: string; errors: OverlayFieldError[] };
    err.code = PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED;
    err.errors = overlayValidation.errors;
    throw err;
  }
  const exportedPageIds = new Set(pagesToExport.map((page) => page.pageId));
  const overlays = overlayValidation.overlays.filter((overlay) =>
    exportedPageIds.has(overlay.pageId)
  );
  const fileMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const filename = deriveExportFilename(
    pagesToExport,
    fileMetadata,
    rawFilename,
    pages != null && pages.length > 0
  );
  const fileBytes: Record<string, Uint8Array> = {};
  const artifactFiles: Record<string, PdfArtifactRef> = {};
  if (workerOutputRef) {
    for (const fm of fileMetadata) {
      artifactFiles[fm.fileId] = {
        userId,
        sessionId,
        fileName: `${fm.fileId}.pdf`,
      };
    }
  } else {
    for (const fm of fileMetadata) {
      const ref = { userId, sessionId, fileName: `${fm.fileId}.pdf` };
      if (await getPdfArtifactStore().exists(ref)) {
        fileBytes[fm.fileId] = await readPdfArtifact(ref);
      }
    }

    const missingFiles = pagesToExport.filter((p) => !fileBytes[p.fileId]);
    if (missingFiles.length > 0) {
      const err = new Error('Source PDF artifacts are missing') as Error & {
        code: string;
      };
      err.code = PDF_ERROR_CODES.EXPORT_FAILED;
      throw err;
    }
  }

  // Prepare form values and signature state for the export worker.
  const formFieldValues = (session.formFieldValues ?? []) as PdfTextFormValue[];
  const signatureState = (session.signatureState ?? { assets: [], overlays: [] }) as PdfSignatureState;
  const signatureOverlays = signatureState.overlays.filter((o) =>
    exportedPageIds.has(o.pageId)
  );
  const signatureArtifacts = buildSignatureArtifactRefs(userId, sessionId, signatureState);

  const workerInput: ExportWorkerInput = {
    manifest: pagesToExport,
    overlays,
    ...(workerOutputRef
      ? { artifactFiles, outputRef: workerOutputRef }
      : { fileBytes }),
    formFieldValues,
    signatureOverlays,
    signatureArtifacts,
  };

  const result = await runPdfExport(workerInput);

  if (!result.success || (!workerOutputRef && !result.pdfBytes)) {
    const err = new Error(
      result.error ?? 'PDF assembly failed. Please retry.'
    ) as Error & { code: string };
    err.code = PDF_ERROR_CODES.EXPORT_FAILED;
    throw err;
  }

  const isPartialExport = pages !== undefined && pages.length > 0;
  if (isPartialExport) {
    // Extraction is non-destructive; keep the assembly available for more work.
    await touchSession(sessionId);
  } else {
    // Final export completes the session. The route removes files after the
    // response finishes; this short expiry is a fallback if that cleanup fails.
    await db
      .update(pdfSessions)
      .set({
        status: 'exported' as const,
        exportFilename: filename,
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() + EXPORTED_SESSION_CLEANUP_GRACE_MS
        ).toISOString(),
      })
      .where(eq(pdfSessions.id, sessionId));
  }

  return {
    pdfBytes: result.pdfBytes ?? new Uint8Array(),
    filename,
    pageCount: pagesToExport.length,
  };
}

// ── Word document conversion + ingestion ────────────────────────────────────────

interface ConvertDocxOptions {
  userId?: string;
  fileId?: string;
  preserveInputOnFailure?: boolean;
}

export async function convertAndIngestDocx(
  sessionId: string,
  inputKeyOrPath: string,
  sanitizedOriginalName: string,
  originalMimeType: string,
  options: ConvertDocxOptions = {}
): Promise<FileUploadResult> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
        message: 'Session not found.',
      },
    };
  }
  const resolvedUserId = options.userId ?? session.userId;
  const isArtifactKey = inputKeyOrPath.startsWith(
    `${resolvedUserId}/${sessionId}/`
  );
  const inputRef = isArtifactKey
    ? {
        userId: resolvedUserId,
        sessionId,
        fileName: path.basename(inputKeyOrPath),
      }
    : undefined;
  const deleteInput = async () => {
    if (inputRef) await getPdfArtifactStore().deleteFile(inputRef);
    else await safeDeleteFile(inputKeyOrPath);
  };
  const deleteFailedInput = async () => {
    if (!options.preserveInputOnFailure) await deleteInput();
  };
  const existingMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const alreadyIngested = options.fileId
    ? existingMetadata.find((metadata) => metadata.fileId === options.fileId)
    : undefined;
  if (alreadyIngested) {
    await deleteInput();
    return {
      fileId: alreadyIngested.fileId,
      originalName: alreadyIngested.originalName,
      status: 'success',
      pageCount: alreadyIngested.pageCount,
      sizeBytes: alreadyIngested.sizeBytes,
      convertedFrom: alreadyIngested.convertedFrom,
    };
  }

  let docxBuffer: Buffer;
  try {
    docxBuffer = inputRef
      ? await readPdfArtifact(inputRef)
      : await fsPromises.readFile(inputKeyOrPath);
  } catch {
    await deleteFailedInput();
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_CORRUPT,
        message: 'File could not be read.',
      },
    };
  }

  let sourceSize = docxBuffer.length;
  if (!inputRef) {
    try {
      sourceSize = fs.statSync(inputKeyOrPath).size;
    } catch {
      await deleteFailedInput();
      return {
        originalName: sanitizedOriginalName,
        status: 'error',
        error: {
          code: PDF_ERROR_CODES.FILE_CORRUPT,
          message: 'File could not be read.',
        },
      };
    }
  }

  if (sourceSize > MAX_FILE_BYTES) {
    await deleteFailedInput();
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message:
          'This file exceeds the 100 MB size limit. Please upload a smaller file.',
      },
    };
  }

  // Convert .docx → PDF via documentConversionService
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await documentConversionService.convert(
      docxBuffer,
      sanitizedOriginalName
    );
  } catch (err: unknown) {
    await deleteFailedInput();
    const code = (err as any)?.code ?? PDF_ERROR_CODES.CONVERSION_FAILED;
    const message =
      (err as Error)?.message ??
      'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.';
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: { code, message },
    };
  }

  // Validate the converted PDF with pdf-lib
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    await deleteFailedInput();
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.CONVERSION_FAILED,
        message:
          'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
      },
    };
  }

  const pageCount = doc.getPageCount();
  const pdfSize = pdfBuffer.length;

  // Session-level limit checks
  const currentTotalBytes = existingMetadata.reduce(
    (sum, f) => sum + (f.sizeBytes ?? 0),
    0
  );
  const currentTotalPages = (session.pageManifest ?? []).filter(
    (p) => !p.deleted
  ).length;

  if (currentTotalBytes + pdfSize > MAX_SESSION_BYTES) {
    await deleteFailedInput();
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_SIZE_EXCEEDED,
        message:
          'Adding this file would exceed the 250 MB session limit. Remove files or start a new session.',
      },
    };
  }

  if (currentTotalPages + pageCount > MAX_SESSION_PAGES) {
    await deleteFailedInput();
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED,
        message: 'Adding this file would exceed the 500-page session limit.',
      },
    };
  }

  const fileId = options.fileId ?? crypto.randomUUID();
  const storedName = `${fileId}.pdf`;
  await getPdfArtifactStore().putFile(
    { userId: resolvedUserId, sessionId, fileName: storedName },
    pdfBuffer
  );

  // Build file metadata with convertedFrom provenance
  const newFileMeta: PdfFileMetadata = {
    fileId,
    originalName: sanitizedOriginalName,
    storedName,
    mimeType: 'application/pdf',
    sizeBytes: pdfSize,
    pageCount,
    convertedFrom: sanitizedOriginalName,
    originalMimeType: originalMimeType,
    uploadedAt: new Date().toISOString(),
  };

  const existingManifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const newPages: PageManifestEntry[] = Array.from(
    { length: pageCount },
    (_, i) => ({
      pageId: crypto.randomUUID(),
      fileId,
      sourcePageIndex: i,
      rotation: 0 as const,
      deleted: false,
    })
  );

  await db
    .update(pdfSessions)
    .set({
      fileMetadata: [...existingMetadata, newFileMeta],
      pageManifest: [...existingManifest, ...newPages],
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })
    .where(eq(pdfSessions.id, sessionId));

  await deleteInput();

  return {
    fileId,
    originalName: sanitizedOriginalName,
    status: 'success',
    pageCount,
    sizeBytes: pdfSize,
    convertedFrom: sanitizedOriginalName,
  };
}

export async function queuePdfExport(
  sessionId: string,
  userId: string,
  rawFilename?: string,
  pages?: number[],
  format: 'pdf' | 'docx' = 'pdf',
) {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) {
    throw Object.assign(new Error('Session not found'), {
      code: PDF_ERROR_CODES.SESSION_NOT_FOUND,
    });
  }
  if (session.userId !== userId) {
    throw Object.assign(new Error('You do not have access to this session'), {
      code: PDF_ERROR_CODES.SESSION_FORBIDDEN,
    });
  }
  if (session.status === 'expired') {
    throw Object.assign(new Error('This session has expired'), {
      code: PDF_ERROR_CODES.SESSION_EXPIRED,
    });
  }

  const activePages = (
    (session.pageManifest ?? []) as PageManifestEntry[]
  ).filter((entry) => !entry.deleted);
  if (activePages.length === 0) {
    throw Object.assign(new Error('Session has no pages to export'), {
      code: PDF_ERROR_CODES.NO_PAGES,
    });
  }
  if (
    pages?.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= activePages.length
    )
  ) {
    throw Object.assign(
      new Error(
        `Page indices out of bounds. Valid range: 0-${activePages.length - 1}`
      ),
      {
        code: PDF_ERROR_CODES.INVALID_PAGE_INDICES,
      }
    );
  }
  return enqueuePdfExport(
    sessionId,
    userId,
    rawFilename?.trim() ? rawFilename : undefined,
    pages,
    format,
  );
}

export async function processPdfJob(job: PdfJobRow) {
  if (job.jobType === 'docx_convert') {
    const result = await convertAndIngestDocx(
      job.sessionId,
      job.inputKey,
      job.originalName,
      job.originalMimeType,
      {
        userId: job.userId,
        fileId: job.id,
        preserveInputOnFailure: true,
      }
    );
    if (result.status !== 'success') {
      const error = Object.assign(
        new Error(result.error?.message ?? 'Word document conversion failed.'),
        { code: result.error?.code ?? PDF_ERROR_CODES.CONVERSION_FAILED }
      );
      throw error;
    }
    return { fileId: result.fileId, result: { fileId: result.fileId } };
  }

  const payload = job.payload as {
    filename?: string;
    pages?: number[];
    resultFileName?: string;
    format?: 'pdf' | 'docx';
  };
  const format = payload.format ?? 'pdf';

  if (format === 'docx') {
    // ── DOCX export: assemble → convert → store ────────────────────────────
    // 1. Use a temporary PDF ref for the intermediate assembled PDF.
    const tempResultFileName = `${job.id}-tmp.pdf`;
    const tempRef: PdfArtifactRef = {
      userId: job.userId,
      sessionId: job.sessionId,
      fileName: tempResultFileName,
    };

    // 2. Run PDF assembly into the temp artifact slot.
    const assembleResult = await assembleAndExport(
      job.sessionId,
      job.userId,
      payload.filename,
      payload.pages,
      tempRef,
    );

    // 3. Convert the assembled PDF bytes to DOCX.
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await readPdfArtifact(tempRef);
    } catch {
      throw Object.assign(new Error('Failed to read intermediate PDF artifact for DOCX conversion.'), {
        code: PDF_ERROR_CODES.EXPORT_FAILED,
      });
    }

    let docxBuffer: Buffer;
    try {
      // Use the pdfjs-based text-extraction path instead of LibreOffice WASM,
      // which does not support PDF→DOCX in the Node.js worker-thread context.
      docxBuffer = await convertPdfToDocx(Buffer.from(pdfBytes));
    } finally {
      // Always clean up the intermediate PDF regardless of whether conversion succeeded.
      try {
        await getPdfArtifactStore().deleteFile(tempRef);
      } catch {
        // best-effort cleanup
      }
    }

    // 4. Derive the user-facing DOCX filename.
    const docxResultFileName = payload.resultFileName ?? `${job.id}.docx`;
    const baseFilename = payload.filename?.trim()
      ? payload.filename.replace(/\.pdf$/i, '').replace(/\.docx$/i, '') + '.docx'
      : assembleResult.filename.replace(/\.pdf$/i, '') + '.docx';

    // 5. Store the DOCX artifact.
    const docxRef: PdfArtifactRef = {
      userId: job.userId,
      sessionId: job.sessionId,
      fileName: docxResultFileName,
    };
    await getPdfArtifactStore().putFile(docxRef, docxBuffer);

    return {
      result: {
        filename: baseFilename,
        pageCount: assembleResult.pageCount,
        resultFileName: docxResultFileName,
        resultKey: buildPdfArtifactKey(docxRef),
        format: 'docx',
      },
    };
  }

  // ── PDF export (default path, unchanged) ────────────────────────────────────
  const resultFileName = payload.resultFileName ?? `${job.id}.pdf`;
  const ref: PdfArtifactRef = {
    userId: job.userId,
    sessionId: job.sessionId,
    fileName: resultFileName,
  };
  const result = await assembleAndExport(
    job.sessionId,
    job.userId,
    payload.filename,
    payload.pages,
    ref
  );
  return {
    result: {
      filename: result.filename,
      pageCount: result.pageCount,
      resultFileName,
      resultKey: buildPdfArtifactKey(ref),
      format: 'pdf',
    },
  };
}

export function kickPendingDocxConversions(): Promise<void> {
  return processPendingPdfJobs(processPdfJob);
}

export function startPdfProcessingPoller(): void {
  startPdfJobPoller(processPdfJob);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Run PDF assembly in a worker thread when the compiled .js exists (production).
 * Under local ts-node/nodemon only the .ts source is present — worker threads do
 * not inherit the main process's -P tsconfig.server.json, so fall back to
 * in-process assemblePdf (already exported for unit tests).
 */
async function runPdfExport(
  input: ExportWorkerInput
): Promise<ExportWorkerOutput> {
  const jsPath = path.join(__dirname, '../workers/pdfExportWorker.js');
  if (fs.existsSync(jsPath)) {
    return new Promise<ExportWorkerOutput>((resolve, reject) => {
      const worker = new Worker(jsPath, { workerData: input });
      worker.on('message', (msg: ExportWorkerOutput) => resolve(msg));
      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }

  const { assemblePdf } = await import('../workers/pdfExportWorker');
  return assemblePdf(input);
}

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function safeDeleteFile(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // Ignore errors — file may not exist or already deleted
  }
}
