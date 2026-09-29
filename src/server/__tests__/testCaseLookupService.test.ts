jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
  },
}));

jest.mock('../services/testCaseService', () => ({
  getTestCases: jest.fn(),
}));

import { db } from '../db/drizzle';
import { getTestCases } from '../services/testCaseService';
import {
  findBacklogMatch,
  getTestCasesForWorkItem,
} from '../services/testCaseLookupService';

const mockSelect = db.select as unknown as jest.Mock;
const mockGetTestCases = getTestCases as jest.Mock;

/** Backlog shaped like `/to-prd` output after an ADO push stamped work item ids. */
const backlogJson = {
  epics: [
    {
      title: 'Checkout Epic',
      adoWorkItemId: 100,
      features: [
        {
          title: 'Payments',
          adoWorkItemId: 200,
          items: [
            { id: 'PBI-001', title: 'Pay by card', type: 'PBI', adoWorkItemId: 301 },
            { id: 'TBI-001', title: 'Payment gateway client', type: 'TBI', adoWorkItemId: 302 },
            { id: 'PBI-002', title: 'Pay by wallet', type: 'PBI', adoWorkItemId: 303 },
          ],
        },
        {
          title: 'Receipts',
          adoWorkItemId: 201,
          items: [
            { id: 'PBI-003', title: 'Email receipt', type: 'PBI', adoWorkItemId: 304 },
          ],
        },
      ],
    },
  ],
};

const testCasesJson = {
  suites: [
    {
      epicTitle: 'Checkout Epic',
      featureTitle: 'Payments',
      featureFlag: null,
      pbiId: 'PBI-001',
      pbiTitle: 'Pay by card',
      testCaseCount: 2,
      testCases: [
        {
          id: 'TC-PBI-001-001',
          title: 'Card payment succeeds',
          type: 'functional',
          tier: 'happy',
          priority: 'Must Have',
          persona: 'Authenticated User',
          preconditions: ['User is signed in'],
          steps: [{ order: 1, action: 'Submit a valid card', expected: 'Payment is accepted' }],
          expectedResult: 'Order is placed',
          traceability: {
            pbiId: 'PBI-001',
            acceptanceCriteriaIndex: 0,
            businessRules: ['BR-001'],
          },
          automation: { candidate: true, recommendedTier: 'e2e-playwright' },
        },
        {
          id: 'TC-PBI-001-002',
          title: 'Expired card is rejected',
          tier: 'negative',
          preconditions: [],
          steps: ['Submit an expired card'],
          traceability: { pbiId: 'PBI-001' },
        },
      ],
    },
    {
      epicTitle: 'Checkout Epic',
      featureTitle: 'Payments',
      pbiId: 'PBI-002',
      pbiTitle: 'Pay by wallet',
      testCases: [
        {
          id: 'TC-PBI-002-001',
          title: 'Wallet payment succeeds',
          preconditions: [],
          steps: [{ order: 1, action: 'Pay with wallet', expected: 'Accepted' }],
          traceability: { pbiId: 'PBI-002' },
        },
      ],
    },
    {
      epicTitle: 'Checkout Epic',
      featureTitle: 'Receipts',
      pbiId: 'PBI-003',
      pbiTitle: 'Email receipt',
      testCases: [
        {
          id: 'TC-PBI-003-001',
          title: 'Receipt is emailed',
          preconditions: [],
          steps: [{ order: 1, action: 'Complete an order', expected: 'Email arrives' }],
          traceability: { pbiId: 'PBI-003' },
        },
      ],
    },
  ],
};

function stubPrdRows(rows: unknown[]): void {
  mockSelect.mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(rows),
    }),
  });
}

const prdRow = {
  id: 'prd-1',
  title: 'Checkout PRD',
  status: 'approved',
  backlogJson,
  updatedAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  stubPrdRows([prdRow]);
  mockGetTestCases.mockResolvedValue({
    id: 'tc-1',
    status: 'ready',
    testCasesJson,
    coverageSummary: {
      totalCases: 4,
      pbisCovered: 3,
      acCovered: '3/3',
      brCovered: '1/1',
      gaps: 0,
    },
    updatedAt: '2026-09-02T00:00:00.000Z',
  });
});

describe('findBacklogMatch', () => {
  it('matches a PBI and returns only its own id', () => {
    expect(findBacklogMatch(backlogJson, 301)).toEqual({
      level: 'pbi',
      title: 'Pay by card',
      pbiIds: ['PBI-001'],
    });
  });

  it('matches a Feature and rolls up every PBI beneath it', () => {
    expect(findBacklogMatch(backlogJson, 200)).toEqual({
      level: 'feature',
      title: 'Payments',
      pbiIds: ['PBI-001', 'PBI-002'],
    });
  });

  it('matches an Epic and rolls up PBIs across all its features', () => {
    expect(findBacklogMatch(backlogJson, 100)).toEqual({
      level: 'epic',
      title: 'Checkout Epic',
      pbiIds: ['PBI-001', 'PBI-002', 'PBI-003'],
    });
  });

  it('ignores TBIs, which never own suites', () => {
    expect(findBacklogMatch(backlogJson, 302)).toBeNull();
  });

  it('returns null for an unknown work item', () => {
    expect(findBacklogMatch(backlogJson, 999)).toBeNull();
  });

  it('returns null for a backlog with no epics', () => {
    expect(findBacklogMatch({}, 301)).toBeNull();
    expect(findBacklogMatch(null, 301)).toBeNull();
  });
});

describe('getTestCasesForWorkItem', () => {
  it('returns the single suite for a PBI, with its ADO link', async () => {
    const result = await getTestCasesForWorkItem('Checkout', 301);

    expect(result.totalCases).toBe(2);
    expect(result.suites).toHaveLength(1);
    expect(result.suites[0].pbiId).toBe('PBI-001');
    expect(result.suites[0].adoWorkItemId).toBe(301);
    expect(result.sources[0]).toMatchObject({
      prdId: 'prd-1',
      prdTitle: 'Checkout PRD',
      matchLevel: 'pbi',
      matchedTitle: 'Pay by card',
    });
  });

  it('rolls up every suite beneath a Feature', async () => {
    const result = await getTestCasesForWorkItem('Checkout', 200);

    expect(result.suites.map((suite) => suite.pbiId)).toEqual(['PBI-001', 'PBI-002']);
    expect(result.totalCases).toBe(3);
    expect(result.sources[0].matchLevel).toBe('feature');
  });

  it('rolls up every suite beneath an Epic', async () => {
    const result = await getTestCasesForWorkItem('Checkout', 100);

    expect(result.suites.map((suite) => suite.pbiId)).toEqual([
      'PBI-001',
      'PBI-002',
      'PBI-003',
    ]);
    expect(result.totalCases).toBe(4);
  });

  it('normalizes traceability, automation, and string-only steps', async () => {
    const result = await getTestCasesForWorkItem('Checkout', 301);
    const [first, second] = result.suites[0].testCases;

    expect(first).toMatchObject({
      id: 'TC-PBI-001-001',
      persona: 'Authenticated User',
      automationTier: 'e2e-playwright',
      automationCandidate: true,
      acceptanceCriteriaIndex: 0,
      businessRules: ['BR-001'],
      pbiId: 'PBI-001',
    });
    expect(first.steps).toEqual([
      { order: 1, action: 'Submit a valid card', expected: 'Payment is accepted' },
    ]);

    // A bare string step still becomes an ordered step with an empty expectation.
    expect(second.steps).toEqual([
      { order: 1, action: 'Submit an expired card', expected: '' },
    ]);
    expect(second.acceptanceCriteriaIndex).toBeNull();
    expect(second.businessRules).toEqual([]);
  });

  it('returns an empty result when the work item is in no backlog', async () => {
    const result = await getTestCasesForWorkItem('Checkout', 999);

    expect(result).toEqual({
      workItemId: 999,
      suites: [],
      sources: [],
      totalCases: 0,
    });
    expect(mockGetTestCases).not.toHaveBeenCalled();
  });

  it('returns an empty result when the PRD has no generated suite yet', async () => {
    mockGetTestCases.mockResolvedValue(null);

    const result = await getTestCasesForWorkItem('Checkout', 301);

    expect(result.suites).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.totalCases).toBe(0);
  });

  it('aggregates matches across multiple PRDs in the project', async () => {
    stubPrdRows([prdRow, { ...prdRow, id: 'prd-2', title: 'Checkout PRD v2' }]);

    const result = await getTestCasesForWorkItem('Checkout', 301);

    expect(result.sources.map((source) => source.prdId)).toEqual(['prd-1', 'prd-2']);
    expect(result.totalCases).toBe(4);
  });
});
