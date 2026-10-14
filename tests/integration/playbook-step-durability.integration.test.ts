/**
 * VT-11 — a suspended step survives the death of the process that created it.
 *
 * This is the claim the whole engine adoption rests on, so it is tested the blunt way: a real child
 * process executes the real adapter against a real database, and once it reports the agent run
 * enqueued, the parent sends SIGKILL. No graceful shutdown, no pool drain, no chance to flush
 * anything — the same courtesy a pod eviction extends. The parent then reads the step back on a
 * fresh connection.
 *
 * A mocked version of this test would prove nothing. The property is that the state lives in
 * Postgres rather than in the process, and the only way to demonstrate that is to destroy the
 * process and find the state still there.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TS_NODE = path.join(REPO_ROOT, 'node_modules', '.bin', 'ts-node');
const MIGRATE_TIMEOUT = 600_000;
const CHILD_TIMEOUT = 300_000;
const INITIATOR = 'feat004-durability-initiator';

let scratch: ScratchDatabase;
let client: pg.Client;

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
 * pipes that keep this test runner's event loop alive long after the test has passed. `taskkill /T`
 * takes the tree.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }

  // The pipes outlive the process they belonged to, and an undestroyed pipe is its own open handle.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Runs the adapter in a child process and kills it the moment the agent run is enqueued.
 *
 * Resolves with whatever the child printed. The child is killed rather than allowed to exit, so
 * that nothing it might do on the way out — closing a pool, flushing a write — can be what makes
 * the assertions pass.
 */
function executeStepThenKill(stepRunId: string, runId: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-durability-'));
  const file = path.join(dir, 'execute-then-hang.ts');

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
        stepId: 'draft',
        stepType: 'cursor-agent',
        project: 'Apex',
        initiatorUserId: '${INITIATOR}',
        config: {
          skillPath: PHASE_0_ALLOWED_AGENT_SKILLS[0],
          prompt: 'Summarise the design docs',
        },
      });

      console.log('ENQUEUED ' + JSON.stringify(outcome));

      // Stay alive and do nothing further, so the kill below is what ends this process rather than
      // a tidy exit.
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
        // The kill. Nothing graceful about it.
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
  scratch = await createScratchDatabase('playbookdurable');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Durability Initiator')
     ON CONFLICT (oid) DO NOTHING`,
    [INITIATOR]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

describe('VT-11 — the step outlives the process', () => {
  it('is still suspended with its correlation intact after SIGKILL', async () => {
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, created_by)
       VALUES ('Apex', 'durability', $1) RETURNING id`,
      [INITIATOR]
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
    const [stepRun] = await query<{ id: string }>(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, started_at)
       VALUES ($1, 'draft', 'cursor-agent', 'running', now()) RETURNING id`,
      [run.id]
    );

    const output = await executeStepThenKill(stepRun.id, run.id);
    expect(output).toContain('ENQUEUED');

    // Fresh read, on a connection the dead process never touched.
    const [step] = await query<{
      status: string;
      agent_run_id: string | null;
      expires_at: Date | null;
    }>('SELECT status, agent_run_id, expires_at FROM playbook_step_runs WHERE id = $1', [
      stepRun.id,
    ]);

    expect(step.status).toBe('suspended');
    expect(step.agent_run_id).not.toBeNull();
    expect(step.expires_at).not.toBeNull();

    // And the agent run it points at is really there — a correlation to a row that does not exist
    // would be worse than no correlation at all.
    const [agentRun] = await query<{ id: string; lane: string }>(
      'SELECT id, lane FROM agent_runs WHERE id = $1',
      [step.agent_run_id]
    );
    expect(agentRun).toBeDefined();
    expect(agentRun.lane).toBe('background');
  }, CHILD_TIMEOUT);
});
