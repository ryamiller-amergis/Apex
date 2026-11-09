import request from 'supertest';
import express, { type Request, type Response } from 'express';

let mockRouterPermissions = new Set(['admin:roles']);
let mockSuperAdmin = false;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) => (_req: unknown, res: Response, next: () => void) => {
    if (keys.some((key) => !mockRouterPermissions.has(key))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  },
  requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  attachPermissions: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSuperAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../services/rbacService');
jest.mock('../services/projectSettingsService');
jest.mock('../services/groupService');
jest.mock('../services/buildProfileService', () => {
  const actual = jest.requireActual('../services/buildProfileService');
  return { ...actual, getBuildProfile: jest.fn(), saveBuildProfile: jest.fn() };
});
jest.mock('../services/buildAccessService', () => ({ isBuildFromPromptEnabled: jest.fn() }));
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: () => mockSuperAdmin }));
jest.mock('@cursor/sdk', () => ({ Cursor: { models: { list: jest.fn() } } }));

import adminRouter from '../routes/admin';
import * as rbacService from '../services/rbacService';
import * as projectSettingsService from '../services/projectSettingsService';
import * as buildProfileService from '../services/buildProfileService';
import * as buildAccessService from '../services/buildAccessService';
import { emptyBuildProfile } from '../../shared/types/buildPreflight';
import type { BuildProfile } from '../../shared/types/build';

const mockGetById = projectSettingsService.getSkillConfigById as jest.Mock;
const mockPermissions = rbacService.getUserPermissions as jest.Mock;
const mockSave = buildProfileService.saveBuildProfile as jest.Mock;
const mockGet = buildProfileService.getBuildProfile as jest.Mock;
const mockFlag = buildAccessService.isBuildFromPromptEnabled as jest.Mock;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = { profile: { oid: 'admin-a' } };
    next();
  });
  a.use('/api/admin', adminRouter);
  return a;
}

function validProfile(): BuildProfile {
  const p = emptyBuildProfile();
  p.roles.planner = { skillPath: '.cursor/skills/planner/SKILL.md', model: 'planner-m' };
  p.supportContactUserIds = ['u1'];
  return p;
}

const URL = '/api/admin/project-settings/row-b/build-profile';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouterPermissions = new Set(['admin:roles']);
  mockSuperAdmin = false;
  mockGetById.mockResolvedValue({ id: 'row-b', project: 'B', skillRepo: 'apex' });
  mockPermissions.mockResolvedValue(new Set(['admin:roles']));
  mockFlag.mockResolvedValue(true);
  mockSave.mockImplementation(async ({ profile }) => ({ settingsId: 'row-b', profile }));
  mockGet.mockResolvedValue({ settingsId: 'row-b', profile: emptyBuildProfile() });
});

describe('PUT /project-settings/:id/build-profile', () => {
  it('PBI-004 AC-0 (VT-02): saves planner skill and model for a Project Admin', async () => {
    const res = await request(app()).put(URL).send(validProfile());
    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ settingsId: 'row-b', actorOid: 'admin-a' }));
    expect(mockSave.mock.calls[0][0].profile.roles.planner).toEqual({
      skillPath: '.cursor/skills/planner/SKILL.md',
      model: 'planner-m',
    });
    expect(mockPermissions).toHaveBeenCalledWith('admin-a', 'B');
  });

  it('PBI-004 AC-1 (VT-03): empty contacts → 400 with the contacts message; nothing saved', async () => {
    const res = await request(app()).put(URL).send({ ...validProfile(), supportContactUserIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.supportContactUserIds).toBe('At least one support contact is required.');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('PBI-004 AC-3 (VT-06): parallelism 9 → 400 "The maximum is 6."; 6 is accepted', async () => {
    const bad = validProfile();
    bad.caps.maxParallelism = 9;
    const res = await request(app()).put(URL).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors['caps.maxParallelism']).toBe('The maximum is 6.');
    expect(mockSave).not.toHaveBeenCalled();

    const ok = validProfile();
    ok.caps.maxParallelism = 6;
    expect((await request(app()).put(URL).send(ok)).status).toBe(200);
  });

  it('rejects unknown properties', async () => {
    const res = await request(app()).put(URL).send({ ...validProfile(), extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.extra).toBeDefined();
  });

  it('VT-08: a caller without admin:roles gets 403 on PUT and GET', async () => {
    mockRouterPermissions = new Set();
    expect((await request(app()).put(URL).send(validProfile())).status).toBe(403);
    expect((await request(app()).get(URL)).status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('VT-09: a Project Admin of A cannot write a row of B; a Platform Admin can', async () => {
    mockPermissions.mockResolvedValue(new Set());
    const denied = await request(app()).put(URL).set('x-apex-project', 'A').send(validProfile());
    expect(denied.status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();

    mockSuperAdmin = true;
    const allowed = await request(app()).put(URL).set('x-apex-project', 'A').send(validProfile());
    expect(allowed.status).toBe(200);
  });

  it('VT-10: a contact not assigned to the project → 400 naming supportContactUserIds', async () => {
    mockSave.mockRejectedValue(
      new buildProfileService.BuildProfileError('invalid_contacts', 'x', {
        supportContactUserIds: 'Each support contact must be a user assigned to this project.',
      }),
    );
    const res = await request(app()).put(URL).send(validProfile());
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.supportContactUserIds).toMatch(/assigned to this project/);
  });

  it('VT-11: flag off → PUT 403 build_from_prompt_disabled; GET still returns the profile', async () => {
    mockFlag.mockResolvedValue(false);
    const put = await request(app()).put(URL).send(validProfile());
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('build_from_prompt_disabled');
    expect(put.body.message).toMatch(/Platform Admin/);
    expect(mockSave).not.toHaveBeenCalled();

    const get = await request(app()).get(URL);
    expect(get.status).toBe(200);
    expect(get.body.settingsId).toBe('row-b');
  });

  it('404 when the settings row does not exist', async () => {
    mockGetById.mockResolvedValue(null);
    expect((await request(app()).put(URL).send(validProfile())).status).toBe(404);
    expect((await request(app()).get(URL)).status).toBe(404);
  });
});
