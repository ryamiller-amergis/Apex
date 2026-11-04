/**
 * S6 — Build deployment notifier tests (TBI-025 DoD-3, PBI-028 AC-0..2 / VT-18, VT-19).
 */
import { createBuildDeploymentNotifier } from '../services/buildDeploymentNotifier';

describe('buildDeploymentNotifier (TBI-025 DoD-3, PBI-028 AC-0..2 / VT-18, VT-19)', () => {
  it('VT-18 PBI-028 AC-0, AC-2 sends one notification per support contact with stage, redacted error, short commit, and pipeline link, and deduplicates repeats', async () => {
    const sent: Array<{
      userId: string;
      title: string;
      body?: string;
      link?: string;
      dedupeKey?: string;
    }> = [];
    const seenDedupe = new Set<string>();
    const events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }> = [];

    const notifier = createBuildDeploymentNotifier({
      createNotification: async (userId, payload, options) => {
        if (options?.dedupeKey && seenDedupe.has(options.dedupeKey)) {
          return {
            id: 'existing',
            userId,
            type: payload.type,
            title: payload.title,
            body: payload.body ?? null,
            link: payload.link ?? null,
            read: false,
            createdAt: new Date().toISOString(),
          };
        }
        if (options?.dedupeKey) seenDedupe.add(options.dedupeKey);
        sent.push({ userId, ...payload, dedupeKey: options?.dedupeKey });
        options?.onTeamsResult?.('sent');
        return {
          id: `n-${sent.length}`,
          userId,
          type: payload.type,
          title: payload.title,
          body: payload.body ?? null,
          link: payload.link ?? null,
          read: false,
          createdAt: new Date().toISOString(),
        };
      },
      appendEvent: async (ev) => {
        events.push(ev);
      },
    });

    const input = {
      buildRunId: 'run-123',
      revisionId: 'rev-1',
      pipelineRunId: '4411',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      failedStage: 'Deploy_Dev',
      errorText: 'Connection failed: postgres://admin:secretPass@host:5432/db',
      pipelineUrl: 'https://dev.azure.com/org/Apex/_build/results?buildId=4411',
      supportContacts: [
        { userId: 'u-1', displayName: 'Alice', email: 'alice@example.com' },
        { userId: 'u-2', displayName: 'Bob', email: 'bob@example.com' },
        { userId: 'u-3', displayName: 'Carol', email: 'carol@example.com' },
      ],
    };

    await notifier.notifyDeploymentFailed(input);
    await notifier.notifyDeploymentFailed(input);

    expect(sent).toHaveLength(3);
    for (const item of sent) {
      expect(item.body).toContain('Deploy_Dev');
      expect(item.body).toContain('abcdef1');
      expect(item.body).toContain('https://dev.azure.com/org/Apex/_build/results?buildId=4411');
      expect(item.body).not.toContain('secretPass');
      expect(item.link).toBe('/builds/run-123/preview');
    }
  });

  it('VT-19 PBI-028 AC-1 records deployment_notification_failed event when Teams delivery returns failed while keeping in-app notification', async () => {
    const inAppCreated: string[] = [];
    const events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }> = [];

    const notifier = createBuildDeploymentNotifier({
      createNotification: async (userId, payload, options) => {
        inAppCreated.push(userId);
        await options?.onTeamsResult?.(userId === 'u-2' ? 'failed' : 'sent');
        return {
          id: `n-${userId}`,
          userId,
          type: payload.type,
          title: payload.title,
          body: payload.body ?? null,
          link: payload.link ?? null,
          read: false,
          createdAt: new Date().toISOString(),
        };
      },
      appendEvent: async (ev) => {
        events.push(ev);
      },
    });

    await notifier.notifyDeploymentFailed({
      buildRunId: 'run-123',
      revisionId: 'rev-1',
      pipelineRunId: '4412',
      commit: '1234567890abcdef1234567890abcdef12345678',
      failedStage: 'Deploy_Dev',
      errorText: 'Step failed',
      pipelineUrl: 'https://dev.azure.com/org/Apex/_build/results?buildId=4412',
      supportContacts: [
        { userId: 'u-1', displayName: 'Alice', email: 'alice@example.com' },
        { userId: 'u-2', displayName: 'Bob', email: 'bob@example.com' },
      ],
    });

    expect(inAppCreated).toEqual(['u-1', 'u-2']);
    const failedEvents = events.filter((e) => e.eventType === 'deployment_notification_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].detail).toEqual(
      expect.objectContaining({ recipientUserId: 'u-2', channel: 'teams' }),
    );
  });
});
