import type { Request, Response, NextFunction } from 'express';
import {
  requirePermission,
  requireAnyPermission,
  attachPermissions,
  requireGroupMembership,
  resolveRequestProject,
} from '../middleware/rbac';
import * as rbacService from '../services/rbacService';
import * as groupService from '../services/groupService';
import * as superAdminUtils from '../utils/superAdmin';

jest.mock('../services/rbacService');
jest.mock('../services/groupService');
jest.mock('../utils/superAdmin');

const mockGetUserPermissions = rbacService.getUserPermissions as jest.MockedFunction<
  typeof rbacService.getUserPermissions
>;
const mockGetUserGroupNames = groupService.getUserGroupNames as jest.MockedFunction<
  typeof groupService.getUserGroupNames
>;
const mockIsSuperAdminRequest = superAdminUtils.isSuperAdminRequest as jest.MockedFunction<
  typeof superAdminUtils.isSuperAdminRequest
>;

interface MakeReqOpts {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  cachedPerms?: Set<string>;
}

function makeReq(user: unknown, optsOrCachedPerms?: Set<string> | MakeReqOpts): Request {
  const opts: MakeReqOpts =
    optsOrCachedPerms instanceof Set ? { cachedPerms: optsOrCachedPerms } : (optsOrCachedPerms ?? {});
  const req: any = {
    user,
    query: opts.query ?? {},
    params: opts.params ?? {},
    body: opts.body ?? {},
    headers: opts.headers ?? {},
    get: function (name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  if (opts.cachedPerms !== undefined) req._permissions = opts.cachedPerms;
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

  it('calls getUserPermissions with the profile oid and undefined project when no project context', async () => {
    const req = makeReq({ profile: { oid: 'oid-abc' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));

    await requirePermission('admin:roles')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('oid-abc', undefined);
  });

  it('passes project from query string to getUserPermissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } }, { query: { project: 'ProjectAlpha' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requirePermission('chat:create')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'ProjectAlpha');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes project from X-Apex-Project header to getUserPermissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } }, { headers: { 'x-apex-project': 'HeaderProj' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requirePermission('chat:create')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'HeaderProj');
  });

  it('passes project from req.body to getUserPermissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } }, { body: { project: 'BodyProj' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requirePermission('chat:create')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'BodyProj');
  });

  it('prefers query.project over header', async () => {
    const req = makeReq(
      { profile: { oid: 'user-1' } },
      { query: { project: 'QueryProj' }, headers: { 'x-apex-project': 'HeaderProj' } },
    );
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await requirePermission('chat:create')(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'QueryProj');
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

// ── requireGroupMembership ─────────────────────────────────────────────────────

describe('requireGroupMembership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSuperAdminRequest.mockReturnValue(false);
  });

  it('returns 401 when req.user is missing', async () => {
    const req = makeReq(undefined);
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user has no oid', async () => {
    const req = makeReq({ profile: {} });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the request is a super admin request', async () => {
    mockIsSuperAdminRequest.mockReturnValue(true);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockGetUserGroupNames).not.toHaveBeenCalled();
  });

  it('calls next() when the user has the admin:roles permission (admin bypass)', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['admin:roles']));
    mockGetUserGroupNames.mockResolvedValue([]);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when the user is in one of the allowed groups', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:manage']));
    mockGetUserGroupNames.mockResolvedValue(['BA']);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager', 'Product-Owner')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when the user is in a second allowed group (not the first)', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:manage']));
    mockGetUserGroupNames.mockResolvedValue(['Manager']);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager', 'Product-Owner')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when the user is not in any of the allowed groups', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:manage']));
    mockGetUserGroupNames.mockResolvedValue(['Developer', 'QA']);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager', 'Product-Owner')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      requiredGroups: ['BA', 'Manager', 'Product-Owner'],
    });
  });

  it('returns 403 when the user has no groups at all', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:manage']));
    mockGetUserGroupNames.mockResolvedValue([]);
    const req = makeReq({ profile: { oid: 'user-1' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await requireGroupMembership('BA', 'Manager')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── resolveRequestProject ─────────────────────────────────────────────────────

describe('resolveRequestProject', () => {
  it('returns query.project when present', () => {
    const req = makeReq(null, { query: { project: 'FromQuery' } });
    expect(resolveRequestProject(req)).toBe('FromQuery');
  });

  it('returns params.project when query is absent', () => {
    const req = makeReq(null, { params: { project: 'FromParams' } });
    expect(resolveRequestProject(req)).toBe('FromParams');
  });

  it('returns body.project when query and params are absent', () => {
    const req = makeReq(null, { body: { project: 'FromBody' } });
    expect(resolveRequestProject(req)).toBe('FromBody');
  });

  it('returns X-Apex-Project header when query/params/body are absent', () => {
    const req = makeReq(null, { headers: { 'x-apex-project': 'FromHeader' } });
    expect(resolveRequestProject(req)).toBe('FromHeader');
  });

  it('returns undefined when no project source is present', () => {
    const req = makeReq(null);
    expect(resolveRequestProject(req)).toBeUndefined();
  });

  it('prefers query over params over body over header', () => {
    const req = makeReq(null, {
      query: { project: 'Q' },
      params: { project: 'P' },
      body: { project: 'B' },
      headers: { 'x-apex-project': 'H' },
    });
    expect(resolveRequestProject(req)).toBe('Q');
  });

  it('skips empty-string query and falls through to params', () => {
    const req = makeReq(null, { query: { project: '' }, params: { project: 'FallbackParam' } });
    expect(resolveRequestProject(req)).toBe('FallbackParam');
  });
});

// ── attachPermissions with project ────────────────────────────────────────────

describe('attachPermissions (project-aware)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes resolved project to getUserPermissions', async () => {
    const req = makeReq({ profile: { oid: 'user-1' } }, { query: { project: 'ProjX' } });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:create']));

    await attachPermissions(req, res, next);

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'ProjX');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
