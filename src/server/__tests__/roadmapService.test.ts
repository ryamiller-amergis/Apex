jest.mock('../services/featureRequestService', () => ({
  createFeatureRequest: jest.fn(),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      roadmapProjectSettings: { findFirst: jest.fn() },
      roadmapPlanOverlays: { findFirst: jest.fn() },
      roadmapAdhocIdeas: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  },
}));

import {
  calculateDateDeltaDays,
  createRoadmapIdea,
  deleteRoadmapIdea,
  getRoadmapWorkspace,
  promoteRoadmapIdea,
  updateRoadmapIdea,
  updateRoadmapSettings,
  upsertRoadmapOverlay,
} from '../services/roadmapService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: {
      roadmapProjectSettings: { findFirst: jest.Mock };
      roadmapPlanOverlays: { findFirst: jest.Mock };
      roadmapAdhocIdeas: { findFirst: jest.Mock };
    };
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };
};

const featureRequestService = jest.requireMock(
  '../services/featureRequestService',
) as {
  createFeatureRequest: jest.Mock;
};

const ACTOR = { actorId: 'user-po-1', actorName: 'Taylor PO' };
const IDEA_ID = '11111111-1111-4111-8111-111111111111';

function makeOverlayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    project: 'MaxView',
    workItemId: 401,
    workItemType: 'Epic',
    horizon: 'now',
    plannedStartDate: '2026-11-15',
    plannedTargetDate: '2026-12-01',
    baselineTargetDate: '2026-12-01',
    confidence: 'high',
    notes: 'Core claims triage epic',
    sortOrder: 0,
    updatedBy: ACTOR.actorId,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

function makeIdeaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: IDEA_ID,
    project: 'MaxView',
    title: 'Prior Auth Auto-Triage',
    ownerLabel: 'Sarah BA',
    horizon: 'next',
    effortSize: 'L',
    confidence: 'medium',
    releaseLabel: 'Q1 Claims',
    notes: 'Automate payer attachments routing',
    plannedStartDate: '2026-12-01',
    plannedTargetDate: '2026-12-20',
    baselineTargetDate: '2026-12-20',
    promotedFeatureRequestId: null,
    promotedAdoWorkItemId: null,
    promotedAt: null,
    archived: false,
    sortOrder: 0,
    createdBy: ACTOR.actorId,
    updatedBy: ACTOR.actorId,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    project: 'MaxView',
    workItemId: 401,
    adhocIdeaId: null,
    itemTitle: 'Claims Portal Modernization',
    itemOrigin: 'ado',
    eventKind: 'baseline_locked',
    fromHorizon: null,
    toHorizon: 'now',
    oldTargetDate: null,
    newTargetDate: '2026-12-01',
    deltaDays: 0,
    reason: 'Initial Baseline',
    note: null,
    syncedToAdo: false,
    actorId: ACTOR.actorId,
    actorName: ACTOR.actorName,
    createdAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('roadmapService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (callback: (tx: typeof mockDb) => Promise<unknown>) =>
        callback(mockDb),
    );
  });

  describe('calculateDateDeltaDays', () => {
    it('computes positive and negative calendar day deltas accurately', () => {
      expect(calculateDateDeltaDays('2026-12-01', '2026-12-15')).toBe(14);
      expect(calculateDateDeltaDays('2026-12-15', '2026-12-08')).toBe(-7);
      expect(calculateDateDeltaDays('2026-12-01', '2026-12-01')).toBe(0);
      expect(calculateDateDeltaDays(null, '2026-12-01')).toBeNull();
    });
  });

  describe('getRoadmapWorkspace & updateRoadmapSettings', () => {
    it('returns default settings when no row exists plus overlays, ideas, and events', async () => {
      mockDb.query.roadmapProjectSettings.findFirst.mockResolvedValue(null);

      mockDb.select
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([makeOverlayRow()]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([makeIdeaRow()]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([makeEventRow()]),
              }),
            }),
          }),
        });

      const workspace = await getRoadmapWorkspace('MaxView');
      expect(workspace.settings.syncDatesToAdo).toBe(false);
      expect(workspace.overlays).toHaveLength(1);
      expect(workspace.ideas).toHaveLength(1);
      expect(workspace.events).toHaveLength(1);
    });

    it('upserts syncDatesToAdo setting cleanly', async () => {
      const returning = jest.fn().mockResolvedValue([
        {
          project: 'MaxView',
          syncDatesToAdo: true,
          updatedBy: ACTOR.actorId,
          updatedAt: '2026-11-13T11:00:00.000Z',
        },
      ]);
      const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
      const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
      mockDb.insert.mockReturnValue({ values });

      const updated = await updateRoadmapSettings(
        'MaxView',
        { syncDatesToAdo: true },
        ACTOR.actorId,
      );
      expect(updated.syncDatesToAdo).toBe(true);
    });
  });

  describe('upsertRoadmapOverlay', () => {
    it('auto-locks baseline_target_date on first plannedTargetDate and logs horizon_changed + baseline_locked', async () => {
      mockDb.query.roadmapPlanOverlays.findFirst.mockResolvedValue(null);
      mockDb.query.roadmapProjectSettings.findFirst.mockResolvedValue(null);

      const upsertedRow = makeOverlayRow({
        plannedTargetDate: '2026-12-01',
        baselineTargetDate: '2026-12-01',
      });
      const horizonEvent = makeEventRow({
        eventKind: 'horizon_changed',
        fromHorizon: null,
        toHorizon: 'now',
        reason: 'Initial Baseline',
      });
      const baselineEvent = makeEventRow({
        eventKind: 'baseline_locked',
        newTargetDate: '2026-12-01',
        deltaDays: 0,
        reason: 'Initial Baseline',
      });

      const overlayReturning = jest.fn().mockResolvedValue([upsertedRow]);
      const overlayConflict = jest
        .fn()
        .mockReturnValue({ returning: overlayReturning });
      const overlayValues = jest
        .fn()
        .mockReturnValue({ onConflictDoUpdate: overlayConflict });

      const event1Values = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([horizonEvent]),
      });
      const event2Values = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([baselineEvent]),
      });

      mockDb.insert
        .mockReturnValueOnce({ values: overlayValues })
        .mockReturnValueOnce({ values: event1Values })
        .mockReturnValueOnce({ values: event2Values });

      const res = await upsertRoadmapOverlay(
        'MaxView',
        401,
        {
          horizon: 'now',
          plannedTargetDate: '2026-12-01',
          itemTitle: 'Claims Portal Modernization',
          itemOrigin: 'ado',
          reason: 'Initial Baseline',
        },
        ACTOR,
      );

      expect(overlayValues).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineTargetDate: '2026-12-01',
          plannedTargetDate: '2026-12-01',
          horizon: 'now',
        }),
      );
      expect(res.overlay.baselineTargetDate).toBe('2026-12-01');
      expect(res.events.map((e) => e.eventKind)).toEqual([
        'horizon_changed',
        'baseline_locked',
      ]);
      expect(res.syncedToAdo).toBe(false);
    });

    it('preserves baseline when shifting target date, logs deltaDays, and triggers ADO sync when enabled', async () => {
      mockDb.query.roadmapPlanOverlays.findFirst.mockResolvedValue(
        makeOverlayRow({
          plannedTargetDate: '2026-12-01',
          baselineTargetDate: '2026-12-01',
        }),
      );
      mockDb.query.roadmapProjectSettings.findFirst.mockResolvedValue({
        project: 'MaxView',
        syncDatesToAdo: true,
        updatedBy: ACTOR.actorId,
        updatedAt: '2026-11-13T10:00:00.000Z',
      });

      const shiftedOverlay = makeOverlayRow({
        plannedTargetDate: '2026-12-15',
        baselineTargetDate: '2026-12-01',
      });
      const dateMovedEvent = makeEventRow({
        eventKind: 'date_changed',
        oldTargetDate: '2026-12-01',
        newTargetDate: '2026-12-15',
        deltaDays: 14,
        reason: 'Scope Expansion',
        note: 'Added EDI 278 rules',
        syncedToAdo: true,
      });

      const overlayValues = jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([shiftedOverlay]),
        }),
      });
      const eventValues = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([dateMovedEvent]),
      });

      mockDb.insert
        .mockReturnValueOnce({ values: overlayValues })
        .mockReturnValueOnce({ values: eventValues });

      const syncCallback = jest.fn().mockResolvedValue(undefined);

      const res = await upsertRoadmapOverlay(
        'MaxView',
        401,
        {
          plannedTargetDate: '2026-12-15',
          itemTitle: 'Claims Portal Modernization',
          itemOrigin: 'ado',
          reason: 'Scope Expansion',
          note: 'Added EDI 278 rules',
        },
        ACTOR,
        syncCallback,
      );

      expect(syncCallback).toHaveBeenCalledWith({
        workItemId: 401,
        targetDate: '2026-12-15',
        historyComment:
          'Roadmap target date updated (Scope Expansion): Added EDI 278 rules',
      });
      expect(overlayValues).toHaveBeenCalledWith(
        expect.objectContaining({
          baselineTargetDate: '2026-12-01',
          plannedTargetDate: '2026-12-15',
        }),
      );
      expect(eventValues).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: 'date_changed',
          deltaDays: 14,
          reason: 'Scope Expansion',
          syncedToAdo: true,
        }),
      );
      expect(res.syncedToAdo).toBe(true);
    });
  });

  describe('ad-hoc idea CRUD & promotion', () => {
    it('creates an ad-hoc idea, locks baseline when target date provided, and inserts idea_created event', async () => {
      const ideaRow = makeIdeaRow();
      const createdEvent = makeEventRow({
        workItemId: null,
        adhocIdeaId: IDEA_ID,
        itemTitle: ideaRow.title,
        itemOrigin: 'adhoc',
        eventKind: 'idea_created',
      });

      mockDb.insert
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([ideaRow]),
          }),
        })
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([createdEvent]),
          }),
        });

      const created = await createRoadmapIdea(
        'MaxView',
        {
          title: 'Prior Auth Auto-Triage',
          ownerLabel: 'Sarah BA',
          horizon: 'next',
          effortSize: 'L',
          confidence: 'medium',
          plannedTargetDate: '2026-12-20',
          notes: 'Automate payer attachments routing',
        },
        ACTOR,
      );

      expect(created.idea.baselineTargetDate).toBe('2026-12-20');
      expect(created.events[0].eventKind).toBe('idea_created');
    });

    it('updates an ad-hoc idea target date and records date_changed with deltaDays', async () => {
      mockDb.query.roadmapAdhocIdeas.findFirst.mockResolvedValue(makeIdeaRow());

      const updatedIdeaRow = makeIdeaRow({
        plannedTargetDate: '2027-01-03',
        baselineTargetDate: '2026-12-20',
      });
      const movedEvent = makeEventRow({
        workItemId: null,
        adhocIdeaId: IDEA_ID,
        itemOrigin: 'adhoc',
        eventKind: 'date_changed',
        oldTargetDate: '2026-12-20',
        newTargetDate: '2027-01-03',
        deltaDays: 14,
        reason: 'Dependency Delay',
      });

      mockDb.update.mockReturnValueOnce({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedIdeaRow]),
          }),
        }),
      });
      mockDb.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([movedEvent]),
        }),
      });

      const res = await updateRoadmapIdea(
        'MaxView',
        IDEA_ID,
        {
          plannedTargetDate: '2027-01-03',
          reason: 'Dependency Delay',
          note: 'Waiting on clearinghouse sandbox',
        },
        ACTOR,
      );

      expect(res.idea.plannedTargetDate).toBe('2027-01-03');
      expect(res.idea.baselineTargetDate).toBe('2026-12-20');
      expect(res.events[0].deltaDays).toBe(14);
    });

    it('promotes an ad-hoc idea to a PostgreSQL Feature Request and logs idea_promoted', async () => {
      mockDb.query.roadmapAdhocIdeas.findFirst.mockResolvedValue(makeIdeaRow());
      featureRequestService.createFeatureRequest.mockResolvedValue({
        id: '44444444-4444-4444-8444-444444444444',
        title: 'Prior Auth Auto-Triage',
      });

      const promotedIdeaRow = makeIdeaRow({
        promotedFeatureRequestId: '44444444-4444-4444-8444-444444444444',
        promotedAt: '2026-11-13T12:00:00.000Z',
      });
      const promotedEventRow = makeEventRow({
        workItemId: null,
        adhocIdeaId: IDEA_ID,
        itemOrigin: 'adhoc',
        eventKind: 'idea_promoted',
        reason: 'Promoted Idea',
      });

      mockDb.update.mockReturnValueOnce({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([promotedIdeaRow]),
          }),
        }),
      });
      mockDb.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([promotedEventRow]),
        }),
      });

      const result = await promoteRoadmapIdea(
        'MaxView',
        IDEA_ID,
        { target: 'feature-request' },
        ACTOR,
      );

      expect(featureRequestService.createFeatureRequest).toHaveBeenCalledWith(
        ACTOR.actorId,
        'MaxView',
        expect.objectContaining({
          type: 'feature',
          title: 'Prior Auth Auto-Triage',
        }),
      );
      expect(result.featureRequestId).toBe(
        '44444444-4444-4444-8444-444444444444',
      );
      expect(result.event.eventKind).toBe('idea_promoted');
    });

    it('archives an ad-hoc idea on delete', async () => {
      mockDb.query.roadmapAdhocIdeas.findFirst.mockResolvedValue(makeIdeaRow());
      const setMock = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      mockDb.update.mockReturnValueOnce({ set: setMock });

      await deleteRoadmapIdea('MaxView', IDEA_ID, ACTOR.actorId);
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ archived: true, updatedBy: ACTOR.actorId }),
      );
    });
  });
});
