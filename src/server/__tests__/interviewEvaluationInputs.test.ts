/**
 * Lineage hooks — TBI-006 VT-07, VT-09, VT-10.
 */

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

jest.mock('../services/artifactDoneEventService', () => ({
  recordArtifactDoneEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isPlatformAdmin: jest.fn().mockResolvedValue(false),
  isProjectAdmin: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/rbacService', () => ({
  getActiveUsers: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillSettingsName: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/runGroundingService', () => ({
  runGroundingService: { getGroundings: jest.fn() },
}));

jest.mock('../services/chatAgentService', () => ({
  markAsInterviewThread: jest.fn(),
  cancelRun: jest.fn().mockResolvedValue(undefined),
  getThreadAsync: jest.fn(),
}));

jest.mock('../services/interviewLinkService', () => ({
  listLinkedContextIds: jest.fn(),
}));

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn(),
  recordApproverResponse: jest.fn(),
  isAssignedApprover: jest.fn(),
  isApprovalComplete: jest.fn(),
  notifyApproversDocumentReady: jest.fn(),
}));

jest.mock('../services/ownerApprovalService', () => ({
  submitOwnerDecision: jest.fn(),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    select: jest.fn(),
  },
}));

import { getInterviewEvaluationInputs } from '../services/interviewService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { getThreadAsync } = jest.requireMock('../services/chatAgentService') as { getThreadAsync: jest.Mock };
const { listLinkedContextIds } = jest.requireMock('../services/interviewLinkService') as {
  listLinkedContextIds: jest.Mock;
};
const documentApproval = jest.requireMock('../services/documentApprovalService') as Record<string, jest.Mock>;
const ownerApproval = jest.requireMock('../services/ownerApprovalService') as Record<string, jest.Mock>;

describe('getInterviewEvaluationInputs — TBI-006', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listLinkedContextIds.mockResolvedValue({ adrIds: ['adr-1'], designModuleIds: [] });
  });

  it('VT-07 / TBI-006 (c): a non-guided interview uses the whole visible transcript as phase 1', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'interview-1',
      project: 'proj-a',
      model: 'claude',
      chatThreadId: 'thread-1',
    });
    getThreadAsync.mockResolvedValue({
      kickoff: { skillPath: '.cursor/skills/grill-design/SKILL.md', model: 'kickoff-model' },
      groundedSha: 'repo-commit',
      skillSha256: 'sha-1',
      messages: [
        { id: '1', role: 'user', text: 'Hello', ts: 't1' },
        { id: '2', role: 'agent', text: 'Hi', ts: 't2', hidden: true },
        { id: '3', role: 'tool', text: 'lookup', ts: 't3' },
        { id: '4', role: 'agent', text: 'Visible reply', ts: 't4' },
      ],
    });

    const result = await getInterviewEvaluationInputs('interview-1');

    expect(result).toMatchObject({
      id: 'interview-1',
      phaseCount: 1,
      currentPhase: 1,
      skillVersion: 'sha-1',
      model: 'claude',
    });
    expect(result?.phases).toEqual([{
      phaseIndex: 1,
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'agent', text: 'Visible reply' },
      ],
    }]);
  });

  it('VT-09 / TBI-006 (b): an unknown interview id returns null', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(undefined);
    await expect(getInterviewEvaluationInputs('missing')).resolves.toBeNull();
  });

  it('VT-10 / TBI-006 (d): the hook writes nothing and ignores caller lineage', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      id: 'interview-1',
      project: 'proj-a',
      model: null,
      chatThreadId: 'thread-1',
    });
    getThreadAsync.mockResolvedValue({
      kickoff: { skillPath: '.cursor/skills/grill-with-docs/SKILL.md' },
      skillSha256: 'real-sha',
      messages: [
        { id: '1', role: 'agent', text: 'Start [[interview-phase:discovery:1:6]]', ts: 't1' },
        { id: '2', role: 'user', text: 'The problem.', ts: 't2' },
      ],
    });

    const result = await (getInterviewEvaluationInputs as (
      id: string,
      extra?: unknown,
    ) => Promise<unknown>)('interview-1', {
      artifactHash: 'forged',
      skillVersion: 'forged',
    });

    expect(result).toMatchObject({ skillVersion: 'real-sha', phaseCount: 3, currentPhase: 1 });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    for (const fn of Object.values(documentApproval)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(ownerApproval)) expect(fn).not.toHaveBeenCalled();
  });
});
