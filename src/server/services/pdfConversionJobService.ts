import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { pdfConversionJobs } from '../db/schema';
import type {
  EnqueueExportResponse,
  FileUploadResult,
  PdfConversionJob,
  PdfJobType,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import {
  buildPdfArtifactKey,
  getPdfArtifactStore,
  type PdfArtifactRef,
} from './pdfArtifactStore';
import { trackEvent } from './telemetry';

type PdfJobRow = typeof pdfConversionJobs.$inferSelect;

export interface PdfJobExecutionResult {
  fileId?: string;
  result?: Record<string, unknown>;
}

export type PdfJobHandler = (job: PdfJobRow) => Promise<PdfJobExecutionResult>;

export class PdfQueueSaturatedError extends Error {
  readonly status = 429;
  readonly code = 'PDF_QUEUE_SATURATED';

  constructor(
    message: string,
    readonly retryAfterSeconds = 5
  ) {
    super(message);
    this.name = 'PdfQueueSaturatedError';
  }
}

function envInt(name: string, fallback: number, minimum = 1): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.floor(parsed))
    : fallback;
}

const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const GLOBAL_LIMIT = envInt('PDF_MAX_CONCURRENT_JOBS', 40);
const INSTANCE_LIMIT = envInt('PDF_MAX_CONCURRENT_JOBS_PER_INSTANCE', 7);
const USER_LIMIT = envInt('PDF_MAX_CONCURRENT_JOBS_PER_USER', 3);
const USER_BACKLOG_LIMIT = envInt('PDF_MAX_QUEUED_JOBS_PER_USER', 12);
const QUEUE_DEPTH_LIMIT = envInt('PDF_MAX_QUEUE_DEPTH', 200);
const LEASE_MS = envInt('PDF_JOB_LEASE_MS', 20 * 60_000, 60_000);
const HEARTBEAT_INTERVAL_MS = Math.min(
  envInt('PDF_JOB_HEARTBEAT_MS', 30_000, 5_000),
  Math.floor(LEASE_MS / 3)
);
const POLL_INTERVAL_MS = envInt('PDF_JOB_POLL_INTERVAL_MS', 1_000, 250);

const activeJobs = new Set<string>();
let activeProcessor: Promise<void> | null = null;
let pollTimer: NodeJS.Timeout | undefined;
let metricsTimer: NodeJS.Timeout | undefined;
let pollHandler: PdfJobHandler | undefined;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | undefined)?.rows;
  return rows ?? [];
}

function mapClaimedJobRow(row: Record<string, unknown>): PdfJobRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobType: row.job_type,
    userId: row.user_id,
    originalName: row.original_name,
    originalMimeType: row.original_mime_type,
    inputKey: row.input_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    result: row.result,
    fileId: row.file_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    ownerInstance: row.owner_instance,
    heartbeatAt: row.heartbeat_at,
    lockExpiresAt: row.lock_expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as PdfJobRow;
}

async function safeDelete(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Multer cleanup is best-effort.
  }
}

function fileNameFromKey(key: string): string {
  const fileName = key.split('/').pop();
  if (!fileName) throw new Error('Invalid PDF artifact key');
  return fileName;
}

export async function assertPdfQueueCapacity(userId: string): Promise<void> {
  const countsResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queue_depth,
      COUNT(*) FILTER (
        WHERE user_id = ${userId} AND status IN ('queued', 'processing')
      )::int AS user_depth
    FROM pdf_conversion_jobs
    WHERE status IN ('queued', 'processing')
  `);
  const counts = resultRows<{ queue_depth: number; user_depth: number }>(
    countsResult
  )[0] ?? {
    queue_depth: 0,
    user_depth: 0,
  };

  if (
    Number(counts.user_depth) >= USER_BACKLOG_LIMIT ||
    Number(counts.queue_depth) >= QUEUE_DEPTH_LIMIT
  ) {
    console.warn('[pdf-queue] Enqueue rejected', {
      userId,
      userDepth: Number(counts.user_depth),
      queueDepth: Number(counts.queue_depth),
      userBacklogLimit: USER_BACKLOG_LIMIT,
      queueDepthLimit: QUEUE_DEPTH_LIMIT,
    });
    trackEvent(
      'PdfQueueBackpressure',
      { userId },
      {
        userDepth: Number(counts.user_depth),
        queueDepth: Number(counts.queue_depth),
      }
    );
    throw new PdfQueueSaturatedError(
      'PDF processing is busy. Please retry shortly.'
    );
  }
}

export async function enqueuePdfConversion(
  sessionId: string,
  userId: string,
  filePath: string,
  originalName: string,
  originalMimeType: string,
  maxFileBytes: number
): Promise<FileUploadResult> {
  let sizeBytes: number;
  try {
    sizeBytes = (await fs.stat(filePath)).size;
  } catch {
    await safeDelete(filePath);
    return {
      originalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_CORRUPT,
        message: 'File could not be read.',
      },
    };
  }

  if (sizeBytes > maxFileBytes) {
    await safeDelete(filePath);
    return {
      originalName,
      status: 'error',
      error: {
        code: PDF_ERROR_CODES.FILE_TOO_LARGE,
        message:
          'This file exceeds the 100 MB size limit. Please upload a smaller file.',
      },
    };
  }

  try {
    await assertPdfQueueCapacity(userId);
  } catch (error) {
    await safeDelete(filePath);
    throw error;
  }
  const conversionId = crypto.randomUUID();
  const ref: PdfArtifactRef = {
    userId,
    sessionId,
    fileName: `${conversionId}.docx`,
  };
  const inputKey = buildPdfArtifactKey(ref);
  await getPdfArtifactStore().putFile(ref, filePath);

  try {
    await db.insert(pdfConversionJobs).values({
      id: conversionId,
      sessionId,
      jobType: 'docx_convert',
      userId,
      originalName,
      originalMimeType,
      inputKey,
      status: 'queued',
      payload: { inputFileName: ref.fileName },
    });
  } catch (error) {
    await getPdfArtifactStore().deleteFile(ref);
    throw error;
  } finally {
    await safeDelete(filePath);
  }

  return { conversionId, originalName, status: 'queued' };
}

export async function enqueuePdfExport(
  sessionId: string,
  userId: string,
  filename?: string,
  pages?: number[]
): Promise<EnqueueExportResponse> {
  await assertPdfQueueCapacity(userId);
  const jobId = crypto.randomUUID();
  const resultFileName = `${jobId}.pdf`;
  const inputKey = buildPdfArtifactKey({
    userId,
    sessionId,
    fileName: resultFileName,
  });
  const payload = {
    ...(filename?.trim() ? { filename } : {}),
    pages: pages ?? [],
    resultFileName,
  };

  await db.insert(pdfConversionJobs).values({
    id: jobId,
    sessionId,
    jobType: 'export',
    userId,
    originalName: filename ?? '',
    originalMimeType: 'application/pdf',
    inputKey,
    status: 'queued',
    payload,
  });

  const queuePosition = await getPdfQueuePosition(jobId);
  return {
    jobId,
    status: 'queued',
    queuePosition,
    statusUrl: `/api/pdf/jobs/${jobId}`,
  };
}

export async function getPdfConversionJobs(
  sessionId: string
): Promise<PdfConversionJob[]> {
  const rows = await db.query.pdfConversionJobs.findMany({
    where: and(
      eq(pdfConversionJobs.sessionId, sessionId),
      eq(pdfConversionJobs.jobType, 'docx_convert')
    ),
    orderBy: [asc(pdfConversionJobs.createdAt)],
  });
  return Promise.all(rows.map(mapJob));
}

export async function getPdfJob(
  jobId: string,
  userId: string
): Promise<PdfConversionJob | undefined> {
  const row = await db.query.pdfConversionJobs.findFirst({
    where: and(
      eq(pdfConversionJobs.id, jobId),
      eq(pdfConversionJobs.userId, userId)
    ),
  });
  return row ? mapJob(row) : undefined;
}

async function mapJob(row: PdfJobRow): Promise<PdfConversionJob> {
  const result = (row.result ?? {}) as { filename?: string };
  return {
    id: row.id,
    sessionId: row.sessionId,
    jobType: row.jobType,
    originalName: row.originalName,
    status: row.status,
    fileId: row.fileId,
    queuePosition:
      row.status === 'queued' ? await getPdfQueuePosition(row.id) : null,
    resultUrl:
      row.status === 'completed' && row.jobType === 'export'
        ? `/api/pdf/jobs/${row.id}/result`
        : null,
    resultFilename: result.filename ?? null,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: row.errorMessage ?? 'PDF processing failed.',
        }
      : null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export async function getPdfQueuePosition(jobId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(position, 0)::int AS position
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id)::int AS position
      FROM pdf_conversion_jobs
      WHERE status = 'queued'
    ) queued
    WHERE id = ${jobId}
  `);
  return Number(resultRows<{ position: number }>(result)[0]?.position ?? 0);
}

export async function claimNextPdfJob(): Promise<PdfJobRow | null> {
  if (activeJobs.size >= INSTANCE_LIMIT) return null;

  return db.transaction(async (tx) => {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + LEASE_MS);
    // Serialize only the short claim decision so independently scaled instances
    // cannot all observe the same global/per-user slot and oversubscribe it.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('apex_pdf_job_claim'))`
    );
    const result = await tx.execute(sql`
      WITH candidate AS (
        SELECT jobs.id
        FROM pdf_conversion_jobs jobs
        WHERE jobs.status = 'queued'
          AND (
            SELECT COUNT(*) FROM pdf_conversion_jobs global_jobs
            WHERE global_jobs.status = 'processing'
              AND global_jobs.lock_expires_at > now()
          ) < ${GLOBAL_LIMIT}
          AND (
            SELECT COUNT(*) FROM pdf_conversion_jobs user_jobs
            WHERE user_jobs.status = 'processing'
              AND user_jobs.user_id = jobs.user_id
              AND user_jobs.lock_expires_at > now()
          ) < ${USER_LIMIT}
        ORDER BY jobs.created_at, jobs.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE pdf_conversion_jobs jobs
      SET status = 'processing',
          owner_instance = ${INSTANCE_ID},
          heartbeat_at = ${now.toISOString()},
          lock_expires_at = ${lockExpiresAt.toISOString()},
          started_at = COALESCE(jobs.started_at, ${now.toISOString()}),
          attempts = jobs.attempts + 1,
          updated_at = ${now.toISOString()}
      FROM candidate
      WHERE jobs.id = candidate.id
        AND jobs.status = 'queued'
      RETURNING jobs.*
    `);
    const row = resultRows<Record<string, unknown>>(result)[0];
    return row ? mapClaimedJobRow(row) : null;
  });
}

export async function renewPdfJobLock(jobId: string): Promise<boolean> {
  const now = new Date();
  const [renewed] = await db
    .update(pdfConversionJobs)
    .set({
      heartbeatAt: now.toISOString(),
      lockExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(pdfConversionJobs.id, jobId),
        eq(pdfConversionJobs.status, 'processing'),
        eq(pdfConversionJobs.ownerInstance, INSTANCE_ID)
      )
    )
    .returning({ id: pdfConversionJobs.id });
  if (!renewed) {
    console.error('[pdf-queue] Lock renewal lost ownership', {
      jobId,
      instanceId: INSTANCE_ID,
    });
    trackEvent('PdfJobLockRenewalFailure', { jobId, instanceId: INSTANCE_ID });
  }
  return Boolean(renewed);
}

export async function recoverExpiredPdfJobs(): Promise<{
  requeued: number;
  poisoned: number;
}> {
  const now = new Date().toISOString();
  const poisonedResult = await db.execute(sql`
    UPDATE pdf_conversion_jobs
    SET status = 'failed',
        completed_at = ${now},
        updated_at = ${now},
        error_code = 'MAX_ATTEMPTS_EXCEEDED',
        error_message = 'PDF processing failed after the maximum retry attempts.',
        owner_instance = NULL,
        heartbeat_at = NULL,
        lock_expires_at = NULL
    WHERE (
        status = 'queued'
        OR (status = 'processing' AND lock_expires_at < now())
      )
      AND attempts >= max_attempts
    RETURNING id
  `);
  const requeuedResult = await db.execute(sql`
    UPDATE pdf_conversion_jobs
    SET status = 'queued',
        updated_at = ${now},
        owner_instance = NULL,
        heartbeat_at = NULL,
        lock_expires_at = NULL
    WHERE status = 'processing'
      AND lock_expires_at < now()
      AND attempts < max_attempts
    RETURNING id
  `);
  const poisoned = resultRows(poisonedResult).length;
  const requeued = resultRows(requeuedResult).length;
  if (poisoned > 0) {
    console.error('[pdf-queue] Poison jobs reached retry limit', { poisoned });
    trackEvent('PdfPoisonJobs', undefined, { count: poisoned });
  }
  return { requeued, poisoned };
}

async function finishJob(
  job: PdfJobRow,
  result: PdfJobExecutionResult,
  startedAt: number
): Promise<void> {
  const completedAt = new Date().toISOString();
  const [completed] = await db
    .update(pdfConversionJobs)
    .set({
      status: 'completed',
      fileId: result.fileId,
      result: result.result ?? {},
      completedAt,
      updatedAt: completedAt,
      ownerInstance: null,
      heartbeatAt: null,
      lockExpiresAt: null,
      errorCode: null,
      errorMessage: null,
    })
    .where(
      and(
        eq(pdfConversionJobs.id, job.id),
        eq(pdfConversionJobs.status, 'processing'),
        eq(pdfConversionJobs.ownerInstance, INSTANCE_ID)
      )
    )
    .returning({ id: pdfConversionJobs.id });
  if (!completed) {
    console.warn('[pdf-queue] Completion ignored after ownership changed', {
      jobId: job.id,
      instanceId: INSTANCE_ID,
    });
    return;
  }
  const latencyMs = Date.now() - startedAt;
  console.info('[pdf-queue] Job completed', {
    jobId: job.id,
    jobType: job.jobType,
    latencyMs,
    attempts: job.attempts,
  });
  trackEvent('PdfJobCompleted', { jobType: job.jobType }, { latencyMs });
}

async function failOrRetryJob(job: PdfJobRow, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  const terminal = job.attempts >= job.maxAttempts;
  const code =
    (error as { code?: string })?.code ??
    (job.jobType === 'export'
      ? PDF_ERROR_CODES.EXPORT_FAILED
      : PDF_ERROR_CODES.CONVERSION_FAILED);
  const message =
    error instanceof Error ? error.message : 'PDF processing failed.';
  const [updated] = await db
    .update(pdfConversionJobs)
    .set({
      status: terminal ? 'failed' : 'queued',
      completedAt: terminal ? now : null,
      updatedAt: now,
      ownerInstance: null,
      heartbeatAt: null,
      lockExpiresAt: null,
      errorCode: terminal ? code : null,
      errorMessage: terminal ? message : null,
    })
    .where(
      and(
        eq(pdfConversionJobs.id, job.id),
        eq(pdfConversionJobs.status, 'processing'),
        eq(pdfConversionJobs.ownerInstance, INSTANCE_ID)
      )
    )
    .returning({ id: pdfConversionJobs.id });
  if (!updated) {
    console.warn('[pdf-queue] Failure ignored after ownership changed', {
      jobId: job.id,
      instanceId: INSTANCE_ID,
    });
    return;
  }
  console.error('[pdf-queue] Job execution failed', {
    jobId: job.id,
    jobType: job.jobType,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    terminal,
    error: message,
  });
  if (terminal) {
    if (job.jobType === 'docx_convert') {
      try {
        await getPdfArtifactStore().deleteFile(artifactRefFromJob(job));
      } catch (cleanupError) {
        console.error('[pdf-queue] Failed to delete poison-job input', {
          jobId: job.id,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      }
    }
    trackEvent('PdfPoisonJobs', { jobType: job.jobType }, { count: 1 });
  }
}

async function runClaimedJob(
  job: PdfJobRow,
  handler: PdfJobHandler
): Promise<void> {
  activeJobs.add(job.id);
  const startedAt = Date.now();
  const heartbeatTimer = setInterval(() => {
    void renewPdfJobLock(job.id).catch((error) => {
      console.error('[pdf-queue] Lock renewal failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      trackEvent('PdfJobLockRenewalFailure', { jobId: job.id });
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    await finishJob(job, await handler(job), startedAt);
  } catch (error) {
    await failOrRetryJob(job, error);
  } finally {
    clearInterval(heartbeatTimer);
    activeJobs.delete(job.id);
  }
}

async function runProcessor(handler: PdfJobHandler): Promise<void> {
  await recoverExpiredPdfJobs();
  while (activeJobs.size < INSTANCE_LIMIT) {
    const job = await claimNextPdfJob();
    if (!job) break;
    void runClaimedJob(job, handler).catch((error) => {
      console.error('[pdf-queue] Claimed job runner failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function processPendingPdfJobs(handler: PdfJobHandler): Promise<void> {
  if (activeProcessor) return activeProcessor;
  activeProcessor = runProcessor(handler).finally(() => {
    activeProcessor = null;
  });
  return activeProcessor;
}

export function processPendingPdfConversions(
  handler: (
    sessionId: string,
    inputKey: string,
    originalName: string,
    originalMimeType: string
  ) => Promise<FileUploadResult>
): Promise<void> {
  return processPendingPdfJobs(async (job) => {
    const result = await handler(
      job.sessionId,
      job.inputKey,
      job.originalName,
      job.originalMimeType
    );
    if (result.status !== 'success') {
      throw Object.assign(
        new Error(result.error?.message ?? 'PDF conversion failed.'),
        {
          code: result.error?.code ?? PDF_ERROR_CODES.CONVERSION_FAILED,
        }
      );
    }
    return { fileId: result.fileId, result: { fileId: result.fileId } };
  });
}

export function startPdfJobPoller(handler: PdfJobHandler): void {
  if (pollTimer) return;
  pollHandler = handler;
  const poll = () => {
    if (!pollHandler) return;
    void processPendingPdfJobs(pollHandler).catch((error) => {
      console.error('[pdf-queue] Poller failed', error);
    });
  };
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  metricsTimer = setInterval(() => {
    void logPdfQueueMetrics().catch((error) => {
      console.error('[pdf-queue] Metrics snapshot failed', error);
    });
  }, 30_000);
  metricsTimer.unref?.();
  console.info('[pdf-queue] Poller started', {
    instanceId: INSTANCE_ID,
    globalLimit: GLOBAL_LIMIT,
    instanceLimit: INSTANCE_LIMIT,
    userLimit: USER_LIMIT,
    leaseMs: LEASE_MS,
  });
}

export function stopPdfJobPoller(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (metricsTimer) clearInterval(metricsTimer);
  pollTimer = undefined;
  metricsTimer = undefined;
  pollHandler = undefined;
}

export async function logPdfQueueMetrics(): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queue_depth,
      COUNT(*) FILTER (WHERE status = 'processing' AND lock_expires_at > now())::int AS global_active,
      COUNT(DISTINCT owner_instance) FILTER (
        WHERE status = 'processing' AND lock_expires_at > now()
      )::int AS active_instances,
      COALESCE(MAX(user_active), 0)::int AS max_user_active
    FROM pdf_conversion_jobs
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS user_active
      FROM pdf_conversion_jobs per_user
      WHERE per_user.user_id = pdf_conversion_jobs.user_id
        AND per_user.status = 'processing'
        AND per_user.lock_expires_at > now()
    ) user_counts ON true
    WHERE status IN ('queued', 'processing')
  `);
  const metrics = resultRows<{
    queue_depth: number;
    global_active: number;
    active_instances: number;
    max_user_active: number;
  }>(result)[0] ?? {
    queue_depth: 0,
    global_active: 0,
    active_instances: 0,
    max_user_active: 0,
  };
  const measurements = {
    queueDepth: Number(metrics.queue_depth),
    globalActive: Number(metrics.global_active),
    instanceActive: activeJobs.size,
    activeInstances: Number(metrics.active_instances),
    maxUserActive: Number(metrics.max_user_active),
  };
  console.info('[pdf-queue] Metrics', measurements);
  trackEvent('PdfQueueMetrics', { instanceId: INSTANCE_ID }, measurements);
}

export function getPdfQueueRuntimeConfig() {
  return {
    instanceId: INSTANCE_ID,
    globalLimit: GLOBAL_LIMIT,
    instanceLimit: INSTANCE_LIMIT,
    userLimit: USER_LIMIT,
    activeInstanceJobs: activeJobs.size,
    leaseMs: LEASE_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

export function artifactRefFromJob(job: PdfJobRow): PdfArtifactRef {
  return {
    userId: job.userId,
    sessionId: job.sessionId,
    fileName: fileNameFromKey(job.inputKey),
  };
}

export type { PdfJobRow, PdfJobType };
