import request from 'supertest';
import express from 'express';

jest.mock('../services/featureFlagService', () => ({
  listFlags: jest.fn(),
  createFlag: jest.fn(),
  updateFlag: jest.fn(),
  deleteFlag: jest.fn(),
  addRule: jest.fn(),
  removeRule: jest.fn(),
}));
import platformAdminRouter from '../routes/platformAdmin';
import * as featureFlagService from '../services/featureFlagService';
import { getSuperAdminEmails } from '../utils/superAdmin';

function appFor(email: string) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: 'user-1', displayName: 'User', upn: email } };
    next();
  });
  app.use('/api/platform-admin', platformAdminRouter);
  return app;
}

describe('build-from-prompt flag changes (VT-20, PBI-021 AC-3)', () => {
  it('refuses a Project Admin who is not a Platform Admin and leaves the flag unchanged', async () => {
    const app = appFor('project-admin@example.com');

    const patch = await request(app).patch('/api/platform-admin/feature-flags/flag-1').send({ enabled: false });
    const removeRule = await request(app).delete('/api/platform-admin/feature-flags/flag-1/rules/rule-1');

    expect([patch.status, removeRule.status]).toEqual([403, 403]);
    expect(featureFlagService.updateFlag).not.toHaveBeenCalled();
    expect(featureFlagService.removeRule).not.toHaveBeenCalled();
  });

  it('lets a Platform Admin through to the flag service', async () => {
    (featureFlagService.updateFlag as jest.Mock).mockResolvedValue({ id: 'flag-1', enabled: false });

    const patch = await request(appFor(getSuperAdminEmails()[0]))
      .patch('/api/platform-admin/feature-flags/flag-1')
      .send({ enabled: false });

    expect(patch.status).not.toBe(403);
    expect(featureFlagService.updateFlag).toHaveBeenCalled();
  });
});
