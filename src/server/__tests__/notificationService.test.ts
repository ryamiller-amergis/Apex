/**
 * Unit tests for notificationService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 * SSE connection internals (subscribe/unsubscribe/pushToUser) are tested
 * through the module's exported functions.
 */

// ── Teams bot mock ─────────────────────────────────────────────────────────────

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
}));

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    offset: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      execute: jest.fn().mockResolvedValue([]),
      query: {
        notificationPreferences: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
    },
  };
});

import {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getPreferences,
  upsertPreference,
  subscribe,
  unsubscribe,
} from '../services/notificationService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotificationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'user-action',
    title: 'Test Notification',
    body: 'Body text',
    link: '/somewhere',
    read: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePrefRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pref-1',
    userId: 'user-1',
    notificationType: 'user-action',
    enabled: true,
    toastEnabled: true,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Builds a mock select chain ending in .offset(): select → from → where → orderBy → limit → offset */
function makePagedSelectChain(rows: unknown[]) {
  const offsetMock = jest.fn().mockResolvedValue(rows);
  const limitMock = jest.fn().mockReturnValue({ offset: offsetMock });
  const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
  const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

/** Builds a mock select chain ending in .where(): select → from → where */
function makeWhereSelectChain(rows: unknown[]) {
  const whereMock = jest.fn().mockResolvedValue(rows);
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  return { from: fromMock };
}

// ── createNotification ─────────────────────────────────────────────────────────

describe('createNotification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a notification row and returns a mapped AppNotification', async () => {
    const row = makeNotificationRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    const result = await createNotification('user-1', {
      type: 'user-action',
      title: 'Test Notification',
      body: 'Body text',
      link: '/somewhere',
    });

    expect(result).toMatchObject({
      id: 'notif-1',
      userId: 'user-1',
      type: 'user-action',
      title: 'Test Notification',
      body: 'Body text',
      link: '/somewhere',
      read: false,
    });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('omits body and link when not provided', async () => {
    const row = makeNotificationRow({ body: null, link: null });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    await createNotification('user-1', { type: 'system', title: 'System Event' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: null, link: null }),
    );
  });

  it('does not push SSE when preference enabled=false', async () => {
    const row = makeNotificationRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(
      makePrefRow({ enabled: false }),
    );

    const res = { write: jest.fn() } as any;
    subscribe('user-1', res);

    await createNotification('user-1', { type: 'user-action', title: 'Test' });

    expect(res.write).not.toHaveBeenCalled();
    unsubscribe('user-1', res);
  });

  it('pushes SSE event when preference is enabled', async () => {
    const row = makeNotificationRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(
      makePrefRow({ enabled: true, toastEnabled: true }),
    );

    const res = { write: jest.fn() } as any;
    subscribe('user-1', res);

    await createNotification('user-1', { type: 'user-action', title: 'Test' });

    expect(res.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((res.write as jest.Mock).mock.calls[0][0].replace(/^data: /, '').trim());
    expect(payload).toMatchObject({ type: 'notification', toast: true });
    unsubscribe('user-1', res);
  });

  it('pushes SSE with toast=false when toastEnabled=false', async () => {
    const row = makeNotificationRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(
      makePrefRow({ enabled: true, toastEnabled: false }),
    );

    const res = { write: jest.fn() } as any;
    subscribe('user-1', res);

    await createNotification('user-1', { type: 'user-action', title: 'Test' });

    const payload = JSON.parse((res.write as jest.Mock).mock.calls[0][0].replace(/^data: /, '').trim());
    expect(payload.toast).toBe(false);
    unsubscribe('user-1', res);
  });

  it('pushes SSE with toast=true when no preference row found (defaults)', async () => {
    const row = makeNotificationRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    const res = { write: jest.fn() } as any;
    subscribe('user-1', res);

    await createNotification('user-1', { type: 'user-action', title: 'Test' });

    expect(res.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((res.write as jest.Mock).mock.calls[0][0].replace(/^data: /, '').trim());
    expect(payload.toast).toBe(true);
    unsubscribe('user-1', res);
  });
});

// ── getNotifications ───────────────────────────────────────────────────────────

describe('getNotifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped notifications for a user', async () => {
    const rows = [makeNotificationRow(), makeNotificationRow({ id: 'notif-2', title: 'Second' })];
    mockDb.select.mockReturnValue(makePagedSelectChain(rows));

    const result = await getNotifications('user-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'notif-1', type: 'user-action' });
    expect(result[1]).toMatchObject({ id: 'notif-2', title: 'Second' });
  });

  it('returns empty array when no notifications', async () => {
    mockDb.select.mockReturnValue(makePagedSelectChain([]));

    const result = await getNotifications('user-1');

    expect(result).toEqual([]);
  });

  it('passes limit and offset to the query', async () => {
    mockDb.select.mockReturnValue(makePagedSelectChain([]));

    await getNotifications('user-1', { limit: 5, offset: 10 });

    const selectChain = mockDb.select.mock.results[0].value;
    const limitCall = selectChain.from().where().orderBy().limit;
    expect(limitCall).toHaveBeenCalledWith(5);
    const offsetCall = selectChain.from().where().orderBy().limit().offset;
    expect(offsetCall).toHaveBeenCalledWith(10);
  });
});

// ── markAsRead ─────────────────────────────────────────────────────────────────

describe('markAsRead', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.update with read=true scoped to userId and notificationId', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markAsRead('user-1', 'notif-1');

    expect(setMock).toHaveBeenCalledWith({ read: true });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});

// ── markAllAsRead ──────────────────────────────────────────────────────────────

describe('markAllAsRead', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.update with read=true scoped to userId and read=false', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markAllAsRead('user-1');

    expect(setMock).toHaveBeenCalledWith({ read: true });
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});

// ── getUnreadCount ─────────────────────────────────────────────────────────────

describe('getUnreadCount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the count from the aggregate query', async () => {
    mockDb.select.mockReturnValue(makeWhereSelectChain([{ value: 7 }]));

    const count = await getUnreadCount('user-1');

    expect(count).toBe(7);
  });

  it('returns 0 when no unread notifications', async () => {
    mockDb.select.mockReturnValue(makeWhereSelectChain([{ value: 0 }]));

    const count = await getUnreadCount('user-1');

    expect(count).toBe(0);
  });

  it('returns 0 when result row is missing', async () => {
    mockDb.select.mockReturnValue(makeWhereSelectChain([]));

    const count = await getUnreadCount('user-1');

    expect(count).toBe(0);
  });
});

// ── getPreferences ─────────────────────────────────────────────────────────────

describe('getPreferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped preferences for a user', async () => {
    mockDb.select.mockReturnValue(makeWhereSelectChain([makePrefRow()]));

    const result = await getPreferences('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'pref-1',
      userId: 'user-1',
      notificationType: 'user-action',
      enabled: true,
      toastEnabled: true,
    });
  });

  it('returns empty array when no preferences exist', async () => {
    mockDb.select.mockReturnValue(makeWhereSelectChain([]));

    const result = await getPreferences('user-1');

    expect(result).toEqual([]);
  });
});

// ── upsertPreference ───────────────────────────────────────────────────────────

describe('upsertPreference', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls insert with enabled and toastEnabled when both provided', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertPreference('user-1', 'user-action', { enabled: false, toastEnabled: false });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        notificationType: 'user-action',
        enabled: false,
        toastEnabled: false,
      }),
    );
  });

  it('defaults enabled and toastEnabled to true when not provided', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertPreference('user-1', 'system', {});

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, toastEnabled: true }),
    );
  });

  it('includes only provided fields in the conflict update set', async () => {
    const onConflictMock = jest.fn().mockResolvedValue(undefined);
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertPreference('user-1', 'user-action', { enabled: false });

    const setArg = onConflictMock.mock.calls[0][0].set;
    expect(setArg.enabled).toBe(false);
    expect(setArg.toastEnabled).toBeUndefined();
  });
});

// ── subscribe / unsubscribe ────────────────────────────────────────────────────

describe('SSE connection management (subscribe / unsubscribe)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes to all subscribed connections for a user', async () => {
    const res1 = { write: jest.fn() } as any;
    const res2 = { write: jest.fn() } as any;
    subscribe('user-sse', res1);
    subscribe('user-sse', res2);

    const row = makeNotificationRow({ userId: 'user-sse' });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    await createNotification('user-sse', { type: 'system', title: 'Broadcast' });

    expect(res1.write).toHaveBeenCalledTimes(1);
    expect(res2.write).toHaveBeenCalledTimes(1);

    unsubscribe('user-sse', res1);
    unsubscribe('user-sse', res2);
  });

  it('does not push to unsubscribed connection', async () => {
    const res = { write: jest.fn() } as any;
    subscribe('user-unsub', res);
    unsubscribe('user-unsub', res);

    const row = makeNotificationRow({ userId: 'user-unsub' });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    await createNotification('user-unsub', { type: 'system', title: 'Should not receive' });

    expect(res.write).not.toHaveBeenCalled();
  });

  it('does not push to a different user', async () => {
    const res = { write: jest.fn() } as any;
    subscribe('user-other', res);

    const row = makeNotificationRow({ userId: 'user-target' });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.query.notificationPreferences.findFirst.mockResolvedValue(null);

    await createNotification('user-target', { type: 'system', title: 'Private' });

    expect(res.write).not.toHaveBeenCalled();
    unsubscribe('user-other', res);
  });
});
