jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
}));

import {
  getAppEnvironment,
  getSuperAdminEmails,
  isSuperAdminEmail,
  isSuperAdminRequest,
} from '../utils/superAdmin';
import { requirePermission, requireSuperAdmin } from '../middleware/rbac';
import type { Request, Response, NextFunction } from 'express';

// ── getAppEnvironment ──────────────────────────────────────────────────────────

describe('getAppEnvironment', () => {
  const originalAppEnv = process.env.APP_ENV;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.APP_ENV = originalAppEnv;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('normalizes prod values', () => {
    process.env.APP_ENV = 'prod';
    expect(getAppEnvironment()).toBe('prod');
    process.env.APP_ENV = 'PRODUCTION';
    expect(getAppEnvironment()).toBe('prod');
  });

  it('normalizes dev values', () => {
    process.env.APP_ENV = 'dev';
    expect(getAppEnvironment()).toBe('dev');
    process.env.APP_ENV = 'development';
    expect(getAppEnvironment()).toBe('dev');
    process.env.APP_ENV = 'staging';
    expect(getAppEnvironment()).toBe('dev');
  });

  it('resolves explicit local', () => {
    process.env.APP_ENV = 'local';
    process.env.NODE_ENV = 'production';
    expect(getAppEnvironment()).toBe('local');
  });

  it('defaults to local when APP_ENV is unset and not a production process', () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'development';
    expect(getAppEnvironment()).toBe('local');
  });

  it('falls back to prod when APP_ENV is unset but NODE_ENV is production', () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'production';
    expect(getAppEnvironment()).toBe('prod');
  });
});

// ── getSuperAdminEmails ──────────────────────────────────────────────────────────

describe('getSuperAdminEmails', () => {
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    process.env.APP_ENV = originalAppEnv;
  });

  it('returns the list for the requested environment', () => {
    expect(Array.isArray(getSuperAdminEmails('local'))).toBe(true);
    expect(Array.isArray(getSuperAdminEmails('dev'))).toBe(true);
    expect(Array.isArray(getSuperAdminEmails('prod'))).toBe(true);
  });

  it('defaults to the current environment when no env is passed', () => {
    process.env.APP_ENV = 'dev';
    expect(getSuperAdminEmails()).toBe(getSuperAdminEmails('dev'));
  });
});

// ── isSuperAdminEmail ──────────────────────────────────────────────────────────

describe('isSuperAdminEmail', () => {
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    process.env.APP_ENV = originalAppEnv;
  });

  it('returns true for an exact match', () => {
    expect(isSuperAdminEmail('ryamiller@amergis.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSuperAdminEmail('RYAMILLER@AMERGIS.COM')).toBe(true);
    expect(isSuperAdminEmail('RyaMiller@Amergis.Com')).toBe(true);
  });

  it('returns false for a non-matching email', () => {
    expect(isSuperAdminEmail('nobody@amergis.com')).toBe(false);
    expect(isSuperAdminEmail('ryamiller@example.com')).toBe(false);
  });

  it('honors an explicit environment argument', () => {
    expect(isSuperAdminEmail('ryamiller@amergis.com', 'prod')).toBe(true);
    expect(isSuperAdminEmail('nobody@amergis.com', 'prod')).toBe(false);
  });

  it('resolves against the current environment when none is passed', () => {
    process.env.APP_ENV = 'prod';
    expect(isSuperAdminEmail('ryamiller@amergis.com')).toBe(true);
  });

  it('rejects an email that is not present in the resolved environment list', () => {
    // Cross-check the mechanism: an email absent from the dev list is rejected
    // regardless of whether it appears in another environment's list.
    const devList = getSuperAdminEmails('dev').map((e) => e.toLowerCase());
    const notInDev = 'someone-not-listed@amergis.com';
    expect(devList).not.toContain(notInDev);
    expect(isSuperAdminEmail(notInDev, 'dev')).toBe(false);
  });
});

// ── isSuperAdminRequest ────────────────────────────────────────────────────────

describe('isSuperAdminRequest', () => {
  it('returns true when profile.upn matches', () => {
    const req = { user: { profile: { upn: 'ryamiller@amergis.com' } } } as unknown as Request;
    expect(isSuperAdminRequest(req)).toBe(true);
  });

  it('falls back to profile.email when upn is missing', () => {
    const req = { user: { profile: { email: 'ryamiller@amergis.com' } } } as unknown as Request;
    expect(isSuperAdminRequest(req)).toBe(true);
  });

  it('returns false when no user', () => {
    const req = {} as unknown as Request;
    expect(isSuperAdminRequest(req)).toBe(false);
  });

  it('returns false when no email fields', () => {
    const req = { user: { profile: {} } } as unknown as Request;
    expect(isSuperAdminRequest(req)).toBe(false);
  });
});

// ── requirePermission super-admin bypass ───────────────────────────────────────

describe('requirePermission with super admin', () => {
  const mockRes = () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    return res;
  };

  it('calls next() immediately for super admin without checking permissions', async () => {
    const req = { user: { profile: { upn: 'ryamiller@amergis.com', oid: 'sa-oid' } } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    const handler = requirePermission('admin:roles');
    await handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when no user is present', async () => {
    const req = {} as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    const handler = requirePermission('admin:roles');
    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── requireSuperAdmin ──────────────────────────────────────────────────────────

describe('requireSuperAdmin', () => {
  const mockRes = () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    return res;
  };

  it('calls next() for a super admin', async () => {
    const req = { user: { profile: { upn: 'ryamiller@amergis.com' } } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await requireSuperAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no user', async () => {
    const req = {} as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-super-admin user', async () => {
    const req = { user: { profile: { upn: 'regular@amergis.com' } } } as unknown as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
