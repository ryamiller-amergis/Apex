import {
  createNightlyIdleReGroundService,
  etCalendarDate,
  isNightlyIdleReGroundDue,
} from '../services/nightlyIdleReGroundService';
import type { RunGrounding } from '../../shared/types/runGrounding';

function grounding(overrides: Partial<RunGrounding> = {}): RunGrounding {
  return {
    id: 'g1',
    runType: 'chat',
    runId: 'thread-1',
    project: 'Apex',
    repoRole: 'target',
    provider: 'github',
    repository: 'AI-Pilot',
    branch: 'main',
    groundedSha: 'a'.repeat(40),
    groundedAt: '2026-08-01T00:00:00.000Z',
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('nightlyIdleReGroundService', () => {
  it('is due after 23:00 ET once per calendar day', () => {
    // 2026-08-20 23:30 EDT = 2026-08-21 03:30 UTC
    const afterEleven = new Date('2026-08-21T03:30:00.000Z');
    expect(isNightlyIdleReGroundDue(afterEleven, null)).toBe(true);
    expect(isNightlyIdleReGroundDue(afterEleven, etCalendarDate(afterEleven))).toBe(
      false,
    );

    // 2026-08-20 22:00 EDT = 2026-08-21 02:00 UTC
    const beforeEleven = new Date('2026-08-21T02:00:00.000Z');
    expect(isNightlyIdleReGroundDue(beforeEleven, null)).toBe(false);
  });

  it('re-grounds idle behind chat pins and skips running threads', async () => {
    const reGroundFromCache = jest.fn().mockResolvedValue({
      previousSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      groundedAt: '2026-08-21T03:35:00.000Z',
    });
    const service = createNightlyIdleReGroundService({
      now: () => new Date('2026-08-21T03:30:00.000Z'),
      listActiveGroundings: async () => [
        grounding({ runId: 'idle-behind' }),
        grounding({ runId: 'running-thread', id: 'g2' }),
        grounding({ runId: 'idle-fresh', id: 'g3', groundedSha: 'b'.repeat(40) }),
      ],
      readCachedOriginSha: async () => 'b'.repeat(40),
      isThreadIdle: async (threadId) => threadId !== 'running-thread',
      isEligibleLongLivedChat: async () => true,
      reGroundFromCache,
    });

    const first = await service.runIfDue();
    expect(first.due).toBe(true);
    expect(first.reGrounded).toBe(1);
    expect(first.skippedRunning).toBe(1);
    expect(first.skippedFresh).toBe(1);
    expect(reGroundFromCache).toHaveBeenCalledTimes(1);
    expect(reGroundFromCache).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'idle-behind' }),
      'target',
    );

    const second = await service.runIfDue();
    expect(second.due).toBe(false);
    expect(reGroundFromCache).toHaveBeenCalledTimes(1);
  });

  it('skips completed interviews and generation jobs', async () => {
    const reGroundFromCache = jest.fn();
    const service = createNightlyIdleReGroundService({
      now: () => new Date('2026-08-21T03:30:00.000Z'),
      listActiveGroundings: async () => [
        grounding({ runId: 'done-interview' }),
        grounding({ runId: 'prd-generation', id: 'g2' }),
      ],
      readCachedOriginSha: async () => 'b'.repeat(40),
      isThreadIdle: async () => true,
      isEligibleLongLivedChat: async (threadId) =>
        threadId !== 'done-interview' && threadId !== 'prd-generation',
      reGroundFromCache,
    });

    const result = await service.runIfDue();
    expect(result.skippedIneligible).toBe(2);
    expect(reGroundFromCache).not.toHaveBeenCalled();
  });

  it('re-grounds idle ADR and PRD/design-doc assistant pins', async () => {
    const reGroundFromCache = jest.fn().mockResolvedValue({
      previousSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      groundedAt: '2026-08-21T03:35:00.000Z',
    });
    const eligible = new Set([
      'adr-chat',
      'adr-assistant',
      'prd-assistant',
      'design-doc-assistant',
      'home-chat',
    ]);
    const service = createNightlyIdleReGroundService({
      now: () => new Date('2026-08-21T03:30:00.000Z'),
      listActiveGroundings: async () => [
        grounding({ runId: 'adr-chat' }),
        grounding({ runId: 'prd-assistant', id: 'g2' }),
        grounding({ runId: 'design-doc-assistant', id: 'g3' }),
        grounding({ runId: 'prd-generation', id: 'g4' }),
        grounding({ runId: 'home-chat', id: 'g5' }),
      ],
      readCachedOriginSha: async () => 'b'.repeat(40),
      isThreadIdle: async () => true,
      isEligibleLongLivedChat: async (threadId) => eligible.has(threadId),
      reGroundFromCache,
    });

    const result = await service.runIfDue();
    expect(result.reGrounded).toBe(4);
    expect(result.skippedIneligible).toBe(1);
    expect(reGroundFromCache).toHaveBeenCalledTimes(4);
    expect(reGroundFromCache.mock.calls.map((c) => c[0].runId).sort()).toEqual([
      'adr-chat',
      'design-doc-assistant',
      'home-chat',
      'prd-assistant',
    ]);
  });
});
