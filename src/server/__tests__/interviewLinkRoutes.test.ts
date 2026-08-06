/**
 * Route integration tests for Interview link endpoints (FEAT-001 / TBI-002).
 * Covers VT-01, VT-03, VT-05, VT-06, VT-08 and RBAC wiring.
 */

import request from 'supertest';
import express from 'express';

const mockGetLinkedContext = jest.fn();
const mockListCandidates = jest.fn();
const mockListProjectCandidates = jest.fn();
const mockAddAdrLink = jest.fn();
const mockAddDesignModuleLink = jest.fn();
const mockRemoveAdrLink = jest.fn();
const mockRemoveDesignModuleLink = jest.fn();

jest.mock('../services/interviewLinkService', () => ({
  getLinkedContext: (...a: unknown[]) => mockGetLinkedContext(...a),
  listCandidates: (...a: unknown[]) => mockListCandidates(...a),
  listProjectCandidates: (...a: unknown[]) => mockListProjectCandidates(...a),
  addAdrLink: (...a: unknown[]) => mockAddAdrLink(...a),
  addDesignModuleLink: (...a: unknown[]) => mockAddDesignModuleLink(...a),
  removeAdrLink: (...a: unknown[]) => mockRemoveAdrLink(...a),
  removeDesignModuleLink: (...a: unknown[]) => mockRemoveDesignModuleLink(...a),
}));

jest.mock('../services/interviewService', () => ({
  createInterview: jest.fn(),
  deleteInterview: jest.fn(),
  getInterview: jest.fn(),
  listInterviews: jest.fn(),
  updateInterviewStatus: jest.fn(),
  updateInterviewTitle: jest.fn(),
}));

jest.mock('../services/prdService', () => ({}));
jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn(),
  readOutputBacklog: jest.fn(),
  readOutputDesignDoc: jest.fn(),
  readOutputTechSpec: jest.fn(),
  readOutputAssumptions: jest.fn(),
  readOutputValidationScorecard: jest.fn(),
  readOutputValidationScorecardMd: jest.fn(),
  createThread: jest.fn(),
  sendMessage: jest.fn(),
  updateThreadKickoffContext: jest.fn(),
}));
jest.mock('../services/designDocService', () => ({}));
jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn(),
  getAssignments: jest.fn(),
  getAvailableApprovers: jest.fn(),
  isApprovalComplete: jest.fn(),
  isAssignedApprover: jest.fn(),
  reassignApprovers: jest.fn(),
  recordApproverResponse: jest.fn(),
}));
jest.mock('../services/ownerApprovalService', () => ({}));
jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/designPlanService', () => ({
  generateDesignPlan: jest.fn(),
}));
jest.mock('../services/projectSettingsService', () => ({
  getApproverPoolForProject: jest.fn(),
  resolveSkillConfig: jest.fn(),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));
jest.mock('../services/rbacService', () => ({
  getActiveUsers: jest.fn(),
}));
jest.mock('../services/testCaseService', () => ({
  getTestCases: jest.fn(),
  recalculateTestCaseCoverage: jest.fn(),
  triggerTestCaseGeneration: jest.fn(),
}));
jest.mock('../services/bedrockService', () => ({
  fixPrdContentWithBedrock: jest.fn(),
  fixPrdBacklogWithBedrock: jest.fn(),
  fixDesignDocSectionWithBedrock: jest.fn(),
  regeneratePrdContentRegionWithBedrock: jest.fn(),
  regeneratePrdBacklogItemWithBedrock: jest.fn(),
  regenerateMarkdownRegionWithBedrock: jest.fn(),
  BedrockModelTruncatedError: class BedrockModelTruncatedError extends Error {},
}));
jest.mock('../services/reviewCommentService', () => ({
  getComments: jest.fn(),
}));
jest.mock('../services/threadAccessService', () => ({
  canCreateDesignDocAssistantThread: jest.fn(),
}));
jest.mock('../services/documentValidationService', () => ({
  generateFallbackReport: jest.fn(),
}));
jest.mock('../services/adoUserToken', () => ({
  getAdoTokenForUser: jest.fn(),
}));
jest.mock('../services/adoFactory', () => ({
  isAdoUserAuthError: jest.fn(),
}));
jest.mock('../db/drizzle', () => ({
  db: {
    query: {},
    select: jest.fn(),
    update: jest.fn(),
  },
}));

const permissionKeys: string[] = [];
const groupRequirements: string[][] = [];
jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) => {
    permissionKeys.push(...keys);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireGroupMembership: (...groups: string[]) => {
    groupRequirements.push(groups);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  attachPermissions: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
  getDisplayName: jest.fn().mockReturnValue('Test User'),
}));

import interviewRouter from '../routes/interviews';
import { InterviewLinkError } from '../../shared/types/interviewLinks';

/** Snapshot of keys registered when interviews router module loaded. */
const registeredPermissions = [...permissionKeys];
const registeredGroupRequirements = [...groupRequirements];

const INTERVIEW_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interviews', interviewRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Interview link routes — RBAC registration (TBI-002 DoD)', () => {
  it('registers view permission on link reads when router loads', () => {
    expect(registeredPermissions).toEqual(
      expect.arrayContaining(['interviews:view', 'interviews:manage']),
    );
  });
});

describe('GET /api/interviews/:id/links', () => {
  it('VT-05 / AC-0: returns linked context read model', async () => {
    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [
        {
          adrId: ADR_ID,
          title: 'ADR One',
          isAccepted: true,
          linkedBy: 'user-test',
          linkedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
      designModuleLinks: [],
      count: 1,
      capacity: 10,
    });

    const res = await request(buildApp()).get(`/api/interviews/${INTERVIEW_ID}/links`);
    expect(res.status).toBe(200);
    expect(res.body.adrLinks[0].isAccepted).toBe(true);
    expect(res.body.count).toBe(1);
  });

  it('VT-06 / AC-1: returns non-2xx without partial current data when read fails', async () => {
    mockGetLinkedContext.mockRejectedValue(new Error('db down'));
    const app = buildApp();
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get(`/api/interviews/${INTERVIEW_ID}/links`);
    expect(res.status).toBe(500);
    expect(res.body.adrLinks).toBeUndefined();
    expect(res.body.designModuleLinks).toBeUndefined();
  });

  it('VT-08 / AC-3: maps PROJECT_FORBIDDEN to 403 with no artifact metadata', async () => {
    mockGetLinkedContext.mockRejectedValue(
      new InterviewLinkError('PROJECT_FORBIDDEN', 'You do not have access to this Interview\'s project'),
    );

    const res = await request(buildApp()).get(`/api/interviews/${INTERVIEW_ID}/links`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROJECT_FORBIDDEN');
    expect(res.body.adrLinks).toBeUndefined();
    expect(res.body.error).toMatch(/access/i);
  });
});

describe('POST /api/interviews/:id/links/adr', () => {
  it('VT-01 / AC-0: returns 200 with mutation result', async () => {
    mockAddAdrLink.mockResolvedValue({
      linkedContext: {
        interviewId: INTERVIEW_ID,
        adrLinks: [
          {
            adrId: ADR_ID,
            title: 'ADR One',
            isAccepted: true,
            linkedBy: 'user-test',
            linkedAt: '2026-08-05T00:00:00.000Z',
          },
        ],
        designModuleLinks: [],
        count: 1,
        capacity: 10,
      },
    });

    const res = await request(buildApp())
      .post(`/api/interviews/${INTERVIEW_ID}/links/adr`)
      .send({ adrId: ADR_ID });

    expect(res.status).toBe(200);
    expect(res.body.linkedContext.count).toBe(1);
    expect(mockAddAdrLink).toHaveBeenCalledWith(
      INTERVIEW_ID,
      expect.objectContaining({ userId: 'user-test' }),
      { adrId: ADR_ID },
    );
  });

  it('VT-03 / AC-2: maps LINK_DUPLICATE to 409', async () => {
    mockAddAdrLink.mockRejectedValue(
      new InterviewLinkError('LINK_DUPLICATE', 'This artifact is already linked to the Interview'),
    );

    const res = await request(buildApp())
      .post(`/api/interviews/${INTERVIEW_ID}/links/adr`)
      .send({ adrId: ADR_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LINK_DUPLICATE');
    expect(res.body.error).toMatch(/already linked/i);
  });

  it('VT-02 / AC-1: maps LINK_CAP_EXCEEDED to 409', async () => {
    mockAddAdrLink.mockRejectedValue(
      new InterviewLinkError('LINK_CAP_EXCEEDED', 'An Interview may have at most 10 linked artifacts'),
    );

    const res = await request(buildApp())
      .post(`/api/interviews/${INTERVIEW_ID}/links/adr`)
      .send({ adrId: ADR_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LINK_CAP_EXCEEDED');
  });

  it('VT-04 / AC-3: maps ADR_NOT_ACCEPTED to 422', async () => {
    mockAddAdrLink.mockRejectedValue(
      new InterviewLinkError('ADR_NOT_ACCEPTED', 'Only accepted ADRs can be newly linked'),
    );

    const res = await request(buildApp())
      .post(`/api/interviews/${INTERVIEW_ID}/links/adr`)
      .send({ adrId: ADR_ID });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ADR_NOT_ACCEPTED');
  });
});

describe('GET /api/interviews/:id/link-candidates', () => {
  it('returns paginated candidates with offset/limit', async () => {
    mockListCandidates.mockResolvedValue({
      items: [{ type: 'adr', id: ADR_ID, title: 'ADR One', status: 'accepted' }],
      total: 1,
      offset: 0,
      limit: 50,
    });

    const res = await request(buildApp())
      .get(`/api/interviews/${INTERVIEW_ID}/link-candidates`)
      .query({ type: 'adr', offset: 0, limit: 50 });

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.items).toHaveLength(1);
  });

  it('rejects missing type', async () => {
    const res = await request(buildApp()).get(`/api/interviews/${INTERVIEW_ID}/link-candidates`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/interviews/link-candidates — kickoff staging', () => {
  it('DoD-2 / BR-002: uses the creation groups and delegates project scope to the service', async () => {
    mockListProjectCandidates.mockResolvedValue({
      items: [{ type: 'adr', id: ADR_ID, title: 'ADR One', status: 'accepted' }],
      total: 1,
      offset: 0,
      limit: 50,
    });

    const res = await request(buildApp())
      .get('/api/interviews/link-candidates')
      .query({ project: 'Apex', type: 'adr', offset: 0, limit: 50 });

    expect(res.status).toBe(200);
    expect(mockListProjectCandidates).toHaveBeenCalledWith(
      'Apex',
      expect.objectContaining({ userId: 'user-test' }),
      { type: 'adr', search: undefined, offset: 0, limit: 50 },
    );
    expect(
      registeredGroupRequirements.filter(
        (groups) => groups.join('|') === 'BA|Manager|Product-Owner',
      ),
    ).toHaveLength(2);
  });
});

describe('DELETE link endpoints', () => {
  it('removes ADR link', async () => {
    mockRemoveAdrLink.mockResolvedValue({
      linkedContext: {
        interviewId: INTERVIEW_ID,
        adrLinks: [],
        designModuleLinks: [],
        count: 0,
        capacity: 10,
      },
    });

    const res = await request(buildApp()).delete(
      `/api/interviews/${INTERVIEW_ID}/links/adr/${ADR_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.linkedContext.count).toBe(0);
  });

  it('removes Design Module link', async () => {
    mockRemoveDesignModuleLink.mockResolvedValue({
      linkedContext: {
        interviewId: INTERVIEW_ID,
        adrLinks: [],
        designModuleLinks: [],
        count: 0,
        capacity: 10,
      },
    });

    const res = await request(buildApp()).delete(
      `/api/interviews/${INTERVIEW_ID}/links/design-module/${ADR_ID}`,
    );
    expect(res.status).toBe(200);
  });
});
