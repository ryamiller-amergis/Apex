/**
 * FEAT-007 / S5 — definition lifecycle HTTP transport.
 *
 * The permission source is mocked but `requirePermission` is real. This proves TBI-036's
 * project-scoped middleware wiring and PBI-006 AC-4/VT-05's requirement that an author denial
 * stops before any lifecycle service call.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => false,
  getAppEnvironment: () => 'local',
}));

const listDefinitions = jest.fn();
const createDefinition = jest.fn();
const getDefinitionDetail = jest.fn();
const updateDraft = jest.fn();
const publishDraft = jest.fn();
const deprecateVersion = jest.fn();
jest.mock('../services/playbookDefinitionService', () => ({
  ...jest.requireActual('../services/playbookDefinitionService'),
  listDefinitions: (...args: unknown[]) => listDefinitions(...args),
  createDefinition: (...args: unknown[]) => createDefinition(...args),
  getDefinitionDetail: (...args: unknown[]) => getDefinitionDetail(...args),
  updateDraft: (...args: unknown[]) => updateDraft(...args),
  publishDraft: (...args: unknown[]) => publishDraft(...args),
  deprecateVersion: (...args: unknown[]) => deprecateVersion(...args),
}));

import express from 'express';
import request from 'supertest';
import playbooksRouter from '../routes/playbooks';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookDraftConflictError,
  PlaybookVersionNotFoundError,
  PlaybookVersionTransitionError,
} from '../services/playbookDefinitionService';
import { PlaybookGuardViolationError } from '../services/playbookGuardService';
import { parseStepInput } from '../services/playbookSteps/descriptorValidation';
import { UnknownPlaybookStepTypeError } from '../services/playbookSteps/registry';

const PROJECT = 'Apex';
const USER_OID = 'author-oid';
const GRAPH = {
  nodes: [{ id: 'draft', stepType: 'cursor-agent' }],
  edges: [],
};
const SERVICE_RESULT = {
  definition: { id: 'def-1', project: PROJECT, name: 'Validate design' },
  draft: { id: 'draft-1', updatedAt: '2026-09-22T12:00:00.000Z' },
  versions: [],
  currentPublishedVersionId: null,
};

function buildApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { profile: { oid: USER_OID } };
      next();
    });
  }
  app.use('/api/playbooks', playbooksRouter);
  return app;
}

function grantIn(project: string, ...permissions: string[]): void {
  getUserPermissions.mockImplementation(async (_userId: string, requestedProject?: string) =>
    requestedProject === project ? new Set(permissions) : new Set<string>()
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  grantIn(PROJECT, 'playbooks:view', 'playbooks:author');
  listDefinitions.mockResolvedValue({ definitions: [SERVICE_RESULT.definition] });
  createDefinition.mockResolvedValue(SERVICE_RESULT);
  getDefinitionDetail.mockResolvedValue(SERVICE_RESULT);
  updateDraft.mockResolvedValue(SERVICE_RESULT);
  publishDraft.mockResolvedValue({ publishedVersion: { id: 'version-1' } });
  deprecateVersion.mockResolvedValue({ version: { id: 'version-1', status: 'deprecated' } });
});

describe('FEAT-007 S5 happy-path forwarding', () => {
  it('TBI-031 DoD-1 lists definitions in the query project with playbooks:view', async () => {
    const res = await request(buildApp()).get('/api/playbooks/definitions').query({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ definitions: [SERVICE_RESULT.definition] });
    expect(listDefinitions).toHaveBeenCalledWith(PROJECT);
    expect(getUserPermissions).toHaveBeenCalledWith(USER_OID, PROJECT);
  });

  it('PBI-006 AC-3 reads same-project detail with playbooks:view', async () => {
    const res = await request(buildApp())
      .get('/api/playbooks/definitions/def-1')
      .query({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SERVICE_RESULT);
    expect(getDefinitionDetail).toHaveBeenCalledWith(PROJECT, 'def-1');
  });

  it('TBI-030 DoD-1 creates a definition and propagates the actor', async () => {
    const res = await request(buildApp()).post('/api/playbooks/definitions').send({
      project: PROJECT,
      name: ' Validate design ',
      description: 'Checks a design document',
      graph: GRAPH,
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(SERVICE_RESULT);
    expect(createDefinition).toHaveBeenCalledWith({
      project: PROJECT,
      name: ' Validate design ',
      description: 'Checks a design document',
      graph: GRAPH,
      createdByUserId: USER_OID,
    });
  });

  it('VT-01 updates the retained draft with its expected revision', async () => {
    const res = await request(buildApp()).put('/api/playbooks/definitions/def-1/draft').send({
      project: PROJECT,
      name: 'Validate design',
      graph: GRAPH,
      expectedDraftUpdatedAt: '2026-09-22T11:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(updateDraft).toHaveBeenCalledWith({
      project: PROJECT,
      definitionId: 'def-1',
      name: 'Validate design',
      description: undefined,
      graph: GRAPH,
      expectedDraftUpdatedAt: '2026-09-22T11:00:00.000Z',
    });
  });

  it('PBI-006 AC-1 / VT-02 publishes with the authenticated actor', async () => {
    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: '2026-09-22T11:00:00.000Z',
    });

    expect(res.status).toBe(201);
    expect(publishDraft).toHaveBeenCalledWith({
      project: PROJECT,
      definitionId: 'def-1',
      publishedByUserId: USER_OID,
      expectedDraftUpdatedAt: '2026-09-22T11:00:00.000Z',
    });
  });

  it('TBI-030 DoD-3 deprecates the named same-definition version', async () => {
    const res = await request(buildApp())
      .post('/api/playbooks/definitions/def-1/versions/version-1/deprecate')
      .send({ project: PROJECT });

    expect(res.status).toBe(200);
    expect(deprecateVersion).toHaveBeenCalledWith({
      project: PROJECT,
      definitionId: 'def-1',
      versionId: 'version-1',
    });
  });
});

describe('PBI-006 AC-4 / VT-05 and TBI-036 — real permission middleware', () => {
  it('returns 403 and does not publish when the caller lacks playbooks:author', async () => {
    grantIn(PROJECT, 'playbooks:view');

    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: '2026-09-22T11:00:00.000Z',
    });

    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['playbooks:author']);
    expect(publishDraft).not.toHaveBeenCalled();
  });

  it('allows author mutations without view but denies definition reads', async () => {
    grantIn(PROJECT, 'playbooks:author');
    const app = buildApp();

    const createRes = await request(app)
      .post('/api/playbooks/definitions')
      .send({ project: PROJECT, name: 'Draft', graph: GRAPH });
    const listRes = await request(app).get('/api/playbooks/definitions').query({ project: PROJECT });

    expect(createRes.status).toBe(201);
    expect(listRes.status).toBe(403);
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it('checks author permission against the body project', async () => {
    grantIn('OtherProject', 'playbooks:author');

    const res = await request(buildApp())
      .post('/api/playbooks/definitions')
      .send({ project: PROJECT, name: 'Draft', graph: GRAPH });

    expect(res.status).toBe(403);
    expect(createDefinition).not.toHaveBeenCalled();
  });

  it('returns 401 and does not call a service for an unauthenticated caller', async () => {
    const res = await request(buildApp(false))
      .post('/api/playbooks/definitions')
      .send({ project: PROJECT, name: 'Draft', graph: GRAPH });

    expect(res.status).toBe(401);
    expect(createDefinition).not.toHaveBeenCalled();
  });
});

describe('FEAT-007 S5 request validation', () => {
  it.each([
    [{ project: PROJECT, graph: GRAPH }, 'name'],
    [{ project: PROJECT, name: 'Draft' }, 'graph'],
    [{ project: PROJECT, name: 'Draft', graph: { nodes: {}, edges: [] } }, 'graph'],
    [{ project: PROJECT, name: 'Draft', graph: GRAPH, description: 42 }, 'description'],
  ])('returns 400 for malformed create input %#', async (body, field) => {
    const res = await request(buildApp()).post('/api/playbooks/definitions').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(field, 'i'));
    expect(createDefinition).not.toHaveBeenCalled();
  });

  it('returns 400 when draft revision is missing', async () => {
    const res = await request(buildApp())
      .put('/api/playbooks/definitions/def-1/draft')
      .send({ project: PROJECT, name: 'Draft', graph: GRAPH });

    expect(res.status).toBe(400);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it('returns 400 when publish revision is missing', async () => {
    const res = await request(buildApp())
      .post('/api/playbooks/definitions/def-1/publish')
      .send({ project: PROJECT });

    expect(res.status).toBe(400);
    expect(publishDraft).not.toHaveBeenCalled();
  });
});

describe('TBI-031 AC-2 / VT-13 and lifecycle error mapping', () => {
  it.each([
    ['detail', () => getDefinitionDetail.mockRejectedValue(new PlaybookDefinitionNotFoundError('def-x')),
      () => request(buildApp()).get('/api/playbooks/definitions/def-x').query({ project: PROJECT })],
    ['update', () => updateDraft.mockRejectedValue(new PlaybookDefinitionNotFoundError('def-x')),
      () => request(buildApp()).put('/api/playbooks/definitions/def-x/draft').send({
        project: PROJECT, name: 'Draft', graph: GRAPH, expectedDraftUpdatedAt: 'revision',
      })],
    ['publish', () => publishDraft.mockRejectedValue(new PlaybookDefinitionNotFoundError('def-x')),
      () => request(buildApp()).post('/api/playbooks/definitions/def-x/publish').send({
        project: PROJECT, expectedDraftUpdatedAt: 'revision',
      })],
    ['deprecate', () => deprecateVersion.mockRejectedValue(new PlaybookVersionNotFoundError('version-x')),
      () => request(buildApp()).post('/api/playbooks/definitions/def-x/versions/version-x/deprecate')
        .send({ project: PROJECT })],
  ])('returns the same 404 for unknown or cross-project %s', async (_name, arrange, act) => {
    arrange();
    const res = await act();

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/otherproject|owner/i);
  });

  it('VT-06 maps a stale draft revision to 409', async () => {
    publishDraft.mockRejectedValue(new PlaybookDraftConflictError('def-1'));

    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: 'stale',
    });

    expect(res.status).toBe(409);
  });

  it('TBI-030 AC-2 maps an illegal lifecycle transition to 409', async () => {
    deprecateVersion.mockRejectedValue(new PlaybookVersionTransitionError('deprecated', 'deprecated'));

    const res = await request(buildApp())
      .post('/api/playbooks/definitions/def-1/versions/version-1/deprecate')
      .send({ project: PROJECT });

    expect(res.status).toBe(409);
  });

  it('maps a duplicate definition name to 409', async () => {
    createDefinition.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));

    const res = await request(buildApp())
      .post('/api/playbooks/definitions')
      .send({ project: PROJECT, name: 'Duplicate', graph: GRAPH });

    expect(res.status).toBe(409);
  });

  it('PBI-006 AC-2 / VT-03 maps structural guard errors to 400 with violation', async () => {
    publishDraft.mockRejectedValue(
      new PlaybookGuardViolationError('max-steps', 'Too many steps')
    );

    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: 'revision',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Too many steps',
      violation: { kind: 'max-steps', message: 'Too many steps' },
    });
  });

  it('FEAT-008 maps an unknown publish step type to an actionable 400', async () => {
    publishDraft.mockRejectedValue(
      new UnknownPlaybookStepTypeError('teleport', [
        'cursor-agent',
        'approval-gate',
        'notify',
      ])
    );

    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: 'revision',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/teleport.*registered types/i);
    expect(res.body).not.toHaveProperty('violation');
  });

  it('FEAT-008 maps invalid publish step config to an actionable 400', async () => {
    let schemaError: unknown;
    try {
      parseStepInput('notify', {});
    } catch (error) {
      schemaError = error;
    }
    publishDraft.mockRejectedValue(schemaError);

    const res = await request(buildApp()).post('/api/playbooks/definitions/def-1/publish').send({
      project: PROJECT,
      expectedDraftUpdatedAt: 'revision',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notify.*invalid input.*title/i);
    expect(res.body).not.toHaveProperty('violation');
  });
});
