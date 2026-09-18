jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: {
        findFirst: jest.fn(),
      },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputRequirementsPhaseSummary: jest.fn(),
}));

jest.mock('../services/phaseLifecycleService', () => ({
  editPhaseSummary: jest.fn(),
}));

import { db } from '../db/drizzle';
import { readOutputRequirementsPhaseSummary } from '../services/chatAgentService';
import { editPhaseSummary } from '../services/phaseLifecycleService';
import {
  syncAvailableRequirementsPhaseSummary,
  syncRequirementsPhaseArtifacts,
  syncRequirementsPhaseSummary,
} from '../services/requirementsPhaseSkillService';

const findInterview = db.query.interviews.findFirst as jest.Mock;
const readSummary = readOutputRequirementsPhaseSummary as jest.Mock;
const editSummary = editPhaseSummary as jest.Mock;

const interview = {
  id: 'interview-1',
  chatThreadId: 'thread-1',
  phaseFlow: 'both_sequential',
  requirementsPhaseStatus: 'draft',
  requirementsOwnerId: 'owner-1',
  requirementsSummary: null,
};

describe('requirementsPhaseSkillService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findInterview.mockResolvedValue(interview);
    readSummary.mockReturnValue('# Generated requirements');
    editSummary.mockResolvedValue(undefined);
  });

  it('persists the summary artifact after a Requirements chat turn completes', async () => {
    await expect(
      syncRequirementsPhaseArtifacts('thread-1', 'owner-1'),
    ).resolves.toBe(true);

    expect(readSummary).toHaveBeenCalledWith('thread-1');
    expect(editSummary).toHaveBeenCalledWith(
      'interview-1',
      'requirements',
      'owner-1',
      '# Generated requirements',
      { onlyIfEmpty: true },
    );
  });

  it('lets the assigned owner retry synchronization for a completed interview', async () => {
    await expect(
      syncRequirementsPhaseSummary('interview-1', 'owner-1'),
    ).resolves.toBeUndefined();
    expect(editSummary).toHaveBeenCalled();
  });

  it('imports an available artifact while building the summary read model', async () => {
    await expect(
      syncAvailableRequirementsPhaseSummary('interview-1'),
    ).resolves.toBe(true);
    expect(editSummary).toHaveBeenCalledWith(
      'interview-1',
      'requirements',
      'owner-1',
      '# Generated requirements',
      { onlyIfEmpty: true },
    );
  });

  it('reports when the phase has not produced a summary artifact', async () => {
    readSummary.mockReturnValue(null);

    await expect(
      syncRequirementsPhaseSummary('interview-1', 'owner-1'),
    ).rejects.toMatchObject({ status: 409 });
  });
});
