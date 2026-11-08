/**
 * TBI-010 — build-intake edit and approve rule (VT-07).
 */
jest.mock('../utils/rbacHelpers', () => ({
  isProjectAdmin: jest.fn(),
  isPlatformAdmin: jest.fn(),
}));

import { isPlatformAdmin, isProjectAdmin } from '../utils/rbacHelpers';
import { canActOnBuildIntakeInterview, isBuildIntakeInterview } from '../services/buildIntakeAccess';

const mockIsProjectAdmin = isProjectAdmin as jest.Mock;
const mockIsPlatformAdmin = isPlatformAdmin as jest.Mock;

const interview = { authorId: 'requester', project: 'proj-a', playbookProfileKey: 'build-intake' };

beforeEach(() => {
  jest.clearAllMocks();
  mockIsProjectAdmin.mockResolvedValue(false);
  mockIsPlatformAdmin.mockResolvedValue(false);
});

describe('VT-07 — who may act on a build-intake interview (TBI-010 DoD-0, DoD-1; PBI-011 AC-3; PBI-012 AC-1)', () => {
  it('VT-07 allows the requester without any admin lookup', async () => {
    await expect(canActOnBuildIntakeInterview('requester', interview)).resolves.toBe(true);
    expect(mockIsProjectAdmin).not.toHaveBeenCalled();
  });

  it('VT-07 allows a Project Admin of the interview project', async () => {
    mockIsProjectAdmin.mockImplementation(async (_userId: string, project: string) => project === 'proj-a');
    await expect(canActOnBuildIntakeInterview('admin-a', interview)).resolves.toBe(true);
  });

  it('VT-07 allows a Platform Admin', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);
    await expect(canActOnBuildIntakeInterview('platform', interview)).resolves.toBe(true);
  });

  it('VT-07 refuses a Project Admin of another project', async () => {
    mockIsProjectAdmin.mockImplementation(async (_userId: string, project: string) => project === 'proj-b');
    await expect(canActOnBuildIntakeInterview('admin-b', interview)).resolves.toBe(false);
    expect(mockIsProjectAdmin).toHaveBeenCalledWith('admin-b', 'proj-a');
  });

  it.each(['ba-user', 'manager-user', 'po-user', 'section-owner', 'phase-assignee'])(
    'VT-07 refuses %s who is not the requester and not an admin',
    async (userId) => {
      await expect(canActOnBuildIntakeInterview(userId, interview)).resolves.toBe(false);
    },
  );

  it('VT-07 refuses when the interview has no project and the caller is not a Platform Admin', async () => {
    mockIsProjectAdmin.mockResolvedValue(true);
    await expect(canActOnBuildIntakeInterview('someone', { ...interview, project: null })).resolves.toBe(false);
  });

  it('VT-07 recognises the build-intake profile only', () => {
    expect(isBuildIntakeInterview(interview)).toBe(true);
    expect(isBuildIntakeInterview({ playbookProfileKey: 'grill-with-docs' })).toBe(false);
    expect(isBuildIntakeInterview({ playbookProfileKey: null })).toBe(false);
    expect(isBuildIntakeInterview(null)).toBe(false);
  });
});
