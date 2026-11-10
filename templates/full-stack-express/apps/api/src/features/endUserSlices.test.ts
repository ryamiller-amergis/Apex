import {
  analyzeInsights,
  getNotifications,
  insightsAnalysisSchema,
  notificationsListSchema,
} from '@project-scope/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, PRINCIPAL_A } from '../../test/support/testApp.ts';

describe('notifications and AI insights API slices', () => {
  it('lists, creates, and marks notifications as read for the authenticated principal', async () => {
    const { app } = buildTestApp({ principal: PRINCIPAL_A });

    const initial = await request(app).get(getNotifications.path).expect(200);
    const parsedInitial = notificationsListSchema.parse(initial.body);
    expect(parsedInitial.unreadCount).toBe(2);
    expect(parsedInitial.items).toHaveLength(3);

    const created = await request(app)
      .post('/api/v1/notifications')
      .send({
        title: 'Dock door B4 opened',
        message: 'Overflow capacity activated for afternoon Midwest lane.',
        category: 'workflow',
      })
      .expect(200);
    const parsedCreated = notificationsListSchema.parse(created.body);
    expect(parsedCreated.unreadCount).toBe(3);
    expect(parsedCreated.items[0]?.title).toBe('Dock door B4 opened');

    const marked = await request(app)
      .put('/api/v1/notifications')
      .send({ markAll: true })
      .expect(200);
    expect(notificationsListSchema.parse(marked.body).unreadCount).toBe(0);
  });

  it('analyzes database records and connector feed through the deterministic composer-2.5 AI skill adapter', async () => {
    const { app } = buildTestApp({ principal: PRINCIPAL_A });

    const res = await request(app)
      .post(analyzeInsights.path)
      .send({
        focusArea: 'operations',
        includeConnectorFeed: true,
        connectorSource: 'Logistics Telemetry Feed',
      })
      .expect(200);

    const parsed = insightsAnalysisSchema.parse(res.body);
    expect(parsed.modelId).toBe('composer-2.5');
    expect(parsed.skillName).toBe('operational-briefing');
    expect(parsed.citations.map((c) => c.sourceKind)).toEqual([
      'database',
      'connector',
    ]);
    expect(parsed.findings.length).toBeGreaterThan(0);
  });
});
