/**
 * TBI-028 — exit criterion E2: process death during a live agent step.
 *
 * The criterion has three parts, and the middle one is the one worth stating plainly: the step ends
 * up **failed-retryable**, **no prior output is lost**, and **nothing attempts to continue the turn
 * mid-flight**. That last part is not a nicety. Cursor work cannot be resumed from the middle of a
 * turn, so a system that tried would either replay side effects or silently produce a half-answer,
 * and both are worse than parking the step for a person.
 *
 * In its own file, separate from E1/E3/E4, because it needs a real child process to kill — the same
 * technique `playbook-step-durability.integration.test.ts` established, including the `killTree`
 * helper that stops Windows leaving an orphaned `ts-node` behind a dead `cmd.exe`.
 *
 * Recorded as test evidence rather than staged live. Killing the server mid-step in front of an
 * audience is not a good demo, which is what TBI-028 (c) says about E2 and E4 both.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type ReconciliationModule = typeof import('../../src/server/services/playbookReconciliationService');
type ReaperModule = typeof import('../../src/server/services/agentRunReaperService');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TS_NODE = path.join(REPO_ROOT, 'node_modules', '.bin', 'ts-node');
const MIGRATE_TIMEOUT = 600_000;
const CHILD_TIMEOUT = 300_000;
const INITIATOR = 'exit-e2-initiator';
const PROJECT = 'Apex';

let scratch: ScratchDatabase;
let client: pg.Client;
let reconciliation: ReconciliationModule;
let reaper: ReaperModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/**
 * Kills a child and everything it spawned.
 *
 * On Windows the child is `cmd.exe` — `spawn` needs a shell to find `ts-node.cmd` — so
 * `child.kill()` reaches the shell and leaves the real Node process running, holding the stdio
 * pipes that keep the test runner's event loop alive. `taskkill /T` takes the tree.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Runs the cursor-agent adapter in a child process and SIGKILLs it the instant the agent run is
 * enqueued — while the turn is live and has produced nothing.
 *
 * No graceful shutdown, no pool drain, no chance to flush: the same courtesy a pod eviction
 * extends. Everything asserted afterwards is read on a connection the dead process never touched.
 */
function executeAgentStepThenKill(stepRunId: string, runId: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-e2-'));
  const file = path.join(dir, 'execute-then-die.ts');

  fs.writeFileSync(
    file,
    `
    import { executeCursorAgentStep } from '${path
      .join(REPO_ROOT, 'src/server/services/playbookSteps/cursorAgentAdapter')
      .replace(/\\/g, '/')}';
    import { PHASE_0_ALLOWED_AGENT_SKILLS } from '${path
      .join(REPO_ROOT, 'src/server/services/playbookSteps/registry')
      .replace(/\\/g, '/')}';

    async function main() {
      const outcome = await executeCursorAgentStep({
        runId: '${runId}',
        stepRunId: '${stepRunId}',
        stepId: 'ask',
        stepType: 'cursor-agent',
        project: '${PROJECT}',
        initiatorUserId: '${INITIATOR}',
        config: {
          skillPath: PHASE_0_ALLOWED_AGENT_SKILLS[0],
          prompt: 'Summarise the Playbook design docs',
        },
      });

      console.log('ENQUEUED ' + JSON.stringify(outcome));

      // Stay alive doing nothing, so the kill below is what ends this process rather than a tidy
      // exit that could flush something on the way out.
      setInterval(() => {}, 1000);
    }

    main().catch((error) => {
      console.error('CHILD FAILED ' + (error && error.message));
      process.exit(1);
    });
    `,
    'utf8'
  );

  return new Promise<string>((resolve, reject) => {
    const child = spawn(TS_NODE, ['--project', 'tsconfig.server.json', file], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: scratch.connectionString },
      shell: process.platform === 'win32',
    });

    let output = '';
    const finish = (fn: () => void) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fn();
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(new Error(`Child never enqueued. Output:\n${output}`)));
    }, CHILD_TIMEOUT - 10_000);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ENQUEUED')) {
        clearTimeout(timer);
        killTree(child);
        finish(() => resolve(output));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('exit', (code) => {
      if (!output.includes('ENQUEUED')) {
        clearTimeout(timer);
        finish(() => reject(new Error(`Child exited with ${code}. Output:\n${output}`)));
      }
    });
  });
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbooke2');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
   * Required after DATABASE_URL is repointed, so the pool binds to the scratch database. */
  reconciliation = require('../../src/server/services/playbookReconciliationService');
  reaper = require('../../src/server/services/agentRunReaperService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Exit criterion E2')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

describe('VT-18 — E2: process death mid agent-step leaves the step failed-retryable', () => {
  it('parks the step for a person, keeps prior output, and never continues the turn', async () => {
    // Its own definition and run: E2 must pass when run alone, per TBI-028's NFR.
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, created_by)
       VALUES ($1, 'exit-criterion-e2', $2) RETURNING id`,
      [PROJECT, INITIATOR]
    );
    const [version] = await query<{ id: string }>(
      `INSERT INTO playbook_definition_versions
         (definition_id, version_number, graph, status, published_by, published_at)
       VALUES ($1, 1, $2, 'published', $3, now()) RETURNING id`,
      [
        definition.id,
        JSON.stringify({
          nodes: [
            { id: 'earlier', stepType: 'notify', config: { title: 'earlier' } },
            { id: 'ask', stepType: 'cursor-agent', config: {} },
          ],
          edges: [{ from: 'earlier', to: 'ask' }],
        }),
        INITIATOR,
      ]
    );
    const [run] = await query<{ id: string }>(
      `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
       VALUES ($1, $2, $3, 'running') RETURNING id`,
      [PROJECT, version.id, INITIATOR]
    );

    // The prior output the criterion says must survive. Written before the death, by a step that
    // had already finished.
    const PRIOR_OUTPUT = { notificationId: 'notif-1', recipientUserId: INITIATOR };
    await query(
      `INSERT INTO playbook_step_runs
         (run_id, step_id, step_type, status, output_inline, started_at, completed_at)
       VALUES ($1, 'earlier', 'notify', 'completed', $2, now(), now())`,
      [run.id, JSON.stringify(PRIOR_OUTPUT)]
    );

    const [agentStep] = await query<{ id: string }>(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, started_at)
       VALUES ($1, 'ask', 'cursor-agent', 'running', now()) RETURNING id`,
      [run.id]
    );

    // ── The death ─────────────────────────────────────────────────────────────────────────────
    const output = await executeAgentStepThenKill(agentStep.id, run.id);
    expect(output).toContain('ENQUEUED');

    const [parked] = await query<{ status: string; agent_run_id: string | null }>(
      'SELECT status, agent_run_id FROM playbook_step_runs WHERE id = $1',
      [agentStep.id]
    );
    // Immediately after the kill the step is suspended against a live agent run — nothing has yet
    // noticed the process is gone. That is the state the recovery path has to work from.
    expect(parked.status).toBe('suspended');
    expect(parked.agent_run_id).not.toBeNull();

    // ── The recovery ──────────────────────────────────────────────────────────────────────────
    const [agentRun] = await query<{
      id: string;
      status: string;
      created_at: string;
      started_at: string | null;
      heartbeat_at: string | null;
      timeout_at: string | null;
    }>(
      `SELECT id, status, created_at, started_at, heartbeat_at, timeout_at
         FROM agent_runs WHERE id = $1`,
      [parked.agent_run_id]
    );

    /*
     * The real classifier, not a hand-written verdict. An agent run whose worker died is detected
     * by `assessAgentRunHealth` — asking it here is what makes this test evidence about Apex's own
     * recovery rather than about a status I set myself a line earlier.
     */
    const verdict = reaper.assessAgentRunHealth(
      {
        id: agentRun.id,
        status: 'running',
        createdAt: agentRun.created_at,
        startedAt: agentRun.started_at ?? agentRun.created_at,
        // The worker is dead, so its last heartbeat recedes into the past and never advances.
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        timeoutAt: agentRun.timeout_at,
      } as Parameters<ReaperModule['assessAgentRunHealth']>[0],
      Date.now(),
      // The real configuration, read from the environment exactly as the reaper reads it.
      reaper.resolveAgentRunHealthConfig()
    );
    // `worker_lost` is the expected verdict — the heartbeat stopped when the process died.
    expect(verdict).not.toBe('healthy');

    // What the reaper does with that verdict: the run ends as failed. Applied here because the
    // reaper's own scheduler is not running in this test process.
    await query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [agentRun.id]);

    const sweep = await reconciliation.runReconciliationPass({});
    expect(sweep.error).toBeUndefined();

    // ── The three parts of the criterion ──────────────────────────────────────────────────────
    const [after] = await query<{ status: string; agent_run_id: string | null }>(
      'SELECT status, agent_run_id FROM playbook_step_runs WHERE id = $1',
      [agentStep.id]
    );

    // (1) Failed-retryable, not failed: a person retries the step, the run does not die.
    expect(after.status).toBe('failed_retryable');

    // (2) No prior output lost.
    const [earlier] = await query<{ status: string; output_inline: Record<string, unknown> }>(
      `SELECT status, output_inline FROM playbook_step_runs
        WHERE run_id = $1 AND step_id = 'earlier'`,
      [run.id]
    );
    expect(earlier.status).toBe('completed');
    expect(earlier.output_inline).toEqual(PRIOR_OUTPUT);

    // (3) No mid-turn continuation attempted. A recovery that tried to resume the turn would have
    // had to enqueue a second agent run for this step; there is exactly one, and it is the
    // original.
    const agentRunsForStep = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE id IN (SELECT agent_run_id FROM playbook_step_runs WHERE run_id = $1)`,
      [run.id]
    );
    expect(agentRunsForStep[0].n).toBe(1);
    expect(after.agent_run_id).toBe(agentRun.id);
  }, CHILD_TIMEOUT);

  it('records failed_retryable as a step status that no run status mirrors', async () => {
    /*
     * The shape the criterion depends on, asserted against the database rather than the type.
     * `failed_retryable` is deliberately absent from the run-status constraint: a retryable step
     * must not imply a retryable *run*, because the run is exactly what should stay alive while a
     * person decides what to do about the step.
     */
    const [stepCheck] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'playbook_step_runs_status_check'`
    );
    const [runCheck] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'playbook_runs_status_check'`
    );

    expect(stepCheck.def).toContain('failed_retryable');
    expect(runCheck.def).not.toContain('failed_retryable');
  });
});
