jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
  },
}));

import { assertEligibleHumanAssignee } from '../services/projectAssigneeService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: { select: jest.Mock };
};

function mockMembershipRows(rows: Array<{ oid: string }>) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  mockDb.select.mockReturnValue({ from });
}

describe('assertEligibleHumanAssignee', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts a user assigned to the source project', async () => {
    mockMembershipRows([{ oid: 'user-2' }]);
    await expect(
      assertEligibleHumanAssignee('Apex', 'user-2'),
    ).resolves.toBeUndefined();
  });

  it('rejects a user outside the source project', async () => {
    mockMembershipRows([]);
    await expect(
      assertEligibleHumanAssignee('Apex', 'outside-user'),
    ).rejects.toThrow('Assignee must be a member of the selected project');
  });
});
