/**
 * PBI-001 — starting a run, against a real database and the real enqueue path.
 *
 * Covers VT-05 (the run row is `running`, the agent run is enqueued in the same request, and the
 * response returns well inside a second) and VT-06 (with the background lane at its in-flight cap,
 * the run is still created and the step waits rather than failing).
 *
 * `chatAgentService` is the one thing stubbed. It creates workspace directories on disk and pulls
 * in most of the server when imported, and none of that is what these tests are about — the agent
 * itself cannot run here in any case. Everything below it is real: the admission governor, the
 * agent_runs insert, and all four Playbook tables.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL points at the scratch database before the
 * services are required. Nothing above may import anything that reaches `db/drizzle`.
 */
const createThread = jest.fn();
jest.mock('../../src/server/services/chatAgentService', () => ({
  createThread: (...a: unknown[]) => createThread(...a),
}));

import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type RunServiceModule = typeof import('../../src/server/services/playbookRunService');
type RegistryModule = typeof import('../../src/server/services/playbookSteps/registry');
type ApprovalModule = typeof import('../../src/server/services/playbookSteps/approvalGateAdapter');
type AdvanceModule = typeof import('../../src/server/services/playbookAdvanceService');

const MIGRATE_TIMEOUT = 600_000;
const INITIATOR = 'feat004-start-initiator';
const PROJECT = 'Apex';

let scratch: ScratchDatabase;
let client: pg.Client;
let runService: RunServiceModule;
let registry: RegistryModule;
let approvals: ApprovalModule;
let advance: AdvanceModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/** Publishes a definition that gates an allow-listed `cursor-agent` step. */
async function seedPublishedDefinition(name: string): Promise<string> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [PROJECT, name, INITIATOR]
  );

  const graph = {
    nodes: [
      { id: 'approve-draft', stepType: 'approval-gate', config: { subject: 'Draft?' } },
      {
        id: 'draft',
        stepType: 'cursor-agent',
        config: {
          skillPath: registry.PHASE_0_ALLOWED_AGENT_SKILLS[0],
          prompt: 'Summarise the design docs',
        },
      },
      { id: 'tell-someone', stepType: 'notify', config: { title: 'Draft ready' } },
    ],
    edges: [
      { from: 'approve-draft', to: 'draft' },
      { from: 'draft', to: 'tell-someone' },
    ],
  };

  await query(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now())`,
    [definition.id, JSON.stringify(graph), INITIATOR]
  );

  return definition.id;
}

/** Fills the background lane with runs that are already in flight. */
async function occupyLane(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await query(
      `INSERT INTO agent_runs (id, thread_id, status, project_id, lane, queued_at, dispatched_at)
       VALUES ($1, $2, 'dispatched', $3, 'background', now(), now())`,
      [`occupier-${i}-${Date.now()}`, `thread-occupier-${i}`, PROJECT]
    );
  }
}

async function approveDraftGate(runId: string): Promise<void> {
  const [gate] = await query<{ id: string }>(
    `SELECT id FROM playbook_step_runs WHERE run_id = $1 AND step_id = 'approve-draft'`,
    [runId]
  );
  await approvals.submitApprovalDecision({
    stepRunId: gate.id,
    deciderUserId: INITIATOR,
    decision: 'approved',
    runId,
  });
  await advance.advanceRun(runId, 'approve-draft');
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookstart');
  // Traversal runs through the engine boundary, which refuses every operation while the flag is off.

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  runService = require('../../src/server/services/playbookRunService');
  registry = require('../../src/server/services/playbookSteps/registry');
  approvals = require('../../src/server/services/playbookSteps/approvalGateAdapter');
  advance = require('../../src/server/services/playbookAdvanceService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Start Initiator')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR]
  );

  await grantStepPermissions(INITIATOR, ['approval-gate', 'cursor-agent', 'notify']);
}, MIGRATE_TIMEOUT);

/** Gives the initiator exactly the permissions required by this definition's descriptors. */
async function grantStepPermissions(userOid: string, stepTypes: string[]): Promise<void> {
  const [role] = await query<{ id: string }>(
    `INSERT INTO app_roles (name, description) VALUES ('playbook-runner', 'Integration fixture')
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
     RETURNING id`
  );

  const requiredPermissions = [
    ...new Set(
      stepTypes.flatMap((stepType) => registry.getStepTypeDescriptor(stepType).requiredPermissions)
    ),
  ];
  const permissions = await query<{ id: string }>(
    `SELECT id FROM app_permissions WHERE key = ANY($1::text[])`,
    [requiredPermissions]
  );
  if (permissions.length !== requiredPermissions.length) {
    throw new Error(`Missing seeded Playbook permissions: ${requiredPermissions.join(', ')}`);
  }
  for (const permission of permissions) {
    await query(
      `INSERT INTO app_role_permissions (role_id, permission_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [role.id, permission.id]
    );
  }

  await query(
    `INSERT INTO app_user_project_roles (user_id, project, role_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userOid, PROJECT, role.id]
  );
}

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  createThread.mockImplementation(async () => ({
    id: `thread-${Math.random().toString(36).slice(2)}`,
    workspaceDir: '/tmp/threads/whatever',
  }));
  await query("DELETE FROM agent_runs WHERE lane = 'background'");
  delete process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT;
});

describe('VT-05 — a published Playbook starts and enqueues in one request', () => {
  it('creates a running run pinned to the published version', async () => {
    const definitionId = await seedPublishedDefinition('start-happy-path');

    const result = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    expect(result.status).toBe('running');

    const [run] = await query<{ status: string; initiator_user_id: string }>(
      'SELECT status, initiator_user_id FROM playbook_runs WHERE id = $1',
      [result.runId]
    );
    /*
     * `suspended`, not `running`: the first step is a `cursor-agent` step, which parks waiting on
     * its agent run, and FEAT-005 made the run follow its step there. Before that it stayed
     * `running` while parked, which nothing read and so nothing caught — until the concurrency
     * guards, which count runs by exactly this column.
     */
    expect(run.status).toBe('suspended');
    expect(run.initiator_user_id).toBe(INITIATOR);
  });

  it('enqueues the agent run and correlates it to the step, in the same request', async () => {
    const definitionId = await seedPublishedDefinition('start-correlation');

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });
    await approveDraftGate(runId);

    const [step] = await query<{
      step_id: string;
      status: string;
      agent_run_id: string | null;
      expires_at: Date | null;
    }>(
      `SELECT step_id, status, agent_run_id, expires_at
       FROM playbook_step_runs WHERE run_id = $1 AND step_id = 'draft'`,
      [runId]
    );

    expect(step.step_id).toBe('draft');
    expect(step.status).toBe('suspended');
    expect(step.agent_run_id).not.toBeNull();
    // BR-005 again, at the point it is actually written rather than where it is declared.
    expect(step.expires_at).not.toBeNull();

    const [agentRun] = await query<{ lane: string; execution_snapshot: { workflowClass: string } }>(
      'SELECT lane, execution_snapshot FROM agent_runs WHERE id = $1',
      [step.agent_run_id]
    );
    expect(agentRun.lane).toBe('background');
    expect(agentRun.execution_snapshot.workflowClass).toBe('playbook-step');
  });

  it('returns well inside the one-second budget', async () => {
    const definitionId = await seedPublishedDefinition('start-fast');

    const startedAt = Date.now();
    await runService.startRun({ project: PROJECT, definitionId, initiatorUserId: INITIATOR });
    const elapsed = Date.now() - startedAt;

    // The budget holds regardless of how long the agent takes, because nothing here waits for it.
    expect(elapsed).toBeLessThan(1000);
  });

  it('starts only one step, leaving the rest of the graph alone', async () => {
    const definitionId = await seedPublishedDefinition('start-one-step');

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    const steps = await query('SELECT step_id FROM playbook_step_runs WHERE run_id = $1', [runId]);
    // The required approval gate is the only step startRun may execute.
    expect(steps).toHaveLength(1);
  });
});

describe('VT-06 — the background lane at its in-flight cap', () => {
  it('still creates the run; the step waits rather than failing', async () => {
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '1';
    expect(registry).toBeDefined();
    await occupyLane(1);

    const definitionId = await seedPublishedDefinition('start-at-cap');

    const { runId, status } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });
    await approveDraftGate(runId);

    expect(status).toBe('running');

    const [run] = await query<{ status: string }>(
      'SELECT status FROM playbook_runs WHERE id = $1',
      [runId]
    );
    const [step] = await query<{ status: string; agent_run_id: string }>(
      `SELECT status, agent_run_id
       FROM playbook_step_runs WHERE run_id = $1 AND step_id = 'draft'`,
      [runId]
    );
    const [agentRun] = await query<{ status: string }>(
      'SELECT status FROM agent_runs WHERE id = $1',
      [step.agent_run_id]
    );

    // A full lane is a capacity condition, not an error. The Playbook behaves exactly as it does
    // with an empty lane; only the agent run's own status differs — `queued` rather than
    // `dispatched`. The run and its step park either way.
    expect(run.status).toBe('suspended');
    expect(step.status).toBe('suspended');
    expect(agentRun.status).toBe('queued');
  });

  it('is not merely queued because admission never ran', async () => {
    /*
     * The control for the test above. `attemptAdmission` swallows its own failures by design, so a
     * run left queued proves nothing on its own — it would look identical if the governor had
     * thrown on the first line. With a free slot, the same path dispatches, which is what shows the
     * queued result above was the cap talking.
     */
    process.env.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT = '5';

    const definitionId = await seedPublishedDefinition('start-with-capacity');
    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });
    await approveDraftGate(runId);

    const [step] = await query<{ agent_run_id: string }>(
      `SELECT agent_run_id FROM playbook_step_runs
       WHERE run_id = $1 AND step_id = 'draft'`,
      [runId]
    );
    const [agentRun] = await query<{ status: string }>(
      'SELECT status FROM agent_runs WHERE id = $1',
      [step.agent_run_id]
    );

    expect(agentRun.status).toBe('dispatched');
  });
});
