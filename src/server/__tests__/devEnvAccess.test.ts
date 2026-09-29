jest.mock('../services/devEnvAllowlistService', () => ({
  isDevEnvironmentAllowed: jest.fn(),
}));

import type { NextFunction, Request, Response } from 'express';
import { ensureAuthenticated } from '../middleware/auth';
import { enforceDevEnvironmentAccess } from '../middleware/devEnvAccess';
import { isDevEnvironmentAllowed } from '../services/devEnvAllowlistService';
import { DEV_ENV_ACCESS_DENIED_CODE } from '../../shared/types/devEnvAllowlist';

const mockIsAllowed = isDevEnvironmentAllowed as jest.MockedFunction<typeof isDevEnvironmentAllowed>;

function mockResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('dev environment access', () => {
  const originalAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_ENV = 'dev';
  });

  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  it('skips the list outside the dev site', async () => {
    process.env.APP_ENV = 'local';
    const res = mockResponse();
    await expect(enforceDevEnvironmentAccess({} as Request, res)).resolves.toBe(true);
    expect(mockIsAllowed).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in email is not approved', async () => {
    mockIsAllowed.mockResolvedValue(false);
    const req = { user: { profile: { upn: 'other@example.com' } } } as unknown as Request;
    const res = mockResponse();
    await expect(enforceDevEnvironmentAccess(req, res)).resolves.toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: DEV_ENV_ACCESS_DENIED_CODE,
    }));
  });

  it('continues an authenticated request when the email is approved', async () => {
    mockIsAllowed.mockResolvedValue(true);
    const req = {
      isAuthenticated: () => true,
      user: { profile: { email: 'person@example.com' } },
      sessionID: 'session-1',
    } as unknown as Request;
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    await ensureAuthenticated(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still requires a session before checking the list', async () => {
    const req = { isAuthenticated: () => false, sessionID: 'session-1' } as unknown as Request;
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    await ensureAuthenticated(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockIsAllowed).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
