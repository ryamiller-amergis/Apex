import { getEntityUsageRollup } from '../services/aiCostAnalyticsService';

const whereMock = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: whereMock,
    })),
  },
}));

jest.mock('../db/schema', () => ({
  aiUsageEvents: {
    entityType: 'entity_type',
    entityId: 'entity_id',
    threadId: 'thread_id',
  },
  cursorUsageEvents: {},
  aiPricing: {},
}));

describe('getEntityUsageRollup', () => {
  beforeEach(() => {
    whereMock.mockReset();
  });

  it('unions entity columns and thread ids and sums tokens, cost, and duration', async () => {
    whereMock.mockResolvedValue([
      {
        modelId: 'composer-2.5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        costUsd: '0.50',
        costSource: 'allocated',
        durationMs: 1000,
        tokenSource: 'estimated',
        createdAt: '2026-09-01T00:00:00.000Z',
        entityType: 'interview',
        entityId: 'int-1',
        threadId: 't-new',
      },
      {
        modelId: 'composer-2.5-fast',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        costUsd: '0.10',
        costSource: 'estimated',
        durationMs: null,
        tokenSource: 'estimated',
        createdAt: '2026-09-01T00:00:02.000Z',
        entityType: null,
        entityId: null,
        threadId: 't-legacy',
      },
    ]);

    const rollup = await getEntityUsageRollup({
      entityType: 'interview',
      entityId: 'int-1',
      threadIds: ['t-legacy'],
    });

    expect(rollup.inputTokens).toBe(150);
    expect(rollup.outputTokens).toBe(30);
    expect(rollup.cacheReadTokens).toBe(5);
    expect(rollup.totalTokens).toBe(185);
    expect(rollup.costUsd).toBeCloseTo(0.6);
    expect(rollup.costSource).toBe('allocated');
    expect(rollup.durationMs).toBe(1000);
    expect(rollup.interactions).toBe(2);
    expect(rollup.models).toEqual(expect.arrayContaining(['composer-2.5', 'composer-2.5-fast']));
    expect(rollup.incomplete).toBe(false);
    expect(rollup.runs).toHaveLength(2);
  });

  it('falls back to first-to-last elapsed time when durations are missing', async () => {
    whereMock.mockResolvedValue([
      {
        modelId: 'm',
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: '0',
        costSource: 'estimated',
        durationMs: null,
        tokenSource: 'estimated',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        modelId: 'm',
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: '0',
        costSource: 'estimated',
        durationMs: null,
        tokenSource: 'estimated',
        createdAt: '2026-09-01T00:00:05.000Z',
      },
    ]);

    const rollup = await getEntityUsageRollup({ entityType: 'prd', entityId: 'prd-1' });
    expect(rollup.durationMs).toBe(5000);
    expect(rollup.incomplete).toBe(true);
  });

  it('returns an empty rollup when no events match', async () => {
    whereMock.mockResolvedValue([]);
    const rollup = await getEntityUsageRollup({ entityType: 'design-prototype', entityId: 'p-1' });
    expect(rollup.interactions).toBe(0);
    expect(rollup.incomplete).toBe(false);
  });
});
