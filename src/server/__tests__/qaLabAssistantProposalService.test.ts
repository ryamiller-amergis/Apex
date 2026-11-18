import { getThread } from '../services/chatAgentService';
import { loadReadySuite } from '../services/qaCaseRegenerationService';
import {
  applyCommentCase,
  applyEditCase,
  applyRegenerateCase,
  resolveToolSuite,
  QaLabAssistantThreadError,
} from '../services/qaLabAssistantService';
import {
  confirmAllProposals,
  confirmProposal,
  listProposals,
  proposeEditCase,
  proposeRegenerateCase,
} from '../services/qaLabAssistantProposalService';

interface DbState {
  proposals: Array<Record<string, unknown>>;
  openComment: Record<string, unknown> | undefined;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

jest.mock('../db/drizzle', () => {
  const state: DbState = { proposals: [], openComment: undefined, inserts: [], updates: [] };
  const db = {
    query: {
      qaLabAssistantProposals: {
        findFirst: jest.fn(async () => state.proposals[0]),
        findMany: jest.fn(async () => state.proposals),
      },
      qaCaseComments: { findFirst: jest.fn(async () => state.openComment) },
      qaAdoTestSuites: {
        findMany: jest.fn(async () => [{ id: 'suite-1', rootWorkItemId: 58977, rootTitle: 'Approval notifications', testCasesJson: null }]),
      },
    },
    insert: jest.fn(() => ({
      values(values: Record<string, unknown>) {
        state.inserts.push(values);
        return { returning: () => Promise.resolve([{ id: 'proposal-new' }]) };
      },
    })),
    update: jest.fn(() => {
      let values: Record<string, unknown> = {};
      const chain = {
        set(next: Record<string, unknown>) {
          values = next;
          state.updates.push(next);
          return chain;
        },
        where: () => chain,
        returning: () => Promise.resolve([{ ...(state.proposals[0] ?? {}), ...values }]),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      };
      return chain;
    }),
  };
  return { db, __proposalDbMock: state };
});

jest.mock('../services/qaLabAssistantService', () => ({
  QaLabAssistantThreadError: class QaLabAssistantThreadError extends Error {},
  resolveToolSuite: jest.fn(),
  prepareAddCase: jest.fn(),
  applyEditCase: jest.fn(),
  applyAddCase: jest.fn(),
  applyDeleteCase: jest.fn(),
  applyCommentCase: jest.fn(),
  applyRegenerateCase: jest.fn(),
}));

jest.mock('../services/qaCaseRegenerationService', () => ({
  QaCaseNotFoundError: class QaCaseNotFoundError extends Error {},
  loadReadySuite: jest.fn(),
}));

jest.mock('../services/chatAgentService', () => ({ getThread: jest.fn() }));
jest.mock('../services/backgroundWorkflowRouter', () => ({ routeBackgroundWorkflow: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn() }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn() }));
jest.mock('../services/agentRunReaperService', () => ({}));
jest.mock('../services/runGroundingService', () => ({ runGroundingService: {} }));
jest.mock('../services/adoFactory', () => ({ adoWriteForRequest: jest.fn(), adoWriteFromToken: jest.fn() }));
jest.mock('../services/azureDevOps', () => ({ AzureDevOpsService: jest.fn() }));

const { __proposalDbMock: dbState } = jest.requireMock('../db/drizzle') as { __proposalDbMock: DbState };

const step = (order: number, action: string) => ({ order, action, expected: `${action} done` });
const approveCase = { id: 'PBI-58989-1', title: 'Validate Approve Timesheet', steps: [step(1, 'Access Env.')] };

function suite(testCase: Record<string, unknown> = approveCase, publishedCases: unknown[] = []) {
  return {
    id: 'suite-1',
    project: 'MatterWorx',
    publishedCases,
    testCasesJson: { suites: [{ pbiId: 'PBI-58989', testCases: [testCase] }] },
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'proposal-1',
    threadId: 'thread-qa',
    suiteId: 'suite-1',
    localCaseId: 'PBI-58989-1',
    kind: 'edit',
    payload: { patch: { title: 'Validate approval email' } },
    beforeCase: approveCase,
    afterCase: { ...approveCase, title: 'Validate approval email' },
    reason: 'Title should say what is checked',
    status: 'pending',
    error: null,
    createdAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  dbState.proposals = [];
  dbState.openComment = undefined;
  dbState.inserts = [];
  dbState.updates = [];
  jest.mocked(getThread).mockResolvedValue({ id: 'thread-qa', userId: 'u1', kickoff: { qaLabSuiteId: 'suite-1' } } as never);
  jest.mocked(resolveToolSuite).mockResolvedValue({ suite: suite(), userId: 'u1' } as never);
  jest.mocked(loadReadySuite).mockResolvedValue(suite() as never);
});

describe('qaLabAssistantProposalService', () => {
  it('saves an edit as a pending proposal with the old and new case, and changes nothing', async () => {
    const receipt = await proposeEditCase({
      threadId: 'thread-qa',
      localCaseId: 'PBI-58989-1',
      patch: { id: 'renamed', title: 'Validate approval email' },
      reason: 'Title should say what is checked',
    });

    expect(receipt).toEqual(expect.objectContaining({ proposalId: 'proposal-new', status: 'pending' }));
    expect(dbState.updates[0]).toEqual(expect.objectContaining({ status: 'discarded' }));
    expect(dbState.inserts[0]).toEqual(expect.objectContaining({
      kind: 'edit',
      localCaseId: 'PBI-58989-1',
      payload: { patch: { title: 'Validate approval email' } },
      beforeCase: approveCase,
      afterCase: { ...approveCase, title: 'Validate approval email' },
      reason: 'Title should say what is checked',
    }));
    expect(applyEditCase).not.toHaveBeenCalled();
  });

  it('will not propose changes to a published case, or a regenerate with nothing to go on', async () => {
    jest.mocked(resolveToolSuite).mockResolvedValue({
      suite: suite(approveCase, [{ localCaseId: 'PBI-58989-1', adoTestCaseId: 9, adoTestCaseUrl: 'u', parentWorkItemId: 58989, publishedAt: 'now' }]),
      userId: 'u1',
    } as never);
    await expect(proposeEditCase({ threadId: 'thread-qa', localCaseId: 'PBI-58989-1', patch: { title: 'x' } }))
      .rejects.toThrow('Published cases cannot be edited');

    jest.mocked(resolveToolSuite).mockResolvedValue({ suite: suite(), userId: 'u1' } as never);
    await expect(proposeRegenerateCase({ threadId: 'thread-qa', localCaseId: 'PBI-58989-1' }))
      .rejects.toThrow('Propose a comment');
    expect(dbState.inserts).toEqual([]);
  });

  it('lists proposals with the cases in the review shape', async () => {
    dbState.proposals = [proposal()];

    const [listed] = await listProposals('thread-qa', 'u1');

    expect(listed).toEqual(expect.objectContaining({
      kind: 'edit',
      workItem: { id: 58977, title: 'Approval notifications' },
      reason: 'Title should say what is checked',
    }));
    expect(listed.before?.title).toBe('Validate Approve Timesheet');
    expect(listed.after?.title).toBe('Validate approval email');
    expect(listed.after?.steps).toEqual([{ order: 1, action: 'Access Env.', expected: 'Access Env. done' }]);
  });

  it('applies a confirmed edit when the case is as it was proposed', async () => {
    dbState.proposals = [proposal()];

    const confirmed = await confirmProposal('thread-qa', 'proposal-1', 'u1');

    expect(applyEditCase).toHaveBeenCalledWith({
      suiteId: 'suite-1',
      localCaseId: 'PBI-58989-1',
      patch: { title: 'Validate approval email' },
      userId: 'u1',
    });
    expect(dbState.updates[0]).toEqual(expect.objectContaining({ status: 'applied', decidedBy: 'u1' }));
    expect(confirmed.status).toBe('applied');
  });

  it('does not overwrite a case that changed after the proposal', async () => {
    jest.mocked(loadReadySuite).mockResolvedValue(suite({ ...approveCase, title: 'Edited by QA' }) as never);
    dbState.proposals = [proposal()];

    const confirmed = await confirmProposal('thread-qa', 'proposal-1', 'u1');

    expect(applyEditCase).not.toHaveBeenCalled();
    expect(confirmed.status).toBe('failed');
    expect(confirmed.error).toMatch(/changed after this was proposed/);
  });

  it("refuses another user's chat", async () => {
    jest.mocked(getThread).mockResolvedValue({ id: 'thread-qa', userId: 'u2', kickoff: { qaLabSuiteId: 'suite-1' } } as never);

    await expect(confirmProposal('thread-qa', 'proposal-1', 'u1')).rejects.toBeInstanceOf(QaLabAssistantThreadError);
  });

  it('confirms all in the order they were proposed, so a comment lands before its regenerate', async () => {
    const comment = proposal({ id: 'p-comment', kind: 'comment', payload: { body: 'Log in as the approver' }, afterCase: null });
    const regenerate = proposal({ id: 'p-regen', kind: 'regenerate', payload: {}, afterCase: null });
    dbState.proposals = [comment, regenerate];
    const order: string[] = [];
    jest.mocked(applyCommentCase).mockImplementation(async () => { order.push('comment'); return {} as never; });
    jest.mocked(applyRegenerateCase).mockImplementation(async () => { order.push('regenerate'); return {} as never; });

    await confirmAllProposals('thread-qa', 'u1');

    expect(order).toEqual(['comment', 'regenerate']);
    expect(applyCommentCase).toHaveBeenCalledWith(expect.objectContaining({ body: 'Log in as the approver', userId: 'u1' }));
  });
});
