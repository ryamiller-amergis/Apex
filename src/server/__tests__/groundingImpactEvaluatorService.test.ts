jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));
jest.mock('../db/drizzle', () => ({
  db: {
    query: { chatThreads: { findFirst: jest.fn() } },
    select: jest.fn(),
  },
}));
jest.mock('../services/chatAgentService', () => ({
  resolveGroundingCallerKey: jest.fn().mockReturnValue('prd'),
}));

import { Agent } from '@cursor/sdk';
import type { RunGrounding } from '../../shared/types/runGrounding';
import {
  createGroundingImpactEvaluatorService,
  evaluateWithCursorSdk,
  groundingImpactDedupeKey,
  resolveProductionRunImpactContext,
} from '../services/groundingImpactEvaluatorService';
import { runImpactContextRegistry } from '../services/runImpactContextRegistry';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: { query: { chatThreads: { findFirst: jest.Mock } } };
};
const { resolveGroundingCallerKey: mockResolveGroundingCallerKey } =
  jest.requireMock('../services/chatAgentService') as {
    resolveGroundingCallerKey: jest.Mock;
  };

const event = {
  provider: 'github' as const,
  project: 'Apex',
  repository: 'AI-Pilot',
  branch: 'main',
  fromSha: 'a'.repeat(40),
  toSha: 'b'.repeat(40),
  changedFiles: ['src/server/services/groundingGateService.ts'],
};

function grounding(index: number): RunGrounding {
  return {
    id: `grounding-${index}`,
    runType: 'chat',
    runId: `run-${index}`,
    repoRole: 'target',
    provider: 'github',
    project: 'Apex',
    repository: 'AI-Pilot',
    branch: 'main',
    groundedSha: event.fromSha,
    groundedAt: '2026-08-01T00:00:00.000Z',
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function dependencies(rows: RunGrounding[]) {
  return {
    findActiveByRepoBranch: jest.fn().mockResolvedValue(rows),
    resolveRun: jest.fn().mockImplementation(async (run: RunGrounding) => ({
      authorId: `author-${run.runId}`,
      title: `Grounded run ${run.runId}`,
      link: `/agent?thread=${run.runId}`,
      caller: 'interview',
      scopePaths: ['src/server/**'],
    })),
    hasProjectAccess: jest.fn().mockResolvedValue(true),
    isCallerEnabled: jest.fn().mockResolvedValue(true),
    heuristicFilter: jest
      .fn()
      .mockImplementation((changedFiles: string[], run: RunGrounding) =>
        run.runId === 'run-2' ? [] : changedFiles
      ),
    evaluateAiRelevance: jest
      .fn()
      .mockImplementation(
        async ({ run }: { run: RunGrounding }) => run.runId === 'run-1'
      ),
    isOperationalEnabled: jest.fn().mockResolvedValue(true),
    resolveModel: jest.fn().mockResolvedValue('project-default-model'),
    createNotification: jest.fn().mockResolvedValue({ id: 'notice-1' }),
    telemetry: {
      notification: jest.fn(),
    },
  };
}

describe('BR-012 / TBI-008 DoD-2 relevance-gated impact evaluation', () => {
  it('derives persisted chat caller using the live caller-key resolver', async () => {
    // Arrange
    const chatGrounding = grounding(1);
    const kickoff = {
      project: 'Apex',
      repo: 'AI-Pilot',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
    };
    mockDb.query.chatThreads.findFirst.mockResolvedValue({
      userId: 'chat-author',
      title: 'PRD run',
      kickoff,
    });
    mockResolveGroundingCallerKey.mockReturnValue('prd');

    // Act
    const context = await resolveProductionRunImpactContext(chatGrounding);

    // Assert
    expect(mockResolveGroundingCallerKey).toHaveBeenCalledWith(kickoff);
    expect(context).toEqual(
      expect.objectContaining({
        authorId: 'chat-author',
        title: 'PRD run',
        caller: 'prd',
      })
    );
  });

  it('feature-flag disabled performs no AI, notification, or volume telemetry', async () => {
    // Arrange
    const deps = dependencies([grounding(1)]);
    deps.isOperationalEnabled.mockResolvedValue(false);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(event);

    // Assert
    expect(result).toEqual({
      candidateCount: 0,
      filteredCount: 0,
      aiEvaluatedCount: 0,
      notifiedCount: 0,
      deduplicatedCount: 0,
    });
    expect(deps.findActiveByRepoBranch).not.toHaveBeenCalled();
    expect(deps.evaluateAiRelevance).not.toHaveBeenCalled();
    expect(deps.createNotification).not.toHaveBeenCalled();
    expect(deps.telemetry.notification).not.toHaveBeenCalled();
  });

  it('heuristically filters before AI and notifies only relevant authorized active authors', async () => {
    // Arrange
    const rows = [
      grounding(1),
      grounding(2),
      { ...grounding(3), groundedSha: 'c'.repeat(40) },
    ];
    const deps = dependencies(rows);
    const order: string[] = [];
    deps.heuristicFilter.mockImplementation((files, run) => {
      order.push(`heuristic:${run.runId}`);
      return run.runId === 'run-2' ? [] : files;
    });
    deps.evaluateAiRelevance.mockImplementation(async ({ run }) => {
      order.push(`ai:${run.runId}`);
      return run.runId === 'run-1';
    });
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(event);

    // Assert
    expect(deps.findActiveByRepoBranch).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repository: 'AI-Pilot',
      branch: 'main',
    });
    expect(order).toEqual(['heuristic:run-1', 'heuristic:run-2', 'ai:run-1']);
    expect(deps.evaluateAiRelevance).toHaveBeenCalledTimes(1);
    expect(deps.hasProjectAccess).toHaveBeenCalledWith('author-run-1', 'Apex');
    expect(deps.isCallerEnabled).toHaveBeenCalledWith({
      userId: 'author-run-1',
      project: 'Apex',
      caller: 'interview',
    });
    expect(deps.createNotification).toHaveBeenCalledTimes(1);
    expect(deps.createNotification).toHaveBeenCalledWith(
      'author-run-1',
      expect.objectContaining({
        type: 'ai',
        title: 'Grounded source changed',
        body: expect.stringContaining('Grounded run run-1'),
      }),
      {
        dedupeKey: groundingImpactDedupeKey(
          'run-1',
          event.fromSha,
          event.toSha
        ),
      }
    );
    expect(result).toEqual({
      candidateCount: 3,
      filteredCount: 2,
      aiEvaluatedCount: 1,
      notifiedCount: 1,
      deduplicatedCount: 0,
    });
    expect(deps.telemetry.notification).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'Apex' }),
      result
    );
  });

  it('fails closed for unresolved or unauthorized runs without AI or notice', async () => {
    // Arrange
    const deps = dependencies([grounding(1), grounding(2)]);
    deps.resolveRun.mockResolvedValueOnce(null).mockResolvedValueOnce({
      authorId: 'author-2',
      title: 'Run 2',
      caller: 'interview',
      scopePaths: ['src/server/**'],
    });
    deps.hasProjectAccess.mockResolvedValue(false);
    deps.heuristicFilter.mockImplementation((files) => files);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(event);

    // Assert
    expect(deps.evaluateAiRelevance).not.toHaveBeenCalled();
    expect(deps.createNotification).not.toHaveBeenCalled();
    expect(result.aiEvaluatedCount).toBe(0);
    expect(result.notifiedCount).toBe(0);
  });

  it('filters a caller-disabled candidate before heuristic, AI, and notification', async () => {
    // Arrange
    const deps = dependencies([grounding(1)]);
    deps.isCallerEnabled.mockResolvedValue(false);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(event);

    // Assert
    expect(deps.hasProjectAccess).toHaveBeenCalledWith('author-run-1', 'Apex');
    expect(deps.isCallerEnabled).toHaveBeenCalledWith({
      userId: 'author-run-1',
      project: 'Apex',
      caller: 'interview',
    });
    expect(deps.heuristicFilter).not.toHaveBeenCalled();
    expect(deps.evaluateAiRelevance).not.toHaveBeenCalled();
    expect(deps.createNotification).not.toHaveBeenCalled();
    expect(result).toEqual({
      candidateCount: 1,
      filteredCount: 1,
      aiEvaluatedCount: 0,
      notifiedCount: 0,
      deduplicatedCount: 0,
    });
    expect(deps.telemetry.notification).toHaveBeenCalledWith(
      expect.any(Object),
      result
    );
  });

  it('bounds AI evaluation to 20 surviving candidates per branch event', async () => {
    // Arrange
    const deps = dependencies(
      Array.from({ length: 25 }, (_, index) => grounding(index + 1))
    );
    deps.heuristicFilter.mockImplementation((files) => files);
    deps.evaluateAiRelevance.mockResolvedValue(false);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(event);

    // Assert
    expect(deps.evaluateAiRelevance).toHaveBeenCalledTimes(20);
    expect(result).toEqual(
      expect.objectContaining({
        candidateCount: 25,
        filteredCount: 5,
        aiEvaluatedCount: 20,
      })
    );
  });

  it('targets an active service run through the process-local production registry', async () => {
    // Arrange
    const serviceGrounding = {
      ...grounding(1),
      runType: 'service' as const,
      runId: 'ask-apex-session-1',
    };
    runImpactContextRegistry.register(serviceGrounding, {
      authorId: 'ask-apex-author',
      title: 'Ask Apex run',
      link: '/home',
      caller: 'ask-apex',
    });
    const deps = dependencies([serviceGrounding]);
    deps.resolveRun.mockImplementation(resolveProductionRunImpactContext);
    deps.heuristicFilter.mockImplementation((files) => files);
    deps.evaluateAiRelevance.mockResolvedValue(true);
    const service = createGroundingImpactEvaluatorService(deps);

    try {
      // Act
      await service.evaluate(event);

      // Assert
      expect(deps.createNotification).toHaveBeenCalledWith(
        'ask-apex-author',
        expect.objectContaining({
          body: expect.stringContaining('Ask Apex run'),
          link: '/home',
        }),
        expect.any(Object)
      );
    } finally {
      runImpactContextRegistry.unregister(serviceGrounding);
    }
  });
});

describe('BR-012 / TBI-008 DoD-4 noisy events and deduplication', () => {
  it.each([
    { ...event, toSha: event.fromSha },
    { ...event, changedFiles: [] },
    { ...event, changedFiles: ['package-lock.json'] },
  ])('ignores a noisy branch event %#', async (noisyEvent) => {
    // Arrange
    const deps = dependencies([grounding(1)]);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const result = await service.evaluate(noisyEvent);

    // Assert
    expect(deps.evaluateAiRelevance).not.toHaveBeenCalled();
    expect(deps.createNotification).not.toHaveBeenCalled();
    expect(result.aiEvaluatedCount).toBe(0);
  });

  it('uses exactly (runId, groundedSha, newSha) for deduplication', async () => {
    // Arrange
    const deps = dependencies([grounding(1)]);
    deps.heuristicFilter.mockImplementation((files) => files);
    deps.evaluateAiRelevance.mockResolvedValue(true);
    const service = createGroundingImpactEvaluatorService(deps);

    // Act
    const first = await service.evaluate(event);
    const repeated = await service.evaluate(event);

    // Assert
    expect(groundingImpactDedupeKey('run-1', event.fromSha, event.toSha)).toBe(
      `grounding-impact:run-1:${event.fromSha}:${event.toSha}`
    );
    expect(deps.createNotification.mock.calls[0][2]).toEqual({
      dedupeKey: `grounding-impact:run-1:${event.fromSha}:${event.toSha}`,
    });
    expect(deps.createNotification).toHaveBeenCalledTimes(1);
    expect(first.notifiedCount).toBe(1);
    expect(repeated).toEqual(
      expect.objectContaining({
        notifiedCount: 0,
        deduplicatedCount: 1,
      })
    );
    const payload = JSON.stringify(deps.createNotification.mock.calls[0][1]);
    expect(payload).not.toContain(event.changedFiles[0]);
  });
});

describe('BR-012 production AI relevance lifecycle', () => {
  it('AC-0 / VT-09 groundingImpactEvaluatorService streams and disposes its SDK agent', async () => {
    // Arrange
    const dispose = jest.fn().mockResolvedValue(undefined);
    const stream = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '{"relevant":true}' }],
        },
      };
    };
    jest.mocked(Agent.create).mockResolvedValue({
      send: jest.fn().mockResolvedValue({
        supports: () => true,
        stream,
      }),
      [Symbol.asyncDispose]: dispose,
    } as never);
    const previousApiKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'test-key';

    try {
      // Act
      const relevant = await evaluateWithCursorSdk({
        run: grounding(1),
        runTitle: 'Grounding telemetry',
        changedFiles: ['src/server/services/groundingTelemetry.ts'],
        fromSha: event.fromSha,
        toSha: event.toSha,
        modelId: 'project-default-model',
      });

      // Assert
      expect(relevant).toBe(true);
      expect(Agent.create).toHaveBeenCalledWith({
        apiKey: 'test-key',
        model: { id: 'project-default-model' },
      });
      const options = jest.mocked(Agent.create).mock.calls[0][0];
      // FEAT-001 verifies that Apex adds no native-read wiring. Host-level tool
      // denial remains the real-runtime capability gate owned by FEAT-005.
      expect(options).not.toHaveProperty('tools');
      expect(options).not.toHaveProperty('nativeTools');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CURSOR_API_KEY = previousApiKey;
    }
  });
});
