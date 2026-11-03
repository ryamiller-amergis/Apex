/**
 * PRD lineage hook — TBI-006 VT-08, VT-09, VT-10.
 */

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: jest.fn() },
      chatThreads: { findFirst: jest.fn() },
      interviews: { findFirst: jest.fn() },
      testCases: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    select: jest.fn(),
    execute: jest.fn(),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn(),
  readOutputBacklog: jest.fn(),
  sendMessage: jest.fn(),
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
  isThreadIdle: jest.fn(),
  hydrateThread: jest.fn(),
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

import { getPrdEvaluationInputs } from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const documentApproval = jest.requireMock('../services/documentApprovalService') as Record<string, jest.Mock>;
const ownerApproval = jest.requireMock('../services/ownerApprovalService') as Record<string, jest.Mock>;

describe('getPrdEvaluationInputs — TBI-006', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-08 / TBI-006 (a): returns skill path, model, grounded SHA, interview id and the normalized backlog', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({
      id: 'prd-1',
      project: 'proj-a',
      status: 'draft',
      interviewId: 'interview-1',
      model: 'claude',
      content: '# PRD',
      backlogJson: {
        epics: [{
          features: [{
            items: [{
              type: 'PBI',
              userStory: { persona: 'BA', want: 'a stable hash', soThat: 'events bind to the PRD' },
            }],
          }],
        }],
      },
      chatThreadId: 'thread-1',
    });
    mockDb.query.chatThreads.findFirst.mockResolvedValue({
      kickoff: { skillPath: '.cursor/skills/to-prd/SKILL.md', model: 'other-model' },
      groundedSha: 'grounded-sha',
    });

    const result = await getPrdEvaluationInputs('prd-1');

    expect(result).toMatchObject({
      id: 'prd-1',
      project: 'proj-a',
      model: 'claude',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'grounded-sha',
      interviewId: 'interview-1',
      content: '# PRD',
    });
    expect(result?.backlogJson).toMatchObject({
      epics: [{
        features: [{
          items: [{ type: 'PBI', userStory: { persona: 'BA', iWant: 'a stable hash', soThat: 'events bind to the PRD' } }],
        }],
      }],
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('VT-09 / TBI-006 (b): an unknown PRD id returns null', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(undefined);
    await expect(getPrdEvaluationInputs('missing')).resolves.toBeNull();
  });

  it('VT-10 / TBI-006 (d): the hook writes nothing, skips approval services, and ignores extra lineage input', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({
      id: 'prd-1',
      project: 'proj-a',
      status: 'generating',
      interviewId: null,
      model: null,
      content: '',
      backlogJson: null,
      chatThreadId: null,
    });

    const result = await (getPrdEvaluationInputs as (id: string, extra?: unknown) => Promise<unknown>)(
      'prd-1',
      { artifactHash: 'forged', skillVersion: 'forged' },
    );

    expect(result).toMatchObject({ skillVersion: null, content: '', backlogJson: null });
    expect(mockDb.query.chatThreads.findFirst).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    for (const fn of Object.values(documentApproval)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(ownerApproval)) expect(fn).not.toHaveBeenCalled();
  });
});
