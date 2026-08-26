jest.mock('../db/drizzle', () => {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const deleteFn = jest.fn().mockReturnValue({ where: deleteWhere });
  const tx = { delete: deleteFn };
  return {
    db: {
      query: {
        adrs: {
          findFirst: jest.fn(),
        },
      },
      update: jest.fn().mockReturnValue({ set }),
      delete: deleteFn,
      transaction: jest.fn(async (fn: (tx: { delete: jest.Mock }) => Promise<void>) => fn(tx)),
      _set: set,
      _deleteWhere: deleteWhere,
      _delete: deleteFn,
      _tx: tx,
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  markAsInterviewThread: jest.fn(),
  readOutputAdr: jest.fn(),
  hydrateThread: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillSettingsName: jest.fn(),
}));

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn(),
  isApprovalComplete: jest.fn(),
}));

jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn(),
}));

jest.mock('../services/ownerApprovalService', () => ({
  recordOwnerApproval: jest.fn(),
}));

jest.mock('../services/groupService', () => ({
  listGroupsWithMembers: jest.fn(),
}));

import { deleteAdr, updateAdrStatus } from '../services/adrService';
import { isApprovalComplete } from '../services/documentApprovalService';
import { getUnresolvedCount } from '../services/reviewCommentService';
import { recordOwnerApproval } from '../services/ownerApprovalService';
import {
  adrs,
  documentApproverAssignments,
  documentOwnerApprovals,
  featureRequestAdrs,
} from '../db/schema';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: { adrs: { findFirst: jest.Mock } };
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
    _set: jest.Mock;
    _deleteWhere: jest.Mock;
    _delete: jest.Mock;
  };
};

describe('updateAdrStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
      project: 'Apex',
      status: 'proposed',
      proposedContent: null,
      content: [
        '---',
        'status: Proposed',
        'slug: event-transport',
        '---',
        '',
        '# Event transport',
        '',
        '## Status',
        '',
        'Proposed',
      ].join('\n'),
    });
    (getUnresolvedCount as jest.Mock).mockResolvedValue(0);
    (isApprovalComplete as jest.Mock).mockResolvedValue({ complete: true, mode: 'all_required' });
    (recordOwnerApproval as jest.Mock).mockResolvedValue({});
  });

  it('updates both the ADR entity and frontmatter when accepted', async () => {
    await updateAdrStatus('adr-1', 'owner-1', 'accepted');

    expect(recordOwnerApproval).toHaveBeenCalledWith('adr-1', 'adr', 'owner-1', 'approved');
    expect(mockDb._set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'accepted',
      content: expect.stringContaining('status: Accepted'),
    }));
    expect(mockDb._set.mock.calls[0][0].content).not.toContain('status: Proposed');
    expect(mockDb._set.mock.calls[0][0].content).toContain('## Status\n\nAccepted');
    expect(mockDb._set.mock.calls[0][0].content).not.toContain('## Status\n\nProposed');
  });

  it('updates the rendered status in CRLF-formatted ADR content', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
      project: 'Apex',
      status: 'proposed',
      proposedContent: null,
      content: [
        '---',
        'status: Proposed',
        '---',
        '',
        '# Event transport',
        '',
        '## Status',
        '',
        'Proposed',
      ].join('\r\n'),
    });

    await updateAdrStatus('adr-1', 'owner-1', 'accepted');

    expect(mockDb._set.mock.calls[0][0].content).toContain('status: Accepted');
    expect(mockDb._set.mock.calls[0][0].content).toContain('## Status\r\n\r\nAccepted');
  });

  it('updates the frontmatter when an accepted ADR is superseded', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
      project: 'Apex',
      status: 'accepted',
      proposedContent: null,
      content: '# Event transport\n\n## Status\n\nAccepted',
    });

    await updateAdrStatus('adr-1', 'owner-1', 'superseded');

    expect(mockDb._set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'superseded',
      content: expect.stringMatching(/^---\nstatus: Superseded\n---/),
    }));
    expect(mockDb._set.mock.calls[0][0].content).toContain('## Status\n\nSuperseded');
    expect(recordOwnerApproval).not.toHaveBeenCalled();
  });
});

describe('deleteAdr', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.delete.mockReturnValue({ where: mockDb._deleteWhere });
    mockDb.transaction.mockImplementation(async (fn: (tx: { delete: jest.Mock }) => Promise<void>) =>
      fn({ delete: mockDb.delete }),
    );
  });

  it('deletes the ADR when the requesting user is the author', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
    });

    await deleteAdr('adr-1', 'owner-1');

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.delete).toHaveBeenCalledWith(adrs);
    expect(mockDb._deleteWhere).toHaveBeenCalled();
  });

  it('clears feature-request links and approval rows before deleting the ADR', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
    });

    await deleteAdr('adr-1', 'owner-1');

    expect(mockDb.delete.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      featureRequestAdrs,
      documentApproverAssignments,
      documentOwnerApprovals,
      adrs,
    ]);
    expect(mockDb._deleteWhere).toHaveBeenCalledTimes(4);
  });

  it('throws 404 when ADR does not exist', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue(null);

    await expect(deleteAdr('adr-missing', 'owner-1')).rejects.toMatchObject({
      message: 'ADR not found',
    });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.adrs.findFirst.mockResolvedValue({
      id: 'adr-1',
      authorId: 'owner-1',
    });

    await expect(deleteAdr('adr-1', 'other-user')).rejects.toMatchObject({
      message: 'Only the author can modify this ADR',
    });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
