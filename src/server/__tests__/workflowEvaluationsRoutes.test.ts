/**
 * Workflow evaluation routes — TBI-008 VT-26 through VT-35.
 */
import request from 'supertest';
import express from 'express';

let permissionGranted = true;
let projectAccessGranted = true;
let authenticated = true;
let flagEnabled = true;

jest.mock('../middleware/rbac', () => {
  const actual = jest.requireActual('../middleware/rbac') as {
    resolveRequestProject: (req: express.Request) => string | undefined;
  };
  return {
    requirePermission: (...keys: string[]) =>
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!authenticated || !req.user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        if (!permissionGranted) {
          res.status(403).json({ error: 'Forbidden', missing: keys });
          return;
        }
        next();
      },
    requireProjectAccess: () =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!authenticated) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        if (!projectAccessGranted) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        next();
      },
    resolveRequestProject: actual.resolveRequestProject,
  };
});

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(async () => flagEnabled),
  isFeatureOperational: jest.fn(async () => flagEnabled),
}));

jest.mock('../services/workflowEvaluationService', () => ({
  listEvaluationDefinitions: jest.fn(),
  listEvaluationEvents: jest.fn(),
  submitEvaluation: jest.fn(),
  getEvaluationEvent: jest.fn(),
}));

import workflowEvaluationsRouter from '../routes/workflowEvaluations';

const service = jest.requireMock('../services/workflowEvaluationService') as Record<string, jest.Mock>;

const eventId = '11111111-1111-4111-8111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) {
      (req as express.Request & { user?: unknown }).user = {
        profile: { oid: 'user-1', displayName: 'Ada' },
      };
    }
    next();
  });
  app.use('/api/projects/:projectId/workflow-evaluations', workflowEvaluationsRouter);
  return app;
}

const storedEvent = {
  id: eventId,
  projectId: 'proj-a',
  processKey: 'orchestrated_workflow',
  stageKey: 'prd_human_review',
  definitionId: 'def-1',
  definitionVersion: 1,
  subjectType: 'prd',
  subjectId: '22222222-2222-4222-8222-222222222222',
  phaseIndex: null,
  reviewerUserId: 'user-1',
  reviewerName: 'Ada',
  reviewerRoleKey: 'product_owner',
  reviewerRoleLabel: 'Product owner',
  lineage: {
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillVersion: 'sha',
    model: 'claude',
    interviewId: null,
    prdId: '22222222-2222-4222-8222-222222222222',
  },
  artifactContentHash: 'a'.repeat(64),
  criteria: {
    intent_alignment: 4,
    requirements_coverage: 4,
    scope_alignment: 4,
    acceptance_criteria: 4,
    readiness: 4,
  },
  outcome: 'accept_unchanged',
  reasonCodes: [],
  comment: null,
  hasCorrectedArtifact: true,
  createdAt: '2026-10-16T12:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  permissionGranted = true;
  projectAccessGranted = true;
  authenticated = true;
  flagEnabled = true;
  service.listEvaluationDefinitions.mockResolvedValue({
    definitions: [{
      id: 'def-1',
      version: 1,
      processKey: 'orchestrated_workflow',
      stageKey: 'prd_human_review',
      subjectType: 'prd',
      criteria: [],
      scale: [],
      reasonCodes: [],
      outcomes: [],
      reviewerRoles: [],
      minLowScoreCommentLength: 20,
      correctedArtifactRequiredOutcomes: ['accept_after_edits'],
    }],
    reviewer: { derivedRoleKey: 'product_owner', options: [], requiresSelection: false },
  });
  service.submitEvaluation.mockResolvedValue(storedEvent);
  service.listEvaluationEvents.mockResolvedValue({
    events: [storedEvent],
    truncated: false,
    currentArtifactHash: 'a'.repeat(64),
  });
  service.getEvaluationEvent.mockResolvedValue({ ...storedEvent, jobs: [] });
});

describe('workflow evaluation routes — TBI-008', () => {
  it('VT-26 / TBI-008 (a): definitions, create, list and one event answer with the shared shapes', async () => {
    const app = buildApp();
    const definitions = await request(app).get('/api/projects/proj-a/workflow-evaluations/definitions');
    expect(definitions.status).toBe(200);
    expect(definitions.body.definitions[0]).not.toHaveProperty('promptfooSuiteRef');
    expect(definitions.body.definitions[0]).not.toHaveProperty('judgeOutputSchema');
    expect(definitions.body.reviewer.derivedRoleKey).toBe('product_owner');

    const created = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({
        subjectType: 'prd',
        subjectId: storedEvent.subjectId,
        stageKey: 'prd_human_review',
        criteria: storedEvent.criteria,
        outcome: 'accept_unchanged',
      });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe(eventId);

    const listed = await request(app).get(
      `/api/projects/proj-a/workflow-evaluations/events?subjectType=prd&subjectId=${storedEvent.subjectId}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.events).toHaveLength(1);

    const one = await request(app).get(`/api/projects/proj-a/workflow-evaluations/events/${eventId}`);
    expect(one.status).toBe(200);
    expect(one.body.jobs).toEqual([]);
  });

  it('VT-27 / TBI-008 (b): missing permission is 403 and an anonymous caller is 401', async () => {
    const app = buildApp();
    permissionGranted = false;
    const denied = await request(app).get('/api/projects/proj-a/workflow-evaluations/definitions');
    expect(denied.status).toBe(403);

    authenticated = false;
    permissionGranted = true;
    const anonymous = await request(app).get('/api/projects/proj-a/workflow-evaluations/definitions');
    expect(anonymous.status).toBe(401);
    expect(service.listEvaluationDefinitions).not.toHaveBeenCalled();
  });

  it('VT-28 / TBI-008 (b): a flag that is off returns 404 and does not call the service', async () => {
    flagEnabled = false;
    const app = buildApp();
    for (const path of [
      '/api/projects/proj-a/workflow-evaluations/definitions',
      `/api/projects/proj-a/workflow-evaluations/events?subjectType=prd&subjectId=${storedEvent.subjectId}`,
      `/api/projects/proj-a/workflow-evaluations/events/${eventId}`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not found' });
    }
    const created = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({ subjectType: 'prd', subjectId: storedEvent.subjectId, stageKey: 'prd_human_review' });
    expect(created.status).toBe(404);
    expect(service.listEvaluationDefinitions).not.toHaveBeenCalled();
    expect(service.listEvaluationEvents).not.toHaveBeenCalled();
    expect(service.submitEvaluation).not.toHaveBeenCalled();
    expect(service.getEvaluationEvent).not.toHaveBeenCalled();
  });

  it('VT-29 / TBI-008 (b): a malformed body is 422, and a bad or unknown event id is 404', async () => {
    const { WorkflowEvaluationError } = jest.requireActual('../services/workflowEvaluationError') as {
      WorkflowEvaluationError: new (code: string, message: string) => Error;
    };
    service.submitEvaluation.mockRejectedValueOnce(new WorkflowEvaluationError('INVALID_SCORES', 'Scores are invalid.'));
    const app = buildApp();
    const malformed = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({ subjectType: 'prd' });
    expect(malformed.status).toBe(422);
    expect(malformed.body.code).toBe('INVALID_SCORES');

    const badId = await request(app).get('/api/projects/proj-a/workflow-evaluations/events/not-a-uuid');
    expect(badId.status).toBe(404);
    expect(service.getEvaluationEvent).not.toHaveBeenCalled();

    service.getEvaluationEvent.mockResolvedValueOnce(null);
    const unknown = await request(app).get(`/api/projects/proj-a/workflow-evaluations/events/${eventId}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'Not found' });
  });

  it('VT-30 / TBI-008 (c): includeOlder and stageKey are forwarded and limit is ignored', async () => {
    service.listEvaluationEvents.mockResolvedValue({
      events: [storedEvent],
      truncated: true,
      currentArtifactHash: null,
    });
    const app = buildApp();
    const older = await request(app).get(
      `/api/projects/proj-a/workflow-evaluations/events?subjectType=prd&subjectId=${storedEvent.subjectId}&includeOlder=true&stageKey=prd_human_review&limit=500`,
    );
    expect(older.status).toBe(200);
    expect(older.body.truncated).toBe(true);
    expect(service.listEvaluationEvents).toHaveBeenCalledWith('proj-a', {
      subjectType: 'prd',
      subjectId: storedEvent.subjectId,
      stageKey: 'prd_human_review',
      includeOlderVersions: true,
    });

    await request(app).get(
      `/api/projects/proj-a/workflow-evaluations/events?subjectType=prd&subjectId=${storedEvent.subjectId}&includeOlder=false`,
    );
    expect(service.listEvaluationEvents).toHaveBeenLastCalledWith('proj-a', expect.objectContaining({
      includeOlderVersions: false,
    }));
    expect(JSON.stringify(service.listEvaluationEvents.mock.calls)).not.toContain('500');
  });

  it('VT-31 / TBI-008 (d): a query, body or header project that differs from the path is 400', async () => {
    const app = buildApp();
    const query = await request(app).get(
      `/api/projects/proj-a/workflow-evaluations/events?project=proj-b&subjectType=prd&subjectId=${storedEvent.subjectId}`,
    );
    const body = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({ project: 'proj-b', subjectType: 'prd' });
    const header = await request(app)
      .get(`/api/projects/proj-a/workflow-evaluations/events?subjectType=prd&subjectId=${storedEvent.subjectId}`)
      .set('x-apex-project', 'proj-b');
    expect(query.status).toBe(400);
    expect(body.status).toBe(400);
    expect(header.status).toBe(400);
    expect(service.listEvaluationEvents).not.toHaveBeenCalled();
    expect(service.submitEvaluation).not.toHaveBeenCalled();
  });

  it('VT-32 / TBI-008 (d): a caller who is not assigned to the project is 403', async () => {
    projectAccessGranted = false;
    const app = buildApp();
    const response = await request(app).get('/api/projects/proj-a/workflow-evaluations/definitions');
    expect(response.status).toBe(403);
    expect(service.listEvaluationDefinitions).not.toHaveBeenCalled();
  });

  it('VT-33 / TBI-008 (d): lineage, hash, reviewer id and project are unknown fields', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({
        subjectType: 'prd',
        subjectId: storedEvent.subjectId,
        stageKey: 'prd_human_review',
        project: 'proj-a',
        lineage: { skillPath: 'forged' },
        artifactContentHash: 'abc',
        reviewerUserId: 'someone-else',
      });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('UNKNOWN_FIELD');
    expect(response.body.error).toContain('lineage');
    expect(response.body.error).toContain('artifactContentHash');
    expect(response.body.error).toContain('reviewerUserId');
    expect(response.body.error).toContain('project');
    expect(service.submitEvaluation).not.toHaveBeenCalled();
  });

  it('VT-34 / TBI-008 (d): an event outside the path project is 404 with no event fields', async () => {
    service.getEvaluationEvent.mockResolvedValue(null);
    const app = buildApp();
    const response = await request(app).get(`/api/projects/proj-a/workflow-evaluations/events/${eventId}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
    expect(service.getEvaluationEvent).toHaveBeenCalledWith('proj-a', eventId);
  });

  it('VT-35 / TBI-008 (d): responses report a corrected artifact without a blob path', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/projects/proj-a/workflow-evaluations/events')
      .send({
        subjectType: 'prd',
        subjectId: storedEvent.subjectId,
        stageKey: 'prd_human_review',
        outcome: 'accept_after_edits',
      });
    const one = await request(app).get(`/api/projects/proj-a/workflow-evaluations/events/${eventId}`);
    for (const response of [created, one]) {
      expect(response.body.hasCorrectedArtifact).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('workflow-evaluations/');
      expect(response.body).not.toHaveProperty('correctedArtifactBlobRef');
    }
  });
});
