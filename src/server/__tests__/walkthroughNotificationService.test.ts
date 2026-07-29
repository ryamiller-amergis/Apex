/**
 * FEAT-007 PBI-009 — walkthroughNotificationService unit tests.
 * Covers AC-0..AC-3 and VT-01/02/03/06 style contracts with mocked Drizzle + deps.
 */

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn(),
}));

jest.mock('../services/walkthroughService', () => ({
  getWalkthroughAdmin: jest.fn(),
  listLiveAudienceUserIds: jest.fn(),
  listPublishedForUserInProject: jest.fn(),
}));

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      query: {
        walkthroughNotificationDeliveries: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    },
  };
});

import {
  notifyPublishedAudience,
  reconcileForUser,
} from '../services/walkthroughNotificationService';
import { createNotification } from '../services/notificationService';
import {
  getWalkthroughAdmin,
  listLiveAudienceUserIds,
  listPublishedForUserInProject,
} from '../services/walkthroughService';
import {
  WALKTHROUGH_LIST_DEEP_LINK,
  WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE,
  walkthroughPublishDedupeKey,
} from '../../shared/types/walkthroughNotification';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockCreate = createNotification as jest.Mock;
const mockAdmin = getWalkthroughAdmin as jest.Mock;
const mockAudience = listLiveAudienceUserIds as jest.Mock;
const mockMemberships = listPublishedForUserInProject as jest.Mock;

function makeInsertReturning(rows: unknown[]) {
  const returning = jest.fn().mockResolvedValue(rows);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });
  mockDb.insert.mockReturnValue({ values });
  return { values, onConflictDoNothing, returning };
}

describe('walkthroughNotificationService (FEAT-007 PBI-009)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdmin.mockResolvedValue({
      id: 'wt-1',
      lifecycle: 'published',
      revision: 2,
      userTitle: 'Intro to Planning',
    });
    mockAudience.mockResolvedValue(['u1', 'u2']);
    mockCreate.mockImplementation(async (userId: string) => ({
      id: `n-${userId}`,
      userId,
      type: 'system',
      title: 'New walkthrough available',
      body: 'Intro to Planning',
      link: WALKTHROUGH_LIST_DEEP_LINK,
      read: false,
      createdAt: '2026-07-29T00:00:00Z',
    }));
  });

  it('contract — system type and FEAT-006 Help deep link', () => {
    expect(WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE).toBe('system');
    expect(WALKTHROUGH_LIST_DEEP_LINK).toBe('/?help=walkthroughs');
  });

  it('AC-0 — fresh publish fans out one durable system notification per live audience member with Help deep link', async () => {
    makeInsertReturning([{ id: 'd1' }]);
    // First recipient reserves; second also reserves (new insert each call)
    mockDb.insert.mockImplementation(() => {
      const returning = jest.fn().mockResolvedValue([{ id: `d-${Math.random()}` }]);
      const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
      const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });
      return { values };
    });

    const result = await notifyPublishedAudience({
      walkthroughId: 'wt-1',
      revision: 2,
      mode: 'fresh',
    });

    expect(result.targeted).toBe(2);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        type: WALKTHROUGH_PUBLISH_NOTIFICATION_TYPE,
        link: WALKTHROUGH_LIST_DEEP_LINK,
        body: 'Intro to Planning',
      }),
      expect.objectContaining({
        dedupeKey: walkthroughPublishDedupeKey('wt-1', 2, 'u1'),
      }),
    );
  });

  it('AC-0 / VT-03 — silent mode is not used by notifyPublishedAudience (caller must skip); reshow notifies', async () => {
    mockDb.insert.mockImplementation(() => {
      const returning = jest.fn().mockResolvedValue([{ id: 'd-reshow' }]);
      const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
      return { values: jest.fn().mockReturnValue({ onConflictDoNothing, returning }) };
    });

    const result = await notifyPublishedAudience({
      walkthroughId: 'wt-1',
      revision: 3,
      mode: 'reshow',
    });
    expect(result.targeted).toBe(2);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('AC-1 — per-recipient createNotification failure is isolated and publication fan-out continues', async () => {
    mockAudience.mockResolvedValue(['ok-user', 'bad-user']);
    mockDb.insert.mockImplementation(() => {
      const returning = jest.fn().mockResolvedValue([{ id: 'd-x' }]);
      const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
      return { values: jest.fn().mockReturnValue({ onConflictDoNothing, returning }) };
    });
    mockCreate.mockImplementation(async (userId: string) => {
      if (userId === 'bad-user') throw new Error('Teams/db failure');
      return {
        id: 'n-ok',
        userId,
        type: 'system',
        title: 'New walkthrough available',
        body: 'Intro to Planning',
        link: WALKTHROUGH_LIST_DEEP_LINK,
        read: false,
        createdAt: '2026-07-29T00:00:00Z',
      };
    });

    const result = await notifyPublishedAudience({
      walkthroughId: 'wt-1',
      revision: 2,
      mode: 'fresh',
    });

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.targeted).toBe(2);
  });

  it('AC-2 — reconcileForUser creates one notification for newly included memberships', async () => {
    mockMemberships.mockResolvedValue([
      { id: 'wt-1', revision: 2, userTitle: 'Intro to Planning' },
    ]);
    mockDb.insert.mockImplementation(() => {
      const returning = jest.fn().mockResolvedValue([{ id: 'd-new' }]);
      const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
      return { values: jest.fn().mockReturnValue({ onConflictDoNothing, returning }) };
    });

    const result = await reconcileForUser('new-user', 'Apex');
    expect(result.created).toBe(1);
    expect(mockCreate).toHaveBeenCalledWith(
      'new-user',
      expect.objectContaining({ link: WALKTHROUGH_LIST_DEEP_LINK }),
      expect.objectContaining({
        dedupeKey: walkthroughPublishDedupeKey('wt-1', 2, 'new-user'),
      }),
    );
  });

  it('AC-3 / VT-02 — duplicate delivery reservation skips createNotification', async () => {
    mockAudience.mockResolvedValue(['u1']);
    // Insert conflict → no returning row; existing delivery already delivered
    const returning = jest.fn().mockResolvedValue([]);
    const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({ onConflictDoNothing, returning }),
    });
    mockDb.query.walkthroughNotificationDeliveries.findFirst.mockResolvedValue({
      id: 'd-existing',
      attemptState: 'delivered',
    });

    const result = await notifyPublishedAudience({
      walkthroughId: 'wt-1',
      revision: 2,
      mode: 'fresh',
    });

    expect(result.skippedDuplicate).toBe(1);
    expect(result.created).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('AC-3 — removed users are not in listLiveAudienceUserIds so they are not notified', async () => {
    mockAudience.mockResolvedValue([]); // audience already excludes removed user
    const result = await notifyPublishedAudience({
      walkthroughId: 'wt-1',
      revision: 2,
      mode: 'fresh',
    });
    expect(result.targeted).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
