jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn().mockResolvedValue(new Set()),
}));

import { isSuperAdminEmail, isSuperAdminRequest } from '../utils/superAdmin';
import { requirePermission, requireSuperAdmin } from '../middleware/rbac';
import type { Request, Response, NextFunction } from 'express';

// ── isSuperAdminEmail ──────────────────────────────────────────────────────────

describe('isSuperAdminEmail', () => {
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
