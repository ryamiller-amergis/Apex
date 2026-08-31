/**
 * Unit tests for pipelineArtifactStatusService (FEAT-001 / PBI-001 / TBI-001).
 *
 * Every Postgres read stays inside the existing artifact services, so those
 * services are mocked at their public API and the tests assert the visible
 * output of the stall rules (BR-001 through BR-006, BR-011) rather than any
 * query shape.
 */

jest.mock('../services/interviewService', () => ({ listInterviews: jest.fn() }));
jest.mock('../services/prdService', () => ({ listPrds: jest.fn() }));
jest.mock('../services/testCaseService', () => ({
  listLatestTestCaseSummariesForPrds: jest.fn(),
}));
jest.mock('../services/designPrototypeService', () => ({ listPrototypes: jest.fn() }));
jest.mock('../services/designDocService', () => ({ listDesignDocs: jest.fn() }));
jest.mock('../services/ownerApprovalService', () => ({ getOwnerApproval: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({ getSkillConfig: jest.fn() }));

import { getIncompletePipeline } from '../services/pipelineArtifactStatusService';
import type {
  DesignDocSummary,
  InterviewSummary,
  PrdSummary,
  TestCaseSummary,
} from '../../shared/types/interview';
import type { DesignPrototypeSummary } from '../../shared/types/designPrototype';
import type {
  OwnerApprovalDocumentType,
  OwnerApprovalStatus,
} from '../../shared/types/approvals';
import type { IncompletePipelineData, PipelineGroup } from '../../shared/types/homeDashboard';

const { listInterviews } = jest.requireMock('../services/interviewService') as {
  listInterviews: jest.Mock;
};
const { listPrds } = jest.requireMock('../services/prdService') as { listPrds: jest.Mock };
const { listLatestTestCaseSummariesForPrds } = jest.requireMock(
  '../services/testCaseService',
) as { listLatestTestCaseSummariesForPrds: jest.Mock };
const { listPrototypes } = jest.requireMock('../services/designPrototypeService') as {
  listPrototypes: jest.Mock;
};
const { listDesignDocs } = jest.requireMock('../services/designDocService') as {
  listDesignDocs: jest.Mock;
};
const { getOwnerApproval } = jest.requireMock('../services/ownerApprovalService') as {
  getOwnerApproval: jest.Mock;
};
const { getSkillConfig } = jest.requireMock('../services/projectSettingsService') as {
  getSkillConfig: jest.Mock;
};

const PROJECT = 'Apex';
const NOW = new Date('2026-08-31T00:00:00.000Z');

const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const interview = (
  over: Partial<InterviewSummary> & { id: string },
): InterviewSummary => ({
  chatThreadId: `thread-${over.id}`,
  authorId: 'user-1',
  title: `Interview ${over.id}`,
  project: PROJECT,
  repo: 'AI-Pilot',
  status: 'in_progress',
  prdCount: 0,
  createdAt: daysAgo(30),
  updatedAt: daysAgo(5),
  ...over,
});

const prd = (over: Partial<PrdSummary> & { id: string }): PrdSummary => ({
  interviewId: 'int-1',
  chatThreadId: `thread-${over.id}`,
  authorId: 'user-1',
  project: PROJECT,
  title: `PRD ${over.id}`,
  status: 'pending_review',
  createdAt: daysAgo(20),
  updatedAt: daysAgo(4),
  testCasesRequired: true,
  prototypeStageEnabled: true,
  ...over,
});

const testCase = (
  over: Partial<TestCaseSummary> & { id: string; prdId: string },
): TestCaseSummary => ({
  chatThreadId: null,
  status: 'generating',
  createdAt: daysAgo(10),
  updatedAt: daysAgo(3),
  ...over,
});

const prototype = (
  over: Partial<DesignPrototypeSummary> & { id: string; prdId: string },
): DesignPrototypeSummary => ({
  featureName: `Feature ${over.id}`,
  featureIndex: 0,
  authorId: 'user-1',
  status: 'pending_review',
  mockVersion: 1,
  createdAt: daysAgo(12),
  updatedAt: daysAgo(2),
  ...over,
});

const designDoc = (
  over: Partial<DesignDocSummary> & { id: string; prdId: string },
): DesignDocSummary => ({
  project: PROJECT,
  chatThreadId: null,
  authorId: 'user-1',
  title: `Design Doc ${over.id}`,
  status: 'pending_review',
  createdAt: daysAgo(8),
  updatedAt: daysAgo(1),
  ...over,
});

/** Seeds `getOwnerApproval` from a `${documentType}:${documentId}` → status map. */
function seedOwnerApprovals(statuses: Record<string, OwnerApprovalStatus>): void {
  getOwnerApproval.mockImplementation(
    async (documentId: string, documentType: OwnerApprovalDocumentType) => {
      const status = statuses[`${documentType}:${documentId}`];
      if (!status) return null;
      return {
        id: `approval-${documentType}-${documentId}`,
        documentId,
        documentType,
        ownerUserId: 'owner-1',
        status,
        comment: null,
        respondedAt: status === 'pending' ? null : daysAgo(1),
        createdAt: daysAgo(2),
      };
    },
  );
}

const groupOf = (data: IncompletePipelineData, key: PipelineGroup['key']): PipelineGroup => {
  const group = data.groups.find((g) => g.key === key);
  if (!group) throw new Error(`expected a "${key}" group in the payload`);
  return group;
};

const hasGroup = (data: IncompletePipelineData, key: PipelineGroup['key']): boolean =>
  data.groups.some((g) => g.key === key);

describe('pipelineArtifactStatusService.getIncompletePipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    listInterviews.mockResolvedValue([]);
    listPrds.mockResolvedValue([]);
    listLatestTestCaseSummariesForPrds.mockResolvedValue(new Map<string, TestCaseSummary>());
    listPrototypes.mockResolvedValue([]);
    listDesignDocs.mockResolvedValue([]);
    getOwnerApproval.mockResolvedValue(null);
    getSkillConfig.mockResolvedValue({ prototypeStageEnabled: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('PBI-001 AC-0 / VT-01 / BR-001 lists an in-progress Interview with its detail route and stale age', async () => {
    listInterviews.mockResolvedValue([
      interview({ id: 'int-1', title: 'Pipeline dashboard', updatedAt: daysAgo(6) }),
    ]);

    const data = await getIncompletePipeline(PROJECT);
    const group = groupOf(data, 'interview');

    expect(listInterviews).toHaveBeenCalledWith({ project: PROJECT });
    expect(group.count).toBe(1);
    expect(group.rows).toEqual([
      {
        id: 'int-1',
        name: 'Pipeline dashboard',
        route: '/backlog/interview/int-1',
        updatedAt: daysAgo(6),
        ageDays: 6,
      },
    ]);
  });

  it('PBI-001 AC-0 / BR-001 keeps a complete Interview with no PRD and drops one that has a PRD', async () => {
    listInterviews.mockResolvedValue([
      interview({ id: 'int-stalled', status: 'complete', prdCount: 0 }),
      interview({ id: 'int-moved-on', status: 'complete', prdCount: 1 }),
    ]);

    const group = groupOf(await getIncompletePipeline(PROJECT), 'interview');

    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['int-stalled']);
  });

  it('PBI-001 AC-0 / BR-001 excludes archived Interviews regardless of PRD count', async () => {
    listInterviews.mockResolvedValue([
      interview({ id: 'int-archived', status: 'archived', prdCount: 0 }),
      interview({ id: 'int-live', status: 'in_progress' }),
    ]);

    const group = groupOf(await getIncompletePipeline(PROJECT), 'interview');

    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['int-live']);
  });

  it('PBI-001 AC-0 / BR-002 keeps a reviewer-approved PRD until the owner gives final approval', async () => {
    listPrds.mockResolvedValue([
      prd({ id: 'prd-reviewer-only', status: 'reviewer_approved', testCasesRequired: false }),
      prd({ id: 'prd-owner-signed', status: 'approved', testCasesRequired: false }),
    ]);
    seedOwnerApprovals({
      'prd:prd-reviewer-only': 'pending',
      'prd:prd-owner-signed': 'approved',
    });

    const group = groupOf(await getIncompletePipeline(PROJECT), 'prd');

    expect(listPrds).toHaveBeenCalledWith({ project: PROJECT });
    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['prd-reviewer-only']);
  });

  it('PBI-001 AC-0 / BR-002 keeps a reviewer-approved Design Doc until the owner gives final approval', async () => {
    listDesignDocs.mockResolvedValue([
      designDoc({ id: 'doc-reviewer-only', prdId: 'prd-1', status: 'reviewer_approved' }),
      designDoc({ id: 'doc-owner-signed', prdId: 'prd-1', status: 'approved' }),
    ]);
    seedOwnerApprovals({
      'design_doc:doc-reviewer-only': 'revision_requested',
      'design_doc:doc-owner-signed': 'approved',
    });

    const group = groupOf(await getIncompletePipeline(PROJECT), 'designDoc');

    expect(listDesignDocs).toHaveBeenCalledWith({ project: PROJECT });
    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['doc-reviewer-only']);
  });

  it('PBI-001 AC-0 / BR-003 adds a Test Case row when the latest suite is missing, generating, or failed', async () => {
    listPrds.mockResolvedValue([
      prd({ id: 'prd-missing' }),
      prd({ id: 'prd-generating' }),
      prd({ id: 'prd-failed' }),
    ]);
    listLatestTestCaseSummariesForPrds.mockResolvedValue(
      new Map<string, TestCaseSummary>([
        ['prd-generating', testCase({ id: 'tc-generating', prdId: 'prd-generating', status: 'generating' })],
        ['prd-failed', testCase({ id: 'tc-failed', prdId: 'prd-failed', status: 'failed' })],
      ]),
    );

    const group = groupOf(await getIncompletePipeline(PROJECT), 'testCase');

    expect(listLatestTestCaseSummariesForPrds).toHaveBeenCalledWith([
      'prd-missing',
      'prd-generating',
      'prd-failed',
    ]);
    expect(group.count).toBe(3);
    expect(group.rows.map((r) => r.route)).toEqual([
      '/backlog/prd/prd-missing',
      '/backlog/prd/prd-generating',
      '/backlog/prd/prd-failed',
    ]);
  });

  it('PBI-001 AC-0 / BR-003 omits the Test Case row once the latest suite is ready', async () => {
    listPrds.mockResolvedValue([prd({ id: 'prd-ready' })]);
    listLatestTestCaseSummariesForPrds.mockResolvedValue(
      new Map<string, TestCaseSummary>([
        ['prd-ready', testCase({ id: 'tc-ready', prdId: 'prd-ready', status: 'ready' })],
      ]),
    );

    const group = groupOf(await getIncompletePipeline(PROJECT), 'testCase');

    expect(group.count).toBe(0);
    expect(group.rows).toEqual([]);
  });

  it('PBI-001 AC-0 / BR-003 omits the Test Case row when the PRD does not require tests', async () => {
    listPrds.mockResolvedValue([prd({ id: 'prd-no-tests', testCasesRequired: false })]);

    const group = groupOf(await getIncompletePipeline(PROJECT), 'testCase');

    expect(group.count).toBe(0);
    expect(group.rows).toEqual([]);
  });

  it('PBI-001 AC-0 / BR-004 keeps an owner-approved Prototype while its feature has no Design Doc', async () => {
    listPrototypes.mockResolvedValue([
      prototype({ id: 'proto-approved', prdId: 'prd-1', status: 'approved', featureIndex: 2 }),
    ]);
    seedOwnerApprovals({ 'design_prototype:proto-approved': 'approved' });

    const group = groupOf(await getIncompletePipeline(PROJECT), 'prototype');

    expect(listPrototypes).toHaveBeenCalledWith({ project: PROJECT });
    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['proto-approved']);
  });

  it('PBI-001 AC-0 / BR-004 drops an owner-approved Prototype once a Design Doc exists for its feature', async () => {
    listPrototypes.mockResolvedValue([
      prototype({ id: 'proto-documented', prdId: 'prd-1', status: 'approved', featureIndex: 2 }),
      prototype({ id: 'proto-undocumented', prdId: 'prd-1', status: 'approved', featureIndex: 3 }),
    ]);
    listDesignDocs.mockResolvedValue([
      designDoc({ id: 'doc-1', prdId: 'prd-1', featureIndex: 2, status: 'approved' }),
    ]);
    seedOwnerApprovals({
      'design_prototype:proto-documented': 'approved',
      'design_prototype:proto-undocumented': 'approved',
      'design_doc:doc-1': 'approved',
    });

    const group = groupOf(await getIncompletePipeline(PROJECT), 'prototype');

    expect(group.count).toBe(1);
    expect(group.rows.map((r) => r.id)).toEqual(['proto-undocumented']);
  });

  it('PBI-001 AC-0 / BR-005 hides the Prototype group when every project Interview has prototypes disabled', async () => {
    getSkillConfig.mockResolvedValue({ prototypeStageEnabled: false });
    listInterviews.mockResolvedValue([
      interview({ id: 'int-a', prototypeStageEnabled: false, prdCount: 1 }),
      interview({ id: 'int-b', prototypeStageEnabled: false, prdCount: 1 }),
    ]);
    listPrds.mockResolvedValue([
      prd({ id: 'prd-a', interviewId: 'int-a', prototypeStageEnabled: false, testCasesRequired: false }),
      prd({ id: 'prd-b', interviewId: 'int-b', prototypeStageEnabled: false, testCasesRequired: false }),
    ]);
    listPrototypes.mockResolvedValue([prototype({ id: 'proto-orphan', prdId: 'prd-a' })]);

    const data = await getIncompletePipeline(PROJECT);

    expect(hasGroup(data, 'prototype')).toBe(false);
    expect(data.groups.map((g) => g.key)).toEqual(['interview', 'prd', 'testCase', 'designDoc']);
  });

  it('PBI-001 AC-0 / BR-005 shows the Prototype group when an enabled Interview has no PRD', async () => {
    getSkillConfig.mockResolvedValue({ prototypeStageEnabled: false });
    listInterviews.mockResolvedValue([
      interview({ id: 'int-no-prd', prototypeStageEnabled: true, prdCount: 0 }),
      interview({ id: 'int-disabled', prototypeStageEnabled: false, prdCount: 1 }),
    ]);
    listPrds.mockResolvedValue([
      prd({
        id: 'prd-disabled',
        interviewId: 'int-disabled',
        prototypeStageEnabled: false,
        testCasesRequired: false,
      }),
    ]);
    listPrototypes.mockResolvedValue([prototype({ id: 'proto-live', prdId: 'prd-disabled' })]);

    const data = await getIncompletePipeline(PROJECT);

    expect(hasGroup(data, 'prototype')).toBe(true);
    expect(groupOf(data, 'prototype').rows.map((r) => r.id)).toEqual(['proto-live']);
  });

  it('PBI-001 AC-0 / BR-006 counts every stalled artifact, caps rows at 20, and orders stalest first', async () => {
    listInterviews.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) =>
        interview({ id: `int-${i}`, updatedAt: daysAgo(i + 1) }),
      ),
    );

    const group = groupOf(await getIncompletePipeline(PROJECT), 'interview');

    expect(group.count).toBe(25);
    expect(group.rows).toHaveLength(20);
    expect(group.rows[0].id).toBe('int-24');
    expect(group.rows[0].ageDays).toBe(25);
    expect(group.rows[19].id).toBe('int-5');
    const ages = group.rows.map((r) => r.ageDays);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });

  it('PBI-001 AC-0 / BR-011 uses the existing detail and View-all routes for every group', async () => {
    listInterviews.mockResolvedValue([interview({ id: 'int-1' })]);
    listPrds.mockResolvedValue([prd({ id: 'prd-1' })]);
    listPrototypes.mockResolvedValue([prototype({ id: 'proto-1', prdId: 'prd-1' })]);
    listDesignDocs.mockResolvedValue([designDoc({ id: 'doc-1', prdId: 'prd-1' })]);

    const data = await getIncompletePipeline(PROJECT);

    expect(groupOf(data, 'interview').rows[0].route).toBe('/backlog/interview/int-1');
    expect(groupOf(data, 'prd').rows[0].route).toBe('/backlog/prd/prd-1');
    expect(groupOf(data, 'testCase').rows[0].route).toBe('/backlog/prd/prd-1');
    expect(groupOf(data, 'prototype').rows[0].route).toBe('/backlog/design-prototypes/prd-1');
    expect(groupOf(data, 'designDoc').rows[0].route).toBe('/backlog/design-doc/doc-1');

    expect(data.groups.map((g) => [g.key, g.viewAllHref])).toEqual([
      ['interview', '/backlog?tab=interviews'],
      ['prd', '/backlog?tab=prds'],
      ['testCase', '/backlog?tab=prds'],
      ['prototype', '/backlog?tab=design-prototypes'],
      ['designDoc', '/backlog?tab=design-docs'],
    ]);
  });

  it('PBI-001 AC-2 / VT-03 returns visible empty groups when the project has no artifacts', async () => {
    getSkillConfig.mockResolvedValue(null);

    const data = await getIncompletePipeline(PROJECT);

    expect(data.groups.map((g) => g.key)).toEqual([
      'interview',
      'prd',
      'testCase',
      'prototype',
      'designDoc',
    ]);
    for (const group of data.groups) {
      expect(group.count).toBe(0);
      expect(group.rows).toEqual([]);
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.viewAllHref.startsWith('/backlog')).toBe(true);
    }
    expect(data.updatedAt).toBe(NOW.toISOString());
  });

  it('TBI-001 propagates a source failure so the caller can isolate this tile', async () => {
    listPrds.mockRejectedValue(new Error('prd source unavailable'));

    await expect(getIncompletePipeline(PROJECT)).rejects.toThrow('prd source unavailable');
  });
});
