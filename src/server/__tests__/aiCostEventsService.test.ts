import { getEvents } from '../services/aiCostAnalyticsService';

const offsetMock = jest.fn();
const executeMock = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: offsetMock,
    })),
    execute: executeMock,
  },
}));

jest.mock('../db/schema', () => ({
  aiUsageEvents: {
    createdAt: 'created_at',
    project: 'project',
    feature: 'feature',
    modelId: 'model_id',
    provider: 'provider',
  },
  cursorUsageEvents: {},
  aiPricing: {},
}));

describe('getEvents effort mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    executeMock.mockResolvedValue({ rows: [{ count: '2' }] });
  });

  it('TBI-006 DoD-3 / VT-05/VT-07 maps valid, null, and opaque stored effort values', async () => {
    const base = {
      provider: 'cursor',
      modelId: 'composer-2.5',
      feature: 'feature-request',
      project: 'Apex',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokenSource: 'exact',
      costUsd: '0.01000000',
      costSource: 'computed',
      durationMs: 500,
      status: 'success',
      entityType: null,
      entityId: null,
      workItemId: null,
      createdAt: '2026-09-08T00:00:00.000Z',
    };
    offsetMock.mockResolvedValue([
      { ...base, id: 'valid', effort: 'low' },
      { ...base, id: 'opaque', effort: 'ultra' },
    ]);

    const result = await getEvents(
      { from: '2026-09-01T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z' },
      1,
      20,
    );

    expect(result.events[0].effort).toBe('low');
    expect(result.events[1].effort).toBe('ultra');
  });
});
