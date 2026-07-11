import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { and, asc, eq, lt } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pdfConversionJobs } from '../db/schema';
import type {
  FileUploadResult,
  PdfConversionJob,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_PROCESSING_MS = 60_000;
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

type ConversionHandler = (
  sessionId: string,
  inputPath: string,
  originalName: string,
  originalMimeType: string,
) => Promise<FileUploadResult>;

let activeProcessor: Promise<void> | null = null;

async function safeDelete(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // The conversion handler may already have removed the source document.
  }
}

export async function enqueuePdfConversion(
  sessionId: string,
  filePath: string,
  originalName: string,
  originalMimeType: string,
  sessionDir: string,
  maxFileBytes: number,
): Promise<FileUploadResult> {
  let sizeBytes: number;
  try {
    sizeBytes = (await fs.stat(filePath)).size;
  } catch {
    await safeDelete(filePath);
    return {
      originalName,
      status: 'error',
      error: { code: PDF_ERROR_CODES.FILE_CORRUPT, message: 'File could not be read.' },
    };
  }

  if (sizeBytes > maxFileBytes) {
    await safeDelete(filePath);
    return {
      originalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message: 'This file exceeds the 100 MB size limit. Please upload a smaller file.',
      },
    };
  }

  const conversionId = crypto.randomUUID();
  const queuedPath = path.join(sessionDir, `${conversionId}.docx`);
  await fs.mkdir(sessionDir, { recursive: true });

  try {
    await fs.rename(filePath, queuedPath);
  } catch {
    await fs.copyFile(filePath, queuedPath);
    await safeDelete(filePath);
  }

  try {
    await db.insert(pdfConversionJobs).values({
      id: conversionId,
      sessionId,
      originalName,
      originalMimeType,
      inputPath: queuedPath,
      status: 'queued',
    });
  } catch (error) {
    await safeDelete(queuedPath);
    throw error;
  }

  return {
    conversionId,
    originalName,
    status: 'queued',
  };
}

export async function getPdfConversionJobs(sessionId: string): Promise<PdfConversionJob[]> {
  const rows = await db.query.pdfConversionJobs.findMany({
    where: eq(pdfConversionJobs.sessionId, sessionId),
    orderBy: [asc(pdfConversionJobs.createdAt)],
  });

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    originalName: row.originalName,
    status: row.status,
    fileId: row.fileId,
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: row.errorMessage ?? 'This Word document could not be converted.',
        }
      : null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

async function claimNextJob() {
  const candidate = await db.query.pdfConversionJobs.findFirst({
    where: eq(pdfConversionJobs.status, 'queued'),
    orderBy: [asc(pdfConversionJobs.createdAt)],
  });
  if (!candidate) return null;

  const now = new Date().toISOString();
  const [claimed] = await db
    .update(pdfConversionJobs)
    .set({
      status: 'processing',
      ownerInstance: INSTANCE_ID,
      heartbeatAt: now,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(pdfConversionJobs.id, candidate.id),
      eq(pdfConversionJobs.status, 'queued'),
    ))
    .returning();

  return claimed ?? null;
}

async function recoverStaleJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  await db
    .update(pdfConversionJobs)
    .set({
      status: 'queued',
      ownerInstance: null,
      heartbeatAt: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(pdfConversionJobs.status, 'processing'),
      lt(pdfConversionJobs.heartbeatAt, staleBefore),
    ));
}

async function runProcessor(handler: ConversionHandler): Promise<void> {
  await recoverStaleJobs();

  while (true) {
    const job = await claimNextJob();
    if (!job) return;

    const heartbeatTimer = setInterval(() => {
      const heartbeatAt = new Date().toISOString();
      void (async () => {
        await db
          .update(pdfConversionJobs)
          .set({ heartbeatAt, updatedAt: heartbeatAt })
          .where(and(
            eq(pdfConversionJobs.id, job.id),
            eq(pdfConversionJobs.status, 'processing'),
            eq(pdfConversionJobs.ownerInstance, INSTANCE_ID),
          ));
      })().catch((error) => {
        console.error(`[pdf-conversion] Heartbeat failed for job ${job.id}:`, error);
      });
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const result = await handler(
        job.sessionId,
        job.inputPath,
        job.originalName,
        job.originalMimeType,
      );
      const completedAt = new Date().toISOString();

      if (result.status === 'success') {
        await db
          .update(pdfConversionJobs)
          .set({
            status: 'completed',
            fileId: result.fileId,
            completedAt,
            updatedAt: completedAt,
            errorCode: null,
            errorMessage: null,
          })
          .where(eq(pdfConversionJobs.id, job.id));
      } else {
        await db
          .update(pdfConversionJobs)
          .set({
            status: 'failed',
            completedAt,
            updatedAt: completedAt,
            errorCode: result.error?.code ?? PDF_ERROR_CODES.CONVERSION_FAILED,
            errorMessage:
              result.error?.message ??
              'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
          })
          .where(eq(pdfConversionJobs.id, job.id));
      }
    } catch (error) {
      const completedAt = new Date().toISOString();
      await db
        .update(pdfConversionJobs)
        .set({
          status: 'failed',
          completedAt,
          updatedAt: completedAt,
          errorCode: (error as { code?: string })?.code ?? PDF_ERROR_CODES.CONVERSION_FAILED,
          errorMessage:
            (error as Error)?.message ??
            'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
        })
        .where(eq(pdfConversionJobs.id, job.id));
    } finally {
      clearInterval(heartbeatTimer);
      await safeDelete(job.inputPath);
    }
  }
}

export function processPendingPdfConversions(handler: ConversionHandler): Promise<void> {
  if (activeProcessor) return activeProcessor;

  activeProcessor = runProcessor(handler).finally(() => {
    activeProcessor = null;
  });
  return activeProcessor;
}
