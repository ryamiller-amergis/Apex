const getApproverUserIdsForProject = jest.fn();
const getAssignmentsForProject = jest.fn();

const queryResults: unknown[][] = [];

jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => queryResults.shift() ?? [],
          }),
        }),
        where: () => {
          const rows = queryResults.shift() ?? [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  },
}));

jest.mock('../services/projectSettingsService', () => ({
  getApproverUserIdsForProject: (...args: unknown[]) => getApproverUserIdsForProject(...args),
  getApprovalModeForProject: jest.fn(),
  getApproverPoolForProject: jest.fn(),
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForProject: (...args: unknown[]) => getAssignmentsForProject(...args),
}));

import { getGateDetail } from '../services/playbookGateService';

describe('getGateDetail binding display', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryResults.length = 0;
    getApproverUserIdsForProject.mockResolvedValue(['user-1']);
    getAssignmentsForProject.mockResolvedValue([{ userId: 'user-1' }]);
  });

  it('renders the stored resolved input, including leftover ${ in agent text', async () => {
    queryResults.push(
      [{
        runId: 'run-1',
        stepRunId: 'gate-1',
        stepId: 'approve-ready',
        status: 'suspended',
        expiresAt: '2026-09-25T00:00:00.000Z',
        gatePoolKey: 'design_doc',
        approvalMode: 'any',
        gateInput: { gatedStepId: 'ingest', subject: 'Review ready result', approverPool: 'design_doc' },
      }],
      [{ id: 'snapshot-1' }],
      [{
        stepType: 'ingest-artifact',
        input: {
          documentType: 'design_doc',
          documentId: 'doc-1',
          validationThreadId: 'thread-1',
          scorecard: { is_ready: true },
          reportMd: 'Keep ${HOME} in the report',
        },
      }],
      [{ userId: 'user-1', decision: null }],
    );

    const detail = await getGateDetail({
      project: 'Apex',
      runId: 'run-1',
      stepRunId: 'gate-1',
      userId: 'user-1',
    });

    expect(detail.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'documentId', value: 'doc-1' }),
      expect.objectContaining({ path: 'reportMd', value: 'Keep ${HOME} in the report' }),
    ]));
  });
});
