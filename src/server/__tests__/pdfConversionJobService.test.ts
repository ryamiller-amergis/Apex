const mockStat = jest.fn();
const mockRm = jest.fn();
const mockExecute = jest.fn();
const mockTxExecute = jest.fn();
const mockInsertValues = jest.fn();
const mockReturning = jest.fn();
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockArtifactPut = jest.fn();
const mockArtifactDelete = jest.fn();

jest.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../services/pdfArtifactStore', () => ({
  getPdfArtifactStore: () => ({
    putFile: (...args: unknown[]) => mockArtifactPut(...args),
    deleteFile: (...args: unknown[]) => mockArtifactDelete(...args),
  }),
  buildPdfArtifactKey: ({ userId, sessionId, fileName }: any) =>
    `${userId}/${sessionId}/${fileName}`,
}));

jest.mock('../db/drizzle', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    transaction: jest.fn(
      (
        callback: (tx: { execute: (...args: unknown[]) => unknown }) => unknown
      ) =>
        callback({
          execute: (...args: unknown[]) => mockTxExecute(...args),
        })
    ),
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({ set: mockSet })),
    query: {
      pdfConversionJobs: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

import {
  PdfQueueSaturatedError,
  assertPdfQueueCapacity,
  claimNextPdfJob,
  enqueuePdfConversion,
  enqueuePdfExport,
  getPdfQueueRuntimeConfig,
  recoverExpiredPdfJobs,
  renewPdfJobLock,
} from '../services/pdfConversionJobService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

const jobRow = {
  id: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000002',
  jobType: 'docx_convert' as const,
  userId: 'user-1',
  originalName: 'large-report.docx',
  originalMimeType:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  inputKey: 'user-1/20000000-0000-4000-8000-000000000002/job.docx',
  status: 'processing' as const,
  attempts: 1,
  maxAttempts: 3,
  payload: {},
  result: null,
  fileId: null,
  errorCode: null,
  errorMessage: null,
  ownerInstance: 'test-instance:1',
  heartbeatAt: '2026-07-11T05:00:00.000Z',
  lockExpiresAt: '2026-07-11T05:20:00.000Z',
  startedAt: '2026-07-11T05:00:00.000Z',
  completedAt: null,
  createdAt: '2026-07-11T04:59:00.000Z',
  updatedAt: '2026-07-11T05:00:00.000Z',
};

const rawClaimedJobRow = {
  id: jobRow.id,
  session_id: jobRow.sessionId,
  job_type: jobRow.jobType,
  user_id: jobRow.userId,
  original_name: jobRow.originalName,
  original_mime_type: jobRow.originalMimeType,
  input_key: jobRow.inputKey,
  status: jobRow.status,
  attempts: jobRow.attempts,
  max_attempts: jobRow.maxAttempts,
  payload: jobRow.payload,
  result: jobRow.result,
  file_id: jobRow.fileId,
  error_code: jobRow.errorCode,
  error_message: jobRow.errorMessage,
  owner_instance: jobRow.ownerInstance,
  heartbeat_at: jobRow.heartbeatAt,
  lock_expires_at: jobRow.lockExpiresAt,
  started_at: jobRow.startedAt,
  completed_at: jobRow.completedAt,
  created_at: jobRow.createdAt,
  updated_at: jobRow.updatedAt,
};

describe('pdfConversionJobService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStat.mockResolvedValue({ size: 1024 });
    mockRm.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue({
      rows: [{ queue_depth: 0, user_depth: 0 }],
    });
    mockInsertValues.mockResolvedValue(undefined);
    mockArtifactPut.mockResolvedValue(undefined);
    mockArtifactDelete.mockResolvedValue(undefined);
    mockReturning.mockResolvedValue([{ id: jobRow.id }]);
  });

  test('stores DOCX input under a user-scoped artifact key before enqueueing', async () => {
    const result = await enqueuePdfConversion(
      jobRow.sessionId,
      jobRow.userId,
      '/uploads/report.docx',
      'report.docx',
      jobRow.originalMimeType,
      100 * 1024 * 1024
    );

    expect(result.status).toBe('queued');
    expect(mockArtifactPut).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: jobRow.userId,
        sessionId: jobRow.sessionId,
      }),
      '/uploads/report.docx'
    );
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'docx_convert',
        userId: jobRow.userId,
        inputKey: expect.stringMatching(/^user-1\/.*\/.*\.docx$/),
        status: 'queued',
      })
    );
  });

  test('rejects an oversized Word file before creating a job', async () => {
    mockStat.mockResolvedValue({ size: 100 * 1024 * 1024 + 1 });

    const result = await enqueuePdfConversion(
      jobRow.sessionId,
      jobRow.userId,
      '/uploads/huge.docx',
      'huge.docx',
      jobRow.originalMimeType,
      100 * 1024 * 1024
    );

    expect(result.error?.code).toBe(PDF_ERROR_CODES.FILE_TOO_LARGE);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith('/uploads/huge.docx', { force: true });
  });

  test('applies enqueue back-pressure at the per-user backlog limit', async () => {
    mockExecute.mockResolvedValue({
      rows: [{ queue_depth: 12, user_depth: 12 }],
    });

    await expect(assertPdfQueueCapacity(jobRow.userId)).rejects.toBeInstanceOf(
      PdfQueueSaturatedError
    );
  });

  test('preserves absent export override through the queue payload', async () => {
    const result = await enqueuePdfExport(
      jobRow.sessionId,
      jobRow.userId,
      undefined,
      [0, 2]
    );

    expect(result.status).toBe('queued');
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'export',
        originalName: '',
        payload: expect.objectContaining({
          pages: [0, 2],
          resultFileName: expect.stringMatching(/\.pdf$/),
        }),
      })
    );
    expect(mockInsertValues.mock.calls[0][0].payload).not.toHaveProperty(
      'filename'
    );
  });

  test('preserves an explicit export override through the queue payload', async () => {
    await enqueuePdfExport(jobRow.sessionId, jobRow.userId, 'custom.pdf', [1]);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'export',
        originalName: 'custom.pdf',
        payload: expect.objectContaining({
          filename: 'custom.pdf',
          pages: [1],
          resultFileName: expect.stringMatching(/\.pdf$/),
        }),
      })
    );
  });

  test('claims atomically through a transaction and records a lease', async () => {
    mockTxExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [rawClaimedJobRow] });

    const claimed = await claimNextPdfJob();

    expect(claimed).toEqual(jobRow);
    expect(mockTxExecute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockTxExecute.mock.calls[1][0])).toContain(
      'FOR UPDATE SKIP LOCKED'
    );
  });

  test('renews a processing job lock owned by this instance', async () => {
    await expect(renewPdfJobLock(jobRow.id)).resolves.toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        heartbeatAt: expect.any(String),
        lockExpiresAt: expect.any(String),
      })
    );
  });

  test('reaper separates retryable expired jobs from poison jobs', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ id: 'poison-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'retry-1' }, { id: 'retry-2' }] });

    await expect(recoverExpiredPdfJobs()).resolves.toEqual({
      requeued: 2,
      poisoned: 1,
    });
    expect(JSON.stringify(mockExecute.mock.calls[0][0])).toContain(
      "status = 'queued'"
    );
    expect(JSON.stringify(mockExecute.mock.calls[0][0])).toContain(
      'attempts >= max_attempts'
    );
  });

  test('exposes the configured three-tier governor', () => {
    expect(getPdfQueueRuntimeConfig()).toEqual(
      expect.objectContaining({
        globalLimit: 40,
        instanceLimit: 7,
        userLimit: 3,
        leaseMs: 20 * 60_000,
      })
    );
  });
});
