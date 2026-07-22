import express from 'express';
import os from 'os';
import request from 'supertest';

const mockQueuePdfExport = jest.fn();

jest.mock('../middleware/auth', () => ({
  ensureAuthenticated: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { profile: { oid: 'user-1' } } as any;
    next();
  },
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission:
    () =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction
    ) =>
      next(),
}));

jest.mock('../services/pdfConversionJobService', () => {
  class PdfQueueSaturatedError extends Error {
    status = 429;
    code = 'PDF_QUEUE_SATURATED';
    constructor(
      message: string,
      public retryAfterSeconds = 5
    ) {
      super(message);
    }
  }
  return {
    PdfQueueSaturatedError,
    getPdfJob: jest.fn(),
  };
});

jest.mock('../services/pdfArtifactStore', () => ({
  getPdfArtifactStore: jest.fn(),
}));

jest.mock('../services/pdfAssemblyService', () => ({
  getPdfTempDir: () => os.tmpdir(),
  createSession: jest.fn(),
  getSession: jest.fn(),
  getActiveSessions: jest.fn(),
  validateAndIngest: jest.fn(),
  getPdfFileStream: jest.fn(),
  updateManifest: jest.fn(),
  removeFile: jest.fn(),
  queuePdfExport: (...args: unknown[]) => mockQueuePdfExport(...args),
  closeSession: jest.fn(),
}));

import pdfRouter from '../routes/pdf';
import { PdfQueueSaturatedError } from '../services/pdfConversionJobService';

const app = express();
app.use(express.json());
app.use('/api/pdf', pdfRouter);

describe('PDF export queue routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 202 with queue status for accepted exports', async () => {
    mockQueuePdfExport.mockResolvedValue({
      jobId: 'job-1',
      status: 'queued',
      queuePosition: 2,
      statusUrl: '/api/pdf/jobs/job-1',
    });

    const response = await request(app)
      .post('/api/pdf/sessions/session-1/export')
      .send({ filename: 'report.pdf' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'queued',
        queuePosition: 2,
      })
    );
  });

  test('passes an absent filename override through to queuePdfExport', async () => {
    mockQueuePdfExport.mockResolvedValue({
      jobId: 'job-2',
      status: 'queued',
      queuePosition: 1,
      statusUrl: '/api/pdf/jobs/job-2',
    });

    const response = await request(app)
      .post('/api/pdf/sessions/session-1/export')
      .send({ pages: [0] });

    expect(response.status).toBe(202);
    expect(mockQueuePdfExport).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      undefined,
      [0]
    );
  });

  test('returns 429 and Retry-After when queue back-pressure triggers', async () => {
    mockQueuePdfExport.mockRejectedValue(
      new PdfQueueSaturatedError('PDF processing is busy.', 7)
    );

    const response = await request(app)
      .post('/api/pdf/sessions/session-1/export')
      .send({ filename: 'report.pdf' });

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.body.error).toEqual({
      code: 'PDF_QUEUE_SATURATED',
      message: 'PDF processing is busy.',
    });
  });
});
