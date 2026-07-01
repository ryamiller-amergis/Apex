import request from 'supertest';
import express from 'express';
import uiLabRouter from '../routes/uiLab';
import * as uiLabService from '../services/uiLabService';
import * as menuSettingsService from '../services/menuSettingsService';
import { isSuperAdminRequest } from '../utils/superAdmin';

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
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
    it('returns the design when its project has ui-lab enabled', async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig(['ui-lab']));
      mockUiLab.getDesign.mockResolvedValue({ id: 'd1', project: 'MaxView' } as any);

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'd1', project: 'MaxView' });
      expect(mockUiLab.getDesignProject).toHaveBeenCalledWith('d1');
    });

    it("returns 403 when the design's project does not have ui-lab enabled", async () => {
      mockUiLab.getDesignProject.mockResolvedValue('MaxView');
      mockMenuSettings.getMenuConfig.mockResolvedValue(menuConfig([]));

      const res = await request(buildApp()).get('/api/ui-lab/d1');

      expect(res.status).toBe(403);
      expect(mockUiLab.getDesign).not.toHaveBeenCalled();
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
