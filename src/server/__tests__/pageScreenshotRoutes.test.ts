/**
 * Integration-style tests for the /api/page-screenshots routes.
 *
 * - pageScreenshotService is fully mocked.
 * - RBAC middleware is mocked to pass-through.
 * - requestUser.getUserId is mocked to return a fixed user ID.
 */
import request from 'supertest';
import express from 'express';
import pageScreenshotRouter from '../routes/pageScreenshots';
import * as pageScreenshotService from '../services/pageScreenshotService';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/pageScreenshotService');

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

const mockService = pageScreenshotService as jest.Mocked<typeof pageScreenshotService>;

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/page-screenshots', pageScreenshotRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const screenshotSummary = {
  id: 'sc-1',
  route: '/timecard/entry',
  displayUrl: 'https://dev.mymaxview.com/Timecard/Entry',
  mediaType: 'image/png',
  uploadedBy: 'user-test',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const screenshot = {
  ...screenshotSummary,
  imageBase64: 'base64imagedata==',
  width: 1920,
  height: 1080,
};

// ── GET /api/page-screenshots ─────────────────────────────────────────────────

describe('GET /api/page-screenshots', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the list of screenshots', async () => {
    mockService.listScreenshots.mockResolvedValue([screenshotSummary]);

    const res = await request(buildApp()).get('/api/page-screenshots');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'sc-1', route: '/timecard/entry' });
  });

  it('returns 200 with an empty array when no screenshots exist', async () => {
    mockService.listScreenshots.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/page-screenshots');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 when the service throws', async () => {
    mockService.listScreenshots.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/page-screenshots');

    expect(res.status).toBe(500);
  });
});

// ── GET /api/page-screenshots/by-route ───────────────────────────────────────

describe('GET /api/page-screenshots/by-route', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with the screenshot when found', async () => {
    mockService.getScreenshotByRoute.mockResolvedValue(screenshot);

    const res = await request(buildApp())
      .get('/api/page-screenshots/by-route')
      .query({ route: '/timecard/entry' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'sc-1', imageBase64: 'base64imagedata==' });
    expect(mockService.getScreenshotByRoute).toHaveBeenCalledWith('/timecard/entry');
  });

  it('returns 404 when no screenshot matches the route', async () => {
    mockService.getScreenshotByRoute.mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/page-screenshots/by-route')
      .query({ route: '/unknown/path' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'No screenshot found for this route' });
  });

  it('returns 400 when the route query parameter is missing', async () => {
    const res = await request(buildApp()).get('/api/page-screenshots/by-route');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'route query parameter is required' });
    expect(mockService.getScreenshotByRoute).not.toHaveBeenCalled();
  });

  it('passes the raw route value directly to the service', async () => {
    mockService.getScreenshotByRoute.mockResolvedValue(screenshot);

    await request(buildApp())
      .get('/api/page-screenshots/by-route')
      .query({ route: 'https://dev.mymaxview.com/Timecard/Entry' });

    // The route forwards the caller-supplied value; normalisation is done inside the service
    expect(mockService.getScreenshotByRoute).toHaveBeenCalledWith(
      'https://dev.mymaxview.com/Timecard/Entry',
    );
  });

  it('returns 500 when the service throws', async () => {
    mockService.getScreenshotByRoute.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .get('/api/page-screenshots/by-route')
      .query({ route: '/timecard/entry' });

    expect(res.status).toBe(500);
  });
});

// ── POST /api/page-screenshots ────────────────────────────────────────────────

describe('POST /api/page-screenshots', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with the upserted screenshot', async () => {
    mockService.upsertScreenshot.mockResolvedValue(screenshot);

    const res = await request(buildApp())
      .post('/api/page-screenshots')
      .send({
        url: 'https://dev.mymaxview.com/Timecard/Entry',
        imageBase64: 'base64imagedata==',
        mediaType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'sc-1', imageBase64: 'base64imagedata==' });
    expect(mockService.upsertScreenshot).toHaveBeenCalledWith(
      'https://dev.mymaxview.com/Timecard/Entry',
      'base64imagedata==',
      'image/png',
      'user-test',
    );
  });

  it('defaults mediaType to image/png when not provided', async () => {
    mockService.upsertScreenshot.mockResolvedValue(screenshot);

    await request(buildApp())
      .post('/api/page-screenshots')
      .send({
        url: 'https://dev.mymaxview.com/Timecard/Entry',
        imageBase64: 'base64imagedata==',
      });

    expect(mockService.upsertScreenshot).toHaveBeenCalledWith(
      expect.any(String),
      'base64imagedata==',
      'image/png',
      expect.any(String),
    );
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(buildApp())
      .post('/api/page-screenshots')
      .send({ imageBase64: 'base64imagedata==' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'url and imageBase64 are required' });
    expect(mockService.upsertScreenshot).not.toHaveBeenCalled();
  });

  it('returns 400 when imageBase64 is missing', async () => {
    const res = await request(buildApp())
      .post('/api/page-screenshots')
      .send({ url: 'https://dev.mymaxview.com/Timecard/Entry' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'url and imageBase64 are required' });
    expect(mockService.upsertScreenshot).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    mockService.upsertScreenshot.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp())
      .post('/api/page-screenshots')
      .send({
        url: 'https://dev.mymaxview.com/Timecard/Entry',
        imageBase64: 'base64imagedata==',
      });

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/page-screenshots/:id ─────────────────────────────────────────

describe('DELETE /api/page-screenshots/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on successful delete', async () => {
    mockService.deleteScreenshot.mockResolvedValue(undefined);

    const res = await request(buildApp()).delete('/api/page-screenshots/sc-1');

    expect(res.status).toBe(204);
    expect(mockService.deleteScreenshot).toHaveBeenCalledWith('sc-1');
  });

  it('returns 500 when the service throws', async () => {
    mockService.deleteScreenshot.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).delete('/api/page-screenshots/sc-1');

    expect(res.status).toBe(500);
  });
});
