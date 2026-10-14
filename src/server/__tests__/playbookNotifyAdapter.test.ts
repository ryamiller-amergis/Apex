/**
 * TBI-019 — the `notify` adapter.
 *
 * Covers VT-17 (a row is created and the step completes) and VT-18 (it still completes when the
 * downstream delivery channel is unconfigured or throwing). VT-19, that the row is readable through
 * the ordinary Notification Center path, needs a real database and lives in the integration suite.
 *
 * The Teams mock is the point of most of this file: `createNotification` fires
 * `sendTeamsNotification(...).catch(() => {})`, so a rejecting channel must be invisible to the
 * step. That is an easy property to break later by "improving" the error handling, and nothing else
 * would notice.
 */
const sendTeamsNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/teamsBotService', () => ({ sendTeamsNotification }));

const completeStepRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  completeStepRun: (...args: unknown[]) => completeStepRun(...args),
}));

const insertReturning = jest.fn();
jest.mock('../db/drizzle', () => ({
  db: {
    insert: () => ({ values: () => ({ returning: insertReturning }) }),
    query: {
      notifications: { findFirst: jest.fn().mockResolvedValue(undefined) },
      notificationPreferences: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  },
}));

import { executeNotifyStep } from '../services/playbookSteps/notifyAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

const INITIATOR = 'initiator-oid';
const NOTIFICATION_ROW = {
  id: 'notification-1',
  userId: INITIATOR,
  type: 'background',
  title: 'Draft ready',
  body: 'Review when you can',
  link: '/playbooks',
  read: false,
  createdAt: '2026-09-19T12:00:00.000Z',
};

function contextWith(config: Record<string, unknown>): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'tell-someone',
    stepType: 'notify',
    project: 'Apex',
    initiatorUserId: INITIATOR,
    config,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  insertReturning.mockResolvedValue([NOTIFICATION_ROW]);
  sendTeamsNotification.mockResolvedValue(undefined);
});

describe('VT-17 — the durable row is the step\u2019s artifact', () => {
  it('creates a notification and completes the step', async () => {
    const outcome = await executeNotifyStep(
      contextWith({ title: 'Draft ready', body: 'Review when you can', link: '/playbooks' })
    );

    expect(outcome.kind).toBe('completed');
    expect(outcome).toMatchObject({
      output: { notificationId: 'notification-1', recipientUserId: INITIATOR },
    });
    expect(completeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output: { notificationId: 'notification-1', recipientUserId: INITIATOR },
    });
  });

  it('sends to the run initiator when no recipient is named', async () => {
    await executeNotifyStep(contextWith({ title: 'Draft ready' }));

    // BR-003: the run acts as its initiator, and Phase 0 can resolve no other identity.
    expect(sendTeamsNotification).toHaveBeenCalledWith(INITIATOR, expect.anything());
  });

  it('sends to an explicit recipient when the config names one', async () => {
    await executeNotifyStep(contextWith({ title: 'Heads up', recipientUserId: 'someone-else' }));

    expect(sendTeamsNotification).toHaveBeenCalledWith('someone-else', expect.anything());
  });
});

describe('VT-18 — delivery failure is not step failure', () => {
  it('completes when the Teams channel rejects', async () => {
    sendTeamsNotification.mockRejectedValue(new Error('TEAMS_WEBHOOK_URL is not configured'));

    const outcome = await executeNotifyStep(contextWith({ title: 'Draft ready' }));

    expect(outcome.kind).toBe('completed');
    expect(completeStepRun).toHaveBeenCalledTimes(1);
  });

  it('depends on delivery failing as a rejection, so it checks that it does', () => {
    /*
     * `createNotification` isolates Teams with `sendTeamsNotification(...).catch(() => {})`. That
     * only works while the call returns a promise: a function throwing synchronously would blow
     * past the `.catch()` entirely, and the step would fail on an unconfigured webhook — the exact
     * outcome TBI-019 forbids.
     *
     * An async function cannot throw synchronously, so the guarantee holds today. This asserts the
     * real module rather than the mock, because the mock is what made the impossible look possible
     * while this test was being written.
     */
    const actual = jest.requireActual('../services/teamsBotService');
    expect(actual.sendTeamsNotification.constructor.name).toBe('AsyncFunction');
  });

  it('fails the step when the row itself cannot be written', async () => {
    // The other side of the line. A database failure is not a delivery failure, and swallowing it
    // would leave a run claiming it notified someone when nothing exists to be read.
    insertReturning.mockRejectedValue(new Error('duplicate key value'));

    await expect(executeNotifyStep(contextWith({ title: 'Draft ready' }))).rejects.toThrow(
      /duplicate key/
    );
    expect(completeStepRun).not.toHaveBeenCalled();
  });
});

describe('TBI-032 VT-24 — descriptor output validation', () => {
  it('rejects malformed output before durable completion and names the field', async () => {
    insertReturning.mockResolvedValue([{ ...NOTIFICATION_ROW, id: 42 }]);

    await expect(executeNotifyStep(contextWith({ title: 'Draft ready' }))).rejects.toThrow(
      /notify.*output.*notificationId/i
    );
    expect(completeStepRun).not.toHaveBeenCalled();
  });
});
