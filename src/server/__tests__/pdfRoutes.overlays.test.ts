import express from 'express';
import os from 'os';
import request from 'supertest';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

const mockGetSession = jest.fn();
const mockUpdateOverlays = jest.fn();
const mockUpdateManifest = jest.fn();

jest.mock('../middleware/auth', () => ({
  ensureAuthenticated: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = {
      profile: { oid: 'user-1' },
    } as unknown as express.Request['user'];
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
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getActiveSessions: jest.fn(),
  validateAndIngest: jest.fn(),
  getPdfFileStream: jest.fn(),
  updateManifest: (...args: unknown[]) => mockUpdateManifest(...args),
  updateOverlays: (...args: unknown[]) => mockUpdateOverlays(...args),
  removeFile: jest.fn(),
  queuePdfExport: jest.fn(),
  closeSession: jest.fn(),
}));

import pdfRouter from '../routes/pdf';

const app = express();
app.use(express.json());
app.use('/api/pdf', pdfRouter);

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    userId: 'user-1',
    status: 'active',
    pageManifest: [],
    textOverlays: [],
    fileMetadata: [],
    conversionJobs: [],
    ...overrides,
  };
}

describe('PUT /api/pdf/sessions/:sessionId/overlays', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue(session());
  });

  it('returns 410 and does not write when the session is expired', async () => {
    mockGetSession.mockResolvedValue(session({ status: 'expired' }));

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/overlays')
      .send({ overlays: [] });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: 'Session has expired' });
    expect(mockUpdateOverlays).not.toHaveBeenCalled();
  });

  it('VT-05: returns the persisted authoritative overlays', async () => {
    const overlays: unknown[] = [];
    mockUpdateOverlays.mockResolvedValue({
      overlays,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/overlays')
      .send({ overlays });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      overlays,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    expect(mockUpdateOverlays).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      overlays
    );
  });

  it('VT-04: returns 403 without calling the update for another user', async () => {
    mockGetSession.mockResolvedValue(session({ userId: 'other-user' }));

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/overlays')
      .send({ overlays: [] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
    expect(mockUpdateOverlays).not.toHaveBeenCalled();
  });

  it('VT-06: maps validation failures to field-scoped 400 responses', async () => {
    const validationError = Object.assign(
      new Error('One or more overlays are invalid.'),
      {
        code: PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED,
        errors: [
          {
            overlayId: 'overlay-1',
            field: 'linkUrl',
            code: 'OVERLAY_LINK_INVALID',
            message: 'linkUrl must be a valid http or https URL.',
          },
        ],
      }
    );
    mockUpdateOverlays.mockRejectedValue(validationError);

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/overlays')
      .send({ overlays: [{ linkUrl: 'javascript:alert(1)' }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: PDF_ERROR_CODES.OVERLAY_VALIDATION_FAILED,
      message: 'One or more overlays are invalid.',
      errors: [
        expect.objectContaining({
          overlayId: 'overlay-1',
          field: 'linkUrl',
        }),
      ],
    });
  });

  it('returns 500 when persistence fails', async () => {
    mockUpdateOverlays.mockRejectedValue(new Error('database unavailable'));

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/overlays')
      .send({ overlays: [] });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});

describe('PUT /api/pdf/sessions/:sessionId/manifest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue(session());
  });

  it('VT-10: returns the post-cleanup overlays from the manifest update', async () => {
    const textOverlays = [{ id: 'overlay-remaining', pageId: 'page-1' }];
    mockUpdateManifest.mockResolvedValue({
      pageCount: 1,
      updatedAt: '2026-07-21T12:00:00.000Z',
      textOverlays,
    });

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/manifest')
      .send({ manifest: [] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      pageCount: 1,
      updatedAt: '2026-07-21T12:00:00.000Z',
      textOverlays,
    });
  });

  it('VT-11: rejects cross-user manifest changes before persistence', async () => {
    mockGetSession.mockResolvedValue(session({ userId: 'other-user' }));

    const response = await request(app)
      .put('/api/pdf/sessions/session-1/manifest')
      .send({ manifest: [] });

    expect(response.status).toBe(403);
    expect(mockUpdateManifest).not.toHaveBeenCalled();
  });
});
