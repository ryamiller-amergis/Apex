/**
 * PBI-004 — a run picks up at its next step, and reaches its own end.
 *
 * This is the half of PBI-004 that FEAT-005 left unbuilt. `resumeStepRun` moved a parked step to
 * `completed` and put the run back to `running`, and there it stayed: nothing read the pinned
 * graph's edges to work out what came next, so no Playbook could reach its final step. The gap
 * survived FEAT-005 and FEAT-006 because every test that needed a multi-step run inserted the step
 * rows itself, which is exactly the shape of fixture that cannot notice missing orchestration.
 *
 * So these tests deliberately provision *nothing* beyond a published definition. Every step row
 * below is created by the system under test. A fixture that pre-creates step rows here would
 * re-introduce the blind spot this file exists to close.
 *
 * `chatAgentService` is stubbed for the same reason as `playbook-run-start`: it writes workspace
 * directories and drags in most of the server, and the agent cannot run here regardless. The agent
 * step's *completion* is delivered the way production delivers it — a terminal agent-run event.
 */
const createThread = jest.fn();
jest.mock('../../src/server/services/chatAgentService', () => ({
  createThread: (...a: unknown[]) => createThread(...a),
  readOutputValidationScorecard: () => null,
  readOutputValidationScorecardMd: () => null,
}));

import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type RunServiceModule = typeof import('../../src/server/services/playbookRunService');
type AdvanceModule = typeof import('../../src/server/services/playbookAdvanceService');
type ApprovalModule = typeof import('../../src/server/services/playbookSteps/approvalGateAdapter');
type TerminalEventModule = typeof import('../../src/server/services/playbookTerminalEventService');
type ProjectionModule = typeof import('../../src/server/services/playbookRunProjectionService');
type RegistryModule = typeof import('../../src/server/services/playbookSteps/registry');

const MIGRATE_TIMEOUT = 600_000;
const INITIATOR = 'advance-initiator';
const PROJECT = 'Apex';

let scratch: ScratchDatabase;
let client: pg.Client;
let runService: RunServiceModule;
let advance: AdvanceModule;
let approvals: ApprovalModule;
let terminalEvents: TerminalEventModule;
let projection: ProjectionModule;
let registry: RegistryModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

interface GraphNode {
  id: string;
  stepType: string;
  config?: Record<string, unknown>;
}

/** Publishes a linear definition. Only the definition — no run, and no step rows. */
async function publishDefinition(name: string, nodes: GraphNode[]): Promise<string> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [PROJECT, name, INITIATOR]
  );

  const graph = {
    nodes: nodes.map((n) => ({ id: n.id, stepType: n.stepType, config: n.config ?? {} })),
    edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
  };

  await query(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now())`,
    [definition.id, JSON.stringify(graph), INITIATOR]
  );

  return definition.id;
}

/** The step rows the system created, in the order it created them. */
async function stepsOf(runId: string): Promise<Array<{ step_id: string; status: string }>> {
  return query<{ step_id: string; status: string }>(
    'SELECT step_id, status FROM playbook_step_runs WHERE run_id = $1 ORDER BY started_at, id',
    [runId]
  );
}

async function runStatus(runId: string): Promise<string> {
  const [row] = await query<{ status: string }>(
    'SELECT status FROM playbook_runs WHERE id = $1',
    [runId]
  );
  return row.status;
}

async function stepRunIdFor(runId: string, stepId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    'SELECT id FROM playbook_step_runs WHERE run_id = $1 AND step_id = $2',
    [runId, stepId]
  );
  return row.id;
}

/** Gives the initiator exactly the permissions required by the step types this suite executes. */
async function grantStepPermissions(userOid: string, stepTypes: string[]): Promise<void> {
  const [role] = await query<{ id: string }>(
    `INSERT INTO app_roles (name, description) VALUES ('playbook-advance-runner', 'Fixture')
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id`
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

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookadvance');
  // Traversal runs through the engine boundary, which refuses every operation while the flag is off.

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required after DATABASE_URL is repointed; a static import is hoisted and would bind the pool
     to whatever URL was set when the file loaded. */
  runService = require('../../src/server/services/playbookRunService');
  advance = require('../../src/server/services/playbookAdvanceService');
  approvals = require('../../src/server/services/playbookSteps/approvalGateAdapter');
  terminalEvents = require('../../src/server/services/playbookTerminalEventService');
  projection = require('../../src/server/services/playbookRunProjectionService');
  registry = require('../../src/server/services/playbookSteps/registry');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Advance Initiator')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR]
  );
  await grantStepPermissions(INITIATOR, ['approval-gate', 'cursor-agent', 'notify']);
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

beforeEach(() => {
  jest.clearAllMocks();
  createThread.mockImplementation(async () => ({
    id: `thread-${Math.random().toString(36).slice(2)}`,
    workspaceDir: '/tmp/threads/whatever',
  }));
});

describe('a gate approval starts the next step', () => {
  it('runs the step after the gate and completes the run', async () => {
    const definitionId = await publishDefinition('advance-gate-then-notify', [
      { id: 'approve', stepType: 'approval-gate', config: { subject: 'Ship it?' } },
      { id: 'announce', stepType: 'notify', config: { title: 'Shipped' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    // The gate parks on its own; only the first step has run so far.
    expect(await stepsOf(runId)).toEqual([{ step_id: 'approve', status: 'suspended' }]);
    expect(await runStatus(runId)).toBe('suspended');

    const decision = await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });
    expect(decision.outcome).toBe('recorded');

    // The part that did not exist: the run works out what comes next and runs it.
    await advance.advanceRun(runId);

    expect(await stepsOf(runId)).toEqual([
      { step_id: 'approve', status: 'completed' },
      { step_id: 'announce', status: 'completed' },
    ]);
    expect(await runStatus(runId)).toBe('completed');
  });

  it('records a completedAt on the run, so the status view can show it ended', async () => {
    const definitionId = await publishDefinition('advance-completed-at', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'announce', stepType: 'notify', config: { title: 'Done' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });
    await advance.advanceRun(runId);

    const [row] = await query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM playbook_runs WHERE id = $1',
      [runId]
    );
    expect(row.completed_at).not.toBeNull();
  });
});

describe('a chain of non-suspending steps runs to the end in one advance', () => {
  it('does not stop after the first one', async () => {
    const definitionId = await publishDefinition('advance-chain', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'first', stepType: 'notify', config: { title: 'One' } },
      { id: 'second', stepType: 'notify', config: { title: 'Two' } },
      { id: 'third', stepType: 'notify', config: { title: 'Three' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });
    await advance.advanceRun(runId);

    expect((await stepsOf(runId)).map((s) => s.step_id)).toEqual([
      'approve',
      'first',
      'second',
      'third',
    ]);
    expect(await runStatus(runId)).toBe('completed');
  });
});

describe('advancing is a no-op unless the run is genuinely waiting for its next step', () => {
  it('does nothing while a step is still open', async () => {
    const definitionId = await publishDefinition('advance-while-parked', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'announce', stepType: 'notify', config: { title: 'Nope' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    // The gate is still suspended. Advancing here would run the step the gate exists to gate.
    const outcome = await advance.advanceRun(runId);

    expect(outcome.advanced).toBe(false);
    expect(await stepsOf(runId)).toEqual([{ step_id: 'approve', status: 'suspended' }]);
  });

  it('is idempotent — a second advance after completion starts nothing', async () => {
    const definitionId = await publishDefinition('advance-twice', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'announce', stepType: 'notify', config: { title: 'Once' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });

    await advance.advanceRun(runId);
    const afterFirst = await stepsOf(runId);

    await advance.advanceRun(runId);
    const afterSecond = await stepsOf(runId);

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.filter((s) => s.step_id === 'announce')).toHaveLength(1);
  });

  it('does not revive a run whose step failed', async () => {
    const definitionId = await publishDefinition('advance-after-failure', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'announce', stepType: 'notify', config: { title: 'Unreachable' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    await query(
      `UPDATE playbook_step_runs SET status = 'failed' WHERE run_id = $1 AND step_id = 'approve'`,
      [runId]
    );

    const outcome = await advance.advanceRun(runId);

    expect(outcome.advanced).toBe(false);
    expect((await stepsOf(runId)).map((s) => s.step_id)).toEqual(['approve']);
  });
});

describe('an agent step completing advances the run, through the real terminal-event path', () => {
  it('runs the step after the agent step when its terminal event arrives', async () => {
    const definitionId = await publishDefinition('advance-after-agent', [
      { id: 'approve', stepType: 'approval-gate', config: { subject: 'Run agent?' } },
      {
        id: 'ask',
        stepType: 'cursor-agent',
        config: {
          skillPath: registry.PHASE_0_ALLOWED_AGENT_SKILLS[0],
          prompt: 'Summarise the design docs',
        },
      },
      { id: 'announce', stepType: 'notify', config: { title: 'Answered' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });
    await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });
    await advance.advanceRun(runId, 'approve');

    const [agentStep] = await query<{ agent_run_id: string | null }>(
      "SELECT agent_run_id FROM playbook_step_runs WHERE run_id = $1 AND step_id = 'ask'",
      [runId]
    );
    expect(agentStep.agent_run_id).not.toBeNull();

    await terminalEvents.handleTerminalAgentRunEvent({
      runId: agentStep.agent_run_id!,
      threadId: 'thread-whatever',
      type: 'done',
      status: 'completed',
      timestamp: new Date().toISOString(),
      sequence: 1,
    } as Parameters<TerminalEventModule['handleTerminalAgentRunEvent']>[0]);

    expect(await stepsOf(runId)).toEqual([
      { step_id: 'approve', status: 'completed' },
      { step_id: 'ask', status: 'completed' },
      { step_id: 'announce', status: 'completed' },
    ]);
    expect(await runStatus(runId)).toBe('completed');
  });
});

describe('the projection reports a completed run as completed', () => {
  it('shows every step completed and no suspension', async () => {
    const definitionId = await publishDefinition('advance-projection', [
      { id: 'approve', stepType: 'approval-gate', config: {} },
      { id: 'announce', stepType: 'notify', config: { title: 'Visible' } },
    ]);

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId,
      initiatorUserId: INITIATOR,
    });

    await approvals.submitApprovalDecision({
      stepRunId: await stepRunIdFor(runId, 'approve'),
      deciderUserId: INITIATOR,
      decision: 'approved',
      runId,
    });
    await advance.advanceRun(runId);

    const detail = await projection.getRun(PROJECT, runId);

    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('completed');
    expect(detail!.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
    expect(detail!.suspension).toBeNull();
  });
});
