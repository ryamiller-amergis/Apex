import { recordCloudAgentUsage } from '../services/cloudAgentUsageService';

const limit = jest.fn();
const findFirst = jest.fn();
const inserted = jest.fn();
const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
const computeCost = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: () => ({
        where: () => ({
          limit,
        }),
      }),
    })),
    insert: jest.fn(() => ({
      values: (row: unknown) => {
        inserted(row);
        return { onConflictDoNothing };
      },
    })),
    query: {
      agentRuns: { findFirst: (...args: unknown[]) => findFirst(...args) },
    },
  },
}));

jest.mock('../services/aiUsageService', () => ({
  computeCost: (...args: unknown[]) => computeCost(...args),
  estimateTokens: (text: string) => Math.max(1, Math.ceil((text ?? '').length / 4)),
}));

describe('recordCloudAgentUsage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    limit.mockResolvedValue([]);
    onConflictDoNothing.mockResolvedValue(undefined);
    computeCost.mockResolvedValue(1.25);
    findFirst.mockResolvedValue({
      requestedByUserId: 'user-1',
      threadId: 'thread-1',
      startedAt: '2026-10-21T12:00:00.000Z',
      devSessionId: 'session-1',
      projectId: 'MaxView',
      executionSnapshot: {
        prompt: 'Implement the login form',
        model: 'composer-2.5',
        skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
        cloudAgent: { workItemId: 42 },
      },
    });
  });

  it('stores exact Cursor tokens against the cloud-agent feature', async () => {
    await recordCloudAgentUsage({
      runId: 'run-1',
      project: 'MaxView',
      status: 'completed',
      modelId: 'composer-2.5',
      durationMs: 5000,
      tokens: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
      },
    });

    expect(computeCost).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'cursor',
      modelId: 'composer-2.5',
      inputTokens: 1000,
      outputTokens: 200,
    }));
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'cloud-agent',
      provider: 'cursor',
      project: 'MaxView',
      runId: 'run-1',
      userId: 'user-1',
      workItemId: '42',
      entityType: 'dev-session',
      entityId: 'session-1',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      inputTokens: 1000,
      outputTokens: 200,
      tokenSource: 'exact',
      costSource: 'computed',
      costUsd: '1.25000000',
      status: 'success',
      durationMs: 5000,
    }));
  });

  it('estimates tokens from the prompt when Cursor did not report usage', async () => {
    computeCost.mockResolvedValue(0);

    await recordCloudAgentUsage({
      runId: 'run-1',
      project: 'MaxView',
      status: 'failed',
      resultText: 'boom',
    });

    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'composer-2.5',
      tokenSource: 'estimated',
      costSource: 'estimated',
      inputTokens: estimateOf('Implement the login form'),
      outputTokens: estimateOf('boom'),
      status: 'error',
    }));
  });

  it('does not insert a second row for the same run', async () => {
    limit.mockResolvedValue([{ id: 'existing' }]);

    await recordCloudAgentUsage({
      runId: 'run-1',
      project: 'MaxView',
      status: 'completed',
    });

    expect(inserted).not.toHaveBeenCalled();
  });
});

function estimateOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
