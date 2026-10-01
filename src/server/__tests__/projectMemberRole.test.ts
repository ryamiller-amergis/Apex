jest.mock('../db/drizzle', () => ({
  db: { query: { appRoles: { findFirst: jest.fn() } } },
}));

jest.mock('../services/rbacService', () => ({
  getUserProjectRoles: jest.fn(),
  assignProjectRole: jest.fn(),
}));

import { db } from '../db/drizzle';
import { ensureProjectMemberRole } from '../services/projectMemberRole';
import { assignProjectRole, getUserProjectRoles } from '../services/rbacService';

describe('ensureProjectMemberRole', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing when the person already has a project role', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue(['admin']);

    await ensureProjectMemberRole('user-1', 'Benefits Tracker', 'admin-1');

    expect(assignProjectRole).not.toHaveBeenCalled();
  });

  it('assigns the member role when the person has none', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue([]);
    (db.query.appRoles.findFirst as jest.Mock).mockResolvedValue({ id: 'role-member', name: 'member' });

    await ensureProjectMemberRole('user-1', 'Benefits Tracker', 'admin-1');

    expect(assignProjectRole).toHaveBeenCalledWith('user-1', 'Benefits Tracker', 'role-member', 'admin-1');
  });

  it('fails when the member role row is missing', async () => {
    (getUserProjectRoles as jest.Mock).mockResolvedValue([]);
    (db.query.appRoles.findFirst as jest.Mock).mockResolvedValue(undefined);

    await expect(ensureProjectMemberRole('user-1', 'Benefits Tracker', 'admin-1'))
      .rejects.toMatchObject({ status: 500, code: 'MEMBER_ROLE_MISSING' });
  });
});
