import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pdfSessions } from '../db/schema';
import type {
  FileUploadResult,
  PageManifestEntry,
  PdfFileMetadata,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Config ─────────────────────────────────────────────────────────────────────

const PDF_TEMP_DIR = process.env.PDF_TEMP_DIR ?? path.join(os.tmpdir(), 'apex-pdf-sessions');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_SESSION_BYTES = 250 * 1024 * 1024; // 250 MB
const MAX_SESSION_PAGES = 500;
const MAX_CONCURRENT_SESSIONS = 3;

// PDF magic number: first 4 bytes are "%PDF"
const PDF_MAGIC = Buffer.from('%PDF');

export function getPdfTempDir(): string {
  return PDF_TEMP_DIR;
}

export function getSessionDir(sessionId: string): string {
  return path.join(PDF_TEMP_DIR, sessionId);
}

// ── Session management ─────────────────────────────────────────────────────────

export async function createSession(
  userId: string,
  projectId?: string,
): Promise<{ sessionId: string; createdAt: string; expiresAt: string }> {
  // Enforce concurrent session limit
  const activeSessions = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pdfSessions)
    .where(and(eq(pdfSessions.userId, userId), eq(pdfSessions.status, 'active')));

  const count = activeSessions[0]?.count ?? 0;
  if (count >= MAX_CONCURRENT_SESSIONS) {
    const err = new Error('Session limit reached') as Error & { code: string };
    err.code = PDF_ERROR_CODES.SESSION_LIMIT_REACHED;
    throw err;
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
  return db.query.pdfSessions.findFirst({
    where: eq(pdfSessions.id, sessionId),
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
  const isSupportedMime =
    mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

  // DOCX files are not yet handled by this service (requires documentConversionService)
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    await safeDeleteFile(filePath);
    return {
      originalName: sanitizedOriginalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.UNSUPPORTED_FORMAT,
        message: 'Word document conversion is not yet available.',
      },
    };
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

export async function expireOldSessions(): Promise<{ expired: number; errors: number }> {
  const now = new Date().toISOString();
  let expired = 0;
  let errors = 0;

  const expiredSessions = await db.query.pdfSessions.findMany({
    where: and(eq(pdfSessions.status, 'active'), lt(pdfSessions.expiresAt, now)),
  });

  for (const session of expiredSessions) {
    try {
      const sessionDir = getSessionDir(session.id);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
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

// ── Utilities ─────────────────────────────────────────────────────────────────

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
