import request from 'supertest';
import express from 'express';
import uiLabRouter from '../routes/uiLab';
import * as uiLabService from '../services/uiLabService';
import * as menuSettingsService from '../services/menuSettingsService';
import { isSuperAdminRequest } from '../utils/superAdmin';

let mockGroupMembershipGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireGroupMembership: (...groups: string[]) => (req: any, res: any, next: any) => {
    if (isSuperAdminRequest(req) || mockGroupMembershipGranted) {
      next();
    } else {
      res.status(403).json({ error: 'Forbidden', requiredGroups: groups });
    }
  },
}));

jest.mock('../services/uiLabService', () => ({
  listDesigns: jest.fn(),
  getDesign: jest.fn(),
  getDesignProject: jest.fn(),
  getCommentProject: jest.fn(),
  createDesign: jest.fn(),
  deleteDesign: jest.fn(),
  saveHtml: jest.fn(),
  runGeneration: jest.fn(),
  runRegeneration: jest.fn(),
  listComments: jest.fn(),
  addComment: jest.fn(),
  resolveComment: jest.fn(),
  reopenComment: jest.fn(),
  resolveDesignAccess: jest.fn(),
  requireManageAccess: jest.fn(),
  listDesignShares: jest.fn(),
  listDesignShareTargets: jest.fn(),
  createDesignShare: jest.fn(),
  revokeDesignShare: jest.fn(),
  UiLabForbiddenError: class UiLabForbiddenError extends Error {
    status = 403;
    constructor(message = 'Forbidden') {
      super(message);
      this.name = 'UiLabForbiddenError';
    }
  },
  UiLabNotFoundError: class UiLabNotFoundError extends Error {
    status = 404;
    constructor(message = 'UI Lab design not found') {
      super(message);
      this.name = 'UiLabNotFoundError';
    }
  },
  UiLabValidationError: class UiLabValidationError extends Error {
    status = 400;
    constructor(message: string) {
      super(message);
      this.name = 'UiLabValidationError';
    }
  },
}));

jest.mock('../services/menuSettingsService', () => ({
  getMenuConfig: jest.fn(),
}));

jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn(() => false),
}));

const mockUiLab = uiLabService as jest.Mocked<typeof uiLabService>;
const mockMenuSettings = menuSettingsService as jest.Mocked<typeof menuSettingsService>;
const mockIsSuperAdmin = isSuperAdminRequest as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-1', upn: 'user@example.com' } };
    next();
  });
  app.use('/api/ui-lab', uiLabRouter);
  return app;
}

function menuConfig(enabledViews: string[]) {
  return { project: 'MaxView', enabledViews: enabledViews as any, updatedBy: null };
}

describe('uiLab routes — project ui-lab enablement enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSuperAdmin.mockReturnValue(false);
    mockGroupMembershipGranted = true;
  });

  describe('GET /api/ui-lab', () => {
    it('lists designs when ui-lab is enabled for the project', async () => {
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.listDesigns.mockResolvedValue([{ id: 'd1' } as any]);

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 'd1' }]);
      expect(mockUiLab.listDesigns).toHaveBeenCalledWith('MaxView');
    });

    it('returns 403 when ui-lab is not enabled for the project', async () => {
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['calendar']));

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(403);
      expect(mockUiLab.listDesigns).not.toHaveBeenCalled();
    });

    it('bypasses the enablement check for super admins', async () => {
      mockIsSuperAdmin.mockReturnValue(true);
      mockUiLab.listDesigns.mockResolvedValue([]);

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(200);
      expect(mockMenuSettings.getMenuConfig).not.toHaveBeenCalled();
      expect(mockUiLab.listDesigns).toHaveBeenCalledWith('MaxView');
    });
  });

  describe('GET /api/ui-lab/:id', () => {
    it('returns the design when access resolves and ui-lab is enabled', async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.resolveDesignAccess.mockResolvedValue({
        design: { id: 'd1', project: 'MaxView', effectiveAccess: 'shared' } as any,
        access: 'shared',
      });

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'd1', project: 'MaxView', effectiveAccess: 'shared' });
      expect(mockUiLab.resolveDesignAccess).toHaveBeenCalledWith('d1', 'user-1', {
        isSuperAdmin: false,
      });
    });

    it('allows shared viewers without UI/UX group membership', async () => {
      mockGroupMembershipGranted = false;
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.resolveDesignAccess.mockResolvedValue({
        design: { id: 'd1', project: 'MaxView', effectiveAccess: 'shared' } as any,
        access: 'shared',
      });

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(200);
      expect(mockUiLab.resolveDesignAccess).toHaveBeenCalled();
    });

    it("returns 403 when the design's project does not have ui-lab enabled", async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig([]));

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(403);
      expect(mockUiLab.resolveDesignAccess).not.toHaveBeenCalled();
    });

    it('returns 403 when resolveDesignAccess denies access', async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.resolveDesignAccess.mockRejectedValue(new uiLabService.UiLabForbiddenError());

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/ui-lab/:id/comments', () => {
    it('lets shared viewers add comments without UI/UX membership', async () => {
      mockGroupMembershipGranted = false;
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.resolveDesignAccess.mockResolvedValue({
        design: { id: 'd1', project: 'MaxView', effectiveAccess: 'shared' } as any,
        access: 'shared',
      });
      mockUiLab.addComment.mockResolvedValue({ id: 'c1', text: 'hi' } as any);

      const res = await request(buildApp())
        .post('/api/ui-lab/d1/comments')
        .send({ text: 'hi', version: 1 });

      expect(res.status).toBe(201);
      expect(mockUiLab.addComment).toHaveBeenCalledWith('d1', 'user-1', {
        text: 'hi',
        version: 1,
      });
    });
  });

  describe('share routes', () => {
    it('creates a share for managers', async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.createDesignShare.mockResolvedValue({
        id: 's1',
        designId: 'd1',
        granteeId: 'dev-1',
        link: '/ui-lab/d1?project=MaxView',
      } as any);

      const res = await request(buildApp())
        .post('/api/ui-lab/d1/shares')
        .send({ granteeId: 'dev-1' });

      expect(res.status).toBe(201);
      expect(mockUiLab.createDesignShare).toHaveBeenCalledWith('d1', 'dev-1', 'user-1', {
        isSuperAdmin: false,
      });
    });

    it('requires UI/UX for share management', async () => {
      mockGroupMembershipGranted = false;
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));

      const res = await request(buildApp())
        .post('/api/ui-lab/d1/shares')
        .send({ granteeId: 'dev-1' });

      expect(res.status).toBe(403);
      expect(mockUiLab.createDesignShare).not.toHaveBeenCalled();
    });
  });

  describe('UI/UX group membership enforcement', () => {
    it('returns 403 when the user is not in the UI/UX group', async () => {
      mockGroupMembershipGranted = false;
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ requiredGroups: ['UI/UX'] });
      expect(mockUiLab.listDesigns).not.toHaveBeenCalled();
    });

    it('lists designs when the user is in the UI/UX group and ui-lab is enabled', async () => {
      mockGroupMembershipGranted = true;
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.listDesigns.mockResolvedValue([{ id: 'd1' } as any]);

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 'd1' }]);
    });

    it('bypasses the group check for super admins', async () => {
      mockGroupMembershipGranted = false;
      mockIsSuperAdmin.mockReturnValue(true);
      mockUiLab.listDesigns.mockResolvedValue([]);

      const res = await request(buildApp()).get('/api/ui-lab').query({ project: 'MaxView' });

      expect(res.status).toBe(200);
      expect(mockUiLab.listDesigns).toHaveBeenCalledWith('MaxView');
    });
  });

  describe('POST /api/ui-lab/comments/:commentId/resolve', () => {
    it("returns 403 when the comment's project does not have ui-lab enabled", async () => {
      mockUiLab.getCommentProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['planning']));

      const res = await request(buildApp()).post('/api/ui-lab/comments/c1/resolve').send({});

      expect(res.status).toBe(403);
      expect(mockUiLab.getCommentProject).toHaveBeenCalledWith('c1');
      expect(mockUiLab.resolveComment).not.toHaveBeenCalled();
    });

    it('resolves the comment for a super admin regardless of enablement', async () => {
      mockIsSuperAdmin.mockReturnValue(true);
      mockUiLab.resolveComment.mockResolvedValue(undefined);

      const res = await request(buildApp()).post('/api/ui-lab/comments/c1/resolve').send({});

      expect(res.status).toBe(200);
      expect(mockUiLab.resolveComment).toHaveBeenCalledWith('c1', 'user-1');
    });
  });
});
