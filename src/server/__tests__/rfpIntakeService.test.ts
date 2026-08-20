jest.mock('../services/rfpEvaluationOrchestrationService', () => ({
  autoStartEvaluation: jest.fn().mockResolvedValue(undefined),
}));

const mockReturning = jest.fn();
const mockInsertValues = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockTxFindMany = jest.fn();
const mockTxInsertValues = jest.fn();
const mockTxInsertReturning = jest.fn();
const mockTxUpdateWhere = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      rfpRequests: { findFirst: jest.fn() },
      rfpEvaluations: { findFirst: jest.fn(), findMany: jest.fn() },
    },
    insert: jest.fn(() => ({
      values: mockInsertValues,
    })),
    update: jest.fn(() => ({
      set: mockUpdateSet,
    })),
    transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({
      query: { rfpEvaluations: { findMany: mockTxFindMany } },
      insert: jest.fn(() => ({ values: mockTxInsertValues })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: mockTxUpdateWhere })),
      })),
    })),
  },
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

import { db } from '../db/drizzle';
import { getUserPermissions } from '../services/rbacService';
import { autoStartEvaluation } from '../services/rfpEvaluationOrchestrationService';
import {
  answerClarification,
  applyReviewerDecision,
  createRequest,
  persistSuccessfulEvaluation,
  reevaluate,
  retryEvaluation,
  RfpIntakeError,
} from '../services/rfpIntakeService';
import type { ProductIntakeEvaluationOutput } from '../../shared/types/rfpIntake';

const mockedDb = db as any;
const mockedGetUserPermissions = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;
const mockedAutoStart = autoStartEvaluation as jest.MockedFunction<typeof autoStartEvaluation>;

const NOW = '2026-08-19T12:00:00.000Z';

const INTAKE = {
  title: 'Internal intake tracker',
  stakeholder: 'BA team',
  request: 'Track RFPs in Apex',
  problem: 'Intake is fragmented',
  audience: 'internal' as const,
  dataSensitivity: 'internal-only' as const,
  existingSolution: 'none known',
};

const REQUEST_ROW = {
  id: 'rfp-1',
  ownerId: 'owner-1',
  ...INTAKE,
  advantage: null,
  constraints: null,
  requestType: null,
  existingSystemStack: null,
  status: 'evaluating',
  aiStatus: 'evaluating',
  aiThreadId: null,
  sourceProject: 'Apex',
  currentEvaluationId: null,
  clarificationUsed: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_OUTPUT: ProductIntakeEvaluationOutput = {
  verdict: 'needs-clarification',
  confidence: 'low',
  techVelocity: 'stable',
  nativeBenefit: 'medium',
  audience: 'internal',
  dataLeavesTenant: false,
  priority: 'medium',
  risk: 'low',
  deliveryApproach: 'full-code',
  recommendedLane: 'none',
  recommendedTooling: [],
  hostingRecommendation: 'undecided',
  operationalOwner: 'unassigned',
  reuseOpportunity: 'none',
  entersInterviewFlow: false,
  buildBuyRentSummary: 'Need more detail on the existing system.',
  rationale: 'The request is underspecified.',
  existingOverlap: 'none',
  clarifyingQuestions: ['What system exists today?'],
};

const BUILD_OUTPUT: ProductIntakeEvaluationOutput = {
  ...VALID_OUTPUT,
  verdict: 'build',
  confidence: 'high',
  recommendedLane: 'platform-feature',
  buildBuyRentSummary: 'Build it in Apex.',
  rationale: 'Stable tech with high native benefit.',
  clarifyingQuestions: [],
};

function thenableInsert(returningRows: unknown[]) {
  mockInsertValues.mockReturnValue({
    returning: mockReturning.mockResolvedValue(returningRows),
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockImplementation(() => ({
    returning: jest.fn().mockResolvedValue([{ id: 'rfp-1' }]),
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  }));
  thenableInsert([REQUEST_ROW]);
  mockedDb.query.rfpRequests.findFirst.mockResolvedValue(REQUEST_ROW);
  mockedDb.query.rfpEvaluations.findFirst.mockResolvedValue(null);
  mockedGetUserPermissions.mockResolvedValue(new Set(['rfp-intake:manage']));
});

describe('createRequest', () => {
  it('creates an Evaluating RFP and starts evaluation asynchronously', async () => {
    const created = await createRequest('owner-1', INTAKE);

    expect(created.status).toBe('evaluating');
    expect(created.aiStatus).toBe('evaluating');
    expect(created.sourceProject).toBe('Apex');
    expect(created.ownerId).toBe('owner-1');
    expect(mockedAutoStart).toHaveBeenCalledWith('rfp-1');
  });

  it('rejects invalid intake without starting evaluation', async () => {
    await expect(createRequest('owner-1', { ...INTAKE, title: '' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(mockedAutoStart).not.toHaveBeenCalled();
  });
});

describe('persistSuccessfulEvaluation VT-02', () => {
  it('inserts the next sequential immutable version and preserves prior versions', async () => {
    mockTxFindMany.mockResolvedValue([{ version: 1 }]);
    const inserted = {
      id: 'eval-2',
      rfpRequestId: 'rfp-1',
      version: 2,
      ...BUILD_OUTPUT,
      recommendedTooling: BUILD_OUTPUT.recommendedTooling,
      clarifyingQuestions: [],
      rawOutput: BUILD_OUTPUT,
      createdAt: NOW,
    };
    mockTxInsertValues.mockReturnValue({
      returning: mockTxInsertReturning.mockResolvedValue([inserted]),
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(undefined).then(onFulfilled, onRejected);
      },
    });
    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...REQUEST_ROW,
      status: 'evaluated',
      aiStatus: 'complete',
      currentEvaluationId: 'eval-2',
    });

    const result = await persistSuccessfulEvaluation('rfp-1', BUILD_OUTPUT);

    expect(result?.version).toBe(2);
    expect(result?.id).toBe('eval-2');
    expect(result?.committedProductBadge).toBe(false);
    expect(mockTxFindMany).toHaveBeenCalled();
  });
});

describe('PBI-002 answerClarification VT-07', () => {
  it('AC-0 starts a new evaluation and records the clarification when allowance is unused', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...REQUEST_ROW,
      status: 'evaluated',
      aiStatus: 'complete',
      currentEvaluationId: 'eval-1',
      clarificationUsed: false,
    });
    mockedDb.query.rfpEvaluations.findFirst.mockResolvedValue({
      id: 'eval-1',
      rfpRequestId: 'rfp-1',
      version: 1,
      ...VALID_OUTPUT,
      rawOutput: VALID_OUTPUT,
      createdAt: NOW,
    });

    await answerClarification('rfp-1', 'owner-1', {
      request: 'Track RFPs with a dedicated queue and form',
      clarifyingAnswers: ['Salesforce today'],
    });

    expect(mockedAutoStart).toHaveBeenCalledWith('rfp-1');
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      clarificationUsed: true,
      status: 'evaluating',
      aiStatus: 'evaluating',
    }));
  });
});

describe('PBI-002 retryEvaluation VT-08', () => {
  it('AC-1 starts a technical retry without consuming the clarification allowance', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...REQUEST_ROW,
      aiStatus: 'failed',
      clarificationUsed: false,
    });

    await retryEvaluation('rfp-1', 'triage-1');

    expect(mockedGetUserPermissions).toHaveBeenCalledWith('triage-1', 'Apex');
    expect(mockedAutoStart).toHaveBeenCalledWith('rfp-1');
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      aiStatus: 'evaluating',
    }));
    expect(mockUpdateSet).not.toHaveBeenCalledWith(expect.objectContaining({
      clarificationUsed: true,
    }));
  });
});

describe('PBI-002 reevaluate VT-09', () => {
  it('AC-2 allows only rfp-intake:manage to start a subsequent re-evaluation', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...REQUEST_ROW,
      status: 'evaluated',
      aiStatus: 'complete',
      clarificationUsed: true,
      currentEvaluationId: 'eval-1',
    });

    await reevaluate('rfp-1', 'triage-1');
    expect(mockedAutoStart).toHaveBeenCalledWith('rfp-1');

    mockedGetUserPermissions.mockResolvedValue(new Set());
    await expect(reevaluate('rfp-1', 'owner-1')).rejects.toBeInstanceOf(RfpIntakeError);
    await expect(reevaluate('rfp-1', 'owner-1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('PBI-002 negative clarification VT-10', () => {
  it('AC-3 rejects a second self-service clarification before any thread or version is created', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...REQUEST_ROW,
      status: 'evaluated',
      aiStatus: 'complete',
      currentEvaluationId: 'eval-1',
      clarificationUsed: true,
    });
    mockedDb.query.rfpEvaluations.findFirst.mockResolvedValue({
      id: 'eval-1',
      rfpRequestId: 'rfp-1',
      version: 1,
      ...VALID_OUTPUT,
      rawOutput: VALID_OUTPUT,
      createdAt: NOW,
    });

    await expect(answerClarification('rfp-1', 'owner-1', { request: 'try again' }))
      .rejects.toMatchObject({ status: 403, code: 'CLARIFICATION_USED' });
    expect(mockedAutoStart).not.toHaveBeenCalled();
  });

  it('AC-3 rejects a requestor-driven re-evaluation', async () => {
    mockedGetUserPermissions.mockResolvedValue(new Set());
    await expect(reevaluate('rfp-1', 'owner-1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(mockedAutoStart).not.toHaveBeenCalled();
  });
});

describe('applyReviewerDecision', () => {
  const evaluatedRow = {
    ...REQUEST_ROW,
    status: 'evaluated',
    aiStatus: 'complete',
    currentEvaluationId: 'eval-1',
    constraints: 'Keep data in tenant',
  };

  beforeEach(() => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue(evaluatedRow);
    mockedDb.query.rfpEvaluations.findFirst.mockResolvedValue({
      id: 'eval-1',
      rfpRequestId: 'rfp-1',
      version: 1,
      ...BUILD_OUTPUT,
      verdict: 'buy',
      rawOutput: { ...BUILD_OUTPUT, verdict: 'buy' },
      createdAt: NOW,
    });
  });

  it('rejects the requestor without rfp-intake:manage', async () => {
    mockedGetUserPermissions.mockResolvedValue(new Set());
    await expect(applyReviewerDecision('rfp-1', 'owner-1', {
      verdict: 'build',
      rationale: 'Replace Cornerstone',
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockedAutoStart).not.toHaveBeenCalled();
  });

  it('records the reviewer call, appends constraints, and re-runs evaluation', async () => {
    await applyReviewerDecision('rfp-1', 'triage-1', {
      verdict: 'build',
      rationale: 'Cornerstone is unused; host a standalone app outside Apex',
      constraintsToAdd: 'No Power Platform staff. Replace Cornerstone.',
      sourceMessageIds: ['m-ai'],
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      reviewerVerdict: 'build',
      reviewerRationale: 'Cornerstone is unused; host a standalone app outside Apex',
      reviewerId: 'triage-1',
      reviewerSourceMessageIds: ['m-ai'],
      aiStatus: 'evaluating',
      status: 'evaluating',
      constraints: expect.stringContaining('[Apex reviewer decision]'),
    }));
    expect(mockedAutoStart).toHaveBeenCalledWith('rfp-1');
  });

  it('skips the re-run when reevaluate is false', async () => {
    await applyReviewerDecision('rfp-1', 'triage-1', {
      verdict: 'build',
      rationale: 'Build it as a standalone app',
      reevaluate: false,
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      reviewerVerdict: 'build',
    }));
    expect(mockUpdateSet).not.toHaveBeenCalledWith(expect.objectContaining({
      aiStatus: 'evaluating',
    }));
    expect(mockedAutoStart).not.toHaveBeenCalled();
  });
});
