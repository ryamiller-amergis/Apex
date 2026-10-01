const mockUpdates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const mockInserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const mockDeletes: Array<{ table: unknown }> = [];
const mockOnConflictDoNothing = jest.fn();
const mockOnConflictDoUpdate = jest.fn();
const mockInsertReturning = jest.fn();
const mockFindJob = jest.fn();
const mockFindUser = jest.fn();
const mockFindRole = jest.fn();

function mockThenable<T>(value: T) {
  return {
    returning: mockInsertReturning.mockImplementation(async () => value),
    onConflictDoNothing: mockOnConflictDoNothing.mockResolvedValue(undefined),
    onConflictDoUpdate: mockOnConflictDoUpdate.mockResolvedValue(undefined),
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  };
}

function mockExecutor() {
  return {
    query: {
      rfpProposalJobs: { findFirst: (...args: unknown[]) => mockFindJob(...args) },
      appUsers: { findFirst: (...args: unknown[]) => mockFindUser(...args) },
      appRoles: { findFirst: (...args: unknown[]) => mockFindRole(...args) },
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        mockUpdates.push({ table, values });
        return { where: () => mockThenable([]) };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        mockInserts.push({ table, values });
        return mockThenable([{ id: 'job-new' }]);
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        mockDeletes.push({ table });
        return mockThenable([]);
      },
    }),
  };
}

jest.mock('../db/drizzle', () => ({
  db: {
    ...mockExecutor(),
    query: {
      ...mockExecutor().query,
      rfpRequests: { findFirst: jest.fn(), findMany: jest.fn() },
    },
    transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockExecutor())),
  },
}));

jest.mock('../services/rfpIntakeService', () => {
  class RfpIntakeError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    RfpIntakeError,
    actorCanManageRfp: jest.fn(),
    getRequestById: jest.fn(),
    resolveRfpSubmissionRecipients: jest.fn(),
    toRequesterView: (request: Record<string, unknown>) => ({ ...request, proposalDraft: null, proposalGeneration: null }),
  };
});

const mockLoadReviewState = jest.fn();
jest.mock('../services/rfpProposalFingerprint', () => ({
  ...jest.requireActual('../services/rfpProposalFingerprint'),
  loadRfpReviewState: (...args: unknown[]) => mockLoadReviewState(...args),
}));

const mockCreateGitRepository = jest.fn();
const mockDeleteGitRepository = jest.fn();
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    createGitRepository: mockCreateGitRepository,
    deleteGitRepository: mockDeleteGitRepository,
  })),
}));

jest.mock('../services/projectCatalogService', () => ({
  listProjectCatalog: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  upsertSkillConfig: jest.fn(),
  listSkillConfigsForProject: jest.fn(),
}));

jest.mock('../services/newProjectSkillSeedService', () => ({
  seedNewProjectSkills: jest.fn().mockResolvedValue(undefined),
  PRODUCT_FOUNDATION_SKILL_PATH: '.agents/skills/product-foundation/SKILL.md',
  SETUP_CHAT_MODEL: 'auto-smart',
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn(),
}));

import { db } from '../db/drizzle';
import {
  appUserProjectRoles,
  projectMenuSettings,
  projectSkillSettings,
  rfpProposalJobs,
  rfpRequests,
  userProjectAssignments,
} from '../db/schema';
import { actorCanManageRfp, getRequestById, resolveRfpSubmissionRecipients } from '../services/rfpIntakeService';
import { listProjectCatalog } from '../services/projectCatalogService';
import { listSkillConfigsForProject, upsertSkillConfig } from '../services/projectSettingsService';
import { seedNewProjectSkills } from '../services/newProjectSkillSeedService';
import { createNotification } from '../services/notificationService';
import { rfpReviewFingerprint } from '../services/rfpProposalFingerprint';
import {
  approveProposal,
  deleteIntakeProject,
  listIntakePrivateProjectNames,
  rejectProposal,
  publishProposal,
  regenerateProposal,
  saveProposalDraft,
  submitReview,
} from '../services/rfpProposalService';
import type {
  RfpArchitecture,
  RfpArchitectureInput,
  RfpCostLine,
  RfpDecisionSummaryDraft,
  RfpProposal,
  RfpProposalDraft,
  RfpRequest,
} from '../../shared/types/rfpIntake';

const mockedDb = db as any;
const mockedCanManage = actorCanManageRfp as jest.MockedFunction<typeof actorCanManageRfp>;
const mockedGetRequest = getRequestById as jest.MockedFunction<typeof getRequestById>;
const mockedCatalog = listProjectCatalog as jest.MockedFunction<typeof listProjectCatalog>;
const mockedUpsert = upsertSkillConfig as jest.MockedFunction<typeof upsertSkillConfig>;
const mockedListConfigs = listSkillConfigsForProject as jest.MockedFunction<typeof listSkillConfigsForProject>;
const mockedNotify = createNotification as jest.MockedFunction<typeof createNotification>;
const mockedAdmins = resolveRfpSubmissionRecipients as jest.MockedFunction<typeof resolveRfpSubmissionRecipients>;

const NOW = '2026-09-28T12:00:00.000Z';

const SIZING = {
  region: 'us-east' as const,
  sizingProfile: 'medium' as const,
  environmentCount: 2,
  uptimePattern: 'always-on' as const,
  storageGb: 100,
  aiUsage: 'moderate' as const,
};

const ARCH_INPUT: RfpArchitectureInput = {
  appType: 'web',
  resources: ['rds', 'ecs', 'rds'],
  requiresAi: true,
  domainName: ' benefits.amergis.com ',
  sizing: SIZING,
};

const ARCHITECTURE: RfpArchitecture = {
  appType: 'web',
  resources: ['rds', 'ecs'],
  requiresAi: true,
  domainName: 'benefits.amergis.com',
  sizing: SIZING,
  updatedBy: 'admin-1',
  updatedAt: NOW,
};

const BUILD_FP = rfpReviewFingerprint('proposal', 'build', ARCHITECTURE);

function costLine(overrides: Partial<RfpCostLine> = {}): RfpCostLine {
  return {
    id: 'ecs-prod',
    label: 'Production app hosting',
    category: 'operating',
    cadence: 'monthly',
    quantity: 730,
    unit: 'task-hour',
    unitPrice: 0.05,
    amounts: { low: 30, expected: 36.5, high: 45 },
    currency: 'USD',
    priceStatus: 'verified',
    sourceType: 'aws-price-list',
    sourceUrl: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json',
    sourceTitle: 'AWS Price List — Amazon ECS',
    retrievedAt: NOW,
    confidence: 'high',
    assumptions: [],
    adminConfirmed: true,
    ...overrides,
  };
}

function proposalDraft(overrides: Partial<RfpProposalDraft> = {}): RfpProposalDraft {
  return {
    version: 1,
    kind: 'proposal',
    jobId: 'job-1',
    inputFingerprint: BUILD_FP,
    verdict: 'build',
    generatedAt: NOW,
    editedBy: null,
    editedAt: null,
    sections: {
      executiveSummary: 'Build it.',
      recommendedSolution: 'A web app.',
      scope: ['Tracking'],
      deliveryPhases: [{ name: 'Build', duration: '6 weeks', outcomes: ['App'] }],
      timeline: 'Eight weeks.',
      assumptions: [],
      exclusions: [],
      risks: [],
      securityAndData: 'Stays internal.',
      ownership: 'Benefits team.',
      nextSteps: ['Approve'],
    },
    costLines: [costLine()],
    totals: {
      oneTime: { low: 0, expected: 0, high: 0 },
      monthly: { low: 30, expected: 36.5, high: 45 },
      annual: { low: 360, expected: 438, high: 540 },
      unpricedLineCount: 0,
    },
    ...overrides,
  };
}

const DECLINE_FP = rfpReviewFingerprint('decision-summary', 'decline', null);

const DECISION: RfpDecisionSummaryDraft = {
  version: 1,
  kind: 'decision-summary',
  jobId: 'job-1',
  inputFingerprint: DECLINE_FP,
  verdict: 'decline',
  generatedAt: NOW,
  editedBy: null,
  editedAt: null,
  summary: 'Not a fit.',
  reasons: ['Covered by an existing tool'],
  alternatives: ['Use the existing tool'],
  nextSteps: ['Talk to IT'],
};

const ROW = {
  id: 'rfp-1',
  ownerId: 'owner-1',
  title: 'Benefits Tracker',
  aiStatus: 'complete',
  architecture: null as RfpArchitecture | null,
  reviewSubmittedAt: null as string | null,
  reviewSubmittedBy: null as string | null,
  currentProposalJobId: null as string | null,
  proposalDraft: null as unknown,
  proposal: null as RfpProposal | null,
  approvedRepoName: null as string | null,
  approvedRepoUrl: null as string | null,
  apexProject: null as string | null,
  approvedAt: null as string | null,
};

function state(overrides: {
  row?: Partial<typeof ROW>;
  verdict?: string | null;
  kind?: string | null;
  fingerprint?: string | null;
} = {}) {
  return {
    row: { ...ROW, ...overrides.row },
    verdict: overrides.verdict === undefined ? 'build' : overrides.verdict,
    kind: overrides.kind === undefined ? 'proposal' : overrides.kind,
    fingerprint: overrides.fingerprint === undefined ? BUILD_FP : overrides.fingerprint,
  };
}

function readyJob(overrides: Record<string, unknown> = {}) {
  return { id: 'job-1', status: 'ready', kind: 'proposal', inputFingerprint: BUILD_FP, ...overrides };
}

function updatesTo(table: unknown) {
  return mockUpdates.filter((entry) => entry.table === table).map((entry) => entry.values);
}

function insertsTo(table: unknown) {
  return mockInserts.filter((entry) => entry.table === table).map((entry) => entry.values);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdates.length = 0;
  mockInserts.length = 0;
  mockDeletes.length = 0;
  mockDeleteGitRepository.mockResolvedValue(undefined);
  mockedCanManage.mockResolvedValue(true);
  mockedAdmins.mockResolvedValue(['admin-1', 'admin-2']);
  mockedGetRequest.mockResolvedValue({ id: 'rfp-1' } as RfpRequest);
  mockLoadReviewState.mockResolvedValue(state());
  mockFindJob.mockResolvedValue(undefined);
  mockFindUser.mockResolvedValue({ oid: 'po-1', displayName: 'Pat Owner', email: 'pat@x.com' });
  mockFindRole.mockResolvedValue({ id: 'role-admin', name: 'admin' });
  mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW });
  mockedCatalog.mockResolvedValue([{ id: 'p-apex', name: 'Apex', description: '' }]);
  mockedListConfigs.mockResolvedValue([]);
  mockedUpsert.mockResolvedValue({} as never);
  mockCreateGitRepository.mockResolvedValue({
    name: 'benefits-tracker',
    webUrl: 'https://dev.azure.com/amergis/Apex%20-%20Apps/_git/benefits-tracker',
  });
});

describe('submitReview', () => {
  it('SR-1 rejects actors without rfp-intake:manage', async () => {
    mockedCanManage.mockResolvedValue(false);
    await expect(submitReview('rfp-1', 'user-9', { architecture: ARCH_INPUT })).rejects.toMatchObject({ status: 403 });
    expect(mockUpdates).toHaveLength(0);
  });

  it('SR-1 lets super admins submit without the permission', async () => {
    mockedCanManage.mockResolvedValue(false);
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT }, { isSuperAdmin: true });
    expect(insertsTo(rfpProposalJobs)).toHaveLength(1);
  });

  it('SR-0 locks the row, queues a proposal job, and records the review', async () => {
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT });
    expect(mockLoadReviewState).toHaveBeenCalledWith(expect.anything(), 'rfp-1', { lock: true });
    expect(insertsTo(rfpProposalJobs)[0]).toEqual({
      rfpRequestId: 'rfp-1',
      kind: 'proposal',
      verdict: 'build',
      inputFingerprint: BUILD_FP,
      requestedBy: 'admin-1',
    });
    const requestUpdate = updatesTo(rfpRequests)[0];
    expect(requestUpdate).toMatchObject({
      reviewSubmittedBy: 'admin-1',
      currentProposalJobId: 'job-new',
      proposalDraft: null,
      architecture: expect.objectContaining({
        resources: ['rds', 'ecs'],
        domainName: 'benefits.amergis.com',
        sizing: SIZING,
        updatedBy: 'admin-1',
      }),
    });
    expect(mockInserts.find((entry) => entry.values.eventType === 'review-submitted')).toBeTruthy();
  });

  it('SR-0 supersedes any active job before queueing a new one', async () => {
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT });
    expect(updatesTo(rfpProposalJobs)[0]).toMatchObject({ status: 'superseded' });
  });

  it('SR-0 rejects invalid sizing', async () => {
    await expect(submitReview('rfp-1', 'admin-1', {
      architecture: { ...ARCH_INPUT, sizing: { ...SIZING, environmentCount: 9 } },
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('SR-0 requires an architecture for proposal verdicts', async () => {
    await expect(submitReview('rfp-1', 'admin-1', { architecture: null }))
      .rejects.toMatchObject({ status: 400, message: 'architecture is required' });
  });

  it('SR-2 reuses a running job when the review has not changed', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: { currentProposalJobId: 'job-1', reviewSubmittedAt: NOW } }));
    mockFindJob.mockResolvedValue(readyJob({ status: 'writing' }));
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT });
    expect(insertsTo(rfpProposalJobs)).toHaveLength(0);
    expect(updatesTo(rfpProposalJobs)).toHaveLength(0);
    expect(mockInserts.find((entry) => entry.values.eventType === 'review-submitted')?.values.payload)
      .toMatchObject({ reused: true, jobId: 'job-1' });
  });

  it('SR-2 queues a new job when the sizing changed', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: { currentProposalJobId: 'job-1' } }));
    mockFindJob.mockResolvedValue(readyJob());
    await submitReview('rfp-1', 'admin-1', { architecture: { ...ARCH_INPUT, sizing: { ...SIZING, storageGb: 500 } } });
    expect(insertsTo(rfpProposalJobs)).toHaveLength(1);
  });

  it('SR-2 clears a published proposal built from different inputs', async () => {
    const published: RfpProposal = {
      document: proposalDraft({ inputFingerprint: 'old' }),
      productOwnerId: 'po-1',
      productOwnerName: 'Pat',
      publishedBy: 'admin-1',
      publishedAt: NOW,
    };
    mockLoadReviewState.mockResolvedValue(state({ row: { proposal: published } }));
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT });
    expect(updatesTo(rfpRequests)[0]).toMatchObject({ proposal: null });
  });

  it('SR-3 saves the review without a job for needs-clarification', async () => {
    mockLoadReviewState.mockResolvedValue(state({ verdict: 'needs-clarification', kind: null, fingerprint: null }));
    await submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT });
    expect(insertsTo(rfpProposalJobs)).toHaveLength(0);
    expect(updatesTo(rfpRequests)[0]).toMatchObject({ reviewSubmittedAt: null, currentProposalJobId: null });
  });

  it('SR-4 queues a decision summary for decline without an architecture', async () => {
    mockLoadReviewState.mockResolvedValue(state({ verdict: 'decline', kind: 'decision-summary', fingerprint: DECLINE_FP }));
    await submitReview('rfp-1', 'admin-1', { architecture: null });
    expect(insertsTo(rfpProposalJobs)[0]).toMatchObject({ kind: 'decision-summary', inputFingerprint: DECLINE_FP });
  });

  it('SR-5 rejects submission while the evaluation is running or without a verdict', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: { aiStatus: 'evaluating' } }));
    await expect(submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT })).rejects.toMatchObject({ code: 'EVALUATING' });
    mockLoadReviewState.mockResolvedValue(state({ verdict: null, kind: null, fingerprint: null }));
    await expect(submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT })).rejects.toMatchObject({ code: 'VERDICT_REQUIRED' });
  });

  it('SR-6 maps a duplicate active job to 409', async () => {
    mockedDb.transaction.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT }))
      .rejects.toMatchObject({ status: 409, code: 'GENERATION_ACTIVE' });
  });

  it('SR-7 rejects edits after the requester approved', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: { approvedAt: NOW } }));
    await expect(submitReview('rfp-1', 'admin-1', { architecture: ARCH_INPUT })).rejects.toMatchObject({ status: 409 });
  });

  it('returns 404 for an unknown request', async () => {
    mockLoadReviewState.mockResolvedValue(null);
    await expect(submitReview('rfp-x', 'admin-1', { architecture: ARCH_INPUT })).rejects.toMatchObject({ status: 404 });
  });
});

describe('regenerateProposal', () => {
  const submitted = { reviewSubmittedAt: NOW, architecture: ARCHITECTURE, currentProposalJobId: 'job-1' };

  it('RG-0 queues a new job after a failure', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: submitted }));
    mockFindJob.mockResolvedValue(readyJob({ status: 'failed' }));
    await regenerateProposal('rfp-1', 'admin-1');
    expect(insertsTo(rfpProposalJobs)[0]).toMatchObject({ inputFingerprint: BUILD_FP, requestedBy: 'admin-1' });
    expect(updatesTo(rfpRequests)[0]).toMatchObject({ currentProposalJobId: 'job-new', proposalDraft: null });
  });

  it('RG-1 rejects while a job is running', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: submitted }));
    mockFindJob.mockResolvedValue(readyJob({ status: 'researching-prices' }));
    await expect(regenerateProposal('rfp-1', 'admin-1')).rejects.toMatchObject({ status: 409, code: 'GENERATION_ACTIVE' });
  });

  it('RG-2 requires a submitted review and a verdict that produces a draft', async () => {
    await expect(regenerateProposal('rfp-1', 'admin-1')).rejects.toMatchObject({ code: 'REVIEW_NOT_SUBMITTED' });
    mockLoadReviewState.mockResolvedValue(state({
      row: submitted, verdict: 'needs-clarification', kind: null, fingerprint: null,
    }));
    await expect(regenerateProposal('rfp-1', 'admin-1')).rejects.toMatchObject({ code: 'NO_DRAFT_FOR_VERDICT' });
  });
});

describe('saveProposalDraft', () => {
  const withDraft = (draft: unknown) => state({
    row: { currentProposalJobId: 'job-1', architecture: ARCHITECTURE, proposalDraft: draft },
  });

  it('DR-0 keeps generated evidence and records the editor', async () => {
    const stored = proposalDraft({ costLines: [costLine({ adminConfirmed: false })] });
    mockLoadReviewState.mockResolvedValue(withDraft(stored));
    mockFindJob.mockResolvedValue(readyJob());
    const edited = proposalDraft({
      costLines: [costLine({ adminConfirmed: true, sourceUrl: 'https://evil.example.com', sourceType: 'vendor-page' })],
    });
    await saveProposalDraft('rfp-1', 'admin-1', edited);
    const saved = updatesTo(rfpRequests)[0].proposalDraft as RfpProposalDraft;
    expect(saved.costLines[0]).toMatchObject({
      adminConfirmed: true,
      sourceUrl: stored.costLines[0].sourceUrl,
      sourceType: 'aws-price-list',
    });
    expect(saved.editedBy).toBe('admin-1');
    expect(mockInserts.find((entry) => entry.values.eventType === 'proposal-draft-edited')).toBeTruthy();
  });

  it('DR-0 marks an edited amount as an estimate', async () => {
    mockLoadReviewState.mockResolvedValue(withDraft(proposalDraft()));
    mockFindJob.mockResolvedValue(readyJob());
    await saveProposalDraft('rfp-1', 'admin-1', proposalDraft({
      costLines: [costLine({ amounts: { low: 50, expected: 60, high: 70 } })],
    }));
    const saved = updatesTo(rfpRequests)[0].proposalDraft as RfpProposalDraft;
    expect(saved.costLines[0]).toMatchObject({ priceStatus: 'estimate', amounts: { expected: 60 } });
    expect(saved.totals.monthly.expected).toBe(60);
  });

  it('DR-1 rejects a draft from an older job', async () => {
    mockLoadReviewState.mockResolvedValue(withDraft(proposalDraft()));
    mockFindJob.mockResolvedValue(readyJob());
    await expect(saveProposalDraft('rfp-1', 'admin-1', proposalDraft({ jobId: 'job-0' })))
      .rejects.toMatchObject({ status: 409, code: 'STALE_DRAFT' });
  });

  it('DR-1 rejects a draft once the review changed', async () => {
    mockLoadReviewState.mockResolvedValue({ ...withDraft(proposalDraft()), fingerprint: 'changed' });
    mockFindJob.mockResolvedValue(readyJob());
    await expect(saveProposalDraft('rfp-1', 'admin-1', proposalDraft()))
      .rejects.toMatchObject({ status: 409, code: 'STALE_DRAFT' });
  });

  it('DR-2 rejects invalid drafts and added or removed cost lines', async () => {
    await expect(saveProposalDraft('rfp-1', 'admin-1', { kind: 'proposal' }))
      .rejects.toMatchObject({ status: 400, message: 'draft is invalid' });
    mockLoadReviewState.mockResolvedValue(withDraft(proposalDraft()));
    mockFindJob.mockResolvedValue(readyJob());
    await expect(saveProposalDraft('rfp-1', 'admin-1', proposalDraft({ costLines: [costLine({ id: 'new' })] })))
      .rejects.toMatchObject({ status: 400, message: 'costLines must match the generated draft' });
  });
});

describe('publishProposal', () => {
  const ready = (draft: unknown, fingerprint = BUILD_FP) => ({
    ...state({ row: { currentProposalJobId: 'job-1', architecture: ARCHITECTURE, proposalDraft: draft } }),
    fingerprint,
  });

  beforeEach(() => {
    mockLoadReviewState.mockResolvedValue(ready(proposalDraft()));
    mockFindJob.mockResolvedValue(readyJob());
  });

  it('PB-1 rejects actors without rfp-intake:manage', async () => {
    mockedCanManage.mockResolvedValue(false);
    await expect(publishProposal('rfp-1', 'user-9', { productOwnerId: 'po-1' })).rejects.toMatchObject({ status: 403 });
  });

  it('PB-0 stores the document with the owner and notifies the requester', async () => {
    await publishProposal('rfp-1', 'admin-1', { productOwnerId: 'po-1' });
    expect(updatesTo(rfpRequests)[0].proposal).toMatchObject({
      document: expect.objectContaining({ kind: 'proposal', jobId: 'job-1' }),
      productOwnerId: 'po-1',
      productOwnerName: 'Pat Owner',
      publishedBy: 'admin-1',
    });
    expect(mockInserts.find((entry) => entry.values.eventType === 'proposal-published')).toBeTruthy();
    expect(mockedNotify).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      title: 'Your product proposal is ready to review',
      link: '/?request=rfp-1',
    }));
  });

  it('PB-2 requires a product owner who is an Apex user', async () => {
    await expect(publishProposal('rfp-1', 'admin-1', {})).rejects.toMatchObject({ message: 'productOwnerId is required' });
    mockFindUser.mockResolvedValue(undefined);
    await expect(publishProposal('rfp-1', 'admin-1', { productOwnerId: 'ghost' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('PB-3 requires every cost to be priced and confirmed', async () => {
    mockLoadReviewState.mockResolvedValue(ready(proposalDraft({
      costLines: [costLine({ adminConfirmed: false }), costLine({ id: 'impl', label: 'Build', amounts: null })],
    })));
    await expect(publishProposal('rfp-1', 'admin-1', { productOwnerId: 'po-1' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('needs admin confirmation'),
    });
    expect(updatesTo(rfpRequests)).toHaveLength(0);
  });

  it('PB-4 rejects a stale draft when the review changed after generation', async () => {
    mockLoadReviewState.mockResolvedValue(ready(proposalDraft(), 'changed'));
    await expect(publishProposal('rfp-1', 'admin-1', { productOwnerId: 'po-1' }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_DRAFT' });
  });

  it('PB-4 rejects publishing before the draft is ready', async () => {
    mockFindJob.mockResolvedValue(readyJob({ status: 'writing' }));
    await expect(publishProposal('rfp-1', 'admin-1', { productOwnerId: 'po-1' }))
      .rejects.toMatchObject({ status: 409, code: 'DRAFT_NOT_READY' });
  });

  it('PB-5 publishes a decision summary without a product owner', async () => {
    mockLoadReviewState.mockResolvedValue(ready(DECISION, DECLINE_FP));
    mockFindJob.mockResolvedValue(readyJob({ kind: 'decision-summary', inputFingerprint: DECLINE_FP }));
    await publishProposal('rfp-1', 'admin-1', {});
    expect(updatesTo(rfpRequests)[0].proposal).toMatchObject({
      document: expect.objectContaining({ kind: 'decision-summary' }),
      productOwnerId: null,
    });
    expect(mockedNotify).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      title: 'Apex triage made a decision on your request',
    }));
  });

  it('PB-6 rejects publishing after approval', async () => {
    mockLoadReviewState.mockResolvedValue(state({ row: { approvedAt: NOW } }));
    await expect(publishProposal('rfp-1', 'admin-1', { productOwnerId: 'po-1' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('approveProposal', () => {
  const PROPOSAL: RfpProposal = {
    document: proposalDraft(),
    productOwnerId: 'po-1',
    productOwnerName: 'Pat Owner',
    publishedBy: 'admin-1',
    publishedAt: NOW,
  };

  beforeEach(() => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, architecture: ARCHITECTURE, proposal: PROPOSAL });
  });

  it('AR-0 returns 404 when the actor is not the requester', async () => {
    await expect(approveProposal('rfp-1', 'someone-else')).rejects.toMatchObject({ status: 404 });
    expect(mockCreateGitRepository).not.toHaveBeenCalled();
  });

  it('AR-0 requires a published proposal', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, architecture: ARCHITECTURE });
    await expect(approveProposal('rfp-1', 'owner-1'))
      .rejects.toMatchObject({ status: 409, code: 'PROPOSAL_NOT_PUBLISHED' });
  });

  it('AR-0 treats a legacy proposal without a document as unpublished', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, proposal: { resourceCosts: [] } });
    await expect(approveProposal('rfp-1', 'owner-1'))
      .rejects.toMatchObject({ status: 409, code: 'PROPOSAL_NOT_PUBLISHED' });
  });

  it('AR-0 refuses to approve a decision summary', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, proposal: { ...PROPOSAL, document: DECISION } });
    await expect(approveProposal('rfp-1', 'owner-1')).rejects.toMatchObject({ status: 409, code: 'NOT_APPROVABLE' });
    expect(mockCreateGitRepository).not.toHaveBeenCalled();
  });

  it('AR-0 refuses to approve a proposal the requester already rejected', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...ROW,
      proposal: { ...PROPOSAL, rejection: { rejectedAt: NOW, rejectedBy: 'owner-1', reason: 'Too expensive' } },
    });
    await expect(approveProposal('rfp-1', 'owner-1')).rejects.toMatchObject({ status: 409, code: 'PROPOSAL_REJECTED' });
    expect(mockCreateGitRepository).not.toHaveBeenCalled();
  });

  it('AR-0 rejects a second approval', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...ROW, proposal: PROPOSAL, approvedAt: NOW, approvedRepoName: 'r', approvedRepoUrl: 'u', apexProject: 'p',
    });
    await expect(approveProposal('rfp-1', 'owner-1')).rejects.toMatchObject({ status: 409, code: 'ALREADY_APPROVED' });
  });

  it('AR-0 rejects a title that matches an existing project', async () => {
    mockedCatalog.mockResolvedValue([{ id: 'x', name: 'benefits tracker', description: '' }]);
    await expect(approveProposal('rfp-1', 'owner-1'))
      .rejects.toMatchObject({ status: 409, code: 'PROJECT_NAME_TAKEN' });
    expect(mockCreateGitRepository).not.toHaveBeenCalled();
  });

  it('AR-1 creates the repo in Apex - Apps named from the title', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(mockCreateGitRepository).toHaveBeenCalledWith('Apex - Apps', 'benefits-tracker');
  });

  it('AR-2 registers an ADO skill config on main for the new project', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(mockedUpsert).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Benefits Tracker',
      skillProvider: 'ado',
      skillRepo: 'Apex - Apps/benefits-tracker',
      skillBranch: 'main',
      isDefault: true,
    }));
  });

  it('AR-3 assigns the project to the requester, records approval, and hides admin fields', async () => {
    mockedGetRequest.mockResolvedValue({ id: 'rfp-1', proposalDraft: proposalDraft() } as unknown as RfpRequest);
    const result = await approveProposal('rfp-1', 'owner-1');
    expect(mockInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ values: expect.objectContaining({ userId: 'owner-1', project: 'Benefits Tracker' }) }),
      expect.objectContaining({ values: expect.objectContaining({ eventType: 'proposal-approved' }) }),
    ]));
    expect(updatesTo(rfpRequests).some((values) => typeof values.approvedAt === 'string')).toBe(true);
    expect(result.proposalDraft).toBeNull();
    expect(mockedNotify).toHaveBeenCalledWith('admin-1', expect.objectContaining({
      title: 'A requester approved the proposal',
      body: 'Benefits Tracker',
      link: '/rfp-intake/rfp-1',
    }));
    expect(mockedNotify).toHaveBeenCalledWith('admin-2', expect.objectContaining({
      title: 'A requester approved the proposal',
      link: '/rfp-intake/rfp-1',
    }));
  });

  it('NP-0 limits the new project menu to Interview and Apex Backlog', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(insertsTo(projectMenuSettings)).toEqual([
      expect.objectContaining({
        project: 'Benefits Tracker',
        enabledViews: ['backlog', 'feature-requests'],
        updatedBy: 'owner-1',
      }),
    ]);
    expect(mockOnConflictDoUpdate).toHaveBeenCalled();
  });

  it('NP-1 assigns the product owner to the project as its admin', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(insertsTo(userProjectAssignments)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'owner-1', project: 'Benefits Tracker' }),
      expect.objectContaining({ userId: 'po-1', project: 'Benefits Tracker', assignedBy: 'owner-1' }),
    ]));
    expect(insertsTo(appUserProjectRoles)).toEqual([
      expect.objectContaining({ userId: 'po-1', project: 'Benefits Tracker', roleId: 'role-admin', assignedBy: 'owner-1' }),
    ]);
  });

  it('NP-1 tells the product owner they manage the new project', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(mockedNotify).toHaveBeenCalledWith('po-1', expect.objectContaining({
      title: 'You are the admin of a new Apex project',
      body: expect.stringContaining('Benefits Tracker'),
    }));
  });

  it('NP-1 adds a single assignment when the requester is also the product owner', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...ROW, architecture: ARCHITECTURE, proposal: { ...PROPOSAL, productOwnerId: 'owner-1' },
    });
    await approveProposal('rfp-1', 'owner-1');
    expect(insertsTo(userProjectAssignments)).toHaveLength(1);
    expect(insertsTo(appUserProjectRoles)).toEqual([
      expect.objectContaining({ userId: 'owner-1', roleId: 'role-admin' }),
    ]);
  });

  it('NP-2 does not record approval when the admin role is missing', async () => {
    mockFindRole.mockResolvedValue(undefined);
    await expect(approveProposal('rfp-1', 'owner-1')).rejects.toMatchObject({ status: 500, code: 'ADMIN_ROLE_MISSING' });
    expect(updatesTo(rfpRequests).some((values) => typeof values.approvedAt === 'string')).toBe(false);
    expect(insertsTo(projectMenuSettings)).toHaveLength(0);
  });

  it('NP-3 keeps the created repository as the only default project setting', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const config = mockedUpsert.mock.calls[0][0];
    expect(config).toEqual({
      project: 'Benefits Tracker',
      friendlyName: 'Benefits Tracker',
      skillProvider: 'ado',
      skillRepo: 'Apex - Apps/benefits-tracker',
      skillBranch: 'main',
      isDefault: true,
      updatedBy: 'owner-1',
      defaultModel: 'auto-smart',
      quickSkillPills: [{
        label: 'Product foundation',
        skillPath: '.agents/skills/product-foundation/SKILL.md',
        model: 'auto-smart',
        description: 'Who the product is for, what the first release includes, and how you would know it worked.',
      }],
    });
  });

  it('NP-4 does not record approval when the skill seed fails', async () => {
    (seedNewProjectSkills as jest.Mock).mockRejectedValueOnce(new Error('push failed'));
    await expect(approveProposal('rfp-1', 'owner-1')).rejects.toMatchObject({
      status: 502,
      code: 'SKILL_SEED_FAILED',
    });
    expect(updatesTo(rfpRequests).some((values) => typeof values.approvedAt === 'string')).toBe(false);
  });

  it('AR-4 does not store approval when Azure DevOps rejects the create', async () => {
    mockCreateGitRepository.mockRejectedValue(new Error('TF401019: permission denied'));
    await expect(approveProposal('rfp-1', 'owner-1'))
      .rejects.toMatchObject({ status: 502, code: 'REPO_CREATE_FAILED', message: expect.stringContaining('permission denied') });
    expect(mockUpdates).toHaveLength(0);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('AR-4 records the repo before registering the project so it survives later failures', async () => {
    await approveProposal('rfp-1', 'owner-1');
    expect(updatesTo(rfpRequests)[0]).toMatchObject({
      approvedRepoName: 'benefits-tracker',
      approvedRepoUrl: expect.stringContaining('_git/benefits-tracker'),
      apexProject: 'Benefits Tracker',
    });
    expect(mockedUpsert).toHaveBeenCalled();
  });

  it('AR-5 retries without creating the repo again', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...ROW,
      proposal: PROPOSAL,
      approvedRepoName: 'benefits-tracker',
      approvedRepoUrl: 'https://x/_git/benefits-tracker',
      apexProject: 'Benefits Tracker',
    });
    mockedCatalog.mockResolvedValue([{ id: 'x', name: 'Benefits Tracker', description: '' }]);
    mockedListConfigs.mockResolvedValue([{ id: 'cfg-1' }] as never);

    await approveProposal('rfp-1', 'owner-1');

    expect(mockCreateGitRepository).not.toHaveBeenCalled();
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(updatesTo(rfpRequests).some((values) => typeof values.approvedAt === 'string')).toBe(true);
  });
});

describe('rejectProposal', () => {
  const PROPOSAL: RfpProposal = {
    document: proposalDraft(),
    productOwnerId: 'po-1',
    productOwnerName: 'Pat Owner',
    publishedBy: 'admin-1',
    publishedAt: NOW,
  };

  beforeEach(() => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, proposal: PROPOSAL });
  });

  it('RJ-0 records the reason, notifies platform admins, and does not create a repository', async () => {
    mockedAdmins.mockResolvedValue(['admin-2', 'owner-1']);
    mockedGetRequest.mockResolvedValue({ id: 'rfp-1', proposalDraft: proposalDraft() } as unknown as RfpRequest);
    const result = await rejectProposal('rfp-1', 'owner-1', '  The monthly cost is too high.  ');

    expect(mockCreateGitRepository).not.toHaveBeenCalled();
    expect(updatesTo(rfpRequests)[0].proposal).toMatchObject({
      rejection: { rejectedBy: 'owner-1', reason: 'The monthly cost is too high.' },
    });
    expect(mockInserts.some((entry) => entry.values.eventType === 'proposal-rejected')).toBe(true);
    expect(mockedNotify).toHaveBeenCalledWith('admin-1', expect.objectContaining({
      title: 'A requester rejected the proposal',
      body: 'Benefits Tracker: The monthly cost is too high.',
      link: '/rfp-intake/rfp-1',
    }));
    expect(mockedNotify).toHaveBeenCalledWith('admin-2', expect.objectContaining({
      title: 'A requester rejected the proposal',
      link: '/rfp-intake/rfp-1',
    }));
    expect(mockedNotify).not.toHaveBeenCalledWith('owner-1', expect.anything());
    expect(result.proposalDraft).toBeNull();
  });

  it('RJ-0 returns 404 when the actor is not the requester', async () => {
    await expect(rejectProposal('rfp-1', 'someone-else', 'No')).rejects.toMatchObject({ status: 404 });
    expect(mockUpdates).toHaveLength(0);
  });

  it('RJ-0 requires a published proposal', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW });
    await expect(rejectProposal('rfp-1', 'owner-1', 'No')).rejects.toMatchObject({ status: 409, code: 'PROPOSAL_NOT_PUBLISHED' });
  });

  it('RJ-0 refuses to reject a decision summary', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, proposal: { ...PROPOSAL, document: DECISION } });
    await expect(rejectProposal('rfp-1', 'owner-1', 'No')).rejects.toMatchObject({ status: 409, code: 'NOT_REJECTABLE' });
  });

  it('RJ-0 requires a reason', async () => {
    await expect(rejectProposal('rfp-1', 'owner-1', '   ')).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
  });

  it('RJ-0 rejects a second rejection', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...ROW,
      proposal: { ...PROPOSAL, rejection: { rejectedAt: NOW, rejectedBy: 'owner-1', reason: 'No' } },
    });
    await expect(rejectProposal('rfp-1', 'owner-1', 'Still no')).rejects.toMatchObject({ status: 409, code: 'ALREADY_REJECTED' });
  });

  it('RJ-0 refuses to reject an approved proposal', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW, proposal: PROPOSAL, approvedAt: NOW });
    await expect(rejectProposal('rfp-1', 'owner-1', 'No')).rejects.toMatchObject({ status: 409, code: 'ALREADY_APPROVED' });
  });
});

describe('deleteIntakeProject', () => {
  const approvedRow = {
    ...ROW,
    proposal: {
      document: proposalDraft(),
      productOwnerId: 'po-1',
      productOwnerName: 'Pat Owner',
      publishedBy: 'admin-1',
      publishedAt: NOW,
    },
    approvedAt: NOW,
    approvedRepoName: 'benefits-tracker',
    approvedRepoUrl: 'https://dev.azure.com/org/Apex%20-%20Apps/_git/benefits-tracker',
    apexProject: 'Benefits Tracker',
  };

  beforeEach(() => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue(approvedRow);
  });

  it('DP-0 archives the request and removes the project from selection', async () => {
    await deleteIntakeProject('rfp-1', 'admin-1');

    expect(mockDeleteGitRepository).not.toHaveBeenCalled();
    expect(mockDeletes.map((entry) => entry.table)).toEqual([
      projectSkillSettings,
      userProjectAssignments,
      appUserProjectRoles,
      projectMenuSettings,
    ]);
    expect(updatesTo(rfpRequests)[0]).toMatchObject({ status: 'archived' });
    expect(updatesTo(rfpRequests)[0]).not.toHaveProperty('apexProject');
    expect(mockInserts.some((entry) => entry.values.eventType === 'proposal-project-deleted')).toBe(true);
    expect(mockedNotify).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      title: 'Your Apex project was archived',
      link: '/?request=rfp-1',
    }));
  });

  it('DP-0 rejects actors without rfp-intake:manage', async () => {
    mockedCanManage.mockResolvedValue(false);
    await expect(deleteIntakeProject('rfp-1', 'user-9')).rejects.toMatchObject({ status: 403 });
    expect(mockDeleteGitRepository).not.toHaveBeenCalled();
  });

  it('DP-0 returns 409 when the request never created a project', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...ROW });
    await expect(deleteIntakeProject('rfp-1', 'admin-1')).rejects.toMatchObject({ status: 409, code: 'PROJECT_NOT_CREATED' });
  });

  it('DP-0 returns 409 when the request is already archived', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({ ...approvedRow, status: 'archived' });
    await expect(deleteIntakeProject('rfp-1', 'admin-1')).rejects.toMatchObject({ status: 409, code: 'ALREADY_ARCHIVED' });
    expect(mockDeletes).toHaveLength(0);
  });
});

describe('listIntakePrivateProjectNames', () => {
  it('AR-6 returns projects created from approved proposals', async () => {
    mockedDb.query.rfpRequests.findMany.mockResolvedValue([{ apexProject: 'Benefits Tracker' }, { apexProject: null }]);
    await expect(listIntakePrivateProjectNames()).resolves.toEqual(['Benefits Tracker']);
  });
});
