/**
 * TBI-021 and TBI-022 — the reconciliation sweep and `expired`.
 *
 * Covers VT-04 (a missed terminal event is recovered), VT-05 and VT-09 through VT-11 (PBI-005's
 * four criteria), VT-08 (the last-run outcome is observable), VT-12 (`expired` has exactly one
 * writer) and VT-06 (two concurrent passes under the advisory lock do each row once).
 *
 * Against a real database on purpose. The deadline comparison this Feature turns on is a SQL
 * predicate — `expires_at <= now` — and the three boundary cases PBI-005 names sit one millisecond
 * apart. A mocked `db` would assert the mock, not the comparison, and the comparison is the thing
 * that can be wrong.
 */
import pg from 'pg';
import { PLAYBOOK_GUARD_LIMITS } from '../../src/shared/types/playbook';
import { createScratchDatabase, enablePlaybooks, ScratchDatabase } from './support/scratch-db';

type ReconciliationModule = typeof import('../../src/server/services/playbookReconciliationService');
type RunServiceModule = typeof import('../../src/server/services/playbookRunService');
type RegistryModule = typeof import('../../src/server/services/playbookSteps/registry');

const MIGRATE_TIMEOUT = 600_000;
const USER_OID = 'feat005-sweep-user';
const PROJECT = 'Apex';

/** The instant every test measures against. Fixed so a slow test cannot drift across a deadline. */
const NOW = new Date('2026-09-19T12:00:00.000Z');
const clock = () => NOW;

let scratch: ScratchDatabase;
let client: pg.Client;
let sweep: ReconciliationModule;
let runService: RunServiceModule;
let registry: RegistryModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

let definitionCounter = 0;

async function seedRun(status = 'suspended', project = PROJECT): Promise<string> {
  definitionCounter += 1;
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [project, `sweep-def-${definitionCounter}`, USER_OID]
  );
  /*
   * A one-node graph matching the step `addStep` inserts, rather than an empty one. The sweep now
   * advances runs as well as resuming steps, so a graph that disagrees with the step rows would
   * make these tests assert against a state no real run can be in.
   */
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now()) RETURNING id`,
    [
      definition.id,
      JSON.stringify({ nodes: [{ id: 'gate', stepType: 'approval-gate', config: {} }], edges: [] }),
      USER_OID,
    ]
  );
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [project, version.id, USER_OID, status]
  );
  return run.id;
}

async function addStep(
  runId: string,
  step: { status: string; expiresAt?: string | null; agentRunId?: string | null }
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at, agent_run_id)
     VALUES ($1, 'gate', 'approval-gate', $2, $3, $4) RETURNING id`,
    [runId, step.status, step.expiresAt ?? null, step.agentRunId ?? null]
  );
  return row.id;
}

async function addAgentRun(status: string): Promise<string> {
  /*
   * A non-terminal run must carry `timeout_at` — `agent_runs_non_terminal_timeout_at_check`
   * enforces that every live run has something the reaper can measure it against. Terminal rows
   * are past needing one.
   */
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  const [row] = await query<{ id: string }>(
    `INSERT INTO agent_runs (thread_id, status, timeout_at) VALUES ($1, $2, $3) RETURNING id`,
    [
      `thread-${Math.random().toString(36).slice(2)}`,
      status,
      terminal ? null : new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    ]
  );
  return row.id;
}

async function statusOf(runId: string, stepRunId: string): Promise<[string, string]> {
  const [run] = await query<{ status: string }>('SELECT status FROM playbook_runs WHERE id = $1', [
    runId,
  ]);
  const [step] = await query<{ status: string }>(
    'SELECT status FROM playbook_step_runs WHERE id = $1',
    [stepRunId]
  );
  return [run.status, step.status];
}

/** A deadline offset from the fixed instant, in milliseconds. Negative is in the past. */
function deadline(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbooksweep');
  // Traversal runs through the engine boundary, which refuses every operation while the flag is off.
  await enablePlaybooks(scratch.connectionString);

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  sweep = require('../../src/server/services/playbookReconciliationService');
  runService = require('../../src/server/services/playbookRunService');
  registry = require('../../src/server/services/playbookSteps/registry');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Sweep User')
     ON CONFLICT (oid) DO NOTHING`,
    [USER_OID]
  );
  await grantPlaybooksRun(USER_OID);
}, MIGRATE_TIMEOUT);

/**
 * Gives the initiator the project role carrying `playbooks:run`.
 *
 * Needed by the one test that starts a run for real: TBI-024 re-checks the initiator's access
 * immediately before a side-effecting step, and an initiator with no role at all is refused there.
 */
async function grantPlaybooksRun(userOid: string): Promise<void> {
  const [role] = await query<{ id: string }>(
    `INSERT INTO app_roles (name, description) VALUES ('playbook-runner', 'Integration fixture')
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
     RETURNING id`
  );
  const [permission] = await query<{ id: string }>(
    `INSERT INTO app_permissions (key, description) VALUES ('playbooks:run', 'Start Playbook runs')
     ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
     RETURNING id`
  );
  await query(
    `INSERT INTO app_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [role.id, permission.id]
  );
  await query(
    `INSERT INTO app_user_project_roles (user_id, project, role_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userOid, PROJECT, role.id]
  );
}

/**
 * Starts a real run that parks on an agent step, and returns it with its agent run marked
 * completed — a terminal event that was never delivered.
 *
 * Built through `startRun` rather than by inserting rows, because the engine must have a snapshot
 * of this run for the sweep to be able to carry it on. Hand-written rows produce a run that Apex
 * believes in and the engine has never heard of, which is not a state the system can reach: a run
 * row is only ever created by `startRun`, which puts it on the engine in the same call.
 */
async function startRunMissingItsTerminalEvent(): Promise<{
  runId: string;
  stepRunId: string;
}> {
  definitionCounter += 1;
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [PROJECT, `sweep-agent-def-${definitionCounter}`, USER_OID]
  );
  await query(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now())`,
    [
      definition.id,
      JSON.stringify({
        nodes: [
          {
            id: 'work',
            stepType: 'cursor-agent',
            config: {
              skillPath: registry.PHASE_0_ALLOWED_AGENT_SKILLS[0],
              prompt: 'Do the thing',
            },
          },
        ],
        edges: [],
      }),
      USER_OID,
    ]
  );

  const { runId } = await runService.startRun({
    project: PROJECT,
    definitionId: definition.id,
    initiatorUserId: USER_OID,
  });

  const [step] = await query<{ id: string; agent_run_id: string }>(
    'SELECT id, agent_run_id FROM playbook_step_runs WHERE run_id = $1',
    [runId]
  );

  // The agent finished; the event announcing it never arrived. That is what the sweep is for.
  await query(`UPDATE agent_runs SET status = 'completed' WHERE id = $1`, [step.agent_run_id]);

  return { runId, stepRunId: step.id };
}

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-05 / VT-09 / VT-10 — the deadline boundary', () => {
  it('VT-05: expires a suspension whose deadline has passed', async () => {
    const runId = await seedRun();
    const stepRunId = await addStep(runId, { status: 'suspended', expiresAt: deadline(-1) });

    const outcome = await sweep.runReconciliationPass({ clock });

    expect(outcome.expired).toBe(1);
    expect(await statusOf(runId, stepRunId)).toEqual(['expired', 'expired']);
  });

  it('VT-09: leaves a suspension whose deadline has not passed', async () => {
    const runId = await seedRun();
    const stepRunId = await addStep(runId, { status: 'suspended', expiresAt: deadline(1) });

    await sweep.runReconciliationPass({ clock });

    expect(await statusOf(runId, stepRunId)).toEqual(['suspended', 'suspended']);
  });

  it('VT-10: expires a deadline falling at the exact sweep instant, with no grace margin', async () => {
    const runId = await seedRun();
    const stepRunId = await addStep(runId, { status: 'suspended', expiresAt: deadline(0) });

    await sweep.runReconciliationPass({ clock });

    // PBI-005's third criterion: a deadline that has passed is treated as passed. `<=`, not `<`.
    expect(await statusOf(runId, stepRunId)).toEqual(['expired', 'expired']);
  });
});

describe('VT-11 — a run that already finished is never overwritten', () => {
  it('leaves a completed run alone even though its old deadline has passed', async () => {
    const runId = await seedRun('completed');
    const stepRunId = await addStep(runId, { status: 'completed', expiresAt: deadline(-60_000) });

    const outcome = await sweep.runReconciliationPass({ clock });

    expect(outcome.expired).toBe(0);
    expect(await statusOf(runId, stepRunId)).toEqual(['completed', 'completed']);
  });

  it('leaves a cancelled run alone', async () => {
    const runId = await seedRun('cancelled');
    const stepRunId = await addStep(runId, { status: 'cancelled', expiresAt: deadline(-60_000) });

    await sweep.runReconciliationPass({ clock });

    expect(await statusOf(runId, stepRunId)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('VT-04 — a missed terminal agent-run event is recovered', () => {
  it('resumes a suspended step whose agent run had already completed', async () => {
    const { runId, stepRunId } = await startRunMissingItsTerminalEvent();

    const outcome = await sweep.runReconciliationPass({ clock });

    expect(outcome.resumed).toBe(1);

    /*
     * The run reads `completed`, not `running`. Resuming the step is only half of what the pass
     * owes this run: `work` is the graph's only node, so once it completes there is nothing left
     * to start and the run is finished. Leaving it at `running` — which is what happened before
     * the sweep advanced runs as well as resuming steps — meant a run recovered by the sweep could
     * never reach a terminal state, and nothing downstream would look at it again.
     */
    expect(await statusOf(runId, stepRunId)).toEqual(['completed', 'completed']);
    expect(outcome.advanced).toBe(1);
  });

  it('fails the step, retryably, when the agent run ended badly', async () => {
    const runId = await seedRun();
    const agentRunId = await addAgentRun('failed');
    const stepRunId = await addStep(runId, {
      status: 'suspended',
      expiresAt: deadline(60 * 60 * 1000),
      agentRunId,
    });

    await sweep.runReconciliationPass({ clock });

    const [, stepStatus] = await statusOf(runId, stepRunId);
    expect(stepStatus).toBe('failed_retryable');
  });

  it('leaves a step alone while its agent run is still running', async () => {
    const runId = await seedRun();
    const agentRunId = await addAgentRun('running');
    const stepRunId = await addStep(runId, {
      status: 'suspended',
      expiresAt: deadline(60 * 60 * 1000),
      agentRunId,
    });

    const outcome = await sweep.runReconciliationPass({ clock });

    expect(outcome.resumed).toBe(0);
    expect(await statusOf(runId, stepRunId)).toEqual(['suspended', 'suspended']);
  });
});

describe('VT-08 — the last-run outcome is observable', () => {
  it('records a timestamp, per-category counts and a duration', async () => {
    sweep.clearLastSweepOutcome();
    expect(sweep.getLastSweepOutcome()).toBeNull();

    await sweep.runReconciliationPass({ clock });
    const outcome = sweep.getLastSweepOutcome();

    expect(outcome).not.toBeNull();
    expect(outcome!.startedAt).toBe(NOW.toISOString());
    expect(typeof outcome!.durationMs).toBe('number');
    expect(outcome).toEqual(
      expect.objectContaining({
        resumed: expect.any(Number),
        expired: expect.any(Number),
        orphaned: expect.any(Number),
      })
    );
    /*
     * The distinction TBI-021's DoD exists for: a dead sweep and an idle sweep both report zero.
     * The timestamp is the only thing that separates them, so it must always be present.
     */
    expect(outcome!.error).toBeUndefined();
  });

  it('counts a suspension with neither a deadline nor an agent run as an orphan', async () => {
    const runId = await seedRun();
    await addStep(runId, { status: 'suspended', expiresAt: null, agentRunId: null });

    const outcome = await sweep.runReconciliationPass({ clock });

    expect(outcome.orphaned).toBeGreaterThanOrEqual(1);
  });
});

describe('VT-06 — two concurrent passes under the advisory lock', () => {
  it('expires each overdue row exactly once across both passes', async () => {
    const runIds = await Promise.all([seedRun(), seedRun(), seedRun()]);
    const stepRunIds = await Promise.all(
      runIds.map((runId) => addStep(runId, { status: 'suspended', expiresAt: deadline(-1) }))
    );

    const [first, second] = await Promise.all([
      sweep.runReconciliationPassLocked({ clock }),
      sweep.runReconciliationPassLocked({ clock }),
    ]);

    // The lock serialises them, so the total is three however the work divides between the two.
    expect(first.expired + second.expired).toBe(3);

    for (const [index, stepRunId] of stepRunIds.entries()) {
      expect(await statusOf(runIds[index], stepRunId)).toEqual(['expired', 'expired']);
    }
  });
});

describe('VT-13 — `expired` is distinct from the other terminal states', () => {
  it('reads back as expired, not collapsed into failed or cancelled', async () => {
    const expiredRun = await seedRun();
    const expiredStep = await addStep(expiredRun, {
      status: 'suspended',
      expiresAt: deadline(-1),
    });
    const cancelledRun = await seedRun('cancelled');
    const failedRun = await seedRun('failed');

    await sweep.runReconciliationPass({ clock });

    /*
     * The point of the Feature, stated as a test. A run nobody answered and a run somebody stopped
     * are different events, and the difference is the whole reason `expired` exists rather than
     * folding both into `failed`. Whoever reads the status view needs to know which happened.
     */
    const statuses = await query<{ id: string; status: string }>(
      'SELECT id, status FROM playbook_runs WHERE id = ANY($1)',
      [[expiredRun, cancelledRun, failedRun]]
    );
    const byId = new Map(statuses.map((row) => [row.id, row.status]));

    expect(byId.get(expiredRun)).toBe('expired');
    expect(byId.get(cancelledRun)).toBe('cancelled');
    expect(byId.get(failedRun)).toBe('failed');
    expect(new Set(byId.values()).size).toBe(3);

    const [step] = await query<{ status: string }>(
      'SELECT status FROM playbook_step_runs WHERE id = $1',
      [expiredStep]
    );
    expect(step.status).toBe('expired');
  });
});

describe('VT-17 — the suspended-run ceiling', () => {
  it('refuses a new suspension at the ceiling, naming it', async () => {
    const { assertSuspendedRunCapacity, PlaybookGuardViolationError } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- after DATABASE_URL is set
      require('../../src/server/services/playbookGuardService') as typeof import('../../src/server/services/playbookGuardService');

    const ceilingProject = `SuspendCeiling-${Date.now()}`;
    for (let i = 0; i < PLAYBOOK_GUARD_LIMITS.maxSuspendedRunsPerProject; i += 1) {
      await seedRun('suspended', ceilingProject);
    }

    try {
      await assertSuspendedRunCapacity(ceilingProject);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as InstanceType<typeof PlaybookGuardViolationError>;
      expect(violation.violation.kind).toBe('suspended-run-ceiling');
      expect(violation.message).toContain(
        String(PLAYBOOK_GUARD_LIMITS.maxSuspendedRunsPerProject)
      );
    }
  });

  it('permits a suspension one below the ceiling', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after DATABASE_URL is set
    const { assertSuspendedRunCapacity } = require('../../src/server/services/playbookGuardService') as typeof import('../../src/server/services/playbookGuardService');

    const project = `SuspendUnder-${Date.now()}`;
    for (let i = 0; i < PLAYBOOK_GUARD_LIMITS.maxSuspendedRunsPerProject - 1; i += 1) {
      await seedRun('suspended', project);
    }

    await expect(assertSuspendedRunCapacity(project)).resolves.toBeUndefined();
  });

  it('does not count a run against its own second suspension', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after DATABASE_URL is set
    const { assertSuspendedRunCapacity } = require('../../src/server/services/playbookGuardService') as typeof import('../../src/server/services/playbookGuardService');

    const project = `SuspendSelf-${Date.now()}`;
    const runIds: string[] = [];
    for (let i = 0; i < PLAYBOOK_GUARD_LIMITS.maxSuspendedRunsPerProject; i += 1) {
      runIds.push(await seedRun('suspended', project));
    }

    /*
     * A run parking its second gate is already suspended and would otherwise be refused by its own
     * first suspension — a run with two gates could never pass the second one.
     */
    await expect(
      assertSuspendedRunCapacity(project, runIds[0])
    ).resolves.toBeUndefined();
  });
});

describe('VT-12 — `expired` has exactly one writer', () => {
  it('is written only by the reconciliation service', () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- node built-ins in a test */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const repoRoot = path.resolve(__dirname, '..', '..');
    const sourceRoot = path.join(repoRoot, 'src');

    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(child);
        return /\.tsx?$/.test(entry.name) ? [child] : [];
      });
    }

    /** Comments are stripped so prose about expiry is not mistaken for a write of it. */
    function stripComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    }

    const writers = walk(sourceRoot)
      .filter((file) => !file.includes('__tests__'))
      .filter((file) => {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        /*
         * Scoped to code that touches a Playbook table. `expired` is an ordinary word elsewhere —
         * PDF assembly sessions expire too — and the claim being made here is narrower than it
         * first sounds: no Playbook row reaches `expired` except through the sweep.
         */
        const touchesPlaybookRows = /playbookRuns|playbookStepRuns/.test(code);
        // A write is a status assignment, not a comparison or a vocabulary listing.
        return touchesPlaybookRows && /status:\s*'expired'/.test(code);
      })
      .map((file) => path.relative(repoRoot, file).replace(/\\/g, '/'));

    expect(writers).toEqual(['src/server/services/playbookReconciliationService.ts']);
  });
});
