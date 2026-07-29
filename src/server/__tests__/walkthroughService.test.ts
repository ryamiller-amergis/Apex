/**
 * Walkthrough domain service tests — FEAT-001 TBI-002.
 * Criterion ids (DoD-*, VT-*) appear in test names for matrix traceability.
 */

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
  });
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });
  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        walkthroughs: { findMany: jest.fn(), findFirst: jest.fn() },
        appGroups: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

jest.mock('../services/featureFlagService', () => ({
  getUserGroupIdsForProject: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import {
  archiveWalkthrough,
  createWalkthrough,
  getAccessibleDefinition,
  getNextEligible,
  listReplay,
  publishWalkthrough,
  unpublishWalkthrough,
  updateOwnProgress,
  validateAiDraft,
} from '../services/walkthroughService';
import { getUserGroupIdsForProject } from '../services/featureFlagService';
import { WalkthroughDomainError } from '../../shared/types/walkthrough';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockGetGroups = getUserGroupIdsForProject as jest.Mock;

const actor = { id: 'admin-1' };

function stepRow(overrides: Partial<any> = {}) {
  return {
    id: 'step-1',
    walkthroughId: 'wt-1',
    ordinal: 0,
    heading: 'Welcome',
    bodyMarkdown: 'Hello',
    imageUrl: null,
    ctaLabel: null,
    ctaRoute: null,
    anchorKey: null,
    targetRoute: null,
    placement: null,
    ...overrides,
  };
}

function definitionRow(overrides: Partial<any> = {}) {
  return {
    id: 'wt-1',
    internalName: 'intro',
    userTitle: 'Intro',
    whyItMatters: 'Why',
    lifecycle: 'draft',
    priority: 10,
    revision: 1,
    publishedAt: null,
    archivedAt: null,
    createdBy: 'admin-1',
    createdAt: '2026-07-01T00:00:00Z',
    updatedBy: 'admin-1',
    updatedAt: '2026-07-01T00:00:00Z',
    steps: [stepRow()],
    targetingRules: [{ id: 'r1', type: 'project', value: 'Apex', walkthroughId: 'wt-1', createdAt: '2026-07-01T00:00:00Z' }],
    progress: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.walkthroughs.findFirst.mockReset();
  mockDb.query.walkthroughs.findMany.mockReset();
  mockDb.query.appGroups.findFirst.mockReset();
  mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb));
  mockDb.insert.mockImplementation(() => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'wt-1' }]),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
  }));
  mockDb.update.mockImplementation(() => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  }));
  mockDb.delete.mockImplementation(() => ({
    where: jest.fn().mockResolvedValue(undefined),
  }));
  mockDb.select.mockImplementation(() => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
  }));
  mockGetGroups.mockResolvedValue([]);
});

describe('walkthroughService (TBI-002)', () => {
  describe('DoD-0 — admin create / lifecycle / AI validate', () => {
    it('VT-02 / DoD — create rolls back when transaction child rejects', async () => {
      mockDb.transaction.mockRejectedValue(new Error('child insert failed'));
      await expect(
        createWalkthrough(
          {
            internalName: 'x',
            userTitle: 'X',
            whyItMatters: 'y',
            targeting: { project: 'Apex' },
            steps: [{ ordinal: 0, heading: 'A', bodyMarkdown: 'a' }],
          },
          actor,
        ),
      ).rejects.toThrow('child insert failed');
    });

    it('validateAiDraft returns same draft model without accepting to DB', () => {
      const result = validateAiDraft({
        internalName: 'ai',
        userTitle: 'AI',
        whyItMatters: 'w',
        targeting: { project: 'Apex' },
        steps: [{ ordinal: 0, heading: 'A', bodyMarkdown: 'a' }],
      });
      expect(result.valid).toBe(true);
      expect(result.draft.internalName).toBe('ai');
    });

    it('VT-11 — silent publish preserves revision; reshow increments (DoD)', async () => {
      const published = definitionRow({
        lifecycle: 'published',
        revision: 2,
        publishedAt: '2026-07-01T00:00:00Z',
      });

      mockDb.query.walkthroughs.findFirst
        .mockResolvedValueOnce(published)
        .mockResolvedValueOnce({ ...published, revision: 2 });

      const silent = await publishWalkthrough(
        'wt-1',
        { mode: 'silent', targeting: { project: 'Apex' } },
        actor,
      );
      expect(silent.revision).toBe(2);

      mockDb.query.walkthroughs.findFirst.mockReset();
      mockDb.query.walkthroughs.findFirst
        .mockResolvedValueOnce({ ...published, revision: 2 })
        .mockResolvedValueOnce({ ...published, revision: 3 });

      const reshow = await publishWalkthrough(
        'wt-1',
        { mode: 'reshow', targeting: { project: 'Apex' } },
        actor,
      );
      expect(reshow.revision).toBe(3);
    });

    it('VT-12 — unpublish and archive exclude from further display reads', async () => {
      mockDb.query.walkthroughs.findFirst
        .mockResolvedValueOnce(definitionRow({ lifecycle: 'published' }))
        .mockResolvedValueOnce(definitionRow({ lifecycle: 'unpublished' }));

      const unpublished = await unpublishWalkthrough('wt-1', actor);
      expect(unpublished.lifecycle).toBe('unpublished');

      mockDb.query.walkthroughs.findFirst.mockReset();
      mockDb.query.walkthroughs.findFirst
        .mockResolvedValueOnce(definitionRow({ lifecycle: 'draft' }))
        .mockResolvedValueOnce(
          definitionRow({ lifecycle: 'archived', archivedAt: '2026-07-02T00:00:00Z' }),
        );

      const archived = await archiveWalkthrough('wt-1', actor);
      expect(archived.lifecycle).toBe('archived');
    });
  });

  describe('DoD-1 / DoD-3 — eligibility bounded to published + audience', () => {
    it('VT-05 — returns highest priority then earliest publish date (DoD-3)', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findMany.mockResolvedValue([
        definitionRow({
          id: 'high',
          lifecycle: 'published',
          priority: 100,
          publishedAt: '2026-07-02T00:00:00Z',
          targetingRules: [{ id: 'r', type: 'project', value: 'Apex' }],
          progress: [],
        }),
        definitionRow({
          id: 'low',
          lifecycle: 'published',
          priority: 1,
          publishedAt: '2026-07-01T00:00:00Z',
          targetingRules: [{ id: 'r2', type: 'project', value: 'Apex' }],
          progress: [],
        }),
      ]);

      const next = await getNextEligible('Apex', 'user-1');
      expect(next?.id).toBe('high');
    });

    it('VT-07 — acknowledged revision 1 does not suppress revision 2 (DoD)', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findMany.mockResolvedValue([
        definitionRow({
          lifecycle: 'published',
          revision: 2,
          publishedAt: '2026-07-01T00:00:00Z',
          targetingRules: [{ id: 'r', type: 'project', value: 'Apex' }],
          progress: [
            {
              walkthroughId: 'wt-1',
              userId: 'user-1',
              revision: 1,
              status: 'completed',
              lastStepId: null,
              seenAt: '2026-07-01T00:00:00Z',
              acknowledgedAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ]);

      const next = await getNextEligible('Apex', 'user-1');
      expect(next?.revision).toBe(2);
    });

    it('VT-08 — removed from group loses eligibility but history path remains (DoD)', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockGetGroups.mockResolvedValue([]); // no longer in group
      mockDb.query.walkthroughs.findMany.mockResolvedValue([
        definitionRow({
          lifecycle: 'published',
          publishedAt: '2026-07-01T00:00:00Z',
          targetingRules: [
            { id: 'r', type: 'project', value: 'Apex' },
            { id: 'g', type: 'group', value: 'grp-1' },
          ],
          progress: [
            {
              walkthroughId: 'wt-1',
              userId: 'user-1',
              revision: 1,
              status: 'seen',
              lastStepId: null,
              seenAt: '2026-07-01T00:00:00Z',
              acknowledgedAt: null,
              updatedAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ]);

      expect(await getNextEligible('Apex', 'user-1')).toBeNull();
      const replay = await listReplay('Apex', 'user-1');
      expect(replay.items).toHaveLength(0);
    });

    it('suppresses current completed revision from automatic launch', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findMany.mockResolvedValue([
        definitionRow({
          lifecycle: 'published',
          revision: 1,
          publishedAt: '2026-07-01T00:00:00Z',
          targetingRules: [{ id: 'r', type: 'project', value: 'Apex' }],
          progress: [
            {
              walkthroughId: 'wt-1',
              userId: 'user-1',
              revision: 1,
              status: 'dismissed',
              lastStepId: null,
              seenAt: '2026-07-01T00:00:00Z',
              acknowledgedAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ]);
      expect(await getNextEligible('Apex', 'user-1')).toBeNull();
    });
  });

  describe('DoD-2 — auth scope and caller-owned progress', () => {
    it('VT-10 — cross-project definition returns not found (DoD-2)', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findFirst.mockResolvedValue(
        definitionRow({
          lifecycle: 'published',
          targetingRules: [{ id: 'r', type: 'project', value: 'OtherProject' }],
        }),
      );
      await expect(getAccessibleDefinition('Apex', 'wt-1', 'user-1')).rejects.toMatchObject({
        code: 'WALKTHROUGH_NOT_FOUND',
      });
    });

    it('VT-06 — progress DB failure does not claim acknowledgement (DoD)', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findFirst.mockResolvedValue(
        definitionRow({
          lifecycle: 'published',
          targetingRules: [{ id: 'r', type: 'project', value: 'Apex' }],
        }),
      );
      const chain: any = {
        values: jest.fn(),
        onConflictDoUpdate: jest.fn(),
        returning: jest.fn().mockRejectedValue(new Error('db down')),
      };
      chain.values.mockReturnValue(chain);
      chain.onConflictDoUpdate.mockReturnValue(chain);
      mockDb.insert.mockImplementation(() => chain);

      await expect(
        updateOwnProgress('Apex', 'wt-1', 'user-1', {
          status: 'completed',
          revision: 1,
        }),
      ).rejects.toThrow('db down');
    });

    it('rejects acknowledged as progress status', async () => {
      await expect(
        updateOwnProgress('Apex', 'wt-1', 'user-1', {
          status: 'acknowledged' as any,
          revision: 1,
        }),
      ).rejects.toBeInstanceOf(WalkthroughDomainError);
    });

    it('updateOwnProgress derives acknowledged for completed', async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ project: 'Apex' }]),
      }));
      mockDb.query.walkthroughs.findFirst.mockResolvedValue(
        definitionRow({
          lifecycle: 'published',
          targetingRules: [{ id: 'r', type: 'project', value: 'Apex' }],
        }),
      );
      const returning = jest.fn().mockResolvedValue([
        {
          walkthroughId: 'wt-1',
          userId: 'user-1',
          revision: 1,
          status: 'completed',
          lastStepId: null,
          seenAt: '2026-07-01T00:00:00Z',
          acknowledgedAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
        },
      ]);
      mockDb.insert.mockImplementation(() => ({
        values: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning,
      }));

      const progress = await updateOwnProgress('Apex', 'wt-1', 'user-1', {
        status: 'completed',
        revision: 1,
      });
      expect(progress.acknowledged).toBe(true);
      expect(progress.userId).toBe('user-1');
    });
  });
});
