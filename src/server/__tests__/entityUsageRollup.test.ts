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
        feature: 'interview',
        skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
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
    expect(rollup.pendingSteps).toEqual([]);
    expect(rollup.runs).toHaveLength(2);
    expect(rollup.runs[0].label).toBe('Interview');
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

  it('labels PRD workflow threads and keeps pending later steps', async () => {
    whereMock.mockResolvedValue([
      {
        modelId: 'composer-2.5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        costUsd: '0.40',
        costSource: 'computed',
        durationMs: 1000,
        tokenSource: 'exact',
        createdAt: '2026-09-01T00:00:00.000Z',
        threadId: 'gen-1',
        feature: 'prd',
        skillPath: '.cursor/skills/to-prd/SKILL.md',
      },
      {
        modelId: 'gpt-4o-mini',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        costUsd: '0.02',
        costSource: 'computed',
        durationMs: 800,
        tokenSource: 'exact',
        createdAt: '2026-09-01T00:02:00.000Z',
        threadId: 'tc-1',
        feature: 'test-case',
        skillPath: '.cursor/skills/create-test-case/SKILL.md',
      },
    ]);

    const rollup = await getEntityUsageRollup({
      entityType: 'prd',
      entityId: 'prd-1',
      threadIds: ['gen-1', 'tc-1', 'val-1'],
      threadLabels: {
        'gen-1': 'Generate',
        'tc-1': 'Test cases',
        'val-1': 'Validation',
      },
      pendingSteps: ['Validation'],
    });

    expect(rollup.runs.map((run) => `${run.label}:${run.modelId}`)).toEqual([
      'Generate:composer-2.5',
      'Test cases:gpt-4o-mini',
    ]);
    expect(rollup.pendingSteps).toEqual(['Validation']);
    expect(rollup.costUsd).toBeCloseTo(0.42);
  });

  it('marks cost pending when exact tokens have no catalog price', async () => {
    whereMock.mockResolvedValue([
      {
        modelId: 'unknown-cursor-model',
        inputTokens: 42_000,
        outputTokens: 900,
        cacheReadTokens: 0,
        costUsd: '0',
        costSource: 'estimated',
        durationMs: 4200,
        tokenSource: 'exact',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const rollup = await getEntityUsageRollup({ entityType: 'interview', entityId: 'int-1' });
    expect(rollup.incomplete).toBe(true);
    expect(rollup.costUsd).toBe(0);
    expect(rollup.inputTokens).toBe(42_000);
  });
});
