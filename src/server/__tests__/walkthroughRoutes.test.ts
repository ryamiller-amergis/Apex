/**
 * Authenticated Walkthrough routes — FEAT-001 TBI-002 (VT-09 / VT-10 / DoD-2).
 */

import request from 'supertest';
import express from 'express';
import walkthroughsRouter from '../routes/walkthroughs';
import * as walkthroughService from '../services/walkthroughService';
import { WalkthroughDomainError } from '../../shared/types/walkthrough';

jest.mock('../services/walkthroughService');
jest.mock('../utils/requestUser', () => ({
  getUserId: (req: any) => req.user?.profile?.oid ?? 'anonymous',
}));

const mockService = walkthroughService as jest.Mocked<typeof walkthroughService>;

function buildApp(oid = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid } };
    next();
  });
  app.use('/api/projects/:projectId/walkthroughs', walkthroughsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err?.message ?? 'error' });
  });
  return app;
}

const sampleDefinition = {
  id: 'wt-1',
  internalName: 'intro',
  userTitle: 'Intro',
  whyItMatters: 'Why',
  lifecycle: 'published' as const,
  priority: 1,
  revision: 1,
  publishedAt: '2026-07-01T00:00:00Z',
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-07-01T00:00:00Z',
  updatedBy: 'admin',
  updatedAt: '2026-07-01T00:00:00Z',
  steps: [],
  targeting: { project: 'Apex', groupId: null },
  targetingRules: [{ type: 'project' as const, value: 'Apex' }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('walkthroughs routes (TBI-002 DoD-1 / DoD-2)', () => {
  it('GET /next returns eligibility payload', async () => {
    mockService.getNextEligible.mockResolvedValue(sampleDefinition);
    const res = await request(buildApp()).get('/api/projects/Apex/walkthroughs/next');
    expect(res.status).toBe(200);
    expect(res.body.walkthrough.id).toBe('wt-1');
    expect(mockService.getNextEligible).toHaveBeenCalledWith('Apex', 'user-1');
  });

  it('VT-10 — GET definition maps inaccessible to 404', async () => {
    mockService.getAccessibleDefinition.mockRejectedValue(
      new WalkthroughDomainError('WALKTHROUGH_NOT_FOUND', 'Walkthrough not found'),
    );
    const res = await request(buildApp()).get('/api/projects/Apex/walkthroughs/other-id');
    expect(res.status).toBe(404);
  });

  it('VT-10 / DoD-2 — PUT progress ignores client userId and uses session caller', async () => {
    mockService.updateOwnProgress.mockResolvedValue({
      walkthroughId: 'wt-1',
      userId: 'user-1',
      revision: 1,
      status: 'completed',
      lastStepId: null,
      seenAt: '2026-07-01T00:00:00Z',
      acknowledgedAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      acknowledged: true,
    });

    const res = await request(buildApp('user-1'))
      .put('/api/projects/Apex/walkthroughs/wt-1/progress')
      .send({ status: 'completed', revision: 1, userId: 'victim-user' });

    expect(res.status).toBe(200);
    expect(mockService.updateOwnProgress).toHaveBeenCalledWith(
      'Apex',
      'wt-1',
      'user-1',
      expect.objectContaining({ status: 'completed', revision: 1 }),
    );
    const passedBody = mockService.updateOwnProgress.mock.calls[0][3] as any;
    expect(passedBody.userId).toBeUndefined();
  });

  it('GET /replay returns page', async () => {
    mockService.listReplay.mockResolvedValue({ items: [], nextCursor: null });
    const res = await request(buildApp()).get('/api/projects/Apex/walkthroughs/replay');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
