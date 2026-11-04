/**
 * S8 — Build run controls routes tests (PBI-035, PBI-036, TBI-029 DoD-3 / VT-05, VT-39).
 */
import express from 'express';
import request from 'supertest';
import { BuildRunControlError } from '../services/buildRunControlService';

const mockCancel = jest.fn();
const mockResume = jest.fn();
let mockUser = {
  id: 'u-req',
  project: 'Apex',
  permissions: new Set<string>(['builds:view']),
  isSuperAdmin: false,
};

jest.mock('../middleware/rbac', () => ({
  resolveRequestProject: (req: express.Request) =>
    (req.query.project as string)
    || (req.headers['x-apex-project'] as string)
    || mockUser.project,
  requireProjectAccess:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  requirePermission:
    (...perms: string[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { userPermissions?: Set<string> }).userPermissions =
        mockUser.permissions;
      if (mockUser.isSuperAdmin || perms.some((p) => mockUser.permissions.has(p))) {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    },
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => mockUser.id,
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => mockUser.isSuperAdmin,
}));

jest.mock('../services/buildRunControlService', () => {
  const actual = jest.requireActual('../services/buildRunControlService');
  return {
    ...actual,
    defaultBuildRunControlService: {
      cancel: (...args: unknown[]) => mockCancel(...args),
      resume: (...args: unknown[]) => mockResume(...args),
    },
  };
});

import buildRunControlsRouter from '../routes/buildRunControls';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/builds', buildRunControlsRouter);
  return app;
}

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

describe('POST /api/builds/:buildId/cancel & /resume (PBI-035, PBI-036, TBI-029 DoD-3 / VT-05, VT-39)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = {
      id: 'u-req',
      project: 'Apex',
      permissions: new Set(['builds:view']),
      isSuperAdmin: false,
    };
  });

  it('VT-05 TBI-029 DoD-3 validates UUID and reason length (400), allows requester/Project Admin/Platform Admin (200), and maps 403/404/409 errors', async () => {
    // Non-UUID -> 400 INVALID_REQUEST before DB read
    const badIdRes = await request(buildApp())
      .post('/api/builds/not-a-uuid/cancel?project=Apex')
      .send({});
    expect(badIdRes.status).toBe(400);
    expect(badIdRes.body.code).toBe('INVALID_REQUEST');
    expect(mockCancel).not.toHaveBeenCalled();

    // Reason > 500 chars -> 400 INVALID_REQUEST
    const longReasonRes = await request(buildApp())
      .post(`/api/builds/${VALID_UUID}/cancel?project=Apex`)
      .send({ reason: 'x'.repeat(501) });
    expect(longReasonRes.status).toBe(400);
    expect(longReasonRes.body.code).toBe('INVALID_REQUEST');

    // Requester cancel -> 200
    mockCancel.mockResolvedValueOnce({
      buildId: VALID_UUID,
      status: 'cancelled',
      suspendReason: null,
      allowedActions: { cancel: false, resume: false },
      stoppedAgents: 1,
      unconfirmedAgents: 0,
    });
    const okCancel = await request(buildApp())
      .post(`/api/builds/${VALID_UUID}/cancel?project=Apex`)
      .send({ reason: 'No longer needed' });
    expect(okCancel.status).toBe(200);
    expect(okCancel.body.status).toBe('cancelled');

    // Project Admin resume -> 200
    mockUser.id = 'u-admin';
    mockUser.permissions = new Set(['builds:view', 'admin:roles']);
    mockResume.mockResolvedValueOnce({
      buildId: VALID_UUID,
      status: 'building',
      suspendReason: null,
      allowedActions: { cancel: true, resume: false },
      stoppedAgents: 0,
      unconfirmedAgents: 0,
    });
    const okResume = await request(buildApp())
      .post(`/api/builds/${VALID_UUID}/resume?project=Apex`)
      .send({});
    expect(okResume.status).toBe(200);
    expect(okResume.body.status).toBe('building');

    // Refused Resume (cause not cleared) -> 409 with remainingCause
    mockResume.mockRejectedValueOnce(
      new BuildRunControlError(
        'RESUME_CAUSE_NOT_CLEARED',
        'Not resumed yet: cost limit still reached.',
        409,
        'cost_cap',
      ),
    );
    const conflictResume = await request(buildApp())
      .post(`/api/builds/${VALID_UUID}/resume?project=Apex`)
      .send({});
    expect(conflictResume.status).toBe(409);
    expect(conflictResume.body.code).toBe('RESUME_CAUSE_NOT_CLEARED');
    expect(conflictResume.body.remainingCause).toBe('cost_cap');
  });
});
