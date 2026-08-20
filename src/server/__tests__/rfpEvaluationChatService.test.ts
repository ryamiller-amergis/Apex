import { askEvaluationChat } from '../services/rfpEvaluationChatService';
import { completePlainTextWithBedrock } from '../services/bedrockService';
import { actorCanViewRfp, getRequestById, RfpIntakeError } from '../services/rfpIntakeService';
import { db } from '../db/drizzle';

jest.mock('../services/bedrockService', () => ({
  completePlainTextWithBedrock: jest.fn(),
}));

jest.mock('../services/rfpIntakeService', () => {
  const actual = jest.requireActual('../services/rfpIntakeService');
  return {
    ...actual,
    getRequestById: jest.fn(),
    actorCanViewRfp: jest.fn(),
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      rfpEvaluationMessages: {
        findMany: jest.fn(),
      },
    },
    transaction: jest.fn(),
  },
}));

const mockedGet = getRequestById as jest.MockedFunction<typeof getRequestById>;
const mockedCanView = actorCanViewRfp as jest.MockedFunction<typeof actorCanViewRfp>;
const mockedBedrock = completePlainTextWithBedrock as jest.MockedFunction<typeof completePlainTextWithBedrock>;
const mockedFindMany = db.query.rfpEvaluationMessages.findMany as jest.Mock;
const mockedTx = db.transaction as jest.Mock;

const REQUEST = {
  id: 'rfp-1',
  ownerId: 'user-1',
  title: '1 on 1',
  stakeholder: 'Manager',
  request: 'Track 1:1 goals',
  problem: 'No internal tool',
  audience: 'internal',
  dataSensitivity: 'employee-pii',
  existingSolution: 'Cornerstone',
  advantage: null,
  constraints: null,
  requestType: 'new-app',
  existingSystemStack: null,
  status: 'evaluated',
  aiStatus: 'complete',
  sourceProject: 'Apex',
  currentEvaluationId: 'ev-1',
  clarificationUsed: false,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  reviewerDecision: null,
  currentEvaluation: {
    id: 'ev-1',
    rfpRequestId: 'rfp-1',
    version: 1,
    verdict: 'buy',
    confidence: 'medium',
    techVelocity: 'moderate',
    nativeBenefit: 'medium',
    audience: 'internal',
    dataLeavesTenant: false,
    priority: 'medium',
    risk: 'medium',
    deliveryApproach: 'low-code-config',
    recommendedLane: 'low-code-solution',
    recommendedTooling: ['Cornerstone'],
    hostingRecommendation: 'vendor-hosted',
    operationalOwner: 'People Operations',
    reuseOpportunity: 'Cornerstone',
    entersInterviewFlow: false,
    buildBuyRentSummary: 'Configure Cornerstone.',
    rationale: '## Call\nBuy.',
    existingOverlap: 'none',
    clarifyingQuestions: [],
    rawOutput: { verdict: 'buy' },
    committedProductBadge: false,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
};

describe('rfpEvaluationChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGet.mockResolvedValue(REQUEST as never);
    mockedCanView.mockResolvedValue(true);
    mockedFindMany.mockResolvedValue([]);
    mockedBedrock.mockResolvedValue('A standalone SDLC build is valid only if Cornerstone cannot cover AI todos.');
    mockedTx.mockImplementation(async (fn: (tx: {
      insert: (table: unknown) => { values: (row: unknown) => { returning: () => Promise<unknown[]> } };
    }) => Promise<unknown>) => {
      const rows = [
        { id: 'm-user', rfpRequestId: 'rfp-1', evaluationId: 'ev-1', authorId: 'user-1', role: 'user', body: 'Is a build valid?', createdAt: '2026-08-20T00:00:00.000Z' },
        { id: 'm-ai', rfpRequestId: 'rfp-1', evaluationId: 'ev-1', authorId: null, role: 'assistant', body: 'A standalone SDLC build is valid only if Cornerstone cannot cover AI todos.', createdAt: '2026-08-20T00:00:01.000Z' },
      ];
      let i = 0;
      return fn({
        insert: () => ({
          values: () => ({
            returning: async () => [rows[i++]],
          }),
        }),
      });
    });
  });

  it('asks Bedrock with the evaluation and stores both turns', async () => {
    const created = await askEvaluationChat('rfp-1', 'user-1', 'Is a build valid?');
    expect(mockedBedrock).toHaveBeenCalledWith(
      expect.stringContaining(':::reviewer-decision'),
      expect.objectContaining({ feature: 'rfp-intake', entityId: 'rfp-1' }),
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.role).toBe('user');
    expect(created[1]?.role).toBe('assistant');
  });

  it('rejects questions before an evaluation exists', async () => {
    mockedGet.mockResolvedValue({ ...REQUEST, currentEvaluation: null, currentEvaluationId: null } as never);
    await expect(askEvaluationChat('rfp-1', 'user-1', 'Why?')).rejects.toBeInstanceOf(RfpIntakeError);
    expect(mockedBedrock).not.toHaveBeenCalled();
  });
});
