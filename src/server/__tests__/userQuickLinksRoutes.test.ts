import request from 'supertest';
import express from 'express';
import { ProjectQuickLinkError } from '../../shared/types/projectQuickLinks';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['quick-links:manage', 'quick-links:personal'],
  member: ['quick-links:personal'],
  viewer: [],
};

let currentRole = 'member';
let currentOid: string | undefined = 'alice';
let assignedProjects = new Set<string>(['MaxView']);

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: any, res: any, next: any) => {
      const granted = new Set(ROLE_PERMISSIONS[currentRole]);
      const missing = keys.filter((k) => !granted.has(k));
      if (missing.length > 0) return res.status(403).json({ error: 'Forbidden', missing });
      next();
    },
  requireProjectAccess: (resolve: (req: any) => string | undefined) =>
    (req: any, res: any, next: any) => {
      const project = resolve(req);
      if (!project || !assignedProjects.has(project)) {
        return res.status(403).json({ error: 'Forbidden: not assigned to this project' });
      }
      next();
    },
  resolveRequestProject: (req: any) => req.params?.projectId,
}));

const listUserLinks = jest.fn();
const createUserLink = jest.fn();
const updateUserLink = jest.fn();
const deleteUserLink = jest.fn();
const importUserLinks = jest.fn();

jest.mock('../services/userQuickLinksService', () => ({
  listUserLinks: (...args: unknown[]) => listUserLinks(...args),
  createUserLink: (...args: unknown[]) => createUserLink(...args),
  updateUserLink: (...args: unknown[]) => updateUserLink(...args),
  deleteUserLink: (...args: unknown[]) => deleteUserLink(...args),
  importUserLinks: (...args: unknown[]) => importUserLinks(...args),
}));

import userQuickLinksRouter from '../routes/userQuickLinks';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: currentOid === undefined ? {} : { oid: currentOid } };
    next();
  });
  app.use('/api/projects/:projectId/my-quick-links', userQuickLinksRouter);
  return app;
}

const base = '/api/projects/MaxView/my-quick-links';

beforeEach(() => {
  jest.clearAllMocks();
  currentRole = 'member';
  currentOid = 'alice';
  assignedProjects = new Set(['MaxView']);
});

describe('permission', () => {
  it.each([
    ['get', base, undefined],
    ['post', base, { label: 'x', url: 'https://x.com' }],
    ['post', `${base}/import`, { items: [{ label: 'x', url: 'https://x.com' }] }],
    ['patch', `${base}/link-1`, { label: 'y' }],
    ['delete', `${base}/link-1`, undefined],
  ] as const)('viewer is denied: %s %s', async (method, url, body) => {
    currentRole = 'viewer';

    const res = await request(buildApp())[method](url).send(body);

    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['quick-links:personal']);
    for (const fn of [listUserLinks, createUserLink, updateUserLink, deleteUserLink, importUserLinks]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it.each(['member', 'admin'])('%s can list their links', async (role) => {
    currentRole = role;
    listUserLinks.mockResolvedValue([]);

    const res = await request(buildApp()).get(base);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('needs access to the project', async () => {
    const res = await request(buildApp()).get('/api/projects/Amego/my-quick-links');
    expect(res.status).toBe(403);
    expect(listUserLinks).not.toHaveBeenCalled();
  });

  it('returns 401 when the session has no user id', async () => {
    currentOid = undefined;
    const res = await request(buildApp()).get(base);
    expect(res.status).toBe(401);
    expect(listUserLinks).not.toHaveBeenCalled();
  });
});

describe('the owner comes from the authenticated user', () => {
  it('GET lists the signed-in user’s links', async () => {
    listUserLinks.mockResolvedValue([]);
    await request(buildApp()).get(`${base}?userId=mallory`);
    expect(listUserLinks).toHaveBeenCalledWith('alice', 'MaxView');
  });

  it('POST ignores a user id in the body', async () => {
    createUserLink.mockResolvedValue({ id: 'link-1' });

    const res = await request(buildApp())
      .post(base)
      .send({ label: 'Clerk', url: 'https://clerk.com', category: 'Tools', userId: 'mallory', user_id: 'mallory' });

    expect(res.status).toBe(201);
    expect(createUserLink).toHaveBeenCalledWith('alice', 'MaxView', {
      label: 'Clerk',
      url: 'https://clerk.com',
      category: 'Tools',
    });
  });

  it('PATCH and DELETE act as the signed-in user', async () => {
    updateUserLink.mockResolvedValue({ id: 'link-1' });
    deleteUserLink.mockResolvedValue(undefined);

    await request(buildApp()).patch(`${base}/link-1`).send({ label: 'y', userId: 'mallory' });
    const del = await request(buildApp()).delete(`${base}/link-1`);

    expect(updateUserLink).toHaveBeenCalledWith('alice', 'MaxView', 'link-1', {
      label: 'y',
      url: undefined,
      category: undefined,
    });
    expect(del.status).toBe(204);
    expect(deleteUserLink).toHaveBeenCalledWith('alice', 'MaxView', 'link-1');
  });

  it('POST /import passes the items and returns the counts', async () => {
    const result = { created: 2, skippedDuplicates: 1, rejected: [] };
    importUserLinks.mockResolvedValue(result);
    const items = [{ label: 'A', url: 'https://a.com' }];

    const res = await request(buildApp()).post(`${base}/import`).send({ items, userId: 'mallory' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(importUserLinks).toHaveBeenCalledWith('alice', 'MaxView', items);
  });
});

describe('error mapping', () => {
  it.each([
    ['VALIDATION', 422],
    ['NOT_FOUND', 404],
    ['DUPLICATE', 409],
    ['LIMIT_REACHED', 409],
  ] as const)('%s maps to %i', async (code, status) => {
    createUserLink.mockRejectedValue(new ProjectQuickLinkError('nope', code));

    const res = await request(buildApp()).post(base).send({ label: 'x', url: 'https://x.com' });

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: 'nope', code });
  });
});
