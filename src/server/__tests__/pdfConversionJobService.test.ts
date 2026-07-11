const mockStat = jest.fn();
const mockMkdir = jest.fn();
const mockRename = jest.fn();
const mockCopyFile = jest.fn();
const mockUnlink = jest.fn();
const mockInsertValues = jest.fn();
const mockFindMany = jest.fn();
const mockFindFirst = jest.fn();
const mockReturning = jest.fn();
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));

jest.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: mockUpdate,
    query: {
      pdfConversionJobs: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
}));

import {
  enqueuePdfConversion,
  getPdfConversionJobs,
  processPendingPdfConversions,
} from '../services/pdfConversionJobService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

const jobRow = {
  id: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000002',
  originalName: 'large-report.docx',
  originalMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  inputPath: '/sessions/job.docx',
  status: 'processing' as const,
  fileId: null,
  errorCode: null,
  errorMessage: null,
  ownerInstance: 'test-instance:1',
  heartbeatAt: '2026-07-11T05:00:00.000Z',
  startedAt: '2026-07-11T05:00:00.000Z',
  completedAt: null,
  createdAt: '2026-07-11T04:59:00.000Z',
  updatedAt: '2026-07-11T05:00:00.000Z',
};

describe('pdfConversionJobService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStat.mockResolvedValue({ size: 1024 });
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockInsertValues.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockReturning.mockResolvedValue([]);
  });

  test('persists a queued job and returns before conversion starts', async () => {
    const result = await enqueuePdfConversion(
      jobRow.sessionId,
      '/uploads/report.docx',
      'report.docx',
      jobRow.originalMimeType,
      '/sessions',
      100 * 1024 * 1024,
    );

    expect(result.status).toBe('queued');
    expect(result.conversionId).toBeDefined();
    expect(mockRename).toHaveBeenCalledWith(
      '/uploads/report.docx',
      expect.stringMatching(/\.docx$/),
    );
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: jobRow.sessionId,
      originalName: 'report.docx',
      status: 'queued',
    }));
  });

  test('rejects an oversized Word file before creating a job', async () => {
    mockStat.mockResolvedValue({ size: 100 * 1024 * 1024 + 1 });

    const result = await enqueuePdfConversion(
      jobRow.sessionId,
      '/uploads/huge.docx',
      'huge.docx',
      jobRow.originalMimeType,
      '/sessions',
      100 * 1024 * 1024,
    );

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe(PDF_ERROR_CODES.FILE_TOO_LARGE);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith('/uploads/huge.docx');
  });

  test('processes a claimed job and records the converted file', async () => {
    mockFindFirst
      .mockResolvedValueOnce({ ...jobRow, status: 'queued' })
      .mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([jobRow]);
    const handler = jest.fn().mockResolvedValue({
      fileId: '30000000-0000-4000-8000-000000000003',
      originalName: jobRow.originalName,
      status: 'success',
      pageCount: 500,
      sizeBytes: 20_000,
      convertedFrom: jobRow.originalName,
    });

    await processPendingPdfConversions(handler);

    expect(handler).toHaveBeenCalledWith(
      jobRow.sessionId,
      jobRow.inputPath,
      jobRow.originalName,
      jobRow.originalMimeType,
    );
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      fileId: '30000000-0000-4000-8000-000000000003',
    }));
    expect(mockUnlink).toHaveBeenCalledWith(jobRow.inputPath);
  });

  test('records background conversion failures without rejecting the processor', async () => {
    mockFindFirst
      .mockResolvedValueOnce({ ...jobRow, status: 'queued' })
      .mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([jobRow]);
    const conversionError = Object.assign(new Error('Converter exhausted its time limit.'), {
      code: PDF_ERROR_CODES.CONVERSION_TIMEOUT,
    });

    await expect(
      processPendingPdfConversions(jest.fn().mockRejectedValue(conversionError)),
    ).resolves.toBeUndefined();

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorCode: PDF_ERROR_CODES.CONVERSION_TIMEOUT,
      errorMessage: 'Converter exhausted its time limit.',
    }));
  });

  test('exposes failed jobs with actionable errors for polling clients', async () => {
    mockFindMany.mockResolvedValue([{
      ...jobRow,
      status: 'failed',
      errorCode: PDF_ERROR_CODES.CONVERSION_FAILED,
      errorMessage: 'Could not convert this document.',
      completedAt: '2026-07-11T05:02:00.000Z',
    }]);

    const jobs = await getPdfConversionJobs(jobRow.sessionId);

    expect(jobs).toEqual([
      expect.objectContaining({
        id: jobRow.id,
        status: 'failed',
        error: {
          code: PDF_ERROR_CODES.CONVERSION_FAILED,
          message: 'Could not convert this document.',
        },
      }),
    ]);
  });
});
