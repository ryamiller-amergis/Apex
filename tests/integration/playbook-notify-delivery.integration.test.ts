/**
 * VT-19 — a notification written by a `notify` step is an ordinary Apex notification.
 *
 * The point is that the step writes nothing bespoke. If a Playbook notification needed its own
 * table, its own reader, or a special case in the Notification Center, then `notify` would not
 * really be "reuse the existing durable-notification path" — it would be a parallel path wearing
 * its name. So the assertion is deliberately made through `getNotifications`, the same function
 * the Notification Center route calls, rather than by reading the table directly.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL points at the scratch database before the
 * services are required. Nothing above may import anything that reaches `db/drizzle`.
 */
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type NotifyModule = typeof import('../../src/server/services/playbookSteps/notifyAdapter');
type StepRunsModule = typeof import('../../src/server/services/playbookSteps/stepRuns');
type NotificationModule = typeof import('../../src/server/services/notificationService');

const MIGRATE_TIMEOUT = 600_000;
const INITIATOR = 'feat004-notify-initiator';
const OTHER_USER = 'feat004-notify-bystander';

let scratch: ScratchDatabase;
let client: pg.Client;
let notify: NotifyModule;
let stepRuns: StepRunsModule;
let notifications: NotificationModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/** Seeds a run and returns a step run ready for the notify adapter to complete. */
async function seedNotifyStep(name: string): Promise<{ runId: string; stepRunId: string }> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [name, INITIATOR]
  );
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now()) RETURNING id`,
    [definition.id, JSON.stringify({ nodes: [], edges: [] }), INITIATOR]
  );
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
     VALUES ('Apex', $1, $2, 'running') RETURNING id`,
    [version.id, INITIATOR]
  );

  const stepRun = await stepRuns.beginStepRun({
    runId: run.id,
    stepId: 'tell-someone',
    stepType: 'notify',
  });

  return { runId: run.id, stepRunId: stepRun.id };
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbooknotify');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  notify = require('../../src/server/services/playbookSteps/notifyAdapter');
  stepRuns = require('../../src/server/services/playbookSteps/stepRuns');
  notifications = require('../../src/server/services/notificationService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Notify Initiator'), ($2, 'Bystander')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR, OTHER_USER]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-19 — it appears like any other Apex notification', () => {
  it('is returned by the same reader the Notification Center uses', async () => {
    const { stepRunId } = await seedNotifyStep('notify-readable');

    await notify.executeNotifyStep({
      runId: 'unused',
      stepRunId,
      stepId: 'tell-someone',
      stepType: 'notify',
      project: 'Apex',
      initiatorUserId: INITIATOR,
      config: { title: 'Draft ready', body: 'Review when you can', link: '/playbooks' },
    });

    // getNotifications is what GET /api/notifications calls. No Playbook-specific reader exists,
    // and this test fails if one is ever introduced.
    const inbox = await notifications.getNotifications(INITIATOR);
    const found = inbox.find((n) => n.title === 'Draft ready');

    expect(found).toBeDefined();
    expect(found).toMatchObject({
      userId: INITIATOR,
      title: 'Draft ready',
      body: 'Review when you can',
      link: '/playbooks',
      read: false,
    });
  });

  it('carries a type the Notification Center already knows how to render', async () => {
    const { stepRunId } = await seedNotifyStep('notify-type');

    await notify.executeNotifyStep({
      runId: 'unused',
      stepRunId,
      stepId: 'tell-someone',
      stepType: 'notify',
      project: 'Apex',
      initiatorUserId: INITIATOR,
      config: { title: 'Typed notification' },
    });

    const [row] = await query<{ type: string }>(
      'SELECT type FROM notifications WHERE title = $1',
      ['Typed notification']
    );

    // One of the four existing NotificationType values, so preferences and toasts apply to it
    // exactly as they do to everything else.
    expect(['system', 'ai', 'user-action', 'background']).toContain(row.type);
  });

  it('completes the step and records which notification it wrote', async () => {
    const { stepRunId } = await seedNotifyStep('notify-completes');

    const outcome = await notify.executeNotifyStep({
      runId: 'unused',
      stepRunId,
      stepId: 'tell-someone',
      stepType: 'notify',
      project: 'Apex',
      initiatorUserId: INITIATOR,
      config: { title: 'Completion evidence' },
    });

    expect(outcome.kind).toBe('completed');

    const [step] = await query<{
      status: string;
      output_inline: { notificationId: string };
      expires_at: Date | null;
    }>('SELECT status, output_inline, expires_at FROM playbook_step_runs WHERE id = $1', [
      stepRunId,
    ]);

    expect(step.status).toBe('completed');
    // Non-suspending, so there is nothing to wait for and nothing to expire.
    expect(step.expires_at).toBeNull();

    const [notification] = await query<{ id: string }>(
      'SELECT id FROM notifications WHERE id = $1',
      [step.output_inline.notificationId]
    );
    expect(notification).toBeDefined();
  });

  it('sends to the run initiator, not to everyone', async () => {
    const { stepRunId } = await seedNotifyStep('notify-scoped');

    await notify.executeNotifyStep({
      runId: 'unused',
      stepRunId,
      stepId: 'tell-someone',
      stepType: 'notify',
      project: 'Apex',
      initiatorUserId: INITIATOR,
      config: { title: 'Only for the initiator' },
    });

    const bystanderInbox = await notifications.getNotifications(OTHER_USER);
    expect(bystanderInbox.find((n) => n.title === 'Only for the initiator')).toBeUndefined();
  });
});
