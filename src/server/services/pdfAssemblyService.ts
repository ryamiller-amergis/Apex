import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pdfSessions } from '../db/schema';
import { resolveDataRoot } from '../utils/dataDir';
import { Worker } from 'worker_threads';
import type {
  FileUploadResult,
  PageManifestEntry,
  PdfFileMetadata,
  ExportWorkerInput,
  ExportWorkerOutput,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import { documentConversionService } from './documentConversionService';
import {
  enqueuePdfConversion,
  getPdfConversionJobs,
  processPendingPdfConversions,
} from './pdfConversionJobService';

// ── Config ─────────────────────────────────────────────────────────────────────

const PDF_TEMP_DIR = process.env.PDF_TEMP_DIR ?? path.join(resolveDataRoot(), 'pdf-sessions');
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

export async function cleanupSessionFiles(sessionId: string): Promise<void> {
  await fsPromises.rm(getSessionDir(sessionId), { recursive: true, force: true });
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
export async function closeSession(sessionId: string, userId: string): Promise<boolean> {
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session || session.userId !== userId) return false;
  if (session.status === 'expired') return true;

  await cleanupSessionFiles(sessionId);
  await db
    .update(pdfSessions)
    .set({ status: 'expired', updatedAt: new Date().toISOString() })
    .where(eq(pdfSessions.id, sessionId));
  return true;
}

export async function createSession(
  userId: string,
  projectId?: string,
  options?: CreateSessionOptions,
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
      const err = new Error('Session limit reached') as Error & { code: string };
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
      fileMetadata: [],
    })
    .returning();

  const row = rows[0];

  // Ensure temp directory exists for this session
  const sessionDir = getSessionDir(row.id);
  fs.mkdirSync(sessionDir, { recursive: true });

  return {
    sessionId: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function getSession(sessionId: string) {
  startPendingDocxConversions();
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });
  if (!session) return undefined;

  return {
    ...session,
    conversionJobs: await getPdfConversionJobs(sessionId),
  };
}

/** Active sessions for a user, newest first. */
export async function getActiveSessions(userId: string) {
  return db.query.pdfSessions.findMany({
    where: and(eq(pdfSessions.userId, userId), eq(pdfSessions.status, 'active')),
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
  mimeType: string,
): Promise<FileUploadResult> {
  const sanitizedOriginalName = sanitizeFilename(originalName);

  // ── MIME type check ──────────────────────────────────────────────────────────
  const isDocx =
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    path.extname(sanitizedOriginalName).toLowerCase() === '.docx';
  const isSupportedMime =
    mimeType === 'application/pdf' ||
    isDocx;

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

  // ── .docx → queue conversion and return immediately ──────────────────────────
  if (isDocx) {
    const result = await enqueuePdfConversion(
      sessionId,
      filePath,
      sanitizedOriginalName,
      mimeType,
      getSessionDir(sessionId),
      MAX_FILE_BYTES,
    );
    if (result.status === 'queued') {
      startPendingDocxConversions();
    }
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
      error: { code: PDF_ERROR_CODES.FILE_CORRUPT, message: 'File could not be read.' },
    };
  }

  if (stat.size > MAX_FILE_BYTES) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message: 'This file exceeds the 100 MB size limit. Please upload a smaller file.',
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
      error: { code: PDF_ERROR_CODES.FILE_CORRUPT, message: 'File could not be read.' },
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
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND', message: 'Session not found.' },
    };
  }

  const existingMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const currentTotalBytes = existingMetadata.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const currentTotalPages = (session.pageManifest ?? []).filter((p) => !p.deleted).length;

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
  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const destPath = path.join(sessionDir, storedName);

  try {
    await fsPromises.rename(filePath, destPath);
  } catch {
    // rename across devices fails — copy then delete
    await fsPromises.copyFile(filePath, destPath);
    await safeDeleteFile(filePath);
  }

  // ── Build updated file_metadata and page_manifest ────────────────────────────
  const newFileMeta: PdfFileMetadata = {
    fileId,
    originalName: sanitizedOriginalName,
    storedName,
    mimeType: 'application/pdf',
    sizeBytes: stat.size,
    pageCount,
    uploadedAt: new Date().toISOString(),
  };

  const existingManifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const newPages: PageManifestEntry[] = Array.from({ length: pageCount }, (_, i) => ({
    pageId: crypto.randomUUID(),
    fileId,
    sourcePageIndex: i,
    rotation: 0 as const,
    deleted: false,
  }));

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
  fileId: string,
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

  await db
    .update(pdfSessions)
    .set({
      fileMetadata: updatedMetadata,
      pageManifest: updatedManifest,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(pdfSessions.id, sessionId));

  const filePath = resolveFilePath(sessionId, fileId);
  if (filePath) {
    await safeDeleteFile(filePath);
  }
}

// ── Manifest update ────────────────────────────────────────────────────────────

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

export async function updateManifest(
  sessionId: string,
  userId: string,
  manifest: PageManifestEntry[],
): Promise<{ pageCount: number; updatedAt: string }> {
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
    ((session.fileMetadata ?? []) as PdfFileMetadata[]).map((f) => f.fileId),
  );

  for (const entry of manifest) {
    if (!knownFileIds.has(entry.fileId)) {
      const err = new Error('Invalid file ID in manifest') as Error & { code: string };
      err.code = PDF_ERROR_CODES.MANIFEST_INVALID_FILE_ID;
      throw err;
    }
    if (!VALID_ROTATIONS.has(entry.rotation)) {
      const err = new Error('Invalid rotation value') as Error & { code: string };
      err.code = PDF_ERROR_CODES.MANIFEST_INVALID_ROTATION;
      throw err;
    }
  }

  const updatedAt = new Date().toISOString();

  await db
    .update(pdfSessions)
    .set({ pageManifest: manifest, updatedAt })
    .where(eq(pdfSessions.id, sessionId));

  const pageCount = manifest.filter((p) => !p.deleted).length;

  return { pageCount, updatedAt };
}

// ── File serving ───────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the stored file, or null if not found.
 * Validates that fileId is a UUID to prevent path traversal.
 */
export function resolveFilePath(sessionId: string, fileId: string): string | null {
  // Validate UUID format to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    return null;
  }
  const filePath = path.join(getSessionDir(sessionId), `${fileId}.pdf`);
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export async function expireOldSessions(
  userId?: string,
): Promise<{ expired: number; errors: number }> {
  const now = new Date().toISOString();
  let expired = 0;
  let errors = 0;

  const expiredSessions = await db.query.pdfSessions.findMany({
    where: and(
      ...(userId ? [eq(pdfSessions.userId, userId)] : []),
      or(eq(pdfSessions.status, 'active'), eq(pdfSessions.status, 'exported')),
      lt(pdfSessions.expiresAt, now),
    ),
  });

  for (const session of expiredSessions) {
    try {
      await cleanupSessionFiles(session.id);
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
    const err = new Error('You do not have access to this session') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_FORBIDDEN;
    throw err;
  }

  if (session.status === 'expired') {
    const err = new Error('This session has expired') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_EXPIRED;
    throw err;
  }

  const manifest = (session.pageManifest ?? []) as PageManifestEntry[];
  const nonDeletedPages = manifest.filter((p) => !p.deleted);

  if (nonDeletedPages.length === 0) {
    const err = new Error('Session has no pages to export') as Error & { code: string };
    err.code = PDF_ERROR_CODES.NO_PAGES;
    throw err;
  }

  // When pages filter is provided, validate indices and select subset
  let pagesToExport = nonDeletedPages;
  if (pages && pages.length > 0) {
    const maxIndex = nonDeletedPages.length - 1;
    const invalidIndices = pages.filter((i) => i < 0 || i > maxIndex || !Number.isInteger(i));
    if (invalidIndices.length > 0) {
      const err = new Error(`Page indices out of bounds. Valid range: 0-${maxIndex}`) as Error & { code: string };
      err.code = PDF_ERROR_CODES.INVALID_PAGE_INDICES;
      throw err;
    }
    pagesToExport = pages.map((i) => nonDeletedPages[i]);
  }

  const filename = sanitizeExportFilename(rawFilename);

  const fileMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const filePaths: Record<string, string> = {};
  for (const fm of fileMetadata) {
    const resolved = resolveFilePath(sessionId, fm.fileId);
    if (resolved) {
      filePaths[fm.fileId] = resolved;
    }
  }

  const missingFiles = pagesToExport.filter((p) => !filePaths[p.fileId]);
  if (missingFiles.length > 0) {
    const err = new Error('Source files missing on disk') as Error & { code: string };
    err.code = PDF_ERROR_CODES.EXPORT_FAILED;
    throw err;
  }

  const workerInput: ExportWorkerInput = {
    manifest: pagesToExport,
    filePaths,
  };

  const result = await runPdfExport(workerInput);

  if (!result.success || !result.pdfBytes) {
    const err = new Error(result.error ?? 'PDF assembly failed. Please retry.') as Error & { code: string };
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
        expiresAt: new Date(Date.now() + EXPORTED_SESSION_CLEANUP_GRACE_MS).toISOString(),
      })
      .where(eq(pdfSessions.id, sessionId));
  }

  return {
    pdfBytes: result.pdfBytes,
    filename,
    pageCount: pagesToExport.length,
  };
}

// ── Word document conversion + ingestion ────────────────────────────────────────

export async function convertAndIngestDocx(
  sessionId: string,
  filePath: string,
  sanitizedOriginalName: string,
  originalMimeType: string,
): Promise<FileUploadResult> {
  // Read the .docx file
  let docxBuffer: Buffer;
  try {
    docxBuffer = await fsPromises.readFile(filePath);
  } catch {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: { code: PDF_ERROR_CODES.FILE_CORRUPT, message: 'File could not be read.' },
    };
  }

  // File size check (applied to the original docx)
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: { code: PDF_ERROR_CODES.FILE_CORRUPT, message: 'File could not be read.' },
    };
  }

  if (stat.size > MAX_FILE_BYTES) {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message: 'This file exceeds the 100 MB size limit. Please upload a smaller file.',
      },
    };
  }

  // Convert .docx → PDF via documentConversionService
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await documentConversionService.convert(docxBuffer, sanitizedOriginalName);
  } catch (err: unknown) {
    await safeDeleteFile(filePath);
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

  // Delete original .docx from disk immediately (security: A6)
  await safeDeleteFile(filePath);

  // Validate the converted PDF with pdf-lib
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBuffer);
  } catch {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.CONVERSION_FAILED,
        message: 'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
      },
    };
  }

  const pageCount = doc.getPageCount();
  const pdfSize = pdfBuffer.length;

  // Session-level limit checks
  const session = await db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
  });

  if (!session) {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: { code: 'SESSION_NOT_FOUND', message: 'Session not found.' },
    };
  }

  const existingMetadata = (session.fileMetadata ?? []) as PdfFileMetadata[];
  const currentTotalBytes = existingMetadata.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const currentTotalPages = (session.pageManifest ?? []).filter((p) => !p.deleted).length;

  if (currentTotalBytes + pdfSize > MAX_SESSION_BYTES) {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_SIZE_EXCEEDED,
        message: 'Adding this file would exceed the 250 MB session limit. Remove files or start a new session.',
      },
    };
  }

  if (currentTotalPages + pageCount > MAX_SESSION_PAGES) {
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.SESSION_PAGES_EXCEEDED,
        message: 'Adding this file would exceed the 500-page session limit.',
      },
    };
  }

  // Persist converted PDF to session directory
  const fileId = crypto.randomUUID();
  const storedName = `${fileId}.pdf`;
  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const destPath = path.join(sessionDir, storedName);
  await fsPromises.writeFile(destPath, pdfBuffer);

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
  const newPages: PageManifestEntry[] = Array.from({ length: pageCount }, (_, i) => ({
    pageId: crypto.randomUUID(),
    fileId,
    sourcePageIndex: i,
    rotation: 0 as const,
    deleted: false,
  }));

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
    sizeBytes: pdfSize,
    convertedFrom: sanitizedOriginalName,
  };
}

export function kickPendingDocxConversions(): Promise<void> {
  return processPendingPdfConversions(convertAndIngestDocx);
}

function startPendingDocxConversions(): void {
  void kickPendingDocxConversions().catch((error) => {
    console.error('[pdf-conversion] Background processor failed:', error);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Run PDF assembly in a worker thread when the compiled .js exists (production).
 * Under local ts-node/nodemon only the .ts source is present — worker threads do
 * not inherit the main process's -P tsconfig.server.json, so fall back to
 * in-process assemblePdf (already exported for unit tests).
 */
async function runPdfExport(input: ExportWorkerInput): Promise<ExportWorkerOutput> {
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
  return path.basename(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

async function safeDeleteFile(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // Ignore errors — file may not exist or already deleted
  }
}
