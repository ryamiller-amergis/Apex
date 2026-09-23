/**
 * Local stand-in for the background AI-runs worker job.
 *
 * In Azure, KEDA starts one Container Apps Job per Service Bus message and that job runs
 * `aiRunsWorker/entrypoint.ts` exactly once. Nothing plays that role on a developer machine, so a
 * Playbook's `cursor-agent` step enqueues, suspends, and then waits forever.
 *
 * The queue is database-authoritative, which is what makes this possible without any Azure
 * resources: admission stamps `dispatched` and the dispatch fence inside a Postgres transaction,
 * and only afterwards publishes. So the rows this polls for are already in exactly the state a
 * worker consumes, whether or not a broker ever saw them.
 *
 * Deliberately a `scripts/` tool and not wired into `npm run dev`. Draining agent runs spends real
 * Cursor tokens, so it should be started on purpose for local Playbook work and stopped afterwards,
 * not a side effect of starting the server.
 *
 * Runs are executed one at a time. The real job gets parallelism from KEDA scaling out, and a
 * serial loop keeps local output readable and the machine responsive.
 *
 * Requires, in `.env`:
 *   AI_RUNS_DISPATCH_PUBLISHER=noop        so admission stops throwing with no Service Bus
 *   AI_RUNS_RUNNER_CALLBACK_TOKEN=<token>  static runner auth, non-production only
 *   APEX_CALLBACK_URL=http://localhost:3001
 *   CURSOR_API_KEY=<key>                   the agent turn itself
 *
 * Usage:
 *   npx ts-node --project tsconfig.server.json scripts/drain-ai-runs.ts [--project Apex] [--interval 3000]
 */
import 'dotenv/config';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import { agentRuns } from '../src/server/db/schema';
import { getAiRunnerCallbackToken } from '../src/server/services/aiRunsCallbackToken';
import {
  createAiRunsCallbackClient,
  createAiRunsWorker,
  createLocalCursorExecution,
  flushWorkspaceArtifacts,
  openLocalCheckout,
} from '../src/server/services/aiRunsWorker';

const DEFAULT_INTERVAL_MS = 3000;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resolveIntervalMs(): number {
  const raw = argValue('--interval');
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 250) {
    throw new Error(`--interval must be a number of milliseconds >= 250, got "${raw}".`);
  }
  return parsed;
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. ${hint}`);
  return value;
}

interface ClaimableRun {
  runId: string;
  dispatchMessageId: string;
  projectId: string | null;
}

/**
 * Dispatched background runs, oldest first.
 *
 * `dispatched` rather than `queued` on purpose: the fence token is written with that status, and
 * the worker refuses a bootstrap whose token does not match. A queued row has no token yet, so the
 * server's own admission cycle still owns the queued-to-dispatched move.
 */
async function findDispatchedRuns(project?: string): Promise<ClaimableRun[]> {
  const rows = await db
    .select({
      runId: agentRuns.id,
      dispatchMessageId: agentRuns.dispatchMessageId,
      projectId: agentRuns.projectId,
    })
    .from(agentRuns)
    .where(
      project
        ? and(
            eq(agentRuns.status, 'dispatched'),
            eq(agentRuns.lane, 'background'),
            eq(agentRuns.projectId, project),
          )
        : and(eq(agentRuns.status, 'dispatched'), eq(agentRuns.lane, 'background')),
    )
    .orderBy(asc(agentRuns.dispatchedAt))
    .limit(25);

  return rows.flatMap((row) =>
    row.dispatchMessageId
      ? [{ ...row, dispatchMessageId: row.dispatchMessageId }]
      : [],
  );
}

async function main(): Promise<void> {
  const project = argValue('--project');
  const intervalMs = resolveIntervalMs();
  const callbackBaseUrl = requireEnv(
    'APEX_CALLBACK_URL',
    'Point it at this server, e.g. http://localhost:3001.',
  );
  requireEnv(
    'AI_RUNS_RUNNER_CALLBACK_TOKEN',
    'The internal callback routes reject an unauthenticated runner.',
  );
  requireEnv('CURSOR_API_KEY', 'The agent turn cannot run without it.');
  if (process.env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE?.trim()) {
    throw new Error(
      'AI_RUNS_CALLBACK_TOKEN_AUDIENCE is set, which forces managed-identity callbacks and '
        + 'disables the static token this script relies on. Unset it for local draining.',
    );
  }

  const callback = createAiRunsCallbackClient({
    callbackBaseUrl,
    getToken: getAiRunnerCallbackToken,
  });
  const worker = createAiRunsWorker({
    getBootstrap: (message) => callback.getBootstrap(message),
    /*
     * Rooted at this repository rather than left to resolve itself.
     *
     * `openGroundedReader` tries a bare mirror, then the HTTP read service, then a local checkout,
     * and the first two both require a `groundedSha` the Playbook path does not set. So it lands on
     * the local checkout, which defaults to the snapshot's `workspaceRef` — a scratch directory
     * holding `.ai-pilot/` and nothing else. The agent's `get_skill_file` and `list_repo_dir` are
     * built on that reader, so they returned nothing for every repository path, and a step told to
     * read one named file instead spent eighty tool calls hunting for it.
     *
     * Deployed workers get a real checkout to point at. This one has the working tree it is
     * running from, which is also what makes uncommitted edits visible to the step.
     */
    openCheckout: (snapshot) => openLocalCheckout(snapshot, process.cwd()),
    /*
     * The SDK agent's `cwd` is `snapshot.workspaceRef` — the same empty scratch directory the
     * reader used to fall back to. Three gemini turns and one composer turn all answered this
     * question correctly and then ended ~3 minutes later with `[internal] unable to open database
     * file`. That error names a SQLite open, and the scratch folder has no git metadata and no
     * `.cursor` layout for the SDK to put that file in. Pointing `cwd` at this working tree is
     * local-drainer-only: `flushArtifacts` still uses the original scratch path, so a confused
     * write does not get ingested from the real repo.
     */
    createExecution: (snapshot, checkout) =>
      createLocalCursorExecution(
        { ...snapshot, workspaceRef: process.cwd() },
        checkout as Awaited<ReturnType<typeof openLocalCheckout>>,
      ),
    postIngest: (projectId, runId, body) => callback.postIngest(projectId, runId, body),
    flushArtifacts: flushWorkspaceArtifacts,
  });

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nFinishing the current run, then stopping. Ctrl+C again to exit now.');
  });

  console.log(
    `Draining background AI runs${project ? ` for project "${project}"` : ''} `
      + `every ${intervalMs}ms. Ctrl+C to stop.`,
  );

  // Runs seen this session. A row stays `dispatched` if the worker failed before reaching a
  // terminal ingest, and retrying it every tick would loop on the same failure forever.
  const attempted = new Set<string>();

  while (!stopping) {
    let claimed: ClaimableRun[] = [];
    try {
      claimed = await findDispatchedRuns(project);
    } catch (error) {
      console.error('Could not read the run queue:', (error as Error).message);
    }

    for (const run of claimed) {
      if (stopping) break;
      if (attempted.has(run.runId)) continue;
      attempted.add(run.runId);

      console.log(`→ ${run.runId}${run.projectId ? ` (${run.projectId})` : ''}`);
      const startedAt = Date.now();
      try {
        await worker.execute({
          runId: run.runId,
          dispatchMessageId: run.dispatchMessageId,
        });
        console.log(`  done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      } catch (error) {
        // One bad run must not stop the loop: the other demo's step may still be waiting.
        console.error(`  failed: ${(error as Error).message}`);
      }
    }

    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  console.log('Stopped.');
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error: Error) => {
      console.error('Drainer failed:', error.message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
