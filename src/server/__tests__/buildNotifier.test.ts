/**
 * S6 — Build notifier tests (PBI-037 AC-0..3, TBI-030 DoD-0 / VT-19..VT-24).
 */
import { createBuildNotifier } from '../services/buildNotifier';

describe('buildNotifier (PBI-037 AC-0..3, TBI-030 DoD-0 / VT-19..VT-24)', () => {
  it('VT-19, VT-20, VT-24 PBI-037 AC-0, AC-3 / TBI-030 DoD-0 routes the 5 events to the right recipients with dedupe keys ending in userId', async () => {
    const created: Array<{ userId: string; title: string; body?: string; link?: string; dedupeKey?: string }> = [];
    const seenDedupe = new Set<string>();
    const events: Array<{ eventType: string; detail?: Record<string, unknown> }> = [];

    const notifier = createBuildNotifier({
      loadBuildContext: async () => ({
        id: 'run-1',
        featureTitle: 'Add Export CSV',
        requesterUserId: 'u-requester',
        supportContacts: [
          { userId: 'u-c1', displayName: 'Alice', email: 'alice@example.com' },
          { userId: 'u-c2', displayName: 'Bob', email: 'bob@example.com' },
        ],
      }),
      isNotificationEnabled: async () => true,
      createNotification: async (userId, payload, options) => {
        if (options?.dedupeKey && seenDedupe.has(options.dedupeKey)) {
          return;
        }
        if (options?.dedupeKey) seenDedupe.add(options.dedupeKey);
        created.push({ userId, ...payload, dedupeKey: options?.dedupeKey });
      },
      appendEvent: async (ev) => {
        events.push(ev);
      },
      track: () => undefined,
    });

    // 1. build_started -> requester (twice to test dedupe VT-20)
    await notifier.notifyBuildEvent({ kind: 'build_started', buildRunId: 'run-1' });
    await notifier.notifyBuildEvent({ kind: 'build_started', buildRunId: 'run-1' });
    expect(created).toHaveLength(1);
    expect(created[0].userId).toBe('u-requester');
    expect(created[0].dedupeKey).toBe('build:run-1:started:u-requester');

    // 2. preview_ready -> requester
    await notifier.notifyBuildEvent({
      kind: 'preview_ready',
      buildRunId: 'run-1',
      revisionNumber: 2,
    });
    expect(created[1].dedupeKey).toBe('build:run-1:preview:2:u-requester');

    // 3. run_suspended -> requester
    await notifier.notifyBuildEvent({
      kind: 'run_suspended',
      buildRunId: 'run-1',
      suspendEventId: 'ev-99',
      reason: 'cost_cap',
    });
    expect(created[2].dedupeKey).toBe('build:run-1:suspended:ev-99:u-requester');

    // 4. deployment_failed -> support contacts only (VT-24)
    await notifier.notifyBuildEvent({
      kind: 'deployment_failed',
      buildRunId: 'run-1',
      pipelineRunId: 'P-77',
      failedStage: 'Deploy_Dev',
    });
    expect(created.slice(3, 5).map((c) => c.userId)).toEqual(['u-c1', 'u-c2']);
    expect(created[3].dedupeKey).toBe('build:run-1:deploy-failed:P-77:u-c1');

    // 5. pull_request_created -> requester
    await notifier.notifyBuildEvent({
      kind: 'pull_request_created',
      buildRunId: 'run-1',
      revisionNumber: 2,
      riskDecisionCount: 4,
    });
    expect(created[5].dedupeKey).toBe('build:run-1:pr:2:u-requester');
  });

  it('VT-22 PBI-037 AC-2 skips createNotification when user has build preference disabled and records notification_skipped event', async () => {
    const created: string[] = [];
    const events: Array<{ eventType: string; detail?: Record<string, unknown> }> = [];

    const notifier = createBuildNotifier({
      loadBuildContext: async () => ({
        id: 'run-1',
        featureTitle: 'Export CSV',
        requesterUserId: 'u-muted',
        supportContacts: [],
      }),
      isNotificationEnabled: async () => false,
      createNotification: async (userId) => {
        created.push(userId);
      },
      appendEvent: async (ev) => {
        events.push(ev);
      },
      track: () => undefined,
    });

    await notifier.notifyBuildEvent({
      kind: 'preview_ready',
      buildRunId: 'run-1',
      revisionNumber: 1,
    });

    expect(created).toHaveLength(0);
    expect(events.map((e) => e.eventType)).toContain('notification_skipped');
  });
});
