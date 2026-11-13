import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../middleware/rbac', () => ({
  requireGroupMembership:
    () => (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
      req.user = { profile: { oid: 'ba-user-oid' } };
      next();
    },
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireProjectAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  attachPermissions: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import apiRouter from '../routes/api';
import {
  createProjectReleasePlatform,
  deleteProjectReleasePlatform,
  getProjectReleasePlatformsState,
  listProjectReleasePlatforms,
  reorderProjectReleasePlatforms,
  setReleaseEpicPlatforms,
  setReleaseWorkItemPlatforms,
  ReleasePlatformValidationError,
} from '../services/releasePlatformService';
import {
  matchPlatformsFromTags,
  resolveReleaseEpicPlatforms,
  resolveWorkItemPlatforms,
  slugifyReleasePlatform,
  type ReleasePlatform,
} from '../../shared/types/releasePlatforms';

interface MockDb {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  transaction: jest.Mock;
}

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: MockDb };

const desktopPlatform: ReleasePlatform = {
  id: 'plat-desktop',
  project: 'MaxView',
  slug: 'desktop',
  name: 'Desktop',
  color: 'blue',
  sortOrder: 0,
  createdBy: 'ba-user-oid',
  createdAt: '2026-11-13T00:00:00.000Z',
};

const mobilePlatform: ReleasePlatform = {
  id: 'plat-mobile',
  project: 'MaxView',
  slug: 'mobile',
  name: 'Mobile',
  color: 'purple',
  sortOrder: 1,
  createdBy: 'ba-user-oid',
  createdAt: '2026-11-13T00:01:00.000Z',
};

function mockSelectQueue(results: unknown[][]) {
  let callIdx = 0;
  mockDb.select.mockImplementation(() => {
    const rows = results[callIdx++] ?? [];
    const chain: {
      from: jest.Mock;
      where: jest.Mock;
      orderBy: jest.Mock;
      then: Promise<unknown[]>['then'];
    } = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => Promise.resolve(rows)),
      then: (onFulfilled, onRejected) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  });
}

describe('releasePlatforms — shared tag & resolution helpers', () => {
  it('slugifies platform names cleanly', () => {
    expect(slugifyReleasePlatform('  Desktop App  ')).toBe('desktop-app');
    expect(slugifyReleasePlatform('iOS / iPadOS')).toBe('ios-ipados');
    expect(slugifyReleasePlatform('---')).toBe('');
  });

  it('matches ADO System.Tags case-insensitively across name, slug, and Platform:<name> conventions', () => {
    const platforms = [desktopPlatform, mobilePlatform];

    expect(matchPlatformsFromTags('ReleaseVersion; desktop; Regression', platforms)).toEqual([
      'plat-desktop',
    ]);
    expect(matchPlatformsFromTags('Platform:Mobile; Priority:1', platforms)).toEqual([
      'plat-mobile',
    ]);
    expect(matchPlatformsFromTags('Platform: Desktop; MOBILE', platforms)).toEqual([
      'plat-desktop',
      'plat-mobile',
    ]);
    expect(matchPlatformsFromTags('UnrelatedTag', platforms)).toEqual([]);
  });

  it('returns empty platform lists when project has zero configured platforms', () => {
    expect(
      resolveWorkItemPlatforms(
        { id: 10, tags: 'Desktop; Mobile' },
        [],
        { 10: ['plat-desktop'] },
      ),
    ).toEqual([]);

    expect(
      resolveReleaseEpicPlatforms(
        { id: 100, tags: 'Desktop' },
        [],
        { 100: ['plat-desktop'] },
        {},
      ),
    ).toEqual([]);
  });

  it('unions explicit DB assignments with ADO tags for single-platform and multi-platform projects', () => {
    const single = resolveWorkItemPlatforms(
      { id: 50, tags: 'Mobile; Desktop' },
      [desktopPlatform],
      {},
    );
    expect(single.map((p) => p.slug)).toEqual(['desktop']);

    const multi = resolveWorkItemPlatforms(
      { id: 51, tags: 'Desktop' },
      [desktopPlatform, mobilePlatform],
      { 51: ['plat-mobile'] },
    );
    expect(multi.map((p) => p.slug)).toEqual(['desktop', 'mobile']);
  });

  it('resolves release epic platforms from explicit epic platforms + child item platforms', () => {
    const platforms = [desktopPlatform, mobilePlatform];
    const resolved = resolveReleaseEpicPlatforms(
      {
        id: 500,
        childItemsSummary: [
          { id: 1, state: 'In Progress', tags: 'Platform:Mobile' },
          { id: 2, state: 'Done', tags: '' },
        ],
      },
      platforms,
      { 500: ['plat-desktop'] },
      {},
    );
    expect(resolved.map((p) => p.slug)).toEqual(['desktop', 'mobile']);
  });
});

describe('releasePlatformService — CRUD & assignment persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists configured platforms ordered for a project', async () => {
    mockSelectQueue([[desktopPlatform, mobilePlatform]]);

    const list = await listProjectReleasePlatforms('MaxView');
    expect(list).toHaveLength(2);
    expect(list[0].slug).toBe('desktop');
    expect(list[1].slug).toBe('mobile');
  });

  it('loads full platform state (platforms + epic assignments + work item assignments)', async () => {
    mockSelectQueue([
      [desktopPlatform, mobilePlatform],
      [{ adoEpicId: 101, platformId: 'plat-desktop' }],
      [
        { workItemId: 501, platformId: 'plat-desktop' },
        { workItemId: 501, platformId: 'plat-mobile' },
      ],
    ]);

    const state = await getProjectReleasePlatformsState('MaxView');
    expect(state.platforms).toHaveLength(2);
    expect(state.epicPlatformIds).toEqual({ 101: ['plat-desktop'] });
    expect(state.workItemPlatformIds).toEqual({ 501: ['plat-desktop', 'plat-mobile'] });
  });

  it('creates a new platform with sequential sortOrder and rejects duplicate slugs', async () => {
    mockSelectQueue([[desktopPlatform]]);
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([mobilePlatform]),
      }),
    });

    const created = await createProjectReleasePlatform({
      project: 'MaxView',
      name: 'Mobile',
      color: 'purple',
      createdBy: 'ba-user-oid',
    });
    expect(created.slug).toBe('mobile');
    expect(created.sortOrder).toBe(1);

    mockSelectQueue([[desktopPlatform]]);
    await expect(
      createProjectReleasePlatform({
        project: 'MaxView',
        name: 'desktop',
      }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_PLATFORM',
    });
  });

  it('rejects invalid color or blank project/name', async () => {
    await expect(
      createProjectReleasePlatform({ project: '  ', name: 'Desktop' }),
    ).rejects.toBeInstanceOf(ReleasePlatformValidationError);

    await expect(
      createProjectReleasePlatform({ project: 'MaxView', name: '   ' }),
    ).rejects.toBeInstanceOf(ReleasePlatformValidationError);

    await expect(
      createProjectReleasePlatform({
        project: 'MaxView',
        name: 'Web',
        color: 'neon-pink',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reorders platforms in a transaction', async () => {
    mockSelectQueue([
      [desktopPlatform, mobilePlatform],
      [
        { ...mobilePlatform, sortOrder: 0 },
        { ...desktopPlatform, sortOrder: 1 },
      ],
    ]);

    const txUpdateWhere = jest.fn().mockResolvedValue(undefined);
    const txUpdate = jest.fn(() => ({
      set: jest.fn(() => ({ where: txUpdateWhere })),
    }));
    mockDb.transaction.mockImplementation(
      async (cb: (tx: { update: jest.Mock }) => Promise<unknown>) =>
        cb({ update: txUpdate }),
    );

    const reordered = await reorderProjectReleasePlatforms('MaxView', [
      'plat-mobile',
      'plat-desktop',
    ]);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(reordered[0].slug).toBe('mobile');
  });

  it('deletes an existing platform and throws NOT_FOUND when missing', async () => {
    mockDb.delete.mockReturnValueOnce({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 'plat-desktop' }]),
      }),
    });

    await expect(
      deleteProjectReleasePlatform('MaxView', 'plat-desktop'),
    ).resolves.toBeUndefined();

    mockDb.delete.mockReturnValueOnce({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });

    await expect(
      deleteProjectReleasePlatform('MaxView', 'missing-id'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sets epic and work-item platform assignments after validating platform ownership', async () => {
    mockSelectQueue([[{ id: 'plat-desktop' }, { id: 'plat-mobile' }]]);
    const txDelete = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
    const txInsert = jest.fn(() => ({
      values: jest.fn(() => ({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) })),
    }));
    mockDb.transaction.mockImplementation(
      async (cb: (tx: { delete: jest.Mock; insert: jest.Mock }) => Promise<unknown>) =>
        cb({ delete: txDelete, insert: txInsert }),
    );

    const savedEpic = await setReleaseEpicPlatforms({
      project: 'MaxView',
      adoEpicId: 101,
      platformIds: ['plat-desktop', 'plat-mobile'],
    });
    expect(savedEpic).toEqual(['plat-desktop', 'plat-mobile']);

    mockSelectQueue([[{ id: 'plat-mobile' }]]);
    const savedItem = await setReleaseWorkItemPlatforms({
      project: 'MaxView',
      workItemId: 555,
      platformIds: ['plat-mobile'],
      updatedBy: 'ba-user-oid',
    });
    expect(savedItem).toEqual(['plat-mobile']);

    mockSelectQueue([[{ id: 'plat-desktop' }]]);
    await expect(
      setReleaseWorkItemPlatforms({
        project: 'MaxView',
        workItemId: 555,
        platformIds: ['plat-other-project'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('Release Platform API routes (/api/releases/platforms*)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
  });

  it('GET /api/releases/platforms validates project and returns state', async () => {
    await request(app).get('/api/releases/platforms').expect(400);

    mockSelectQueue([[desktopPlatform], [], []]);
    const res = await request(app)
      .get('/api/releases/platforms')
      .query({ project: 'MaxView' })
      .expect(200);

    expect(res.body.project).toBe('MaxView');
    expect(res.body.platforms).toHaveLength(1);
    expect(res.body.platforms[0].name).toBe('Desktop');
  });

  it('POST /api/releases/platforms creates a platform and returns 409 on duplicate', async () => {
    mockSelectQueue([[]]);
    mockDb.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([desktopPlatform]),
      }),
    });

    const created = await request(app)
      .post('/api/releases/platforms')
      .send({ project: 'MaxView', name: 'Desktop', color: 'blue' })
      .expect(201);
    expect(created.body.slug).toBe('desktop');

    mockSelectQueue([[desktopPlatform]]);
    await request(app)
      .post('/api/releases/platforms')
      .send({ project: 'MaxView', name: 'Desktop', color: 'blue' })
      .expect(409);
  });

  it('PUT /api/releases/work-items/:workItemId/platforms and PUT /api/releases/:epicId/platforms save assignments', async () => {
    mockSelectQueue([[{ id: 'plat-desktop' }]]);
    mockDb.transaction.mockImplementation(
      async (
        cb: (tx: {
          delete: () => { where: jest.Mock };
          insert: () => { values: () => { onConflictDoNothing: jest.Mock } };
        }) => Promise<unknown>,
      ) =>
        cb({
          delete: () => ({ where: jest.fn().mockResolvedValue(undefined) }),
          insert: () => ({
            values: () => ({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
          }),
        }),
    );

    const itemRes = await request(app)
      .put('/api/releases/work-items/900/platforms')
      .send({ project: 'MaxView', platformIds: ['plat-desktop'] })
      .expect(200);
    expect(itemRes.body).toEqual({
      success: true,
      workItemId: 900,
      platformIds: ['plat-desktop'],
    });

    mockSelectQueue([[{ id: 'plat-desktop' }]]);
    const epicRes = await request(app)
      .put('/api/releases/101/platforms')
      .send({ project: 'MaxView', platformIds: ['plat-desktop'] })
      .expect(200);
    expect(epicRes.body).toEqual({
      success: true,
      epicId: 101,
      platformIds: ['plat-desktop'],
    });
  });
});
