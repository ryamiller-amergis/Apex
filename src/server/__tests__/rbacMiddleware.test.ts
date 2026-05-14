import type { Request, Response, NextFunction } from 'express';
import { requirePermission, requireAnyPermission, attachPermissions } from '../middleware/rbac';
import * as rbacService from '../services/rbacService';

jest.mock('../services/rbacService');

const mockGetUserPermissions = rbacService.getUserPermissions as jest.MockedFunction<
  typeof rbacService.getUserPermissions
>;

function makeReq(user: unknown, cachedPerms?: Set<string>): Request {
  const req: any = { user };
  if (cachedPerms !== undefined) req._permissions = cachedPerms;
  return req as Request;
}

function makeRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

// ── requirePermission ──────────────────────────────────────────────────────────

describe('requirePermission', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when req.user is missing', async () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requirePermission('admin:roles')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user has the required permission', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    await requirePermission('admin:roles')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when user has all of multiple required permissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles', 'admin:users']));

    await requirePermission('admin:roles', 'admin:users')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 with missing keys when user lacks a permission', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    await requirePermission('admin:roles', 'admin:users')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden', missing: ['admin:users'] });
  });

  it('returns 403 with all missing keys when user has none of them', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requirePermission('admin:roles', 'admin:users')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ missing: expect.arrayContaining(['admin:roles', 'admin:users']) }),
    );
  });

  it('uses cached req._permissions and skips getUserPermissions', async () => {
    const cached = new Set(['admin:roles', 'admin:users']);
    const req = makeReq({ profile: { oid: 'user-1' } }, cached);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requirePermission('admin:roles')(req, res, next);

    expect(mockGetUserPermissions).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('populates req._permissions so subsequent middleware can use the cache', async () => {
    const perms = new Set(['chat:create', 'wiki:write']);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(perms);

    await requirePermission('chat:create')(req, res, next);

    expect((req as any)._permissions).toBe(perms);
  });

  it('calls getUserPermissions with the profile oid', async () => {
    const req = makeReq({ profile: { oid: 'oid-abc' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    await requirePermission('admin:roles')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('oid-abc');
  });
});

// ── requireAnyPermission ───────────────────────────────────────────────────────

describe('requireAnyPermission', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when req.user is missing', async () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireAnyPermission('admin:roles')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user has at least one matching permission', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requireAnyPermission('admin:roles', 'chat:create')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when user has the first of multiple permissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    await requireAnyPermission('admin:roles', 'chat:create')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when user has none of the required permissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['cost:view']));

    await requireAnyPermission('admin:roles', 'admin:users')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('returns 403 for a user with no permissions at all', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set());

    await requireAnyPermission('admin:roles')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── attachPermissions ──────────────────────────────────────────────────────────

describe('attachPermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('always calls next() on success', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await attachPermissions(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() even when getUserPermissions rejects', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockRejectedValue(new Error('DB connection error'));

    await attachPermissions(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when user has no permissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set());

    await attachPermissions(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('populates req._permissions with loaded permissions', async () => {
    const perms = new Set(['chat:create', 'wiki:write']);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(perms);

    await attachPermissions(req, res, next);

    expect((req as any)._permissions).toBe(perms);
  });

  it('does not overwrite an already-cached _permissions set', async () => {
    const existing = new Set(['admin:roles']);
    const req = makeReq({ profile: { oid: 'user-1' } }, existing);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await attachPermissions(req, res, next);

    // getUserPermissions should not be called when cache is already warm
    expect(mockGetUserPermissions).not.toHaveBeenCalled();
    expect((req as any)._permissions).toBe(existing);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
