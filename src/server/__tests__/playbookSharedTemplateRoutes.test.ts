/**
 * Share and remove routes are platform-admin only; install stays an author action and accepts a name.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const getUserPermissions = jest.fn();
jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => getUserPermissions(...args),
}));

let superAdmin = false;
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: () => superAdmin,
  getAppEnvironment: () => 'local',
}));

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

const installPlaybookTemplate = jest.fn();
const assertTemplatePrerequisites = jest.fn();
jest.mock('../services/playbookTemplateService', () => ({
  ...jest.requireActual('../services/playbookTemplateService'),
  installPlaybookTemplate: (...args: unknown[]) => installPlaybookTemplate(...args),
  assertTemplatePrerequisites: (...args: unknown[]) => assertTemplatePrerequisites(...args),
}));

const sharePlaybookAsTemplate = jest.fn();
const archiveSharedTemplate = jest.fn();
jest.mock('../services/playbookSharedTemplateService', () => ({
  ...jest.requireActual('../services/playbookSharedTemplateService'),
  sharePlaybookAsTemplate: (...args: unknown[]) => sharePlaybookAsTemplate(...args),
  archiveSharedTemplate: (...args: unknown[]) => archiveSharedTemplate(...args),
}));

jest.mock('../services/playbookDefinitionService', () => ({
  ...jest.requireActual('../services/playbookDefinitionService'),
  listDefinitions: jest.fn(),
  createDefinition: jest.fn(),
  getDefinitionDetail: jest.fn(),
  updateDraft: jest.fn(),
  publishDraft: jest.fn(),
  deprecateVersion: jest.fn(),
}));

import playbooksRouter from '../routes/playbooks';
import {
  PlaybookSharedTemplateInvalidError,
  PlaybookSharedTemplateNameTakenError,
  PlaybookSharedTemplateNotFoundError,
} from '../services/playbookSharedTemplateService';

const PROJECT = 'Project A';
const USER_OID = 'admin-oid';
const KEY = 'shared:11111111-2222-4333-8444-555555555555';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: USER_OID } };
    next();
  });
  app.use('/api/playbooks', playbooksRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  superAdmin = false;
  getUserPermissions.mockResolvedValue(new Set(['playbooks:author', 'playbooks:view']));
  isFeatureEnabled.mockResolvedValue(true);
  assertTemplatePrerequisites.mockResolvedValue(undefined);
  installPlaybookTemplate.mockResolvedValue({ created: true, detail: { definition: { id: 'd' } } });
  sharePlaybookAsTemplate.mockResolvedValue({ template: { templateKey: KEY }, notes: ['n'] });
  archiveSharedTemplate.mockResolvedValue(undefined);
});

describe('POST /definitions/:id/share-as-template', () => {
  const url = '/api/playbooks/definitions/def-1/share-as-template';

  it('refuses a project author who is not a platform admin', async () => {
    const res = await request(buildApp()).post(url).send({ project: PROJECT });
    expect(res.status).toBe(403);
    expect(sharePlaybookAsTemplate).not.toHaveBeenCalled();
  });

  it('requires a project', async () => {
    superAdmin = true;
    const res = await request(buildApp()).post(url).send({});
    expect(res.status).toBe(404);
    expect(sharePlaybookAsTemplate).not.toHaveBeenCalled();
  });

  it('shares for a platform admin and returns the notes', async () => {
    superAdmin = true;
    const res = await request(buildApp())
      .post(url)
      .send({ project: PROJECT, name: 'Team flow', summary: 'What it does' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ template: { templateKey: KEY }, notes: ['n'] });
    expect(sharePlaybookAsTemplate).toHaveBeenCalledWith({
      project: PROJECT,
      definitionId: 'def-1',
      actorUserId: USER_OID,
      name: 'Team flow',
      summary: 'What it does',
    });
  });

  it('rejects a non-string name or summary', async () => {
    superAdmin = true;
    const res = await request(buildApp()).post(url).send({ project: PROJECT, name: 5 });
    expect(res.status).toBe(400);
    expect(sharePlaybookAsTemplate).not.toHaveBeenCalled();
  });

  it('maps service errors to 400, 404 and 409', async () => {
    superAdmin = true;
    sharePlaybookAsTemplate.mockRejectedValueOnce(new PlaybookSharedTemplateInvalidError('Publish first'));
    expect((await request(buildApp()).post(url).send({ project: PROJECT })).status).toBe(400);
    sharePlaybookAsTemplate.mockRejectedValueOnce(new PlaybookSharedTemplateNotFoundError('def-1'));
    expect((await request(buildApp()).post(url).send({ project: PROJECT })).status).toBe(404);
    sharePlaybookAsTemplate.mockRejectedValueOnce(new PlaybookSharedTemplateNameTakenError('X'));
    expect((await request(buildApp()).post(url).send({ project: PROJECT })).status).toBe(409);
  });
});

describe('DELETE /templates/:templateKey', () => {
  it('refuses a user who is not a platform admin', async () => {
    const res = await request(buildApp()).delete(`/api/playbooks/templates/${encodeURIComponent(KEY)}?project=${PROJECT}`);
    expect(res.status).toBe(403);
    expect(archiveSharedTemplate).not.toHaveBeenCalled();
  });

  it('removes a shared template for a platform admin', async () => {
    superAdmin = true;
    const res = await request(buildApp()).delete(`/api/playbooks/templates/${encodeURIComponent(KEY)}?project=${PROJECT}`);
    expect(res.status).toBe(204);
    expect(archiveSharedTemplate).toHaveBeenCalledWith(KEY, USER_OID);
  });

  it('returns 404 for a template that is not shared', async () => {
    superAdmin = true;
    archiveSharedTemplate.mockRejectedValueOnce(new PlaybookSharedTemplateNotFoundError('core-interview'));
    const res = await request(buildApp()).delete(`/api/playbooks/templates/core-interview?project=${PROJECT}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /templates/:templateKey/install for a shared template', () => {
  it('passes the chosen name to the installer', async () => {
    const res = await request(buildApp())
      .post(`/api/playbooks/templates/${encodeURIComponent(KEY)}/install`)
      .send({ project: PROJECT, name: 'My copy' });
    expect(res.status).toBe(201);
    expect(installPlaybookTemplate).toHaveBeenCalledWith({
      project: PROJECT,
      templateKey: KEY,
      createdByUserId: USER_OID,
      name: 'My copy',
    });
  });

  it('still requires playbooks:author', async () => {
    getUserPermissions.mockResolvedValue(new Set(['playbooks:view']));
    const res = await request(buildApp())
      .post(`/api/playbooks/templates/${encodeURIComponent(KEY)}/install`)
      .send({ project: PROJECT });
    expect(res.status).toBe(403);
    expect(installPlaybookTemplate).not.toHaveBeenCalled();
  });
});
