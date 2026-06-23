/**
 * Integration-style tests for the /api/notifications routes.
 *
 * - All notificationService calls are mocked.
 * - requestUser.getUserId is mocked to return a fixed user ID.
 * - The notifications router has no RBAC middleware (auth is implicit via getUserId).
 */
import request from 'supertest';
import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../services/notificationService', () => ({
  getNotifications: jest.fn().mockResolvedValue([]),
  markAsRead: jest.fn().mockResolvedValue(undefined),
  markAllAsRead: jest.fn().mockResolvedValue(undefined),
  getUnreadCount: jest.fn().mockResolvedValue(0),
  getPreferences: jest.fn().mockResolvedValue([]),
  upsertPreference: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

import notificationsRouter from '../routes/notifications';
import * as notificationService from '../services/notificationService';

const mockSvc = notificationService as jest.Mocked<typeof notificationService>;

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-test' } };
    next();
  });
  app.use('/api/notifications', notificationsRouter);
  return app;
}

// ── GET /api/notifications ─────────────────────────────────────────────────────

describe('GET /api/notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with notification array', async () => {
    const notifications = [
      { id: 'n1', userId: 'user-test', type: 'user-action', title: 'Hello', body: null, link: null, read: false, createdAt: '2026-01-01T00:00:00Z' },
    ];
    mockSvc.getNotifications.mockResolvedValue(notifications as any);

    const res = await request(buildApp()).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'n1', title: 'Hello' });
    expect(mockSvc.getNotifications).toHaveBeenCalledWith('user-test', { limit: 20, offset: 0 });
  });

  it('passes limit and offset query params to the service', async () => {
    mockSvc.getNotifications.mockResolvedValue([]);

    await request(buildApp()).get('/api/notifications?limit=5&offset=10');

    expect(mockSvc.getNotifications).toHaveBeenCalledWith('user-test', { limit: 5, offset: 10 });
  });

  it('clamps limit to 100', async () => {
    mockSvc.getNotifications.mockResolvedValue([]);

    await request(buildApp()).get('/api/notifications?limit=999');

    expect(mockSvc.getNotifications).toHaveBeenCalledWith('user-test', { limit: 100, offset: 0 });
  });

  it('defaults to limit=20, offset=0 when params are absent', async () => {
    mockSvc.getNotifications.mockResolvedValue([]);

    await request(buildApp()).get('/api/notifications');

    expect(mockSvc.getNotifications).toHaveBeenCalledWith('user-test', { limit: 20, offset: 0 });
  });
});

// ── GET /api/notifications/unread-count ───────────────────────────────────────

describe('GET /api/notifications/unread-count', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with count object', async () => {
    mockSvc.getUnreadCount.mockResolvedValue(3);

    const res = await request(buildApp()).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    expect(mockSvc.getUnreadCount).toHaveBeenCalledWith('user-test');
  });

  it('returns 200 with count=0 when no unread notifications', async () => {
    mockSvc.getUnreadCount.mockResolvedValue(0);

    const res = await request(buildApp()).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });
});

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────

describe('PATCH /api/notifications/:id/read', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on success', async () => {
    mockSvc.markAsRead.mockResolvedValue(undefined);

    const res = await request(buildApp()).patch('/api/notifications/notif-1/read');

    expect(res.status).toBe(204);
    expect(mockSvc.markAsRead).toHaveBeenCalledWith('user-test', 'notif-1');
  });
});

// ── PATCH /api/notifications/read-all ─────────────────────────────────────────

describe('PATCH /api/notifications/read-all', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 on success', async () => {
    mockSvc.markAllAsRead.mockResolvedValue(undefined);

    const res = await request(buildApp()).patch('/api/notifications/read-all');

    expect(res.status).toBe(204);
    expect(mockSvc.markAllAsRead).toHaveBeenCalledWith('user-test');
  });
});

// ── GET /api/notifications/preferences ────────────────────────────────────────

describe('GET /api/notifications/preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with preferences array', async () => {
    const prefs = [
      { id: 'pref-1', userId: 'user-test', notificationType: 'user-action', enabled: true, toastEnabled: true, updatedAt: '2026-01-01T00:00:00Z' },
    ];
    mockSvc.getPreferences.mockResolvedValue(prefs as any);

    const res = await request(buildApp()).get('/api/notifications/preferences');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ notificationType: 'user-action', enabled: true });
    expect(mockSvc.getPreferences).toHaveBeenCalledWith('user-test');
  });

  it('returns empty array when no preferences set', async () => {
    mockSvc.getPreferences.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/notifications/preferences');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── PATCH /api/notifications/preferences ──────────────────────────────────────

describe('PATCH /api/notifications/preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 204 and calls upsertPreference with the full payload', async () => {
    mockSvc.upsertPreference.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .send({ notificationType: 'user-action', enabled: false, toastEnabled: true });

    expect(res.status).toBe(204);
    expect(mockSvc.upsertPreference).toHaveBeenCalledWith(
      'user-test',
      'user-action',
      { enabled: false, toastEnabled: true },
    );
  });

  it('returns 204 when only enabled is provided', async () => {
    mockSvc.upsertPreference.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .send({ notificationType: 'system', enabled: true });

    expect(res.status).toBe(204);
    expect(mockSvc.upsertPreference).toHaveBeenCalledWith(
      'user-test',
      'system',
      { enabled: true, toastEnabled: undefined },
    );
  });

  it('returns 400 when notificationType is missing', async () => {
    const res = await request(buildApp())
      .patch('/api/notifications/preferences')
      .send({ enabled: false });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'notificationType is required' });
    expect(mockSvc.upsertPreference).not.toHaveBeenCalled();
  });
});
