/**
 * VT-TEMPLATE-5 — install route permission, project, and playbook-interview-step flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

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

const isFeatureEnabled = jest.fn();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

const installPlaybookTemplate = jest.fn();
jest.mock('../services/playbookTemplateService', () => {
  const actual = jest.requireActual('../services/playbookTemplateService');
  return {
    ...actual,
    installPlaybookTemplate: (...args: unknown[]) => installPlaybookTemplate(...args),
  };
});

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
import { publishDraft } from '../services/playbookDefinitionService';

const PROJECT = 'Project A';
const USER_OID = 'author-oid';
const FLAG = 'playbook-interview-step';
const publishDraftMock = publishDraft as jest.MockedFunction<typeof publishDraft>;

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

function grant(...permissions: string[]): void {
  getUserPermissions.mockImplementation(async (_userId: string, requestedProject?: string) =>
    requestedProject === PROJECT ? new Set(permissions) : new Set<string>(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  grant('playbooks:author');
  isFeatureEnabled.mockImplementation(async (key: string) => key === 'playbooks-production-adapters');
  installPlaybookTemplate.mockResolvedValue({
    created: true,
    detail: { definition: { id: 'def-a', project: PROJECT }, draft: { id: 'draft-a' }, versions: [] },
  });
  publishDraftMock.mockResolvedValue({ publishedVersion: { id: 'version-1' } } as never);
});

describe('VT-TEMPLATE-5 — install entry point', () => {
  it('requires a project and does not call the installer', async () => {
    const res = await request(buildApp()).post('/api/playbooks/templates/core-interview/install').send({});

    expect(res.status).toBe(404);
    expect(installPlaybookTemplate).not.toHaveBeenCalled();
  });

  it('requires playbooks:author and does not call the installer', async () => {
    grant('playbooks:view');

    const res = await request(buildApp())
      .post('/api/playbooks/templates/core-interview/install')
      .send({ project: PROJECT });

    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['playbooks:author']);
    expect(installPlaybookTemplate).not.toHaveBeenCalled();
  });

  it('returns 404 when playbook-interview-step is disabled', async () => {
    const res = await request(buildApp())
      .post('/api/playbooks/templates/core-interview/install')
      .send({ project: PROJECT });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(isFeatureEnabled).toHaveBeenCalledWith(FLAG, { userId: USER_OID, project: PROJECT });
    expect(installPlaybookTemplate).not.toHaveBeenCalled();
  });

  it('invokes the installer when the flag is enabled', async () => {
    isFeatureEnabled.mockResolvedValue(true);

    const res = await request(buildApp())
      .post('/api/playbooks/templates/core-interview/install')
      .send({ project: PROJECT });

    expect(res.status).toBe(201);
    expect(installPlaybookTemplate).toHaveBeenCalledWith({
      project: PROJECT,
      templateKey: 'core-interview',
      createdByUserId: USER_OID,
    });
  });

  it('keeps balanced cleanup-ready markers around the install split', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/server/routes/playbooks.ts'),
      'utf8',
    );
    const markers = [
      `// @feature-flag:${FLAG} start winner=enabled`,
      `// @feature-flag:${FLAG} disabled-start`,
      `// @feature-flag:${FLAG} disabled-end`,
      `// @feature-flag:${FLAG} enabled-start`,
      `// @feature-flag:${FLAG} enabled-end`,
      `// @feature-flag:${FLAG} end`,
    ];
    for (const marker of markers) {
      const occurrences = source.split(marker).length - 1;
      expect(occurrences).toBe(1);
    }

    const start = source.indexOf(markers[0]);
    const disabledStart = source.indexOf(markers[1]);
    const disabledEnd = source.indexOf(markers[2]);
    const enabledStart = source.indexOf(markers[3]);
    const enabledEnd = source.indexOf(markers[4]);
    const end = source.indexOf(markers[5]);
    expect(start).toBeLessThan(disabledStart);
    expect(disabledStart).toBeLessThan(disabledEnd);
    expect(disabledEnd).toBeLessThan(enabledStart);
    expect(enabledStart).toBeLessThan(enabledEnd);
    expect(enabledEnd).toBeLessThan(end);
  });
});

describe('VT-TEMPLATE-7 — publish route forwards sample run input', () => {
  it('passes sampleRunInput through to publishDraft', async () => {
    const sampleRunInput = { interviewProfileKey: 'grill' };
    const res = await request(buildApp())
      .post('/api/playbooks/definitions/def-a/publish')
      .send({
        project: PROJECT,
        expectedDraftUpdatedAt: '2026-10-07T12:00:00.000Z',
        sampleRunInput,
      });

    expect(res.status).toBe(201);
    expect(publishDraftMock).toHaveBeenCalledWith({
      project: PROJECT,
      definitionId: 'def-a',
      publishedByUserId: USER_OID,
      expectedDraftUpdatedAt: '2026-10-07T12:00:00.000Z',
      sampleRunInput,
    });
  });
});
