jest.mock('../db/drizzle', () => {
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn(),
  };
  return {
    db: {
      query: { interviews: { findFirst: jest.fn() } },
      update: jest.fn(() => updateChain),
    },
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn(),
}));

import {
  amendRequirementsSummary,
  approvePhaseSummary,
  editPhaseSummary,
  getPhaseSummary,
} from '../services/phaseLifecycleService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { createNotification: mockCreateNotification } =
  jest.requireMock('../services/notificationService') as {
    createNotification: jest.Mock;
  };

const updateChain = mockDb.update();

const baseInterview = {
  id: 'interview-1',
  title: 'Lifecycle interview',
  phaseFlow: 'both_sequential',
  requirementsOwnerId: 'requirements-owner',
  technicalOwnerId: 'technical-owner',
  requirementsPhaseStatus: 'draft',
  technicalPhaseStatus: 'locked',
  requirementsSummary: 'Requirements content',
  technicalSummary: 'Technical content',
  requirementsApprovedAt: null,
  technicalApprovedAt: null,
  requirementsOwner: { displayName: 'Requirements Owner' },
  technicalOwner: { displayName: 'Technical Owner' },
};

describe('phaseLifecycleService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.interviews.findFirst.mockResolvedValue(baseInterview);
    updateChain.returning.mockResolvedValue([{ id: baseInterview.id }]);
    mockCreateNotification.mockResolvedValue({ id: 'notification-1' });
  });

  it('VT-01 / PBI-003 AC-0 edits a configured draft summary as its owner', async () => {
    await editPhaseSummary('interview-1', 'requirements', 'requirements-owner', 'Updated');

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
      requirementsSummary: 'Updated',
    }));
  });

  it('does not overwrite a draft that was saved before an empty-only import', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsSummary: 'Owner saved this',
    });

    await editPhaseSummary(
      'interview-1',
      'requirements',
      'requirements-owner',
      'Generated from file',
      { onlyIfEmpty: true },
    );

    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('skips an empty-only import when the draft is no longer empty at write time', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsSummary: null,
    });
    updateChain.returning.mockResolvedValue([]);

    await expect(
      editPhaseSummary(
        'interview-1',
        'requirements',
        'requirements-owner',
        'Generated from file',
        { onlyIfEmpty: true },
      ),
    ).resolves.toBeUndefined();
  });

  it('VT-02 / PBI-003 AC-1 blocks approval of whitespace-only content', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsSummary: '   ',
    });

    await expect(
      approvePhaseSummary('interview-1', 'requirements', 'requirements-owner'),
    ).rejects.toMatchObject({ status: 400 });
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('VT-03 / PBI-003 AC-2 freezes an approved summary against owner edits', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsPhaseStatus: 'approved',
    });

    await expect(
      editPhaseSummary('interview-1', 'requirements', 'requirements-owner', 'Changed'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('VT-04 / PBI-003 AC-3 rejects edits and approvals by a non-owner', async () => {
    await expect(
      editPhaseSummary('interview-1', 'requirements', 'other-user', 'Changed'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      approvePhaseSummary('interview-1', 'requirements', 'other-user'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('PBI-003 AC-0 approves atomically and unlocks Technical', async () => {
    const result = await approvePhaseSummary(
      'interview-1',
      'requirements',
      'requirements-owner',
    );

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
      requirementsPhaseStatus: 'approved',
      requirementsApprovedAt: expect.any(String),
      technicalPhaseStatus: 'draft',
    }));
    expect(result).toEqual({
      ok: true,
      unlockedTechnicalOwnerId: 'technical-owner',
      isLastConfiguredPhase: false,
    });
  });

  it('VT-05 / PBI-004 AC-0 amends approved Requirements without changing approval fields', async () => {
    const approvedAt = '2026-09-17T12:00:00.000Z';
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
      requirementsApprovedAt: approvedAt,
    });

    await amendRequirementsSummary('interview-1', 'technical-owner', 'Closed gap');

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
      requirementsSummary: 'Closed gap',
    }));
    expect(updateChain.set.mock.calls[0][0]).not.toHaveProperty('requirementsPhaseStatus');
    expect(updateChain.set.mock.calls[0][0]).not.toHaveProperty('requirementsApprovedAt');
  });

  it('VT-06 / PBI-004 AC-1 rejects amendment before Technical unlocks', async () => {
    await expect(
      amendRequirementsSummary('interview-1', 'technical-owner', 'Too soon'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('VT-07 / PBI-004 AC-2 allows same-person ownership and notifies once', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsOwnerId: 'same-owner',
      technicalOwnerId: 'same-owner',
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
    });

    await amendRequirementsSummary('interview-1', 'same-owner', 'Amended');

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'same-owner',
      expect.objectContaining({ title: 'Requirements Summary Amended' }),
    );
  });

  it('VT-08 / PBI-004 AC-3 rejects amendment by a non-Technical-owner', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
    });

    await expect(
      amendRequirementsSummary('interview-1', 'other-user', 'No access'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('VT-09 / PBI-005 AC-0 dispatches exact unlock and amendment notifications', async () => {
    await approvePhaseSummary('interview-1', 'requirements', 'requirements-owner');
    expect(mockCreateNotification).toHaveBeenCalledWith('technical-owner', {
      type: 'user-action',
      title: 'Technical Phase Unlocked',
      body: 'The Requirements summary for "Lifecycle interview" was approved. You can now start the Technical phase.',
      link: '/backlog/interview/interview-1',
    });

    jest.clearAllMocks();
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
    });
    updateChain.returning.mockResolvedValue([{ id: baseInterview.id }]);
    mockCreateNotification.mockResolvedValue({ id: 'notification-2' });

    await amendRequirementsSummary('interview-1', 'technical-owner', 'Amended');
    expect(mockCreateNotification).toHaveBeenCalledWith('requirements-owner', {
      type: 'user-action',
      title: 'Requirements Summary Amended',
      body: 'The Technical owner updated the approved Requirements summary for "Lifecycle interview".',
      link: '/backlog/interview/interview-1',
    });
  });

  it('VT-10 / PBI-005 AC-1 keeps a completed transition when notification dispatch fails', async () => {
    mockCreateNotification.mockRejectedValue(new Error('notifications unavailable'));

    await expect(
      approvePhaseSummary('interview-1', 'requirements', 'requirements-owner'),
    ).resolves.toMatchObject({ ok: true });
    expect(updateChain.returning).toHaveBeenCalled();
  });

  it('VT-11 / PBI-005 AC-2 sends exactly one unlock notification to a same-person owner', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...baseInterview,
      requirementsOwnerId: 'same-owner',
      technicalOwnerId: 'same-owner',
    });

    await approvePhaseSummary('interview-1', 'requirements', 'same-owner');

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'same-owner',
      expect.objectContaining({ title: 'Technical Phase Unlocked' }),
    );
  });

  it('TBI-002 returns correct last-phase timing for one- and two-phase flows', async () => {
    mockDb.query.interviews.findFirst
      .mockResolvedValueOnce({
        ...baseInterview,
        phaseFlow: 'requirements_only',
        technicalOwnerId: null,
        technicalPhaseStatus: null,
      })
      .mockResolvedValueOnce({
        ...baseInterview,
        phaseFlow: 'technical_only',
        requirementsOwnerId: null,
        requirementsPhaseStatus: null,
        technicalPhaseStatus: 'draft',
      });

    await expect(
      approvePhaseSummary('interview-1', 'requirements', 'requirements-owner'),
    ).resolves.toMatchObject({ isLastConfiguredPhase: true });
    await expect(
      approvePhaseSummary('interview-1', 'technical', 'technical-owner'),
    ).resolves.toMatchObject({ isLastConfiguredPhase: true });
  });

  it('TBI-002 detects a concurrent transition through a conditional update', async () => {
    updateChain.returning.mockResolvedValue([]);

    await expect(
      approvePhaseSummary('interview-1', 'requirements', 'requirements-owner'),
    ).rejects.toMatchObject({ status: 409 });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('returns null for legacy interviews and derives summary lock/amend state', async () => {
    mockDb.query.interviews.findFirst
      .mockResolvedValueOnce({ ...baseInterview, phaseFlow: null })
      .mockResolvedValueOnce({
        ...baseInterview,
        requirementsPhaseStatus: 'approved',
        technicalPhaseStatus: 'draft',
      });

    await expect(getPhaseSummary('interview-1', 'requirements')).resolves.toBeNull();
    await expect(getPhaseSummary('interview-1', 'requirements')).resolves.toMatchObject({
      locked: false,
      amendable: true,
      ownerName: 'Requirements Owner',
    });
  });
});
