/**
 * Unit tests for apiKeyExpiryNotificationService fan-out + deep link.
 */
import { runApiKeyExpiryNotifications } from '../services/apiKeyExpiryNotificationService';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
  },
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'n1' }),
}));

jest.mock('../services/rbacService', () => ({
  listUsersForProject: jest.fn(),
  getUserPermissions: jest.fn(),
}));

import { db } from '../db/drizzle';
import { createNotification } from '../services/notificationService';
import { getUserPermissions, listUsersForProject } from '../services/rbacService';

const mockSelect = db.select as jest.Mock;
const mockCreateNotification = createNotification as jest.MockedFunction<typeof createNotification>;
const mockListUsers = listUsersForProject as jest.MockedFunction<typeof listUsersForProject>;
const mockGetPerms = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;

function chainSelect(rows: unknown[]) {
  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runApiKeyExpiryNotifications', () => {
  const now = new Date('2026-08-11T12:00:00.000Z');

  it('notifies project admins with api-keys:manage and deep-links to API Keys', async () => {
    chainSelect([
      {
        id: 'key-1',
        name: 'CI Bot',
        projectId: 'Apex',
        expiresAt: '2026-08-18T12:00:00.000Z', // 7 days
      },
    ]);
    mockListUsers.mockResolvedValue([
      { oid: 'admin-1', displayName: 'Admin', email: 'a@x', lastSeenAt: '', roles: ['admin'] },
      { oid: 'member-1', displayName: 'Member', email: 'm@x', lastSeenAt: '', roles: ['member'] },
    ]);
    mockGetPerms.mockImplementation(async (userId: string) => {
      if (userId === 'admin-1') return new Set(['api-keys:manage']);
      return new Set(['home:view']);
    });

    const result = await runApiKeyExpiryNotifications(now);

    expect(result.keysScanned).toBe(1);
    // 7 days remaining → thresholds 30 + 7
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        type: 'system',
        link: '/admin/api-keys?project=Apex',
        title: expect.stringContaining('7 days'),
      }),
      { dedupeKey: 'api-key-expiry:key-1:7d:admin-1' },
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        link: '/admin/api-keys?project=Apex',
        title: expect.stringContaining('30 days'),
      }),
      { dedupeKey: 'api-key-expiry:key-1:30d:admin-1' },
    );
    expect(mockCreateNotification.mock.calls.every((c) => c[0] === 'admin-1')).toBe(true);
  });

  it('skips projects with no api-keys:manage recipients', async () => {
    chainSelect([
      {
        id: 'key-2',
        name: 'Orphan',
        projectId: 'Lonely',
        expiresAt: '2026-08-12T12:00:00.000Z',
      },
    ]);
    mockListUsers.mockResolvedValue([]);

    const result = await runApiKeyExpiryNotifications(now);
    expect(result.notificationsAttempted).toBe(0);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
