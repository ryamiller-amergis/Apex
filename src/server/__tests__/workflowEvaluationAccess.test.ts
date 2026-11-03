import fs from 'fs';
import path from 'path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import * as rbacService from '../services/rbacService';
import * as userProjectAssignmentService from '../services/userProjectAssignmentService';
import * as superAdminUtils from '../utils/superAdmin';
import * as featureFlagService from '../services/featureFlagService';
import {
  BODY_PROJECT_ERROR,
  MISSING_PROJECT_ERROR,
  requireWorkflowEvaluationFlag,
  workflowEvaluationHubGuard,
  workflowEvaluationReadGuard,
  workflowEvaluationSubmitGuard,
} from '../middleware/workflowEvaluationAccess';
import {
  WORKFLOW_EVALUATION_SUBMIT,
  WORKFLOW_EVALUATION_VIEW,
} from '../../shared/types/workflowEvaluationAccess';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../shared/types/featureFlags';

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));
jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn(),
}));
jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: jest.fn(),
}));
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
  isFeatureOperational: jest.fn(),
}));

const mockGetUserPermissions = rbacService.getUserPermissions as jest.MockedFunction<
  typeof rbacService.getUserPermissions
>;
const mockGetAssignments = userProjectAssignmentService.getAssignmentsForUser as jest.MockedFunction<
  typeof userProjectAssignmentService.getAssignmentsForUser
>;
const mockIsSuperAdmin = superAdminUtils.isSuperAdminRequest as jest.MockedFunction<
  typeof superAdminUtils.isSuperAdminRequest
>;
const mockIsFeatureEnabled = featureFlagService.isFeatureEnabled as jest.MockedFunction<
  typeof featureFlagService.isFeatureEnabled
>;
const mockIsFeatureOperational = featureFlagService.isFeatureOperational as jest.MockedFunction<
  typeof featureFlagService.isFeatureOperational
>;

interface MakeReqOpts {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function makeReq(user: unknown, opts: MakeReqOpts = {}): Request {
  const headers = opts.headers ?? {};
  return {
    user,
    query: opts.query ?? {},
    params: opts.params ?? {},
    body: opts.body ?? {},
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

function makeRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

async function runChain(guards: RequestHandler[], req: Request, res: Response) {
  const terminal = jest.fn();
  let error: unknown;
  let index = 0;
  const pending: Promise<unknown>[] = [];

  function step(err?: unknown): void {
    if (err) {
      error = err;
      return;
    }
    const guard = guards[index];
    index += 1;
    if (!guard) {
      terminal();
      return;
    }
    const invoke = guard as (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void | Promise<void>;
    const result = invoke(req, res, step as NextFunction);
    if (result && typeof result.then === 'function') {
      pending.push(result);
    }
  }

  step();
  while (pending.length > 0) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
  return { terminal, error };
}

const user = { profile: { oid: 'user-1' } };
const bothKeys = new Set([WORKFLOW_EVALUATION_VIEW, WORKFLOW_EVALUATION_SUBMIT]);

describe('workflow evaluation access guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSuperAdmin.mockReturnValue(false);
    mockGetAssignments.mockResolvedValue(['Apex']);
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockIsFeatureOperational.mockResolvedValue(true);
    mockGetUserPermissions.mockResolvedValue(bothKeys);
  });

  it('VT-05 denies submit when the caller holds view only', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set([WORKFLOW_EVALUATION_VIEW]));
    const req = makeReq(user, { headers: { 'x-apex-project': 'Apex' } });
    const res = makeRes();

    const { terminal } = await runChain(workflowEvaluationSubmitGuard, req, res);

    expect(terminal).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      missing: [WORKFLOW_EVALUATION_SUBMIT],
    });
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('VT-06 denies read and submit when the caller holds submit only', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set([WORKFLOW_EVALUATION_SUBMIT]));
    const req = makeReq(user, { headers: { 'x-apex-project': 'Apex' } });
    const readRes = makeRes();
    const submitRes = makeRes();

    const read = await runChain(workflowEvaluationReadGuard, req, readRes);
    const submitReq = makeReq(user, { headers: { 'x-apex-project': 'Apex' } });
    const submit = await runChain(workflowEvaluationSubmitGuard, submitReq, submitRes);

    expect(read.terminal).not.toHaveBeenCalled();
    expect(submit.terminal).not.toHaveBeenCalled();
    expect(readRes.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      missing: [WORKFLOW_EVALUATION_VIEW],
    });
    expect(submitRes.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      missing: [WORKFLOW_EVALUATION_VIEW],
    });
  });

  it('VT-07 uses the project role for Beta and the granted role for Apex', async () => {
    mockGetUserPermissions.mockImplementation(async (_userId, project) => (
      project === 'Apex' ? bothKeys : new Set()
    ));
    mockGetAssignments.mockResolvedValue(['Apex', 'Beta']);

    const betaReq = makeReq(user, { headers: { 'x-apex-project': 'Beta' } });
    const betaRes = makeRes();
    const beta = await runChain(workflowEvaluationSubmitGuard, betaReq, betaRes);

    const apexReq = makeReq(user, { headers: { 'x-apex-project': 'Apex' } });
    const apexRes = makeRes();
    const apex = await runChain(workflowEvaluationSubmitGuard, apexReq, apexRes);

    expect(beta.terminal).not.toHaveBeenCalled();
    expect(betaRes.status).toHaveBeenCalledWith(403);
    expect(apex.terminal).toHaveBeenCalledTimes(1);
    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'Beta');
    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'Apex');
  });

  it('VT-08 rejects a project the caller is not assigned to before the flag check', async () => {
    const req = makeReq(user, { headers: { 'x-apex-project': 'Beta' } });
    const res = makeRes();

    const { terminal } = await runChain(workflowEvaluationReadGuard, req, res);

    expect(terminal).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: not assigned to this project' });
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('VT-09 rejects a body project before permission or flag checks', async () => {
    const req = makeReq(user, {
      headers: { 'x-apex-project': 'Beta' },
      body: { project: 'Apex' },
    });
    const res = makeRes();

    const { terminal } = await runChain(workflowEvaluationSubmitGuard, req, res);

    expect(terminal).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: BODY_PROJECT_ERROR });
    expect(mockGetUserPermissions).not.toHaveBeenCalled();
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('VT-10 passes the read guard when the flag is on for Apex', async () => {
    const req = makeReq(user, { query: { project: 'Apex' } });
    const res = makeRes();

    const { terminal } = await runChain(workflowEvaluationReadGuard, req, res);

    expect(terminal).toHaveBeenCalledTimes(1);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(WORKFLOW_HUMAN_EVALUATION_FLAG, {
      userId: 'user-1',
      project: 'Apex',
    });
  });

  it('VT-11 forwards a flag evaluation error and does not answer the request', async () => {
    const failure = new Error('database unreachable');
    mockIsFeatureEnabled.mockRejectedValue(failure);
    const req = makeReq(user, { query: { project: 'Apex' } });
    const res = makeRes();

    const { terminal, error } = await runChain([requireWorkflowEvaluationFlag], req, res);

    expect(error).toBe(failure);
    expect(terminal).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('VT-12 returns 404 when the flag is off, including for a super admin', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    const memberReq = makeReq(user, { query: { project: 'Apex' } });
    const memberRes = makeRes();
    const member = await runChain(workflowEvaluationReadGuard, memberReq, memberRes);

    mockIsSuperAdmin.mockReturnValue(true);
    const adminReq = makeReq(user, { query: { project: 'Apex' } });
    const adminRes = makeRes();
    const admin = await runChain(workflowEvaluationReadGuard, adminReq, adminRes);

    expect(member.terminal).not.toHaveBeenCalled();
    expect(admin.terminal).not.toHaveBeenCalled();
    expect(memberRes.status).toHaveBeenCalledWith(404);
    expect(memberRes.json).toHaveBeenCalledWith({ error: 'Not found' });
    expect(adminRes.status).toHaveBeenCalledWith(404);
    expect(adminRes.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('answers 400 when the flag guard has no project', async () => {
    const req = makeReq(user);
    const res = makeRes();

    const { terminal } = await runChain([requireWorkflowEvaluationFlag], req, res);

    expect(terminal).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: MISSING_PROJECT_ERROR });
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('VT-13 gates the hub on super admin and an operational flag', async () => {
    const deniedReq = makeReq(user);
    const deniedRes = makeRes();
    const denied = await runChain(workflowEvaluationHubGuard, deniedReq, deniedRes);

    mockIsSuperAdmin.mockReturnValue(true);
    const allowedReq = makeReq(user);
    const allowedRes = makeRes();
    const allowed = await runChain(workflowEvaluationHubGuard, allowedReq, allowedRes);

    mockIsFeatureOperational.mockResolvedValue(false);
    const offReq = makeReq(user);
    const offRes = makeRes();
    const off = await runChain(workflowEvaluationHubGuard, offReq, offRes);

    expect(denied.terminal).not.toHaveBeenCalled();
    expect(deniedRes.status).toHaveBeenCalledWith(403);
    expect(deniedRes.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(allowed.terminal).toHaveBeenCalledTimes(1);
    expect(off.terminal).not.toHaveBeenCalled();
    expect(offRes.status).toHaveBeenCalledWith(404);
    expect(offRes.json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('VT-20 leaves Interview and PRD routes and services free of the guard module', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const files = [
      'src/server/routes/interviews.ts',
      'src/server/services/interviewService.ts',
      'src/server/services/prdService.ts',
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(source).not.toContain('workflowEvaluationAccess');
    }
  });
});
