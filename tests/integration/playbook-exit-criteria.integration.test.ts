/**
 * TBI-028 — Phase 0 exit criteria E1, E3 and E4, recorded as re-runnable tests.
 *
 * E2 lives in `playbook-exit-criterion-e2.integration.test.ts`, because it needs the child-process
 * kill machinery and keeping it here would make this file's setup heavier for the three criteria
 * that do not need it.
 *
 * The rule that shapes this file is TBI-028's non-functional requirement: **each criterion must
 * pass when run alone.** So every `describe` below provisions its own definition, its own run and
 * its own steps, and none reads a row another created. That is deliberately more setup than a
 * shared fixture would need — a shared fixture is exactly how one criterion comes to depend on
 * another having just run, and the failure mode is four passing criteria that turn into four
 * failures the first time someone runs them in a different order.
 *
 * Why these are tests rather than a checklist: the six things that can change under a version bump
 * are the same six a person would re-check by hand before moving the pin. A test that can be run
 * again turns an upgrade decision into evidence instead of a changelog reading.
 */
/*
 * E3 runs definition B for real, and B contains an agent step. `chatAgentService` writes workspace
 * directories and pulls in most of the server; the agent itself cannot run here in any case. Its
 * *completion* is delivered the way production delivers it — a terminal agent-run event.
 */
const createThread = jest.fn(async () => ({
  id: `thread-${Math.random().toString(36).slice(2)}`,
  workspaceDir: '/tmp/threads/whatever',
}));
jest.mock('../../src/server/services/chatAgentService', () => ({
  createThread: (...a: unknown[]) => createThread(...(a as [])),
}));

import pg from 'pg';
import { createScratchDatabase, listTables, ScratchDatabase } from './support/scratch-db';

type ProjectionModule = typeof import('../../src/server/services/playbookRunProjectionService');
type ApprovalModule = typeof import('../../src/server/services/playbookSteps/approvalGateAdapter');
type RunServiceModule = typeof import('../../src/server/services/playbookRunService');
type AdvanceModule = typeof import('../../src/server/services/playbookAdvanceService');
type TerminalEventModule = typeof import('../../src/server/services/playbookTerminalEventService');

const MIGRATE_TIMEOUT = 600_000;
const PROJECT = 'Apex';

let scratch: ScratchDatabase;
let client: pg.Client;
let projection: ProjectionModule;
let approvals: ApprovalModule;
let runService: RunServiceModule;
let advance: AdvanceModule;
let terminalEvents: TerminalEventModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/**
 * A whole run, provisioned from nothing.
 *
 * Every criterion calls this with its own names, which is what makes them independent. `label`
 * keeps the definition names unique so two criteria in the same file cannot collide on the
 * `(project, name)` unique index — and so a reader can tell from a row which criterion made it.
 */
async function provisionRun(
  label: string,
  steps: Array<{
    stepId: string;
    stepType: string;
    status: string;
    output?: Record<string, unknown>;
    expiresAt?: string | null;
  }>
): Promise<{ runId: string; versionId: string; stepRunIds: Record<string, string> }> {
  const initiator = `exit-${label}-initiator`;

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, $2)
     ON CONFLICT (oid) DO NOTHING`,
    [initiator, `Exit criterion ${label}`]
  );

  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [PROJECT, `exit-criterion-${label}`, initiator]
  );

  const graph = {
    nodes: steps.map((s) => ({ id: s.stepId, stepType: s.stepType, config: {} })),
    edges: steps.slice(1).map((s, i) => ({ from: steps[i].stepId, to: s.stepId })),
  };

  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions
       (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, $2, 'published', $3, now()) RETURNING id`,
    [definition.id, JSON.stringify(graph), initiator]
  );

  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      PROJECT,
      version.id,
      initiator,
      steps.some((s) => s.status === 'suspended') ? 'suspended' : 'running',
    ]
  );

  const stepRunIds: Record<string, string> = {};
  for (const step of steps) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO playbook_step_runs
         (run_id, step_id, step_type, status, output_inline, expires_at, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7) RETURNING id`,
      [
        run.id,
        step.stepId,
        step.stepType,
        step.status,
        step.output ? JSON.stringify(step.output) : null,
        step.expiresAt ?? null,
        step.status === 'completed' ? new Date().toISOString() : null,
      ]
    );
    stepRunIds[step.stepId] = row.id;
  }

  return { runId: run.id, versionId: version.id, stepRunIds };
}

/**
 * Gives a user the project role carrying `playbooks:run`.
 *
 * E3 calls `startRun` directly rather than through the route, so `requirePermission` never runs —
 * but TBI-024 re-checks the initiator's access again before each side-effecting step, and an
 * initiator with no role at all is refused there. Seeding a real role rather than stubbing keeps
 * that re-check honest.
 */
async function grantPlaybooksRun(userOid: string): Promise<void> {
  const [role] = await query<{ id: string }>(
    `INSERT INTO app_roles (name, description) VALUES ('exit-criteria-runner', 'Fixture')
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id`
  );
  const [permission] = await query<{ id: string }>(
    `INSERT INTO app_permissions (key, description) VALUES ('playbooks:run', 'Start Playbook runs')
     ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description RETURNING id`
  );
  await query(
    `INSERT INTO app_role_permissions (role_id, permission_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [role.id, permission.id]
  );
  await query(
    `INSERT INTO app_user_project_roles (user_id, project, role_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userOid, PROJECT, role.id]
  );
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookexit');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
   * Required after DATABASE_URL is repointed; a static import is hoisted and would bind the pool
   * to whatever URL was set when the file loaded. */
  projection = require('../../src/server/services/playbookRunProjectionService');
  approvals = require('../../src/server/services/playbookSteps/approvalGateAdapter');
  runService = require('../../src/server/services/playbookRunService');
  advance = require('../../src/server/services/playbookAdvanceService');
  terminalEvents = require('../../src/server/services/playbookTerminalEventService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

/* ── E1 ──────────────────────────────────────────────────────────────────────────────────────── */

describe('VT-17 — E1: a gate suspends, survives a restart, and resumes with prior outputs intact', () => {
  /**
   * "Survives a restart" is modelled by writing the state through one set of service calls and
   * reading it back through a connection that never saw them, after the in-memory caches those
   * calls populated have been discarded. `playbook-step-durability.integration.test.ts` proves the
   * harder half of this — that the row survives SIGKILL — and E2 below repeats the technique. What
   * E1 adds is the half that test does not cover: that the gate can still be *decided* afterwards.
   */
  it('resumes the gate after the process that parked it is gone, with earlier output intact', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { runId, stepRunIds } = await provisionRun('e1', [
      { stepId: 'ask', stepType: 'cursor-agent', status: 'completed', output: { answer: 'forty-two' } },
      { stepId: 'approve', stepType: 'approval-gate', status: 'suspended', expiresAt: deadline },
    ]);

    // The restart boundary: everything below reads state only from the database.
    const decision = await approvals.submitApprovalDecision({
      stepRunId: stepRunIds.approve,
      deciderUserId: `exit-e1-initiator`,
      decision: 'approved',
      runId,
    });

    // `recorded` is the adapter's success outcome; `already-decided` is its refusal. The gate
    // having actually moved is asserted below, on the step itself.
    expect(decision.outcome).toBe('recorded');

    const after = await projection.getRun(PROJECT, runId);
    expect(after).not.toBeNull();

    const gate = after!.steps.find((s) => s.stepId === 'approve')!;
    expect(gate.status).toBe('completed');

    // "With prior outputs intact" is the part of E1 that is easy to lose: a resume path that
    // rebuilt the step rows rather than updating them would pass every other assertion here.
    const earlier = after!.steps.find((s) => s.stepId === 'ask')!;
    expect(earlier.status).toBe('completed');
    expect(earlier.outputInline).toEqual({ answer: 'forty-two' });

    // And the run itself moved off suspended, rather than the step advancing alone.
    expect(after!.status).not.toBe('suspended');
  });

  it('refuses a second decision on the same gate rather than resuming it twice', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { runId, stepRunIds } = await provisionRun('e1-idempotent', [
      { stepId: 'approve', stepType: 'approval-gate', status: 'suspended', expiresAt: deadline },
    ]);

    await approvals.submitApprovalDecision({
      stepRunId: stepRunIds.approve,
      deciderUserId: 'exit-e1-idempotent-initiator',
      decision: 'approved',
      runId,
    });

    // A restart can mean a person clicks approve twice, having not seen the first take effect.
    const second = await approvals.submitApprovalDecision({
      stepRunId: stepRunIds.approve,
      deciderUserId: 'exit-e1-idempotent-initiator',
      decision: 'approved',
      runId,
    });

    expect(second.outcome).toBe('already-decided');
  });
});

/* ── E3 ──────────────────────────────────────────────────────────────────────────────────────── */

describe('VT-19 — E3: definition B runs end to end with zero lines of code changed', () => {
  it('executes B purely from its stored graph, with no B-specific branch in the codebase', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- node built-ins and the seed module */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const seed = require('../../scripts/seed-playbook-demos') as typeof import('../../scripts/seed-playbook-demos');
    /* eslint-enable @typescript-eslint/no-require-imports */

    /*
     * The mechanical statement of "zero lines changed": nothing in the application source names
     * definition B. If B needed a branch anywhere, that branch would have to identify B somehow —
     * by name, by id, by step order — and the name is the only one of those a grep can find, which
     * is why the demo definitions are named rather than numbered.
     */
    const APPLICATION_ROOTS = [
      path.join(__dirname, '..', '..', 'src', 'server'),
      path.join(__dirname, '..', '..', 'src', 'client'),
      path.join(__dirname, '..', '..', 'src', 'shared'),
    ];

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;

        const source = fs.readFileSync(full, 'utf8');
        if (source.includes(seed.DEFINITION_B.name) || /Demo B\b/.test(source)) {
          offenders.push(full);
        }
      }
    };
    for (const root of APPLICATION_ROOTS) walk(root);

    expect(offenders).toEqual([]);

    // The other half: B is made of nothing but the three Phase 0 step types, so there is no step
    // type it could need that A did not already exercise.
    const bTypes = new Set(seed.DEFINITION_B.graph.nodes.map((n) => n.stepType));
    const aTypes = new Set(seed.DEFINITION_A.graph.nodes.map((n) => n.stepType));
    expect([...bTypes].sort()).toEqual([...aTypes].sort());
  });

  /**
   * B, started and finished by the system rather than driven step by step.
   *
   * An earlier version of this test provisioned all three step rows itself and then completed each
   * one in turn. It passed while no graph traversal existed at all, which is the problem with it:
   * a test that creates the step rows cannot notice that nothing else would have. So the only row
   * written here is B's published definition. Every step row below is the system's own work, and
   * the run reaching `completed` is the system deciding it had run out of graph.
   */
  it('runs B end to end from its stored graph, creating every step itself', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports -- seed module */
    const seed = require('../../scripts/seed-playbook-demos') as typeof import('../../scripts/seed-playbook-demos');

    const initiator = 'exit-e3-runner';
    await query(
      `INSERT INTO app_users (oid, display_name) VALUES ($1, 'E3 Runner')
       ON CONFLICT (oid) DO NOTHING`,
      [initiator]
    );
    await grantPlaybooksRun(initiator);

    // B's actual graph, not a hand-written copy — a change to B is a change to this test.
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [PROJECT, `${seed.DEFINITION_B.name} (E3)`, initiator]
    );
    await query(
      `INSERT INTO playbook_definition_versions
         (definition_id, version_number, graph, status, published_by, published_at)
       VALUES ($1, 1, $2, 'published', $3, now())`,
      [definition.id, JSON.stringify(seed.DEFINITION_B.graph), initiator]
    );

    const [gateNode, agentNode, notifyNode] = seed.DEFINITION_B.graph.nodes;

    const { runId } = await runService.startRun({
      project: PROJECT,
      definitionId: definition.id,
      initiatorUserId: initiator,
    });

    /*
     * B parks before it does anything, which is the property that makes it a sharper test than a
     * reordering starting with an agent step: anything written around "a run begins by enqueueing
     * an agent run" fails here.
     */
    let detail = await projection.getRun(PROJECT, runId);
    expect(detail!.steps.map((s) => s.stepId)).toEqual([gateNode.id]);
    expect(detail!.suspension!.stepId).toBe(gateNode.id);

    await approvals.submitApprovalDecision({
      stepRunId: detail!.steps[0].id,
      deciderUserId: initiator,
      decision: 'approved',
      runId,
    });
    await advance.advanceRun(runId);

    // The agent step was started by the traversal, and parked itself waiting on its agent run.
    detail = await projection.getRun(PROJECT, runId);
    expect(detail!.steps.map((s) => s.stepId)).toEqual([gateNode.id, agentNode.id]);

    const [agentStep] = await query<{ agent_run_id: string | null }>(
      'SELECT agent_run_id FROM playbook_step_runs WHERE run_id = $1 AND step_id = $2',
      [runId, agentNode.id]
    );

    // Delivered the way production delivers it, rather than by completing the row by hand.
    await terminalEvents.handleTerminalAgentRunEvent({
      runId: agentStep.agent_run_id!,
      threadId: 'thread-e3',
      status: 'completed',
      timestamp: new Date().toISOString(),
      sequence: 1,
    } as Parameters<TerminalEventModule['handleTerminalAgentRunEvent']>[0]);

    detail = await projection.getRun(PROJECT, runId);

    expect(detail!.steps.map((s) => s.stepId)).toEqual([
      gateNode.id,
      agentNode.id,
      notifyNode.id,
    ]);
    expect(detail!.steps.every((s) => s.status === 'completed')).toBe(true);
    // Nothing is left waiting, which is what "end to end" means.
    expect(detail!.status).toBe('completed');
    expect(detail!.currentStepId).toBeNull();
    expect(detail!.suspension).toBeNull();
  });
});

/* ── E4 and VT-02 ────────────────────────────────────────────────────────────────────────────── */

describe('VT-20 / VT-02 — E4: the run stays reconstructible after every engine table is dropped', () => {
  it('renders correct step status and pinned version from Apex tables alone', async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { runId } = await provisionRun('e4', [
      { stepId: 'ask', stepType: 'cursor-agent', status: 'completed', output: { answer: 'yes' } },
      { stepId: 'approve', stepType: 'approval-gate', status: 'suspended', expiresAt: deadline },
      { stepId: 'announce', stepType: 'notify', status: 'pending' },
    ]);

    const before = await projection.getRun(PROJECT, runId);
    expect(before).not.toBeNull();

    /*
     * The criterion, executed literally. `playbook_engine` is the engine's own schema — the
     * disposable execution cache BR-001 describes — and dropping it mid-run is the sharpest
     * available test of whether anything outside the wrapper needed it.
     */
    await client.query('DROP SCHEMA IF EXISTS playbook_engine CASCADE');

    const remaining = await listTables(scratch.connectionString, 'playbook_engine');
    expect(remaining).toEqual([]);

    const after = await projection.getRun(PROJECT, runId);

    expect(after).not.toBeNull();
    // Identical, not merely present: E4 is about the answer being unchanged, not about the query
    // surviving.
    expect(after).toEqual(before);

    // The two facts PBI-002 puts on screen, named explicitly so a future reader knows what E4
    // was protecting.
    expect(after!.versionNumber).toBe(1);
    expect(after!.steps.map((s) => s.status)).toEqual(['completed', 'suspended', 'pending']);
    // Compared as instants, not strings: Postgres returns the offset as `+00:00` where
    // `toISOString()` writes `Z`, and the criterion is about the deadline surviving the drop
    // rather than about how the driver spells UTC.
    expect(new Date(after!.suspension!.deadline!).getTime()).toBe(new Date(deadline).getTime());
  });

  it('lists runs from Apex tables alone after the drop', async () => {
    // The list endpoint is the other half of the view's data path, and a list query that reached
    // an engine table would fail here rather than in front of an audience.
    const listed = await projection.listRuns(PROJECT, 50);

    expect(listed.runs.length).toBeGreaterThan(0);
    expect(listed.total).toBeGreaterThanOrEqual(listed.runs.length);
  });
});

/* ── Properties of the criteria themselves ───────────────────────────────────────────────────── */

describe('VT-21 — each criterion provisions its own state', () => {
  it('gives every criterion its own definition, so none can read another’s rows', async () => {
    const rows = await query<{ name: string }>(
      `SELECT name FROM playbook_definitions WHERE project = $1 AND name LIKE 'exit-criterion-%'`,
      [PROJECT]
    );

    const names = rows.map((r) => r.name);
    // Distinct names mean distinct definitions: no two criteria above shared one.
    expect(new Set(names).size).toBe(names.length);
  });

  it('leaves no criterion depending on another having just run', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- node built-ins in a test */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const source = fs.readFileSync(path.join(__dirname, path.basename(__filename)), 'utf8');

    /*
     * Structural rather than behavioural, and honest about it: running each `describe` in a fresh
     * process is what would prove this outright, and Jest has no in-suite way to do that. What can
     * be checked here is the thing that makes the dependency possible in the first place — shared
     * mutable fixture state hoisted above the describes. `provisionRun` takes a label precisely so
     * that no such state is needed.
     */
    expect(source).not.toMatch(/^\s*let\s+sharedRunId/m);
    expect(source).not.toMatch(/^\s*let\s+sharedStepRunIds/m);
  });
});

describe('VT-22 — a criterion that cannot be evaluated fails rather than skipping', () => {
  it('has no skipped or conditionally-skipped criterion tests', () => {
    /* eslint-disable @typescript-eslint/no-require-imports -- node built-ins in a test */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    /*
     * TBI-028 (b) asks for the same posture TBI-006 set for the conformance suite: a question that
     * cannot be answered in this environment is a failure, not a pass. A skip reads as green on a
     * dashboard, which is the whole problem — the criteria exist to be evidence, and evidence that
     * quietly abstains is worse than none.
     */
    const files = [path.basename(__filename), 'playbook-exit-criterion-e2.integration.test.ts'];

    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/\b(it|test|describe)\.skip\b/);
      expect(source).not.toMatch(/\b(it|test|describe)\.todo\b/);
    }
  });
});
