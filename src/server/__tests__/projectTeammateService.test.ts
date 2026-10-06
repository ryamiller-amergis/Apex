jest.mock('../services/userProjectAssignmentService', () => ({
  ensureUserProjectAssignment: jest.fn(),
  getAssignmentsForProject: jest.fn(),
  listKnownApplicationUsers: jest.fn(),
}));

jest.mock('../services/pendingAssignmentService', () => ({
  addPendingAssignments: jest.fn(),
  listPendingForProject: jest.fn(),
  removePendingAssignment: jest.fn(),
}));

jest.mock('../services/projectMemberRole', () => ({
  ensureProjectMemberRole: jest.fn(),
}));

jest.mock('../db/drizzle', () => ({
  db: { select: jest.fn() },
}));

import { db } from '../db/drizzle';
import { addPendingAssignments, listPendingForProject, removePendingAssignment } from '../services/pendingAssignmentService';
import { ensureProjectMemberRole } from '../services/projectMemberRole';
import { addProjectTeammate, listProjectTeammateCandidates, PROJECT_TEAM_LIMIT } from '../services/projectTeammateService';
import { ensureUserProjectAssignment, getAssignmentsForProject, listKnownApplicationUsers } from '../services/userProjectAssignmentService';

const mockSelect = db.select as jest.Mock;

function mockUserLookup(oid: string | null) {
  const limit = jest.fn().mockResolvedValue(oid ? [{ oid }] : []);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe('projectTeammateService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAssignmentsForProject as jest.Mock).mockResolvedValue([]);
    (listPendingForProject as jest.Mock).mockResolvedValue([]);
  });

  it('assigns an existing Apex user immediately and gives them the member role', async () => {
    mockUserLookup('user-1');

    const result = await addProjectTeammate('Benefits Tracker', ' Pat@Example.com ', 'admin-1');

    expect(result).toEqual({ status: 'assigned', email: 'pat@example.com' });
    expect(ensureUserProjectAssignment).toHaveBeenCalledWith('user-1', 'Benefits Tracker', 'admin-1');
    expect(ensureProjectMemberRole).toHaveBeenCalledWith('user-1', 'Benefits Tracker', 'admin-1');
    expect(removePendingAssignment).toHaveBeenCalledWith('pat@example.com', 'Benefits Tracker');
    expect(addPendingAssignments).not.toHaveBeenCalled();
  });

  it('stores a pending email when nobody has that account yet', async () => {
    mockUserLookup(null);

    const result = await addProjectTeammate('Benefits Tracker', 'new@example.com', 'admin-1');

    expect(result).toEqual({ status: 'pending', email: 'new@example.com' });
    expect(addPendingAssignments).toHaveBeenCalledWith(
      [{ email: 'new@example.com', project: 'Benefits Tracker' }],
      'admin-1',
    );
    expect(ensureUserProjectAssignment).not.toHaveBeenCalled();
  });

  it('does not add another pending row when the project already has 50 people', async () => {
    mockUserLookup(null);
    (getAssignmentsForProject as jest.Mock).mockResolvedValue(
      Array.from({ length: PROJECT_TEAM_LIMIT }, (_, index) => ({ userId: `user-${index}` })),
    );

    await expect(addProjectTeammate('Benefits Tracker', 'new@example.com', 'admin-1'))
      .rejects.toMatchObject({ status: 409, code: 'TEAM_FULL' });
    expect(addPendingAssignments).not.toHaveBeenCalled();
  });

  it('assigns an existing Apex user even when the stored address has no dotted domain', async () => {
    mockUserLookup('qa-1');

    const result = await addProjectTeammate('To Do App', 'qa-dev@localhost', 'admin-1');

    expect(result).toEqual({ status: 'assigned', email: 'qa-dev@localhost' });
    expect(ensureUserProjectAssignment).toHaveBeenCalledWith('qa-1', 'To Do App', 'admin-1');
    expect(ensureProjectMemberRole).toHaveBeenCalledWith('qa-1', 'To Do App', 'admin-1');
    expect(addPendingAssignments).not.toHaveBeenCalled();
  });

  it('rejects a value that is not an email when nobody in Apex has it', async () => {
    mockUserLookup(null);

    await expect(addProjectTeammate('Benefits Tracker', 'not-an-email', 'admin-1'))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(ensureUserProjectAssignment).not.toHaveBeenCalled();
    expect(addPendingAssignments).not.toHaveBeenCalled();
  });

  it('lists Apex users who are not already on the project', async () => {
    (listKnownApplicationUsers as jest.Mock).mockResolvedValue([
      { userId: 'user-1', displayName: 'Pat', email: 'pat@example.com' },
      { userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' },
    ]);
    (getAssignmentsForProject as jest.Mock).mockResolvedValue([{ userId: 'user-1' }]);

    await expect(listProjectTeammateCandidates('Benefits Tracker')).resolves.toEqual([
      { userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' },
    ]);
  });
});
