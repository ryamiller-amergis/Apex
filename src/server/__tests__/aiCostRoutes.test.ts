import express from 'express';
import request from 'supertest';
import aiCostRouter from '../routes/aiCost';
import { getUserPermissions } from '../services/rbacService';
import { getEvents } from '../services/aiCostAnalyticsService';

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));
jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn(),
}));
jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: jest.fn(),
}));
jest.mock('../utils/superAdmin', () => ({
  isSuperAdminRequest: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/aiCostAnalyticsService', () => ({
  getEvents: jest.fn(),
}));
jest.mock('../services/aiCostForecastService', () => ({
  getForecast: jest.fn(),
}));
jest.mock('../services/aiCostDailyBriefService', () => ({
  getLatestDailyBrief: jest.fn(),
  generateDailyBrief: jest.fn(),
}));
jest.mock('../db/drizzle', () => ({
  db: {},
}));

const mockGetUserPermissions = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;
const mockGetEvents = getEvents as jest.MockedFunction<typeof getEvents>;

describe('AI cost route authorization', () => {
  it('PBI-003 AC-3 / VT-04 denies events, including effort, without analytics permission', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set());
    const app = express();
    app.use((req, _res, next) => {
      req.user = { profile: { oid: 'user-without-ai-cost-access' } };
      next();
    });
    app.use('/api/ai-cost', aiCostRouter);

    const response = await request(app).get('/api/ai-cost/events?project=Apex');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: 'Forbidden',
      missing: ['analytics:ai-cost:view'],
    });
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
