import express from 'express';
import request from 'supertest';
import type { GroundingGateEvaluation } from '../../shared/types/groundingOperations';
import platformAdminRouter from '../routes/platformAdmin';
import { groundingGateService } from '../services/groundingGateService';

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.mock('../services/groundingGateService', () => ({
  groundingGateService: {
    evaluate: jest.fn(),
  },
}));

const mockEvaluate = groundingGateService.evaluate as jest.MockedFunction<
  typeof groundingGateService.evaluate
>;

const eligibleEvaluation: GroundingGateEvaluation = {
  cohort: 'design-module',
  sampleSize: 100,
  minimumSampleSize: 100,
  gates: [
    {
      id: 'fallback-rate',
      label: 'Remote fallback rate',
      value: 0.01,
      threshold: 0.02,
      comparison: '<',
      status: 'pass',
    },
  ],
  eligible: true,
  blockingGates: [],
};

function buildApp() {
  const app = express();
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

describe('GET /api/platform-admin/grounding/rollout-status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('AC-0 / BR-011 / performance NFR returns eligible supporting metrics with one bounded gate query', async () => {
    mockEvaluate.mockResolvedValue(eligibleEvaluation);

    const response = await request(buildApp()).get(
      '/api/platform-admin/grounding/rollout-status?stage=design-module&project=Apex',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(eligibleEvaluation);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith('design-module', 'Apex');
  });

  it('AC-1 / BR-011 returns a conservative blocked result naming failed and unknown gates', async () => {
    const blockedEvaluation: GroundingGateEvaluation = {
      ...eligibleEvaluation,
      sampleSize: 25,
      gates: [
        {
          ...eligibleEvaluation.gates[0],
          value: null,
          status: 'unknown',
        },
      ],
      eligible: false,
      blockingGates: ['fallback-rate'],
    };
    mockEvaluate.mockResolvedValue(blockedEvaluation);

    const response = await request(buildApp()).get(
      '/api/platform-admin/grounding/rollout-status?stage=assistants-walkthroughs',
    );

    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(false);
    expect(response.body.blockingGates).toEqual(['fallback-rate']);
    expect(response.body.gates[0].status).toBe('unknown');
    expect(mockEvaluate).toHaveBeenCalledWith('assistants-walkthroughs', undefined);
  });

  it.each(['', 'unknown-stage', 'INTERVIEW'])(
    'AC-1 rejects invalid rollout stage %p without querying telemetry',
    async (stage) => {
      const response = await request(buildApp()).get(
        `/api/platform-admin/grounding/rollout-status?stage=${encodeURIComponent(stage)}`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/stage/i);
      expect(mockEvaluate).not.toHaveBeenCalled();
    },
  );
});
