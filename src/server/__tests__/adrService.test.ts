jest.mock('../db/drizzle', () => {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return {
    db: {
      query: {
        adrs: {
          findFirst: jest.fn(),
        },
      },
      update: jest.fn().mockReturnValue({ set }),
      _set: set,
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  markAsInterviewThread: jest.fn(),
  readOutputAdr: jest.fn(),
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

import { updateAdrStatus } from '../services/adrService';
import { isApprovalComplete } from '../services/documentApprovalService';
import { getUnresolvedCount } from '../services/reviewCommentService';
import { recordOwnerApproval } from '../services/ownerApprovalService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as {
  db: {
    query: { adrs: { findFirst: jest.Mock } };
    update: jest.Mock;
    _set: jest.Mock;
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
