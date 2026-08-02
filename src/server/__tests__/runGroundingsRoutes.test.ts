jest.mock('../db/drizzle', () => ({ db: {} }));

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { RunGroundingService } from '../services/runGroundingService';
import type { ResolvedRunGroundingSurface } from '../services/runGroundingService';
import { createRunGroundingsRouter } from '../routes/runGroundings';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const groundedAt = '2026-08-02T14:00:00.000Z';

const resolved: ResolvedRunGroundingSurface = {
  surface: 'prd',
  domainRunId: 'prd-1',
  run: {
    runType: 'chat',
    runId: 'prd-thread',
    project: 'Apex',
  },
  ownerId: 'owner-1',
  participantIds: ['owner-1', 'participant-1'],
};

function serviceMock(): jest.Mocked<RunGroundingService> {
  return {
    activateGroundings: jest.fn(),
    copyGrounding: jest.fn(),
    copyGroundingByValue: jest.fn(),
    getGroundings: jest.fn(),
    findActiveByRepoBranch: jest.fn(),
    reground: jest.fn(),
    deactivate: jest.fn(),
    markTerminalInactive: jest.fn(),
    persistThenMarkTerminalInactive: jest.fn(),
    getStatus: jest.fn(),
    reGroundFromCache: jest.fn(),
  };
}

function buildApp(
  userId: string,
  options: {
    service?: jest.Mocked<RunGroundingService>;
    resolveSurface?: jest.Mock;
    featureEnabled?: boolean;
  } = {}
) {
  const service = options.service ?? serviceMock();
  const resolveSurface =
    options.resolveSurface ?? jest.fn().mockResolvedValue(resolved);
  const permissions: string[] = [];
  const permissionMiddleware = (permission: string): RequestHandler => {
    permissions.push(permission);
    return (_req, _res, next) => next();
  };
  const router = createRunGroundingsRouter({
    service,
    resolveSurface,
    isFeatureEnabled: jest
      .fn()
      .mockResolvedValue(options.featureEnabled ?? true),
    permissionMiddleware,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { profile: { oid: userId } };
    next();
  });
  app.use('/api/run-groundings', router);
  return { app, service, resolveSurface, permissions };
}

describe('TBI-004 run grounding route authorization', () => {
  it('DoD-3 allows an authorized participant to read status through the PRD surface permission', async () => {
    // Arrange
    const fixture = buildApp('participant-1');
    fixture.service.getStatus.mockResolvedValue({
      runType: 'chat',
      runId: 'prd-thread',
      role: 'target',
      groundedSha: shaA,
      groundedShaShort: shaA.slice(0, 12),
      groundedAt,
      driftState: 'grounded',
      canReGround: false,
    });

    // Act
    const response = await request(fixture.app).get(
      '/api/run-groundings/prd/prd-1?role=target'
    );

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        groundedSha: shaA,
        canReGround: false,
      }),
    ]);
    expect(fixture.permissions).toContain('prds:review');
    expect(fixture.service.getStatus).toHaveBeenCalledWith(
      resolved.run,
      'target',
      false
    );
  });

  it('security unrelated scope discloses no grounding metadata or checkout path', async () => {
    // Arrange
    const fixture = buildApp('unrelated-user');
    fixture.service.getStatus.mockResolvedValue({
      runType: 'chat',
      runId: 'prd-thread',
      role: 'target',
      groundedSha: shaA,
      groundedShaShort: shaA.slice(0, 12),
      groundedAt,
      driftState: 'grounded',
      canReGround: false,
    });

    // Act
    const response = await request(fixture.app).get(
      '/api/run-groundings/prd/prd-1'
    );

    // Assert
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Run grounding not found' });
    expect(JSON.stringify(response.body)).not.toMatch(
      /sha|checkout|credential|path/i
    );
    expect(fixture.service.getStatus).not.toHaveBeenCalled();
  });

  it('security permits only the run owner to explicitly re-ground', async () => {
    // Arrange
    const fixture = buildApp('participant-1');

    // Act
    const response = await request(fixture.app)
      .post('/api/run-groundings/prd/prd-1/re-ground')
      .send({ role: 'target' });

    // Assert
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
    expect(fixture.service.reGroundFromCache).not.toHaveBeenCalled();
  });

  it('DoD-3 owner re-ground accepts no caller SHA and pins through the cached-only service contract', async () => {
    // Arrange
    const fixture = buildApp('owner-1');
    fixture.service.reGroundFromCache.mockResolvedValue({
      previousSha: shaA,
      newSha: shaB,
      groundedAt,
    });

    // Act
    const response = await request(fixture.app)
      .post('/api/run-groundings/prd/prd-1/re-ground')
      .send({ role: 'target', sha: 'caller-controlled-sha' });

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      previousSha: shaA,
      newSha: shaB,
      groundedAt,
    });
    expect(fixture.service.reGroundFromCache).toHaveBeenCalledWith(
      resolved.run,
      'target'
    );
  });

  it('feature flag off preserves the null contract with a 404', async () => {
    // Arrange
    const fixture = buildApp('owner-1', { featureEnabled: false });

    // Act
    const response = await request(fixture.app).get(
      '/api/run-groundings/prd/prd-1'
    );

    // Assert
    expect(response.status).toBe(404);
    expect(fixture.service.getStatus).not.toHaveBeenCalled();
  });
});
