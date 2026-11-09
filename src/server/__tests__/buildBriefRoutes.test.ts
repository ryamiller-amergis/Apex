/**
 * FEAT-006 S2 + S5 — brief routes for build-intake and non-build interviews.
 *
 * The real guards (`middleware/buildIntakeBrief.ts`, `services/buildIntakeAccess.ts`) run; the brief
 * services are mocked. `requirePermission` / `requireGroupMembership` refuse unless the test grants them,
 * so the non-build path proves it still runs today's middleware.
 */
import request from 'supertest';
import express from 'express';
import interviewRouter from '../routes/interviews';
import * as interviewService from '../services/interviewService';

jest.mock('../services/interviewService');
jest.mock('../services/prdService');
jest.mock('../services/interviewBriefService', () => {
  class InterviewBriefError extends Error {
    constructor(message: string, readonly statusCode = 400) { super(message); }
  }
  return {
    InterviewBriefError,
    getInterviewBrief: jest.fn(),
    saveInterviewBrief: jest.fn(),
    approveInterviewBrief: jest.fn(),
    getApprovedInterviewBriefForPrd: jest.fn().mockResolvedValue(null),
    formatInterviewBriefForPrd: jest.fn().mockReturnValue('# Approved Interview Brief'),
  };
});
jest.mock('../services/interviewOrchestratorService', () => ({
  draftInterviewBriefSections: jest.fn(),
}));
jest.mock('../services/buildBriefService', () => {
  class BuildBriefError extends Error {
    constructor(message: string, readonly statusCode: number, options?: { draftFailed?: boolean }) {
      super(message);
      this.draftFailed = options?.draftFailed ?? false;
    }
    readonly draftFailed: boolean;
  }
  return {
    BuildBriefError,
    BUILD_BRIEF_FORBIDDEN_MESSAGE: 'Only the requester, a Project Admin or a Platform Admin can change or approve this brief.',
    approveBuildBrief: jest.fn(),
    draftBuildBrief: jest.fn(),
    saveBuildBrief: jest.fn(),
    getBuildBriefAnalysis: jest.fn(),
    getRedactedBuildBrief: jest.fn(),
  };
});
jest.mock('../services/buildAccessService', () => ({
  isBuildFromPromptEnabled: jest.fn(),
}));
jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  createThread: jest.fn(),
  sendMessage: jest.fn(),
  getThreadAsync: jest.fn().mockResolvedValue(null),
  updateThreadKickoffTranscript: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/designDocService');
jest.mock('../services/documentApprovalService');
jest.mock('../services/reviewerAvailabilityService', () => ({ resolveReviewerAvailability: jest.fn() }));
jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn(),
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('../services/ownerApprovalService', () => ({
  getOwnerApproval: jest.fn(),
  isDocumentOwner: jest.fn(),
  recordOwnerApproval: jest.fn(),
}));
jest.mock('../services/artifactDoneEventService', () => ({ recordArtifactDoneEvent: jest.fn() }));
jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
  isProjectAdmin: jest.fn(),
  isPlatformAdmin: jest.fn(),
}));
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: jest.fn().mockReturnValue(false) }));
jest.mock('../services/designPlanService', () => ({ generateDesignPlan: jest.fn() }));
jest.mock('../services/designPrototypeService', () => ({
  getUnresolvedCommentCount: jest.fn().mockResolvedValue(0),
  triggerDesignDocForPrototype: jest.fn(),
}));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
  resolveSkillConfig: jest.fn().mockResolvedValue(null),
  getSkillSettingsName: jest.fn().mockResolvedValue(null),
  getApproverPoolForProject: jest.fn(),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('model'),
  getAppSetting: jest.fn().mockResolvedValue(null),
  setAppSetting: jest.fn(),
}));
jest.mock('../services/rbacService', () => ({
  getActiveUsers: jest.fn(),
  getUserPermissions: jest.fn(),
}));
jest.mock('../services/groupService', () => ({ getUserGroupNames: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/testCaseService', () => ({ getTestCases: jest.fn(), triggerTestCaseGeneration: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({
  isProjectRepositoryCheckoutReadinessEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/projectRepositoryReadinessService', () => ({
  assertResolvedProjectRepositoryReady: jest.fn(),
  ProjectRepositoryNotReady: class ProjectRepositoryNotReady extends Error {},
}));
jest.mock('../services/bedrockService', () => ({
  BedrockModelTruncatedError: class BedrockModelTruncatedError extends Error {},
}));
jest.mock('../services/designSystemService', () => ({
  getScreenInventory: jest.fn().mockResolvedValue([]),
  fetchExistingPageContext: jest.fn().mockResolvedValue(''),
}));
jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn() },
      prds: { findFirst: jest.fn() },
      designPlans: { findFirst: jest.fn() },
      designDocs: { findFirst: jest.fn() },
      designPrototypes: { findFirst: jest.fn() },
    },
  },
}));

const granted = new Set<string>();
jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (keys.every((key) => granted.has(key))) next();
    else res.status(403).json({ error: 'Forbidden', missing: keys });
  },
  requireAnyPermission: (...keys: string[]) => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (keys.some((key) => granted.has(key))) next();
    else res.status(403).json({ error: 'Forbidden', missing: keys });
  },
  requireGroupMembership: (...groups: string[]) => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (groups.some((group) => granted.has(`group:${group}`))) next();
    else res.status(403).json({ error: 'Group required' });
  },
  attachPermissions: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveRequestProject: () => undefined,
}));

let currentUser = 'requester';
jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn(() => currentUser),
  getDisplayName: jest.fn().mockReturnValue('Test User'),
}));

const { db } = jest.requireMock('../db/drizzle') as { db: { query: { interviews: { findFirst: jest.Mock } } } };
const briefService = jest.requireMock('../services/buildBriefService') as {
  BuildBriefError: new (message: string, statusCode: number, options?: { draftFailed?: boolean }) => Error;
  approveBuildBrief: jest.Mock;
  draftBuildBrief: jest.Mock;
  saveBuildBrief: jest.Mock;
  getBuildBriefAnalysis: jest.Mock;
  getRedactedBuildBrief: jest.Mock;
};
const interviewBriefService = jest.requireMock('../services/interviewBriefService') as {
  saveInterviewBrief: jest.Mock;
  approveInterviewBrief: jest.Mock;
  getInterviewBrief: jest.Mock;
};
const { isBuildFromPromptEnabled } = jest.requireMock('../services/buildAccessService') as { isBuildFromPromptEnabled: jest.Mock };
const { isProjectAdmin, isPlatformAdmin } = jest.requireMock('../utils/rbacHelpers') as {
  isProjectAdmin: jest.Mock;
  isPlatformAdmin: jest.Mock;
};
const { getUserPermissions } = jest.requireMock('../services/rbacService') as { getUserPermissions: jest.Mock };
const mockInterviewService = interviewService as jest.Mocked<typeof interviewService>;

const buildRow = { id: 'iv-1', project: 'proj-a', authorId: 'requester', playbookProfileKey: 'build-intake' };
const plainRow = { ...buildRow, playbookProfileKey: 'grill-with-docs' };
const sections = {
  problemAndOutcome: 'p', users: 'u', scope: 's', businessRules: '', scenarios: 'sc',
  acceptanceCriteria: '', assumptions: '', unresolvedItems: [],
};

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/interviews', interviewRouter);
  server.use((err: { message?: string }, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
    res.status(500).json({ error: err.message ?? 'Internal server error' });
  });
  return server;
}

beforeEach(() => {
  jest.clearAllMocks();
  granted.clear();
  currentUser = 'requester';
  db.query.interviews.findFirst.mockResolvedValue(buildRow);
  isBuildFromPromptEnabled.mockResolvedValue(true);
  isProjectAdmin.mockImplementation(async (userId: string, project: string) => userId === 'pa-1' && project === 'proj-a');
  isPlatformAdmin.mockImplementation(async (userId: string) => userId === 'platform-1');
  getUserPermissions.mockResolvedValue(new Set());
});

describe('VT-09 — non-build interviews keep today\'s middleware (TBI-010 DoD-2, DoD-3)', () => {
  beforeEach(() => db.query.interviews.findFirst.mockResolvedValue(plainRow));

  it('VT-09 refuses a member without the BA group on PUT and draft', async () => {
    granted.add('interviews:manage');
    const put = await request(app()).put('/api/interviews/iv-1/brief').send({ sections });
    const draft = await request(app()).post('/api/interviews/iv-1/brief/draft');
    expect(put.status).toBe(403);
    expect(draft.status).toBe(403);
    expect(interviewBriefService.saveInterviewBrief).not.toHaveBeenCalled();
    expect(briefService.saveBuildBrief).not.toHaveBeenCalled();
  });

  it('VT-09 still saves for a BA with interviews:manage', async () => {
    granted.add('interviews:manage');
    granted.add('group:BA');
    interviewBriefService.saveInterviewBrief.mockResolvedValue({ id: 'b', version: 2 });
    const put = await request(app()).put('/api/interviews/iv-1/brief').send({ sections });
    expect(put.status).toBe(200);
    expect(briefService.saveBuildBrief).not.toHaveBeenCalled();
  });

  it('VT-21 analysis returns 404 for a non-build interview', async () => {
    const res = await request(app()).get('/api/interviews/iv-1/brief/analysis');
    expect(res.status).toBe(404);
    expect(briefService.getBuildBriefAnalysis).not.toHaveBeenCalled();
  });
});

describe('build-intake save and draft', () => {
  it('VT-10 the requester saves without interviews:manage or a group (PBI-012 AC-2)', async () => {
    briefService.saveBuildBrief.mockResolvedValue({ id: 'b', version: 2 });
    const requirements = [{ id: 'AC-1', kind: 'ac', text: 'Edited' }];
    const res = await request(app()).put('/api/interviews/iv-1/brief').send({ sections, requirements });
    expect(res.status).toBe(200);
    expect(briefService.saveBuildBrief).toHaveBeenCalledWith({ interviewId: 'iv-1', actorId: 'requester', sections, requirements });
  });

  it('PBI-012 AC-2 a Project Admin with no group edits', async () => {
    currentUser = 'pa-1';
    briefService.saveBuildBrief.mockResolvedValue({ id: 'b', version: 2 });
    const res = await request(app()).put('/api/interviews/iv-1/brief').send({ sections, requirements: [] });
    expect(res.status).toBe(200);
  });

  it('VT-17 draft failure returns 502 with the plain retry message', async () => {
    briefService.draftBuildBrief.mockRejectedValue(new briefService.BuildBriefError('The brief could not be drafted. Try again, or keep chatting and draft it later.', 502, { draftFailed: true }));
    const res = await request(app()).post('/api/interviews/iv-1/brief/draft');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: expect.stringMatching(/Try again/), draftFailed: true });
  });
});

describe('build-intake approve', () => {
  it('VT-11 refuses a BA who is not the requester or an admin (PBI-011 AC-3)', async () => {
    currentUser = 'ba-1';
    granted.add('interviews:manage');
    granted.add('group:BA');
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.status).toBe(403);
    expect(briefService.approveBuildBrief).not.toHaveBeenCalled();
    expect(interviewBriefService.approveInterviewBrief).not.toHaveBeenCalled();
  });

  it('VT-12 refuses a Project Admin of another project (PBI-012 AC-1)', async () => {
    currentUser = 'pa-other';
    isProjectAdmin.mockImplementation(async (userId: string, project: string) => userId === 'pa-other' && project === 'proj-b');
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.status).toBe(403);
    expect(isProjectAdmin).toHaveBeenCalledWith('pa-other', 'proj-a');
  });

  it('VT-13 a Project Admin approves for the requester (PBI-012 AC-0)', async () => {
    currentUser = 'pa-1';
    briefService.approveBuildBrief.mockResolvedValue({ version: 2, resumed: true, alreadyApproved: false, classification: { value: 'small', reasons: [] } });
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.status).toBe(200);
    expect(briefService.approveBuildBrief).toHaveBeenCalledWith({ interviewId: 'iv-1', actorId: 'pa-1' });
    expect(interviewBriefService.approveInterviewBrief).not.toHaveBeenCalled();
  });

  it('VT-14 passes alreadyApproved through (PBI-012 AC-3)', async () => {
    briefService.approveBuildBrief.mockResolvedValue({ version: 2, resumed: false, alreadyApproved: true });
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.body.alreadyApproved).toBe(true);
  });

  it('VT-16 no acceptance criterion returns 400 with the plain message', async () => {
    briefService.approveBuildBrief.mockRejectedValue(new briefService.BuildBriefError('Add at least one acceptance criterion before you approve.', 400));
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Add at least one acceptance criterion before you approve.');
  });

  it('VT-23 an approval write failure returns 500 with the plain message', async () => {
    briefService.approveBuildBrief.mockRejectedValue(new briefService.BuildBriefError('The brief was not approved. Nothing changed. Try again.', 500));
    const res = await request(app()).post('/api/interviews/iv-1/brief/approve');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('The brief was not approved. Nothing changed. Try again.');
  });
});

describe('VT-20 — flag off refuses changes and keeps reads open', () => {
  beforeEach(() => {
    isBuildFromPromptEnabled.mockResolvedValue(false);
    getUserPermissions.mockResolvedValue(new Set(['builds:view']));
    granted.add('interviews:view');
    briefService.getRedactedBuildBrief.mockResolvedValue({ id: 'b' });
    briefService.getBuildBriefAnalysis.mockResolvedValue({ interviewId: 'iv-1' });
  });

  it('VT-20 PUT, draft and approve return 403 with the plain message and change nothing', async () => {
    const put = await request(app()).put('/api/interviews/iv-1/brief').send({ sections, requirements: [] });
    const draft = await request(app()).post('/api/interviews/iv-1/brief/draft');
    const approve = await request(app()).post('/api/interviews/iv-1/brief/approve');
    for (const res of [put, draft, approve]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Build from prompt is turned off for this project. Ask a Platform Admin to turn it back on.');
    }
    expect(briefService.saveBuildBrief).not.toHaveBeenCalled();
    expect(briefService.draftBuildBrief).not.toHaveBeenCalled();
    expect(briefService.approveBuildBrief).not.toHaveBeenCalled();
  });

  it('VT-20 both GET routes still return 200', async () => {
    const brief = await request(app()).get('/api/interviews/iv-1/brief');
    const analysis = await request(app()).get('/api/interviews/iv-1/brief/analysis');
    expect(brief.status).toBe(200);
    expect(analysis.status).toBe(200);
  });
});

describe('VT-21 — reading the brief and its risk decisions (PBI-013 AC-0, d2)', () => {
  beforeEach(() => {
    currentUser = 'dev-1';
    granted.add('interviews:view');
  });

  it('VT-21 a builds:view holder reads the redacted brief and the analysis', async () => {
    getUserPermissions.mockResolvedValue(new Set(['builds:view']));
    briefService.getRedactedBuildBrief.mockResolvedValue({ id: 'b' });
    briefService.getBuildBriefAnalysis.mockResolvedValue({ riskDecisions: [] });
    const brief = await request(app()).get('/api/interviews/iv-1/brief');
    const analysis = await request(app()).get('/api/interviews/iv-1/brief/analysis');
    expect(brief.status).toBe(200);
    expect(analysis.status).toBe(200);
    expect(getUserPermissions).toHaveBeenCalledWith('dev-1', 'proj-a');
    expect(interviewBriefService.getInterviewBrief).not.toHaveBeenCalled();
  });

  it('VT-21 a user without builds:view receives 403 and nothing is shown', async () => {
    const brief = await request(app()).get('/api/interviews/iv-1/brief');
    const analysis = await request(app()).get('/api/interviews/iv-1/brief/analysis');
    expect(brief.status).toBe(403);
    expect(analysis.status).toBe(403);
    expect(briefService.getRedactedBuildBrief).not.toHaveBeenCalled();
    expect(briefService.getBuildBriefAnalysis).not.toHaveBeenCalled();
  });

  it('PBI-011 AC-1 analysis 404 carries draftFailed', async () => {
    getUserPermissions.mockResolvedValue(new Set(['builds:view']));
    briefService.getBuildBriefAnalysis.mockRejectedValue(new briefService.BuildBriefError('The brief has not been drafted yet.', 404, { draftFailed: true }));
    const res = await request(app()).get('/api/interviews/iv-1/brief/analysis');
    expect(res.status).toBe(404);
    expect(res.body.draftFailed).toBe(true);
  });
});

describe('VT-25 — a build request never creates a PRD (U6)', () => {
  it('VT-25 returns 409 for a build-intake interview', async () => {
    mockInterviewService.getInterview.mockResolvedValue({ id: 'iv-1', playbookProfileKey: 'build-intake' } as never);
    const res = await request(app()).post('/api/interviews/iv-1/prds').send({ chatThreadId: 'thread-1' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Build requests do not create a PRD.');
    expect(mockInterviewService.canCompleteInterviewAndGeneratePrd).not.toHaveBeenCalled();
  });

  it('VT-25 leaves a non-build interview on the existing checks', async () => {
    mockInterviewService.getInterview.mockResolvedValue({ id: 'iv-1', playbookProfileKey: null } as never);
    mockInterviewService.canCompleteInterviewAndGeneratePrd.mockResolvedValue(false);
    const res = await request(app()).post('/api/interviews/iv-1/prds').send({ chatThreadId: 'thread-1' });
    expect(res.status).toBe(403);
  });
});
