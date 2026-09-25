/**
 * TBI-018 — the approval gate, and the shared suspend/resume primitive underneath it.
 *
 * Covers VT-13 (suspends with a deadline), VT-14 (a decision from anyone but the initiator is
 * refused), VT-15 (the initiator's decision resumes it) and VT-16 (a duplicate is a no-op).
 *
 * Deliberately an integration test rather than a unit test with a mocked database. The property
 * being asserted *is* a database property: idempotence comes from an UPDATE whose WHERE clause
 * includes the status it expects to find, and a mock that returns whatever the test told it to
 * would assert nothing about whether that clause is correct. VT-15 in particular runs two
 * submissions concurrently, which is the case a check-then-write would pass in a unit test and fail
 * in production.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL points at the scratch database before the
 * services are required. Nothing above may import anything that reaches `db/drizzle`.
 */
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type ApprovalModule = typeof import('../../src/server/services/playbookSteps/approvalGateAdapter');
type StepRunsModule = typeof import('../../src/server/services/playbookSteps/stepRuns');

const MIGRATE_TIMEOUT = 600_000;
const INITIATOR = 'feat004-initiator';
const BYSTANDER = 'feat004-bystander';
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

let scratch: ScratchDatabase;
let client: pg.Client;
let approval: ApprovalModule;
let stepRuns: StepRunsModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/** Seeds a run and returns a step run parked by the adapter itself, not by hand-written SQL. */
async function seedGate(options: { name: string; initiator?: string; deadlineMs?: number }) {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [options.name, INITIATOR]
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
    [version.id, options.initiator ?? INITIATOR]
  );

  const stepRun = await stepRuns.beginStepRun({
    runId: run.id,
    stepId: 'approve',
    stepType: 'approval-gate',
  });

  const outcome = await approval.executeApprovalGateStep({
    runId: run.id,
    stepRunId: stepRun.id,
    stepId: 'approve',
    stepType: 'approval-gate',
    project: 'Apex',
    initiatorUserId: options.initiator ?? INITIATOR,
    config: options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs },
  });

  return { runId: run.id, stepRunId: stepRun.id, outcome };
}

async function statusOf(stepRunId: string): Promise<string> {
  const [row] = await query<{ status: string }>(
    'SELECT status FROM playbook_step_runs WHERE id = $1',
    [stepRunId]
  );
  return row.status;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookgate');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  approval = require('../../src/server/services/playbookSteps/approvalGateAdapter');
  stepRuns = require('../../src/server/services/playbookSteps/stepRuns');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Initiator'), ($2, 'Bystander')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR, BYSTANDER]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-13 — the gate parks with a deadline', () => {
  it('suspends with the registry default of 48 hours', async () => {
    const before = Date.now();
    const { stepRunId, outcome } = await seedGate({ name: 'gate-default-deadline' });

    expect(outcome.kind).toBe('suspended');
    expect(await statusOf(stepRunId)).toBe('suspended');

    const [row] = await query<{ expires_at: Date }>(
      'SELECT expires_at FROM playbook_step_runs WHERE id = $1',
      [stepRunId]
    );
    // Compared as an instant rather than a string: Postgres renders a +00:00 offset where the
    // service produced a Z, and the two are the same moment.
    const waited = row.expires_at.getTime() - before;
    expect(waited).toBeGreaterThan(FORTY_EIGHT_HOURS_MS - 60_000);
    expect(waited).toBeLessThan(FORTY_EIGHT_HOURS_MS + 60_000);
  });

  it('honours a per-definition override', async () => {
    const before = Date.now();
    const { stepRunId } = await seedGate({
      name: 'gate-short-deadline',
      deadlineMs: 90 * 60 * 1000,
    });

    const [row] = await query<{ expires_at: Date }>(
      'SELECT expires_at FROM playbook_step_runs WHERE id = $1',
      [stepRunId]
    );
    expect(row.expires_at.getTime() - before).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it('never parks without one', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-always-has-deadline' });

    // BR-005 at the only place it can actually be violated. A suspended step with a null expiry is
    // invisible to a sweep whose index is over expires_at, so nothing would ever end it.
    const [row] = await query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM playbook_step_runs WHERE id = $1',
      [stepRunId]
    );
    expect(row.expires_at).not.toBeNull();
  });
});

describe('VT-15 — the initiator\u2019s decision resumes the step', () => {
  it('records an approval and completes the step', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-approved' });

    const result = await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'approved',
    });

    // stepId rides along so the caller knows which node to carry the run on from.
    expect(result).toEqual({ outcome: 'recorded', decision: 'approved', stepId: 'approve' });
    expect(await statusOf(stepRunId)).toBe('completed');

    const [row] = await query<{ output_inline: { decision: string; decidedBy: string } }>(
      'SELECT output_inline FROM playbook_step_runs WHERE id = $1',
      [stepRunId]
    );
    expect(row.output_inline).toEqual({ decision: 'approved', decidedBy: INITIATOR });
  });

  it('records a rejection the same way', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-rejected' });

    const result = await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'rejected',
    });

    // A rejection still *completes* the step. What the run does next is the graph's business, not
    // the gate's — a rejected gate is a decision that arrived, not a step that failed.
    expect(result).toEqual({ outcome: 'recorded', decision: 'rejected', stepId: 'approve' });
    expect(await statusOf(stepRunId)).toBe('completed');
  });

  it('uses the same primitive an agent step resumes through', async () => {
    // BR-008 stated as a test: a step parked by the gate is advanced by the plain stepRuns resume,
    // with nothing approval-specific involved.
    const { stepRunId } = await seedGate({ name: 'gate-shared-primitive' });

    expect(await stepRuns.resumeStepRun({ stepRunId })).toBe(true);
    expect(await statusOf(stepRunId)).toBe('completed');
  });
});

describe('VT-16 — a duplicate decision changes nothing', () => {
  it('reports the second submission as already-decided', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-double-submit' });

    const first = await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'approved',
    });
    const second = await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'rejected',
    });

    expect(first).toEqual({ outcome: 'recorded', decision: 'approved', stepId: 'approve' });
    expect(second).toEqual({ outcome: 'already-decided' });
  });

  it('does not let a late submission overwrite the recorded decision', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-no-overwrite' });

    await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'approved',
    });
    await approval.submitApprovalDecision({
      stepRunId,
      deciderUserId: INITIATOR,
      decision: 'rejected',
    });

    const [row] = await query<{ output_inline: { decision: string } }>(
      'SELECT output_inline FROM playbook_step_runs WHERE id = $1',
      [stepRunId]
    );
    expect(row.output_inline.decision).toBe('approved');
  });

  it('admits exactly one of two concurrent submissions', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-concurrent' });

    // The case a check-then-write passes in a unit test and loses in production: both submissions
    // read `suspended`, and only the conditional UPDATE decides which one wins.
    const results = await Promise.all([
      approval.submitApprovalDecision({
        stepRunId,
        deciderUserId: INITIATOR,
        decision: 'approved',
      }),
      approval.submitApprovalDecision({
        stepRunId,
        deciderUserId: INITIATOR,
        decision: 'approved',
      }),
    ]);

    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already-decided')).toHaveLength(1);
    expect(await statusOf(stepRunId)).toBe('completed');
  });

  it('will not resume a step that was never suspended', async () => {
    const { runId } = await seedGate({ name: 'gate-not-suspended' });
    const fresh = await stepRuns.beginStepRun({
      runId,
      stepId: 'second-gate',
      stepType: 'approval-gate',
    });

    expect(await stepRuns.resumeStepRun({ stepRunId: fresh.id })).toBe(false);
    expect(await statusOf(fresh.id)).toBe('running');
  });
});

describe('VT-14 — only the initiator decides', () => {
  it('refuses a decision from anyone else', async () => {
    const { stepRunId } = await seedGate({ name: 'gate-wrong-decider' });

    await expect(
      approval.submitApprovalDecision({
        stepRunId,
        deciderUserId: BYSTANDER,
        decision: 'approved',
      })
    ).rejects.toThrow(/Only the person who started this run/);

    // Refused, not ignored: the gate is still waiting for the right person.
    expect(await statusOf(stepRunId)).toBe('suspended');
  });

  it('refuses a decision aimed at a step that is not a gate', async () => {
    const { runId } = await seedGate({ name: 'gate-wrong-step-type' });
    const agentStep = await stepRuns.beginStepRun({
      runId,
      stepId: 'draft',
      stepType: 'cursor-agent',
    });

    await expect(
      approval.submitApprovalDecision({
        stepRunId: agentStep.id,
        deciderUserId: INITIATOR,
        decision: 'approved',
      })
    ).rejects.toThrow(/not an approval gate/);
  });

  it('refuses a decision on a step run that does not exist', async () => {
    await expect(
      approval.submitApprovalDecision({
        stepRunId: '00000000-0000-0000-0000-000000000000',
        deciderUserId: INITIATOR,
        decision: 'approved',
      })
    ).rejects.toThrow(/No approval gate/);
  });
});
